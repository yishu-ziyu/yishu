import AudioToolbox
import AVFoundation
import Foundation

enum YishuSpeechPlaybackSignal: Equatable, Sendable {
    case dataConsumed
    case dataRendered
    case dataPlayedBack
}

/// Completes a clip only when the last scheduled buffer reports `.dataPlayedBack`.
/// `stop()` bumps the generation so a later callback from the cancelled clip is ignored.
struct YishuSpeechClipGate: Equatable, Sendable {
    private(set) var generation: UInt64 = 0
    private(set) var scheduled = 0
    private(set) var playedBack = 0
    private(set) var parseFinished = false

    var isComplete: Bool {
        parseFinished && playedBack >= scheduled
    }

    mutating func reset(generation: UInt64) {
        self.generation = generation
        scheduled = 0
        playedBack = 0
        parseFinished = false
    }

    mutating func noteScheduled() {
        scheduled += 1
    }

    mutating func noteParseFinished() {
        parseFinished = true
    }

    mutating func stop() {
        generation &+= 1
        scheduled = 0
        playedBack = 0
        parseFinished = false
    }

    mutating func noteCallback(
        _ signal: YishuSpeechPlaybackSignal,
        generation: UInt64
    ) {
        guard generation == self.generation else { return }
        guard signal == .dataPlayedBack else { return }
        playedBack = min(scheduled, playedBack + 1)
    }
}

enum YishuSpeechSilenceTrim {
    static let windowMs = 10
    static let threshold: Float = 0.01
    static let keepLeadingMs = 80
    static let keepTrailingMs = 200

    static func framesForMs(_ ms: Int, sampleRate: Double) -> Int {
        max(0, Int((sampleRate * Double(ms) / 1000.0).rounded()))
    }

    static func milliseconds(frames: Int, sampleRate: Double) -> Int {
        guard sampleRate > 0 else { return 0 }
        return Int((Double(frames) / sampleRate * 1000.0).rounded())
    }

    static func rms(_ samples: [Float], start: Int, count: Int) -> Float {
        guard count > 0 else { return 0 }
        var sum: Float = 0
        let end = start + count
        var index = start
        while index < end {
            let sample = samples[index]
            sum += sample * sample
            index += 1
        }
        return sqrt(sum / Float(count))
    }

    static func keptRange(samples: [Float], sampleRate: Double) -> Range<Int> {
        keptRange(frameCount: samples.count, sampleRate: sampleRate) { start, count in
            rms(samples, start: start, count: count)
        }
    }

    static func keptRange(
        frameCount: Int,
        sampleRate: Double,
        rmsOfWindow: (_ start: Int, _ count: Int) -> Float
    ) -> Range<Int> {
        guard frameCount > 0 else { return 0..<0 }
        let windowFrames = max(1, framesForMs(windowMs, sampleRate: sampleRate))
        var firstLoud: Int?
        var lastLoudEnd: Int?
        var start = 0
        while start < frameCount {
            let count = min(windowFrames, frameCount - start)
            if rmsOfWindow(start, count) >= threshold {
                if firstLoud == nil { firstLoud = start }
                lastLoudEnd = start + count
            }
            start += windowFrames
        }
        guard let first = firstLoud, let last = lastLoudEnd else {
            return 0..<0
        }
        let lower = max(0, first - framesForMs(keepLeadingMs, sampleRate: sampleRate))
        let upper = min(frameCount, last + framesForMs(keepTrailingMs, sampleRate: sampleRate))
        return lower..<upper
    }

    static func trim(samples: [Float], sampleRate: Double) -> [Float] {
        Array(samples[keptRange(samples: samples, sampleRate: sampleRate)])
    }
}

struct YishuSpeechClipHooks {
    var onFirstAudio: () -> Void = {}
    var onClipGap: (Int) -> Void = { _ in }
    /// Fires once per clip whose last buffer really played back (not on stop/failure).
    var onClipDone: (YishuSpeechClipStats) -> Void = { _ in }
}

struct YishuSpeechClipStats: Equatable, Sendable {
    var decodedDurationMs: Int = 0
    var leadingTrimmedMs: Int = 0
    var trailingTrimmedMs: Int = 0
    var scheduleToPlayedBackMs: Int = 0
    var gapMs: Int? = nil

