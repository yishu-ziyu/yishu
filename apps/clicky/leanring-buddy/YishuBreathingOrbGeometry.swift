// Geometry adapted from thinking-orbs by Jakub Antalik.
// Copyright (c) 2026 Jakub Antalik. Licensed under the MIT License.
// https://github.com/Jakubantalik/thinking-orbs
// Faithful Swift port of thinking-orbs 0.3.1 20 px engine presets.

import CoreGraphics
import Foundation

struct YishuBreathingOrbDot: Equatable {
    let x: Double
    let y: Double
    let z: Double
    let radius: Double
    let white: Double
    let alpha: Double
}

struct YishuBreathingOrbLine: Equatable {
    let x1: Double
    let y1: Double
    let x2: Double
    let y2: Double
    let white: Double
    let alpha: Double
    let width: Double
}

struct YishuBreathingOrbFrame: Equatable {
    let dots: [YishuBreathingOrbDot]
    let lines: [YishuBreathingOrbLine]
}

enum YishuBreathingOrbState: String, CaseIterable {
    case working
    case searching
    case solving
    case listening
    case connecting
    case weaving
    case composing
    case breathing
    case shaping
}

private struct OrbOptions {
    var latRings: Int?
    var lonDensity: Int?
    var rings: Int?
    var lanes: Int?
    var segs: Int?
    var orbitN: Int?
    var ghostN: Int?
    var nodeN: Int?
    var strandN: Int?
    var signals: Int?
    var iconD: Double?
    var rBase: Double?
    var rDepth: Double?
    var rActive: Double?
    var rDot: Double?
    var ghostR: Double?
    var ghostA: Double?
    var partR: Double?
    var partRDepth: Double?
    var nodeR: Double?
    var nodeRDepth: Double?
    var particles: Int?
    var turns: Double?
    var thr: Double?
    var lineW: Double?
    var rsPow: Double?
    var rMin: Double?
    var rBoost: Double?
    var inkFar: Double?
    var inkSpan: Double?
    var moveCount: Int?
    var faceOn: Bool = false
    var spin: Double?
    var bandMul: Double?
    var wobMul: Double?
    var spread: Double?
    var scanMul: Double?
    var dimBase: Double?
}

private enum OrbMode { case orbits, globe, rubik, wave, web, braid, ribbon, ring, morph }

private struct OrbPreset { let mode: OrbMode; let speed: Double; let options: OrbOptions }

enum YishuBreathingOrbGeometry {
    static let liveSpeed = 3.78
    static let reducedMotionTime = 0.6

    static func frame(state: YishuBreathingOrbState = .breathing, size: Double = 20, time: Double) -> YishuBreathingOrbFrame {
        let preset = resolvePreset(state)
        switch preset.mode {
        case .orbits: return orbits(size, time, preset.options)
        case .globe: return globe(size, time, preset.options)
        case .rubik: return rubik(size, time, preset.options)
        case .wave: return wave(size, time, preset.options)
        case .web: return web(size, time, preset.options)
        case .braid: return braid(size, time, preset.options)
        case .ribbon, .ring: return ribbon(size, time, preset.options)
        case .morph: return morph(size, time, preset.options)
        }
    }

    static func frame(size: Double = 20, time: Double) -> [YishuBreathingOrbDot] {
        frame(state: .breathing, size: size, time: time).dots
    }

    static func dots(size: Double = 20, time: Double) -> [YishuBreathingOrbDot] {
        frame(state: .breathing, size: size, time: time).dots
    }

    static func speed(for state: YishuBreathingOrbState) -> Double { resolvePreset(state).speed }

    private static func finalize(_ dots: [YishuBreathingOrbDot], _ lines: [YishuBreathingOrbLine], rMin: Double? = nil) -> YishuBreathingOrbFrame {
        var indexedDots: [(Int, YishuBreathingOrbDot)] = []
        indexedDots.reserveCapacity(dots.count)
        for (index, dot) in dots.enumerated() {
            if dot.alpha >= 0.02 {
                indexedDots.append((index, YishuBreathingOrbDot(x: dot.x, y: dot.y, z: dot.z, radius: max(rMin ?? 0.3, dot.radius), white: dot.white, alpha: dot.alpha)))
            }
        }
        return YishuBreathingOrbFrame(
            dots: indexedDots.sorted { lhs, rhs in
                if lhs.1.z == rhs.1.z { return lhs.0 < rhs.0 }
                return lhs.1.z < rhs.1.z
            }.map(\.1),
            lines: lines.filter { $0.alpha >= 0.02 }
        )
    }

