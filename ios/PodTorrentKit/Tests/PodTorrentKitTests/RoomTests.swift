import Foundation
import Testing
@testable import PodTorrentKit

/// Against a running rendezvous: `cd rendezvous && npx wrangler dev`, then
/// PODTORRENT_RENDEZVOUS=ws://localhost:8787 ./test.sh. Skipped without that variable.
struct RoomTests {
    static let live = ProcessInfo.processInfo.environment["PODTORRENT_RENDEZVOUS"] != nil

    @Test(.enabled(if: live)) func lobbyAssignsOnePublicPod() async throws {
        let model = Supply.Model(model: "test/swift-\(UUID().uuidString.prefix(8))", layers: 48, gb: 24)
        let a = Identity(), b = Identity()
        async let ra = waitForPublicPod(a, supply: Supply(name: "a", chip: "A17", memTotalGB: 16, memFreeGB: 16, node: true, models: [model]))
        async let rb = waitForPublicPod(b, supply: Supply(name: "b", chip: "A17", memTotalGB: 16, memFreeGB: 16, models: [model]))
        let (x, y) = try await (ra, rb)
        #expect(x.podId == y.podId && x.kind == "public")
        #expect(x.isMember(a.peerId) && x.isMember(b.peerId))
        #expect(x.plans.first?.head == a.peerId)   // the tokened machine heads

        // Both move into the pod's room as members.
        let conn = RoomConnection(url: URL(string: "\(rendezvousURL)/v1/pod/\(x.podId)")!)
        defer { conn.close() }
        let welcome = try await roomAuth(conn, a, room: x.podId, roster: x.json)
        #expect(welcome["member"] == .bool(true))
    }

    @Test(.enabled(if: live)) func strangerIsNotAMember() async throws {
        let owner = Identity()
        let conn = RoomConnection(url: URL(string: "\(rendezvousURL)/v1/pod/\(String(repeating: "ab", count: 16))")!)
        defer { conn.close() }
        let welcome = try await roomAuth(conn, owner, room: String(repeating: "ab", count: 16))
        #expect(welcome["member"] == .bool(false))
    }
}
