// Network.framework QUIC against the Python PeerNet (podtorrent/net/quic.py).
//
//   swift run QuicSpike dial HOST PORT [EXPECTED_PEER_ID] [--probe]
//     Dials as a QUIC client, checks the server's Ed25519 certificate, sends the signed auth frame,
//     runs Heartbeat/Info RPCs (and an 8 MB echo), and answers the server's Info call back to us.
//     --probe first sends a punch probe from the same local UDP port QUIC then uses.
//   swift run QuicSpike listen PORT DIR
//     Serves QUIC with DIR/swift.p12 (P-256 cert + identity extension) as identity DIR/swift.seed,
//     with a BSD socket bound to the same port alongside (where STUN and probes would go).
import CryptoKit
import Foundation
import Network
import Security

let ALPN = "podtorrent/1"
let PROBE: [UInt8] = [0x00] + Array("PTP".utf8)
let M_AUTH: UInt8 = 0, M_HEARTBEAT: UInt8 = 1, M_INFO: UInt8 = 2
let WINDOW: UInt64 = 64 << 20
let queue = DispatchQueue(label: "spike")

func log(_ s: String) { print("swift: \(s)"); fflush(stdout) }
func hex(_ d: some Sequence<UInt8>) -> String { d.map { String(format: "%02x", $0) }.joined() }
func peerId(_ pub: Data) -> String { String(hex(SHA256.hash(data: pub)).prefix(32)) }

// ---- identity ----
var key = Curve25519.Signing.PrivateKey()
var myId = peerId(key.publicKey.rawRepresentation)

/// The raw Ed25519 key in a DER certificate: SPKI is SEQ{ SEQ{ OID 1.3.101.112 }, BIT STRING 00 || 32 bytes }.
func ed25519Key(inCert der: Data) -> Data? {
    let marker: [UInt8] = [0x06, 0x03, 0x2B, 0x65, 0x70, 0x03, 0x21, 0x00]
    let b = [UInt8](der)
    guard b.count >= marker.count + 32 else { return nil }
    for i in 0...(b.count - marker.count - 32) where Array(b[i..<i + marker.count]) == marker {
        return Data(b[(i + marker.count)..<(i + marker.count + 32)])
    }
    return nil
}

let ID_EXT: [UInt8] = [0x06, 0x0a, 0x2b, 0x06, 0x01, 0x04, 0x01, 0x83, 0xa2, 0x5a, 0x4d, 0x01]  // OID 1.3.6.1.4.1.53594.77.1 (TLV prefix)

/// The Ed25519 identity a server certificate proves: either its own key (what aioquic peers serve today),
/// or, for a P-256 certificate, the key in the identity extension whose signature covers that P-256 key.
func identityKey(_ cert: SecCertificate) -> Data? {
    let der = SecCertificateCopyData(cert) as Data
    if let k = ed25519Key(inCert: der) { return k }
    let b = [UInt8](der)
    let want = ID_EXT + [0x04, 0x60]
    guard let i = (0...(b.count - want.count - 96)).first(where: { Array(b[$0..<$0 + want.count]) == want }),
          let leaf = SecCertificateCopyKey(cert),
          let point = SecKeyCopyExternalRepresentation(leaf, nil) as Data? else { return nil }
    let proof = Data(b[(i + want.count)..<(i + want.count + 96)])
    let pub = proof.prefix(32), sig = proof.suffix(64)
    guard let k = try? Curve25519.Signing.PublicKey(rawRepresentation: pub),
          k.isValidSignature(sig, for: Data("podtorrent-tls|".utf8) + point) else { return nil }
    return pub
}

// ---- protobuf, by hand (just the fields the spike needs) ----
func varint(_ v: UInt64) -> [UInt8] {
    var v = v, out: [UInt8] = []
    repeat { var b = UInt8(v & 0x7f); v >>= 7; if v != 0 { b |= 0x80 }; out.append(b) } while v != 0
    return out
}
func pbString(_ field: UInt64, _ s: String) -> [UInt8] {
    let u = Array(s.utf8); return varint(field << 3 | 2) + varint(UInt64(u.count)) + u
}
func pbFirstString(_ field: UInt64, _ d: [UInt8]) -> String? {
    var i = 0
    func read() -> UInt64 { var v: UInt64 = 0, s: UInt64 = 0; while i < d.count { let b = d[i]; i += 1; v |= UInt64(b & 0x7f) << s; s += 7; if b < 0x80 { break } }; return v }
    while i < d.count {
        let tag = read(), wire = tag & 7
        switch wire {
        case 0: _ = read()
        case 1: i += 8
        case 5: i += 4
        case 2:
            let n = Int(read()); let body = Array(d[i..<min(i + n, d.count)]); i += n
            if tag >> 3 == field { return String(decoding: body, as: UTF8.self) }
        default: return nil
        }
    }
    return nil
}

