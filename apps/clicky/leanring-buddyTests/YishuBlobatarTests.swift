import Foundation
import Testing
@testable import Clicky

struct YishuBlobatarTests {
    private let seedA = "yishu.task.11111111-1111-1111-1111-111111111111"
    private let seedB = "yishu.task.22222222-2222-2222-2222-222222222222"

    @Test func sameNameAlwaysDrawsTheSameCreature() {
        #expect(YishuBlobatar.svg(name: seedA) == YishuBlobatar.svg(name: seedA))
        #expect(YishuBlobatar.svg(name: "Alain@x.com") == YishuBlobatar.svg(name: "alain@x.com"))
    }

    @Test func differentTasksDrawDifferentCreatures() {
        #expect(YishuBlobatar.svg(name: seedA) != YishuBlobatar.svg(name: seedB))
    }

    @Test func matchesUpstreamBlobatarGoldens() {
        #expect(YishuBlobatar.svg(name: seedA) == Self.goldenA)
        #expect(YishuBlobatar.svg(name: seedB) == Self.goldenB)
        #expect(YishuBlobatar.svg(name: "alain") == Self.goldenAlain)
        #expect(YishuBlobatar.svg(name: seedA, expression: .happy) == Self.goldenHappy)
        #expect(YishuBlobatar.svg(name: seedA, expression: .sad) == Self.goldenSad)
    }

    @Test func taskIdIsTheSeedAndStatusOnlyChangesTheFace() {
        let id = UUID(uuidString: "11111111-1111-1111-1111-111111111111")!
        let running = makeTask(id: id, status: .running)
        let done = makeTask(id: id, status: .done)
        #expect(running.blobatarName == seedA)
        #expect(YishuBlobatar.svg(name: running.blobatarName) == Self.goldenA)
        #expect(done.blobatarExpression == .happy)
        #expect(YishuBlobatar.svg(name: done.blobatarName, expression: done.blobatarExpression) == Self.goldenHappy)
        #expect(YishuBlobatar.expression(for: .failed) == .sad)
        #expect(YishuBlobatar.expression(for: .cancelled) == .sleepy)
        #expect(YishuBlobatar.expression(for: .interrupted) == .scared)
        #expect(YishuBlobatar.animates(for: .running))
        #expect(!YishuBlobatar.animates(for: .done))
    }

    private func makeTask(id: UUID, status: YishuDelegatedTaskStatus) -> YishuDelegatedTaskPresenceEvent {
        YishuDelegatedTaskPresenceEvent(
            id: id,
            parentId: UUID(),
            mainConversationId: UUID(),
            title: "整理研究结论",
            status: status,
            createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            updatedAt: Date(timeIntervalSince1970: 1_700_000_010),
            provider: nil,
            model: nil,
            resultKind: nil,
            summary: nil,
            sourceEventId: UUID()
        )
    }

