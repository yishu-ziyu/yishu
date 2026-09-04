#!/usr/bin/env swift
import AVFoundation
import Foundation
import Speech

struct ProbeResult: Codable {
    var ok: Bool
    var authorized: Bool
    var auth_status: String
    var locale: String
    var supports_on_device: Bool?
    var error: String?
}

struct RunResult: Codable {
    var ok: Bool
    var text: String
    var first_partial_ms: Int?
    var final_after_end_ms: Int?
    var on_device: Bool
    var requires_on_device: Bool
    var supports_on_device: Bool
    var auth_status: String
    var sample: String?
    var trial: Int?
    var mode: String
    var error: String?
}

func argValue(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let idx = args.firstIndex(of: name), idx + 1 < args.count else { return nil }
    return args[idx + 1]
}

func hasFlag(_ name: String) -> Bool {
    CommandLine.arguments.contains(name)
}

func loadJob() -> [String: String] {
    guard let path = argValue("--job") else { return [:] }
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return [:] }
    var out: [String: String] = [:]
    for (k, v) in obj {
        if let s = v as? String { out[k] = s }
        else if let b = v as? Bool { out[k] = b ? "true" : "false" }
        else if let n = v as? NSNumber { out[k] = n.stringValue }
    }
    return out
}

let job = loadJob()

func opt(_ name: String, jobKey: String? = nil) -> String? {
    argValue(name) ?? job[jobKey ?? String(name.dropFirst(2))]
}

func writeJSON<T: Encodable>(_ value: T, to path: String?) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    let data = try! encoder.encode(value)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    if let path, !path.isEmpty {
        try? data.write(to: URL(fileURLWithPath: path))
    }
}

func touchStarted(_ outPath: String?) {
    guard let outPath, !outPath.isEmpty else { return }
    try? "started\n".write(toFile: outPath + ".started", atomically: true, encoding: .utf8)
}

func authStatusName(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
}

func requestSpeechAuth(timeoutSeconds: Double) -> SFSpeechRecognizerAuthorizationStatus {
    var status = SFSpeechRecognizer.authorizationStatus()
    if status != .notDetermined { return status }
    var done = false
    SFSpeechRecognizer.requestAuthorization { next in
        status = next
        done = true
    }
    let deadline = Date().addingTimeInterval(timeoutSeconds)
    while !done && Date() < deadline {
        RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
    }
    return status
}

func sliceBuffer(_ src: AVAudioPCMBuffer, start: AVAudioFrameCount, count: AVAudioFrameCount) -> AVAudioPCMBuffer? {
    guard let dst = AVAudioPCMBuffer(pcmFormat: src.format, frameCapacity: count) else { return nil }
    dst.frameLength = count
    let channels = Int(src.format.channelCount)
    if let srcCh = src.floatChannelData, let dstCh = dst.floatChannelData {
        for ch in 0..<channels {
            memcpy(dstCh[ch], srcCh[ch] + Int(start), Int(count) * MemoryLayout<Float>.size)
        }
        return dst
    }
    if let srcCh = src.int16ChannelData, let dstCh = dst.int16ChannelData {
        for ch in 0..<channels {
            memcpy(dstCh[ch], srcCh[ch] + Int(start), Int(count) * MemoryLayout<Int16>.size)
        }
        return dst
    }
    return nil
}

func boolOpt(_ raw: String?, default defaultValue: Bool) -> Bool {
    guard let raw else { return defaultValue }
    switch raw.lowercased() {
    case "1", "true", "yes", "on": return true
    case "0", "false", "no", "off": return false
    default: return defaultValue
    }
}

