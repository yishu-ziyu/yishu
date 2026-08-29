import Foundation
import Testing
@testable import Clicky

struct YishuPanelHierarchyTests {
    @Test func defaultVisibleLocalModelsStayAtTheRecommendedPick() {
        let defaultVisible = YishuConversationModelCatalog.featuredLocalModels(
            selectedModel: YishuConversationModelCatalog.defaultModel,
            selectedProvider: YishuConversationModelCatalog.localProvider
        )
        let defaultMore = YishuConversationModelCatalog.moreLocalModels(
            selectedModel: YishuConversationModelCatalog.defaultModel,
            selectedProvider: YishuConversationModelCatalog.localProvider
        )
        #expect(defaultVisible.map(\.model) == [YishuConversationModelCatalog.defaultModel])
        #expect(defaultVisible.count <= 3)
        #expect(defaultMore.count == YishuConversationModelCatalog.localModels.count - 1)
        #expect(!defaultMore.map(\.model).contains(YishuConversationModelCatalog.defaultModel))

        let selectedHidden = YishuConversationModelCatalog.featuredLocalModels(
            selectedModel: "grok-4.3",
            selectedProvider: YishuConversationModelCatalog.localProvider
        )
        #expect(selectedHidden.map(\.model) == [YishuConversationModelCatalog.defaultModel, "grok-4.3"])
        #expect(
            !YishuConversationModelCatalog.moreLocalModels(
                selectedModel: "grok-4.3",
                selectedProvider: YishuConversationModelCatalog.localProvider
            ).map(\.model).contains("grok-4.3")
        )
        #expect(
            YishuConversationModelCatalog.authSections(authModels: [
                YishuAuthModel(provider: .openAICodex, id: "gpt-5.6-sol", name: "GPT-5.6 Sol"),
            ]).map(\.title) == ["ChatGPT"]
        )
    }

    @Test func userFacingCopyNeverSaysRuntimeOrPi() {
        let lines = [
            YishuPanelRuntimeCopy.headerStarting,
            YishuPanelRuntimeCopy.headerStopped,
            YishuPanelRuntimeCopy.bodyStarting,
            YishuPanelRuntimeCopy.bodyStopped,
            YishuPanelRuntimeCopy.retry,
            YishuPanelRuntimeCopy.unavailable,
        ]
        for line in lines {
            #expect(!line.contains("Runtime"))
            #expect(!line.contains("Pi"))
        }
        #expect(YishuVisibleMemoryEditorMetrics.editorHeight <= 80)
        #expect(YishuVisibleMemoryEditorMetrics.editorHeight < 168)
        #expect(YishuPanelFirstScreenCopy.promise.contains("验证"))
        #expect(!YishuPanelFirstScreenCopy.promise.contains("帮你完成并告诉你结果"))
        #expect(YishuPanelFirstScreenCopy.noVerifiedCompletion == "还没有验证过的完成")
        #expect(!YishuPanelFirstScreenCopy.promise.contains(WorkspaceSettingsCopy.title))
        #expect(!YishuPanelFirstScreenCopy.greeting.contains(WorkspaceSettingsCopy.add))
    }
}
