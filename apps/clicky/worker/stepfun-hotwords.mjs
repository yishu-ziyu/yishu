// Shared, side-effect-free ASR hotword contract for the Wrangler and local
// worker entrypoints.  The app's provider mirrors these limits before sending
// a request, while the worker remains the final validation boundary.
export const MAX_STEPFUN_HOTWORDS = 50;
export const MAX_STEPFUN_HOTWORD_LENGTH = 64;

export function sanitizeStepFunHotwords(value) {
  // Missing hotwords preserve the pre-hotword request shape.  A present null,
  // scalar, or object is malformed and is rejected below.
  if (typeof value === "undefined") {
    return { ok: true };
  }

  if (!Array.isArray(value)) {
    return { ok: false, error: "hotwords must be an array of strings" };
  }

  if (value.length > MAX_STEPFUN_HOTWORDS) {
    return {
      ok: false,
      error: `hotwords must contain at most ${MAX_STEPFUN_HOTWORDS} items`,
    };
  }

  const seen = new Set();
  const hotwords = [];
  for (const [index, rawHotword] of value.entries()) {
    if (typeof rawHotword !== "string") {
      return {
        ok: false,
        error: `hotwords[${index}] must be a string`,
      };
    }

    const hotword = rawHotword.trim();
    if (!hotword) {
      return {
        ok: false,
        error: `hotwords[${index}] must not be empty`,
      };
    }

    if ([...hotword].length > MAX_STEPFUN_HOTWORD_LENGTH) {
      return {
        ok: false,
        error: `hotwords[${index}] must be at most ${MAX_STEPFUN_HOTWORD_LENGTH} characters`,
      };
    }

    const duplicateKey = hotword.toLowerCase();
    if (seen.has(duplicateKey)) continue;
    seen.add(duplicateKey);
    hotwords.push(hotword);
  }

  return hotwords.length > 0 ? { ok: true, hotwords } : { ok: true };
}

export function buildStepFunTranscriptionBody({
  audioBase64,
  format,
  sampleRate,
  language,
  model,
  hotwords,
}) {
  const transcription = {
    model,
    language,
    enable_itn: true,
  };
  if (hotwords && hotwords.length > 0) {
    transcription.hotwords = hotwords;
  }

  return {
    audio: {
      data: audioBase64,
      input: {
        transcription,
        format: {
          type: format,
          codec: "pcm_s16le",
          rate: sampleRate,
          bits: 16,
          channel: 1,
        },
      },
    },
  };
}
