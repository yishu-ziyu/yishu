//
//  leanring_buddyApp.swift
//  leanring-buddy
//
//  Menu bar-only companion app. No dock icon, no main window — just an
//  always-available status item in the macOS status bar. Clicking the icon
//  opens a floating panel with companion voice controls.
//

import Darwin
import ServiceManagement
import SwiftUI
import UserNotifications

@main
struct leanring_buddyApp: App {
    @NSApplicationDelegateAdaptor(CompanionAppDelegate.self) var appDelegate

    var body: some Scene {
        // The app lives entirely in the menu bar panel managed by the AppDelegate.
        // This empty Settings scene satisfies SwiftUI's requirement for at least
        // one scene but is never shown (LSUIElement=true removes the app menu).
        Settings {
            EmptyView()
        }
    }
}

/// Manages the companion lifecycle: creates the menu bar panel and starts
/// the companion voice pipeline on launch.
@MainActor
final class CompanionAppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private var menuBarPanelManager: MenuBarPanelManager?
    private let companionManager = CompanionManager()
    private let singleInstance = YishuSingleInstanceLock()

    func applicationWillFinishLaunching(_ notification: Notification) {
        if CommandLine.arguments.contains("--migrate-model-config") {
            guard CommandLine.arguments.contains("--confirm") else {
                fputs("Refusing to migrate without explicit confirmation.\n", stderr)
                Darwin.exit(2)
            }
            do {
                try YishuModelConfigMigration.migrateDefaultConfiguration()
                fputs("Model credential migration completed; no credential values were printed.\n", stdout)
                Darwin.exit(0)
            } catch {
                fputs("Model credential migration failed; the original config was preserved.\n", stderr)
                Darwin.exit(1)
            }
        }
        guard !YishuVoiceProxySupervisor.shouldSkipRealProxyLifecycle else { return }
        guard singleInstance.acquire() else {
            let bundleID = Bundle.main.bundleIdentifier ?? "com.clicky-app.leanring-buddy"
            NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
                .first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier })?
                .activate(options: [.activateIgnoringOtherApps])
            NSApp.terminate(nil)
            return
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard singleInstance.isAcquired else { return }
        print("🎯 奕枢: Starting...")
        print("🎯 奕枢: Version \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown")")

        UserDefaults.standard.register(defaults: ["NSInitialToolTipDelay": 0])

        ClickyAnalytics.configure()
        ClickyAnalytics.trackAppOpened()
        UNUserNotificationCenter.current().delegate = self

        menuBarPanelManager = MenuBarPanelManager(companionManager: companionManager)
        companionManager.start()
        // Auto-open when intro has not been shown, or permissions were revoked.
        // Activation is a later gate and must not force the first-run panel.
        if YishuActivationPolicy.shouldOpenPanelOnLaunch(
            introSeen: companionManager.hasSeenIntro,
            permissionsGranted: companionManager.allPermissionsGranted
        ) {
            menuBarPanelManager?.showPanelOnLaunch()
        }
        registerAsLoginItemIfNeeded()
    }

    func applicationWillTerminate(_ notification: Notification) {
        companionManager.stop()
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
        let content = notification.request.content
        guard content.userInfo["kind"] as? String == "yishu_time_reminder",
              let identifier = content.userInfo["reminderId"] as? String,
              identifier == notification.request.identifier else {
            return
        }
        Task { @MainActor [weak self] in
            self?.companionManager.enqueueTimeReminderReturn(
                identifier: identifier,
                body: content.body
            )
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        // Opening an old banner is never a reason to speak it again.
        completionHandler()
    }

    /// Registers the app as a login item so it launches automatically on
    /// startup. Uses SMAppService which shows the app in System Settings >
    /// General > Login Items, letting the user toggle it off if they want.
    private func registerAsLoginItemIfNeeded() {
        let loginItemService = SMAppService.mainApp
        let defaults = UserDefaults.standard
        let requestMarker = "YishuDidRequestLoginItemRegistration"
        switch loginItemService.status {
        case .enabled, .requiresApproval:
            // The request reached macOS. Persist that fact so a later user
            // disable remains authoritative instead of being silently undone.
            defaults.set(true, forKey: requestMarker)
            return
        case .notRegistered:
            guard defaults.bool(forKey: requestMarker) == false else { return }
            do {
                try loginItemService.register()
                // Mark only a successful request. A failure stays retryable.
                defaults.set(true, forKey: requestMarker)
                print("🎯 奕枢: Registered as login item")
            } catch {
                print("⚠️ 奕枢: Failed to register as login item: \(error)")
            }
        case .notFound:
            return
        @unknown default:
            return
        }
    }
}

private final class YishuSingleInstanceLock {
    private var descriptor: Int32 = -1

    var isAcquired: Bool { descriptor >= 0 }

    func acquire() -> Bool {
        if isAcquired { return true }
        let fileManager = FileManager.default
        let support = fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? URL(fileURLWithPath: NSTemporaryDirectory())
        let directory = support.appendingPathComponent("Yishu", isDirectory: true)
        do {
            try fileManager.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
        } catch {
            return false
        }
        try? fileManager.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: directory.path
        )
        let lockURL = directory.appendingPathComponent("clicky-instance.lock")
        let fd = lockURL.path.withCString {
            Darwin.open($0, O_CREAT | O_RDWR | O_CLOEXEC, S_IRUSR | S_IWUSR)
        }
        guard fd >= 0 else { return false }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            Darwin.close(fd)
            return false
        }
        descriptor = fd
        return true
    }

    deinit {
        if descriptor >= 0 {
            _ = flock(descriptor, LOCK_UN)
            Darwin.close(descriptor)
        }
    }
}
