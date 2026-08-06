import AVFoundation
import Foundation

@MainActor
final class SpeechOutput: NSObject, AVSpeechSynthesizerDelegate {
    private let synthesizer = AVSpeechSynthesizer()
    private var completion: (() -> Void)?

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    var isSpeaking: Bool { synthesizer.isSpeaking }

    func speak(_ text: String, completion: @escaping () -> Void) {
        stop()
        let environmentDisabled = ProcessInfo.processInfo.environment["YISHU_DISABLE_TTS"] == "1"
        let bundleDisabled = (Bundle.main.object(forInfoDictionaryKey: "YishuDisableTTS") as? Bool) == true
        guard !environmentDisabled, !bundleDisabled else {
            completion()
            return
        }

        self.completion = completion
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: "zh-CN")
        utterance.rate = 0.49
        utterance.pitchMultiplier = 1.02
        synthesizer.speak(utterance)
    }

    func stop() {
        guard synthesizer.isSpeaking || synthesizer.isPaused else {
            completion = nil
            return
        }
        synthesizer.stopSpeaking(at: .immediate)
        completion = nil
    }

    nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didFinish utterance: AVSpeechUtterance
    ) {
        Task { @MainActor in
            let finished = self.completion
            self.completion = nil
            finished?()
        }
    }
}
