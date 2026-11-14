// PodTorrent Test: the swarm as the desktop app shows it, on an iPad or iPhone.
//   Swarm:       every pod and the public lobby from the census (read-only until you join), then this
//                device's pod: its members and which layers of which model each serves.
//   Models:      pick a model and download a range of its layers sized to this device's memory.
//   Diagnostics: the direct protocol test against the spike's Python peer, and the connection log.
import os
import SwiftUI
import UIKit

@main
struct PeerTestApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}

struct Download: Sendable {
    let repo: String
    let range: Range<Int>
    var done: Int64 = 0
    var total: Int64 = 0
    var error: String?
}

@MainActor
final class Model: ObservableObject {
    @Published var rendezvous = ProcessInfo.processInfo.environment["PODTORRENT_RENDEZVOUS"] ?? ""  // your own rendezvous
    @Published var peers: [SwarmPeer] = []   // this device's pod, once it's in one
    @Published var census = Census()
    @Published var place = Place.watching
    @Published var invite = ""
    @Published var links: [String: PeerRow] = [:]
    @Published var joined = false
    @Published var joining = false
    @Published var joinError: String?
    @Published var local: [LocalLayers.Entry] = LocalLayers.list()
    @Published var download: Download?
    @Published var host = "192.168.0.7"
    @Published var port = "47100"
    @Published var peerId = "a31c4bd2db0aca88c53985bc5d615793"
    @Published var lines: [String] = []
    @Published var testing = false
    let peer = TestPeer(name: "\(UIDevice.current.name)")
    private var task: Task<Void, Never>?

    var inPod: Bool { if case .pod = place { true } else { false } }
    var models: [SwarmModel] { inPod ? SwarmModel.from(peers) : census.models }
    /// Memory iOS lets this app use right now: the budget for layers.
    var budget: Int64 { Int64(os_proc_available_memory()) }

    init() {
        peer.onLog = { [weak self] line in Task { @MainActor in self?.lines.append(line) } }
        peer.onRows = { [weak self] rows in Task { @MainActor in self?.links = Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }) } }
        peer.onSwarm = { [weak self] peers in Task { @MainActor in self?.peers = peers.sorted { $0.name < $1.name } } }
        peer.onCensus = { [weak self] c in Task { @MainActor in self?.census = c } }
        peer.onPlace = { [weak self] p in Task { @MainActor in self?.place = p } }
        UIApplication.shared.isIdleTimerDisabled = true   // iOS stops the network when the screen locks
        peer.watch(url: rendezvous)
    }

    /// Without a code: wait in the public lobby. With a pod1-… invite code: join that private pod.
    func join(invite: String? = nil) {
        joining = true
        joinError = nil
        Task {
            do {
                try await peer.join(invite: invite)
                joined = true
                self.invite = ""
            } catch {
                joinError = "\(error)"
            }
            joining = false
        }
    }

    func leave() {
        joined = false
        let peer = peer
        Task.detached { await peer.leave() }
    }

    func mine(_ repo: String) -> [Range<Int>] { local.filter { $0.repo == repo }.map(\.range) }

    func startDownload(_ info: ModelInfo, _ range: Range<Int>) {
        download = Download(repo: info.repo, range: range)
        task = Task {
            do {
                _ = try await downloadLayers(repo: info.repo, files: info.files, lo: range.lowerBound, hi: range.upperBound) { d, t in
                    Task { @MainActor in
                        guard self.download?.repo == info.repo else { return }
                        self.download?.done = d
                        self.download?.total = t
                    }
                }
                download = nil
            } catch is CancellationError {
                download = nil
            } catch {
                download?.error = (error as? URLError)?.code == .cancelled ? nil : "\(error)"
                if download?.error == nil { download = nil }
            }
            local = LocalLayers.list()
        }
    }

    func cancelDownload() { task?.cancel() }

    func delete(_ e: LocalLayers.Entry) {
        try? LocalLayers.delete(e)
        local = LocalLayers.list()
    }

    func runDirect() {
        guard let p = UInt16(port.trimmingCharacters(in: .whitespaces)) else { lines.append("port must be a number"); return }
        testing = true
        let host = host.trimmingCharacters(in: .whitespaces), id = peerId.trimmingCharacters(in: .whitespaces)
        Task {
            await peer.runDirect(host: host, port: p, expect: id.isEmpty ? nil : id)
            testing = false
        }
    }
}

