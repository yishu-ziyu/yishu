import CoreGraphics
import Foundation

@MainActor
final class GlobalPushToTalkMonitor {
    var onPress: (() -> Void)?
    var onRelease: (() -> Void)?

    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var isPressed = false

    func startIfAuthorized() -> Bool {
        guard CGPreflightListenEventAccess() else { return false }
        return installEventTap()
    }

    func requestPermissionAndStart() -> Bool {
        if !CGPreflightListenEventAccess() {
            _ = CGRequestListenEventAccess()
        }
        guard CGPreflightListenEventAccess() else { return false }
        return installEventTap()
    }

    private func installEventTap() -> Bool {
        guard eventTap == nil else { return true }
        let mask = CGEventMask(1) << CGEventType.flagsChanged.rawValue
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: { _, type, event, userInfo in
                guard let userInfo else { return Unmanaged.passUnretained(event) }
                let monitor = Unmanaged<GlobalPushToTalkMonitor>
                    .fromOpaque(userInfo)
                    .takeUnretainedValue()

                if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                    Task { @MainActor in monitor.enableEventTap() }
                    return Unmanaged.passUnretained(event)
                }

                let rawFlags = event.flags.rawValue
                Task { @MainActor in monitor.handle(rawFlags: rawFlags) }
                return Unmanaged.passUnretained(event)
            },
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            return false
        }

        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        eventTap = tap
        runLoopSource = source
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        return true
    }

    func stop() {
        if let source = runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
        }
        if let tap = eventTap {
            CGEvent.tapEnable(tap: tap, enable: false)
        }
        runLoopSource = nil
        eventTap = nil
        if isPressed {
            isPressed = false
            onRelease?()
        }
    }

    private func handle(rawFlags: UInt64) {
        let flags = CGEventFlags(rawValue: rawFlags)
        let pressed = flags.contains(.maskControl) && flags.contains(.maskAlternate)
        guard pressed != isPressed else { return }
        isPressed = pressed
        if pressed {
            onPress?()
        } else {
            onRelease?()
        }
    }

    private func enableEventTap() {
        guard let eventTap else { return }
        CGEvent.tapEnable(tap: eventTap, enable: true)
    }
}