    /// What was actually scheduled after trimming; `scheduleToPlayedBackMs` must cover it.
    var trimmedDurationMs: Int {
        max(0, decodedDurationMs - leadingTrimmedMs - trailingTrimmedMs)
    }
}

/// One AVAudioEngine + AVAudioPlayerNode for every TTS clip. The node stays
/// running across sentences so the next clip can schedule without teardown.
final class YishuSpeechClipPlayer: @unchecked Sendable {
    var hooks = YishuSpeechClipHooks()
    private(set) var lastStats = YishuSpeechClipStats()

    private let engine = AVAudioEngine()
    private let playerNode = AVAudioPlayerNode()
    private let engineQueue: DispatchQueue
    private let engineKey = DispatchSpecificKey<UInt8>()
    private let lock = NSLock()

    private var connectedFormat: AVAudioFormat?
    private var nodeIsPlaying = false
    private var clipInFlight = false
    private var generation: UInt64 = 0
    private var gate = YishuSpeechClipGate()
    private var playContinuation: CheckedContinuation<Void, any Error>?
    private var firstScheduledAt: DispatchTime?
    private var lastPlayedBackAt: DispatchTime?
    private var firstBufferScheduled = false

    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    var isPlaying: Bool {
        withLock { nodeIsPlaying && clipInFlight }
    }

    init() {
        engineQueue = DispatchQueue(label: "yishu.speech.clip")
        engineQueue.setSpecific(key: engineKey, value: 1)
        engine.attach(playerNode)
    }

    func play(data: Data) async throws {
        let (stream, continuation) = AsyncStream<Data>.makeStream()
        continuation.yield(data)
        continuation.finish()
        try await play(chunks: stream)
    }

    func play(chunks: AsyncStream<Data>) async throws {
        try await withTaskCancellationHandler {
            try await self.playClip(chunks: chunks)
        } onCancel: {
            self.stop()
        }
    }

    func stop() {
        lock.lock()
        generation &+= 1
        gate.stop()
        clipInFlight = false
        let continuation = playContinuation
        playContinuation = nil
        lock.unlock()
        onEngine {
            if self.playerNode.isPlaying {
                self.playerNode.stop()
            }
            self.lock.lock()
            self.nodeIsPlaying = false
            self.lock.unlock()
        }
        continuation?.resume(throwing: CancellationError())
    }

