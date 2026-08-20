// Geometry and palette adapted from blobatar by Alain.
// Copyright (c) 2026 Alain. Licensed under the MIT License.
// https://github.com/Alain00/blobatar
// Faithful Swift port of blobatar's hash, trait stream, OKLCh ramp, and blob layout.
// Same name in the same major mapping always yields the same figure.

import SwiftUI

enum YishuBlobatar {
    enum Expression: String, Equatable {
        case idle
        case happy
        case sad
        case unsure
        case sleepy
        case scared
    }

    struct Figure: Equatable {
        let svg: String
        let headHex: String
        let eyeHex: String
        let wrapY: Double
        let petals: [Petal]
        let bodyPath: String
        let eyePaths: [String]
    }

    struct Petal: Equatable {
        let cx: Double
        let cy: Double
        let r: Double
    }

    static func seed(taskID: UUID) -> String {
        "yishu.task.\(taskID.uuidString.lowercased())"
    }

    static func expression(for status: YishuDelegatedTaskStatus) -> Expression {
        switch status {
        case .pending: return .unsure
        case .running: return .idle
        case .done: return .happy
        case .blocked: return .unsure
        case .failed: return .sad
        case .cancelled: return .sleepy
        case .interrupted: return .scared
        }
    }

    static func animates(for status: YishuDelegatedTaskStatus) -> Bool {
        status == .pending || status == .running
    }

    static func svg(name: String, expression: Expression = .idle) -> String {
        figure(name: name, expression: expression).svg
    }

    static func figure(name: String, expression: Expression = .idle) -> Figure {
        let traits = TraitReader(name: name)
        let hue = traits.num("hue", 0, 360)
        let palette = Palette.ramp(hue: hue, tone: traits("tone"))
        let layout = BlobLayout.make(traits)
        let posed = expression.bake(layout)
        let bodySVG = posed.layout.render(head: palette.head, eye: palette.eye)
        let wrapped = posed.wrapY == 0
            ? bodySVG
            : "<g transform=\"translate(0 \(r3(posed.wrapY)))\">\(bodySVG)</g>"
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\">\(wrapped)</svg>"
        return Figure(
            svg: svg,
            headHex: palette.head,
            eyeHex: palette.eye,
            wrapY: posed.wrapY,
            petals: posed.layout.petals,
            bodyPath: posed.layout.corePath,
            eyePaths: posed.layout.eyes.map(\.path)
        )
    }
}

struct YishuBlobatarView: View {
    let name: String
    var expression: YishuBlobatar.Expression = .idle
    var size: CGFloat = 36
    var animates: Bool = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulse = false

    var body: some View {
        let figure = YishuBlobatar.figure(name: name, expression: expression)
        BlobatarCanvas(figure: figure)
            .frame(width: size, height: size)
            .scaleEffect(shouldPulse && pulse ? 1.06 : 1)
            .offset(y: shouldPulse && pulse ? -0.8 : 0)
            .onAppear {
                guard shouldPulse else { return }
                withAnimation(.easeInOut(duration: 1.8).repeatForever(autoreverses: true)) {
                    pulse = true
                }
            }
            .accessibilityHidden(true)
    }

    private var shouldPulse: Bool {
        animates && !reduceMotion
    }
}

private struct BlobatarCanvas: View {
    let figure: YishuBlobatar.Figure

    var body: some View {
        Canvas { context, size in
            let scale = min(size.width, size.height) / 100
            var inner = context
            inner.scaleBy(x: scale, y: scale)
            if figure.wrapY != 0 {
                inner.translateBy(x: 0, y: figure.wrapY)
            }
            let head = Color(blobatarHex: figure.headHex)
            let eye = Color(blobatarHex: figure.eyeHex)
            for petal in figure.petals {
                let rect = CGRect(
                    x: petal.cx - petal.r,
                    y: petal.cy - petal.r,
                    width: petal.r * 2,
                    height: petal.r * 2
                )
                inner.fill(Path(ellipseIn: rect), with: .color(head))
            }
            if let body = Path(svgPath: figure.bodyPath) {
                inner.fill(body, with: .color(head))
            }
            for eyePath in figure.eyePaths {
                if let path = Path(svgPath: eyePath) {
                    inner.fill(path, with: .color(eye))
                }
            }
        }
    }
}

// MARK: - Hash (blobatar/src/hash.ts)

