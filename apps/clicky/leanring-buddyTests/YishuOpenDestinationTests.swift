import Foundation
import Testing
@testable import Clicky

@MainActor
struct YishuOpenDestinationTests {
    @Test func decodesOnlyTheTypedGoogleEmailDestination() throws {
        let requestID = UUID()
        let traceID = UUID()
        let payload: [String: Any] = [
            "actionId": UUID().uuidString,
            "action": "open_destination",
            "x": 0,
            "y": 0,
            "destinationId": "email.google",
            "intentId": UUID().uuidString,
            "attemptId": UUID().uuidString,
            "basisFrameId": UUID().uuidString,
            "effectClass": "navigation",
        ]

        let request = try #require(YishuAgentRuntimeClient.decodeComputerActionRequest(
            payload: payload,
            requestId: requestID,
            traceId: traceID,
            schemaVersion: NSNumber(value: 1)
        ))
        #expect(request.destinationId == "email.google")

        var arbitraryURL = payload
        arbitraryURL["destinationId"] = "https://example.com"
        #expect(YishuAgentRuntimeClient.decodeComputerActionRequest(
            payload: arbitraryURL,
            requestId: requestID,
            traceId: traceID,
            schemaVersion: NSNumber(value: 1)
        ) == nil)
    }

    @Test func opensTheCanonicalGmailURLOnceBehindTheAuthorizationFence() async throws {
        let request = YishuComputerActionRequest(
            requestId: UUID(),
            traceId: UUID(),
            actionId: UUID(),
            action: "open_destination",
            x: 0,
            y: 0,
            destinationId: "email.google",
            intentId: UUID().uuidString,
            attemptId: UUID().uuidString,
            basisFrameId: UUID().uuidString,
            effectClass: "navigation"
        )
        var openedURLs: [URL] = []
        let result = await YishuComputerUseActuator.perform(
            request,
            screenCaptures: [],
            destinationExecutor: { url in
                openedURLs.append(url)
                return true
            }
        )

        #expect(openedURLs == [URL(string: "https://mail.google.com/")!])
        #expect(result.succeeded)
        #expect(result.verified)
        #expect(result.method == .nativeCommand)
        #expect(result.code == .verifiedURLReady)
    }
}
