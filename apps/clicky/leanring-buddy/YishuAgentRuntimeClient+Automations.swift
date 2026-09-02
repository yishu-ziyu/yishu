import Foundation

struct YishuAutomationRun: Equatable {
    let id: String
    let trigger: String
    let startedAt: Date
    let finishedAt: Date?
    let status: String
    let detail: String?
    let event: String?
}

struct YishuAutomationRecord: Equatable, Identifiable {
    let id: String
    let name: String
    let prompt: String
    let schedule: String
    let triggerDescription: String
    let isEnabled: Bool
    let createdAt: Date
    let lastRunAt: Date?
    let nextRunAt: Date?
    let runs: [YishuAutomationRun]
}

enum YishuAutomationTriggerInput {
    case cron(schedule: String)
    case appTransition(app: String, transition: String)
    case fileChange(path: String)
    case systemResume
}

struct YishuAutomationRunFinishedEvent {
    let automationId: String
    let automationName: String
    let status: String
    let summary: String?
}

struct PendingAutomationRequest {
    let continuation: CheckedContinuation<Any, Error>
    var timeoutTask: Task<Void, Never>?
}

private struct YishuAutomationTriggerWire: Encodable {
    let type: String
    let schedule: String?
    let app: String?
    let transition: String?
    let path: String?

    init(_ input: YishuAutomationTriggerInput) {
        switch input {
        case .cron(let schedule):
            type = "cron"
            self.schedule = schedule
            app = nil
            transition = nil
            path = nil
        case .appTransition(let app, let transition):
            type = "app_transition"
            schedule = nil
            self.app = app
            self.transition = transition
            path = nil
        case .fileChange(let path):
            type = "file_change"
            schedule = nil
            app = nil
            transition = nil
            self.path = path
        case .systemResume:
            type = "system_resume"
            schedule = nil
            app = nil
            transition = nil
            path = nil
        }
    }
}

private struct YishuAutomationListCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: [String: String]
}

private struct YishuAutomationCreatePayload: Encodable {
    let name: String
    let prompt: String
    let trigger: YishuAutomationTriggerWire
}

private struct YishuAutomationCreateCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuAutomationCreatePayload
}

private struct YishuAutomationSetEnabledPayload: Encodable {
    let automationId: String
    let isEnabled: Bool
}

private struct YishuAutomationSetEnabledCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuAutomationSetEnabledPayload
}

private struct YishuAutomationIdPayload: Encodable {
    let automationId: String
}

private struct YishuAutomationIdCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuAutomationIdPayload
}