private enum BlobHash {
    static func normalize(_ seed: String) -> String {
        seed.precomposedStringWithCanonicalMapping
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
    }

    static func seedState(_ seed: String) -> Int32 {
        let normalized = normalize(seed)
        let bytes = Array(normalized.utf8)
        let initial = Int32(truncatingIfNeeded: 1_779_033_703) ^ Int32(truncatingIfNeeded: bytes.count)
        return feed(initial, bytes)
    }

    static func stream(_ state: Int32, key: String) -> Double {
        let mixed = feed(feed(state, [0xFF]), Array(key.utf8))
        return Double(finalize(mixed)) / 4_294_967_296.0
    }

    private static func feed(_ start: Int32, _ bytes: [UInt8]) -> Int32 {
        var h = start
        for byte in bytes {
            h = imul(h ^ Int32(byte), Int32(bitPattern: 3_432_918_353))
            let bits = UInt32(bitPattern: h)
            h = Int32(bitPattern: (bits << 13) | (bits >> 19))
        }
        return h
    }

    private static func finalize(_ start: Int32) -> UInt32 {
        var h = start
        h = imul(h ^ Int32(bitPattern: UInt32(bitPattern: h) >> 16), Int32(bitPattern: 2_246_822_507))
        h = imul(h ^ Int32(bitPattern: UInt32(bitPattern: h) >> 13), Int32(bitPattern: 3_266_489_909))
        return UInt32(bitPattern: h) ^ (UInt32(bitPattern: h) >> 16)
    }

    private static func imul(_ a: Int32, _ b: Int32) -> Int32 {
        a &* b
    }
}

// MARK: - Traits

private struct TraitReader {
    private let state: Int32

    init(name: String) {
        state = BlobHash.seedState(name)
    }

    func callAsFunction(_ key: String) -> Double {
        BlobHash.stream(state, key: key)
    }

    func num(_ key: String, _ min: Double, _ max: Double) -> Double {
        min + self(key) * (max - min)
    }

    func int(_ key: String, _ min: Int, _ max: Int) -> Int {
        min + Int(floor(self(key) * Double(max - min + 1)))
    }

    func jitter(_ key: String, _ amount: Double) -> Double {
        (self(key) * 2 - 1) * amount
    }
}

// MARK: - Palette (blobatar/src/color.ts)

private struct Oklch {
    var l: Double
    var c: Double
    var h: Double
}

private struct Palette {
    let head: String
    let eye: String

    private static let tones: [(Double, (l: Double, c: Double))] = [
        (0.2, (0.86, 0.085)),
        (0.36, (0.9, 0.028)),
        (0.62, (0.73, 0.135)),
        (0.8, (0.62, 0.165)),
        (0.93, (0.87, 0.16)),
        (1.0, (0.34, 0.035)),
    ]
    private static let darkSurface = Oklch(l: 0.145, c: 0, h: 0)
    private static let surfaceFloor = 1.5

    static func ramp(hue: Double, tone: Double) -> Palette {
        let swatch = tones.first(where: { tone < $0.0 })?.1 ?? tones[0].1
        var head = ensureContrast(Oklch(l: swatch.l, c: swatch.c, h: hue), darkSurface, surfaceFloor)
        var bg = Oklch(l: 0.965, c: 0.01, h: hue)
        var eye = head.l >= 0.5
            ? Oklch(l: 0.17, c: 0.02, h: hue)
            : Oklch(l: 0.97, c: 0.012, h: hue)
        head = ensureContrast(head, bg, 1.25)
        eye = ensureContrast(eye, head, 4.5)
        return Palette(head: toHex(head), eye: toHex(eye))
    }

    private static func toLinear(_ color: Oklch) -> (Double, Double, Double) {
        let r = (color.h * .pi) / 180
        let a = color.c * cos(r)
        let b = color.c * sin(r)
        let l_ = color.l + 0.3963377774 * a + 0.2158037573 * b
        let m_ = color.l - 0.1055613458 * a - 0.0638541728 * b
        let s_ = color.l - 0.0894841775 * a - 1.291485548 * b
        let L = l_ * l_ * l_
        let M = m_ * m_ * m_
        let S = s_ * s_ * s_
        return (
            4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
            -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
            -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S
        )
    }

