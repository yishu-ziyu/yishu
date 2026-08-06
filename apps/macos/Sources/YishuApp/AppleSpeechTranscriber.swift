import AVFoundation
import Foundation
import Speech

enum SpeechTranscriberError: LocalizedError {
    case speechPermissionDenied
    case microphonePermissionDenied
    case recognizerUnavailable
    case audioInputUnavailable

    var errorDescription: String? {
        switch self {
        case .speechPermissionDenied: return "需要语音识别权限才能听见你。"
        case .microphonePermissionDenied: return "需要麦克风权限才能听见你。"
        case .recognizerUnavailable: return "当前语音识别服务不可用。"
        case .audioInputUnavailable: return "没有可用的麦克风输入。"
        }
    }
}

@MainActor
final class AppleSpeechTranscriber {
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
    private var audioEngine: AVAudioEngine?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var finalizationTimer: Timer?
    private var lastTranscript = ""
    private var isStopping = false
    private var onPartial: ((String) -> Void)?
    private var onFinal: ((String) -> Void)?
    private var onFailure: ((String) -> Void)?

    var isListening: Bool {
        audioEngine?.isRunning == true || recognitionTask != nil
    }

    func start(
        onPartial: @escaping (String) -> Void,
        onFinal: @escaping (String) -> Void,
        onFailure: @escaping (String) -> Void
    ) async throws {
        cancel()
        try await authorize()
        guard let recognizer, recognizer.isAvailable else {
            throw SpeechTranscriberError.recognizerUnavailable
        }

        let engine = AVAudioEngine()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation

        let inputNode = engine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw SpeechTranscriberError.audioInputUnavailable
        }

        self.onPartial = onPartial
        self.onFinal = onFinal
        self.onFailure = onFailure
        audioEngine = engine
        recognitionRequest = request
        lastTranscript = ""
        isStopping = false

        inputNode.installTap(onBus: 0, bufferSize: 1_024, format: format) { buffer, _ in
            request.append(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            inputNode.removeTap(onBus: 0)
            cleanup(cancelRecognition: true)
            throw error
        }

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            let transcript = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal == true
            let failureMessage = error?.localizedDescription
            Task { @MainActor in
                guard let self else { return }
                if let transcript, !transcript.isEmpty {
                    self.lastTranscript = transcript
                    self.onPartial?(transcript)
                }
                if isFinal {
                    self.finish(with: self.lastTranscript)
                } else if let failureMessage {
                    if self.isStopping, !self.lastTranscript.isEmpty {
                        self.finish(with: self.lastTranscript)
                    } else {
                        self.fail(message: failureMessage)
                    }
                }
            }
        }
    }

    func stopAndFinalize() {
        guard recognitionTask != nil else { return }
        isStopping = true
        stopAudioInput()
        recognitionRequest?.endAudio()
        finalizationTimer?.invalidate()
        finalizationTimer = Timer.scheduledTimer(withTimeInterval: 1.4, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                if self.lastTranscript.isEmpty {
                    self.fail(message: "我没听清。点我再说一次就好。")
                } else {
                    self.finish(with: self.lastTranscript)
                }
            }
        }
    }

    func cancel() {
        finalizationTimer?.invalidate()
        finalizationTimer = nil
        stopAudioInput()
        cleanup(cancelRecognition: true)
    }

    private func authorize() async throws {
        let speechStatus: SFSpeechRecognizerAuthorizationStatus
        if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
            speechStatus = await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { status in
                    continuation.resume(returning: status)
                }
            }
        } else {
            speechStatus = SFSpeechRecognizer.authorizationStatus()
        }
        guard speechStatus == .authorized else {
            throw SpeechTranscriberError.speechPermissionDenied
        }

        let microphoneAuthorized: Bool
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            microphoneAuthorized = true
        case .notDetermined:
            microphoneAuthorized = await AVCaptureDevice.requestAccess(for: .audio)
        default:
            microphoneAuthorized = false
        }
        guard microphoneAuthorized else {
            throw SpeechTranscriberError.microphonePermissionDenied
        }
    }

    private func stopAudioInput() {
        guard let engine = audioEngine else { return }
        if engine.isRunning {
            engine.stop()
        }
        engine.inputNode.removeTap(onBus: 0)
        audioEngine = nil
    }

    private func finish(with transcript: String) {
        let completion = onFinal
        stopAudioInput()
        cleanup(cancelRecognition: true)
        completion?(transcript)
    }

    private func fail(message: String) {
        let failure = onFailure
        stopAudioInput()
        cleanup(cancelRecognition: true)
        failure?(message)
    }

    private func cleanup(cancelRecognition: Bool) {
        finalizationTimer?.invalidate()
        finalizationTimer = nil
        if cancelRecognition {
            recognitionTask?.cancel()
        }
        recognitionTask = nil
        recognitionRequest = nil
        audioEngine = nil
        isStopping = false
        lastTranscript = ""
        onPartial = nil
        onFinal = nil
        onFailure = nil
    }
}
