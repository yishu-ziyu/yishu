import Foundation
import Testing
@testable import Clicky

struct YishuBreathingOrbGeometryTests {
    private struct Golden {
        let state: YishuBreathingOrbState
        let dots: Int
        let lines: Int
        let first: [Double]
    }

    private let goldens: [Golden] = [
        .init(state: .working, dots: 39, lines: 0, first: [11.235898, 9.940794, -7.451958, 0.425401, 0.720000, 0.202026]),
        .init(state: .searching, dots: 54, lines: 0, first: [11.574668, 10.979949, -0.974085, 0.300000, 0.613003, 0.450000]),
        .init(state: .solving, dots: 30, lines: 0, first: [8.121109, 13.194107, -0.892058, 0.300000, 0.590856, 1.000000]),
        .init(state: .listening, dots: 42, lines: 0, first: [9.175250, 9.487216, -7.986373, 0.300000, 0.597281, 1.000000]),
        .init(state: .connecting, dots: 9, lines: 0, first: [12.345722, 12.323515, -0.910862, 0.652664, 0.050000, 0.522284]),
        .init(state: .weaving, dots: 35, lines: 0, first: [11.450750, 9.567985, -7.447730, 0.300000, 0.780000, 0.102204]),
        .init(state: .composing, dots: 208, lines: 0, first: [7.795005, 12.112063, -7.177547, 0.300000, 0.682444, 0.423940]),
        .init(state: .breathing, dots: 120, lines: 0, first: [12.339578, 17.200480, -1.987396, 0.415300, 0.536055, 0.623562]),
        .init(state: .shaping, dots: 18, lines: 0, first: [10.000000, 2.906581, 0.000000, 0.831194, 0.100000, 1.000000])
    ]

    @Test func all20PixelStatesMatchThinkingOrbs031GoldenVectorsAtReducedMotionFrame() throws {
        for golden in goldens {
            let frame = YishuBreathingOrbGeometry.frame(state: golden.state, time: 0.6)
            #expect(frame.dots.count == golden.dots, "\(golden.state.rawValue) dot count")
            #expect(frame.lines.count == golden.lines, "\(golden.state.rawValue) line count")

            let first = try #require(frame.dots.first)
            let actual = [first.x, first.y, first.z, first.radius, first.white, first.alpha]
            for (actualValue, expectedValue) in zip(actual, golden.first) {
                #expect(abs(actualValue - expectedValue) < 0.0001, "\(golden.state.rawValue) golden component")
            }
        }
    }

    @Test func all20PixelStatesChangeOverTime() {
        for state in YishuBreathingOrbState.allCases {
            let start = YishuBreathingOrbGeometry.frame(state: state, time: 0.6)
            let later = YishuBreathingOrbGeometry.frame(state: state, time: 1.7)

            #expect(start.dots.count > 0)
            #expect(later.dots.count > 0)
            #expect(start.dots.allSatisfy { $0.radius >= 0.25 && $0.alpha >= 0.02 })

            let changed = start.dots.count != later.dots.count || start.lines.count != later.lines.count || zip(start.dots, later.dots).contains { lhs, rhs in
                abs(lhs.x - rhs.x) > 0.05 || abs(lhs.y - rhs.y) > 0.05 || abs(lhs.alpha - rhs.alpha) > 0.05
            }
            #expect(changed, "\(state.rawValue) changes over time")
        }
    }

    @Test func breathingDotOnlyCompatibilityAPIStillReturnsRingDots() throws {
        let dots = YishuBreathingOrbGeometry.frame(time: 0.6)
        let frame = YishuBreathingOrbGeometry.frame(state: .breathing, time: 0.6)

        #expect(dots == frame.dots)
        #expect(frame.lines.isEmpty)
        #expect(dots.count == 120)
        let first = try #require(dots.first)
        #expect(abs(first.x - 12.339578) < 0.0001)
        #expect(abs(first.y - 17.200480) < 0.0001)
        #expect(abs(first.z - -1.987396) < 0.0001)
        #expect(abs(first.radius - 0.415300) < 0.0001)
        #expect(abs(first.white - 0.536055) < 0.0001)
        #expect(abs(first.alpha - 0.623562) < 0.0001)
    }
}
