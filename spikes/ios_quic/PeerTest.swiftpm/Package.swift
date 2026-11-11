// swift-tools-version: 5.9

// A Swift Playgrounds app: open this folder in Swift Playgrounds on the iPad and tap Run.
import AppleProductTypes
import PackageDescription

let package = Package(
    name: "PodTorrent Test",
    platforms: [
        .iOS("17.0"),
    ],
    products: [
        .iOSApplication(
            name: "PodTorrent Test",
            targets: ["AppModule"],
            bundleIdentifier: "com.podtorrent.peertest",
            teamIdentifier: "",
            displayVersion: "1.0",
            bundleVersion: "1",
            supportedDeviceFamilies: [
                .pad,
                .phone,
            ],
            supportedInterfaceOrientations: [
                .portrait,
                .landscapeRight,
                .landscapeLeft,
                .portraitUpsideDown(.when(deviceFamilies: [.pad])),
            ],
            capabilities: [
                .localNetwork(purposeString: "Connects to PodTorrent peers on your network."),
            ]
        ),
    ],
    targets: [
        .executableTarget(
            name: "AppModule",
            path: "."
        ),
    ]
)
