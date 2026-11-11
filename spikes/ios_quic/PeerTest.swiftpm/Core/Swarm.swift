// What the rendezvous says about the swarm: peer records, and per model which layers someone serves.
// Mirrors the desktop app's store.js (models(), swarmStats()) and catalog.suggest.
import Foundation

struct SliceRecord: Hashable, Sendable {
    let model: String
    let lo: Int, hi: Int, nLayers: Int
    let loaded: Bool
}

struct SwarmPeer: Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let chip: String
    let memTotalGB: Double
    let memFreeGB: Double
    let slices: [SliceRecord]
    let proto: Int

    init?(_ r: [String: Any]) {
        guard let pid = r["peer_id"] as? String else { return nil }
        id = pid
        name = r["name"] as? String ?? String(pid.prefix(8))
        chip = r["chip"] as? String ?? ""
        memTotalGB = (r["mem_total_gb"] as? NSNumber)?.doubleValue ?? 0
        memFreeGB = (r["mem_free_gb"] as? NSNumber)?.doubleValue ?? 0
        proto = r["protocol"] as? Int ?? 1
        slices = (r["slices"] as? [[String: Any]] ?? []).compactMap { s in
            guard let m = s["model"] as? String, let lo = s["lo"] as? Int, let hi = s["hi"] as? Int else { return nil }
            return SliceRecord(model: m, lo: lo, hi: hi, nLayers: s["n_layers"] as? Int ?? hi, loaded: s["loaded"] as? Bool ?? false)
        }
    }
}

enum LayerState: Int, Sendable { case gap = 0, loading, serving }

/// One text model the swarm knows about: the best state any peer has for each layer.
struct SwarmModel: Identifiable, Sendable {
    let id: String          // the Hugging Face repo
    let nLayers: Int
    let layers: [LayerState]
    let servers: [(peer: String, lo: Int, hi: Int, loaded: Bool)]

    var name: String { id.split(separator: "/").last.map(String.init) ?? id }
    var served: Int { layers.filter { $0 == .serving }.count }
    var ready: Bool { served == nLayers }
    /// Half-open runs of layers nobody serves or loads.
    var gaps: [Range<Int>] { runs(layers.indices.filter { layers[$0] == .gap }) }

    var verdict: String {
        if ready { return "Ready: all \(nLayers) layers are served" }
        let waiting = layers.filter { $0 == .gap }.count
        if waiting > 0 { return "Not ready: waiting for \(waiting) of \(nLayers) layers" }
        return "Loading: \(layers.filter { $0 == .loading }.count) layers are still loading"
    }

    static func from(_ peers: [SwarmPeer]) -> [SwarmModel] {
        var byModel: [String: [(String, SliceRecord)]] = [:]
        for p in peers { for s in p.slices { byModel[s.model, default: []].append((p.name, s)) } }
        return byModel.map { model, list in
            let n = list.map { max($0.1.nLayers, $0.1.hi) }.max() ?? 0
            var layers = [LayerState](repeating: .gap, count: n)
            for (_, s) in list {
                let st: LayerState = s.loaded ? .serving : .loading
                for i in max(s.lo, 0)..<min(s.hi, n) where st.rawValue > layers[i].rawValue { layers[i] = st }
            }
            return SwarmModel(id: model, nLayers: n, layers: layers,
                              servers: list.map { ($0.0, $0.1.lo, $0.1.hi, $0.1.loaded) }.sorted { $0.lo < $1.lo })
        }.sorted { ($0.served, $0.id) > ($1.served, $1.id) }
    }
}

func runs(_ xs: [Int]) -> [Range<Int>] {
    var out: [Range<Int>] = []
    for x in xs.sorted() {
        if let last = out.last, last.upperBound == x { out[out.count - 1] = last.lowerBound..<(x + 1) } else { out.append(x..<(x + 1)) }
    }
    return out
}

func layerText(_ r: Range<Int>) -> String { r.count == 1 ? "\(r.lowerBound)" : "\(r.lowerBound)–\(r.upperBound - 1)" }

/// A layer range for this device (catalog.suggest): inside the swarm's first gap if there is one, else
/// after what's already here, else from layer 0; as many layers as fit in `budget` bytes with 10% headroom.
struct Suggestion: Sendable {
    let range: Range<Int>
    let fits: Int
    let reason: String
}

