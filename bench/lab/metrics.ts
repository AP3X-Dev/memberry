import type { LabProbeOracle, LabScenarioInput } from './contracts/scenario.js';
import type { LabQueryResult } from './contracts/adapter.js';
import type { LabContextAccounting, LabGatePolicy, ProbeMetrics, ProbeReport } from './contracts/report.js';

export const DEFAULT_GATE_POLICY: LabGatePolicy = Object.freeze({
  minRecallAtK: 0.8,
  minPrecisionAtK: 0.4,
  minAnswerCoverage: 1,
  maxStaleLeakRate: 0,
  maxIsolationLeakRate: 0,
  maxDuplicateRate: 0,
  maxUnknownResultRate: 0,
  maxQualityRegression: 0.01,
});

const clamp = (value: number) => Math.max(0, Math.min(1, value));

function uniqueTopIds(results: readonly LabQueryResult[], k: number): string[] {
  return [...new Set(results.slice(0, k).map((result) => result.id))];
}

function countMatches(ids: readonly string[], expected: ReadonlySet<string>): number {
  return ids.reduce((count, id) => count + Number(expected.has(id)), 0);
}

export function reciprocalRank(ids: readonly string[], relevant: ReadonlySet<string>): number {
  const index = ids.findIndex((id) => relevant.has(id));
  return index < 0 ? 0 : 1 / (index + 1);
}

export function ndcgAtK(ids: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  const dcg = ids.slice(0, k).reduce(
    (sum, id, index) => sum + (relevant.has(id) ? 1 / Math.log2(index + 2) : 0),
    0,
  );
  const idealCount = Math.min(relevant.size, k);
  const ideal = Array.from({ length: idealCount }, (_, index) => 1 / Math.log2(index + 2))
    .reduce((sum, value) => sum + value, 0);
  return ideal === 0 ? 0 : dcg / ideal;
}

export function scoreProbe(
  scenario: LabScenarioInput,
  probe: LabProbeOracle,
  limit: number,
  results: readonly LabQueryResult[],
): ProbeMetrics {
  const rawTop = results.slice(0, limit).map((result) => result.id);
  const top = uniqueTopIds(results, limit);
  const relevant = new Set(probe.relevant);
  const required = new Set(probe.required?.length ? probe.required : probe.relevant);
  const stale = new Set(probe.stale ?? []);
  const forbidden = new Set(probe.forbidden ?? []);
  const known = new Set(scenario.memories.map((memory) => memory.id));
  const relevantHits = countMatches(top, relevant);
  const requiredHits = countMatches(top, required);
  const answerCoverage = required.size === 0 ? 0 : requiredHits / required.size;
  const staleHits = countMatches(top, stale);
  const isolationHits = countMatches(top, forbidden);
  const returned = rawTop.length;
  const duplicates = returned - new Set(rawTop).size;
  const unknown = top.filter((id) => !known.has(id)).length;
  const staleLeakRate = returned === 0 ? 0 : staleHits / returned;
  const isolationLeakRate = returned === 0 ? 0 : isolationHits / returned;

  return {
    recallAtK: relevant.size === 0 ? 0 : relevantHits / relevant.size,
    precisionAtK: returned === 0 ? 0 : relevantHits / returned,
    reciprocalRank: reciprocalRank(top, relevant),
    ndcgAtK: ndcgAtK(top, relevant, limit),
    answerCoverage,
    staleLeakRate,
    isolationLeakRate,
    duplicateRate: returned === 0 ? 0 : duplicates / returned,
    unknownResultRate: returned === 0 ? 0 : unknown / returned,
    staleSafety: answerCoverage === 0 ? 0 : clamp(1 - staleLeakRate),
    isolationSafety: answerCoverage === 0 ? 0 : clamp(1 - isolationLeakRate),
  };
}

const METRIC_KEYS: readonly (keyof ProbeMetrics)[] = [
  'recallAtK', 'precisionAtK', 'reciprocalRank', 'ndcgAtK', 'answerCoverage',
  'staleLeakRate', 'isolationLeakRate', 'duplicateRate', 'unknownResultRate',
  'staleSafety', 'isolationSafety',
];

export function averageMetrics(metrics: readonly ProbeMetrics[]): ProbeMetrics {
  const divisor = metrics.length || 1;
  return Object.fromEntries(METRIC_KEYS.map((key) => [
    key,
    metrics.reduce((sum, value) => sum + value[key], 0) / divisor,
  ])) as unknown as ProbeMetrics;
}

/** Versioned token-estimator identity; changed arithmetic requires a new id, ids are never reused. */
export const LAB_TOKEN_ESTIMATOR_ID = 'chars-div-4-ceil-v1' as const;

/**
 * Lab-local deterministic token estimate. Provenance: mirrors estimateTokens
 * in packages/core/src/ranking.ts:38-41, deliberately copied instead of
 * imported so the measuring stick does not depend on the system under test.
 */
export function estimateLabTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Context-token denominator for one probe: estimated fixture-content tokens
 * of the deduplicated top-k result ids. Unknown ids contribute 0; duplicate
 * ids are counted once. Caveat: this measures fixture-content tokens of
 * returned results, not rendered markdown, prompt scaffolding, or the live
 * trace's `**Tokens:** ~N`; it is uniform across arms on identical fixtures,
 * which is what a comparison requires.
 *
 * `taskSuccessPer1kTokens` is the deterministic-lab proxy for PRP §6.5's
 * "task success per 1,000 context tokens". Its numerator is fixture-oracle
 * answer coverage on retrieval probes, not agent task completion; no agent
 * executes a task in this lab. Its denominator is estimated from fixture
 * content of returned results, not from rendered context actually consumed
 * by a model. It is a comparative efficiency signal between two arms on
 * identical fixtures, and is not a claim about agent-level task completion.
 */
export function probeContextTokens(
  scenario: LabScenarioInput,
  limit: number,
  results: readonly LabQueryResult[],
): number {
  const contentById = new Map(scenario.memories.map((memory) => [memory.id, memory.content]));
  return uniqueTopIds(results, limit).reduce((sum, id) => {
    const content = contentById.get(id);
    return sum + (content === undefined ? 0 : estimateLabTokens(content));
  }, 0);
}

/**
 * Run-level accounting over scored probes only, as a ratio of sums — never a
 * mean of probe ratios, so a 20-token probe cannot weigh like a 400-token one.
 * Unmeasurable outcomes are typed 'unsupported', never 0, NaN, or Infinity;
 * zero success over positive tokens is a measured zero.
 */
export function aggregateContextAccounting(probes: readonly ProbeReport[]): LabContextAccounting {
  const scoredProbes = probes.length;
  const contextTokens = probes.reduce((sum, probe) => sum + (probe.contextTokens ?? 0), 0);
  const taskSuccessTotal = probes.reduce((sum, probe) => sum + probe.metrics.answerCoverage, 0);
  const base = { estimatorId: LAB_TOKEN_ESTIMATOR_ID, scoredProbes, contextTokens, taskSuccessTotal } as const;
  if (scoredProbes === 0) {
    return { ...base, outcome: 'unsupported', unsupportedReason: 'no-scored-probes', taskSuccessPer1kTokens: null };
  }
  if (contextTokens === 0) {
    return { ...base, outcome: 'unsupported', unsupportedReason: 'zero-context-tokens', taskSuccessPer1kTokens: null };
  }
  return { ...base, outcome: 'measured', taskSuccessPer1kTokens: (1000 * taskSuccessTotal) / contextTokens };
}
