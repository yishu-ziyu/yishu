// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "YishuTestbed",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "YishuTestbedKit", targets: ["YishuTestbedKit"]),
        .executable(name: "YishuTestbed", targets: ["YishuTestbed"]),
    ],
    targets: [
        .target(name: "YishuTestbedKit"),
        .executableTarget(name: "YishuTestbed", dependencies: ["YishuTestbedKit"]),
        .testTarget(name: "YishuTestbedTests", dependencies: ["YishuTestbedKit"]),
    ]
)
