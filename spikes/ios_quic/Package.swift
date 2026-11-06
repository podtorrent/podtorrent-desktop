// swift-tools-version: 5.9
import PackageDescription

// Spike: can Network.framework QUIC (what an iOS peer would use) talk to the Python aioquic PeerNet?
let package = Package(
    name: "QuicSpike",
    platforms: [.macOS(.v13)],
    targets: [.executableTarget(name: "QuicSpike")]
)