extension YishuAgentRuntimeClient {
    func listAutomations() async throws -> [YishuAutomationRecord] {
        let requestId = UUID()
        let result: Any = try await withCheckedThrowingContinuation { continuation in
            let timeoutTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                await MainActor.run {
                    self?.failAutomationRequest(requestId, error: YishuAgentRuntimeClientError.automationTimedOut)
                }
            }
            automationContinuations[requestId] = PendingAutomationRequest(
                continuation: continuation,
                timeoutTask: timeoutTask
            )
            do {
                try send(YishuAutomationListCommand(
                    schemaVersion: yishuRuntimeProtocolVersion,
                    type: "automation.list",
                    requestId: requestId,
                    traceId: UUID(),
                    sentAt: Date(),
                    payload: [:]
                ))
            } catch {
                failAutomationRequest(requestId, error: error)
            }
        }
        guard let records = result as? [YishuAutomationRecord] else {
            throw YishuAgentRuntimeClientError.invalidAutomationEvent
        }
        return records
    }

    func createAutomation(name: String, prompt: String, trigger: YishuAutomationTriggerInput) throws {
        try send(YishuAutomationCreateCommand(
            schemaVersion: yishuRuntimeProtocolVersion,
            type: "automation.create",
            requestId: UUID(),
            traceId: UUID(),
            sentAt: Date(),
            payload: YishuAutomationCreatePayload(
                name: name,
                prompt: prompt,
                trigger: YishuAutomationTriggerWire(trigger)
            )
        ))
    }

    func setAutomationEnabled(_ automationId: String, isEnabled: Bool) throws {
        try send(YishuAutomationSetEnabledCommand(
            schemaVersion: yishuRuntimeProtocolVersion,
            type: "automation.setEnabled",
            requestId: UUID(),
            traceId: UUID(),
            sentAt: Date(),
            payload: YishuAutomationSetEnabledPayload(automationId: automationId, isEnabled: isEnabled)
        ))
    }

    func runAutomationNow(_ automationId: String) throws {
        try send(YishuAutomationIdCommand(
            schemaVersion: yishuRuntimeProtocolVersion,
            type: "automation.runNow",
            requestId: UUID(),
            traceId: UUID(),
            sentAt: Date(),
            payload: YishuAutomationIdPayload(automationId: automationId)
        ))
    }

    func deleteAutomation(_ automationId: String) throws {
        try send(YishuAutomationIdCommand(
            schemaVersion: yishuRuntimeProtocolVersion,
            type: "automation.delete",
            requestId: UUID(),
            traceId: UUID(),
            sentAt: Date(),
            payload: YishuAutomationIdPayload(automationId: automationId)
        ))
    }

    /// Returns true when the event was consumed by the automation surface.
    func handleAutomationEvent(type: String, requestId: UUID?, payload: [String: Any]) -> Bool {
        switch type {
        case "automation.listed":
            guard let requestId else { return true }
            finishAutomationRequest(requestId, value: Self.decodeAutomationRecords(payload["automations"]))
            return true
        case "automation.mutated":
            onAutomationsChanged?()
            return true
        case "automation.run.finished":
            onAutomationRunFinished?(YishuAutomationRunFinishedEvent(
                automationId: payload["automationId"] as? String ?? "",
                automationName: payload["automationName"] as? String ?? "例程",
                status: payload["status"] as? String ?? "error",
                summary: payload["summary"] as? String
            ))
            onAutomationsChanged?()
            return true
        case "automation.failed":
            if let requestId, automationContinuations[requestId] != nil {
                let message = payload["message"] as? String ?? "例程操作失败。"
                failAutomationRequest(requestId, error: YishuAgentRuntimeClientError.automationFailed(message))
            }
            return true
        default:
            return false
        }
    }

    func finishAutomationRequest(_ requestId: UUID, value: Any) {
        guard let pending = automationContinuations.removeValue(forKey: requestId) else { return }
        pending.timeoutTask?.cancel()
        pending.continuation.resume(returning: value)
    }

    func failAutomationRequest(_ requestId: UUID, error: Error) {
        guard let pending = automationContinuations.removeValue(forKey: requestId) else { return }
        pending.timeoutTask?.cancel()
        pending.continuation.resume(throwing: error)
    }

    static func decodeAutomationRecords(_ value: Any?) -> [YishuAutomationRecord] {
        guard let rows = value as? [[String: Any]] else { return [] }
        return rows.compactMap { row in
            guard let id = row["id"] as? String,
                  let name = row["name"] as? String,
                  let prompt = row["prompt"] as? String else { return nil }
            let runs = (row["runs"] as? [[String: Any]] ?? []).compactMap { runRow -> YishuAutomationRun? in
                guard let runId = runRow["id"] as? String,
                      let startedAtMs = runRow["startedAt"] as? Double else { return nil }
                return YishuAutomationRun(
                    id: runId,
                    trigger: runRow["trigger"] as? String ?? "schedule",
                    startedAt: Date(timeIntervalSince1970: startedAtMs / 1000),
                    finishedAt: (runRow["finishedAt"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) },
                    status: runRow["status"] as? String ?? "ok",
                    detail: runRow["detail"] as? String,
                    event: runRow["event"] as? String
                )
            }
            return YishuAutomationRecord(
                id: id,
                name: name,
                prompt: prompt,
                schedule: row["schedule"] as? String ?? "",
                triggerDescription: row["triggerDescription"] as? String ?? "",
                isEnabled: row["isEnabled"] as? Bool ?? true,
                createdAt: (row["createdAt"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) } ?? Date(),
                lastRunAt: (row["lastRunAt"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) },
                nextRunAt: (row["nextRunAt"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) },
                runs: runs
            )
        }
    }
}