    private static let goldenA = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><g fill=\"#f5bce7\"><path d=\"M86.01 48.51C86.74 57.15 80.2 70.87 72.84 77.23C65.49 83.59 50.23 89.18 41.86 86.67C33.49 84.16 26.58 71.15 22.63 62.15C18.68 53.15 14.94 41.22 18.16 32.67C21.38 24.12 33.59 12.07 41.98 10.86C50.36 9.65 61.12 19.12 68.46 25.39C75.8 31.67 85.28 39.87 86.01 48.51Z\"/></g><g fill=\"#150c13\"><path d=\"M42.82 42.53C42.78 51.21 42.59 51.74 39.55 51.73C36.52 51.71 36.34 51.18 36.38 42.5C36.42 33.82 36.61 33.29 39.65 33.3C42.68 33.32 42.86 33.85 42.82 42.53Z\"/><path d=\"M61.09 42.97C61.62 53.09 61.45 53.72 58.22 53.89C54.99 54.05 54.76 53.45 54.23 43.33C53.71 33.21 53.87 32.59 57.1 32.42C60.33 32.25 60.56 32.86 61.09 42.97Z\"/></g></svg>"
    private static let goldenB = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><g fill=\"#453425\"><path d=\"M82.21 50.19C82.21 66.96 67.77 81.49 51.09 81.49C34.42 81.49 19.97 66.96 19.97 50.19C19.97 33.42 34.42 18.89 51.09 18.89C67.77 18.89 82.21 33.42 82.21 50.19Z\"/></g><g fill=\"#fbf4ed\"><path d=\"M41.52 50.05C42.47 56.9 42.25 57.79 39.55 58.17C36.84 58.54 36.39 57.74 35.45 50.89C34.5 44.03 34.72 43.14 37.42 42.77C40.12 42.39 40.57 43.19 41.52 50.05Z\"/><path d=\"M62.73 50.16C63.39 58.09 63.13 59.1 60.36 59.33C57.6 59.56 57.17 58.61 56.52 50.68C55.86 42.75 56.12 41.75 58.89 41.52C61.65 41.29 62.08 42.23 62.73 50.16Z\"/></g></svg>"
    private static let goldenAlain = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><g fill=\"#d0d897\"><path d=\"M88.1 50.49C88.1 73.31 73.75 87.6 50.83 87.6C27.91 87.6 13.56 73.31 13.56 50.49C13.56 27.67 27.91 13.39 50.83 13.39C73.75 13.39 88.1 27.67 88.1 50.49Z\"/></g><g fill=\"#0f1006\"><path d=\"M41.86 50.24C39.96 59.57 39.93 59.62 36.16 58.86C32.39 58.09 32.38 58.03 34.28 48.7C36.17 39.36 36.21 39.31 39.97 40.08C43.74 40.84 43.75 40.9 41.86 50.24Z\"/><path d=\"M64.59 48.75C62.81 57.79 62.78 57.85 59.55 57.21C56.33 56.57 56.32 56.51 58.1 47.47C59.89 38.42 59.92 38.37 63.14 39.01C66.37 39.64 66.38 39.7 64.59 48.75Z\"/></g></svg>"
    private static let goldenHappy = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><g transform=\"translate(0 -2.2)\"><g fill=\"#f5bce7\"><path d=\"M86.01 48.51C86.74 57.15 80.2 70.87 72.84 77.23C65.49 83.59 50.23 89.18 41.86 86.67C33.49 84.16 26.58 71.15 22.63 62.15C18.68 53.15 14.94 41.22 18.16 32.67C21.38 24.12 33.59 12.07 41.98 10.86C50.36 9.65 61.12 19.12 68.46 25.39C75.8 31.67 85.28 39.87 86.01 48.51Z\"/></g><g fill=\"#150c13\"><path d=\"M43.59 40.24C43.95 42.82 43.65 43.03 38.48 43.75C33.31 44.48 32.98 44.37 32.61 41.79C32.25 39.21 32.55 39.01 37.72 38.28C42.89 37.55 43.22 37.67 43.59 40.24Z\"/><path d=\"M65.28 40.79C65.77 44.3 65.45 44.57 59.68 45.38C53.92 46.19 53.54 46.02 53.04 42.51C52.55 39 52.87 38.74 58.64 37.93C64.4 37.12 64.78 37.28 65.28 40.79Z\"/></g></g></svg>"
    private static let goldenSad = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><g transform=\"translate(0 2.6)\"><g fill=\"#f5bce7\"><path d=\"M86.01 48.51C86.74 57.15 80.2 70.87 72.84 77.23C65.49 83.59 50.23 89.18 41.86 86.67C33.49 84.16 26.58 71.15 22.63 62.15C18.68 53.15 14.94 41.22 18.16 32.67C21.38 24.12 33.59 12.07 41.98 10.86C50.36 9.65 61.12 19.12 68.46 25.39C75.8 31.67 85.28 39.87 86.01 48.51Z\"/></g><g fill=\"#150c13\"><path d=\"M39.44 45.27C41.57 49.64 41.6 49.95 39.96 50.75C38.32 51.55 38.09 51.33 35.96 46.96C33.83 42.59 33.8 42.28 35.44 41.48C37.08 40.68 37.31 40.9 39.44 45.27Z\"/><path d=\"M61.34 47.37C59.73 52.06 59.53 52.31 57.85 51.73C56.16 51.15 56.16 50.83 57.78 46.14C59.39 41.44 59.59 41.19 61.27 41.77C62.96 42.35 62.96 42.67 61.34 47.37Z\"/></g></g></svg>"
}
