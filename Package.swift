// swift-tools-version: 5.10

import PackageDescription

let package = Package(
    name: "Yishu",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(name: "Yishu", targets: ["Yishu"]),
        .library(name: "YishuContext", targets: ["YishuContext"]),
    ],
    targets: [
        .target(
            name: "YishuContext",
            path: "apps/macos/Sources/YishuContext"
        ),
        .executableTarget(
            name: "Yishu",
            dependencies: ["YishuContext"],
            path: "apps/macos/Sources/YishuApp"
        ),
        .testTarget(
            name: "YishuContextTests",
            dependencies: ["YishuContext"],
            path: "apps/macos/Tests/YishuContextTests"
        ),
    ],
    swiftLanguageVersions: [.v5]
)