struct ContentView: View {
    @StateObject private var model = Model()

    var body: some View {
        TabView {
            NavigationStack { SwarmView() }.tabItem { Label("Swarm", systemImage: "point.3.connected.trianglepath.dotted") }
            NavigationStack { ModelsView() }.tabItem { Label("Models", systemImage: "square.stack.3d.up") }
            NavigationStack { DiagnosticsView() }.tabItem { Label("Diagnostics", systemImage: "stethoscope") }
        }
        .environmentObject(model)
    }
}

// MARK: - swarm

struct SwarmView: View {
    @EnvironmentObject var model: Model

    var body: some View {
        List {
            Section {
                HStack(spacing: 12) {
                    Stat(label: "Pods", value: "\(model.census.pods.count)")
                    Stat(label: "Machines online", value: "\(model.census.machinesOnline)")
                    Stat(label: "Pooled memory", value: gb(model.census.memoryGB))
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }

            Section {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Circle().fill(model.joined ? Color.green : Color.secondary).frame(width: 8, height: 8)
                        Text(UIDevice.current.name).bold()
                        Text("You").font(.caption).padding(.horizontal, 6).padding(.vertical, 1)
                            .background(Color.blue.opacity(0.15), in: Capsule())
                        Spacer()
                        if model.joined {
                            Button("Leave", role: .destructive) { model.leave() }.buttonStyle(.borderedProminent).tint(.red)
                        } else {
                            Button(model.joining ? "Joining…" : "Wait in public lobby") { model.join() }
                                .buttonStyle(.borderedProminent)
                                .disabled(model.joining)
                        }
                    }
                    Text(placeText(model.place)).font(.caption).foregroundStyle(.secondary)
                    if !model.joined {
                        HStack {
                            TextField("Invite code (pod1-…)", text: $model.invite)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                                .font(.caption.monospaced())
                            Button("Join pod") { model.join(invite: model.invite) }
                                .disabled(model.joining || !model.invite.hasPrefix("pod1-"))
                        }
                    }
                    if let e = model.joinError { Text(e).font(.caption).foregroundStyle(.red) }
                    if !model.local.isEmpty {
                        Text("On this device: " + model.local.map { "\($0.repo.split(separator: "/").last ?? "") \(layerText($0.range))" }.joined(separator: ", "))
                            .font(.caption)
                    }
                }
            }

            Section(model.inPod ? "Text models in this pod" : "Text models in pods") {
                if model.models.isEmpty { Text("No pod serves a model right now.").foregroundStyle(.secondary) }
                ForEach(model.models) { m in
                    NavigationLink { GetLayersView(repo: m.id) } label: { ModelCoverage(m: m, mine: model.mine(m.id)) }
                }
            }

            if model.inPod {
                Section("Machines in this pod") {
                    if model.peers.isEmpty { Text("No other machine or peer of this pod is online.").foregroundStyle(.secondary) }
                    ForEach(model.peers) { p in PeerCard(p: p, link: model.links[p.id]) }
                }
            }

            Section {
                if model.census.pods.isEmpty { Text("No pods online.").foregroundStyle(.secondary) }
                ForEach(model.census.pods) { p in PodCard(p: p) }
            } header: {
                Text("All pods")
            } footer: {
                Text("From the rendezvous's census: chips, memory and layers, never names.")
            }

            if !model.census.idle.isEmpty || model.census.waiting > 0 {
                Section("Public lobby") {
                    ForEach(Array(model.census.idle.enumerated()), id: \.offset) { _, m in
                        Text("\(m.chip.isEmpty ? "A machine" : m.chip) · \(gb(m.memGB))\(m.models.isEmpty ? " · no models" : " · " + m.models.map { $0.split(separator: "/").last.map(String.init) ?? $0 }.joined(separator: ", "))")
                            .font(.caption)
                    }
                    if model.census.waiting > 0 {
                        Text("\(model.census.waiting) more waiting without an offer yet").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle("Swarm")
    }
}

func placeText(_ p: Place) -> String {
    switch p {
    case .watching: "Watching. Wait in the public lobby, or join a private pod with an invite code from its owner."
    case .lobby: "In the public lobby. The matchmaker puts a machine or peer in a public pod once it offers layers; this device offers none yet."
    case .pod(_, let name, let kind, let members): "In the \(kind) pod \(name) (\(members) machines). Its members connect to this device; it serves no layers yet."
    }
}

/// One pod from the census: its models and each machine's chip, memory and layers.
struct PodCard: View {
    let p: CensusPod
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Circle().fill(p.online > 0 ? Color.green : Color.secondary).frame(width: 8, height: 8)
                Text(p.models.isEmpty ? "No model planned" : p.models.map { $0.split(separator: "/").last.map(String.init) ?? $0 }.joined(separator: ", "))
                    .bold().lineLimit(1)
                Spacer()
                Text(p.kind.capitalized).font(.caption).padding(.horizontal, 6).padding(.vertical, 1)
                    .background(Color.secondary.opacity(0.15), in: Capsule())
            }
            Text("\(p.online) of \(p.machines.count) online\(p.onNetwork ? " · on the network" : "")")
                .font(.caption).foregroundStyle(.secondary)
            ForEach(Array(p.machines.enumerated()), id: \.offset) { _, m in
                Text("\(m.online ? "●" : "○") \(m.chip.isEmpty ? "A machine" : m.chip) · \(gb(m.memGB))" + (m.layers.isEmpty ? "" : " · layers " + m.layers.map(layerText).joined(separator: ", ")))
                    .font(.caption2).foregroundStyle(m.online ? .primary : .secondary)
            }
        }
        .padding(.vertical, 4)
    }
}