// ---- streams: [method u8] then [len u32 BE][body] frames ----
func frame(_ body: [UInt8]) -> Data {
    var n = UInt32(body.count).bigEndian
    return Data(bytes: &n, count: 4) + Data(body)
}

func send(_ c: NWConnection, _ d: Data, fin: Bool) async throws {
    try await withCheckedThrowingContinuation { (k: CheckedContinuation<Void, Error>) in
        c.send(content: d, contentContext: fin ? .finalMessage : .defaultMessage, isComplete: fin,
               completion: .contentProcessed { e in if let e { k.resume(throwing: e) } else { k.resume() } })
    }
}

func readExactly(_ c: NWConnection, _ n: Int) async throws -> Data {
    var out = Data()
    while out.count < n {
        let chunk: Data = try await withCheckedThrowingContinuation { k in
            c.receive(minimumIncompleteLength: 1, maximumLength: n - out.count) { d, _, done, e in
                if let e { k.resume(throwing: e) }
                else if let d, !d.isEmpty { k.resume(returning: d) }
                else if done { k.resume(throwing: NWError.posix(.ECONNRESET)) }
                else { k.resume(returning: Data()) }
            }
        }
        out += chunk
    }
    return out
}

func readFrame(_ c: NWConnection) async throws -> [UInt8] {
    let h = try await readExactly(c, 4)
    let n = Int(h.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).bigEndian })
    return [UInt8](try await readExactly(c, n))
}

func waitReady(_ c: NWConnection) async throws {
    try await withCheckedThrowingContinuation { (k: CheckedContinuation<Void, Error>) in
        var done = false
        c.stateUpdateHandler = { s in
            guard !done else { return }
            switch s {
            case .ready: done = true; k.resume()
            case .failed(let e), .waiting(let e): done = true; k.resume(throwing: e)
            case .cancelled: done = true; k.resume(throwing: NWError.posix(.ECANCELED))
            default: break
            }
        }
        c.start(queue: queue)
    }
}

/// One RPC = one new bidirectional stream on the connection group.
func call(_ g: NWConnectionGroup, _ method: UInt8, _ body: [UInt8]) async throws -> [UInt8] {
    guard let s = NWConnection(from: g) else { throw NWError.posix(.ENOTCONN) }
    try await waitReady(s)
    defer { s.cancel() }
    try await send(s, Data([method]) + frame(body), fin: true)
    if body.count > 1000 { log("  sent \(body.count) bytes") }
    let h = try await readExactly(s, 4)
    let n = Int(h.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).bigEndian })
    if body.count > 1000 { log("  reply header says \(n) bytes") }
    return [UInt8](try await readExactly(s, n))
}

func withTimeout<T>(_ secs: Double, _ f: @escaping () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await f() }
        group.addTask { try await Task.sleep(nanoseconds: UInt64(secs * 1e9)); throw NWError.posix(.ETIMEDOUT) }
        defer { group.cancelAll() }
        return try await group.next()!
    }
}

// ---- QUIC options shared by both roles ----
func quicOptions(verify: ((SecCertificate?) -> Bool)? = nil) -> NWProtocolQUIC.Options {
    let q = NWProtocolQUIC.Options(alpn: [ALPN])
    q.idleTimeout = 30_000
    q.initialMaxData = Int(WINDOW)
    q.initialMaxStreamDataBidirectionalLocal = Int(WINDOW)
    q.initialMaxStreamDataBidirectionalRemote = Int(WINDOW)
    q.initialMaxStreamsBidirectional = 100
    let sec = q.securityProtocolOptions
    sec_protocol_options_set_min_tls_protocol_version(sec, .TLSv13)
    if let verify {
        sec_protocol_options_set_tls_server_name(sec, "podtorrent")
        sec_protocol_options_set_verify_block(sec, { _, trust, complete in
            let t = sec_trust_copy_ref(trust).takeRetainedValue()
            let chain = (SecTrustCopyCertificateChain(t) as? [SecCertificate]) ?? []
            complete(verify(chain.first))   // peer_id itself is compared after the handshake
        }, queue)
    }
    return q
}

