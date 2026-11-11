// Model layers from Hugging Face, the way podtorrent/slicer.py fetches them: HTTP range requests on the
// repo's safetensors files, keeping only the tensors of layers [lo, hi). The result is the same file a
// desktop peer writes, <models>/<repo name>/layers-<lo>-<hi>.safetensors, next to config.json and the
// tokenizer. The output header is known before any weights arrive, so tensor bytes stream straight to disk.
import Foundation

enum HF {
    static let base = "https://huggingface.co"
    static let metaFiles = ["config.json", "model.safetensors.index.json", "tokenizer.json",
                            "tokenizer_config.json", "generation_config.json"]

    static func file(_ repo: String, _ name: String) -> URL { URL(string: "\(base)/\(repo)/resolve/main/\(name)")! }

    static func json(_ url: URL) async throws -> Any {
        let (data, resp) = try await URLSession.shared.data(from: url)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
            throw WireError("\(url.lastPathComponent): HTTP \((resp as? HTTPURLResponse)?.statusCode ?? 0)")
        }
        return try JSONSerialization.jsonObject(with: data)
    }

    /// MLX text-generation models matching `q`, most downloaded first (catalog.search).
    static func search(_ q: String, limit: Int = 24) async throws -> [(repo: String, downloads: Int)] {
        var c = URLComponents(string: "\(base)/api/models")!
        c.queryItems = [.init(name: "search", value: q), .init(name: "filter", value: "mlx"),
                        .init(name: "pipeline_tag", value: "text-generation"), .init(name: "sort", value: "downloads"),
                        .init(name: "direction", value: "-1"), .init(name: "limit", value: String(limit))]
        let list = try await json(c.url!) as? [[String: Any]] ?? []
        return list.compactMap { m in (m["id"] as? String).map { ($0, m["downloads"] as? Int ?? 0) } }
    }
}

struct ModelInfo: Sendable {
    let repo: String
    let nLayers: Int
    let sizeBytes: Int64
    let files: [String]        // the repo's .safetensors files
    var layerBytes: Int64 { nLayers > 0 ? sizeBytes / Int64(nLayers) : 0 }

    /// Layer count from config.json and the weights' size from the repo listing (catalog.info).
    static func fetch(_ repo: String) async throws -> ModelInfo {
        var cfg = try await HF.json(HF.file(repo, "config.json")) as? [String: Any] ?? [:]
        if cfg["num_hidden_layers"] == nil, let t = cfg["text_config"] as? [String: Any] { cfg = t }
        guard let n = cfg["num_hidden_layers"] as? Int else { throw WireError("\(repo) has no num_hidden_layers in config.json") }
        let api = try await HF.json(URL(string: "\(HF.base)/api/models/\(repo)?blobs=true")!) as? [String: Any] ?? [:]
        let weights = (api["siblings"] as? [[String: Any]] ?? []).filter { ($0["rfilename"] as? String)?.hasSuffix(".safetensors") == true }
        return ModelInfo(repo: repo, nLayers: n,
                         sizeBytes: weights.reduce(0) { $0 + ((($1["size"] as? NSNumber)?.int64Value) ?? 0) },
                         files: weights.compactMap { $0["rfilename"] as? String })
    }
}

/// Layers on this device: one folder per model, as on a desktop peer.
enum LocalLayers {
    static var home: URL {
        if let h = ProcessInfo.processInfo.environment["LAYERS_HOME"] { return URL(fileURLWithPath: h) }   // the macOS test CLI
        return FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("models")
    }

    static func dir(_ repo: String) -> URL { home.appendingPathComponent(String(repo.split(separator: "/").last ?? "model")) }

    struct Entry: Identifiable, Sendable {
        var id: String { repo + ":\(range)" }
        let repo: String
        let range: Range<Int>
        let bytes: Int64
        let file: URL
    }