    private static func inGamut(_ rgb: (Double, Double, Double)) -> Bool {
        [rgb.0, rgb.1, rgb.2].allSatisfy { $0 >= -1e-4 && $0 <= 1 + 1e-4 }
    }

    private static func resolve(_ color: Oklch) -> (Double, Double, Double) {
        var rgb = toLinear(color)
        if !inGamut(rgb) {
            var lo = 0.0
            var hi = color.c
            for _ in 0..<12 {
                let mid = (lo + hi) / 2
                if inGamut(toLinear(Oklch(l: color.l, c: mid, h: color.h))) {
                    lo = mid
                } else {
                    hi = mid
                }
            }
            rgb = toLinear(Oklch(l: color.l, c: lo, h: color.h))
        }
        return (
            min(1, max(0, rgb.0)),
            min(1, max(0, rgb.1)),
            min(1, max(0, rgb.2))
        )
    }

    private static func luminance(_ color: Oklch) -> Double {
        let rgb = resolve(color)
        return 0.2126 * rgb.0 + 0.7152 * rgb.1 + 0.0722 * rgb.2
    }

    private static func contrast(_ a: Oklch, _ b: Oklch) -> Double {
        let x = luminance(a)
        let y = luminance(b)
        return (max(x, y) + 0.05) / (min(x, y) + 0.05)
    }

    private static func ensureContrast(_ fg: Oklch, _ bg: Oklch, _ minRatio: Double) -> Oklch {
        if contrast(fg, bg) >= minRatio { return fg }
        let lean: Double = fg.l >= bg.l ? 1 : -1
        for dir in [lean, -lean] {
            var probe = fg
            for _ in 0..<60 {
                probe.l = min(1, max(0, probe.l + dir * 0.02))
                if contrast(probe, bg) >= minRatio { return probe }
                if probe.l == 0 || probe.l == 1 { break }
            }
        }
        let black = Oklch(l: 0, c: 0, h: fg.h)
        let white = Oklch(l: 1, c: 0, h: fg.h)
        return contrast(black, bg) >= contrast(white, bg) ? black : white
    }

    private static func toHex(_ color: Oklch) -> String {
        let rgb = resolve(color)
        func channel(_ v: Double) -> String {
            let s = v <= 0.0031308 ? 12.92 * v : 1.055 * pow(v, 1 / 2.4) - 0.055
            return String(format: "%02x", Int(jsRound(s * 255)))
        }
        return "#\(channel(rgb.0))\(channel(rgb.1))\(channel(rgb.2))"
    }
}

// MARK: - Shape + layout (blobatar/src/shape.ts + styles/blob.ts)

private enum ShapeKind {
    case round, organic, boxy, nub, cloud, sun

    static func from(_ value: Double) -> ShapeKind {
        if value < 0.28 { return .round }
        if value < 0.58 { return .organic }
        if value < 0.72 { return .boxy }
        if value < 0.84 { return .nub }
        if value < 0.93 { return .cloud }
        return .sun
    }

    var core: Double {
        switch self {
        case .round: return 1
        case .boxy: return 0.86
        case .organic: return 0.98
        case .cloud: return 0.78
        case .sun: return 0.7
        case .nub: return 0.88
        }
    }
}

private struct EyeLayout {
    var cx: Double
    var cy: Double
    var rx: Double
    var ry: Double
    var n: Double
    var rot: Double

    var path: String {
        superellipse(cx: cx, cy: cy, rx: rx, ry: ry, n: n, rot: rot)
    }
}

private struct BlobLayout {
    var shape: ShapeKind
    var body: (cx: Double, cy: Double, rx: Double, ry: Double, n: Double, rot: Double, radii: [Double])
    var petals: [YishuBlobatar.Petal]
    var eyes: [EyeLayout]

    var corePath: String {
        if shape == .organic || shape == .cloud {
            return blobPath(
                cx: body.cx,
                cy: body.cy,
                rx: body.rx,
                ry: body.ry,
                radii: body.radii,
                rot: shape == .cloud ? 0 : body.rot
            )
        }
        return superellipse(
            cx: body.cx,
            cy: body.cy,
            rx: body.rx,
            ry: body.ry,
            n: body.n,
            rot: body.rot
        )
    }

