// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "YishuTestbed",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "YishuTestbed", targets: ["YishuTestbed"]),
    ],
    targets: [
        .executableTarget(name: "YishuTestbed"),
        .testTarget(name: "YishuTestbedTests", dependencies: ["YishuTestbed"]),
    ]
)
