import Foundation

struct YishuWorkspaceGrantItem: Identifiable, Equatable {
    let id: UUID
    let displayName: String
    let capabilities: [String]
    let createdAt: Date
    let trashApproved: Bool
}

struct YishuWorkspaceRevokeResult: Equatable {
    let workspaceId: UUID
    let alreadyGone: Bool
}

struct YishuWorkspaceApproveResult: Equatable {
    let workspaceId: UUID
    let allowed: Bool
}

extension YishuAgentRuntimeClient {
    func grantWorkspace(
        id: UUID,
        displayName: String,
        rootPath: String,
        scope: YishuSessionScope = .personal
    ) async throws -> YishuWorkspaceGrantItem {
        let result = try await awaitPanelResult(
            kind: .workspaceGrant,
            timeout: .workspaceTimedOut
        ) { requestId in
            try send(YishuWorkspaceGrantCommand(
                schemaVersion: yishuRuntimeProtocolVersion,
                type: "workspace.grant",
                requestId: requestId,
                traceId: UUID(),
                sentAt: Date(),
                payload: YishuWorkspaceGrantPayload(
                    workspaceId: id,
                    displayName: displayName,
                    rootPath: rootPath,
                    sessionScope: scope
                )
            ))
        }
        guard let item = result as? YishuWorkspaceGrantItem else {
            throw YishuAgentRuntimeClientError.invalidWorkspaceEvent
        }
        return item
    }

    func revokeWorkspace(
        id: UUID,
        scope: YishuSessionScope = .personal
    ) async throws -> YishuWorkspaceRevokeResult {
        let result = try await awaitPanelResult(
            kind: .workspaceRevoke,
            timeout: .workspaceTimedOut
        ) { requestId in
            try send(YishuWorkspaceRevokeCommand(
                schemaVersion: yishuRuntimeProtocolVersion,
                type: "workspace.revoke",
                requestId: requestId,
                traceId: UUID(),
                sentAt: Date(),
                payload: YishuWorkspaceRevokePayload(
                    workspaceId: id,
                    sessionScope: scope
                )
            ))
        }
        guard let revoked = result as? YishuWorkspaceRevokeResult else {
            throw YishuAgentRuntimeClientError.invalidWorkspaceEvent
        }
        return revoked
    }

    func listWorkspaces(
        scope: YishuSessionScope = .personal
    ) async throws -> [YishuWorkspaceGrantItem] {
        let result = try await awaitPanelResult(
            kind: .workspaceList,
            timeout: .workspaceTimedOut
        ) { requestId in
            try send(YishuWorkspaceListCommand(
                schemaVersion: yishuRuntimeProtocolVersion,
                type: "workspace.list",
                requestId: requestId,
                traceId: UUID(),
                sentAt: Date(),
                payload: YishuWorkspaceListPayload(sessionScope: scope)
            ))
        }
        guard let items = result as? [YishuWorkspaceGrantItem] else {
            throw YishuAgentRuntimeClientError.invalidWorkspaceEvent
        }
        return items
    }

    func approveWorkspaceTrash(
        id: UUID,
        allowed: Bool,
        scope: YishuSessionScope = .personal
    ) async throws -> YishuWorkspaceApproveResult {
        let result = try await awaitPanelResult(
            kind: .workspaceApprove,
            timeout: .workspaceTimedOut
        ) { requestId in
            try send(YishuWorkspaceApproveCommand(
                schemaVersion: yishuRuntimeProtocolVersion,
                type: "workspace.approve",
                requestId: requestId,
                traceId: UUID(),
                sentAt: Date(),
                payload: YishuWorkspaceApprovePayload(
                    workspaceId: id,
                    op: "trash",
                    allowed: allowed,
                    sessionScope: scope
                )
            ))
        }
        guard let approved = result as? YishuWorkspaceApproveResult else {
            throw YishuAgentRuntimeClientError.invalidWorkspaceEvent
        }
        return approved
    }

    func consumeWorkspacePanelEvent(
        type: String,
        requestId: UUID?,
        payload: [String: Any]
    ) -> Bool {
        let isWorkspacePanelEvent =
            type == "workspace.granted"
            || type == "workspace.revoked"
            || type == "workspace.listed"
            || type == "workspace.approved"
            || type == "workspace.failed"
        guard isWorkspacePanelEvent, let requestId, historyContinuations[requestId] != nil else {
            return false
        }
        dispatchWorkspaceEvent(type: type, requestId: requestId, payload: payload)
        return true
    }

    func workspaceRuntimeError(from message: String?) -> YishuAgentRuntimeClientError {
        YishuAgentRuntimeClientError.workspaceFailed(
            (message?.isEmpty == false) ? message! : WorkspaceSettingsCopy.failed
        )
    }

    func isWorkspaceHistoryKind(_ kind: PendingHistoryKind) -> Bool {
        kind == .workspaceGrant
            || kind == .workspaceRevoke
            || kind == .workspaceList
            || kind == .workspaceApprove
    }