    private static func resolvePreset(_ state: YishuBreathingOrbState) -> OrbPreset {
        switch state {
        case .working: return .init(mode: .orbits, speed: 3.9, options: scaledCountSize(baseOrbits(), count: 0.238, size: 2.4))
        case .searching:
            var o = scaledCountSize(baseGlobe(), count: 0.105, size: 1.75); o.scanMul = 4.335; o.dimBase = 0.45
            return .init(mode: .globe, speed: 2.665, options: o)
        case .solving: return .init(mode: .rubik, speed: 1.95, options: scaledCountSize(baseRubik(), count: 0.088, size: 1.9))
        case .listening: return .init(mode: .wave, speed: 3.998, options: scaledCountSize(baseWave(), count: 0.105, size: 1.6))
        case .connecting: return .init(mode: .web, speed: 6.63, options: scaledCountSize(baseWeb(), count: 0.25, size: 1.52))
        case .weaving: return .init(mode: .braid, speed: 2.75, options: scaledCountSize(baseBraid(), count: 0.1125, size: 1.36))
        case .composing:
            var o = scaledCountSize(baseRibbon(), count: 0.051, size: 1.073); o.spin = 0; o.bandMul = 4.94; o.wobMul = 1
            return .init(mode: .ribbon, speed: 3.12, options: o)
        case .breathing:
            var o = scaledCountSize(baseRing(), count: 0.028, size: 1.622); o.spin = 0; o.bandMul = 3.968; o.wobMul = 0.565
            return .init(mode: .ring, speed: 3.78, options: o)
        case .shaping:
            var o = scaledCountSize(baseMorph(), count: 0.53, size: 1.011); o.spread = 1.45
            return .init(mode: .morph, speed: 2.08, options: o)
        }
    }

    private static func scaledCountSize(_ base: OrbOptions, count: Double, size: Double) -> OrbOptions { scaleSize(scaleCount(base, count), size) }
    private static func radiusScale(_ n: Double, _ s: Double) -> Double { pow(n / 300, s) }
    private static func fract(_ n: Double) -> Double { n - floor(n) }
    private static func rand(_ n: Double, _ s: Double) -> Double { fract(sin(n * 12.9898 + s * 78.233) * 43758.5453) }
    private static func noise(_ n: Double, _ s: Double) -> Double {
        let t = floor(n), r = floor(s)
        var a = n - t, o = s - r
        a = a * a * (3 - 2 * a); o = o * o * (3 - 2 * o)
        let c = rand(t, r), m = rand(t + 1, r), h = rand(t, r + 1), mm = rand(t + 1, r + 1)
        return c + (m - c) * a + (h - c) * o + (c - m - h + mm) * a * o
    }
    private static func fibonacci(_ n: Int, _ s: Int) -> (Double, Double, Double) {
        let t = Double.pi * (3 - sqrt(5)), r = 1 - 2 * (Double(n) + 0.5) / Double(s), a = sqrt(1 - r * r), o = Double(n) * t
        return (a * cos(o), r, a * sin(o))
    }
    private static func angleDelta(_ n: Double, _ s: Double) -> Double { atan2(sin(n - s), cos(n - s)) }
    private static func smooth(_ n: Double) -> Double { n * n * (3 - 2 * n) }
    private static func proj(_ yaw: Double, _ tilt: Double, _ cx: Double, _ cy: Double, _ scale: Double) -> (Double, Double, Double) -> (Double, Double, Double) {
        let o = sin(tilt), c = cos(tilt), m = sin(yaw), h = cos(yaw)
        return { x, y, z in
            let e = x * h + z * m, l = -x * m + z * h, r = y * c - l * o, w = y * o + l * c
            return (cx + e * scale, cy - r * scale, w)
        }
    }

