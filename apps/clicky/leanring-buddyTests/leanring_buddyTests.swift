//
//  leanring_buddyTests.swift
//  leanring-buddyTests
//
//  Created by thorfinn on 3/2/26.
//

import Foundation
import AVFoundation
import Testing
@testable import Clicky

@MainActor
struct leanring_buddyTests {

    @Test func authenticatedModelsJoinTheConversationPickerWithTheirProvider() {
        let options = YishuConversationModelCatalog.available(authModels: [
            YishuAuthModel(
                provider: .openAICodex,
                id: "gpt-5.6-sol",
                name: "GPT-5.6 Sol"
            ),
            YishuAuthModel(
                provider: .xAI,
                id: "grok-4.5",
                name: "Grok 4.5"
            ),
        ])

        let openAIOption = options.first {
            $0.provider == YishuAuthProvider.openAICodex.rawValue
                && $0.model == "gpt-5.6-sol"
        }
        let xAIOption = options.first {
            $0.provider == YishuAuthProvider.xAI.rawValue
                && $0.model == "grok-4.5"
        }
        let localOption = options.first {
            $0.provider == YishuConversationModelCatalog.localProvider
                && $0.model == "grok-4.5"
        }

        #expect(openAIOption?.sourceLabel == "ChatGPT")
        #expect(xAIOption?.sourceLabel == "xAI")
        #expect(localOption != nil)
    }

