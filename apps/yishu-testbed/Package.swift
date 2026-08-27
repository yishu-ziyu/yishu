// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "YishuTestbed",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "YishuTestbedKit", targets: ["YishuTestbedKit"]),
        .executable(name: "YishuTestbed", targets: ["YishuTestbed"]),
        .executable(name: "YishuTestbedDriver", targets: ["YishuTestbedDriver"]),
    ],
    targets: [
        .target(name: "YishuTestbedKit"),
        .executableTarget(name: "YishuTestbed", dependencies: ["YishuTestbedKit"]),
        .executableTarget(name: "YishuTestbedDriver"),
        .testTarget(name: "YishuTestbedTests", dependencies: ["YishuTestbedKit"]),
    ]
)