    private static func scaleCount(_ input: OrbOptions, _ s: Double) -> OrbOptions {
        var t = input; let a = sqrt(s)
        func pair(_ kp1: WritableKeyPath<OrbOptions, Int?>, _ kp2: WritableKeyPath<OrbOptions, Int?>) {
            if let x = t[keyPath: kp1], let y = t[keyPath: kp2] { t[keyPath: kp1] = max(2, Int(round(Double(x) * a))); t[keyPath: kp2] = max(2, Int(round(Double(y) * a))) }
        }
        pair(\.latRings, \.lonDensity); pair(\.rings, \.lonDensity); pair(\.lanes, \.segs)
        for kp in [\.orbitN, \.ghostN, \.nodeN, \.strandN, \.signals] as [WritableKeyPath<OrbOptions, Int?>] {
            if let x = t[keyPath: kp], x != 0 { t[keyPath: kp] = max(1, Int(round(Double(x) * s))) }
        }
        if let x = t.iconD { t.iconD = max(0.02, x * s) }
        return t
    }
    private static func scaleSize(_ input: OrbOptions, _ s: Double) -> OrbOptions {
        var t = input
        for kp in [\.rBase, \.rDepth, \.rActive, \.rDot, \.ghostR, \.partR, \.partRDepth, \.nodeR, \.nodeRDepth] as [WritableKeyPath<OrbOptions, Double?>] {
            if let x = t[keyPath: kp] { t[keyPath: kp] = x * s }
        }
        return t
    }


    private static func dot(_ x: Double, _ y: Double, _ z: Double, _ radius: Double, _ white: Double, _ alpha: Double = 1) -> YishuBreathingOrbDot { .init(x: x, y: y, z: z, radius: radius, white: white, alpha: alpha) }

    private static func globe(_ n: Double, _ s: Double, _ t: OrbOptions) -> YishuBreathingOrbFrame {
        let a=n/2,o=n/2,c=n/2*0.82, tilt=0.4+0.06*sin(s*0.35), h=proj(s*0.5,tilt,a,o,c), scan=s*(0.5+(1.7-0.5)*(t.scanMul ?? 1)), rs=radiusScale(n,t.rsPow ?? 0.6), dim=t.dimBase ?? 1
        var dots:[YishuBreathingOrbDot]=[]; let lat=t.latRings ?? 17, lon=t.lonDensity ?? 44
        for w in 0...lat { let i = -Double.pi/2 + Double(w)/Double(lat)*Double.pi, u=cos(i), y=sin(i), b=max(1,Int(round(abs(u)*Double(lon)))); for f in 0..<b { let p=Double(f)/Double(b)*2*Double.pi; let (x,g,d)=h(u*cos(p),y,u*sin(p)); let v=(d+1)/2; let k=angleDelta(p+s*0.5,scan); let boost=exp(-(k*k)/0.18)*max(0,d); dots.append(dot(x,g,d,((t.rBase ?? 0.6)+(t.rDepth ?? 1.7)*v+(t.rBoost ?? 1)*boost)*rs,(t.inkFar ?? 0.62)-(t.inkSpan ?? 0.54)*v,dim+(1-dim)*min(1,boost))) } }
        return finalize(dots, [], rMin: t.rMin)
    }

    private static func moveProgress(_ n: Double, _ s: Int, _ step: Double, _ pause: Double) -> ([Double], Int) { let a=2*Double(s)*step+pause, o=n.truncatingRemainder(dividingBy:a); var c=Array(repeating:0.0,count:s); var active = -1; if o < 2*Double(s)*step { let h=Int(floor(o/step)), m=(o-Double(h)*step)/step, p=1-pow(1-min(1,m/0.7),3); if h < s { for e in 0..<h { c[e]=1 }; c[h]=p; active=h } else { let e=2*s-1-h; for l in 0..<e { c[l]=1 }; c[e]=1-p; active=e } }; return (c,active) }
    private struct Move { let axis:Int; let lo:Double; let hi:Double; let ang:Double }
    private static func moves(_ n:Int)->[Move]{ (0..<n).map{ i in Move(axis:min(2,Int(floor(rand(Double(i),2.3)*3))), lo:-1+0.5*Double(min(3,Int(floor(rand(Double(i),5.9)*4)))), hi:-1+0.5*Double(min(3,Int(floor(rand(Double(i),5.9)*4))))+0.5, ang:(rand(Double(i),7.7)<0.5 ? 1:-1)*Double.pi/2) } }
    private static func applyMove(_ p:(Double,Double,Double), _ moves:[Move], _ prog:([Double],Int))->(Double,Double,Double,Bool){ var (r,a,o)=p; var active=false; for (idx,h) in moves.enumerated(){ if prog.0[idx] <= 0 { continue }; let m = h.axis==0 ? r : h.axis==1 ? a : o; if m < h.lo || m >= h.hi { continue }; if idx == prog.1 { active=true }; let d=h.ang*prog.0[idx], c=cos(d), sn=sin(d); if h.axis==0 { let l=a*c-o*sn; o=a*sn+o*c; a=l } else if h.axis==1 { let l=r*c+o*sn; o = -r*sn+o*c; r=l } else { let l=r*c-a*sn; a=r*sn+a*c; r=l } }; return (r,a,o,active) }

