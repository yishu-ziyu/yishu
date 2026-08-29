import Foundation

enum OnboardingMilestone: String, Codable, CaseIterable {
    case introSeen
    case inputCompleted
    case screenUnderstood
    case guidanceShown
    case verifiedActionCompleted
    case memoryReviewed
    case completed
}

struct OnboardingProgress: Codable {
    var milestone: OnboardingMilestone
    var completedAt: Date
    var scenarioId: String?
    var receiptId: String?
    var appVersion: String
}

enum YishuOnboardingStore {
    private static let key = "yishu.onboarding.progress"
    static var testDefaults: UserDefaults?

    private static var defaults: UserDefaults {
        testDefaults ?? .standard
    }

    static var isActivated: Bool {
        load()?.milestone == .verifiedActionCompleted
            || load()?.milestone == .memoryReviewed
            || load()?.milestone == .completed
    }

    static func load() -> OnboardingProgress? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(OnboardingProgress.self, from: data)
    }

    static func record(_ milestone: OnboardingMilestone, scenarioId: String? = nil, receiptId: String? = nil) {
        let progress = OnboardingProgress(
            milestone: milestone,
            completedAt: Date(),
            scenarioId: scenarioId,
            receiptId: receiptId,
            appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown"
        )
        if let data = try? JSONEncoder().encode(progress) {
            defaults.set(data, forKey: key)
        }
        QualityEventRecorder.record(
            name: milestone == .verifiedActionCompleted ? "onboarding.first_verified_action" : "onboarding.step_completed",
            sessionId: "onboarding",
            attributes: ["milestone": milestone.rawValue]
        )
    }
}
