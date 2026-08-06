/**
 * Book Ch6 offline statistical helpers for eval/judge scores.
 * Deterministic bootstrap with fixed PRNG seed — no network, no deps.
 */

export interface BootstrapMeanResult {
  mean: number;
  ciLow: number;
  ciHigh: number;
  n: number;
  samples: number;
  /** Confidence level used (e.g. 0.95). */
  level: number;
}

export interface PairedBootstrapResult {
  meanDiff: number;
  ciLow: number;
  ciHigh: number;
  /** True when 0 is outside the CI (two-sided at given level). */
  significant: boolean;
  n: number;
  samples: number;
  level: number;
}

/** Mulberry32 — small deterministic PRNG. */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function meanOf(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const w = idx - lo;
  return sorted[lo]! * (1 - w) + sorted[hi]! * w;
}

export interface BootstrapOptions {
  /** Resample count (default 1000). */
  samples?: number;
  /** Confidence level in (0,1), default 0.95. */
  level?: number;
  /** PRNG seed for reproducibility (default 42). */
  seed?: number;
}

/**
 * Bootstrap percentile CI for the mean of a score list.
 */
export function bootstrapMean(
  scores: number[],
  options?: BootstrapOptions,
): BootstrapMeanResult {
  const n = scores.length;
  const samples = options?.samples ?? 1000;
  const level = options?.level ?? 0.95;
  const seed = options?.seed ?? 42;
  const mean = meanOf(scores);

  if (n === 0) {
    return { mean: 0, ciLow: 0, ciHigh: 0, n: 0, samples, level };
  }
  if (n === 1) {
    return { mean, ciLow: mean, ciHigh: mean, n, samples, level };
  }

  const rand = mulberry32(seed);
  const boots: number[] = [];
  for (let b = 0; b < samples; b += 1) {
    let s = 0;
    for (let i = 0; i < n; i += 1) {
      const j = Math.floor(rand() * n);
      s += scores[j]!;
    }
    boots.push(s / n);
  }
  boots.sort((a, b) => a - b);
  const alpha = 1 - level;
  const ciLow = percentile(boots, alpha / 2);
  const ciHigh = percentile(boots, 1 - alpha / 2);
  return { mean, ciLow, ciHigh, n, samples, level };
}

/**
 * Paired bootstrap of mean(a[i] - b[i]). Significant when 0 ∉ CI.
 */
export function pairedBootstrapDiff(
  a: number[],
  b: number[],
  options?: BootstrapOptions,
): PairedBootstrapResult {
  if (a.length !== b.length) {
    throw new Error(
      `pairedBootstrapDiff: length mismatch ${a.length} vs ${b.length}`,
    );
  }
  const n = a.length;
  const samples = options?.samples ?? 1000;
  const level = options?.level ?? 0.95;
  const seed = options?.seed ?? 42;
  const diffs = a.map((x, i) => x - b[i]!);
  const meanDiff = meanOf(diffs);

  if (n === 0) {
    return {
      meanDiff: 0,
      ciLow: 0,
      ciHigh: 0,
      significant: false,
      n: 0,
      samples,
      level,
    };
  }
  if (n === 1) {
    return {
      meanDiff,
      ciLow: meanDiff,
      ciHigh: meanDiff,
      significant: meanDiff !== 0,
      n,
      samples,
      level,
    };
  }

  const rand = mulberry32(seed);
  const boots: number[] = [];
  for (let bIdx = 0; bIdx < samples; bIdx += 1) {
    let s = 0;
    for (let i = 0; i < n; i += 1) {
      const j = Math.floor(rand() * n);
      s += diffs[j]!;
    }
    boots.push(s / n);
  }
  boots.sort((x, y) => x - y);
  const alpha = 1 - level;
  const ciLow = percentile(boots, alpha / 2);
  const ciHigh = percentile(boots, 1 - alpha / 2);
  const significant = ciLow > 0 || ciHigh < 0;
  return { meanDiff, ciLow, ciHigh, significant, n, samples, level };
}

/** Format bootstrap mean for CLI one-liners. */
export function formatBootstrapMean(r: BootstrapMeanResult): string {
  const pct = Math.round(r.level * 100);
  return `mean=${r.mean.toFixed(3)} ${pct}%CI=[${r.ciLow.toFixed(3)}, ${r.ciHigh.toFixed(3)}] n=${r.n} boot=${r.samples}`;
}