    private func playClip(chunks: AsyncStream<Data>) async throws {
        let clipGeneration = beginClip()
        let decoder = YishuMPEGPCMDecoder()
        let holdBack = YishuSpeechHoldBack()
        var decodedDuration: TimeInterval = 0

        decoder.onFormat = { [weak self] format in
            guard let self else { return }
            do {
                try self.ensureGraph(format: format, generation: clipGeneration)
            } catch {
                self.failClip(generation: clipGeneration, error: error)
            }
        }
        decoder.onPCM = { [weak self] buffer in
            guard let self else { return }
            let live = self.withLock { self.clipInFlight && self.generation == clipGeneration }
            guard live else { return }
            if let released = holdBack.ingest(buffer) {
                self.schedule(released, generation: clipGeneration)
            }
        }

        do {
            for await chunk in chunks {
                try Task.checkCancellation()
                try throwIfCancelled(generation: clipGeneration)
                try decoder.append(chunk)
            }
            try throwIfCancelled(generation: clipGeneration)
            try decoder.finish()
        } catch {
            decoder.close()
            if error is CancellationError {
                stop()
                throw error
            }
            failClip(generation: clipGeneration, error: error)
            throw error
        }
        decoder.close()

        try throwIfCancelled(generation: clipGeneration)
        let remainder = holdBack.finish()
        decodedDuration = withLock {
            lastStats.decodedDurationMs = holdBack.decodedDurationMs
            lastStats.leadingTrimmedMs = holdBack.leadingTrimmedMs
            lastStats.trailingTrimmedMs = holdBack.trailingTrimmedMs
            return Double(lastStats.decodedDurationMs) / 1000.0
        }

        if let remainder {
            schedule(remainder, generation: clipGeneration)
        }

        let alreadyDone: YishuSpeechClipStats? = withLock {
            gate.noteParseFinished()
            guard gate.isComplete, generation == clipGeneration else { return nil }
            let now = DispatchTime.now()
            lastPlayedBackAt = now
            if let first = firstScheduledAt {
                lastStats.scheduleToPlayedBackMs = Int(
                    (now.uptimeNanoseconds &- first.uptimeNanoseconds) / 1_000_000
                )
            }
            clipInFlight = false
            return lastStats
        }
        if let alreadyDone {
            // Every scheduled buffer played back before the stream ended (or nothing was
            // audible); an all-silent clip reports nothing.
            if alreadyDone.trimmedDurationMs > 0 {
                hooks.onClipDone(alreadyDone)
            }
            return
        }

        let timeout = min(max(decodedDuration + 5, 10), 90)
        let watchdog = Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            } catch {
                return
            }
            self?.failClip(
                generation: clipGeneration,
                error: NSError(
                    domain: "YishuTTS",
                    code: -5,
                    userInfo: [NSLocalizedDescriptionKey: "TTS 音频播放超时"]
                )
            )
        }
        defer { watchdog.cancel() }
        try await waitForPlayback(generation: clipGeneration)
    }

    private func beginClip() -> UInt64 {
        lock.lock()
        generation &+= 1
        let clipGeneration = generation
        gate.reset(generation: clipGeneration)
        clipInFlight = true
        firstBufferScheduled = false
        firstScheduledAt = nil
        lastStats = YishuSpeechClipStats()
        playContinuation = nil
        lock.unlock()
        return clipGeneration
    }

    private func throwIfCancelled(generation: UInt64) throws {
        try Task.checkCancellation()
        let cancelled = withLock { !clipInFlight || self.generation != generation }
        if cancelled { throw CancellationError() }
    }

    private func schedule(_ buffer: AVAudioPCMBuffer, generation clipGeneration: UInt64) {
        guard buffer.frameLength > 0 else { return }
        var shouldEmitFirst = false
        var gapMs: Int?
        onEngine {
            self.lock.lock()
            guard self.clipInFlight, self.generation == clipGeneration else {
                self.lock.unlock()
                return
            }
            if !self.firstBufferScheduled {
                self.firstBufferScheduled = true
                let now = DispatchTime.now()
                self.firstScheduledAt = now
                if let previous = self.lastPlayedBackAt {
                    let gap = Int((now.uptimeNanoseconds &- previous.uptimeNanoseconds) / 1_000_000)
                    gapMs = max(0, gap)
                    self.lastStats.gapMs = gapMs
                }
                shouldEmitFirst = self.nodeIsPlaying || self.playerNode.isPlaying
            }
            self.gate.noteScheduled()
            let capturedGeneration = clipGeneration
            self.lock.unlock()

            self.playerNode.scheduleBuffer(
                buffer,
                completionCallbackType: .dataPlayedBack
            ) { [weak self] type in
                self?.handleCallback(type, generation: capturedGeneration)
            }
        }
        if let gapMs {
            hooks.onClipGap(gapMs)
        }
        if shouldEmitFirst {
            hooks.onFirstAudio()
        }
    }

    private func handleCallback(
        _ type: AVAudioPlayerNodeCompletionCallbackType,
        generation clipGeneration: UInt64
    ) {
        let signal: YishuSpeechPlaybackSignal
        switch type {
        case .dataConsumed:
            signal = .dataConsumed
        case .dataRendered:
            signal = .dataRendered
        case .dataPlayedBack:
            signal = .dataPlayedBack
        @unknown default:
            return
        }

        lock.lock()
        guard clipInFlight, generation == clipGeneration else {
            lock.unlock()
            return
        }
        gate.noteCallback(signal, generation: clipGeneration)
        let done = gate.isComplete
        if done {
            let now = DispatchTime.now()
            lastPlayedBackAt = now
            if let first = firstScheduledAt {
                lastStats.scheduleToPlayedBackMs = Int(
                    (now.uptimeNanoseconds &- first.uptimeNanoseconds) / 1_000_000
                )
            }
            clipInFlight = false
        }
        let continuation = done ? playContinuation : nil
        if done { playContinuation = nil }
        let stats = lastStats
        lock.unlock()
        if done {
            hooks.onClipDone(stats)
            continuation?.resume()
        }
    }

    private func waitForPlayback(generation clipGeneration: UInt64) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            let action = withLock { () -> Int in
                if self.generation != clipGeneration { return 1 }
                if gate.isComplete {
                    clipInFlight = false
                    return 2
                }
                playContinuation = continuation
                return 0
            }
            switch action {
            case 1:
                continuation.resume(throwing: CancellationError())
            case 2:
                continuation.resume()
            default:
                break
            }
        }
    }

    private func failClip(generation clipGeneration: UInt64, error: Error) {
        lock.lock()
        guard self.generation == clipGeneration else {
            lock.unlock()
            return
        }
        generation &+= 1
        gate.stop()
        clipInFlight = false
        let continuation = playContinuation
        playContinuation = nil
        lock.unlock()
        onEngine {
            if self.playerNode.isPlaying {
                self.playerNode.stop()
            }
            self.lock.lock()
            self.nodeIsPlaying = false
            self.lock.unlock()
        }
        continuation?.resume(throwing: error)
    }

    private func ensureGraph(format: AVAudioFormat, generation clipGeneration: UInt64) throws {
        var thrown: Error?
        onEngine {
            do {
                try self.ensureGraphLocked(format: format, generation: clipGeneration)
            } catch {
                thrown = error
            }
        }
        if let thrown { throw thrown }
    }

    private func ensureGraphLocked(format: AVAudioFormat, generation clipGeneration: UInt64) throws {
        lock.lock()
        let live = clipInFlight && generation == clipGeneration
        lock.unlock()
        guard live else { return }

        let same = connectedFormat.map {
            $0.sampleRate == format.sampleRate
                && $0.channelCount == format.channelCount
                && $0.commonFormat == format.commonFormat
        } ?? false

        if !same {
            if playerNode.isPlaying {
                playerNode.stop()
            }
            if connectedFormat != nil {
                engine.disconnectNodeOutput(playerNode)
            }
            engine.connect(playerNode, to: engine.mainMixerNode, format: format)
            connectedFormat = format
        }

        if !engine.isRunning {
            engine.prepare()
            try engine.start()
        }
        if !playerNode.isPlaying {
            playerNode.play()
        }
        lock.lock()
        nodeIsPlaying = playerNode.isPlaying
        lock.unlock()
    }

    private func onEngine(_ body: @escaping () -> Void) {
        if DispatchQueue.getSpecific(key: engineKey) != nil {
            body()
        } else {
            engineQueue.sync(execute: body)
        }
    }
}