struct Stat: View {
    let label: String, value: String
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.title3.monospacedDigit()).bold()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(.background, in: RoundedRectangle(cornerRadius: 12))
    }
}

struct ModelCoverage: View {
    let m: SwarmModel
    let mine: [Range<Int>]
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(m.name).bold().lineLimit(1)
                Spacer()
                Text(m.ready ? "Ready" : "Not ready").font(.caption.bold())
                    .foregroundStyle(m.ready ? .green : .orange)
            }
            LayerBar(n: m.nLayers, states: m.layers, mine: mine)
            Text(m.verdict).font(.caption).foregroundStyle(.secondary)
            ForEach(Array(m.servers.enumerated()), id: \.offset) { _, s in
                Text("Layers \(layerText(s.lo..<s.hi)) \(s.loaded ? "served" : "loading") by \(s.peer)")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            if !m.gaps.isEmpty {
                Text("Layers \(m.gaps.map(layerText).joined(separator: ", ")) are waiting for a machine or peer")
                    .font(.caption2).foregroundStyle(.orange)
            }
        }
        .padding(.vertical, 4)
    }
}

/// One cell per layer: served (green), loading (yellow), waiting (grey); a blue line under layers on this device.
struct LayerBar: View {
    let n: Int
    var states: [LayerState] = []
    var mine: [Range<Int>] = []
    var highlight: Range<Int>?

    var body: some View {
        Canvas { ctx, size in
            guard n > 0 else { return }
            let w = size.width / CGFloat(n), gap: CGFloat = n > 60 ? 0.5 : 1
            for i in 0..<n {
                let st = i < states.count ? states[i] : .gap
                let color: Color = highlight?.contains(i) == true ? .blue
                    : st == .serving ? .green : st == .loading ? .yellow : Color.secondary.opacity(0.25)
                ctx.fill(Path(CGRect(x: CGFloat(i) * w, y: 0, width: max(w - gap, 0.5), height: 10)), with: .color(color))
                if mine.contains(where: { $0.contains(i) }) {
                    ctx.fill(Path(CGRect(x: CGFloat(i) * w, y: 12, width: max(w - gap, 0.5), height: 3)), with: .color(.blue))
                }
            }
        }
        .frame(height: 15)
        .accessibilityLabel("\(n) layers")
    }
}

struct PeerCard: View {
    let p: SwarmPeer
    let link: PeerRow?
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Circle().fill(p.slices.contains(where: \.loaded) ? Color.green : Color.secondary).frame(width: 8, height: 8)
                Text(p.name).bold().lineLimit(1)
                Spacer()
                if let link {
                    Text(link.state == "direct" ? "Connected" + (link.rttMs.map { String(format: " · %.0f ms", $0) } ?? "") : link.state.capitalized)
                        .font(.caption).foregroundStyle(link.state == "direct" ? .green : .secondary)
                }
            }
            Text([p.chip, p.memTotalGB > 0 ? "\(gb(p.memTotalGB)) memory" : "", p.proto < 2 ? "old client" : ""]
                .filter { !$0.isEmpty }.joined(separator: " · "))
                .font(.caption).foregroundStyle(.secondary)
            if p.slices.isEmpty { Text("No layers").font(.caption).foregroundStyle(.secondary) }
            ForEach(p.slices, id: \.self) { s in
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(s.model.split(separator: "/").last ?? "") · layers \(layerText(s.lo..<s.hi))\(s.loaded ? "" : " (loading)")")
                        .font(.caption)
                    LayerBar(n: s.nLayers, states: (0..<s.nLayers).map { (s.lo..<s.hi).contains($0) ? (s.loaded ? .serving : .loading) : .gap })
                }
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - models

