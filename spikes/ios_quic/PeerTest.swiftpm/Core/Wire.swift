// The PodTorrent wire format (podtorrent/net/quic.py): one bidirectional QUIC stream per call, opening with
// [method u8], then [len u32 BE][protobuf] frames both ways. Protobuf is encoded by hand: the test only
// needs a few NodeInfo fields.
import CryptoKit
import Foundation
import Network

enum Wire {
    static let alpn = "podtorrent/1"
    static let probe: [UInt8] = [0x00] + Array("PTP".utf8)
    static let mAuth: UInt8 = 0, mHeartbeat: UInt8 = 1, mInfo: UInt8 = 2
    static let window = 64 << 20
}

struct WireError: Error, CustomStringConvertible {
    let description: String
    init(_ s: String) { description = s }
}

func hexString(_ d: some Sequence<UInt8>) -> String { d.map { String(format: "%02x", $0) }.joined() }

func unhex(_ s: String) -> Data? {
    guard s.count % 2 == 0 else { return nil }
    var out = Data(), i = s.startIndex
    while i < s.endIndex {
        let j = s.index(i, offsetBy: 2)
        guard let b = UInt8(s[i..<j], radix: 16) else { return nil }
        out.append(b); i = j
    }
    return out
}

func peerIdOf(_ pub: Data) -> String { String(hexString(SHA256.hash(data: pub)).prefix(32)) }

// ---- protobuf ----
func varint(_ v: UInt64) -> [UInt8] {
    var v = v, out: [UInt8] = []
    repeat { var b = UInt8(v & 0x7f); v >>= 7; if v != 0 { b |= 0x80 }; out.append(b) } while v != 0
    return out
}

func pbString(_ field: UInt64, _ s: String) -> [UInt8] {
    let u = Array(s.utf8); return varint(field << 3 | 2) + varint(UInt64(u.count)) + u
}

func pbFloat(_ field: UInt64, _ f: Float) -> [UInt8] {
    withUnsafeBytes(of: f.bitPattern.littleEndian) { varint(field << 3 | 5) + Array($0) }
}

/// Every field in a message: (number, varint value or nil, bytes for length-delimited fields).
func pbFields(_ d: [UInt8]) -> [(field: UInt64, int: UInt64?, bytes: [UInt8])] {
    var i = 0, out: [(UInt64, UInt64?, [UInt8])] = []
    func read() -> UInt64 {
        var v: UInt64 = 0, s: UInt64 = 0
        while i < d.count { let b = d[i]; i += 1; v |= UInt64(b & 0x7f) << s; s += 7; if b < 0x80 { break } }
        return v
    }
    while i < d.count {
        let tag = read(), field = tag >> 3
        switch tag & 7 {
        case 0: out.append((field, read(), []))
        case 1: out.append((field, nil, Array(d[i..<min(i + 8, d.count)]))); i += 8
        case 5: out.append((field, nil, Array(d[i..<min(i + 4, d.count)]))); i += 4
        case 2:
            let n = Int(read()); out.append((field, nil, Array(d[i..<min(i + n, d.count)]))); i += n
        default: return out
        }
    }
    return out
}

/// What the test reads from a peer's NodeInfo: its name and the layer slices it serves.
struct NodeSummary {
    var name = ""
    var slices: [String] = []

    init(_ d: [UInt8]) {
        for f in pbFields(d) {
            if f.field == 1 { name = String(decoding: f.bytes, as: UTF8.self) }
            if f.field == 12 {
                var lo = 0, hi = 0, loaded = false
                for s in pbFields(f.bytes) {
                    if s.field == 2 { lo = Int(s.int ?? 0) }
                    if s.field == 3 { hi = Int(s.int ?? 0) }
                    if s.field == 4 { loaded = s.int == 1 }
                }
                slices.append("\(lo)–\(hi)\(loaded ? "" : " (loading)")")
            }
        }
    }
}

// ---- streams ----
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
                else if done { k.resume(throwing: WireError("stream ended early")) }
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
    guard n <= 256 << 20 else { throw WireError("frame too large: \(n)") }
    return [UInt8](try await readExactly(c, n))
}

/// Resolves once the connection (or stream) is ready; fails on failure, cancel or `timeout` seconds.
func start(_ c: NWConnection, on queue: DispatchQueue, timeout: Double = 8) async throws {
    try await withCheckedThrowingContinuation { (k: CheckedContinuation<Void, Error>) in
        let once = Once()
        c.stateUpdateHandler = { s in
            switch s {
            case .ready: once.run { k.resume() }
            case .failed(let e): once.run { k.resume(throwing: e) }
            case .cancelled: once.run { k.resume(throwing: WireError("cancelled")) }
            default: break
            }
        }
        c.start(queue: queue)
        queue.asyncAfter(deadline: .now() + timeout) { once.run { c.cancel(); k.resume(throwing: WireError("timed out")) } }
    }
}

/// Runs its closure at most once (state handlers and timeouts race to resume one continuation).
final class Once: @unchecked Sendable {
    private var done = false
    private let lock = NSLock()
    func run(_ f: () -> Void) {
        lock.lock(); let first = !done; done = true; lock.unlock()
        if first { f() }
    }
}

/// One RPC = one new bidirectional stream on the connection.
func call(_ g: NWConnectionGroup, _ method: UInt8, _ body: [UInt8], queue: DispatchQueue) async throws -> [UInt8] {
    guard let s = NWConnection(from: g) else { throw WireError("can't open a stream") }
    try await start(s, on: queue)
    try await send(s, Data([method]) + frame(body), fin: true)
    let reply = try await readFrame(s)
    // Let the other side's FIN arrive before letting go, so we never reset a stream it is still closing.
    queue.asyncAfter(deadline: .now() + 5) { s.cancel() }
    return reply
}