func runRecognition(wavPath: String, requireOnDevice: Bool, sample: String?, trial: Int?) -> RunResult {
    let mode = requireOnDevice ? "on-device" : "server-assisted"
    let auth = requestSpeechAuth(timeoutSeconds: 120)
    let authName = authStatusName(auth)
    guard auth == .authorized else {
        return RunResult(
            ok: false,
            text: "",
            first_partial_ms: nil,
            final_after_end_ms: nil,
            on_device: requireOnDevice,
            requires_on_device: requireOnDevice,
            supports_on_device: false,
            auth_status: authName,
            sample: sample,
            trial: trial,
            mode: mode,
            error: "permission not granted"
        )
    }

    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN")) else {
        return RunResult(
            ok: false,
            text: "",
            first_partial_ms: nil,
            final_after_end_ms: nil,
            on_device: requireOnDevice,
            requires_on_device: requireOnDevice,
            supports_on_device: false,
            auth_status: authName,
            sample: sample,
            trial: trial,
            mode: mode,
            error: "SFSpeechRecognizer unavailable for zh-CN"
        )
    }

    let supports = recognizer.supportsOnDeviceRecognition
    if requireOnDevice && !supports {
        return RunResult(
            ok: false,
            text: "",
            first_partial_ms: nil,
            final_after_end_ms: nil,
            on_device: true,
            requires_on_device: true,
            supports_on_device: false,
            auth_status: authName,
            sample: sample,
            trial: trial,
            mode: mode,
            error: "on-device recognition not supported for zh-CN"
        )
    }

    let url = URL(fileURLWithPath: wavPath)
    let audioFile: AVAudioFile
    do {
        audioFile = try AVAudioFile(forReading: url)
    } catch {
        return RunResult(
            ok: false,
            text: "",
            first_partial_ms: nil,
            final_after_end_ms: nil,
            on_device: requireOnDevice,
            requires_on_device: requireOnDevice,
            supports_on_device: supports,
            auth_status: authName,
            sample: sample,
            trial: trial,
            mode: mode,
            error: "failed to read wav"
        )
    }

    let frameCount = AVAudioFrameCount(audioFile.length)
    guard frameCount > 0,
          let full = AVAudioPCMBuffer(pcmFormat: audioFile.processingFormat, frameCapacity: frameCount)
    else {
        return RunResult(
            ok: false,
            text: "",
            first_partial_ms: nil,
            final_after_end_ms: nil,
            on_device: requireOnDevice,
            requires_on_device: requireOnDevice,
            supports_on_device: supports,
            auth_status: authName,
            sample: sample,
            trial: trial,
            mode: mode,
            error: "empty wav buffer"
        )
    }
    do {
        try audioFile.read(into: full)
    } catch {
        return RunResult(
            ok: false,
            text: "",
            first_partial_ms: nil,
            final_after_end_ms: nil,
            on_device: requireOnDevice,
            requires_on_device: requireOnDevice,
            supports_on_device: supports,
            auth_status: authName,
            sample: sample,
            trial: trial,
            mode: mode,
            error: "failed to decode wav"
        )
    }

    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.requiresOnDeviceRecognition = requireOnDevice

    let lock = NSLock()
    var firstPartialMs: Int?
    var finalAfterEndMs: Int?
    var lastText = ""
    var finished = false
    var recError: String?
    var tEnd = DispatchTime.now()
    var t0 = DispatchTime.now()

    let task = recognizer.recognitionTask(with: request) { result, error in
        lock.lock()
        defer { lock.unlock() }
        if let result {
            let text = result.bestTranscription.formattedString
            if !text.isEmpty {
                lastText = text
                if firstPartialMs == nil {
                    firstPartialMs = Int(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1_000_000
                }
            }
            if result.isFinal {
                finalAfterEndMs = Int(DispatchTime.now().uptimeNanoseconds - tEnd.uptimeNanoseconds) / 1_000_000
                finished = true
            }
        }
        if let error {
            recError = error.localizedDescription
            finished = true
        }
    }

    let framesPerChunk = max(AVAudioFrameCount(full.format.sampleRate * 0.1), 1)
    var offset: AVAudioFrameCount = 0
    t0 = DispatchTime.now()
    while offset < full.frameLength {
        let count = min(framesPerChunk, full.frameLength - offset)
        if let chunk = sliceBuffer(full, start: offset, count: count) {
            request.append(chunk)
        }
        offset += count
        Thread.sleep(forTimeInterval: 0.1)
    }
    tEnd = DispatchTime.now()
    request.endAudio()

    let deadline = Date().addingTimeInterval(max(8.0, Double(full.frameLength) / full.format.sampleRate + 8.0))
    while Date() < deadline {
        lock.lock()
        let done = finished
        lock.unlock()
        if done { break }
        RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
    }

    lock.lock()
    let text = lastText
    let first = firstPartialMs
    var finalMs = finalAfterEndMs
    let err = recError
    let done = finished
    lock.unlock()
    task.cancel()

    if !done && finalMs == nil {
        finalMs = Int(DispatchTime.now().uptimeNanoseconds - tEnd.uptimeNanoseconds) / 1_000_000
    }

    if let err, text.isEmpty {
        return RunResult(
            ok: false,
            text: "",
            first_partial_ms: first,
            final_after_end_ms: finalMs,
            on_device: requireOnDevice,
            requires_on_device: requireOnDevice,
            supports_on_device: supports,
            auth_status: authName,
            sample: sample,
            trial: trial,
            mode: mode,
            error: err
        )
    }

    return RunResult(
        ok: !text.isEmpty,
        text: text,
        first_partial_ms: first,
        final_after_end_ms: finalMs,
        on_device: requireOnDevice,
        requires_on_device: requireOnDevice,
        supports_on_device: supports,
        auth_status: authName,
        sample: sample,
        trial: trial,
        mode: mode,
        error: text.isEmpty ? (err ?? "no transcript") : err
    )
}

let outPath = opt("--out")
touchStarted(outPath)

if hasFlag("--probe") {
    let auth = requestSpeechAuth(timeoutSeconds: 120)
    let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
    let ok = auth == .authorized
    writeJSON(
        ProbeResult(
            ok: ok,
            authorized: ok,
            auth_status: authStatusName(auth),
            locale: "zh-CN",
            supports_on_device: recognizer?.supportsOnDeviceRecognition,
            error: ok ? nil : "permission not granted"
        ),
        to: outPath
    )
    exit(ok ? 0 : 1)
}

guard let wav = opt("--wav") else {
    FileHandle.standardError.write(Data("usage: AppleSTTProbe --wav PATH [--on-device true|false] [--out PATH] [--job JSON]\n".utf8))
    exit(2)
}

let requireOnDevice = boolOpt(opt("--on-device", jobKey: "on_device"), default: true)
let sample = opt("--sample")
let trial = Int(opt("--trial") ?? "")
let result = runRecognition(wavPath: wav, requireOnDevice: requireOnDevice, sample: sample, trial: trial)
writeJSON(result, to: outPath)
exit(result.ok ? 0 : 1)
