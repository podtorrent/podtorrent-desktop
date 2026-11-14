import Foundation

// The servers this build talks to, as podtorrent/endpoints.py reads them. None are in the repository:
// an app bundles its own endpoints.json (official builds get it from CI; a fork copies
// endpoints.example.json and points it at servers it deployed). Lookup: PODTORRENT_ENDPOINTS (a path),
// then endpoints.json in the main bundle. PODTORRENT_RENDEZVOUS overrides the rendezvous.

public enum Endpoints {
    static let config: [String: Any] = {
        let env = ProcessInfo.processInfo.environment
        let url = env["PODTORRENT_ENDPOINTS"].map { URL(fileURLWithPath: $0) }
            ?? Bundle.main.url(forResource: "endpoints", withExtension: "json")
        guard let url, let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return obj
    }()

    /// The rendezvous base URL, or "" when this build has none.
    public static var rendezvous: String {
        let env = ProcessInfo.processInfo.environment["PODTORRENT_RENDEZVOUS"]
        return (env ?? config["rendezvous"] as? String ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    /// Public keys (hex) allowed to sign public rosters: the rendezvous Worker's MATCHMAKER_SEED.
    public static var matchmakers: [String] { config["matchmakers"] as? [String] ?? [] }
}
