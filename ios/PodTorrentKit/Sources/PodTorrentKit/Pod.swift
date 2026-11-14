import CryptoKit
import Foundation

// Pods: the signed roster that says which machines serve together (docs/PODS_PLAN.md). A port of
// podtorrent/pod.py, which is the reference; tests/pod_vectors.json decides when they disagree.

/// Public halves of the matchmaker keys allowed to sign public rosters (the rendezvous Worker's MATCHMAKER_SEED
/// secret), from this build's endpoints.json.
public var matchmakers: [String] { Endpoints.matchmakers }
public let rosterDomain = "podtorrent-roster|"
public let inviteDomain = "podtorrent-invite|"

/// `rawValue` is the code shared by every port; the case names follow it.
public enum RosterError: String, Error, Equatable {
    case badShape = "bad-shape", badKind = "bad-kind", badValue = "bad-value", podIdMismatch = "pod-id-mismatch"
    case badSignature = "bad-signature", badMembers = "bad-members", untrustedSigner = "untrusted-signer"
    case expired, badPlan = "bad-plan", badInvite = "bad-invite"
}

// MARK: hex and hashing

public func hex<D: Sequence>(_ bytes: D) -> String where D.Element == UInt8 {
    bytes.map { String(format: "%02x", $0) }.joined()
}

public func unhex(_ s: String) -> Data? {
    guard s.count % 2 == 0, isHex(s) else { return nil }
    var out = Data(capacity: s.count / 2)
    var it = s.utf8.makeIterator()
    while let a = it.next(), let b = it.next() {
        out.append(UInt8(String(decoding: [a, b], as: UTF8.self), radix: 16)!)
    }
    return out
}

func isHex(_ s: String, _ n: Int? = nil) -> Bool {
    (n == nil || s.utf8.count == n!) && s.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
}

public func sha256Hex(_ parts: Data...) -> String {
    var h = SHA256()
    for p in parts { h.update(data: p) }
    return hex(h.finalize())
}

/// sha256(pubkey)[:16], hex: a machine's id everywhere (QUIC, rooms, rosters).
public func peerId(ofPubkey pub: Data) -> String { String(sha256Hex(pub).prefix(32)) }

public func podId(signer: String, salt: String) -> String {
    String(sha256Hex(unhex(signer) ?? Data(), unhex(salt) ?? Data()).prefix(32))
}

// MARK: identity

/// This machine's Ed25519 key. CryptoKit signatures carry randomness, so they differ from Python's
/// byte for byte but verify the same everywhere.
public struct Identity: Sendable {
    public let key: Curve25519.Signing.PrivateKey
    public init(key: Curve25519.Signing.PrivateKey = .init()) { self.key = key }
    public init(seedHex: String) throws { key = try .init(rawRepresentation: unhex(seedHex) ?? Data()) }
    public var pubkeyHex: String { hex(key.publicKey.rawRepresentation) }
    public var peerId: String { PodTorrentKit.peerId(ofPubkey: key.publicKey.rawRepresentation) }
    public func sign(_ msg: Data) throws -> String { hex(try key.signature(for: msg)) }
}

func ed25519Verify(pubkey: String, sig: String, msg: Data) -> Bool {
    guard let p = unhex(pubkey), let s = unhex(sig), let k = try? Curve25519.Signing.PublicKey(rawRepresentation: p) else { return false }
    return k.isValidSignature(s, for: msg)
}

// MARK: rosters

public struct Member: Equatable, Sendable { public let peerId, pubkey, name: String; public let isPublic: Bool }
public struct Hop: Equatable, Sendable { public let peer: String; public let lo, hi: Int }
public struct Plan: Equatable, Sendable { public let model: String; public let layers: Int; public let head: String; public let hops: [Hop] }

/// A roster that passed `verify`. `json` is the signed original, to store and pass on unchanged.
public struct Roster: Equatable, Sendable {
    public let json: JSON
    public let podId, kind, name, signer: String
    public let version, expires: Int
    public let members: [Member]
    public let plans: [Plan]

    public func isMember(_ peerId: String) -> Bool { members.contains { $0.peerId == peerId } }
    /// The owner machine's peer_id; nil for a public pod, whose signer is the matchmaker.
    public var ownerId: String? { kind == "public" ? nil : PodTorrentKit.peerId(ofPubkey: unhex(signer)!) }
    public func plan(for model: String) -> Plan? { plans.first { $0.model == model } }
}

public func signingInput(_ roster: JSON) throws -> Data {
    guard var o = roster.object else { throw RosterError.badShape }
    o["sig"] = nil
    return Data((rosterDomain + (try canonical(.object(o)))).utf8)
}