struct ModelsView: View {
    @EnvironmentObject var model: Model
    @State private var query = ""
    @State private var results: [(repo: String, downloads: Int)] = []
    @State private var searching = false
    @State private var searchError: String?

    var body: some View {
        List {
            Section {
                HStack(spacing: 12) {
                    Stat(label: "Free for layers", value: bytes(model.budget))
                    Stat(label: "Downloaded", value: bytes(model.local.reduce(0) { $0 + $1.bytes }))
                    Stat(label: "Free disk", value: bytes(LocalLayers.freeDisk()))
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }

            if let d = model.download { Section("Downloading") { DownloadRow(d: d) } }

            Section("On this device") {
                if model.local.isEmpty { Text("No layers yet. Pick a model below.").foregroundStyle(.secondary) }
                ForEach(model.local) { e in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(e.repo.split(separator: "/").last.map(String.init) ?? e.repo).bold()
                            Text("Layers \(layerText(e.range)) · \(bytes(e.bytes))").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text("Not serving").font(.caption).foregroundStyle(.secondary)
                    }
                    .swipeActions { Button("Delete", role: .destructive) { model.delete(e) } }
                }
            }

            Section {
                ForEach(model.models) { m in
                    NavigationLink { GetLayersView(repo: m.id) } label: { ModelCoverage(m: m, mine: model.mine(m.id)) }
                }
                if model.models.isEmpty { Text("No pod serves a model right now.").foregroundStyle(.secondary) }
            } header: {
                Text("Models in pods")
            } footer: {
                Text("Taking layers nobody serves helps a model become ready.")
            }

            Section("Find on Hugging Face") {
                HStack {
                    TextField("Search MLX models, e.g. Qwen3", text: $query).onSubmit(search)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    if searching { ProgressView() } else { Button("Search", action: search).disabled(query.isEmpty) }
                }
                if let e = searchError { Text(e).font(.caption).foregroundStyle(.red) }
                ForEach(results, id: \.repo) { r in
                    NavigationLink { GetLayersView(repo: r.repo) } label: {
                        VStack(alignment: .leading) {
                            Text(r.repo).lineLimit(1)
                            Text("\(r.downloads) downloads").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .navigationTitle("Models")
        .onAppear { model.local = LocalLayers.list() }
    }

    private func search() {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return }
        searching = true
        searchError = nil
        Task {
            do { results = try await HF.search(q) } catch { searchError = "\(error)" }
            searching = false
        }
    }
}

struct DownloadRow: View {
    @EnvironmentObject var model: Model
    let d: Download
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(d.repo.split(separator: "/").last ?? "") · layers \(layerText(d.range))").bold()
            if let e = d.error {
                Text(e).font(.caption).foregroundStyle(.red)
                Button("Dismiss") { model.download = nil }
            } else {
                ProgressView(value: d.total > 0 ? Double(d.done) / Double(d.total) : 0)
                HStack {
                    Text(d.total > 0 ? "\(bytes(d.done)) of \(bytes(d.total))" : "Reading the model's file headers…")
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    Spacer()
                    Button("Cancel", role: .destructive) { model.cancelDownload() }
                }
            }
        }
    }
}

/// One model: what the swarm has, a suggested layer range for this device, and the download.
struct GetLayersView: View {
    @EnvironmentObject var model: Model
    let repo: String
    @State private var info: ModelInfo?
    @State private var error: String?
    @State private var lo = 0
    @State private var hi = 0
    @State private var picked = false

    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            if info == nil && error == nil { HStack { ProgressView(); Text("Reading the model's config…") } }
            if let info {
                let swarm = model.models.first { $0.id == repo }
                let s = suggestion(info, swarm)
                Section {
                    LabeledContent("Layers", value: "\(info.nLayers)")
                    LabeledContent("Model size", value: bytes(info.sizeBytes))
                    LabeledContent("Per layer", value: "about \(bytes(info.layerBytes))")
                    LabeledContent("This device holds", value: "\(s.fits) layers")
                } footer: {
                    Text("\(bytes(model.budget)) of memory is free for this app now; layers are sized with 10% headroom.")
                }

                Section {
                    LayerBar(n: info.nLayers, states: swarm?.layers ?? [], mine: model.mine(repo), highlight: lo..<hi)
                    Stepper("First layer: \(lo)", value: $lo, in: 0...max(info.nLayers - 1, 0)) { _ in hi = max(hi, lo + 1) }
                    Stepper("Last layer: \(hi - 1)", value: $hi, in: (lo + 1)...max(info.nLayers, lo + 1))
                    LabeledContent("Download", value: "about \(bytes(info.layerBytes * Int64(hi - lo)))")
                    if hi - lo > s.fits { Text("More layers than this device's memory can hold.").font(.caption).foregroundStyle(.orange) }
                } header: {
                    Text("Layers for this device")
                } footer: {
                    Text("Suggested: \(s.range.isEmpty ? "none" : "layers " + layerText(s.range)). \(s.reason). Green is served in the swarm, blue is your pick.")
                }

                Section {
                    if let d = model.download {
                        DownloadRow(d: d)
                    } else {
                        Button("Download layers \(layerText(lo..<hi))") { model.startDownload(info, lo..<hi) }
                            .disabled(hi <= lo || model.mine(repo).contains(lo..<hi))
                    }
                } footer: {
                    Text("Weights come from Hugging Face with range requests, only the layers you picked. Serving them comes with the MLX build.")
                }
            }
        }
        .navigationTitle(repo.split(separator: "/").last.map(String.init) ?? repo)
        .task {
            guard info == nil else { return }
            do {
                let i = try await ModelInfo.fetch(repo)
                info = i
                if !picked {
                    let s = suggestion(i, model.models.first { $0.id == repo })
                    lo = s.range.isEmpty ? 0 : s.range.lowerBound
                    hi = s.range.isEmpty ? min(1, i.nLayers) : s.range.upperBound
                    picked = true
                }
            } catch {
                self.error = "\(error)"
            }
        }
    }