    private static func rubik(_ n: Double, _ s: Double, _ t: OrbOptions) -> YishuBreathingOrbFrame { let r=n/2,a=n/2,o=n/2*0.82,c=proj(s*0.55,0.35+0.1*sin(s*0.9),r,a,o), rs=radiusScale(n,t.rsPow ?? 0.6), mv=moves(t.moveCount ?? 14), pr=moveProgress(s,t.moveCount ?? 14,0.42,1.2); var dots:[YishuBreathingOrbDot]=[]; let lat=t.latRings ?? 15, lon=t.lonDensity ?? 40; for rr in 0...lat { let w = -Double.pi/2+Double(rr)/Double(lat)*Double.pi, i=cos(w), u=sin(w), y=max(1,Int(round(abs(i)*Double(lon)))); for b in 0..<y { let f=Double(b)/Double(y)*2*Double.pi, q=applyMove((i*cos(f),u,i*sin(f)),mv,pr), p=c(q.0,q.1,q.2), z=(p.2+1)/2; dots.append(dot(p.0,p.1,p.2,((t.rBase ?? 0.6)+(t.rDepth ?? 1.7)*z+(q.3 ? (t.rActive ?? 0.3):0))*rs,(t.inkFar ?? 0.62)-(t.inkSpan ?? 0.54)*z-(q.3 ? 0.14:0))) } }; return finalize(dots, [], rMin: t.rMin) }

    private static func wave(_ n: Double, _ s: Double, _ t: OrbOptions) -> YishuBreathingOrbFrame { let r=n/2,a=n/2,o=n/2*0.874,c=proj(s*0.18,0.38,r,a,1), rs=radiusScale(n,t.rsPow ?? 0.6); var dots:[YishuBreathingOrbDot]=[]; let rings=t.rings ?? 15, lon=t.lonDensity ?? 40; for p in 0...rings { let e = -Double.pi/2+Double(p)/Double(rings)*Double.pi, l=cos(e), rr=sin(e), w=0.62*sin(s*2.1-Double(p)*0.52)+0.38*sin(s*1.27+Double(p)*0.83), rad=o*(0.88+0.105*w), u=max(1,Int(round(abs(l)*Double(lon)))); for y in 0..<u { let b=Double(y)/Double(u)*2*Double.pi, q=c(l*cos(b)*rad,rr*rad,l*sin(b)*rad), g=(q.2/o+1)/2, d=max(0,w); dots.append(dot(q.0,q.1,q.2,((t.rBase ?? 0.6)+(t.rDepth ?? 1.7)*g)*(1+0.4*d)*rs,0.66-0.56*g-0.1*d)) } }; return finalize(dots, [], rMin: t.rMin) }

    private static func orbits(_ n: Double, _ s: Double, _ t: OrbOptions) -> YishuBreathingOrbFrame { let r=n/2,a=n/2,o=n/2*0.82,c=proj(s*0.12,0.3,r,a,1), rs=radiusScale(n,t.rsPow ?? 0.6); var dots:[YishuBreathingOrbDot]=[]; for e in 0..<(t.orbitN ?? 12) { let l=rand(Double(e),1.7), rr=rand(Double(e),5.2), w=rand(Double(e),8.9), i=o*(0.45+0.52*l), u=l*2*Double.pi, y=acos(2*rr-1), b=sin(y)*cos(u), f=cos(y), p=sin(y)*sin(u); var x = -f, g=b; let d=0.0, v=max(1e-6,sqrt(x*x+g*g)); x/=v; g/=v; let k=f*d-p*g, nn=p*x-b*d, z=b*g-f*x, speed=(0.25+0.55*w)*(w>0.5 ? 1:-1); for bb in 0..<(t.ghostN ?? 40) { let ii=Double(bb)/Double(t.ghostN ?? 40)*2*Double.pi, q=c((x*cos(ii)+k*sin(ii))*i,(g*cos(ii)+nn*sin(ii))*i,(d*cos(ii)+z*sin(ii))*i), dep=(q.2/i+1)/2; dots.append(dot(q.0,q.1,q.2,(t.ghostR ?? 0.9)*rs,0.72,(t.ghostA ?? 0.5)*(0.4+0.6*dep))) }; for bb in 0..<(t.particles ?? 3) { let ii=s*speed+Double(bb)/Double(t.particles ?? 3)*2*Double.pi+rr*6, q=c((x*cos(ii)+k*sin(ii))*i,(g*cos(ii)+nn*sin(ii))*i,(d*cos(ii)+z*sin(ii))*i), dep=(q.2/i+1)/2; dots.append(dot(q.0,q.1,q.2,((t.partR ?? 1.2)+(t.partRDepth ?? 1.6)*dep)*rs,0.3-0.22*dep)) } }; return finalize(dots, [], rMin: t.rMin) }

