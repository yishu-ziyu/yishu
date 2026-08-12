// swift-tools-version: 5.10

import PackageDescription

let package = Package(
    name: "Yishu",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .library(name: "YishuContext", targets: ["YishuContext"]),
    ],
    targets: [
        .target(
            name: "YishuContext",
            path: "Sources/YishuContext"
        ),
        .testTarget(
            name: "YishuContextTests",
            dependencies: ["YishuContext"],
            path: "Tests/YishuContextTests"
        ),
    ],
    swiftLanguageVersions: [.v5]
)
