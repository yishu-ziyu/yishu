//
//  YishuOverlayTextReconcilePolicyTests.swift
//  leanring-buddyTests
//

import Foundation
import Testing
@testable import Clicky

struct YishuOverlayTextReconcilePolicyTests {
    @Test func authoritativeExtensionWins() {
        // Completed text continues the streamed text → show the full final.
        #expect(
            YishuOverlayTextReconcilePolicy.displayText(
                streamed: "你好，我在。",
                authoritative: "你好，我在。有什么可以帮你？"
            ) == "你好，我在。有什么可以帮你？"
        )
    }

    @Test func longerStreamedTextIsKept() {
        // Streamed already carries more than the final (contract break with a
        // truncated completion) → never visually cut the answer back.
        #expect(
            YishuOverlayTextReconcilePolicy.displayText(
                streamed: "你好，我在。有什么可以帮你？",
                authoritative: "你好，我在。"
            ) == "你好，我在。有什么可以帮你？"
        )
    }

    @Test func divergedTextKeepsStreamedView() {
        // The model restated itself in the same generation: replacing what the
        // user watched appear reads as the answer restarting. Keep streamed.
        #expect(
            YishuOverlayTextReconcilePolicy.displayText(
                streamed: "第一段回答。",
                authoritative: "第二段完全不同的复述。"
            ) == "第一段回答。"
        )
    }

    @Test func whitespaceOnlySidesFallBack() {
        #expect(
            YishuOverlayTextReconcilePolicy.displayText(
                streamed: "  ",
                authoritative: "权威文本"
            ) == "权威文本"
        )
        #expect(
            YishuOverlayTextReconcilePolicy.displayText(
                streamed: "已流式文本",
                authoritative: ""
            ) == "已流式文本"
        )
    }

    @Test func identicalTextIsStable() {
        let text = "同一句话。"
        #expect(
            YishuOverlayTextReconcilePolicy.displayText(
                streamed: text,
                authoritative: text
            ) == text
        )
    }
}
