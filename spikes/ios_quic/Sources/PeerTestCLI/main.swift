// The iPad test app's peer, headless on macOS (same sources, symlinked from PeerTest.swiftpm/Core).
//   swift run PeerTestCLI direct HOST PORT [PEER_ID]
//   swift run PeerTestCLI census URL [SECONDS]           every pod and the lobby, read-only
//   swift run PeerTestCLI public URL [SECONDS]           wait in the public lobby (and follow an assignment)
//   swift run PeerTestCLI pod URL INVITE_CODE [SECONDS]  join a private pod with a pod1-… code, link with its members
//   LAYERS_HOME=DIR swift run PeerTestCLI download REPO LO HI
import Foundation
import Network

let args = CommandLine.arguments
let peer = TestPeer(name: "PodTorrent test (\(Host.current().localizedName ?? "Mac"))")
peer.onLog = { print($0); fflush(stdout) }
var lastRows: [PeerRow] = []
peer.onRows = { rows in
    for r in rows where !lastRows.contains(r) {
        print("   link: \(r.id.prefix(8)) [\(r.state)]\(r.rttMs.map { String(format: " %.1f ms", $0) } ?? "")")
    }
    lastRows = rows
}
var lastSwarm: [SwarmPeer]?
peer.onSwarm = { peers in
    guard peers != lastSwarm else { return }
    lastSwarm = peers
    print("   pod: \(peers.count) members online")
    for p in peers {
        print("     \(p.name) [\(p.chip), \(p.memTotalGB) GB] " + p.slices.map { "\($0.model) \(layerText($0.lo..<$0.hi))\($0.loaded ? "" : " loading")" }.joined(separator: ", "))
    }
    for m in SwarmModel.from(peers) {
        print("     model \(m.id): \(m.verdict); gaps \(m.gaps.map(layerText))")
    }
}
switch args.dropFirst().first {
case "direct":
    await peer.runDirect(host: args[2], port: UInt16(args[3])!, expect: args.count > 4 ? args[4] : nil)
    try await Task.sleep(nanoseconds: 1_000_000_000)
case "census", "public", "pod":
    var lastCensus: Census?
    peer.onCensus = { c in
        guard c != lastCensus else { return }
        lastCensus = c
        print("   census: \(c.pods.count) pods, \(c.machinesOnline) machines online (\(c.idle.count) offering supply in the lobby, \(c.waiting) waiting)")
        for p in c.pods {
            print("     \(p.kind) pod \(p.id.prefix(8)): \(p.models.isEmpty ? "no plan" : p.models.joined(separator: ", ")); \(p.online) of \(p.machines.count) online\(p.onNetwork ? ", on the network" : "")")
            for m in p.machines {
                print("       \(m.online ? "●" : "○") \(m.chip.isEmpty ? "?" : m.chip) \(gbText(m.memGB))" + (m.layers.isEmpty ? "" : " layers " + m.layers.map(layerText).joined(separator: ", ")))
            }
        }
        for i in c.idle { print("     idle: \(i.chip) \(gbText(i.memGB)) \(i.models.joined(separator: ", "))") }
    }
    peer.onPlace = { print("   place: \($0)") }
    peer.watch(url: args[2])
    try await Task.sleep(nanoseconds: 2_000_000_000)
    let rest = args.dropFirst(3).filter { !$0.hasPrefix("pod1-") }
    if args[1] != "census" {
        do { try await peer.join(invite: args[1] == "pod" ? args.first { $0.hasPrefix("pod1-") } : nil) } catch {
            print("join failed: \(error)")
            exit(1)
        }
    }
    try await Task.sleep(nanoseconds: UInt64((rest.first.flatMap(Double.init) ?? 60) * 1e9))
    await peer.leave()
    try await Task.sleep(nanoseconds: 1_000_000_000)
    peer.stop()
case "download":
    // LAYERS_HOME=DIR PeerTestCLI download REPO LO HI
    let info = try await ModelInfo.fetch(args[2])
    print("\(info.repo): \(info.nLayers) layers, \(info.sizeBytes) bytes in \(info.files)")
    print(suggest(nLayers: info.nLayers, layerBytes: info.layerBytes, budget: 4 << 30, gaps: [], have: [], inSwarm: false))
    var last = Date.distantPast
    let out = try await downloadLayers(repo: info.repo, files: info.files, lo: Int(args[3])!, hi: Int(args[4])!) { d, t in
        if Date().timeIntervalSince(last) > 1 || d == t { last = Date(); print("   \(d) / \(t)") }
    }
    print("wrote \(out.path)")
    print(LocalLayers.list().map { "\($0.repo) \($0.range) \($0.bytes)" })
case "stun-check":
    // Does a connected BSD socket on the QUIC port still get replies once an NWListener holds the port?
    let port = UInt16.random(in: 50_000...60_000)
    print("STUN with no listener:", stun(localPort: port).map { "\($0.0):\($0.1)" } ?? "no answer")
    let p = NWParameters(quic: NWProtocolQUIC.Options(alpn: [Wire.alpn]))
    p.allowLocalEndpointReuse = true
    let l = try NWListener(using: p, on: .init(rawValue: port)!)
    l.newConnectionGroupHandler = { _ in }
    l.stateUpdateHandler = { print("listener", $0) }
    l.start(queue: .main)
    try await Task.sleep(nanoseconds: 500_000_000)
    print("STUN with the listener up:", stun(localPort: port).map { "\($0.0):\($0.1)" } ?? "no answer")
default:
    print("usage: PeerTestCLI direct HOST PORT [PEER_ID] | census URL [SECONDS] | public URL [SECONDS] | pod URL INVITE_CODE [SECONDS] | download REPO LO HI")
}

func gbText(_ v: Double) -> String { String(format: "%.0f GB", v) }
