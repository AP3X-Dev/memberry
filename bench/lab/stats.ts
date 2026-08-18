/**
 * Paired percentile bootstrap for the run-level context-efficiency proxy.
 *
 * Zero dependencies by design: the measuring stick must not depend on the
 * system under test. Honest caveat: at the current paired-probe counts
 * (n = 13 on the migrated retrieval lane) the interval is wide; the only
 * admissible remedy is adding probes in a future packet. Narrowing the
 * interval definition, lowering MIN_PAIRED_PROBES, or switching interval
 * types to obtain a favourable bound is prohibited and review-blocking.
 */

export const BOOTSTRAP_RESAMPLES = 2000;
export const BOOTSTRAP_LEVEL = 0.95;
/** Bound before observing which lanes pass it; never lowered to make a lane reportable. */
export const MIN_PAIRED_PROBES = 10;

/** One probe scored in both arms, matched on (scenarioId, probeId), in run order. */
export interface LabPairedProbe {
  scenarioId: string;
  probeId: string;
  controlCoverage: number;
  controlTokens: number;
  candidateCoverage: number;
  candidateTokens: number;
}

export interface LabBootstrapInterval {
  outcome: 'measured' | 'unsupported';
  unsupportedReason?: 'insufficient-paired-probes' | 'zero-context-tokens' | 'arm-not-scored';
  pairedProbes: number;
  resamples: number;
  level: number;
  seed: number;
  point: number | null;
  lower: number | null;
  upper: number | null;
  oneSidedLower: number | null;
}

/** FNV-1a 32-bit hash over UTF-16 code units. */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Deterministic PRNG; the seed fully determines the resampling sequence. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exact bound percentile rule: index = min(B-1, max(0, round(q*(B-1)))), no interpolation. */
export function percentileIndex(quantile: number, count: number): number {
  return Math.min(count - 1, Math.max(0, Math.round(quantile * (count - 1))));
}

/** The seed is a pure function of the paired data vector, in run order. */
export function pairedVectorSeed(pairs: readonly LabPairedProbe[]): number {
  return fnv1a32(JSON.stringify(pairs.map((pair) => [
    pair.scenarioId, pair.probeId, pair.controlCoverage, pair.controlTokens, pair.candidateCoverage, pair.candidateTokens,
  ])));
}

export function unsupportedEfficiencyInterval(
  reason: NonNullable<LabBootstrapInterval['unsupportedReason']>,
  pairs: readonly LabPairedProbe[],
): LabBootstrapInterval {
  return {
    outcome: 'unsupported',
    unsupportedReason: reason,
    pairedProbes: pairs.length,
    resamples: BOOTSTRAP_RESAMPLES,
    level: BOOTSTRAP_LEVEL,
    seed: pairedVectorSeed(pairs),
    point: null,
    lower: null,
    upper: null,
    oneSidedLower: null,
  };
}

/**
 * Paired percentile bootstrap over the run-level ratio-of-sums statistic
 * 1000*(Σ candidateCoverage / Σ candidateTokens) - 1000*(Σ controlCoverage / Σ controlTokens),
 * recomputed inside each resample. A zero token denominator in either arm of
 * any resample makes the whole interval unsupported (never Infinity, never a
 * silent discard-and-redraw).
 */
export function pairedEfficiencyInterval(pairs: readonly LabPairedProbe[]): LabBootstrapInterval {
  if (pairs.length < MIN_PAIRED_PROBES) return unsupportedEfficiencyInterval('insufficient-paired-probes', pairs);
  const statistic = (indices: readonly number[]): number | null => {
    let controlCoverage = 0;
    let controlTokens = 0;
    let candidateCoverage = 0;
    let candidateTokens = 0;
    for (const index of indices) {
      const pair = pairs[index];
      controlCoverage += pair.controlCoverage;
      controlTokens += pair.controlTokens;
      candidateCoverage += pair.candidateCoverage;
      candidateTokens += pair.candidateTokens;
    }
    if (controlTokens === 0 || candidateTokens === 0) return null;
    return 1000 * (candidateCoverage / candidateTokens) - 1000 * (controlCoverage / controlTokens);
  };
  const identity = pairs.map((_, index) => index);
  const point = statistic(identity);
  if (point === null) return unsupportedEfficiencyInterval('zero-context-tokens', pairs);
  const seed = pairedVectorSeed(pairs);
  const random = mulberry32(seed);
  const resampled: number[] = [];
  for (let resample = 0; resample < BOOTSTRAP_RESAMPLES; resample += 1) {
    const value = statistic(identity.map(() => Math.floor(random() * pairs.length)));
    if (value === null) return unsupportedEfficiencyInterval('zero-context-tokens', pairs);
    resampled.push(value);
  }
  resampled.sort((left, right) => left - right);
  return {
    outcome: 'measured',
    pairedProbes: pairs.length,
    resamples: BOOTSTRAP_RESAMPLES,
    level: BOOTSTRAP_LEVEL,
    seed,
    point,
    lower: resampled[percentileIndex(0.025, BOOTSTRAP_RESAMPLES)],
    upper: resampled[percentileIndex(0.975, BOOTSTRAP_RESAMPLES)],
    oneSidedLower: resampled[percentileIndex(0.05, BOOTSTRAP_RESAMPLES)],
  };
}