/// Holds the most recent 2 s of decoded PCM so trailing silence can be trimmed
/// after the stream ends, while still scheduling older audio as it arrives.
private final class YishuSpeechHoldBack {
    // ponytail: 2.0 s hold-back ceiling (if a vendor ever pads more than 2 s, the excess plays).
    static let holdBackSeconds: Double = 2.0
    static let leadingGiveUpMs = 500

    private var format: AVAudioFormat?
    private var channels: [[Float]] = []
    private var head = 0
    private var foundLoud = false
    private(set) var leadingTrimmedMs = 0
    private(set) var trailingTrimmedMs = 0
    private(set) var decodedFrames = 0

    var sampleRate: Double { format?.sampleRate ?? 0 }
    var pendingFrames: Int { (channels.first?.count ?? 0) - head }
    var decodedDurationMs: Int {
        YishuSpeechSilenceTrim.milliseconds(frames: decodedFrames, sampleRate: sampleRate)
    }

    func ingest(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        append(buffer)
        decodedFrames += Int(buffer.frameLength)
        applyLeadingIfNeeded()
        guard foundLoud else { return nil }
        return releaseOverflow()
    }

    func finish() -> AVAudioPCMBuffer? {
        applyLeadingIfNeeded()
        if !foundLoud {
            trailingTrimmedMs = YishuSpeechSilenceTrim.milliseconds(
                frames: pendingFrames,
                sampleRate: sampleRate
            )
            channels.removeAll()
            head = 0
            return nil
        }
        applyTrailing()
        return takeAllPending()
    }

    private func append(_ buffer: AVAudioPCMBuffer) {
        let frames = Int(buffer.frameLength)
        guard frames > 0, let source = buffer.floatChannelData else { return }
        if format == nil {
            format = buffer.format
        }
        let channelCount = Int(buffer.format.channelCount)
        if channels.isEmpty {
            channels = Array(repeating: [], count: max(channelCount, 1))
        }
        for channel in 0..<min(channelCount, channels.count) {
            channels[channel].append(contentsOf: UnsafeBufferPointer(start: source[channel], count: frames))
        }
    }