    func dispatchWorkspaceEvent(type: String, requestId: UUID, payload: [String: Any]) {
        guard let pending = historyContinuations[requestId] else { return }
        switch type {
        case "workspace.granted":
            guard pending.kind == .workspaceGrant else {
                failHistoryRequest(requestId, error: YishuAgentRuntimeClientError.invalidWorkspaceEvent)
                return
            }
            guard let item = Self.decodeWorkspaceItem(payload, idKey: "workspaceId") else {
                failHistoryRequest(requestId, error: YishuAgentRuntimeClientError.invalidWorkspaceEvent)
                return
            }
            finishHistoryRequest(requestId, value: item)
        case "workspace.listed":
            guard pending.kind == .workspaceList else {
                failHistoryRequest(requestId, error: YishuAgentRuntimeClientError.invalidWorkspaceEvent)
                return
            }
            guard let rawItems = payload["items"] as? [[String: Any]] else {
                failHistoryRequest(requestId, error: YishuAgentRuntimeClientError.invalidWorkspaceEvent)
                return
            }
            var items: [YishuWorkspaceGrantItem] = []
            items.reserveCapacity(rawItems.count)
            for raw in rawItems {
                guard let item = Self.decodeWorkspaceItem(raw, idKey: "id") else {
                    failHistoryRequest(requestId, error: YishuAgentRuntimeClientError.invalidWorkspaceEvent)
                    return
                }
                items.append(item)
            }
            finishHistoryRequest(requestId, value: items)
        case "workspace.revoked":
            guard pending.kind == .workspaceRevoke else {
                failHistoryRequest(requestId, error: YishuAgentRuntimeClientError.invalidWorkspaceEvent)
                return
            }
            guard
                let idString = payload["workspaceId"] as? String,
                let workspaceId = UUID(uuidString: idString)
            else {
                failHistoryRequest(requestId, error: YishuAgentRuntimeClientError.invalidWorkspaceEvent)
                return
            }
            finishHistoryRequest(
                requestId,
                value: YishuWorkspaceRevokeResult(
                    workspaceId: workspaceId,
                    alreadyGone: (payload["alreadyGone"] as? Bool) ?? false
                )
            )
        case "workspace.approved":
            guard pending.kind == .workspaceApprove else {
                failHistoryRequest(requestId, error: YishuAgentRuntimeClientError.invalidWorkspaceEvent)
                return
            }
            guard
                let idString = payload["workspaceId"] as? String,
                let workspaceId = UUID(uuidString: idString)
            else {
                failHistoryRequest(requestId, error: YishuAgentRuntimeClientError.invalidWorkspaceEvent)
                return
            }
            finishHistoryRequest(
                requestId,
                value: YishuWorkspaceApproveResult(
                    workspaceId: workspaceId,
                    allowed: (payload["allowed"] as? Bool) ?? true
                )
            )
        case "workspace.failed":
            let message = (payload["message"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            failHistoryRequest(requestId, error: workspaceRuntimeError(from: message))
        default:
            break
        }
    }

    static func decodeWorkspaceItem(
        _ payload: [String: Any],
        idKey: String
    ) -> YishuWorkspaceGrantItem? {
        guard
            let idString = payload[idKey] as? String,
            let id = UUID(uuidString: idString),
            let displayName = payload["displayName"] as? String
        else {
            return nil
        }
        let capabilities = (payload["capabilities"] as? [String]) ?? []
        return YishuWorkspaceGrantItem(
            id: id,
            displayName: String(displayName.prefix(80)),
            capabilities: capabilities,
            createdAt: parseWorkspaceISO8601(payload["createdAt"] as? String) ?? Date(),
            trashApproved: (payload["trashApproved"] as? Bool) ?? false
        )
    }

    private static func parseWorkspaceISO8601(_ value: String?) -> Date? {
        guard let value, !value.isEmpty else { return nil }
        let withFractional = ISO8601DateFormatter()
        withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFractional.date(from: value) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: value)
    }
}

private struct YishuWorkspaceGrantCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuWorkspaceGrantPayload
}

private struct YishuWorkspaceGrantPayload: Encodable {
    let workspaceId: UUID
    let displayName: String
    let rootPath: String
    let sessionScope: YishuSessionScope
}

private struct YishuWorkspaceRevokeCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuWorkspaceRevokePayload
}

private struct YishuWorkspaceRevokePayload: Encodable {
    let workspaceId: UUID
    let sessionScope: YishuSessionScope
}

private struct YishuWorkspaceListCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuWorkspaceListPayload
}

private struct YishuWorkspaceListPayload: Encodable {
    let sessionScope: YishuSessionScope
}

private struct YishuWorkspaceApproveCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuWorkspaceApprovePayload
}

private struct YishuWorkspaceApprovePayload: Encodable {
    let workspaceId: UUID
    let op: String
    let allowed: Bool
    let sessionScope: YishuSessionScope
}