func suggest(nLayers: Int, layerBytes: Int64, budget: Int64, gaps: [Range<Int>], have: [Range<Int>], inSwarm: Bool) -> Suggestion {
    let fit = layerBytes > 0 ? min(Int(Double(budget) * 0.9) / Int(layerBytes), nLayers) : nLayers
    var lo = gaps.first?.lowerBound ?? 0, hi = gaps.first?.upperBound ?? nLayers
    if gaps.isEmpty, let end = have.map(\.upperBound).max() { lo = end; hi = nLayers }
    hi = min(hi, lo + max(fit, 0))
    let reason = hi <= lo ? "Not enough free memory for one layer"
        : !gaps.isEmpty ? "Fills the swarm's missing layers"
        : !have.isEmpty ? "Extends what this device has"
        : inSwarm ? "Adds a second copy, so failures re-route" : "Starts the model in the swarm"
    return Suggestion(range: lo..<max(lo, hi), fits: max(fit, 0), reason: reason)
}

// MARK: census

/// One machine in the census: chip, memory and layer ranges, never its name or key.
struct CensusMachine: Hashable, Sendable {
    let chip: String
    let memGB: Double
    let layers: [Range<Int>]
    let online: Bool

    init(_ r: [String: Any]) {
        chip = r["chip"] as? String ?? ""
        memGB = (r["mem_gb"] as? NSNumber)?.doubleValue ?? 0
        layers = (r["layers"] as? [[Int]] ?? []).compactMap { $0.count == 2 && $0[0] < $0[1] ? $0[0]..<$0[1] : nil }
        online = r["online"] as? Bool ?? false
    }
}

/// A pod as the rendezvous's census reports it (PodSummary in rendezvous/src/index.ts).
struct CensusPod: Identifiable, Hashable, Sendable {
    let id: String
    let kind: String        // private | public | alone
    let models: [String]
    let onNetwork: Bool
    let machines: [CensusMachine]   // the head first

    init?(_ r: [String: Any]) {
        guard let pid = r["pod_id"] as? String else { return nil }
        id = pid
        kind = r["kind"] as? String ?? "?"
        models = r["models"] as? [String] ?? []
        onNetwork = r["on_network"] as? Bool ?? false
        let head = (r["head"] as? [String: Any]).map { [$0] } ?? []
        machines = (head + (r["satellites"] as? [[String: Any]] ?? [])).map(CensusMachine.init)
    }

    var online: Int { machines.filter(\.online).count }
}

/// Every pod, plus the lobby: machines offering supply (`idle`) and ones that haven't yet (`waiting`).
struct Census: Sendable, Equatable {
    var pods: [CensusPod] = []
    var idle: [(chip: String, memGB: Double, models: [String])] = []
    var waiting = 0

    init() {}

    init(_ r: [String: Any]) {
        pods = (r["pods"] as? [[String: Any]] ?? []).compactMap(CensusPod.init).sorted { ($0.online, $0.id) > ($1.online, $1.id) }
        idle = (r["idle"] as? [[String: Any]] ?? []).map {
            ($0["chip"] as? String ?? "", ($0["mem_gb"] as? NSNumber)?.doubleValue ?? 0, $0["models"] as? [String] ?? [])
        }
        waiting = r["waiting"] as? Int ?? 0
    }

    var machinesOnline: Int { pods.reduce(0) { $0 + $1.online } + idle.count + waiting }
    var memoryGB: Double { pods.flatMap(\.machines).filter(\.online).reduce(0) { $0 + $1.memGB } + idle.reduce(0) { $0 + $1.memGB } }

    /// Single-model pods as layer coverage: online machines' layers serve, the rest wait. The census has
    /// no layer counts, so a model's length is the highest layer any pod plans for it.
    var models: [SwarmModel] {
        var by: [String: [CensusMachine]] = [:]
        for p in pods where p.models.count == 1 { by[p.models[0], default: []] += p.machines }
        return by.map { model, ms in
            let n = ms.flatMap(\.layers).map(\.upperBound).max() ?? 0
            var layers = [LayerState](repeating: .gap, count: n)
            for m in ms where m.online { for r in m.layers { for i in r where i < n { layers[i] = .serving } } }
            return SwarmModel(id: model, nLayers: n, layers: layers,
                              servers: ms.flatMap { m in m.layers.map { (m.chip.isEmpty ? "a machine" : m.chip, $0.lowerBound, $0.upperBound, m.online) } })
        }.sorted { ($0.served, $0.id) > ($1.served, $1.id) }
    }

    static func == (a: Census, b: Census) -> Bool {
        a.pods == b.pods && a.waiting == b.waiting && a.idle.map(\.chip) == b.idle.map(\.chip) && a.idle.map(\.memGB) == b.idle.map(\.memGB)
    }
}