    private func applyLeadingIfNeeded() {
        guard !foundLoud, pendingFrames > 0 else { return }
        if let firstLoud = firstLoudWindowStart() {
            let keep = YishuSpeechSilenceTrim.framesForMs(
                YishuSpeechSilenceTrim.keepLeadingMs,
                sampleRate: sampleRate
            )
            let drop = max(0, firstLoud - keep)
            dropPrefix(drop)
            leadingTrimmedMs = YishuSpeechSilenceTrim.milliseconds(frames: drop, sampleRate: sampleRate)
            foundLoud = true
            return
        }
        let giveUp = YishuSpeechSilenceTrim.framesForMs(Self.leadingGiveUpMs, sampleRate: sampleRate)
        if pendingFrames >= giveUp {
            foundLoud = true
        }
    }

    private func applyTrailing() {
        let count = pendingFrames
        guard count > 0 else { return }
        let window = max(1, YishuSpeechSilenceTrim.framesForMs(
            YishuSpeechSilenceTrim.windowMs,
            sampleRate: sampleRate
        ))
        var lastLoudEnd: Int?
        var start = 0
        while start < count {
            let windowCount = min(window, count - start)
            if windowRMS(start: start, count: windowCount) >= YishuSpeechSilenceTrim.threshold {
                lastLoudEnd = start + windowCount
            }
            start += window
        }
        let keep = YishuSpeechSilenceTrim.framesForMs(
            YishuSpeechSilenceTrim.keepTrailingMs,
            sampleRate: sampleRate
        )
        let keepUntil = lastLoudEnd.map { min(count, $0 + keep) } ?? 0
        let drop = count - keepUntil
        trailingTrimmedMs = YishuSpeechSilenceTrim.milliseconds(frames: drop, sampleRate: sampleRate)
        if drop > 0 {
            let keepAbsolute = (channels.first?.count ?? 0) - drop
            for index in channels.indices {
                if keepAbsolute <= head {
                    channels[index].removeAll()
                } else {
                    channels[index].removeLast(drop)
                }
            }
            if (channels.first?.count ?? 0) <= head {
                channels.removeAll()
                head = 0
            }
        }
    }

    private func releaseOverflow() -> AVAudioPCMBuffer? {
        let hold = Int((sampleRate * Self.holdBackSeconds).rounded())
        let overflow = pendingFrames - hold
        guard overflow > 0 else { return nil }
        return takePrefix(overflow)
    }

    private func takeAllPending() -> AVAudioPCMBuffer? {
        takePrefix(pendingFrames)
    }

    private func takePrefix(_ count: Int) -> AVAudioPCMBuffer? {
        guard count > 0 else { return nil }
        let buffer = makeBuffer(offset: head, count: count)
        dropPrefix(count)
        return buffer
    }

    private func dropPrefix(_ count: Int) {
        guard count > 0 else { return }
        head += min(count, pendingFrames)
        compactIfNeeded()
    }

    private func compactIfNeeded() {
        let compactAfter = max(1, Int(sampleRate))
        guard head >= compactAfter else { return }
        for index in channels.indices {
            channels[index].removeFirst(min(head, channels[index].count))
        }
        head = 0
    }

    private func firstLoudWindowStart() -> Int? {
        let count = pendingFrames
        let window = max(1, YishuSpeechSilenceTrim.framesForMs(
            YishuSpeechSilenceTrim.windowMs,
            sampleRate: sampleRate
        ))
        var start = 0
        while start < count {
            let windowCount = min(window, count - start)
            if windowRMS(start: start, count: windowCount) >= YishuSpeechSilenceTrim.threshold {
                return start
            }
            start += window
        }
        return nil
    }

    private func windowRMS(start: Int, count: Int) -> Float {
        var loudest: Float = 0
        for channel in channels {
            let absolute = head + start
            guard absolute + count <= channel.count else { continue }
            loudest = max(loudest, YishuSpeechSilenceTrim.rms(channel, start: absolute, count: count))
        }
        return loudest
    }

