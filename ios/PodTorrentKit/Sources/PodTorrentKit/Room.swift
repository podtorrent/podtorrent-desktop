import Foundation

// The rendezvous side of pods (docs/PODS_PLAN.md, 4), as podtorrent/net/rendezvous.py speaks it:
// a pod room (/v1/pod/<id>) or the public lobby (/v1/public) sends `challenge {nonce}`, the machine
// answers `auth {pubkey, sig}` signing "podtorrent-room|<pod_id or public>|<nonce>", and gets a welcome.

/// Override with PODTORRENT_RENDEZVOUS, e.g. ws://localhost:8787 for `wrangler dev`.
public var rendezvousURL: String {
    (ProcessInfo.processInfo.environment["PODTORRENT_RENDEZVOUS"] ?? "wss://rendezvous.podtorrent.com")
        .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
}

public struct RoomError: Error, CustomStringConvertible {
    public let description: String
    public init(_ d: String) { description = d }
}

/// One WebSocket to a room, with the rendezvous' keepalive ("ping" every 10 s, answered "pong").
public final class RoomConnection: @unchecked Sendable {
    private let task: URLSessionWebSocketTask
    private var pinger: Task<Void, Never>?

    public init(url: URL, session: URLSession = .shared) {
        task = session.webSocketTask(with: url)
        task.resume()
        pinger = Task { [task] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                try? await task.send(.string("ping"))
            }
        }
    }

    deinit { close() }

    public func close() {
        pinger?.cancel()
        task.cancel(with: .normalClosure, reason: nil)
    }

    public func send(_ msg: JSON) async throws {
        let data = try JSONEncoder().encode(msg)
        try await task.send(.string(String(decoding: data, as: UTF8.self)))
    }

    /// The next event (pongs skipped); throws when the room closes the connection.
    public func next() async throws -> JSON {
        while true {
            let msg: URLSessionWebSocketTask.Message
            do { msg = try await task.receive() } catch {
                throw RoomError("the room closed the connection (\(task.closeCode.rawValue): \(task.closeReason.map { String(decoding: $0, as: UTF8.self) } ?? error.localizedDescription))")
            }
            guard case .string(let s) = msg, s != "pong" else { continue }
            return try JSON.parse(s)
        }
    }

    /// `next()`, or a RoomError after `seconds`.
    public func next(timeout seconds: Double) async throws -> JSON {
        try await withThrowingTaskGroup(of: JSON.self) { g in
            g.addTask { try await self.next() }
            g.addTask { try await Task.sleep(for: .seconds(seconds)); throw RoomError("timed out") }
            defer { g.cancelAll() }
            return try await g.next()!
        }
    }
}

/// Answer a room's challenge with this machine's key (offering `roster`); returns the welcome.
/// `room` is the pod id, or "public" for the lobby.
public func roomAuth(_ conn: RoomConnection, _ ident: Identity, room: String, roster: JSON? = nil, timeout: Double = 15) async throws -> JSON {
    let ev = try await conn.next(timeout: timeout)
    guard ev["type"] == .string("challenge"), let nonce = ev["nonce"]?.string else {
        throw RoomError("expected a challenge, got \(ev["type"]?.string ?? "nothing")")
    }
    var auth: [String: JSON] = ["type": .string("auth"), "pubkey": .string(ident.pubkeyHex),
                                "sig": .string(try ident.sign(Data("podtorrent-room|\(room)|\(nonce)".utf8)))]
    if let roster { auth["roster"] = roster }
    try await conn.send(.object(auth))
    while true {
        let ev = try await conn.next(timeout: timeout)
        if ev["type"] == .string("welcome") { return ev }
    }
}

private func lists(_ r: JSON?, _ peerId: String) -> Bool {
    r?["members"]?.array?.contains { $0["peer_id"]?.string == peerId } ?? false
}

