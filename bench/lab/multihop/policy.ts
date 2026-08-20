import type { ComparisonReport, ProbeMetrics } from '../contracts/report.js';
import type { MultiHopAggregateReport } from './scorer-only.js';

/** Frozen before RET-007: changing this constant requires a new dataset version and review. */
export const MULTIHOP_K = 10;
export const MULTIHOP_PROBES_PER_SPLIT = 10;

export const MULTIHOP_POLICY = Object.freeze({
  metric: 'strict-multi-hop-task-success-v1' as const,
  minimumPointDeltaExclusive: 0,
  minimumOneSidedLowerInclusive: 0,
  maximumQualityRegression: 0,
  maximumSafetyRegression: 0,
});

export const MULTIHOP_QUALITY_METRICS = Object.freeze([
  'recallAtK', 'precisionAtK', 'reciprocalRank', 'ndcgAtK', 'answerCoverage',
  'staleSafety', 'isolationSafety',
] as const satisfies readonly (keyof ProbeMetrics)[]);

export const MULTIHOP_SAFETY_METRICS = Object.freeze([
  'staleLeakRate', 'isolationLeakRate', 'duplicateRate', 'unknownResultRate',
] as const satisfies readonly (keyof ProbeMetrics)[]);

export type MultiHopPolicyFailure =
  | 'insufficient-paired-probes'
  | 'point-delta-not-positive'
  | 'one-sided-lower-below-zero'
  | 'comparison-failed'
  | `quality-regression:${(typeof MULTIHOP_QUALITY_METRICS)[number]}`
  | `safety-regression:${(typeof MULTIHOP_SAFETY_METRICS)[number]}`;

/** Aggregate-only adjudication; no scenario, probe, query, result, or oracle value is returned. */
export function evaluateMultiHopPolicy(
  report: MultiHopAggregateReport,
  comparison: ComparisonReport,
): readonly MultiHopPolicyFailure[] {
  const failures: MultiHopPolicyFailure[] = [];
  if (report.interval.outcome !== 'measured') failures.push('insufficient-paired-probes');
  if (report.delta <= MULTIHOP_POLICY.minimumPointDeltaExclusive) failures.push('point-delta-not-positive');
  if (report.interval.oneSidedLower === null
    || report.interval.oneSidedLower < MULTIHOP_POLICY.minimumOneSidedLowerInclusive) {
    failures.push('one-sided-lower-below-zero');
  }
  if (!comparison.passed || comparison.failures.length > 0) failures.push('comparison-failed');
  const deltas = new Map(comparison.deltas.map((delta) => [delta.metric, delta]));
  for (const metric of MULTIHOP_QUALITY_METRICS) {
    if ((deltas.get(metric)?.delta ?? Number.NEGATIVE_INFINITY) < -MULTIHOP_POLICY.maximumQualityRegression) {
      failures.push(`quality-regression:${metric}`);
    }
  }
  for (const metric of MULTIHOP_SAFETY_METRICS) {
    if ((deltas.get(metric)?.delta ?? Number.POSITIVE_INFINITY) > MULTIHOP_POLICY.maximumSafetyRegression) {
      failures.push(`safety-regression:${metric}`);
    }
  }
  return Object.freeze([...new Set(failures)]);
}