    static func list() -> [Entry] {
        let fm = FileManager.default
        guard let dirs = try? fm.contentsOfDirectory(at: home, includingPropertiesForKeys: nil) else { return [] }
        var out: [Entry] = []
        for d in dirs {
            let repo = (try? String(contentsOf: d.appendingPathComponent(".repo"), encoding: .utf8))?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? d.lastPathComponent
            for f in (try? fm.contentsOfDirectory(at: d, includingPropertiesForKeys: [.fileSizeKey])) ?? [] {
                let parts = f.deletingPathExtension().lastPathComponent.split(separator: "-")
                guard f.pathExtension == "safetensors", parts.count == 3, parts[0] == "layers",
                      let lo = Int(parts[1]), let hi = Int(parts[2]), lo < hi else { continue }
                let size = (try? f.resourceValues(forKeys: [.fileSizeKey]).fileSize).flatMap { $0 } ?? 0
                out.append(Entry(repo: repo, range: lo..<hi, bytes: Int64(size), file: f))
            }
        }
        return out.sorted { ($0.repo, $0.range.lowerBound) < ($1.repo, $1.range.lowerBound) }
    }

    /// Removes one slice file, and the model's folder once no slice is left in it.
    static func delete(_ e: Entry) throws {
        let fm = FileManager.default
        try fm.removeItem(at: e.file)
        let d = e.file.deletingLastPathComponent()
        let left = (try? fm.contentsOfDirectory(atPath: d.path))?.filter { $0.hasSuffix(".safetensors") } ?? []
        if left.isEmpty { try? fm.removeItem(at: d) }
    }

    static func freeDisk() -> Int64 {
        let v = try? URL(fileURLWithPath: NSHomeDirectory()).resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return v?.volumeAvailableCapacityForImportantUsage ?? 0
    }
}

/// slicer.LAYER_RE: "model.layers.N.", "model.language_model.layers.N.", "language_model.model.layers.N."
func layerIndex(_ tensor: String) -> Int? {
    var s = Substring(tensor)
    while true {
        if s.hasPrefix("model.") { s = s.dropFirst(6) } else if s.hasPrefix("language_model.") { s = s.dropFirst(15) } else { break }
    }
    guard s.hasPrefix("layers.") else { return nil }
    let digits = s.dropFirst(7).prefix { $0.isNumber }
    guard !digits.isEmpty, s.dropFirst(7 + digits.count).first == "." else { return nil }
    return Int(digits)
}