    func render(head: String, eye: String) -> String {
        let decoration = petals.map { petal in
            "<circle cx=\"\(r2(petal.cx))\" cy=\"\(r2(petal.cy))\" r=\"\(r2(petal.r))\"/>"
        }.joined()
        let eyeMarkup = eyes.map { "<path d=\"\($0.path)\"/>" }.joined()
        return "<g fill=\"\(head)\">\(decoration)<path d=\"\(corePath)\"/></g><g fill=\"\(eye)\">\(eyeMarkup)</g>"
    }

    static func make(_ t: TraitReader) -> BlobLayout {
        let shape = ShapeKind.from(t("shape"))
        let r = t.num("body.r", 31, 38) * shape.core
        let rx = r
        let ry = r * t.num("body.ratio", 0.92, 1.08)
        let pointCount = t.int("body.pts", 6, 8)
        let radii = (0..<pointCount).map { 1 + t.jitter("body.r\($0)", 0.16) }
        let body = (
            cx: 50 + t.jitter("body.x", 1.5),
            cy: 50 + t.jitter("body.y", 1.5),
            rx: rx,
            ry: ry,
            n: shape == .boxy ? t.num("body.n", 3.4, 6) : t.num("body.n", 1.9, 2.5),
            rot: shape == .boxy ? t.num("body.rot", -20, 20) : 0.0,
            radii: radii
        )
        let gx = t.jitter("gaze.x", 0.09) * rx
        let gy = t.num("gaze.y", -0.2, 0.08) * ry
        let er0 = t.num("eye.rx", 0.075, 0.105) * rx
        let ratio = t.num("eye.ratio", 1.9, 3.2)
        let scale = t.num("eye.scale", 0.78, 1.24)
        let stretch = t.num("eye.stretch", 0.85, 1.18)
        let clearance = t.num("eye.gap", 0.1, 0.24) * rx
        let wide = er0 * max(1, scale)
        let tall = er0 * ratio * max(1, scale * stretch)
        let gap0 = wide + rx * 0.03 + clearance
        let tight = (shape == .organic || shape == .cloud) ? (radii.min() ?? 1) * 0.95 : 1
        let need = (abs(gx) + gap0 + hypot(wide, tall)) / rx
        let fit = need > tight * 0.9 ? (tight * 0.9) / need : 1
        let er = er0 * fit
        let gap = gap0 * fit
        let eyeRy = er * ratio
        let room = max(0, min(1, (clearance * fit) / (tall * fit)))
        let bound = min(12.0, (asin(room) * 180) / .pi)
        let lean = t.num("eye.lean", -1, 1) * bound
        let lean2 = max(-12, min(12, lean + t.jitter("eye.lean2", 3.5)))
        var petals: [YishuBlobatar.Petal] = []
        if shape == .sun {
            let count = t.int("sun.n", 6, 9)
            let dist = r * t.num("sun.dist", 1.0, 1.08)
            let pr = r * t.num("sun.r", 0.2, 0.26)
            let off = t.num("sun.rot", 0, 2 * .pi)
            for index in 0..<count {
                let angle = off + (2 * .pi * Double(index)) / Double(count)
                petals.append(YishuBlobatar.Petal(
                    cx: body.cx + cos(angle) * dist,
                    cy: body.cy + sin(angle) * dist,
                    r: pr
                ))
            }
        } else if shape == .cloud {
            let count = t.int("cloud.n", 4, 6)
            for index in 0..<count {
                let angle = .pi + (.pi * (Double(index) + 0.5)) / Double(count)
                petals.append(YishuBlobatar.Petal(
                    cx: body.cx + cos(angle) * r * 0.8,
                    cy: body.cy + sin(angle) * r * 0.5,
                    r: r * t.num("cloud.r\(index)", 0.44, 0.62)
                ))
            }
        } else if shape == .nub {
            let count = t.int("nub.n", 1, 2)
            for index in 0..<count {
                let angle = t.num("nub.a\(index)", 0, 2 * .pi)
                petals.append(YishuBlobatar.Petal(
                    cx: body.cx + cos(angle) * r * 0.88,
                    cy: body.cy + sin(angle) * r * 0.88,
                    r: r * t.num("nub.r\(index)", 0.24, 0.4)
                ))
            }
        }
        let eyeN = t.num("eye.n", 3.5, 6)
        return BlobLayout(
            shape: shape,
            body: body,
            petals: petals,
            eyes: [
                EyeLayout(cx: body.cx + gx - gap, cy: body.cy + gy, rx: er, ry: eyeRy, n: eyeN, rot: lean),
                EyeLayout(
                    cx: body.cx + gx + gap,
                    cy: body.cy + gy + t.jitter("eye.dy", 0.04) * ry,
                    rx: er * scale,
                    ry: eyeRy * scale * stretch,
                    n: eyeN,
                    rot: lean2
                ),
            ]
        )
    }
}