    private static func ribbon(_ n: Double, _ s: Double, _ t: OrbOptions) -> YishuBreathingOrbFrame { let r=n/2,a=n/2,o=n/2*0.78, spin=t.spin ?? 1, tilt=0.3, h=proj(s*0.1*spin,tilt,r,a,1), rs=radiusScale(n,t.rsPow ?? 0.6); var dots:[YishuBreathingOrbDot]=[]; for z in 0..<(t.ghostN ?? 150) { let f=fibonacci(z,t.ghostN ?? 150), q=h(f.0*o,f.1*o,f.2*o), dep=(q.2/o+1)/2; dots.append(dot(q.0,q.1,q.2,0.8*rs,0.78,0.1+0.22*dep)) }; let e=s*0.24*spin, l=t.faceOn ? -tilt : 0.55+0.3*sin(s*0.18)*spin, rr=cos(e), w=0.0, i=sin(e), u = -i*sin(l), y=cos(l), b=rr*sin(l), f=w*b-i*y, p=i*u-rr*b, x=rr*y-w*u, wob=0.23*(t.wobMul ?? 1), d=t.faceOn ? o/(1+0.85*wob):o, lanes=t.lanes ?? 5, segs=t.segs ?? 88, bands=max(1,Int(round(Double(lanes)*(t.bandMul ?? 1)))); for z in 0..<bands { let off=(Double(z)-Double(bands-1)/2)*0.075, edge=abs(Double(z)-Double(bands-1)/2)/max(1,Double(bands-1)/2); for ii in 0..<segs { let ang=Double(ii)/Double(segs)*2*Double.pi, wobble=(0.16*sin(ang*3-s*1.7+Double(z)*0.22)+0.07*sin(ang*5+s*1.1))*(t.wobMul ?? 1), radMul=t.faceOn ? 1+wobble:1, laneOff=t.faceOn ? off:off+wobble, qx=rr*cos(ang)+u*sin(ang)+f*laneOff, qy=w*cos(ang)+y*sin(ang)+p*laneOff, qz=i*cos(ang)+b*sin(ang)+x*laneOff, len=sqrt(qx*qx+qy*qy+qz*qz), q=h(qx/len*d*radMul,qy/len*d*radMul,qz/len*d*radMul), dep=(q.2/o+1)/2; dots.append(dot(q.0,q.1,q.2,((t.rBase ?? 1.1)+(t.rDepth ?? 1.7)*dep)*(1-0.25*edge)*rs,0.52-0.44*dep+0.18*edge,0.4+0.6*dep)) } }; return finalize(dots, [], rMin: t.rMin) }

    private static func braid(_ n: Double, _ s: Double, _ t: OrbOptions) -> YishuBreathingOrbFrame { let r=n/2,a=n/2,o=n/2*0.76,c=proj(s*0.4,0.3,r,a,1), rs=radiusScale(n,t.rsPow ?? 0.6); var dots:[YishuBreathingOrbDot]=[]; for e in 0..<(t.ghostN ?? 150) { let f=fibonacci(e,t.ghostN ?? 150), q=c(f.0*o,f.1*o,f.2*o), u=(q.2/o+1)/2; dots.append(dot(q.0,q.1,q.2,0.8*rs,0.78,0.1+0.22*u)) }; let strand=t.strandN ?? 52, turns=t.turns ?? 3; for e in 0..<3 { let l=Double(e)/3*2*Double.pi; for rr in 0..<strand { let w=(fract(Double(rr)/Double(strand)+s*0.045)*2-1)*0.96, i=sqrt(max(0,1-w*w)), u=min(1,(1-abs(w))/0.1), y=w*Double.pi*turns+l, b=1+0.075*sin(w*Double.pi*turns*2+l*2+s*0.8), f=i*o*b, q=c(cos(y)*f,w*o*b,sin(y)*f), dep=(q.2/o+1)/2; dots.append(dot(q.0,q.1,q.2,((t.rBase ?? 1.2)+(t.rDepth ?? 1.8)*dep)*rs,0.55-0.45*dep,u*(0.45+0.55*dep))) } }; return finalize(dots, [], rMin: t.rMin) }

