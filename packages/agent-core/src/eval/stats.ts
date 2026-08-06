/**
 * Book Ch6 statistical significance lite.
 *
 * Offline heuristics for small-n agent evals (not a full frequentist suite).
 * Wilson score interval for binomial proportions; simple non-overlap / large-delta
 * rule for comparing two pass rates.
 */

export interface WilsonInterval {
  /** Lower bound of the interval (clamped to [0, 1]). */
  low: number;
  /** Upper bound of the interval (clamped to [0, 1]). */
  high: number;
  /** Sample mean successes / n (0 when n === 0). */
  mean: number;
}

/**
 * Wilson score interval for a binomial proportion.
 *
 * @param successes number of passes (clamped to [0, n])
 * @param n         total trials
 * @param z         normal critical value (default 1.96 ≈ 95%)
 */
export function binomialWilsonInterval(
  successes: number,
  n: number,
  z = 1.96,
): WilsonInterval {
  if (!Number.isFinite(n) || n <= 0) {
    return { low: 0, high: 1, mean: 0 };
  }
  const s = Math.min(Math.max(0, successes), n);
  const p = s / n;
  const z2 = z * z;
  const den = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / den;
  const margin =
    (z / den) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const low = clamp01(center - margin);
  const high = clamp01(center + margin);
  return { low, high, mean: p };
}

export interface PassRateSample {
  pass: number;
  total: number;
}

export interface PassRateComparison {
  /** b.mean - a.mean */
  delta: number;
  aMean: number;
  bMean: number;
  /**
   * Offline heuristic (documented):
   * - true if Wilson 95% intervals do not overlap, OR
   * - true if |delta| >= 0.2 and both samples have total >= 5
   *
   * This is intentionally simple for small offline evals; not a p-value test.
   */
  significant: boolean;
  note: string;
}

/**
 * Compare two pass-rate samples with Wilson intervals + large-delta heuristic.
 */
export function comparePassRates(
  a: PassRateSample,
  b: PassRateSample,
): PassRateComparison {
  const aInt = binomialWilsonInterval(a.pass, a.total);
  const bInt = binomialWilsonInterval(b.pass, b.total);
  const delta = bInt.mean - aInt.mean;
  const noOverlap = aInt.high < bInt.low || bInt.high < aInt.low;
  const largeDelta =
    Math.abs(delta) >= 0.2 && a.total >= 5 && b.total >= 5;
  const significant = noOverlap || largeDelta;

  let note: string;
  if (noOverlap && largeDelta) {
    note =
      "Wilson 95% intervals do not overlap and |delta|>=0.2 with n>=5 (offline heuristic)";
  } else if (noOverlap) {
    note = "Wilson 95% intervals do not overlap";
  } else if (largeDelta) {
    note =
      "|delta|>=0.2 with both n>=5 (offline large-delta heuristic; intervals may still overlap)";
  } else {
    note =
      "not significant under offline heuristic (intervals overlap and |delta|<0.2 or n<5)";
  }

  return {
    delta,
    aMean: aInt.mean,
    bMean: bInt.mean,
    significant,
    note,
  };
}

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** Format a Wilson interval for CLI output, e.g. "60.0% [35.7%, 80.2%]". */
export function formatWilsonCi(
  successes: number,
  n: number,
  z = 1.96,
): string {
  const { low, high, mean } = binomialWilsonInterval(successes, n, z);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  return `${pct(mean)} [${pct(low)}, ${pct(high)}] (Wilson 95% CI, n=${n})`;
}
