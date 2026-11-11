// swift-tools-version: 5.9
import PackageDescription

// The iOS peer's pod and rendezvous core (docs/PODS_PLAN.md): canonical JSON, roster checks, invites
// and the pod room / public lobby protocol. Checked against tests/pod_vectors.json like every port.
let package = Package(
    name: "PodTorrentKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "PodTorrentKit", targets: ["PodTorrentKit"])],
    targets: [
        .target(name: "PodTorrentKit"),
        .testTarget(name: "PodTorrentKitTests", dependencies: ["PodTorrentKit"]),
    ]
)
