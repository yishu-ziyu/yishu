import Foundation
import Testing
import YishuContext
@testable import Clicky

struct YishuModelRoutingTests {
    @Test func modesKeepStableWireValuesAndProductOrder() {
        #expect(YishuModelRoutingMode.allCases == [
            .auto,
            .realtimeConversation,
            .screenCollaboration,
            .deepTask,
            .fixedModel,
        ])
        #expect(YishuModelRoutingMode.allCases.map(\.rawValue) == [
            "auto",
            "realtime_conversation",
            "screen_collaboration",
            "deep_task",
            "fixed_model",
        ])
        #expect(
            YishuModelRoutingMode.auto.helperText
                == "普通对话和屏幕协作自动切换；深度任务可手动选择。"
        )
    }

    @Test func migrationPrefersValidStoredModeThenFallsBackToLegacyChoice() throws {
        let defaults = try temporaryDefaults()
        let fixed = YishuModelPreference(provider: "openai-codex", model: "gpt-5.6-sol")

        defaults.set(true, forKey: "clicky.chatModel.userPicked.v1")
        defaults.set("screen_collaboration", forKey: YishuModelRoutingDefaults.modeKey)
        #expect(
            YishuModelRoutingSettings.load(from: defaults, fixedPreference: fixed).mode
                == .screenCollaboration
        )

        defaults.removeObject(forKey: YishuModelRoutingDefaults.modeKey)
        #expect(
            YishuModelRoutingSettings.load(from: defaults, fixedPreference: fixed).mode
                == .fixedModel
        )

        defaults.set(false, forKey: "clicky.chatModel.userPicked.v1")
        defaults.removeObject(forKey: YishuModelRoutingDefaults.modeKey)
        #expect(
            YishuModelRoutingSettings.load(from: defaults, fixedPreference: fixed).mode
                == .auto
        )
    }

    @Test func profileAssignmentsDefaultToLegacyChoicePersistAndSurviveModeSwitches() throws {
        let defaults = try temporaryDefaults()
        let fixed = YishuModelPreference(
            provider: YishuConversationModelCatalog.localProvider,
            model: YishuConversationModelCatalog.defaultModel
        )
        var settings = YishuModelRoutingSettings.load(
            from: defaults,
            fixedPreference: fixed
        )

        for profile in YishuModelRoutingProfile.allCases {
            #expect(settings.profiles[profile] == fixed)
        }

        let realtime = YishuModelPreference(provider: "xai", model: "grok-4.5")
        let screen = YishuModelPreference(provider: "openai-codex", model: "gpt-5.6-sol")
        settings.selectMode(.realtimeConversation, in: defaults)
        let assignedRealtime = settings.assign(
            realtime,
            to: .realtimeConversation,
            in: defaults
        )
        #expect(assignedRealtime)
        settings.selectMode(.screenCollaboration, in: defaults)
        let assignedScreen = settings.assign(
            screen,
            to: .screenCollaboration,
            in: defaults
        )
        #expect(assignedScreen)
        settings.selectMode(.auto, in: defaults)

        let reloaded = YishuModelRoutingSettings.load(
            from: defaults,
            fixedPreference: YishuModelPreference(
                provider: YishuConversationModelCatalog.localProvider,
                model: "grok-4.3"
            )
        )
        #expect(reloaded.mode == .auto)
        #expect(reloaded.profiles[.realtimeConversation] == realtime)
        #expect(reloaded.profiles[.screenCollaboration] == screen)
        #expect(reloaded.profiles[.deepTask] == fixed)
    }

    @Test func routingWireKeepsFixedAndProfiledShapesDistinct() throws {
        let fixed = YishuModelPreference(
            provider: YishuConversationModelCatalog.localProvider,
            model: YishuConversationModelCatalog.defaultModel
        )
        let profiles = YishuModelProfileAssignments(
            realtimeConversation: YishuModelPreference(provider: "xai", model: "grok-4.5"),
            screenCollaboration: YishuModelPreference(provider: "openai-codex", model: "gpt-5.6-sol"),
            deepTask: fixed
        )

        let automatic = try jsonObject(YishuModelRouting.profiled(
            mode: .auto,
            profiles: profiles
        ))
        #expect(Set(automatic.keys) == ["mode", "profiles"])
        #expect(automatic["mode"] as? String == "auto")
        let automaticProfiles = try #require(automatic["profiles"] as? [String: Any])
        #expect(Set(automaticProfiles.keys) == [
            "realtimeConversation",
            "screenCollaboration",
            "deepTask",
        ])
        #expect(
            (automaticProfiles["screenCollaboration"] as? [String: Any])?["model"] as? String
                == "gpt-5.6-sol"
        )

        let fixedWire = try jsonObject(YishuModelRouting.fixed(preference: fixed))
        #expect(Set(fixedWire.keys) == ["mode", "preference"])
        #expect(fixedWire["mode"] as? String == "fixed_model")
        #expect(fixedWire["profiles"] == nil)
        #expect((fixedWire["preference"] as? [String: Any])?["model"] as? String == "MiniMax-M3")
    }

    @Test func turnStartPayloadCarriesRoutingAndLegacyFixedFallbackTogether() throws {
        let fixed = YishuModelPreference(
            provider: YishuConversationModelCatalog.localProvider,
            model: YishuConversationModelCatalog.defaultModel
        )
        let profiles = YishuModelProfileAssignments(
            realtimeConversation: YishuModelPreference(provider: "xai", model: "grok-4.5"),
            screenCollaboration: fixed,
            deepTask: YishuModelPreference(provider: "openai-codex", model: "gpt-5.6-sol")
        )
        let payload = YishuTurnStartPayload(
            utterance: "帮我看看这个页面",
            contextFrame: contextFrame(),
            capabilityProfile: "conversation",
            conversationId: UUID(),
            sessionScope: .personal,
            modelPreference: fixed,
            modelRouting: .profiled(mode: .auto, profiles: profiles)
        )

        let raw = try jsonObject(payload)
        #expect((raw["modelPreference"] as? [String: Any])?["model"] as? String == "MiniMax-M3")
        #expect((raw["modelRouting"] as? [String: Any])?["mode"] as? String == "auto")
    }

    @Test @MainActor func turnStartedMetadataIsStrictOptionalAndProjectsOneTruthfulLine() async throws {
        let valid = YishuResolvedModelRoute.decode([
            "routingMode": "auto",
            "resolvedRoute": "screen_collaboration",
            "provider": YishuConversationModelCatalog.localProvider,
            "model": YishuConversationModelCatalog.defaultModel,
        ])
        #expect(valid != nil)
        #expect(
            YishuModelRoutePresentation.line(
                for: valid,
                availableModels: YishuConversationModelCatalog.localModels,
                isProductActionTurn: false
            ) == "自动 · 屏幕协作 · MiniMax M3"
        )
        #expect(YishuModelRoutePresentation.line(
            for: valid,
            availableModels: YishuConversationModelCatalog.localModels,
            isProductActionTurn: true
        ) == nil)
        #expect(YishuResolvedModelRoute.decode([
            "routingMode": "auto",
            "resolvedRoute": "screen_collaboration",
            "provider": YishuConversationModelCatalog.localProvider,
        ]) == nil)

        let client = YishuAgentRuntimeClient()
        let requestID = UUID()
        let traceID = UUID()
        let parked = client.parkTurnForTests(requestId: requestID, traceId: traceID)
        client.dispatchRuntimeEventForTests(runtimeEvent(
            "turn.started",
            requestID: requestID,
            traceID: traceID,
            payload: [
                "generation": 1,
                "routingMode": "auto",
                "resolvedRoute": "screen_collaboration",
                "provider": YishuConversationModelCatalog.localProvider,
                "model": YishuConversationModelCatalog.defaultModel,
            ]
        ))
        client.dispatchRuntimeEventForTests(runtimeEvent(
            "response.completed",
            requestID: requestID,
            traceID: traceID,
            payload: ["generation": 1, "text": "完成", "verified": true]
        ))

        var projected: YishuResolvedModelRoute?
        for try await event in parked.turn.events {
            if case let .started(route, _) = event {
                projected = route
            }
        }
        #expect(projected == valid)
    }

    @Test @MainActor func overlayClearsRoutingMetadataAtEveryNewOrStaticTurn() {
        let manager = CompanionResponseOverlayManager()
        manager.showThinking()
        manager.updateRoutingMetadataText("自动 · 屏幕协作 · MiniMax M3")
        #expect(!manager.viewModel.routingMetadataText.isEmpty)

        manager.showOverlayAndBeginStreaming()
        #expect(manager.viewModel.routingMetadataText.isEmpty)

        manager.updateRoutingMetadataText("固定模型 · MiniMax M3")
        manager.showStaticMessage("已创建提醒", autoHideAfter: 0)
        #expect(manager.viewModel.routingMetadataText.isEmpty)
    }

    private func temporaryDefaults() throws -> UserDefaults {
        let suite = "YishuModelRoutingTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    private func jsonObject<T: Encodable>(_ value: T) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func runtimeEvent(
        _ type: String,
        requestID: UUID,
        traceID: UUID,
        payload: [String: Any]
    ) -> [String: Any] {
        [
            "schemaVersion": 1,
            "type": type,
            "eventId": UUID().uuidString,
            "requestId": requestID.uuidString,
            "traceId": traceID.uuidString,
            "sentAt": "2026-08-30T00:00:00Z",
            "payload": payload,
        ]
    }

    private func contextFrame() -> YishuContextFrame {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let point = YishuScreenPoint(x: 10, y: 20, coordinateSpace: .globalTopLeft)
        return YishuContextFrame(
            capturedAt: now,
            expiresAt: now.addingTimeInterval(15),
            cursor: YishuObservedValue(
                value: point,
                source: "test",
                capturedAt: now,
                confidence: 1
            ),
            pointerTrail: [],
            frontmostApplication: nil,
            activeWindow: nil,
            elementUnderCursor: nil,
            screenshots: [],
            warnings: []
        )
    }
}