    private func suggestion(_ info: ModelInfo, _ swarm: SwarmModel?) -> Suggestion {
        let gaps = swarm.map { s in s.gaps.filter { g in !model.mine(repo).contains { $0.overlaps(g) } } } ?? []
        return suggest(nLayers: info.nLayers, layerBytes: info.layerBytes, budget: model.budget,
                       gaps: gaps, have: model.mine(repo), inSwarm: swarm != nil)
    }
}

// MARK: - diagnostics

struct DiagnosticsView: View {
    @EnvironmentObject var model: Model

    var body: some View {
        Form {
            Section {
                LabeledContent("Address") { TextField("192.168.0.7", text: $model.host).multilineTextAlignment(.trailing) }
                LabeledContent("Port") { TextField("47100", text: $model.port).multilineTextAlignment(.trailing) }
                LabeledContent("Peer ID") {
                    TextField("optional", text: $model.peerId).multilineTextAlignment(.trailing).font(.caption.monospaced())
                }
                Button(model.testing ? "Testing…" : "Run direct test", action: model.runDirect).disabled(model.testing)
            } header: {
                Text("Direct test (same Wi-Fi)")
            } footer: {
                Text("Dials the spike's test peer (spikes/ios_quic/py_peer.py --p256) and checks the protocol.")
            }

            Section {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 4) {
                            ForEach(Array(model.lines.enumerated()), id: \.offset) { i, line in
                                Text(line).font(.caption.monospaced()).textSelection(.enabled).id(i)
                            }
                        }
                    }
                    .frame(minHeight: 280)
                    .onChange(of: model.lines.count) { _, n in proxy.scrollTo(n - 1, anchor: .bottom) }
                }
            } header: {
                HStack {
                    Text("Connection log")
                    Spacer()
                    Button("Copy") { UIPasteboard.general.string = model.lines.joined(separator: "\n") }
                    Button("Clear") { model.lines = [] }
                }
            }
        }
        .navigationTitle("Diagnostics")
    }
}

func gb(_ v: Double) -> String { v >= 100 ? String(format: "%.0f GB", v) : String(format: "%.1f GB", v) }
func bytes(_ n: Int64) -> String { ByteCountFormatter.string(fromByteCount: n, countStyle: .memory) }