// MARK: - Expressions (static bake only)

private struct Pose {
    var esx: Double
    var esy: Double
    var tilt: Double
    var edy: Double
    var edx: Double
    var esx2: Double
    var esy2: Double
    var tilt2: Double
    var lock: Double
    var bdy: Double

    static let idle = Pose(esx: 1, esy: 1, tilt: 0, edy: 0, edx: 0, esx2: 0, esy2: 0, tilt2: 0, lock: 0, bdy: 0)
    static let happy = Pose(esx: 1.72, esy: 0.3, tilt: 8, edy: -1.5, edx: 1.5, esx2: 0.08, esy2: 0.05, tilt2: -16, lock: 1, bdy: -2.2)
    static let sad = Pose(esx: 0.6, esy: 0.56, tilt: 26, edy: 3.6, edx: 1.9, esx2: -0.05, esy2: -0.07, tilt2: -7, lock: 1, bdy: 2.6)
    static let unsure = Pose(esx: 0.95, esy: 1.02, tilt: 4, edy: -0.2, edx: 0.3, esx2: 0.24, esy2: -0.44, tilt2: -18, lock: 1, bdy: 0)
    static let sleepy = Pose(esx: 1.14, esy: 0.22, tilt: 0, edy: 2.4, edx: 0.3, esx2: -0.04, esy2: 0.03, tilt2: 4, lock: 1, bdy: 1.2)
    static let scared = Pose(esx: 0.78, esy: 0.96, tilt: -12, edy: -1.5, edx: -0.8, esx2: -0.04, esy2: 0.05, tilt2: 4, lock: 1, bdy: -0.6)
}

private extension YishuBlobatar.Expression {
    var pose: Pose {
        switch self {
        case .idle: return .idle
        case .happy: return .happy
        case .sad: return .sad
        case .unsure: return .unsure
        case .sleepy: return .sleepy
        case .scared: return .scared
        }
    }

    func bake(_ layout: BlobLayout) -> (layout: BlobLayout, wrapY: Double) {
        let pose = self.pose
        if self == .idle {
            return (layout, 0)
        }
        var next = layout
        next.eyes = layout.eyes.enumerated().map { index, eye in
            var baked = eye
            baked.cx = eye.cx + pose.edx * (index == 0 ? -1 : 1)
            baked.cy = eye.cy + pose.edy
            baked.rx = eye.rx * (pose.esx + (index == 0 ? 0 : pose.esx2))
            baked.ry = eye.ry * (pose.esy + (index == 0 ? 0 : pose.esy2))
            baked.rot = eye.rot * (1 - pose.lock) + (pose.tilt + (index == 0 ? 0 : pose.tilt2)) * (index == 0 ? -1 : 1)
            return baked
        }
        return (next, pose.bdy)
    }
}

// MARK: - Path helpers

private func jsRound(_ value: Double) -> Double {
    floor(value + 0.5)
}

private func r2(_ value: Double) -> String {
    formatNumber(jsRound(value * 100) / 100)
}

private func r3(_ value: Double) -> String {
    formatNumber(jsRound(value * 1000) / 1000)
}

private func formatNumber(_ value: Double) -> String {
    if value == 0 { return "0" }
    let sign = value < 0 ? "-" : ""
    let absValue = abs(value)
    let hundredths = Int(jsRound(absValue * 1000))
    // Keep up to 3 decimals, strip trailing zeros, match JS number toString for 2-dec r2.
    let scaled = hundredths
    if scaled % 1000 == 0 {
        return "\(sign)\(scaled / 1000)"
    }
    if scaled % 100 == 0 {
        return "\(sign)\(scaled / 1000).\( (scaled / 100) % 10 )"
    }
    if scaled % 10 == 0 {
        return String(format: "%@%d.%02d", sign, scaled / 1000, (scaled / 10) % 100)
    }
    return String(format: "%@%d.%03d", sign, scaled / 1000, scaled % 1000)
}