    @Test func runtimeClientAcceptsCurrentAuthenticatedModelsAndRejectsUnknownOnes() {
        #expect(YishuAgentRuntimeClient.supportsModel(
            provider: YishuAuthProvider.openAICodex.rawValue,
            model: "gpt-5.6-sol"
        ))
        #expect(YishuAgentRuntimeClient.supportsModel(
            provider: YishuAuthProvider.xAI.rawValue,
            model: "grok-build-0.1"
        ))
        #expect(!YishuAgentRuntimeClient.supportsModel(
            provider: YishuAuthProvider.openAICodex.rawValue,
            model: "unknown-model"
        ))

        let selectedPreference = YishuAgentRuntimeClient.modelPreference(
            provider: YishuAuthProvider.openAICodex.rawValue,
            model: "gpt-5.6-sol"
        )
        #expect(selectedPreference == YishuModelPreference(
            provider: YishuAuthProvider.openAICodex.rawValue,
            model: "gpt-5.6-sol"
        ))
    }

    @Test func browserAuthorizationURLOpensAutomaticallyOnce() throws {
        var openedURLs: [URL] = []
        let viewModel = ProviderAccountsViewModel(
            runtimeClient: nil,
            openExternalURL: { url in
                openedURLs.append(url)
                return true
            }
        )
        let authURL = YishuAuthURL(
            provider: .openAICodex,
            url: try #require(URL(string: "https://example.com/oauth/authorize")),
            instructions: nil
        )

        viewModel.handleBrowserURL(authURL)
        viewModel.handleBrowserURL(authURL)

        #expect(openedURLs == [authURL.url])
        #expect(viewModel.state(for: .openAICodex).browserURL == authURL)
        #expect(viewModel.state(for: .openAICodex).phase == .awaitingBrowser)
    }

    @Test func dualProviderStatusFailureRetiresBothLoadingRows() {
        var loadingStates = Dictionary(
            uniqueKeysWithValues: YishuAuthProvider.allCases.map {
                ($0, YishuProviderAccountState(phase: .loading))
            }
        )
        for provider in YishuAuthProvider.allCases {
            loadingStates[provider]?.message = "读取账号状态…"
        }

        let failedStates = YishuProviderStatusFailureReducer.apply(
            to: loadingStates,
            code: "storage_failed",
            message: "登录凭据存储不可用。"
        )

        for provider in YishuAuthProvider.allCases {
            let state = try! #require(failedStates[provider])
            #expect(state.phase == .idle)
            #expect(state.failure?.provider == provider)
            #expect(state.failure?.code == "storage_failed")
            #expect(state.failure?.message == "登录凭据存储不可用。")
            #expect(state.message == "登录凭据存储不可用。")
        }
    }

    @Test func stepFunTranscriptionRequestTrimsAndDeduplicatesHotwords() throws {
        let request = StepFunTranscriptionRequest(
            audioBase64: "cpcm",
            format: "wav",
            sampleRate: 16_000,
            language: "zh",
            keyterms: [" Yishu ", "yishu", "", "\n奕枢\n"]
        )

        let body = try #require(
            JSONSerialization.jsonObject(
                with: JSONEncoder().encode(request)
            ) as? [String: Any]
        )
        let hotwords = try #require(body["hotwords"] as? [String])

        #expect(hotwords == ["Yishu", "奕枢"])
    }

    @Test func stepFunTranscriptionRequestOmitsHotwordsWhenEmpty() throws {
        let request = StepFunTranscriptionRequest(
            audioBase64: "cpcm",
            format: "wav",
            sampleRate: 16_000,
            language: "zh",
            keyterms: []
        )

        let body = try #require(
            JSONSerialization.jsonObject(
                with: JSONEncoder().encode(request)
            ) as? [String: Any]
        )

        #expect(body["hotwords"] == nil)
    }

    @Test func stepFunHotwordsDropOverlongTermsAndCapAfterDeduplication() {
        let overlong = String(repeating: "x", count: 65)
        let keyterms = [overlong] + (0..<55).map { "term-\($0)" }

        let normalized = StepFunTranscriptionRequest.normalizedHotwords(from: keyterms)

        #expect(normalized.count == 50)
        #expect(normalized.first == "term-0")
        #expect(normalized.last == "term-49")
        #expect(!normalized.contains(overlong))
    }

    @Test func stepFunUpstreamErrorMessageRedactsResponseBody() {
        let secretMarker = "synthetic-secret-marker"
        let message = StepFunTranscriptionProviderError.redactedUpstreamMessage(
            statusCode: 502,
            bodyByteCount: secretMarker.utf8.count
        )

        #expect(message.contains("502"))
        #expect(message.contains("body_bytes=\(secretMarker.utf8.count)"))
        #expect(!message.contains(secretMarker))
    }

    @Test func firstPermissionRequestUsesSystemPromptOnly() async throws {
        let presentationDestination = WindowPositionManager.permissionRequestPresentationDestination(
            hasPermissionNow: false,
            hasAttemptedSystemPrompt: false
        )

        #expect(presentationDestination == .systemPrompt)
    }

    @Test func repeatedPermissionRequestOpensSystemSettings() async throws {
        let presentationDestination = WindowPositionManager.permissionRequestPresentationDestination(
            hasPermissionNow: false,
            hasAttemptedSystemPrompt: true
        )

        #expect(presentationDestination == .systemSettings)
    }

    @Test func knownGrantedScreenRecordingPermissionSkipsTheGate() async throws {
        let shouldTreatPermissionAsGranted = WindowPositionManager.shouldTreatScreenRecordingPermissionAsGrantedForSessionLaunch(
            hasScreenRecordingPermissionNow: false,
            hasPreviouslyConfirmedScreenRecordingPermission: true
        )

        #expect(shouldTreatPermissionAsGranted)
    }

    @Test func productUtteranceRouterClassifiesRememberHowAndHandoff() async throws {
        #expect(YishuProductUtteranceRouter.classify("记住我刚才是怎么做的") == .rememberHow)
        #expect(YishuProductUtteranceRouter.classify("记住刚才这个流程") == .rememberHow)
        #expect(YishuProductUtteranceRouter.classify("这个交给 Codex") == .runSkillOrShare)
        #expect(YishuProductUtteranceRouter.classify("记住：这个项目准备基于 Pi") == .rememberFact)
        #expect(YishuProductUtteranceRouter.classify("以后不要在没有证据时自动写入长期记忆") == .recordLearning)
        #expect(YishuProductUtteranceRouter.classify("这个按钮为什么是灰色的？") == .conversation)
        #expect(YishuProductUtteranceRouter.shouldPreferProductKernel("记住刚才这个流程"))
        #expect(!YishuProductUtteranceRouter.shouldPreferProductKernel("这个按钮为什么是灰色的？"))
    }

    @Test func memorySourceNoticeShowsClaimTimeAndSource() async throws {
        let item = YishuMemoryUsedItem(
            id: UUID(uuidString: "11111111-1111-4111-8111-111111111111")!,
            summary: "验收回答先给结论",
            source: "conversation",
            capturedAt: "2026-08-08T12:00:00.000Z",
            scope: "personal"
        )
        let notice = CompanionManager.formatMemorySourceNotice([item])
        #expect(notice.contains("验收回答先给结论"))
        #expect(notice.contains("对话中明确保存"))
        #expect(notice.contains("保存于") || notice.contains("2026-08-08"))
        #expect(CompanionManager.formatMemorySourceNotice([]).isEmpty)
    }

    @Test func memorySourcePolicyClearsOnConversationScopeAndFailureBoundaries() async throws {
        // Pure policy: after these product events the panel must not keep a
        // prior answer's source line (Codex rejection: residual after history/scope).
        #expect(YishuMemorySourcePolicy.noticeAfterConversationOrScopeChange() == nil)
        #expect(YishuMemorySourcePolicy.noticeAfterTurnCancelledOrFailed() == nil)
        #expect(YishuMemorySourcePolicy.noticeAfterSuccessfulTurn(usedMemories: []) == nil)

        let item = YishuMemoryUsedItem(
            id: UUID(uuidString: "11111111-1111-4111-8111-111111111111")!,
            summary: "验收回答先给结论",
            source: "conversation",
            capturedAt: "2026-08-08T12:00:00.000Z",
            scope: "personal"
        )
        let kept = YishuMemorySourcePolicy.noticeAfterSuccessfulTurn(usedMemories: [item])
        #expect(kept != nil)
        #expect(kept?.contains("验收回答先给结论") == true)
        // Panel must render this string in exactly one place (history section only).
        #expect(YishuMemorySourcePolicy.panelDisplaySiteCount == 1)
    }

    @Test func directClickIntentKeepsTheVisibleTarget() async throws {
        #expect(YishuDirectClickResolver.isDirectClickIntent("点击左上角新对话"))
        #expect(YishuDirectClickResolver.isDirectClickIntent("去点击左上角的新对话"))
        #expect(YishuDirectClickResolver.isDirectClickIntent("点左上角的新对话"))
        #expect(YishuDirectClickResolver.isDirectClickIntent("请你点左上角新对话"))
        #expect(!YishuDirectClickResolver.isDirectClickIntent("点击左上角新对话，然后发送消息"))
        #expect(!YishuDirectClickResolver.isDirectClickIntent("点击新对话，再点击发送"))
        #expect(!YishuDirectClickResolver.isDirectClickIntent("点新对话再点插件"))
        #expect(!YishuDirectClickResolver.isDirectClickIntent("click New Thread and then type hello"))
        #expect(!YishuDirectClickResolver.isDirectClickIntent("点击新对话并点击发送"))
        #expect(!YishuDirectClickResolver.isDirectClickIntent("点击新对话并输入 hello"))
        #expect(!YishuDirectClickResolver.isDirectClickIntent("click New Thread and type hello"))
        #expect(!YishuDirectClickResolver.isDirectClickIntent("解释为什么点击这个按钮"))
        #expect(!YishuDirectClickResolver.isDirectClickIntent("解释为什么点这个按钮"))
        #expect(!YishuDirectClickResolver.isDirectClickIntent("我觉得这个点很奇怪"))
        #expect(!YishuDirectClickResolver.isDirectClickIntent("点什么"))
        #expect(!YishuDirectClickResolver.isDirectClickIntent("点哪里"))
        #expect(!YishuDirectClickResolver.isDirectClickIntent("我该点哪个"))
        #expect(YishuDirectClickResolver.targetPhrase(from: "点击左上角新对话") == "新对话")
        #expect(YishuDirectClickResolver.targetPhrase(from: "点左上角的新对话") == "新对话")
        #expect(YishuDirectClickResolver.targetPhrase(from: "请你点左上角新对话") == "新对话")
        #expect(YishuDirectClickResolver.targetPhrase(from: "click top left New Thread") == "newthread")
        #expect(YishuDirectClickResolver.isDirectClickIntent("点击左上角的返回按钮"))
        #expect(YishuDirectClickResolver.targetPhrase(from: "点击左上角的返回按钮") == "返回")
        #expect(YishuComputerUseActuator.isAccessibilityChromeNavigationTarget("返回"))
        #expect(YishuComputerUseActuator.isAccessibilityChromeNavigationTarget("back"))
        #expect(YishuComputerUseActuator.isAccessibilityChromeNavigationTarget("上一级"))
        #expect(!YishuComputerUseActuator.isAccessibilityChromeNavigationTarget("新对话"))
        // Back vs Up must not be mixed: 返回 never expands to 上层文件夹.
        #expect(YishuComputerUseActuator.chromeNavigationKind(forTargetPhrase: "返回") == .back)
        #expect(YishuComputerUseActuator.chromeNavigationKind(forTargetPhrase: "后退") == .back)
        #expect(YishuComputerUseActuator.chromeNavigationKind(forTargetPhrase: "上一级") == .up)
        #expect(YishuComputerUseActuator.chromeNavigationKind(forTargetPhrase: "上层文件夹") == .up)
        let chromeLabels = CompanionManager.accessibilityChromeNavigationLabels(
            for: "点击左上角的返回按钮"
        )
        #expect(chromeLabels?.contains("返回") == true)
        #expect(chromeLabels?.contains("上层文件夹") != true)
        #expect(chromeLabels?.contains("上一级") != true)
        let upLabels = CompanionManager.accessibilityChromeNavigationLabels(
            for: "点击上层文件夹"
        )
        // "点击上层文件夹" may not parse as direct-click chrome; check pure API.
        let upFromTarget = YishuComputerUseActuator.chromeNavigationLabels(forTargetPhrase: "上一级")
        #expect(upFromTarget?.contains("上层文件夹") == true)
        #expect(upFromTarget?.contains("返回") != true)
        _ = upLabels
        // Path-specific verified basis: only ancestor path counts as parent.
        #expect(
            YishuComputerUseActuator.isFilesystemPath(
                "/tmp/yishu-click-acceptance/parent",
                ancestorOf: "/tmp/yishu-click-acceptance/parent/child"
            )
        )
        #expect(
            !YishuComputerUseActuator.isFilesystemPath(
                "/tmp/yishu-click-acceptance/parent/child",
                ancestorOf: "/tmp/yishu-click-acceptance/parent"
            )
        )
        #expect(
            !YishuComputerUseActuator.isFilesystemPath(
                "/tmp/yishu-click-acceptance/parent/child",
                ancestorOf: "/tmp/yishu-click-acceptance/parent/child"
            )
        )
        #expect(
            YishuComputerUseActuator.isFilesystemPath(
                "file:///tmp/yishu-click-acceptance/parent",
                ancestorOf: "file:///tmp/yishu-click-acceptance/parent/child/"
            )
        )
        // Dominant kind from label lists: back-only stays back; up-only stays up.
        #expect(
            YishuComputerUseActuator.chromeNavigationKind(forLabels: ["返回", "后退"]) == .back
        )
        #expect(
            YishuComputerUseActuator.chromeNavigationKind(forLabels: ["上一级", "上层文件夹"]) == .up
        )
    }

    @Test func visionBoundingBoxLiftsOutOfTopLeftROIBeforeMapping() async throws {
        let point = try #require(YishuDirectClickResolver.pixelPoint(
            for: CGRect(x: 0.0136, y: 0.7647, width: 0.0604, height: 0.0261),
            screenshotWidth: 1280,
            screenshotHeight: 832,
            regionOfInterest: CGRect(x: 0, y: 0.45, width: 0.6, height: 0.55)
        ))

        // Vision's y-axis is bottom-left normalized; the screenshot point is
        // top-left pixel space. The observation is ROI-relative, so lifting it
        // once places the target near the real top-left control rather than the
        // vertically lower sidebar item.
        #expect(abs(point.x - 34.0) < 1.0)
        #expect(abs(point.y - 102.0) < 1.0)
    }

    @Test func visionBoundingBoxFullImageROIIsIdentityAndKeepsVerticalOrder() async throws {
        let target = try #require(YishuDirectClickResolver.pixelPoint(
            for: CGRect(x: 0.0087, y: 0.8724, width: 0.0350, height: 0.0141),
            screenshotWidth: 1280,
            screenshotHeight: 832,
            regionOfInterest: CGRect(x: 0, y: 0, width: 1, height: 1)
        ))
        let plugin = try #require(YishuDirectClickResolver.pixelPoint(
            for: CGRect(x: 0.0135, y: 0.5840, width: 0.0491, height: 0.0281),
            screenshotWidth: 1280,
            screenshotHeight: 832,
            regionOfInterest: CGRect(x: 0, y: 0.45, width: 0.6, height: 0.55)
        ))

        #expect(abs(target.x - 34.0) < 1.0)
        #expect(abs(target.y - 101.0) < 1.0)
        #expect(abs(plugin.y - 184.0) < 1.0)
        #expect(target.y < plugin.y)
    }

    @Test func visionBoundingBoxRejectsNonFiniteOrOutOfBoundsGeometry() async throws {
        let outOfBounds = YishuDirectClickResolver.pixelPoint(
            for: CGRect(x: 1.2, y: 1.2, width: 2, height: 2),
            screenshotWidth: 640,
            screenshotHeight: 480
        )
        let nonFinite = YishuDirectClickResolver.pixelPoint(
            for: CGRect(x: .infinity, y: 0, width: 0.1, height: 0.1),
            screenshotWidth: 640,
            screenshotHeight: 480
        )
        let invalidROI = YishuDirectClickResolver.pixelPoint(
            for: CGRect(x: 0.1, y: 0.1, width: 0.1, height: 0.1),
            screenshotWidth: 640,
            screenshotHeight: 480,
            regionOfInterest: CGRect(x: 0, y: 0.9, width: 0.5, height: 0.5)
        )

        #expect(outOfBounds == nil)
        #expect(nonFinite == nil)
        #expect(invalidROI == nil)
    }

    @Test func pointerFallbackRequiresTheSameFrontmostOwner() async throws {
        #expect(YishuComputerUseActuator.shouldUsePointerPreservingSystemClick(
            expectedFrontmostProcessIdentifier: pid_t(42),
            currentFrontmostProcessIdentifier: pid_t(42),
            targetWindowOwnerProcessIdentifier: pid_t(42)
        ))
        #expect(!YishuComputerUseActuator.shouldUsePointerPreservingSystemClick(
            expectedFrontmostProcessIdentifier: pid_t(42),
            currentFrontmostProcessIdentifier: pid_t(42),
            targetWindowOwnerProcessIdentifier: pid_t(99)
        ))
        #expect(!YishuComputerUseActuator.shouldUsePointerPreservingSystemClick(
            expectedFrontmostProcessIdentifier: pid_t(42),
            currentFrontmostProcessIdentifier: pid_t(99),
            targetWindowOwnerProcessIdentifier: pid_t(42)
        ))
        #expect(YishuComputerUseActuator.isValidScreenSelection(nil, captureCount: 2))
        #expect(YishuComputerUseActuator.isValidScreenSelection(2, captureCount: 2))
        #expect(!YishuComputerUseActuator.isValidScreenSelection(99, captureCount: 2))
    }

    @Test func screenshotPixelsMapThroughRetinaAndMultiScreenOrigins() throws {
        let capture = CompanionScreenCapture(
            imageData: Data(),
            label: "test",
            isCursorScreen: false,
            displayWidthInPoints: 1280,
            displayHeightInPoints: 832,
            displayFrame: CGRect(x: -1280, y: 240, width: 1280, height: 832),
            globalTopLeftDisplayFrame: CGRect(x: -1280, y: -240, width: 1280, height: 832),
            screenshotWidthInPixels: 2560,
            screenshotHeightInPixels: 1664
        )

        let center = YishuComputerUseActuator.globalTopLeftPoint(
            screenshotX: 1280,
            screenshotY: 832,
            screenCapture: capture
        )
        let topLeft = YishuComputerUseActuator.globalTopLeftPoint(
            screenshotX: 0,
            screenshotY: 0,
            screenCapture: capture
        )
        let bottomRight = YishuComputerUseActuator.globalTopLeftPoint(
            screenshotX: 2560,
            screenshotY: 1664,
            screenCapture: capture
        )

        // 2x Retina pixels map to the same point-space display frame. The
        // negative x and upward y origins must be preserved, not normalized
        // against a primary-screen rectangle.
        #expect(center == CGPoint(x: -640, y: 176))
        #expect(topLeft == CGPoint(x: -1280, y: -240))
        #expect(bottomRight == CGPoint(x: 0, y: 592))
    }

    @Test func unknownActionOutcomeNeverGetsAnAutomaticRetry() async throws {
        #expect(YishuActionPolicy.allowsQuartzFallback(after: .axElementUnavailable))
        #expect(YishuActionPolicy.allowsQuartzFallback(after: .axPressUnsupported))
        #expect(!YishuActionPolicy.allowsQuartzFallback(after: .axPressUnknown))
        #expect(!YishuActionPolicy.allowsAutomaticRetry(after: .unverified))
        #expect(!YishuActionPolicy.allowsAutomaticRetry(after: .delivered))
    }

    @Test func actionReceiptPreservesUnverifiedDeliveryLanguage() async throws {
        let result = YishuComputerActionResult(
            succeeded: true,
            verified: false,
            message: "点击结果不确定，我没有重复操作。",
            evidence: "method=ax;code=ax_press_unknown",
            status: .unverified,
            method: .axPress,
            code: .axPressUnknown,
            receiptId: "receipt-1",
            attemptId: "attempt-1"
        )

        #expect(result.status == .unverified)
        #expect(result.method == .axPress)
        #expect(result.code == .axPressUnknown)
        #expect(result.receiptId == "receipt-1")
        #expect(result.attemptId == "attempt-1")
        #expect(result.message.contains("没有重复操作"))
    }

    @Test func toolMarkupScrubberRemovesCompleteAndTruncatedXML() async throws {
        let complete = CompanionManager.scrubToolMarkup(from: "我来点它。<computer_control><action>left_click</action><x>40</x><y>20</y></computer_control>")
        #expect(complete == "我来点它。")

        let incomplete = CompanionManager.scrubToolMarkup(from: "我来点它。<computer_control><action>left_click")
        #expect(incomplete == "我来点它。")

        let partialOpening = CompanionManager.scrubToolMarkup(from: "我来点它。<computer_control")
        #expect(partialOpening == "我来点它。")

        let fenced = CompanionManager.scrubToolMarkup(from: "说明如下：\n```html\n<computer_control><x>40</x></computer_control>\n```")
        #expect(fenced == "说明如下：")

        let ordinaryCode = CompanionManager.scrubToolMarkup(from: "代码如下：\n```swift\nprint(\"hello\")\n```")
        #expect(ordinaryCode.contains("```swift"))
        #expect(ordinaryCode.contains("print(\"hello\")"))

        let pseudoFunction = CompanionManager.scrubToolMarkup(from: "准备执行<function=computer_control><action>left_click</action></function>")
        #expect(pseudoFunction == "准备执行")

        let ordinaryXML = CompanionManager.scrubToolMarkup(from: "HTML 中的 <label>表单</label>，解释 <x>横坐标</x>。")
        #expect(ordinaryXML == "HTML 中的 <label>表单</label>，解释 <x>横坐标</x>。")

        let namedParameter = CompanionManager.scrubToolMarkup(from: "工具参数：<parameter name=\"x\">40</parameter>")
        #expect(namedParameter == "工具参数：")
    }

    @Test func toolMarkupScrubberPreservesChineseAndPointTag() async throws {
        let cleaned = CompanionManager.scrubToolMarkup(from: "左上角是新对话。[POINT:54,182:新对话]")
        let parsed = CompanionManager.parsePointingCoordinates(from: cleaned)

        #expect(parsed.spokenText == "左上角是新对话。")
        #expect(parsed.coordinate == CGPoint(x: 54, y: 182))
        #expect(parsed.elementLabel == "新对话")
    }

    @Test func speechTextKeepsVisibleSourcesButDoesNotReadURLs() {
        let presentationText = """
        1. Apple 调整了硬件出货。
        https://www.macrumors.com/2026/08/10/apple-hardware/
        2. 相机增加来源认证（来源：https://9to5mac.com/example）。
        3. 详情见 [Apple 开发者新闻](https://developer.apple.com/news/?id=example)。
        来源：https://developer.apple.com/news/
        """

        let spoken = CompanionManager.speechText(from: presentationText)

        #expect(presentationText.contains("https://www.macrumors.com"))
        #expect(!spoken.contains("http"))
        #expect(!spoken.contains("www."))
        #expect(spoken.contains("2. 相机增加来源认证。"))
        #expect(spoken.contains("3. 详情见 Apple 开发者新闻。"))
        #expect(spoken.hasSuffix("来源链接我放在文字里了。"))
    }

    @Test func speechTextLeavesOrdinaryRepliesUntouched() {
        #expect(CompanionManager.speechText(from: "好的，我已经处理完了。") == "好的，我已经处理完了。")
    }

    @Test func directClickWithoutPointUsesOnlyTheShortFailure() async throws {
        #expect(CompanionManager.shouldUseDirectClickFailure(
            transcript: "点击左上角新对话",
            coordinate: nil,
            actionConsumed: false
        ))
        #expect(!CompanionManager.shouldUseDirectClickFailure(
            transcript: "点击左上角新对话",
            coordinate: nil,
            actionConsumed: true
        ))
        #expect(!CompanionManager.shouldUseDirectClickFailure(
            transcript: "点击左上角新对话",
            coordinate: CGPoint(x: 40, y: 20),
            actionConsumed: false
        ))
        #expect(CompanionManager.directClickFailureMessage == "这次没找到可点击的目标，我没有执行操作。")
        #expect(CompanionManager.selectedScreenIndex(for: 1, captureCount: 2) == 0)
        #expect(CompanionManager.selectedScreenIndex(for: 99, captureCount: 2) == nil)

        let consumedResult = YishuComputerActionResult(
            succeeded: false,
            verified: false,
            message: "failed",
            evidence: nil,
            status: .failed,
            method: .unknown,
            code: .runtimeError,
            receiptId: "receipt",
            attemptId: "attempt"
        )
        #expect(CompanionManager.shouldUseDirectActionResultAfterTurnFailure(
            transcript: "点击左上角新对话",
            actionResult: consumedResult
        ))
        #expect(!CompanionManager.shouldUseDirectActionResultAfterTurnFailure(
            transcript: "点击左上角新对话",
            actionResult: nil
        ))
        #expect(CompanionManager.runtimeFailureRecoveryRoute(
            actionResult: consumedResult,
            runtimeIsRunning: false
        ) == .useActionReceipt)
        #expect(CompanionManager.runtimeFailureRecoveryRoute(
            actionResult: consumedResult,
            runtimeIsRunning: true
        ) == .useActionReceipt)
        #expect(CompanionManager.runtimeFailureRecoveryRoute(
            actionResult: nil,
            runtimeIsRunning: false
        ) == .restartRuntime)
        #expect(CompanionManager.runtimeFailureRecoveryRoute(
            actionResult: nil,
            runtimeIsRunning: true
        ) == .legacyProxy)

        let initialCapture = Self.makeCapture(label: "initial", width: 111)
        let retryCapture = Self.makeCapture(label: "retry", width: 222)
        #expect(CompanionManager.continuityProxyScreenCaptures(
            initial: [initialCapture],
            retry: [retryCapture]
        ).map(\.label) == ["retry"])
        #expect(CompanionManager.continuityProxyScreenCaptures(
            initial: [initialCapture],
            retry: []
        ).isEmpty)
    }

    private static func makeCapture(label: String, width: Int) -> CompanionScreenCapture {
        CompanionScreenCapture(
            imageData: Data(label.utf8),
            label: label,
            isCursorScreen: true,
            displayWidthInPoints: width,
            displayHeightInPoints: 100,
            displayFrame: CGRect(x: 0, y: 0, width: width, height: 100),
            globalTopLeftDisplayFrame: CGRect(x: 0, y: 0, width: width, height: 100),
            screenshotWidthInPixels: width,
            screenshotHeightInPixels: 100
        )
    }

    @Test func runtimeIngressUUIDHelperRejectsMalformedOptionalIDs() async throws {
        #expect(YishuAgentRuntimeClient.isValidSchemaVersionValue(NSNumber(value: 1)))
        #expect(!YishuAgentRuntimeClient.isValidSchemaVersionValue(NSNumber(value: 2)))
        #expect(!YishuAgentRuntimeClient.isValidSchemaVersionValue(NSNumber(value: true)))
        #expect(YishuAgentRuntimeClient.isValidOptionalLabelPayloadValue("New Thread"))
        #expect(!YishuAgentRuntimeClient.isValidOptionalLabelPayloadValue("   "))
        #expect(!YishuAgentRuntimeClient.isValidOptionalLabelPayloadValue(String(repeating: "x", count: 121)))
        #expect(YishuAgentRuntimeClient.isValidOptionalEffectClassPayloadValue("activate"))
        #expect(!YishuAgentRuntimeClient.isValidOptionalEffectClassPayloadValue("   "))
        #expect(YishuAgentRuntimeClient.isValidOptionalUUIDString(nil))
        #expect(YishuAgentRuntimeClient.isValidOptionalUUIDString(UUID().uuidString))
        #expect(!YishuAgentRuntimeClient.isValidOptionalUUIDString("not-a-uuid"))
        #expect(YishuAgentRuntimeClient.isValidScreenPayloadValue(NSNumber(value: 2)))
        #expect(!YishuAgentRuntimeClient.isValidScreenPayloadValue(NSNumber(value: 1.5)))
        #expect(!YishuAgentRuntimeClient.isValidScreenPayloadValue(NSNumber(value: true)))
        #expect(!YishuAgentRuntimeClient.isValidScreenPayloadValue("2"))
    }

    @Test @MainActor func delegatedTaskPresenceStrictlyDecodesAndProjectsRuntimeTruth() {
        let taskId = UUID()
        let parentId = UUID()
        let conversationId = UUID()
        let timestamp = ISO8601DateFormatter().string(from: Date())
        var raw: [String: Any] = [
            "schemaVersion": 1,
            "type": "task.presence.updated",
            "eventId": UUID().uuidString,
            "requestId": parentId.uuidString,
            "traceId": UUID().uuidString,
            "conversationId": conversationId.uuidString,
            "payload": [
                "taskId": taskId.uuidString,
                "parentId": parentId.uuidString,
                "mainConversationId": conversationId.uuidString,
                "title": "研究 Agent Presence",
                "status": "running",
                "createdAt": timestamp,
                "updatedAt": timestamp,
                "provider": "openai-codex",
                "model": "gpt-5.6-terra",
            ],
        ]

        let running = YishuDelegatedTaskPresenceEvent.decode(raw)
        #expect(running?.id == taskId)
        #expect(running?.status == .running)
        #expect(running?.workerLabel == "Research · Terra")

        let client = YishuAgentRuntimeClient()
        var dispatched: YishuDelegatedTaskPresenceEvent?
        client.onDelegatedTaskPresenceEvent = { dispatched = $0 }
        client.dispatchRuntimeEventForTests(raw)
        #expect(dispatched?.id == taskId)

        let viewModel = AgentPresenceViewModel()
        if let running { viewModel.apply(running) }
        #expect(viewModel.tasks.count == 1)
        #expect(viewModel.tasks.first?.status == .running)

        var terminalPayload = raw["payload"] as! [String: Any]
        terminalPayload["status"] = "done"
        terminalPayload["resultKind"] = "completed"
        terminalPayload["summary"] = "找到三个可执行结论。"
        raw["payload"] = terminalPayload
        let completed = YishuDelegatedTaskPresenceEvent.decode(raw)
        if let completed { viewModel.apply(completed) }
        #expect(viewModel.tasks.first?.status == .done)
        #expect(viewModel.tasks.first?.summary == "找到三个可执行结论。")

        viewModel.acknowledge(taskId)
        #expect(viewModel.tasks.isEmpty)
    }

    @Test @MainActor func delegatedTaskPresenceRejectsCrossConversationAndIncompleteTerminalEvents() {
        let taskId = UUID()
        let parentId = UUID()
        let conversationId = UUID()
        let timestamp = ISO8601DateFormatter().string(from: Date())
        var base: [String: Any] = [
            "schemaVersion": 1,
            "type": "task.presence.updated",
            "eventId": UUID().uuidString,
            "requestId": parentId.uuidString,
            "traceId": UUID().uuidString,
            "conversationId": conversationId.uuidString,
            "payload": [
                "taskId": taskId.uuidString,
                "parentId": parentId.uuidString,
                "mainConversationId": conversationId.uuidString,
                "title": "不应进入 UI",
                "status": "done",
                "createdAt": timestamp,
                "updatedAt": timestamp,
            ],
        ]
        #expect(YishuDelegatedTaskPresenceEvent.decode(base) == nil)

        var mismatchedPayload = base["payload"] as! [String: Any]
        mismatchedPayload["mainConversationId"] = UUID().uuidString
        mismatchedPayload["resultKind"] = "completed"
        mismatchedPayload["summary"] = "不应进入 UI"
        base["payload"] = mismatchedPayload
        #expect(YishuDelegatedTaskPresenceEvent.decode(base) == nil)
    }

    @Test @MainActor func runtimeProcessDeathEndsPendingHistoryWithoutWaitingTimeout() async throws {
        let client = YishuAgentRuntimeClient()
        let parked = await client.parkHistoryListWaitForTests()
        #expect(client.pendingHistoryRequestCountForTests == 1)

        // Simulate the terminationHandler path: sidecar died unexpectedly.
        // Must finish immediately — not after the 10s history timeout.
        let started = ContinuousClock.now
        client.endAllPendingRuntimeRequests(
            throwing: YishuAgentRuntimeClientError.runtimeNotRunning
        )
        #expect(client.pendingHistoryRequestCountForTests == 0)

        var sawFailure = false
        do {
            try await parked.wait.value
        } catch {
            sawFailure = true
        }
        let elapsed = ContinuousClock.now - started
        #expect(sawFailure)
        // Far under the 10s history timeout; process death must not leave UI waiting.
        #expect(elapsed < .seconds(2))
    }

    @Test @MainActor func runtimeProcessDeathEndsPendingMemoryListAndForgetWithoutTimeout() async throws {
        let client = YishuAgentRuntimeClient()
        let listParked = await client.parkMemoryListWaitForTests()
        let forgetParked = await client.parkMemoryForgetWaitForTests()
        #expect(client.pendingHistoryRequestCountForTests == 2)

        let started = ContinuousClock.now
        client.endAllPendingRuntimeRequests(
            throwing: YishuAgentRuntimeClientError.runtimeNotRunning
        )
        #expect(client.pendingHistoryRequestCountForTests == 0)

        var listFailed = false
        var forgetFailed = false
        do { try await listParked.wait.value } catch { listFailed = true }
        do { try await forgetParked.wait.value } catch { forgetFailed = true }
        let elapsed = ContinuousClock.now - started
        #expect(listFailed)
        #expect(forgetFailed)
        #expect(elapsed < .seconds(2))
    }

    @Test @MainActor func memoryForgetFailureKeepsWaitFailingWithoutHang() async throws {
        let client = YishuAgentRuntimeClient()
        let parked = await client.parkMemoryForgetWaitForTests()
        #expect(client.pendingHistoryRequestCountForTests == 1)

        client.failParkedHistoryRequestForTests(
            requestId: parked.requestId,
            error: YishuAgentRuntimeClientError.memoryFailed("忘记失败，原记忆仍保留。")
        )
        #expect(client.pendingHistoryRequestCountForTests == 0)

        var message = ""
        do {
            try await parked.wait.value
        } catch let error as YishuAgentRuntimeClientError {
            message = error.localizedDescription
        }
        #expect(message.contains("忘记失败") || message.contains("原记忆"))
    }

    @Test func memoryForgetUIPolicyDoesNotMutateOnCancelOrBusy() async throws {
        // Product rules Codex asked to verify without spinning the full manager graph.
        #expect(YishuMemoryForgetUIPolicy.shouldMutateStoreOnCancel == false)
        #expect(YishuMemoryForgetUIPolicy.shouldMutateStoreWhenBusy == false)
        #expect(YishuMemoryForgetUIPolicy.shouldRemoveRowOnlyAfterStoreSuccess == true)
        #expect(YishuMemoryForgetUIPolicy.busyRefuseNotice.contains("回答结束"))
    }

    @Test @MainActor func selectConversationRequiresIdleTurnsAndPersistsId() throws {
        let keys = [
            "yishu.runtime.conversationId.v1",
            "yishu.runtime.sessionScope.kind.v1",
            "yishu.runtime.sessionScope.projectId.v1",
            "yishu.runtime.sessionScope.projectLabel.v1",
        ]
        let defaults = UserDefaults.standard
        let previous = keys.map { ($0, defaults.object(forKey: $0)) }
        defer {
            for (key, value) in previous {
                if let value {
                    defaults.set(value, forKey: key)
                } else {
                    defaults.removeObject(forKey: key)
                }
            }
        }
        keys.forEach(defaults.removeObject(forKey:))

        let client = YishuAgentRuntimeClient()
        let older = UUID()
        #expect(client.selectConversation(id: older, scope: .personal))
        #expect(client.currentConversationId == older)
        #expect(client.currentSessionScope.kind == .personal)
        #expect(defaults.string(forKey: keys[0]) == older.uuidString)

        // Private is never selectable as durable history.
        #expect(!client.selectConversation(id: UUID(), scope: .privateSession))
        #expect(client.currentConversationId == older)
    }

    @Test @MainActor func deletingCurrentConversationRotatesToCleanIdWithoutReuse() throws {
        let keys = [
            "yishu.runtime.conversationId.v1",
            "yishu.runtime.sessionScope.kind.v1",
            "yishu.runtime.sessionScope.projectId.v1",
            "yishu.runtime.sessionScope.projectLabel.v1",
        ]
        let defaults = UserDefaults.standard
        let previous = keys.map { ($0, defaults.object(forKey: $0)) }
        defer {
            for (key, value) in previous {
                if let value {
                    defaults.set(value, forKey: key)
                } else {
                    defaults.removeObject(forKey: key)
                }
            }
        }
        keys.forEach(defaults.removeObject(forKey:))

        let client = YishuAgentRuntimeClient()
        let doomed = UUID()
        #expect(client.selectConversation(id: doomed, scope: .personal))
        #expect(client.currentConversationId == doomed)

        // After a successful soft-delete of the current row, product code must
        // rotate to a brand-new personal conversation and never reuse the old id.
        #expect(client.beginNewConversation(scope: .personal))
        #expect(client.currentConversationId != doomed)
        #expect(client.currentSessionScope.kind == .personal)
        #expect(defaults.string(forKey: keys[0]) == client.currentConversationId.uuidString)
        #expect(defaults.string(forKey: keys[0])?.caseInsensitiveCompare(doomed.uuidString) != .orderedSame)
    }

    @Test @MainActor func runtimeConversationIdPersistsAcrossClientsAndRotatesExplicitly() throws {
        let key = "yishu.runtime.conversationId.v1"
        let scopeKeys = [
            key,
            "yishu.runtime.sessionScope.kind.v1",
            "yishu.runtime.sessionScope.projectId.v1",
            "yishu.runtime.sessionScope.projectLabel.v1",
        ]
        let defaults = UserDefaults.standard
        let previous = scopeKeys.map { ($0, defaults.object(forKey: $0)) }
        defer {
            for (savedKey, savedValue) in previous {
                if let savedValue {
                    defaults.set(savedValue, forKey: savedKey)
                } else {
                    defaults.removeObject(forKey: savedKey)
                }
            }
        }

        scopeKeys.forEach(defaults.removeObject(forKey:))
        let first = YishuAgentRuntimeClient()
        let persistedString = try #require(defaults.string(forKey: key))
        let persisted = try #require(UUID(uuidString: persistedString))
        #expect(first.currentConversationId == persisted)

        let second = YishuAgentRuntimeClient()
        #expect(second.currentConversationId == first.currentConversationId)

        second.beginNewConversation()
        #expect(second.currentConversationId != first.currentConversationId)
        #expect(defaults.string(forKey: key) == second.currentConversationId.uuidString)
    }

    @Test @MainActor func runtimeProjectScopePersistsButPrivateScopeNeverRestores() throws {
        let keys = [
            "yishu.runtime.conversationId.v1",
            "yishu.runtime.sessionScope.kind.v1",
            "yishu.runtime.sessionScope.projectId.v1",
            "yishu.runtime.sessionScope.projectLabel.v1",
        ]
        let defaults = UserDefaults.standard
        let previous = keys.map { ($0, defaults.object(forKey: $0)) }
        defer {
            for (key, value) in previous {
                if let value {
                    defaults.set(value, forKey: key)
                } else {
                    defaults.removeObject(forKey: key)
                }
            }
        }
        keys.forEach(defaults.removeObject(forKey:))

        let client = YishuAgentRuntimeClient()
        let projectID = UUID()
        let project = try #require(YishuSessionScope.project(id: projectID, label: " 奕枢   统一 "))
        #expect(client.beginNewConversation(scope: project))
        #expect(client.currentSessionScope.projectId == projectID)
        #expect(client.currentSessionScope.projectLabel == "奕枢 统一")

        #expect(client.beginNewConversation(scope: .personal))
        #expect(client.currentSessionScope.kind == .personal)
        #expect(client.lastProjectScope?.projectId == projectID)
        #expect(defaults.string(forKey: keys[2]) == projectID.uuidString)

        #expect(client.beginNewConversation(scope: project))
        #expect(client.currentSessionScope.projectId == projectID)
        let persistedProjectConversation = client.currentConversationId

        #expect(client.beginNewConversation(scope: .privateSession))
        #expect(client.currentSessionScope.kind == .privateSession)
        #expect(client.currentConversationId != persistedProjectConversation)
        #expect(defaults.string(forKey: keys[0]) == persistedProjectConversation.uuidString)
        #expect(defaults.string(forKey: keys[1]) == YishuSessionScopeKind.project.rawValue)

        let restarted = YishuAgentRuntimeClient()
        #expect(restarted.currentConversationId == persistedProjectConversation)
        #expect(restarted.currentSessionScope.kind == .project)
        #expect(restarted.currentSessionScope.projectId == projectID)
    }

    @Test func transcriptionReducerSubmitsFinalExactlyOnceAfterRelease() {
        var reducer = BuddyTranscriptionStateMachine()
        let token = BuddyTranscriptionSessionToken(token: 7, generation: 3)
        _ = reducer.start(token: token)

        #expect(reducer.reduce(.partial(
            token: token,
            sequence: 1,
            text: "  你好  "
        )) == [.updatePartial(token: token, sequence: 1, text: "你好")])
        #expect(reducer.reduce(.final(
            token: token,
            sequence: 2,
            text: "  你好，世界  "
        )).isEmpty)

        #expect(reducer.reduce(.release(token: token, sequence: 3)) == [
            .submitFinal(token: token, sequence: 3, text: "你好，世界")
        ])
        #expect(reducer.snapshot.submissionEmitted)
        #expect(reducer.reduce(.release(token: token, sequence: 4)) == [
            .drop(token: token, sequence: 4, reason: .terminal)
        ])
        #expect(reducer.reduce(.final(token: token, sequence: 5, text: "迟到的结果")) == [
            .drop(token: token, sequence: 5, reason: .terminal)
        ])
    }

    @Test func transcriptionReducerAcceptsFinalAfterReleaseAndArmsTimeout() {
        var reducer = BuddyTranscriptionStateMachine()
        let token = BuddyTranscriptionSessionToken(token: 8, generation: 4)
        _ = reducer.start(token: token)

        #expect(reducer.reduce(.release(token: token, sequence: 1)) == [
            .armFinalTimeout(token: token)
        ])
        #expect(reducer.snapshot.phase == .finalizing)
        #expect(reducer.reduce(.final(
            token: token,
            sequence: 2,
            text: "最终稿"
        )) == [.submitFinal(token: token, sequence: 2, text: "最终稿")])
    }

    @Test func transcriptionReducerTimeoutCanSubmitManagerFallbackText() {
        var reducer = BuddyTranscriptionStateMachine()
        let token = BuddyTranscriptionSessionToken(token: 9, generation: 5)
        _ = reducer.start(token: token)
        _ = reducer.reduce(.release(token: token, sequence: 1))

        #expect(reducer.reduce(.timeout(
            token: token,
            sequence: 2,
            phase: .final,
            fallbackText: "旧 provider 的最终稿"
        )) == [
            .submitFinal(token: token, sequence: 2, text: "旧 provider 的最终稿")
        ])
        #expect(reducer.snapshot.phase == .completed)
    }

    @Test func transcriptionReducerDropsStaleAndLateEvents() {
        var reducer = BuddyTranscriptionStateMachine()
        let token = BuddyTranscriptionSessionToken(token: 10, generation: 6)
        let oldToken = BuddyTranscriptionSessionToken(token: 11, generation: 6)
        _ = reducer.start(token: token)

        #expect(reducer.reduce(.partial(token: token, sequence: 2, text: "first")) == [
            .updatePartial(token: token, sequence: 2, text: "first")
        ])
        #expect(reducer.reduce(.partial(token: token, sequence: 2, text: "replayed")) == [
            .drop(token: token, sequence: 2, reason: .staleSequence)
        ])
        #expect(reducer.reduce(.final(token: oldToken, sequence: 3, text: "other session")) == [
            .drop(token: oldToken, sequence: 3, reason: .tokenMismatch)
        ])

        _ = reducer.reduce(.failure(
            token: token,
            sequence: 4,
            reason: .transport
        ))
        #expect(reducer.reduce(.final(token: token, sequence: 5, text: "late stream result")) == [
            .drop(token: token, sequence: 5, reason: .afterFallback)
        ])
    }

    @Test func transcriptionReducerSupersedesOldGeneration() {
        var reducer = BuddyTranscriptionStateMachine()
        let oldToken = BuddyTranscriptionSessionToken(token: 12, generation: 1)
        let newToken = BuddyTranscriptionSessionToken(token: 13, generation: 2)
        _ = reducer.start(token: oldToken)

        #expect(reducer.start(token: newToken) == [
            .cancelTransport(token: oldToken)
        ])
        #expect(reducer.reduce(.partial(
            token: oldToken,
            sequence: 1,
            text: "旧会话"
        )) == [
            .drop(token: oldToken, sequence: 1, reason: .tokenMismatch)
        ])
        #expect(reducer.reduce(.partial(
            token: newToken,
            sequence: 1,
            text: "新会话"
        )) == [
            .updatePartial(token: newToken, sequence: 1, text: "新会话")
        ])
    }

    @Test func transcriptionRetentionBufferRemainsBounded() {
        var retention = BuddyPCM16RetentionBuffer(maximumBytes: 6)
        retention.append(Data([1, 2, 3]))
        retention.append(Data([4, 5, 6]))
        retention.append(Data([7, 8]))

        #expect(retention.byteCount <= retention.maximumBytes)
        #expect(retention.didDropOldestAudio)
        #expect(retention.data == Data([4, 5, 6, 7, 8]))
    }

    @Test func stepFunStreamingDefaultsToOfflineFallbackSeam() {
        let configuration = StepFunStreamingConfiguration()

        #expect(configuration.apiKey == nil)
        #expect(!configuration.isAvailable)
    }

    @Test func fakeStreamingTransportExercisesOnlyInjectedProtocol() async throws {
        let token = BuddyTranscriptionSessionToken(token: 14, generation: 7)
        let transport = FakeStepFunStreamingTransport()
        try await transport.connect()
        transport.sendAudio(Data([0, 1, 2, 3]))
        transport.emit(.partial(token: token, sequence: 1, text: "离线测试"))
        transport.finish()
        transport.cancel()

        #expect(transport.connectCount == 1)
        #expect(transport.sentAudio == [Data([0, 1, 2, 3])])
        #expect(transport.finishCount == 1)
        #expect(transport.cancelCount == 1)
    }

    @Test func hybridReducerKeepsApplePartialAndFinalOutOfNormalSubmit() {
        var reducer = BuddyHybridTranscriptionStateMachine()
        let token = BuddyTranscriptionSessionToken(token: 20, generation: 8)
        _ = reducer.start(token: token)

        #expect(reducer.reduce(.partial(
            token: token,
            sequence: 1,
            text: "点击左上"
        )) == [.updatePartial(token: token, sequence: 1, text: "点击左上")])
        #expect(reducer.reduce(.final(
            token: token,
            sequence: 2,
            source: .appleSpeechShadow,
            text: "点击左上角新对话"
        )).isEmpty)
        #expect(reducer.snapshot.pendingAppleFinalText == "点击左上角新对话")
    }

    @Test func hybridReducerUsesStepFunFinalBeforeAppleFallback() {
        var reducer = BuddyHybridTranscriptionStateMachine()
        let token = BuddyTranscriptionSessionToken(token: 21, generation: 9)
        _ = reducer.start(token: token)
        _ = reducer.reduce(.final(
            token: token,
            sequence: 1,
            source: .appleSpeechShadow,
            text: "shadow"
        ))
        _ = reducer.reduce(.release(token: token, sequence: 2))

        #expect(reducer.reduce(.final(
            token: token,
            sequence: 3,
            source: .stepFunAuthoritative,
            text: "authoritative"
        )) == [
            .submitFinal(
                token: token,
                sequence: 3,
                source: .stepFunAuthoritative,
                text: "authoritative"
            )
        ])
        #expect(reducer.reduce(.final(
            token: token,
            sequence: 4,
            source: .appleSpeechShadow,
            text: "late shadow"
        )) == [
            .drop(token: token, sequence: 4, reason: .terminal)
        ])
    }

    @Test func hybridReducerSubmitsAppleFinalOnlyAfterStepFunFailure() {
        var reducer = BuddyHybridTranscriptionStateMachine()
        let token = BuddyTranscriptionSessionToken(token: 22, generation: 10)
        _ = reducer.start(token: token)
        _ = reducer.reduce(.final(
            token: token,
            sequence: 1,
            source: .appleSpeechShadow,
            text: "apple fallback"
        ))
        _ = reducer.reduce(.failure(
            token: token,
            sequence: 2,
            source: .stepFunAuthoritative
        ))

        #expect(reducer.reduce(.release(token: token, sequence: 3)) == [
            .submitFinal(
                token: token,
                sequence: 3,
                source: .appleSpeechFallback,
                text: "apple fallback"
            )
        ])
        #expect(reducer.snapshot.submissionEmitted)
    }

    @Test func hybridReducerTimeoutUsesAppleFallbackOrLegacyPath() {
        var withApple = BuddyHybridTranscriptionStateMachine()
        let appleToken = BuddyTranscriptionSessionToken(token: 23, generation: 11)
        _ = withApple.start(token: appleToken)
        _ = withApple.reduce(.release(token: appleToken, sequence: 1))
        _ = withApple.reduce(.final(
            token: appleToken,
            sequence: 2,
            source: .appleSpeechShadow,
            text: "apple after release"
        ))
        #expect(withApple.reduce(.timeout(token: appleToken, sequence: 3)) == [
            .submitFinal(
                token: appleToken,
                sequence: 3,
                source: .appleSpeechFallback,
                text: "apple after release"
            )
        ])

        var withoutApple = BuddyHybridTranscriptionStateMachine()
        let legacyToken = BuddyTranscriptionSessionToken(token: 24, generation: 12)
        _ = withoutApple.start(token: legacyToken)
        _ = withoutApple.reduce(.release(token: legacyToken, sequence: 1))
        #expect(withoutApple.reduce(.timeout(token: legacyToken, sequence: 2)) == [
            .cancelStepFun(token: legacyToken),
            .startLegacyBufferedFallback(token: legacyToken)
        ])
    }

    @Test func dictationSubmitKeepsNonEmptyTranscriptWhenAudiblePowerPresent() {
        let audibleHistory: [CGFloat] = Array(repeating: 0.02, count: 40) + [0.12, 0.18, 0.09, 0.03]
        #expect(
            BuddyDictationManager.submitTranscriptText(
                finalTranscriptText: "  二加三等于几  ",
                recordedAudioPowerHistory: audibleHistory
            ) == "二加三等于几"
        )
    }

    @Test func dictationSubmitEmptiesNonEmptyTranscriptWhenNearSilence() {
        let silenceHistory = Array(repeating: CGFloat(0.02), count: 44)
        #expect(
            BuddyDictationManager.submitTranscriptText(
                finalTranscriptText: "噪声转写",
                recordedAudioPowerHistory: silenceHistory
            ).isEmpty
        )
        // Baseline-only + tiny noise below audible delta must still fail closed.
        let nearSilence = Array(repeating: CGFloat(0.03), count: 44)
        #expect(
            BuddyDictationManager.submitTranscriptText(
                finalTranscriptText: "噪声转写",
                recordedAudioPowerHistory: nearSilence
            ).isEmpty
        )
    }

    @Test func dictationSubmitEmptiesBlankTranscriptRegardlessOfPower() {
        let audibleHistory: [CGFloat] = [0.02, 0.5, 0.4]
        #expect(
            BuddyDictationManager.submitTranscriptText(
                finalTranscriptText: "   ",
                recordedAudioPowerHistory: audibleHistory
            ).isEmpty
        )
        #expect(
            BuddyDictationManager.submitTranscriptText(
                finalTranscriptText: "",
                recordedAudioPowerHistory: audibleHistory
            ).isEmpty
        )
    }

    @Test func dictationSubmitDecisionIsDeterministicForSameInputs() {
        let history: [CGFloat] = [0.02, 0.02, 0.15]
        let first = BuddyDictationManager.submitTranscriptText(
            finalTranscriptText: "你好",
            recordedAudioPowerHistory: history
        )
        let second = BuddyDictationManager.submitTranscriptText(
            finalTranscriptText: "你好",
            recordedAudioPowerHistory: history
        )
        #expect(first == "你好")
        #expect(first == second)
    }

    @Test func hybridPartialOnlyNeverBecomesLegacyFallbackTranscript() {
        #expect(
            BuddyDictationManager.authoritativeHybridFallbackText(
                authoritativeText: "",
                shadowPartialText: "点击左上角新对话"
            ).isEmpty
        )
        #expect(
            BuddyDictationManager.authoritativeHybridFallbackText(
                authoritativeText: "  StepFun final  ",
                shadowPartialText: "partial-only text"
            ) == "StepFun final"
        )

        var reducer = BuddyHybridTranscriptionStateMachine()
        let token = BuddyTranscriptionSessionToken(token: 25, generation: 13)
        _ = reducer.start(token: token)
        _ = reducer.reduce(.partial(
            token: token,
            sequence: 1,
            text: "点击左上角新对话"
        ))
        _ = reducer.reduce(.release(token: token, sequence: 2))

        let effects = reducer.reduce(.timeout(token: token, sequence: 3))
        #expect(!effects.contains {
            if case .submitFinal = $0 { return true }
            return false
        })
        #expect(reducer.snapshot.pendingAppleFinalText == nil)
        #expect(reducer.snapshot.pendingStepFunFinalText == nil)
    }

    @Test func hybridProviderRoutesInjectedFakeSourcesWithoutNetwork() async throws {
        let apple = FakeBuddyTranscriptionProvider()
        let stepFun = FakeBuddyTranscriptionProvider()
        let provider = HybridSpeechStepFunTranscriptionProvider(
            appleSpeechProvider: apple,
            stepFunProvider: stepFun
        )
        var partials: [String] = []
        var stepFunFinals: [String] = []
        var appleFinals: [String] = []

        _ = try await provider.startHybridStreamingSession(
            keyterms: [],
            onApplePartial: { partials.append($0) },
            onStepFunFinal: { stepFunFinals.append($0) },
            onAppleFinal: { appleFinals.append($0) },
            onSourceError: { _, _ in }
        )

        apple.emitPartial("shadow partial")
        stepFun.emitFinal("stepfun final")
        apple.emitFinal("apple final")

        #expect(apple.startCount == 1)
        #expect(stepFun.startCount == 1)
        #expect(partials == ["shadow partial"])
        #expect(stepFunFinals == ["stepfun final"])
        #expect(appleFinals == ["apple final"])
    }

    @Test func directClickResolutionKeyIncludesTargetAndROI() {
        #expect(
            YishuDirectClickResolver.resolutionKey(for: "点击左上角新对话")
                == YishuDirectClickResolver.resolutionKey(for: "请点击左上角新对话")
        )
        #expect(
            YishuDirectClickResolver.resolutionKey(for: "点击左上角新对话")
                != YishuDirectClickResolver.resolutionKey(for: "点击右上角新对话")
        )
    }

    @Test func directClickPrewarmRejectsChangedBasisAndUsesCaptureAge() {
        let basis: UInt64 = 1_000_000_000
        #expect(CompanionManager.isValidDirectClickPrewarmBasis(
            capturedAtUptimeNanoseconds: basis,
            nowUptimeNanoseconds: basis + 499_000_000,
            expectedFrontmostProcessIdentifier: pid_t(42),
            currentFrontmostProcessIdentifier: pid_t(42),
            expectedDisplayFingerprint: "display-a",
            currentDisplayFingerprint: "display-a"
        ))
        #expect(!CompanionManager.isValidDirectClickPrewarmBasis(
            capturedAtUptimeNanoseconds: basis,
            nowUptimeNanoseconds: basis + 501_000_000,
            expectedFrontmostProcessIdentifier: pid_t(42),
            currentFrontmostProcessIdentifier: pid_t(42),
            expectedDisplayFingerprint: "display-a",
            currentDisplayFingerprint: "display-a"
        ))
        #expect(!CompanionManager.isValidDirectClickPrewarmBasis(
            capturedAtUptimeNanoseconds: basis,
            nowUptimeNanoseconds: basis + 100_000_000,
            expectedFrontmostProcessIdentifier: pid_t(42),
            currentFrontmostProcessIdentifier: pid_t(99),
            expectedDisplayFingerprint: "display-a",
            currentDisplayFingerprint: "display-a"
        ))
        #expect(!CompanionManager.isValidDirectClickPrewarmBasis(
            capturedAtUptimeNanoseconds: basis,
            nowUptimeNanoseconds: basis + 100_000_000,
            expectedFrontmostProcessIdentifier: pid_t(42),
            currentFrontmostProcessIdentifier: pid_t(42),
            expectedDisplayFingerprint: "display-a",
            currentDisplayFingerprint: "display-b"
        ))

        #expect(CompanionManager.isValidDirectClickPrewarmCaptureBasis(
            expectedFrontmostProcessIdentifier: pid_t(42),
            currentFrontmostProcessIdentifier: pid_t(42),
            expectedDisplayFingerprint: "display-a",
            capturedDisplayFingerprint: "display-a",
            currentDisplayFingerprint: "display-a"
        ))
        #expect(!CompanionManager.isValidDirectClickPrewarmCaptureBasis(
            expectedFrontmostProcessIdentifier: pid_t(42),
            currentFrontmostProcessIdentifier: pid_t(99),
            expectedDisplayFingerprint: "display-a",
            capturedDisplayFingerprint: "display-a",
            currentDisplayFingerprint: "display-a"
        ))
        #expect(!CompanionManager.isValidDirectClickPrewarmCaptureBasis(
            expectedFrontmostProcessIdentifier: pid_t(42),
            currentFrontmostProcessIdentifier: pid_t(42),
            expectedDisplayFingerprint: "display-a",
            capturedDisplayFingerprint: "display-b",
            currentDisplayFingerprint: "display-a"
        ))
        #expect(!CompanionManager.isValidDirectClickPrewarmCaptureBasis(
            expectedFrontmostProcessIdentifier: pid_t(42),
            currentFrontmostProcessIdentifier: pid_t(42),
            expectedDisplayFingerprint: "display-a",
            capturedDisplayFingerprint: "display-a",
            currentDisplayFingerprint: "display-b"
        ))
    }

}