func reuse(_ p: NWParameters, localPort: UInt16) {
    if ProcessInfo.processInfo.environment["NOREUSE"] != nil { return }
    p.allowLocalEndpointReuse = true
    p.requiredLocalEndpoint = .hostPort(host: "0.0.0.0", port: NWEndpoint.Port(rawValue: localPort)!)
}

/// Serve the calls the Python side makes to us (it asks for Info right after auth).
func serveIncoming(_ s: NWConnection) {
    Task {
        do {
            try await waitReady(s)
            let method = try await readExactly(s, 1)[0]
            let body = try await readFrame(s)
            let out: [UInt8] = method == M_INFO ? pbString(1, "swift-peer")
                : method == M_HEARTBEAT ? body
                : method == M_AUTH ? Array(checkAuth(body).utf8) : []
            if method != M_HEARTBEAT { log("incoming call method=\(method) → \(out.count) bytes") }
            try await send(s, frame(out), fin: true)
        } catch { log("incoming stream: \(error)") }
    }
}

/// The client's signed auth frame (podtorrent/net/quic.py PeerNet._auth).
func checkAuth(_ body: [UInt8]) -> String {
    guard let a = try? JSONSerialization.jsonObject(with: Data(body)) as? [String: String],
          let id = a["peer_id"], let pub = a["pub"].flatMap(unhex), let sig = a["sig"].flatMap(unhex) else { return "bad auth: json" }
    guard peerId(pub) == id else { return "peer_id does not match key" }
    guard let k = try? Curve25519.Signing.PublicKey(rawRepresentation: pub),
          k.isValidSignature(sig, for: Data("podtorrent-auth|\(myId)|\(id)".utf8)) else { return "bad auth: InvalidSignature" }
    log("authenticated client \(id)")
    return "ok"
}

func unhex(_ s: String) -> Data? {
    var out = Data(), i = s.startIndex
    while i < s.endIndex {
        let j = s.index(i, offsetBy: 2, limitedBy: s.endIndex) ?? s.endIndex
        guard let b = UInt8(s[i..<j], radix: 16) else { return nil }
        out.append(b); i = j
    }
    return out
}

func bsdSocket(port: UInt16) throws -> Int32 {
    let fd = socket(AF_INET, SOCK_DGRAM, 0)
    var one: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, 4)
    setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &one, 4)
    var local = sockaddr_in(); local.sin_family = sa_family_t(AF_INET); local.sin_port = port.bigEndian
    let rc = withUnsafePointer(to: &local) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, 16) } }
    guard rc == 0 else { throw NWError.posix(POSIXErrorCode(rawValue: errno)!) }
    return fd
}

func countStolen(_ fd: Int32) {
    Thread.detachNewThread {
        var buf = [UInt8](repeating: 0, count: 65536), quic = 0, other = 0
        while true {
            let n = recv(fd, &buf, buf.count, 0)
            if n > 0 { if buf[0] & 0x40 != 0 { quic += 1 } else { other += 1 }
                       if (quic + other) % 10 == 1 { log("probe socket stole \(quic) QUIC + \(other) other datagrams") } }
        }
    }
}