/// `roster` if it is well formed, signed by an allowed signer and not expired; else the RosterError
/// whose code pod.py would give. Same checks in the same order.
public func verify(_ roster: JSON, now: Double = Date().timeIntervalSince1970, matchmakers allowed: [String] = matchmakers) throws -> Roster {
    func need(_ ok: Bool, _ e: RosterError) throws { if !ok { throw e } }
    guard let r = roster.object else { throw RosterError.badShape }
    let keys: Set = ["pod_id", "salt", "kind", "name", "version", "signer", "members", "plans", "expires", "sig"]
    try need(Set(r.keys) == keys, .badShape)
    guard let kind = r["kind"]?.string else { throw RosterError.badKind }
    try need(["private", "public", "alone"].contains(kind), .badKind)
    guard let name = r["name"]?.string, (1...64).contains(name.unicodeScalars.count) else { throw RosterError.badShape }
    guard let version = r["version"]?.int, version >= 1 else { throw RosterError.badShape }
    guard let expires = r["expires"]?.int, expires >= 0 else { throw RosterError.badShape }
    guard let signer = r["signer"]?.string, let salt = r["salt"]?.string, let sig = r["sig"]?.string,
          isHex(signer, 64), isHex(salt, 32), isHex(sig, 128) else { throw RosterError.badShape }
    try need(r["pod_id"]?.string == podId(signer: signer, salt: salt), .podIdMismatch)
    try need(ed25519Verify(pubkey: signer, sig: sig, msg: try signingInput(roster)), .badSignature)

    guard let ms = r["members"]?.array, !ms.isEmpty else { throw RosterError.badMembers }
    var members: [Member] = [], ids = Set<String>()
    for m in ms {
        guard let o = m.object, Set(o.keys).subtracting(["public"]) == ["peer_id", "pubkey", "name"],
              let pub = o["pubkey"]?.string, isHex(pub, 64), let mname = o["name"]?.string,
              o["public"] == nil || o["public"] == .bool(true) else { throw RosterError.badMembers }
        let pid = o["peer_id"]?.string
        try need(pid == peerId(ofPubkey: unhex(pub)!), .badMembers)
        try need(!ids.contains(pid!), .badMembers)
        ids.insert(pid!)
        members.append(Member(peerId: pid!, pubkey: pub, name: mname, isPublic: o["public"] != nil))
    }

    if kind == "public" {
        try need(allowed.contains(signer), .untrustedSigner)
        try need(expires > 0, .badShape)
    } else {
        try need(ids.contains(peerId(ofPubkey: unhex(signer)!)), .untrustedSigner)
        try need(!members.contains { $0.isPublic } || kind == "private", .badMembers)
    }
    if kind == "alone" { try need(members.count == 1, .badMembers) }
    if expires > 0 { try need(now < Double(expires), .expired) }

    guard let ps = r["plans"]?.array else { throw RosterError.badPlan }
    var plans: [Plan] = [], models = Set<String>()
    for p in ps {
        guard let o = p.object, Set(o.keys) == ["model", "layers", "head", "hops"],
              let model = o["model"]?.string, !models.contains(model) else { throw RosterError.badPlan }
        models.insert(model)
        guard let layers = o["layers"]?.int, layers > 0 else { throw RosterError.badPlan }
        guard let head = o["head"]?.string, ids.contains(head) else { throw RosterError.badPlan }
        guard let hs = o["hops"]?.array, !hs.isEmpty else { throw RosterError.badPlan }
        var hops: [Hop] = [], at = 0
        for h in hs {
            guard let ho = h.object, Set(ho.keys) == ["peer", "lo", "hi"], let peer = ho["peer"]?.string, ids.contains(peer),
                  let lo = ho["lo"]?.int, let hi = ho["hi"]?.int, lo == at, hi > at else { throw RosterError.badPlan }
            hops.append(Hop(peer: peer, lo: lo, hi: hi))
            at = hi
        }
        try need(at == layers, .badPlan)
        plans.append(Plan(model: model, layers: layers, head: head, hops: hops))
    }
    return Roster(json: roster, podId: r["pod_id"]!.string!, kind: kind, name: name, signer: signer,
                  version: version, expires: expires, members: members, plans: plans)
}

/// `incoming` if it is valid and replaces `current` (same pod, higher version), else nil.
public func newer(_ current: Roster?, _ incoming: JSON, now: Double = Date().timeIntervalSince1970,
                  matchmakers allowed: [String] = matchmakers) -> Roster? {
    guard let r = try? verify(incoming, now: now, matchmakers: allowed) else { return nil }
    guard let cur = current else { return r }
    return r.podId == cur.podId && r.version > cur.version ? r : nil
}

// MARK: invites

private let b32 = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".utf8)

/// (pod_id, secret hex) from an invite code `pod1-<pod_id>-<base32(secret)>`.
public func parseInvite(_ code: String) throws -> (podId: String, secret: String) {
    let parts = code.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "-", omittingEmptySubsequences: false).map(String.init)
    guard parts.count == 3, parts[0] == "pod1", isHex(parts[1], 32) else { throw RosterError.badInvite }
    var bits = 0, acc = 0, out = Data()
    for c in parts[2].uppercased().utf8 {
        guard let v = b32.firstIndex(of: c) else { throw RosterError.badInvite }
        acc = (acc << 5) | v
        bits += 5
        if bits >= 8 { bits -= 8; out.append(UInt8((acc >> bits) & 0xff)) }
    }
    guard out.count == 16 else { throw RosterError.badInvite }
    return (parts[1], hex(out))
}

/// Proves the joiner holds the invite, bound to its key: a captured request can't admit another machine.
public func inviteProof(secret: String, podId: String, pubkey: String) -> String {
    let msg = Data((inviteDomain + "\(podId)|\(peerId(ofPubkey: unhex(pubkey) ?? Data()))|\(pubkey)").utf8)
    return hex(HMAC<SHA256>.authenticationCode(for: msg, using: SymmetricKey(data: unhex(secret) ?? Data())))
}