/// Ask a pod's owner (through the pod's room) to add this machine, with an invite code. Returns the
/// first valid roster that lists this machine; throws when the owner refuses or doesn't answer.
/// An owner just moving into the room is asked again every 3 s for 12 s.
public func joinPod(_ ident: Identity, code: String, name: String, base: String = rendezvousURL, timeout: Double = 45) async throws -> Roster {
    let (podId, secret) = try parseInvite(code)
    let proof = inviteProof(secret: secret, podId: podId, pubkey: ident.pubkeyHex)
    let conn = RoomConnection(url: URL(string: "\(base)/v1/pod/\(podId)")!)
    defer { conn.close() }
    let request: JSON = .object(["type": .string("join_request"), "name": .string(name), "proof": .string(proof)])
    let start = Date()
    let welcome = try await roomAuth(conn, ident, room: podId)
    func accept(_ r: JSON?) -> Roster? {
        guard let r, lists(r, ident.peerId), let roster = newer(nil, r), roster.podId == podId else { return nil }
        return roster
    }
    if welcome["member"] == .bool(true), let r = accept(welcome["roster"]) { return r }
    try await conn.send(request)
    while true {
        let left = timeout - Date().timeIntervalSince(start)
        guard left > 0 else { throw RoomError("the pod's owner didn't answer; is it online?") }
        let ev: JSON
        do { ev = try await conn.next(timeout: left) } catch let e as RoomError where e.description == "timed out" { continue }
        switch ev["type"]?.string {
        case "join_failed":
            let elapsed = Date().timeIntervalSince(start)
            guard ev["offline"] == .bool(true), elapsed + 3 < min(timeout, 12) else {
                throw RoomError(ev["reason"]?.string ?? "refused")
            }
            try await Task.sleep(for: .seconds(3))
            try await conn.send(request)
        case "roster":
            if let r = accept(ev["roster"]) { return r }
        default: break
        }
    }
}

/// What a machine offers the matchmaker from the lobby (see PeerApp.supply in Python).
public struct Supply: Sendable {
    public struct Model: Sendable {
        public let model: String; public let layers: Int; public let gb: Double; public let held: [(Int, Int)]
        public init(model: String, layers: Int, gb: Double, held: [(Int, Int)] = []) {
            self.model = model; self.layers = layers; self.gb = gb; self.held = held
        }
    }
    public let name, chip: String
    public let memTotalGB, memFreeGB: Double
    public let node: Bool
    public let models: [Model]
    public init(name: String, chip: String, memTotalGB: Double, memFreeGB: Double, node: Bool = false, models: [Model]) {
        self.name = name; self.chip = chip; self.memTotalGB = memTotalGB; self.memFreeGB = memFreeGB; self.node = node; self.models = models
    }

    var json: JSON {
        .object(["name": .string(name), "chip": .string(chip), "node": .bool(node),
            "mem_total_gb": .double(memTotalGB), "mem_free_gb": .double((memFreeGB * 2).rounded(.down) / 2),
            "models": .array(models.map { m in .object(["model": .string(m.model), "layers": .int(m.layers), "gb": .double(m.gb),
                "held": .array(m.held.map { .array([.int($0.0), .int($0.1)]) })]) })])
    }
}

/// Wait in the public lobby, offering `supply`, until the matchmaker assigns a public pod; returns
/// its roster (checked against the shipped matchmaker keys). Call it again when that pod dissolves.
public func waitForPublicPod(_ ident: Identity, supply: Supply, base: String = rendezvousURL) async throws -> Roster {
    let conn = RoomConnection(url: URL(string: "\(base)/v1/public")!)
    defer { conn.close() }
    _ = try await roomAuth(conn, ident, room: "public")
    try await conn.send(.object(["type": .string("supply"), "supply": supply.json]))
    while true {
        let ev = try await conn.next()
        if ev["type"] == .string("assign"), let r = ev["roster"], lists(r, ident.peerId), let roster = newer(nil, r) {
            return roster
        }
    }
}