// ---- dial ----
func dial(host: String, port: UInt16, expect: String?, probe: Bool, from: UInt16? = nil) async throws {
    let localPort = from ?? UInt16.random(in: 50_000...60_000)
    log("my peer_id \(myId), local udp/\(localPort)")
    let target = NWEndpoint.hostPort(host: .init(host), port: .init(rawValue: port)!)

    var probeSock: Int32 = -1
    if probe {
        // Network.framework will not pin a UDP NWConnection to a reused local port (ENOTSUP), so STUN and
        // punch probes go out of a BSD socket bound to the same port QUIC then uses (SO_REUSEPORT on both).
        probeSock = socket(AF_INET, SOCK_DGRAM, 0)
        var one: Int32 = 1
        setsockopt(probeSock, SOL_SOCKET, SO_REUSEADDR, &one, 4)
        setsockopt(probeSock, SOL_SOCKET, SO_REUSEPORT, &one, 4)
        var tv = timeval(tv_sec: 1, tv_usec: 0)
        setsockopt(probeSock, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        var local = sockaddr_in(); local.sin_family = sa_family_t(AF_INET); local.sin_port = localPort.bigEndian
        var dst = sockaddr_in(); dst.sin_family = sa_family_t(AF_INET); dst.sin_port = port.bigEndian
        inet_pton(AF_INET, host, &dst.sin_addr)
        let rc = withUnsafePointer(to: &local) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(probeSock, $0, 16) } }
        guard rc == 0 else { throw NWError.posix(POSIXErrorCode(rawValue: errno)!) }
        let pkt = PROBE + Array("?".utf8) + Array(myId.utf8) + Array((expect ?? String(repeating: "0", count: 32)).utf8)
        for _ in 0..<3 {
            _ = withUnsafePointer(to: &dst) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { sendto(probeSock, pkt, pkt.count, 0, $0, 16) } }
        }
        var buf = [UInt8](repeating: 0, count: 2048)
        let n = recv(probeSock, &buf, buf.count, 0)
        log(n > 4 && Array(buf[0..<4]) == PROBE ? "probe answered (\(String(decoding: buf[4..<5], as: UTF8.self))) on the BSD socket, udp/\(localPort)"
                                                : "no probe answer (n=\(n), errno=\(errno))")
    }
    if probeSock >= 0 {
        // Count QUIC datagrams that land on the probe socket instead of the QUIC connection.
        let fd = probeSock
        Thread.detachNewThread {
            var buf = [UInt8](repeating: 0, count: 65536), quic = 0, other = 0
            while true {
                let n = recv(fd, &buf, buf.count, 0)
                if n > 0 { if buf[0] & 0x40 != 0 { quic += 1 } else { other += 1 }
                           if (quic + other) % 10 == 1 { log("probe socket stole \(quic) QUIC + \(other) other datagrams") } }
            }
        }
    }

    var serverKey: Data?
    let p = NWParameters(quic: quicOptions(verify: { cert in
        serverKey = cert.flatMap(identityKey)
        if serverKey == nil { log("server certificate carries no valid identity") }
        return serverKey != nil
    }))
    reuse(p, localPort: localPort)
    let g = NWConnectionGroup(with: NWMultiplexGroup(to: target), using: p)
    g.newConnectionHandler = serveIncoming
    let t0 = Date()
    try await withCheckedThrowingContinuation { (k: CheckedContinuation<Void, Error>) in
        var done = false
        g.stateUpdateHandler = { s in
            log("group state \(s)")
            guard !done else { return }
            switch s {
            case .ready: done = true; k.resume()
            case .failed(let e): done = true; k.resume(throwing: e)
            case .cancelled: done = true; k.resume(throwing: NWError.posix(.ECANCELED))
            default: break
            }
        }
        g.start(queue: queue)
        queue.asyncAfter(deadline: .now() + 8) {
            guard !done else { return }
            done = true; g.cancel(); k.resume(throwing: NWError.posix(.ETIMEDOUT))
        }
    }
    log(String(format: "QUIC handshake ok in %.0f ms", Date().timeIntervalSince(t0) * 1000))

    guard let serverKey else { throw NSError(domain: "spike", code: 1, userInfo: [NSLocalizedDescriptionKey: "no Ed25519 key in server cert"]) }
    let server = peerId(serverKey)
    log("server cert peer_id \(server)\(expect.map { $0 == server ? " (matches)" : " (EXPECTED \($0))" } ?? "")")

    let sig = try key.signature(for: Data("podtorrent-auth|\(server)|\(myId)".utf8))
    let auth = try JSONSerialization.data(withJSONObject: ["peer_id": myId, "pub": hex(key.publicKey.rawRepresentation), "sig": hex(sig)])
    let reply = try await call(g, M_AUTH, [UInt8](auth))
    log("auth reply: \(String(decoding: reply, as: UTF8.self))")

    for _ in 0..<5 {
        let t = Date()
        _ = try await call(g, M_HEARTBEAT, [0x08] + varint(UInt64(Date().timeIntervalSince1970 * 1e9)))
        log(String(format: "heartbeat rtt %.2f ms", Date().timeIntervalSince(t) * 1000))
    }
    let info = try await call(g, M_INFO, [])
    log("Info.name = \(pbFirstString(1, info) ?? "?")")

    for kb in [16, 256, 1024, 4096, 8192] {
        let big = [UInt8]((0..<(kb << 10)).map { UInt8(truncatingIfNeeded: $0 &* 2654435761 >> 13) })
        let t = Date()
        let echo = try await withTimeout(20) { try await call(g, M_HEARTBEAT, big) }
        let dt = Date().timeIntervalSince(t)
        log(String(format: "%5d KB echo %@ in %.0f ms (%.1f MB/s each way)", kb, echo == big ? "intact" : "CORRUPT", dt * 1000, Double(kb) / 1024 / dt))
    }

    log("holding the connection 6 s so the server's Info call and heartbeats land")
    try await Task.sleep(nanoseconds: 6_000_000_000)
    g.cancel()
}

