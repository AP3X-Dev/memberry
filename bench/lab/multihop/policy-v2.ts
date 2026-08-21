import type { ComparisonReport, ProbeMetrics } from '../contracts/report.js';
import type { MultiHopV2AggregateReport } from './scorer-only-v2.js';

export const MULTIHOP_V2_K = 10;
export const MULTIHOP_V2_PROBES_PER_SPLIT = 20;
export const MULTIHOP_V2_CONTROL_ADAPTER_ID = 'memberry-retrieval-core-v1';
export const MULTIHOP_V2_CONTROL_ADAPTER_CLASS = 'production-core-fixture-adapter' as const;
export const MULTIHOP_V2_CONTROL_EXECUTION_MODE = 'fixture' as const;
export const MULTIHOP_V2_CANDIDATE_EXECUTION_MODE = 'fixture' as const;
export const MULTIHOP_V2_DENSITY_COUNTS = Object.freeze({ low: 7, medium: 7, high: 6 } as const);
export type MultiHopV2Density = keyof typeof MULTIHOP_V2_DENSITY_COUNTS;

export const MULTIHOP_V2_FREEZE = Object.freeze({
  instrument: 'memberry-multihop-v2' as const,
  version: '2.0.0' as const,
  exactBaseCommit: 'a90d8a91aa0ec5f10796938798537aafc2ed0b9c' as const,
  publicOrderSeed: 'memberry-lab013-v2-order-2026-08-20' as const,
  seedCommitmentSha256: '8a405c6921dc3e5790f0df6054620099ed98bf54767637229c5544f2e54e241a' as const,
  orderKeyDerivation: 'sha256-utf8(seed+LF+scenario_id+LF+neutral_slot_id)' as const,
  controlSourceIdentity: Object.freeze({
    controlAdapterPath: 'bench/lab/adapters/memberry-retrieval-core.ts' as const,
    controlAdapterGitBlob: '3ceda0bcc44a5e7a8d79356c5ec909451d426a02' as const,
    registeredAdaptersGitBlob: '752bc02e4ef5aabe99a5c52699c2ead6e6395f83' as const,
    runnerGitBlob: 'c0b885845d117f1d6e7a25bbfc87832e97ddee77' as const,
    systemsRegistryGitBlob: '41ccf2b5e8a6c90d5f675d56c2b641126d151f82' as const,
    experimentsRegistryGitBlob: '9dda1d33d84611cdc9c388fb81df5d8a678798a2' as const,
  }),
  artifacts: Object.freeze({
    dev: Object.freeze({
      input: Object.freeze({ sha256: '7ea7b54899bf5e99905487d71da503667425ecff85aaa2d2c954640aa708d7d0', sizeBytes: 84500 }),
      oracle: Object.freeze({ sha256: '25f9969a48ea4f30561e5bbd857aab10c3cb87422295842006e427dcbac70d64', sizeBytes: 4860 }),
    }),
    holdout: Object.freeze({
      input: Object.freeze({ sha256: 'c4484005b4e0349da4018ec2ab6a4e3278fdbde3a964eb9fedad4f5ca1a68bc1', sizeBytes: 84238 }),
      oracle: Object.freeze({ sha256: '58a68db01cf237e0153c5055bab172483c4cb5e66363bfa3c721b2d45214cfb1', sizeBytes: 4860 }),
    }),
  }),
});

export const MULTIHOP_V2_CONTROL_HEADROOM = Object.freeze({
  minimumSuccessRateInclusive: 0.30,
  maximumSuccessRateInclusive: 0.70,
  minimumSuccessesPerStratumInclusive: 1,
  minimumFailuresPerStratumInclusive: 1,
});

export const MULTIHOP_V2_POLICY = Object.freeze({
  metric: 'strict-multi-hop-task-success-v2' as const,
  minimumPointDeltaExclusive: 0,
  minimumOneSidedLowerInclusive: 0,
  maximumQualityRegression: 0,
  maximumSafetyRegression: 0,
});

export const MULTIHOP_V2_QUALITY_METRICS = Object.freeze([
  'recallAtK', 'precisionAtK', 'reciprocalRank', 'ndcgAtK', 'answerCoverage',
  'staleSafety', 'isolationSafety',
] as const satisfies readonly (keyof ProbeMetrics)[]);

export const MULTIHOP_V2_SAFETY_METRICS = Object.freeze([
  'staleLeakRate', 'isolationLeakRate', 'duplicateRate', 'unknownResultRate',
] as const satisfies readonly (keyof ProbeMetrics)[]);

export type MultiHopV2PolicyFailure =
  | 'insufficient-paired-probes'
  | 'point-delta-not-positive'
  | 'one-sided-lower-below-zero'
  | 'comparison-failed'
  | `quality-regression:${(typeof MULTIHOP_V2_QUALITY_METRICS)[number]}`
  | `safety-regression:${(typeof MULTIHOP_V2_SAFETY_METRICS)[number]}`;

/** Closed aggregate adjudication: no scenario, probe, query, result, oracle, or binary lane escapes. */
export function evaluateMultiHopV2Policy(
  report: MultiHopV2AggregateReport,
  comparison: ComparisonReport,
): readonly MultiHopV2PolicyFailure[] {
  const failures: MultiHopV2PolicyFailure[] = [];
  if (report.interval.outcome !== 'measured') failures.push('insufficient-paired-probes');
  if (report.delta <= MULTIHOP_V2_POLICY.minimumPointDeltaExclusive) failures.push('point-delta-not-positive');
  if (report.interval.oneSidedLower === null
    || report.interval.oneSidedLower < MULTIHOP_V2_POLICY.minimumOneSidedLowerInclusive) {
    failures.push('one-sided-lower-below-zero');
  }
  if (!comparison.passed || comparison.failures.length > 0) failures.push('comparison-failed');
  const deltas = new Map(comparison.deltas.map((delta) => [delta.metric, delta]));
  for (const metric of MULTIHOP_V2_QUALITY_METRICS) {
    if ((deltas.get(metric)?.delta ?? Number.NEGATIVE_INFINITY) < -MULTIHOP_V2_POLICY.maximumQualityRegression) {
      failures.push(`quality-regression:${metric}`);
    }
  }
  for (const metric of MULTIHOP_V2_SAFETY_METRICS) {
    if ((deltas.get(metric)?.delta ?? Number.POSITIVE_INFINITY) > MULTIHOP_V2_POLICY.maximumSafetyRegression) {
      failures.push(`safety-regression:${metric}`);
    }
  }
  return Object.freeze([...new Set(failures)]);
}