    private func makeBuffer(offset: Int, count: Int) -> AVAudioPCMBuffer? {
        guard count > 0,
              let format,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count))
        else { return nil }
        buffer.frameLength = AVAudioFrameCount(count)
        guard let destination = buffer.floatChannelData else { return nil }
        for channel in 0..<min(channels.count, Int(format.channelCount)) {
            channels[channel].withUnsafeBufferPointer { source in
                destination[channel].update(from: source.baseAddress! + offset, count: count)
            }
        }
        return buffer
    }
}

/// MiniMax's first hex chunk may start with an ID3v2 tag; AudioFileStream skips it.
private final class YishuMPEGPCMDecoder {
    var onFormat: ((AVAudioFormat) -> Void)?
    var onPCM: ((AVAudioPCMBuffer) -> Void)?

    private var fileStream: AudioFileStreamID?
    private var compressedFormat: AVAudioFormat?
    private var pcmFormat: AVAudioFormat?
    private var converter: AVAudioConverter?
    private var maxPacketSize = 1
    private var didEmitFormat = false
    private var receivedBytes = false
    private var formatError: Error?

    deinit {
        close()
    }

    func append(_ data: Data) throws {
        if fileStream == nil {
            try open()
        }
        guard let stream = fileStream, !data.isEmpty else { return }
        receivedBytes = true
        let status = data.withUnsafeBytes { raw -> OSStatus in
            guard let base = raw.baseAddress else { return noErr }
            return AudioFileStreamParseBytes(stream, UInt32(data.count), base, [])
        }
        if let formatError { throw formatError }
        guard status == noErr else {
            throw NSError(
                domain: "YishuTTS",
                code: -10,
                userInfo: [NSLocalizedDescriptionKey: "TTS 流式解析失败"]
            )
        }
    }

    func finish() throws {
        if let stream = fileStream {
            AudioFileStreamParseBytes(stream, 0, nil, [])
        }
        if let formatError { throw formatError }
        if receivedBytes && !didEmitFormat {
            throw NSError(
                domain: "YishuTTS",
                code: -10,
                userInfo: [NSLocalizedDescriptionKey: "TTS 流式解析失败"]
            )
        }
        flushConverter()
    }

    func close() {
        if let stream = fileStream {
            AudioFileStreamClose(stream)
            fileStream = nil
        }
        converter = nil
    }

    private func open() throws {
        var stream: AudioFileStreamID?
        let status = AudioFileStreamOpen(
            Unmanaged.passUnretained(self).toOpaque(),
            yishuSpeechClipPropertyListener,
            yishuSpeechClipPacketsListener,
            kAudioFileMP3Type,
            &stream
        )
        guard status == noErr, let stream else {
            throw NSError(
                domain: "YishuTTS",
                code: -10,
                userInfo: [NSLocalizedDescriptionKey: "TTS 流式解析失败"]
            )
        }
        fileStream = stream
    }

    fileprivate func handleProperty(_ propertyID: AudioFileStreamPropertyID) {
        guard propertyID == kAudioFileStreamProperty_ReadyToProducePackets, !didEmitFormat else { return }
        guard let stream = fileStream else { return }

        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        let status = AudioFileStreamGetProperty(
            stream,
            kAudioFileStreamProperty_DataFormat,
            &size,
            &asbd
        )
        guard status == noErr else { return }

        var packetSize: UInt32 = 0
        var packetSizeSize = UInt32(MemoryLayout<UInt32>.size)
        if AudioFileStreamGetProperty(
            stream,
            kAudioFileStreamProperty_MaximumPacketSize,
            &packetSizeSize,
            &packetSize
        ) != noErr || packetSize == 0 {
            var upper: UInt32 = 0
            var upperSize = UInt32(MemoryLayout<UInt32>.size)
            AudioFileStreamGetProperty(
                stream,
                kAudioFileStreamProperty_PacketSizeUpperBound,
                &upperSize,
                &upper
            )
            packetSize = upper
        }
        maxPacketSize = Int(max(packetSize, 1))

        guard let compressed = AVAudioFormat(streamDescription: &asbd),
              let pcm = AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: asbd.mSampleRate,
                channels: asbd.mChannelsPerFrame,
                interleaved: false
              ),
              let converter = AVAudioConverter(from: compressed, to: pcm)
        else {
            formatError = NSError(
                domain: "YishuTTS",
                code: -4,
                userInfo: [NSLocalizedDescriptionKey: "TTS 音频解码失败"]
            )
            return
        }

