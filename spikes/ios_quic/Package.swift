// swift-tools-version: 5.9
import PackageDescription

// Spike: can Network.framework QUIC (what an iOS peer would use) talk to the Python aioquic PeerNet?
// PeerTestCLI runs the iPad test app's peer (PeerTest.swiftpm/Core, symlinked) headless on macOS.
let package = Package(
    name: "QuicSpike",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "QuicSpike"),
        .executableTarget(name: "PeerTestCLI"),
    ]
)