private func superellipse(cx: Double, cy: Double, rx: Double, ry: Double, n: Double, rot: Double) -> String {
    let k = min(1, (8 * pow(2, -1 / n) - 4) / 3)
    let a = rx
    let b = ry
    let ak = a * k
    let bk = b * k
    let pts: [(Double, Double)] = [
        (a, 0),
        (a, bk), (ak, b), (0, b),
        (-ak, b), (-a, bk), (-a, 0),
        (-a, -bk), (-ak, -b), (0, -b),
        (ak, -b), (a, -bk), (a, 0),
    ]
    let theta = (rot * .pi) / 180
    let cosT = cos(theta)
    let sinT = sin(theta)
    func at(_ index: Int) -> String {
        let point = pts[index]
        return "\(r2(cx + point.0 * cosT - point.1 * sinT)) \(r2(cy + point.0 * sinT + point.1 * cosT))"
    }
    var d = "M\(at(0))"
    var index = 1
    while index < 13 {
        d += "C\(at(index)) \(at(index + 1)) \(at(index + 2))"
        index += 3
    }
    return d + "Z"
}

private func blobPath(cx: Double, cy: Double, rx: Double, ry: Double, radii: [Double], rot: Double) -> String {
    let count = radii.count
    let t0 = (rot * .pi) / 180
    let points: [(Double, Double)] = radii.enumerated().map { index, multiplier in
        let angle = t0 + (2 * .pi * Double(index)) / Double(count)
        return (cx + rx * multiplier * cos(angle), cy + ry * multiplier * sin(angle))
    }
    func at(_ index: Int) -> (Double, Double) {
        points[((index % count) + count) % count]
    }
    var d = "M\(r2(at(0).0)) \(r2(at(0).1))"
    for index in 0..<count {
        let p0 = at(index - 1)
        let p1 = at(index)
        let p2 = at(index + 1)
        let p3 = at(index + 2)
        d += "C\(r2(p1.0 + (p2.0 - p0.0) / 6)) \(r2(p1.1 + (p2.1 - p0.1) / 6))"
        d += " \(r2(p2.0 - (p3.0 - p1.0) / 6)) \(r2(p2.1 - (p3.1 - p1.1) / 6))"
        d += " \(r2(p2.0)) \(r2(p2.1))"
    }
    return d + "Z"
}

private extension Path {
    init?(svgPath: String) {
        var path = Path()
        let tokens = svgPath.replacingOccurrences(of: ",", with: " ")
            .replacingOccurrences(of: "M", with: " M ")
            .replacingOccurrences(of: "C", with: " C ")
            .replacingOccurrences(of: "Z", with: " Z ")
            .split(whereSeparator: { $0.isWhitespace })
            .map(String.init)
        var index = 0
        var current = CGPoint.zero
        while index < tokens.count {
            let command = tokens[index]
            index += 1
            switch command {
            case "M":
                guard index + 1 < tokens.count,
                      let x = Double(tokens[index]),
                      let y = Double(tokens[index + 1]) else { return nil }
                current = CGPoint(x: x, y: y)
                path.move(to: current)
                index += 2
            case "C":
                guard index + 5 < tokens.count,
                      let x1 = Double(tokens[index]),
                      let y1 = Double(tokens[index + 1]),
                      let x2 = Double(tokens[index + 2]),
                      let y2 = Double(tokens[index + 3]),
                      let x = Double(tokens[index + 4]),
                      let y = Double(tokens[index + 5]) else { return nil }
                let end = CGPoint(x: x, y: y)
                path.addCurve(
                    to: end,
                    control1: CGPoint(x: x1, y: y1),
                    control2: CGPoint(x: x2, y: y2)
                )
                current = end
                index += 6
            case "Z":
                path.closeSubpath()
            default:
                return nil
            }
        }
        self = path
    }
}

private extension Color {
    init(blobatarHex: String) {
        let raw = Int(blobatarHex.dropFirst(), radix: 16) ?? 0
        self.init(
            red: Double((raw >> 16) & 255) / 255,
            green: Double((raw >> 8) & 255) / 255,
            blue: Double(raw & 255) / 255
        )
    }
}

extension YishuDelegatedTaskPresenceEvent {
    var blobatarName: String {
        YishuBlobatar.seed(taskID: id)
    }

    var blobatarExpression: YishuBlobatar.Expression {
        YishuBlobatar.expression(for: status)
    }

    var blobatarAnimates: Bool {
        YishuBlobatar.animates(for: status)
    }
}