        compressedFormat = compressed
        pcmFormat = pcm
        self.converter = converter
        didEmitFormat = true
        onFormat?(pcm)
    }

    fileprivate func handlePackets(
        numberBytes: UInt32,
        numberPackets: UInt32,
        inputData: UnsafeRawPointer,
        packetDescriptions: UnsafeMutablePointer<AudioStreamPacketDescription>?
    ) {
        guard numberBytes > 0, numberPackets > 0,
              let compressedFormat,
              let pcmFormat,
              let converter
        else { return }

        let maximumPacketSize = max(maxPacketSize, Int(numberBytes))
        let compressed = AVAudioCompressedBuffer(
            format: compressedFormat,
            packetCapacity: AVAudioPacketCount(numberPackets),
            maximumPacketSize: maximumPacketSize
        )

        memcpy(compressed.data, inputData, Int(numberBytes))
        compressed.byteLength = numberBytes
        compressed.packetCount = AVAudioPacketCount(numberPackets)
        if let packetDescriptions, let destination = compressed.packetDescriptions {
            destination.update(from: packetDescriptions, count: Int(numberPackets))
        }

        let framesPerPacket = max(compressedFormat.streamDescription.pointee.mFramesPerPacket, 1152)
        let capacity = AVAudioFrameCount(framesPerPacket * numberPackets + 1152)
        guard let pcm = AVAudioPCMBuffer(pcmFormat: pcmFormat, frameCapacity: capacity) else { return }

        var handed = false
        while true {
            var error: NSError?
            pcm.frameLength = 0
            let status = converter.convert(to: pcm, error: &error) { _, outStatus in
                if handed {
                    outStatus.pointee = .noDataNow
                    return nil
                }
                handed = true
                outStatus.pointee = .haveData
                return compressed
            }
            switch status {
            case .haveData, .inputRanDry:
                if pcm.frameLength > 0 {
                    onPCM?(pcm)
                }
                if status == .inputRanDry { return }
            case .endOfStream:
                if pcm.frameLength > 0 {
                    onPCM?(pcm)
                }
                return
            case .error:
                return
            @unknown default:
                return
            }
            if pcm.frameLength == 0 { return }
        }
    }

    private func flushConverter() {
        guard let converter, let pcmFormat else { return }
        let framesPerPacket = max(compressedFormat?.streamDescription.pointee.mFramesPerPacket ?? 1152, 1152)
        guard let pcm = AVAudioPCMBuffer(pcmFormat: pcmFormat, frameCapacity: framesPerPacket * 4) else { return }
        while true {
            var error: NSError?
            pcm.frameLength = 0
            let status = converter.convert(to: pcm, error: &error) { _, outStatus in
                outStatus.pointee = .endOfStream
                return nil
            }
            if pcm.frameLength > 0 {
                onPCM?(pcm)
            }
            if status != .haveData { break }
        }
    }
}

private func yishuSpeechClipPropertyListener(
    _ clientData: UnsafeMutableRawPointer,
    _ inAudioFileStream: AudioFileStreamID,
    _ inPropertyID: AudioFileStreamPropertyID,
    _ ioFlags: UnsafeMutablePointer<AudioFileStreamPropertyFlags>
) {
    _ = inAudioFileStream
    _ = ioFlags
    let decoder = Unmanaged<YishuMPEGPCMDecoder>.fromOpaque(clientData).takeUnretainedValue()
    decoder.handleProperty(inPropertyID)
}

private func yishuSpeechClipPacketsListener(
    _ clientData: UnsafeMutableRawPointer,
    _ inNumberBytes: UInt32,
    _ inNumberPackets: UInt32,
    _ inInputData: UnsafeRawPointer,
    _ inPacketDescriptions: UnsafeMutablePointer<AudioStreamPacketDescription>?
) {
    let decoder = Unmanaged<YishuMPEGPCMDecoder>.fromOpaque(clientData).takeUnretainedValue()
    decoder.handlePackets(
        numberBytes: inNumberBytes,
        numberPackets: inNumberPackets,
        inputData: inInputData,
        packetDescriptions: inPacketDescriptions
    )
}
