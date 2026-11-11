import Foundation
import Testing
@testable import PodTorrentKit

/// The shared vectors every port must agree with (built by tests/pod_vectors.py).
struct VectorTests {
    static let vectors: JSON = {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../tests/pod_vectors.json").standardized
        return try! JSON.parse(Data(contentsOf: url))
    }()
    var v: JSON { Self.vectors }
    var now: Double { Double(v["now"]!.int!) }
    var mms: [String] { v["matchmakers"]!.array!.map { $0.string! } }

    @Test func canonicalEncoding() throws {
        for c in v["canonical"]!.array! {
            #expect(try canonical(c["value"]!) == c["utf8"]!.string!)
        }
        #expect(throws: RosterError.badValue) { try canonical(.object(["x": .double(1.5)])) }
    }

    @Test func keys() throws {
        for (_, k) in v["keys"]!.object! {
            let id = try Identity(seedHex: k["seed"]!.string!)
            #expect(id.pubkeyHex == k["pubkey"]!.string!)
            #expect(id.peerId == k["peer_id"]!.string!)
        }
    }

    @Test func rosters() {
        for c in v["rosters"]!.array! {
            let name = c["case"]!.string!, want = c["error"]?.string
            var got: String? = nil
            do { _ = try verify(c["roster"]!, now: now, matchmakers: mms) } catch let e as RosterError { got = e.rawValue } catch { got = "\(error)" }
            #expect(got == want, "\(name)")
        }
    }

    @Test func invites() throws {
        for i in v["invites"]!.array! {
            let (pod, secret) = try parseInvite(i["code"]!.string!)
            #expect(pod == i["pod_id"]!.string!)
            #expect(secret == i["secret"]!.string!)
            #expect(inviteProof(secret: secret, podId: pod, pubkey: i["pubkey"]!.string!) == i["proof"]!.string!)
        }
        #expect(throws: RosterError.badInvite) { try parseInvite("pod1-xyz-abc") }
    }

    /// A roster CryptoKit signs passes this port's check (and so pod.py's: same input bytes).
    @Test func signedHere() throws {
        let good = v["rosters"]!.array!.first { ($0["error"] ?? .null) == .null && $0["roster"]!["kind"] == .string("private") }!["roster"]!
        let owner = try Identity(seedHex: v["keys"]!["owner"]!["seed"]!.string!)
        guard case .object(var o) = good else { Issue.record("not an object"); return }
        o["version"] = .int(o["version"]!.int! + 1)
        o["sig"] = .string(try owner.sign(try signingInput(.object(o))))
        let r = try verify(.object(o), now: now, matchmakers: mms)
        #expect(newer(try verify(good, now: now, matchmakers: mms), r.json, now: now, matchmakers: mms)?.version == r.version)
    }
}