    private static func web(_ n: Double, _ s: Double, _ t: OrbOptions) -> YishuBreathingOrbFrame { let r=n/2,a=n/2,o=n/2*0.8*(t.spread ?? 1), c=proj(s*0.12,0.32,r,a,o), rs=radiusScale(n,t.rsPow ?? 0.6), node=t.nodeN ?? 30, thr=t.thr ?? 0.72, nr=t.nodeR ?? 1.4, nd=t.nodeRDepth ?? 1.8; var pts:[(Double,Double,Double)]=[]; for i in 0..<node { let u=fibonacci(i,node), y=u.0+0.3*(noise(Double(i)*0.31+9,s*0.24)-0.5)*2, b=u.1+0.3*(noise(Double(i)*0.53+27,s*0.21)-0.5)*2, f=u.2+0.3*(noise(Double(i)*0.77+55,s*0.27)-0.5)*2, len=sqrt(y*y+b*b+f*f); pts.append((y/len,b/len,f/len)) }; var lines:[YishuBreathingOrbLine]=[], dots:[YishuBreathingOrbDot]=[]; for i in 0..<node { for u in (i+1)..<node { let dx=pts[i].0-pts[u].0, dy=pts[i].1-pts[u].1, dz=pts[i].2-pts[u].2, dist=sqrt(dx*dx+dy*dy+dz*dz); if dist >= thr { continue }; let p1=c(pts[i].0,pts[i].1,pts[i].2), p2=c(pts[u].0,pts[u].1,pts[u].2), z=((p1.2+p2.2)/2+1)/2; lines.append(.init(x1:p1.0,y1:p1.1,x2:p2.0,y2:p2.1,white:0.42,alpha:(1-dist/thr)*(0.3+0.55*z),width:max(0.6,(t.lineW ?? 0.8)*rs))) } }; for i in 0..<node { let p=c(pts[i].0,pts[i].1,pts[i].2), f=(p.2+1)/2, pulse=1+0.25*sin(s*1.4+Double(i)*2.7); dots.append(dot(p.0,p.1,p.2,(nr+nd*f)*pulse*rs,0.55-0.45*f)) }; for i in 0..<(t.signals ?? 5) { let u=floor(s*0.55+Double(i)*7.31), y=Int(floor(rand(u,Double(i)*3.1+1.7)*Double(node))), b=Int(floor(rand(u,Double(i)*5.7+4.2)*Double(node))); if y==b { continue }; let f=fract(s*0.55+Double(i)*7.31), px=pts[y].0+(pts[b].0-pts[y].0)*f, py=pts[y].1+(pts[b].1-pts[y].1)*f, pz=pts[y].2+(pts[b].2-pts[y].2)*f, len=max(1e-6,sqrt(px*px+py*py+pz*pz)), p=c(px/len,py/len,pz/len), z=(p.2+1)/2; dots.append(dot(p.0,p.1,p.2,(nr*1.5+nd*z)*rs,0.05,0.5+0.5*z)) }; return finalize(dots, lines, rMin: t.rMin) }

