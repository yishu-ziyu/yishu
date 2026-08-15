import Foundation
import UserNotifications

@MainActor
protocol YishuTimeReminderCenter {
    func authorizationStatus() async -> UNAuthorizationStatus
    func requestAuthorization()
    func add(_ request: UNNotificationRequest) async throws
    func pendingRequests() async -> [YishuPendingTimeReminder]
}

struct YishuPendingTimeReminder: Equatable, Sendable {
    let identifier: String
    let body: String
    let delaySeconds: TimeInterval?
    let repeats: Bool?
}

@MainActor
final class YishuSystemTimeReminderCenter: YishuTimeReminderCenter {
    private let center: UNUserNotificationCenter

    init(center: UNUserNotificationCenter = .current()) {
        self.center = center
    }

    func authorizationStatus() async -> UNAuthorizationStatus {
        await withCheckedContinuation { continuation in
            center.getNotificationSettings { settings in
                continuation.resume(returning: settings.authorizationStatus)
            }
        }
    }

    func requestAuthorization() {
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    func add(_ request: UNNotificationRequest) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            center.add(request) { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
    }

    func pendingRequests() async -> [YishuPendingTimeReminder] {
        await withCheckedContinuation { continuation in
            center.getPendingNotificationRequests { requests in
                continuation.resume(returning: requests.map { request in
                    let trigger = request.trigger as? UNTimeIntervalNotificationTrigger
                    return YishuPendingTimeReminder(
                        identifier: request.identifier,
                        body: request.content.body,
                        delaySeconds: trigger?.timeInterval,
                        repeats: trigger?.repeats
                    )
                })
            }
        }
    }
}

enum YishuTimeReminderScheduleOutcome: Equatable, Sendable {
    case verified
    case permissionPending
    case permissionDenied
    case failedBeforeSubmission
    case unknownAfterSubmission
}

struct YishuTimeReminderReturnState: Equatable {
    struct Reminder: Equatable {
        let identifier: String
        let body: String
    }

    private(set) var pending: [Reminder] = []
    private var announcedIdentifiers: [String] = []
    private var announcedIdentifierSet: Set<String> = []

    mutating func enqueue(identifier: String, body: String) -> Bool {
        guard !identifier.isEmpty,
              !announcedIdentifierSet.contains(identifier),
              !pending.contains(where: { $0.identifier == identifier }) else {
            return false
        }
        announcedIdentifierSet.insert(identifier)
        announcedIdentifiers.append(identifier)
        if announcedIdentifiers.count > 256 {
            announcedIdentifierSet.remove(announcedIdentifiers.removeFirst())
        }
        pending.append(Reminder(identifier: identifier, body: body))
        return true
    }

    mutating func takeNext() -> Reminder? {
        guard !pending.isEmpty else { return nil }
        return pending.removeFirst()
    }

    mutating func clearPending() {
        pending.removeAll()
    }
}

/// macOS owns the clock. This type only asks it to hold one notification and
/// reads the same pending request back before claiming success.
@MainActor
enum YishuTimeReminderDelivery {
    static func schedule(
        reminderId: String,
        body: String,
        delaySeconds: Int,
        authorizationFence: YishuComputerUseActuator.AuthorizationFence,
        center providedCenter: YishuTimeReminderCenter? = nil
    ) async -> YishuTimeReminderScheduleOutcome {
        let center = providedCenter ?? YishuSystemTimeReminderCenter()
        let authorization = await center.authorizationStatus()
        switch authorization {
        case .notDetermined:
            center.requestAuthorization()
            return .permissionPending
        case .denied:
            return .permissionDenied
        case .authorized, .provisional, .ephemeral:
            break
        @unknown default:
            return .permissionDenied
        }

        let existing = await center.pendingRequests().first { $0.identifier == reminderId }
        if let existing {
            return isExact(existing, body: body, delaySeconds: delaySeconds)
                ? .verified
                : .unknownAfterSubmission
        }

        guard authorizationFence() else { return .failedBeforeSubmission }
        let content = UNMutableNotificationContent()
        content.body = body
        content.sound = .default
        content.userInfo = [
            "kind": "yishu_time_reminder",
            "reminderId": reminderId,
        ]
        let trigger = UNTimeIntervalNotificationTrigger(
            timeInterval: TimeInterval(delaySeconds),
            repeats: false
        )
        let request = UNNotificationRequest(identifier: reminderId, content: content, trigger: trigger)
        do {
            try await center.add(request)
        } catch {
            return .failedBeforeSubmission
        }

        let readBack = await center.pendingRequests().first { $0.identifier == reminderId }
        guard let readBack else { return .unknownAfterSubmission }
        return isExact(readBack, body: body, delaySeconds: delaySeconds)
            ? .verified
            : .unknownAfterSubmission
    }

    static func clockLabel(
        delaySeconds: Int,
        now: Date = Date(),
        timeZone: TimeZone = .current
    ) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.timeZone = timeZone
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: now.addingTimeInterval(TimeInterval(delaySeconds)))
    }

    static func isMacClockLabel(_ value: String) -> Bool {
        value.range(of: #"^\d{2}:\d{2}$"#, options: .regularExpression) != nil
    }

    private static func isExact(
        _ request: YishuPendingTimeReminder,
        body: String,
        delaySeconds: Int
    ) -> Bool {
        request.body == body
            && request.delaySeconds == TimeInterval(delaySeconds)
            && request.repeats == false
    }
}