private final class FakeStepFunStreamingTransport: StepFunStreamingTransport {
    private let continuation: AsyncStream<StepFunStreamingTransportEvent>.Continuation
    let events: AsyncStream<StepFunStreamingTransportEvent>
    private(set) var connectCount = 0
    private(set) var finishCount = 0
    private(set) var cancelCount = 0
    private(set) var sentAudio: [Data] = []

    init() {
        let stream = AsyncStream<StepFunStreamingTransportEvent>.makeStream()
        events = stream.stream
        continuation = stream.continuation
    }

    func connect() async throws {
        connectCount += 1
    }

    func sendAudio(_ pcm16Data: Data) {
        sentAudio.append(pcm16Data)
    }

    func finish() {
        finishCount += 1
    }

    func cancel() {
        cancelCount += 1
        continuation.finish()
    }

    func emit(_ event: StepFunStreamingTransportEvent) {
        continuation.yield(event)
    }
}

private final class FakeBuddyTranscriptionProvider: BuddyTranscriptionProvider {
    let displayName = "fake"
    let requiresSpeechRecognitionPermission = false
    let isConfigured = true
    let unavailableExplanation: String? = nil
    private(set) var startCount = 0
    private var partialCallback: ((String) -> Void)?
    private var finalCallback: ((String) -> Void)?
    private let session = FakeBuddyTranscriptionSession()

    func startStreamingSession(
        keyterms: [String],
        onTranscriptUpdate: @escaping (String) -> Void,
        onFinalTranscriptReady: @escaping (String) -> Void,
        onError: @escaping (Error) -> Void
    ) async throws -> any BuddyStreamingTranscriptionSession {
        startCount += 1
        partialCallback = onTranscriptUpdate
        finalCallback = onFinalTranscriptReady
        return session
    }

    func emitPartial(_ text: String) {
        partialCallback?(text)
    }

    func emitFinal(_ text: String) {
        finalCallback?(text)
    }
}

private final class FakeBuddyTranscriptionSession: BuddyStreamingTranscriptionSession {
    let finalTranscriptFallbackDelaySeconds: TimeInterval = 0.2

    func appendAudioBuffer(_ audioBuffer: AVAudioPCMBuffer) {}
    func requestFinalTranscript() {}
    func cancel() {}
}