// ---- listen ----
func listen(port: UInt16, dir: String) async throws {
    key = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(contentsOf: URL(fileURLWithPath: dir + "/swift.seed")))
    myId = peerId(key.publicKey.rawRepresentation)
    let blob = try Data(contentsOf: URL(fileURLWithPath: dir + "/swift.p12"))
    var items: CFArray?
    var opts: [String: Any] = [kSecImportExportPassphrase as String: "spike"]
    if #available(macOS 15, *) { opts[kSecImportToMemoryOnly as String] = true }   // the iOS default
    let st = SecPKCS12Import(blob as CFData, opts as CFDictionary, &items)
    guard st == errSecSuccess, let first = (items as? [[String: Any]])?.first,
          let idAny = first[kSecImportItemIdentity as String] else {
        throw NSError(domain: "spike", code: Int(st), userInfo: [NSLocalizedDescriptionKey:
            "SecPKCS12Import failed: \(st) \(SecCopyErrorMessageString(st, nil) as String? ?? "")"])
    }
    let q = quicOptions()
    sec_protocol_options_set_local_identity(q.securityProtocolOptions, sec_identity_create(idAny as! SecIdentity)!)
    let p = NWParameters(quic: q)
    p.allowLocalEndpointReuse = true
    let l = try NWListener(using: p, on: .init(rawValue: port)!)
    l.newConnectionGroupHandler = { g in
        log("incoming QUIC connection")
        g.newConnectionHandler = serveIncoming
        g.stateUpdateHandler = { st in
            log("group \(st)")
            if case .ready = st {
                Task {
                    try await Task.sleep(nanoseconds: 500_000_000)   // after the client's auth
                    let info = try await call(g, M_INFO, [])
                    log("server→client Info call: name = \(pbFirstString(1, info) ?? "?")")
                }
            }
        }
        g.start(queue: queue)
    }
    l.stateUpdateHandler = { log("listener \($0)") }
    l.start(queue: queue)
    try await Task.sleep(nanoseconds: 300_000_000)
    let env = ProcessInfo.processInfo.environment
    if let to = env["PROBE_TO"] {
        // A probe socket *connected* to one remote only ever receives from that remote.
        let parts = to.split(separator: ":"), fd = try bsdSocket(port: port)
        var dst = sockaddr_in(); dst.sin_family = sa_family_t(AF_INET); dst.sin_port = UInt16(parts[1])!.bigEndian
        inet_pton(AF_INET, String(parts[0]), &dst.sin_addr)
        let rc = withUnsafePointer(to: &dst) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, 16) } }
        log("connected probe socket to \(to): rc=\(rc)")
        let pkt = PROBE + Array("?".utf8) + Array(myId.utf8) + Array(String(repeating: "0", count: 32).utf8)
        _ = send(fd, pkt, pkt.count, 0)
        if env["KEEP"] != nil {
            countStolen(fd)
        } else {
            queue.asyncAfter(deadline: .now() + 1) {
                var buf = [UInt8](repeating: 0, count: 2048), got = 0
                while recv(fd, &buf, buf.count, MSG_DONTWAIT) > 0 { got += 1 }
                close(fd)
                log("closed the probe socket (it had received \(got) datagrams)")
            }
        }
    } else if env["NOBSD"] == nil {
        do { countStolen(try bsdSocket(port: port)) } catch { log("BSD socket on udp/\(port) after the listener: \(error)") }
    }
    if let to = env["DIAL_TO"] {
        // Dial out from the listener's own port, as a real peer must.
        let parts = to.split(separator: ":")
        try await dial(host: String(parts[0]), port: UInt16(parts[1])!, expect: parts.count > 2 ? String(parts[2]) : nil,
                       probe: false, from: port)
        return
    }
    log("peer_id \(myId) listening on udp/\(port) (BSD socket bound alongside)")
    try await Task.sleep(nanoseconds: 60_000_000_000)
}

let args = CommandLine.arguments
do {
    switch args.dropFirst().first {
    case "dial":
        try await dial(host: args[2], port: UInt16(args[3])!, expect: args.count > 4 && !args[4].hasPrefix("--") ? args[4] : nil,
                       probe: args.contains("--probe"))
    case "listen":
        try await listen(port: UInt16(args[2])!, dir: args[3])
    default:
        print("usage: QuicSpike dial HOST PORT [PEER_ID] [--probe] | listen PORT DIR")
    }
} catch {
    log("FAILED: \(error)")
    exit(1)
}
