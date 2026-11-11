// A PodTorrent test peer on Network.framework QUIC. Two modes:
//   direct: dial one peer (the spike's py_peer.py --p256) and run the protocol checks against it;
//   pods:   watch the rendezvous's census (read-only); once joined, serve QUIC on one UDP port, wait in
//           the public lobby or enter a private pod by invite code, hole-punch when a pod member asks,
//           and let members dial in. It serves no layers yet, so no work is ever routed to it.
import CryptoKit
import Foundation
import Network
import Security

/// A peer this device has a link with (or is punching towards).
struct PeerRow: Identifiable, Equatable, Sendable {
    let id: String
    var state = "punching"
    var rttMs: Double?
}

/// Where this device is: watching only, waiting in the public lobby, or a member of a pod.
enum Place: Equatable, Sendable {
    case watching
    case lobby
    case pod(id: String, name: String, kind: String, members: Int)
}

final class TestPeer: @unchecked Sendable {
    /// Called on an arbitrary queue.
    var onLog: (String) -> Void = { print($0) }
    var onRows: ([PeerRow]) -> Void = { _ in }     // peers linked with this device
    var onSwarm: ([SwarmPeer]) -> Void = { _ in }  // every member online in this device's pod
    var onCensus: (Census) -> Void = { _ in }      // every pod and the lobby, from the census
    var onPlace: (Place) -> Void = { _ in }

    let name: String
    private let queue = DispatchQueue(label: "podtorrent.test")
    // Sorts after every peer, so they dial us: today's peers serve Ed25519 certificates Apple's TLS can't verify.
    // Not kept between launches, so a private pod needs a fresh invite each time.
    private let ident = PeerIdentity.generate(prefix: "fff")
    private var known: [String: String] = [:]   // peer_id -> name
    private var url: String?
    private var rows: [String: PeerRow] = [:]
    private var listener: NWListener?
    private var census: URLSessionWebSocketTask?
    private var socket: URLSessionWebSocketTask?   // the lobby or the pod's room
    private var roster: [String: Any]?             // the pod's signed roster, as the room sent it
    private var groups: [ObjectIdentifier: NWConnectionGroup] = [:]
    private var port: UInt16 = 0
    private var dials = 0   // incoming QUIC connections so far; a punch stops probing once one arrives
    private var endpoints: [[String: Any]] = []
    private var relayNoted = false
    private var leaving = false   // the owner's roster without us is our own leave, not a removal
    private(set) var joined = false
    private(set) var place = Place.watching
    var peerId: String { ident.peerId }

    init(name: String) { self.name = name }