    private static func pathSampler(_ points:[(Double,Double)]) -> (Double)->(Double,Double) { var lengths:[Double]=[]; var total=0.0; for i in points.indices { let a=points[i], b=points[(i+1)%points.count], l=hypot(b.0-a.0,b.1-a.1); lengths.append(l); total += l }; return { v in var o=v*total; var c=0; while o > lengths[c] && c < points.count-1 { o -= lengths[c]; c += 1 }; let a=points[c], b=points[(c+1)%points.count], m=lengths[c] > 0 ? min(1,o/lengths[c]):0; return (a.0+(b.0-a.0)*m,a.1+(b.1-a.1)*m) } }
    private static func icon(_ idx:Int, _ n:Double)->(Double,Double){ if idx==0 { let s = -Double.pi/2+n*2*Double.pi; return (cos(s)*0.24,sin(s)*0.24) }; if idx==1 { return pathSampler([(0,-0.26),(0.24,0.16),(-0.24,0.16)])(n) }; return pathSampler([(0,-0.2),(0.2,-0.2),(0.2,0.2),(-0.2,0.2),(-0.2,-0.2)])(n) }
    private static func morph(_ n: Double, _ s: Double, _ t: OrbOptions) -> YishuBreathingOrbFrame { let shapeCount=3, hold=1.4, trans=0.9, cycle=hold+trans, a=s.truncatingRemainder(dividingBy:cycle*Double(shapeCount)), idx=Int(floor(a/cycle)), c=a-Double(idx)*cycle, mix=c > hold ? smooth((c-hold)/trans):0, spread=t.spread ?? 1, samples=160; var e:[(Double,Double)]=[]; for x in 0..<samples { let g=Double(x)/Double(samples), d=icon(idx,g), v=icon((idx+1)%shapeCount,g); e.append(((d.0+(v.0-d.0)*mix)*spread,(d.1+(v.1-d.1)*mix)*spread)) }; var lengths:[Double]=[]; var total=0.0; for x in 0..<samples { let g=e[x], d=e[(x+1)%samples], l=hypot(d.0-g.0,d.1-g.1); lengths.append(l); total += l }; let count=max(6,Int(round(34*(t.iconD ?? 1)))), rad=(t.rDot ?? 0.021)*1.35*spread, pulse=1+0.02*sin(c*3.1), center=n/2; var dots:[YishuBreathingOrbDot]=[]; var f=0; var acc=0.0; for x in 0..<count { let g=Double(x)/Double(count)*total; while acc+lengths[f] < g && f < samples-1 { acc += lengths[f]; f += 1 }; let d=e[f], v=e[(f+1)%samples], k=lengths[f] > 0 ? min(1,(g-acc)/lengths[f]):0, px=(d.0+(v.0-d.0)*k)*pulse, py=(d.1+(v.1-d.1)*k)*pulse; dots.append(dot(center+px*n, center+py*n, 0, max(0.35,rad*n), 0.1)) }; return finalize(dots, [], rMin: t.rMin) }


    private static func baseGlobe() -> OrbOptions { OrbOptions(latRings: 17, lonDensity: 44, rBase: 0.6, rDepth: 1.7, rsPow: 0.6, rMin: 0.3, rBoost: 1, inkFar: 0.62, inkSpan: 0.54) }
    private static func baseOrbits() -> OrbOptions { OrbOptions(orbitN: 12, ghostN: 40, ghostR: 0.9, ghostA: 0.5, partR: 1.2, partRDepth: 1.6, particles: 3, rsPow: 0.6, rMin: 0.3) }
    private static func baseRubik() -> OrbOptions { OrbOptions(latRings: 15, lonDensity: 40, rBase: 0.6, rDepth: 1.7, rActive: 0.3, rsPow: 0.6, rMin: 0.3, inkFar: 0.62, inkSpan: 0.54, moveCount: 14) }
    private static func baseWave() -> OrbOptions { OrbOptions(lonDensity: 40, rings: 15, rBase: 0.6, rDepth: 1.7, rsPow: 0.6, rMin: 0.3) }
    private static func baseWeb() -> OrbOptions { OrbOptions(nodeN: 30, signals: 5, nodeR: 1.4, nodeRDepth: 1.8, thr: 0.72, lineW: 0.8, rsPow: 0.6, rMin: 0.3) }
    private static func baseBraid() -> OrbOptions { OrbOptions(ghostN: 150, strandN: 52, rBase: 1.2, rDepth: 1.8, turns: 3, rsPow: 0.6, rMin: 0.3) }
    private static func baseRibbon() -> OrbOptions { OrbOptions(lanes: 5, segs: 88, ghostN: 150, rBase: 1.1, rDepth: 1.7, rsPow: 0.6, rMin: 0.3) }
    private static func baseRing() -> OrbOptions { OrbOptions(lanes: 5, segs: 88, ghostN: 0, rBase: 1.1, rDepth: 1.7, rsPow: 0.6, rMin: 0.3, faceOn: true) }
    private static func baseMorph() -> OrbOptions { OrbOptions(iconD: 1, rDot: 0.021, rMin: 0.25) }
}