/// Downloads layers [lo, hi) of `repo` into LocalLayers.dir(repo). `progress(done, total)` in bytes.
func downloadLayers(repo: String, files: [String], lo: Int, hi: Int,
                    progress: @escaping @Sendable (Int64, Int64) -> Void) async throws -> URL {
    let fm = FileManager.default
    let dir = LocalLayers.dir(repo)
    try fm.createDirectory(at: dir, withIntermediateDirectories: true)
    try repo.write(to: dir.appendingPathComponent(".repo"), atomically: true, encoding: .utf8)
    let out = dir.appendingPathComponent("layers-\(lo)-\(hi).safetensors")
    if fm.fileExists(atPath: out.path) { return out }
    for f in HF.metaFiles where !fm.fileExists(atPath: dir.appendingPathComponent(f).path) {
        if let (data, r) = try? await URLSession.shared.data(from: HF.file(repo, f)), (r as? HTTPURLResponse)?.statusCode == 200 {
            try data.write(to: dir.appendingPathComponent(f))
        }
    }

    // Which files hold our layers: the index says, unless it names files the repo doesn't have (a stale
    // index, see slicer.weight_map); then every file's header is read anyway.
    var wanted = Set(files)
    if let idx = try? JSONSerialization.jsonObject(with: Data(contentsOf: dir.appendingPathComponent("model.safetensors.index.json"))) as? [String: Any],
       let wm = idx["weight_map"] as? [String: String], Set(wm.values).isSubset(of: Set(files)) {
        wanted = Set(wm.compactMap { name, file in layerIndex(name).map { (lo..<hi).contains($0) } == true ? file : nil })
    }

    // Plan: per file, our tensors in file order, coalesced into runs of adjacent bytes (≤ 64 MB a request).
    var header: [String: Any] = [:]
    var pos: Int64 = 0
    var requests: [(url: URL, start: Int64, end: Int64)] = []   // inclusive byte ranges, in output order
    for f in wanted.sorted() {
        let url = HF.file(repo, f)
        let hlen = try await range(url, 0, 7).withUnsafeBytes { Int64(UInt64(littleEndian: $0.loadUnaligned(as: UInt64.self))) }
        guard let fh = try JSONSerialization.jsonObject(with: try await range(url, 8, 8 + hlen - 1)) as? [String: Any] else {
            throw WireError("\(f): bad safetensors header")
        }
        let items: [(String, [String: Any], Int64, Int64)] = fh.compactMap { name, v in
            guard let meta = v as? [String: Any], let i = layerIndex(name), (lo..<hi).contains(i),
                  let offs = meta["data_offsets"] as? [NSNumber], offs.count == 2 else { return nil }
            return (name, meta, 8 + hlen + offs[0].int64Value, 8 + hlen + offs[1].int64Value - 1)
        }.sorted { $0.2 < $1.2 }
        for (name, meta, s, e) in items {
            header[name] = ["dtype": meta["dtype"]!, "shape": meta["shape"]!, "data_offsets": [pos, pos + e - s + 1]]
            pos += e - s + 1
            if let last = requests.last, last.url == url, last.end + 1 == s, e - last.start < 64 << 20 {
                requests[requests.count - 1].end = e
            } else {
                requests.append((url, s, e))
            }
        }
    }
    guard !header.isEmpty else { throw WireError("\(repo) has no tensors for layers \(lo)–\(hi - 1)") }
    header["__metadata__"] = ["format": "mlx"]

    var hb = try JSONSerialization.data(withJSONObject: header, options: [.withoutEscapingSlashes])
    hb.append(contentsOf: [UInt8](repeating: 0x20, count: (8 - hb.count % 8) % 8))
    let part = dir.appendingPathComponent("layers-\(lo)-\(hi).part")
    fm.createFile(atPath: part.path, contents: withUnsafeBytes(of: UInt64(hb.count).littleEndian) { Data($0) } + hb)
    let fh = try FileHandle(forWritingTo: part)
    var ok = false
    defer {
        try? fh.close()
        if !ok { try? fm.removeItem(at: part) }
    }
    try fh.seekToEnd()
    let total = pos
    var done: Int64 = 0
    progress(0, total)
    for r in requests {
        try Task.checkCancellation()
        let base = done
        let tmp = try await rangeToFile(r.url, r.start, r.end) { progress(base + $0, total) }
        defer { try? fm.removeItem(at: tmp) }
        let src = try FileHandle(forReadingFrom: tmp)
        defer { try? src.close() }
        var n: Int64 = 0
        while let chunk = try src.read(upToCount: 8 << 20), !chunk.isEmpty {
            try fh.write(contentsOf: chunk)
            n += Int64(chunk.count)
        }
        guard n == r.end - r.start + 1 else { throw WireError("short read from \(r.url.lastPathComponent): \(n) bytes") }
        done += n
        progress(done, total)
    }
    try fh.close()
    try fm.moveItem(at: part, to: out)
    ok = true
    return out
}

private func rangeRequest(_ url: URL, _ start: Int64, _ end: Int64) -> URLRequest {
    var req = URLRequest(url: url)
    req.setValue("bytes=\(start)-\(end)", forHTTPHeaderField: "Range")
    return req
}

private func range(_ url: URL, _ start: Int64, _ end: Int64) async throws -> Data {
    let (data, resp) = try await URLSession.shared.data(for: rangeRequest(url, start, end))
    guard (resp as? HTTPURLResponse)?.statusCode == 206 else { throw WireError("server ignored the Range request for \(url.lastPathComponent)") }
    return data
}

/// One range request saved to a temporary file (big ranges never sit in memory), with byte progress.
private func rangeToFile(_ url: URL, _ start: Int64, _ end: Int64, progress: @escaping @Sendable (Int64) -> Void) async throws -> URL {
    let (tmp, resp) = try await URLSession.shared.download(for: rangeRequest(url, start, end), delegate: Progress(progress))
    guard (resp as? HTTPURLResponse)?.statusCode == 206 else {
        try? FileManager.default.removeItem(at: tmp)
        throw WireError("server ignored the Range request for \(url.lastPathComponent)")
    }
    return tmp
}

private final class Progress: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    let f: @Sendable (Int64) -> Void
    init(_ f: @escaping @Sendable (Int64) -> Void) { self.f = f }
    func urlSession(_ s: URLSession, downloadTask: URLSessionDownloadTask, didWriteData _: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite _: Int64) {
        f(totalBytesWritten)
    }
    func urlSession(_ s: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {}
}