    private func log(_ s: String) {
        let t = DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium)
        onLog("\(t)  \(s)")
    }

    // MARK: direct

    func runDirect(host: String, port: UInt16, expect: String?) async {
        let ident = PeerIdentity.generate()
        log("direct test as \(ident.peerId.prefix(8)) → \(host):\(port)")
        var serverKey: Data?
        let p = NWParameters(quic: quicOptions(verify: { cert in
            serverKey = cert.flatMap(certIdentityKey)
            return serverKey != nil
        }))
        let target = NWEndpoint.hostPort(host: .init(host), port: .init(rawValue: port)!)
        let g = NWConnectionGroup(with: NWMultiplexGroup(to: target), using: p)
        g.newConnectionHandler = { [weak self] s in self?.serve(s, as: ident, onAuth: { _ in }) }
        defer { queue.asyncAfter(deadline: .now() + 6) { g.cancel() } }
        do {
            let t0 = Date()
            try await startGroup(g)
            log(String(format: "QUIC handshake ok in %.0f ms", Date().timeIntervalSince(t0) * 1000))
            guard let serverKey else { throw WireError("server certificate proves no identity") }
            let server = peerIdOf(serverKey)
            if let expect, !expect.isEmpty, expect != server {
                throw WireError("certificate is for \(server), expected \(expect)")
            }
            log("server is \(server)\(expect?.isEmpty == false ? " (matches)" : "")")

            let sig = try ident.sign("podtorrent-auth|\(server)|\(ident.peerId)")
            let auth = try JSONSerialization.data(withJSONObject: [
                "peer_id": ident.peerId, "pub": hexString(ident.key.publicKey.rawRepresentation), "sig": hexString(sig)])
            let reply = String(decoding: try await call(g, Wire.mAuth, [UInt8](auth), queue: queue), as: UTF8.self)
            guard reply == "ok" else { throw WireError("auth refused: \(reply)") }
            log("auth ok")

            var rtts: [Double] = []
            for _ in 0..<5 {
                let t = Date()
                _ = try await call(g, Wire.mHeartbeat, [0x08] + varint(UInt64(Date().timeIntervalSince1970 * 1e9)), queue: queue)
                rtts.append(Date().timeIntervalSince(t) * 1000)
            }
            log("heartbeat rtt " + rtts.map { String(format: "%.1f", $0) }.joined(separator: ", ") + " ms")
            let info = NodeSummary(try await call(g, Wire.mInfo, [], queue: queue))
            log("Info: name \(info.name.isEmpty ? "?" : info.name)\(info.slices.isEmpty ? "" : ", slices " + info.slices.joined(separator: ", "))")

            for kb in [16, 256, 1024, 4096, 8192] {
                let body = [UInt8]((0..<(kb << 10)).map { UInt8(truncatingIfNeeded: $0 &* 2654435761 >> 13) })
                let t = Date()
                let echo = try await call(g, Wire.mHeartbeat, body, queue: queue)
                let dt = Date().timeIntervalSince(t)
                log(String(format: "%d KB echo %@ in %.0f ms (%.1f MB/s each way)", kb,
                           echo == body ? "intact" : "CORRUPT", dt * 1000, Double(kb) / 1024 / dt))
            }
            log("direct test passed ✅")
        } catch {
            log("direct test FAILED: \(error)")
        }
    }

    // MARK: pods

    /// Read-only view of every pod and the public lobby: the census socket needs no key and publishes
    /// nothing, so nobody connects to us.
    func watch(url: String) {
        guard census == nil else { return }
        self.url = url
        let ws = URLSession.shared.webSocketTask(with: URL(string: "\(url)/v1/census")!)
        census = ws
        ws.resume()
        log("watching the census at \(url)")
        Task { await self.censusLoop(ws) }
        Task { await self.pingLoop(ws) { [weak self] in self?.census === ws } }
    }

    /// Serves QUIC and enters a room. With a `pod1-…` invite code, asks that private pod's owner to add
    /// this device first; without one, waits in the public lobby until the matchmaker assigns a pod.
    func join(invite: String? = nil) async throws {
        guard !joined, let url else { return }
        let code = invite?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let pod = code.isEmpty ? nil : try parseInvite(code)
        try await startListener()
        joined = true
        do {
            if let pod { roster = try await requestJoin(url: url, podId: pod.id, secret: pod.secret) }
            try await connectRoom()
        } catch {
            closeRoom()
            throw error
        }
    }

    /// Back to watching. A private pod's owner is asked to sign this device out of the roster first.
    func leave() async {
        guard joined else { return }
        if let ws = socket, let r = roster, r["kind"] as? String == "private" {
            leaving = true
            try? await ws.send(.string(json(["type": "leave"])))
            try? await Task.sleep(nanoseconds: 300_000_000)
        }
        closeRoom()
        log("left \(placeText)")
        setPlace(.watching)
    }

    func stop(quiet: Bool = false) {
        let ws = census
        census = nil
        ws?.cancel(with: .goingAway, reason: nil)
        closeRoom()
        TLSIdentity.removeOld()
        if !quiet { log("stopped") }
    }

    private func closeRoom() {
        let ws = socket
        socket = nil
        ws?.cancel(with: .goingAway, reason: nil)
        listener?.cancel()
        listener = nil
        joined = false
        leaving = false
        roster = nil
        queue.sync {
            groups.values.forEach { $0.cancel() }
            groups = [:]
            rows = [:]
            known = [:]
        }
        onRows([])
        onSwarm([])
    }

    private func startListener() async throws {
        let tls = try TLSIdentity.make(for: ident)
        let q = quicOptions(verify: nil)
        sec_protocol_options_set_local_identity(q.securityProtocolOptions, sec_identity_create(tls)!)
        let p = NWParameters(quic: q)
        p.allowLocalEndpointReuse = true
        port = UInt16.random(in: 50_000...60_000)
        // STUN first: once the listener holds the port, it receives every datagram, STUN replies included.
        await findEndpoints()
        let l = try NWListener(using: p, on: .init(rawValue: port)!)
        l.newConnectionGroupHandler = { [weak self] g in self?.accept(g) }
        try await withCheckedThrowingContinuation { (k: CheckedContinuation<Void, Error>) in
            let once = Once()
            l.stateUpdateHandler = { s in
                switch s {
                case .ready: once.run { k.resume() }
                case .failed(let e): once.run { k.resume(throwing: e) }
                default: break
                }
            }
            l.start(queue: queue)
        }
        listener = l
        log("QUIC listening on udp/\(port)")
    }

    /// The pod's room if this device has a roster, else the public lobby (rendezvous.py SwarmClient.run).
    private func connectRoom() async throws {
        guard let url else { return }
        let ws: URLSessionWebSocketTask
        if let r = roster, let podId = r["pod_id"] as? String {
            let (room, welcome) = try await openRoom("\(url)/v1/pod/\(podId)", podId: podId)
            guard welcome["member"] as? Bool == true else {
                room.cancel(with: .goingAway, reason: nil)
                roster = nil
                throw WireError("the pod's room says this device isn't a member")
            }
            if let newer = welcome["roster"] as? [String: Any], lists(newer) { roster = newer }
            ws = room
            socket = ws
            try await ws.send(.string(json(["type": "hello", "peer": record()])))
            log("in pod \(roster?["name"] as? String ?? "?") as \(ident.peerId); the room sees us at \(welcome["observed_ip"] as? String ?? "?")")
            setPlace(.pod(id: podId, name: roster?["name"] as? String ?? "", kind: roster?["kind"] as? String ?? "",
                          members: (roster?["members"] as? [Any])?.count ?? 0))
        } else {
            let (lobby, _) = try await openRoom("\(url)/v1/public", podId: "public")
            ws = lobby
            socket = ws
            try await ws.send(.string(json(["type": "supply", "supply": supply()])))
            log("in the public lobby as \(ident.peerId): the matchmaker assigns a pod to machines that offer layers, and this device offers none yet")
            setPlace(.lobby)
        }
        Task { await self.roomLoop(ws) }
        Task { await self.pingLoop(ws) { [weak self] in self?.socket === ws } }
    }

    /// Opens a room and answers its challenge with this device's key (rendezvous.py room_auth); returns the welcome.
    private func openRoom(_ path: String, podId: String) async throws -> (URLSessionWebSocketTask, [String: Any]) {
        let ws = URLSession.shared.webSocketTask(with: URL(string: path)!)
        ws.resume()
        let done = Box<Bool>()
        queue.asyncAfter(deadline: .now() + 15) { if done.value == nil { ws.cancel(with: .goingAway, reason: nil) } }
        defer { done.value = true }
        do {
            let ch = try await nextEvent(ws)
            guard ch["type"] as? String == "challenge", let nonce = ch["nonce"] as? String else {
                throw WireError("expected a challenge, got \(ch["type"] ?? "?")")
            }
            let sig = try ident.sign("podtorrent-room|\(podId)|\(nonce)")
            try await ws.send(.string(json(["type": "auth", "pubkey": hexString(ident.key.publicKey.rawRepresentation), "sig": hexString(sig)])))
            while true {
                let ev = try await nextEvent(ws)
                if ev["type"] as? String == "welcome" { return (ws, ev) }
            }
        } catch {
            ws.cancel(with: .goingAway, reason: nil)
            throw done.value == nil && ws.closeCode == .invalid ? error : WireError("\(path): \(error)")
        }
    }

    /// Asks a private pod's owner, through the pod's room, to add this device (rendezvous.py join_pod).
    private func requestJoin(url: String, podId: String, secret: Data) async throws -> [String: Any] {
        let (ws, welcome) = try await openRoom("\(url)/v1/pod/\(podId)", podId: podId)
        defer { ws.cancel(with: .normalClosure, reason: nil) }
        if welcome["member"] as? Bool == true, let r = welcome["roster"] as? [String: Any], lists(r) { return r }
        let pub = hexString(ident.key.publicKey.rawRepresentation)
        let mac = HMAC<SHA256>.authenticationCode(for: Data("podtorrent-invite|\(podId)|\(ident.peerId)|\(pub)".utf8),
                                                  using: SymmetricKey(data: secret))
        let ask = json(["type": "join_request", "name": name, "proof": hexString(mac)])
        try await ws.send(.string(ask))
        log("asked the pod's owner to add this device")
        let start = Date()
        let timedOut = Box<Bool>()
        queue.asyncAfter(deadline: .now() + 45) { timedOut.value = true; ws.cancel(with: .goingAway, reason: nil) }
        while true {
            let ev: [String: Any]
            do { ev = try await nextEvent(ws) } catch {
                throw timedOut.value == true ? WireError("the pod's owner didn't answer; is it online?") : error
            }
            switch ev["type"] as? String {
            case "join_failed":
                let reason = ev["reason"] as? String ?? "refused"
                // The owner may be moving into the room (it just made the pod): ask again for a few seconds.
                guard ev["offline"] as? Bool == true, Date().timeIntervalSince(start) < 9 else { throw WireError("couldn't join: \(reason)") }
                try await Task.sleep(nanoseconds: 3_000_000_000)
                try await ws.send(.string(ask))
            case "roster":
                if let r = ev["roster"] as? [String: Any], lists(r) { return r }
            default: break
            }
        }
    }

    private func nextEvent(_ ws: URLSessionWebSocketTask) async throws -> [String: Any] {
        while true {
            if case .string(let s) = try await ws.receive(), s != "pong",
               let ev = try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any] { return ev }
        }
    }

    private func lists(_ roster: [String: Any]) -> Bool {
        (roster["members"] as? [[String: Any]] ?? []).contains { $0["peer_id"] as? String == ident.peerId }
    }

    private func roomLoop(_ ws: URLSessionWebSocketTask) async {
        while socket === ws {
            guard let ev = try? await nextEvent(ws) else {
                if socket === ws { await roomLost(ws) }
                return
            }
            switch ev["type"] as? String {
            case "peers": onPeers(ev["peers"] as? [[String: Any]] ?? [])
            case "punch":
                if case .pod = place, let rec = ev["peer"] as? [String: Any] {
                    Thread.detachNewThread { [weak self] in self?.punch(rec) }
                }
            case "roster", "assign":
                if let r = ev["roster"] as? [String: Any] { await adopt(r) }
            case "dissolved":
                log("the matchmaker dissolved this pod: back to the lobby")
                roster = nil
                await moveRoom()
            case "relay":
                if !relayNoted {
                    relayNoted = true
                    log("a peer is relaying QUIC through the room (its NAT won't hole-punch); this device can't carry relayed QUIC yet")
                }
            default: break
            }
        }
    }

    /// A roster from the room: an assignment from the lobby, or the pod's next version.
    private func adopt(_ r: [String: Any]) async {
        let cur = roster?["pod_id"] as? String
        guard lists(r) else {
            if !leaving, cur != nil && cur == r["pod_id"] as? String {
                log("the owner removed this device from the pod: back to the lobby")
                roster = nil
                await moveRoom()
            }
            return
        }
        if cur == r["pod_id"] as? String {
            if (r["version"] as? Int ?? 0) > (roster?["version"] as? Int ?? 0) {
                roster = r
                setPlace(.pod(id: cur!, name: r["name"] as? String ?? "", kind: r["kind"] as? String ?? "",
                              members: (r["members"] as? [Any])?.count ?? 0))
            }
            return
        }
        log("assigned to \(r["kind"] as? String ?? "") pod \(r["name"] as? String ?? "?"): moving to its room")
        roster = r
        await moveRoom()
    }

    /// Closes the room socket (keeping the QUIC listener and links) and connects to the right room.
    private func moveRoom() async {
        let ws = socket
        socket = nil
        ws?.cancel(with: .goingAway, reason: nil)
        onPeers([])
        await reconnect()
    }

    private func roomLost(_ ws: URLSessionWebSocketTask) async {
        socket = nil
        if leaving { return }
        switch ws.closeCode.rawValue {
        case 4000: log("another connection with this key replaced ours"); return
        case 4003: log("the pod's roster no longer lists this device: back to the lobby"); roster = nil
        case 4004: log("the pod was dissolved: back to the lobby"); roster = nil
        default: log("rendezvous connection lost (\(ws.closeCode.rawValue)); reconnecting in 3 s")
        }
        try? await Task.sleep(nanoseconds: 3_000_000_000)
        await reconnect()
    }

    private func reconnect() async {
        while joined && socket == nil {
            do { try await connectRoom(); return } catch {
                log("couldn't enter \(roster == nil ? "the lobby" : "the pod's room"): \(error); retrying in 5 s")
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
    }

    private func setPlace(_ p: Place) {
        place = p
        onPlace(p)
    }

    private var placeText: String {
        switch place {
        case .watching: "nothing"
        case .lobby: "the public lobby"
        case .pod(_, let name, let kind, _): "\(kind) pod \(name)"
        }
    }

    private func record() -> [String: Any] {
        ["name": name, "chip": deviceModel(), "mem_total_gb": memTotalGB(), "mem_free_gb": 0,
         "slices": [] as [Any], "has_head": [:] as [String: Any], "endpoints": endpoints, "protocol": 2]
    }

    /// What the lobby's matchmaker sees: no models, so it never puts this device in a public pod it can't serve.
    private func supply() -> [String: Any] {
        ["name": name, "chip": deviceModel(), "mem_total_gb": memTotalGB(), "mem_free_gb": 0, "node": false, "models": [] as [Any]]
    }

    private func memTotalGB() -> Double { (Double(ProcessInfo.processInfo.physicalMemory) / Double(1 << 30) * 10).rounded() / 10 }

    private func findEndpoints() async {
        let port = self.port
        let pub = await Task.detached { stun(localPort: port) }.value
        if let pub { log("public address (STUN on the QUIC port): \(pub.0):\(pub.1)") } else { log("STUN got no answer") }
        endpoints = (pub.map { [["kind": "stun", "ip": $0.0, "port": Int($0.1)]] } ?? [])
            + lanAddresses().map { ["kind": "lan", "ip": $0, "port": Int(port)] }
    }

    /// Keeps the NAT mapping for the QUIC port alive with an outbound STUN request (the reply goes to the
    /// listener and is dropped there; only the outgoing packet matters).
    private func keepMappingAlive() {
        let port = self.port
        Thread.detachNewThread {
            guard let s = try? UDPSocket(localPort: port, host: "stun.cloudflare.com", port: 3478) else { return }
            s.send([0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xa4, 0x42] + (0..<12).map { _ in UInt8.random(in: 0...255) })
            s.close()
        }
    }

    private func censusLoop(_ ws: URLSessionWebSocketTask) async {
        while census === ws {
            guard let ev = try? await nextEvent(ws) else {
                if census === ws {
                    census = nil
                    log("census connection lost; reconnecting in 3 s (a rendezvous from before pods has no census)")
                    try? await Task.sleep(nanoseconds: 3_000_000_000)
                    if let url, census == nil { watch(url: url) }
                }
                return
            }
            if ev["type"] as? String == "census" { onCensus(Census(ev)) }
        }
    }

    private func pingLoop(_ ws: URLSessionWebSocketTask, alive: @escaping () -> Bool) async {
        while alive() {
            try? await Task.sleep(nanoseconds: 10_000_000_000)
            guard alive() else { return }
            try? await ws.send(.string("ping"))
            if ws === socket, joined { keepMappingAlive() }
        }
    }

    private func onPeers(_ records: [[String: Any]]) {
        let peers = records.compactMap(SwarmPeer.init).filter { $0.id != ident.peerId }
        queue.async { [self] in
            let now = Dictionary(peers.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a })
            for p in peers where known[p.id] == nil { log("peer online: \(p.name) \(p.id.prefix(8))") }
            for (pid, name) in known where now[pid] == nil {
                log("peer left: \(name)")
                rows[pid] = nil
            }
            known = now
            publishRows()
        }
        onSwarm(peers)
    }

    private func setRow(_ pid: String, _ f: @escaping (inout PeerRow) -> Void) {
        queue.async { [self] in
            guard joined else { return }
            var r = rows[pid] ?? PeerRow(id: pid)
            f(&r)
            rows[pid] = r
            publishRows()
        }
    }

    private func publishRows() { onRows(rows.values.sorted { $0.id < $1.id }) }

    /// PeerNet._punch, send-only: the listener receives everything on our port, so we can't see the
    /// peer's answers. We don't need to: our probe reaching the peer is what makes it dial us, and the
    /// outgoing probes open our NAT for its packets. Spray until the peer has dialed in, or 4 s.
    private func punch(_ rec: [String: Any]) {
        guard let pid = rec["peer_id"] as? String else { return }
        let name = rec["name"] as? String ?? String(pid.prefix(8))
        var cands: [(String, UInt16)] = []
        var stunPorts: [UInt16] = []
        for e in rec["endpoints"] as? [[String: Any]] ?? [] {
            guard let ip = e["ip"] as? String, !ip.contains(":"), let p = e["port"] as? Int, p > 0 else { continue }
            cands.append((ip, UInt16(p)))
            if e["kind"] as? String == "stun" { stunPorts.append(UInt16(p)) }
        }
        if let obs = rec["observed_ip"] as? String, !obs.contains(":") {
            for p in stunPorts where !cands.contains(where: { $0 == (obs, p) }) { cands.append((obs, p)) }
        }
        log("\(name) wants to connect: probing " + cands.map { "\($0.0):\($0.1)" }.joined(separator: ", "))
        setRow(pid) { $0.state = "punching" }
        let ask = Wire.probe + Array("?".utf8) + Array(ident.peerId.utf8) + Array(pid.utf8)
        let deadline = Date().addingTimeInterval(4)
        let dialsBefore = queue.sync { dials }
        while Date() < deadline && joined && queue.sync(execute: { dials }) == dialsBefore {
            // A socket connected to the peer's address keeps Network.framework from answering that address,
            // so each burst opens, sends and closes at once.
            for (ip, p) in cands {
                guard let s = try? UDPSocket(localPort: port, host: ip, port: p) else { continue }
                s.send(ask)
                s.close()
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
        if queue.sync(execute: { dials }) == dialsBefore {
            log("\(name) hasn't dialed in yet after 4 s of probes")
            setRow(pid) { $0.state = "waiting for dial" }
        }
    }

    private func accept(_ g: NWConnectionGroup) {
        let remote = (g.descriptor as? NWMultiplexGroup)?.members.first.map { "\($0)" } ?? "?"
        let who = remote
        dials += 1
        log("incoming QUIC connection from \(who)")
        groups[ObjectIdentifier(g)] = g
        let authed = Box<String>()
        g.newConnectionHandler = { [weak self] s in
            self?.serve(s, as: self!.ident) { pid in
                authed.value = pid
                self?.linked(pid, g)
            }
        }
        g.stateUpdateHandler = { [weak self] st in
            guard let self else { return }
            switch st {
            case .failed, .cancelled:
                self.groups[ObjectIdentifier(g)] = nil
                if let pid = authed.value {
                    self.log("link to \(self.known[pid] ?? pid) closed")
                    self.setRow(pid) { $0.state = "closed"; $0.rttMs = nil }
                } else {
                    self.log("\(who) closed before authenticating: a duplicate dial (peers try each address), or a peer on 0.1.21 or older, which can't verify this certificate")
                }
            default: break
            }
        }
        g.start(queue: queue)
    }

    private func linked(_ pid: String, _ g: NWConnectionGroup) {
        let name = known[pid] ?? String(pid.prefix(8))
        log("direct link with \(name) ✅ (it dialed us and authenticated)")
        setRow(pid) { $0.state = "direct" }
        Task {
            if let info = try? await call(g, Wire.mInfo, [], queue: queue) {
                let s = NodeSummary(info)
                log("\(name) Info: \(s.slices.isEmpty ? "no slices" : "slices " + s.slices.joined(separator: ", "))")
            }
            var rtt: Double?
            while joined, groups[ObjectIdentifier(g)] != nil {
                let t = Date()
                guard (try? await call(g, Wire.mHeartbeat, [0x08] + varint(1), queue: queue)) != nil else { break }
                let ms = Date().timeIntervalSince(t) * 1000
                rtt = rtt.map { 0.7 * $0 + 0.3 * ms } ?? ms
                let r = rtt
                setRow(pid) { $0.rttMs = r }
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    // MARK: shared

    /// Answer one incoming call: Auth, Heartbeat (echo) and Info; anything else gets an empty reply.
    private func serve(_ s: NWConnection, as ident: PeerIdentity, onAuth: @escaping (String) -> Void) {
        Task {
            do {
                try await start(s, on: queue)
                let method = try await readExactly(s, 1)[0]
                let body = try await readFrame(s)
                var out: [UInt8] = []
                switch method {
                case Wire.mAuth:
                    let (reply, pid) = checkAuth(body, server: ident.peerId)
                    out = Array(reply.utf8)
                    if let pid { onAuth(pid) }
                case Wire.mHeartbeat: out = body
                case Wire.mInfo: out = pbString(1, name) + pbFloat(6, Float(ProcessInfo.processInfo.physicalMemory) / Float(1 << 30))
                default: break
                }
                try await send(s, frame(out), fin: true)
                queue.asyncAfter(deadline: .now() + 5) { s.cancel() }
            } catch {
                s.cancel()
            }
        }
    }

    /// The client's signed auth frame, as PeerNet._auth checks it.
    private func checkAuth(_ body: [UInt8], server: String) -> (String, String?) {
        guard let a = try? JSONSerialization.jsonObject(with: Data(body)) as? [String: String],
              let id = a["peer_id"], let pub = a["pub"].flatMap(unhex), let sig = a["sig"].flatMap(unhex) else { return ("bad auth: json", nil) }
        guard peerIdOf(pub) == id else { return ("peer_id does not match key", nil) }
        guard let k = try? Curve25519.Signing.PublicKey(rawRepresentation: pub),
              k.isValidSignature(sig, for: Data("podtorrent-auth|\(server)|\(id)".utf8)) else { return ("bad auth: InvalidSignature", nil) }
        return ("ok", id)
    }

    private func quicOptions(verify: ((SecCertificate?) -> Bool)?) -> NWProtocolQUIC.Options {
        let q = NWProtocolQUIC.Options(alpn: [Wire.alpn])
        q.idleTimeout = 30_000
        q.initialMaxData = Wire.window
        q.initialMaxStreamDataBidirectionalLocal = Wire.window
        q.initialMaxStreamDataBidirectionalRemote = Wire.window
        q.initialMaxStreamsBidirectional = 100
        let sec = q.securityProtocolOptions
        sec_protocol_options_set_min_tls_protocol_version(sec, .TLSv13)
        if let verify {
            sec_protocol_options_set_tls_server_name(sec, "podtorrent")
            sec_protocol_options_set_verify_block(sec, { _, trust, complete in
                let t = sec_trust_copy_ref(trust).takeRetainedValue()
                complete(verify((SecTrustCopyCertificateChain(t) as? [SecCertificate])?.first))
            }, queue)
        }
        return q
    }

    private func startGroup(_ g: NWConnectionGroup) async throws {
        try await withCheckedThrowingContinuation { (k: CheckedContinuation<Void, Error>) in
            let once = Once()
            g.stateUpdateHandler = { s in
                switch s {
                case .ready: once.run { k.resume() }
                case .failed(let e): once.run { k.resume(throwing: e) }
                case .cancelled: once.run { k.resume(throwing: WireError("cancelled")) }
                default: break
                }
            }
            g.start(queue: queue)
            queue.asyncAfter(deadline: .now() + 10) {
                once.run { g.cancel(); k.resume(throwing: WireError("QUIC handshake timed out (wrong address, or the peer serves an Ed25519 certificate)")) }
            }
        }
    }
}

final class Box<T>: @unchecked Sendable { var value: T? }

private func json(_ o: [String: Any]) -> String {
    String(decoding: (try? JSONSerialization.data(withJSONObject: o)) ?? Data(), as: UTF8.self)
}

/// (pod_id, secret) from a `pod1-<pod_id>-<base32 secret>` invite code (pod.py parse_invite).
func parseInvite(_ code: String) throws -> (id: String, secret: Data) {
    let parts = code.split(separator: "-").map(String.init)
    let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
    guard parts.count == 3, parts[0] == "pod1", parts[1].count == 32, unhex(parts[1]) != nil else {
        throw WireError("not a pod invite code")
    }
    var bits = 0, acc = 0, out = Data()
    for c in parts[2].uppercased() {
        guard let v = alphabet.firstIndex(of: c) else { throw WireError("not a pod invite code") }
        acc = (acc << 5) | v
        bits += 5
        if bits >= 8 { bits -= 8; out.append(UInt8((acc >> bits) & 0xff)) }
    }
    guard out.count == 16 else { throw WireError("not a pod invite code") }
    return (parts[1], out)
}

func deviceModel() -> String {
    var size = 0
    let key = "hw.machine"
    sysctlbyname(key, nil, &size, nil, 0)
    var b = [CChar](repeating: 0, count: size)
    sysctlbyname(key, &b, &size, nil, 0)
    return String(cString: b)
}
