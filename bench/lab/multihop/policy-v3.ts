// RET-007 v3 instrument policy — clone of the v2 apparatus constants with v3
// identity, plus the pre-registered difficulty knobs (monotone interpolation
// v1 -> v2) and their measured bounds. See
// docs/agent-runs/specs/2026-08-25-ret007-v3-instrument.md and
// bench/lab/multihop/measure-v2-knobs.output.txt.

import type { ComparisonReport, ProbeMetrics } from '../contracts/report.js';
import type { MultiHopV3AggregateReport } from './scorer-only-v3.js';

export const MULTIHOP_V3_K = 10;
export const MULTIHOP_V3_PROBES_PER_SPLIT = 20;
export const MULTIHOP_V3_CALIB_PROBES = 15;
export const MULTIHOP_V3_CONTROL_ADAPTER_ID = 'memberry-retrieval-core-v1';
export const MULTIHOP_V3_CONTROL_ADAPTER_CLASS = 'production-core-fixture-adapter' as const;
export const MULTIHOP_V3_CONTROL_EXECUTION_MODE = 'fixture' as const;
export const MULTIHOP_V3_CANDIDATE_EXECUTION_MODE = 'fixture' as const;
export const MULTIHOP_V3_DENSITY_COUNTS = Object.freeze({ low: 7, medium: 7, high: 6 } as const);
export const MULTIHOP_V3_CALIB_DENSITY_COUNTS = Object.freeze({ low: 5, medium: 5, high: 5 } as const);
export type MultiHopV3Density = keyof typeof MULTIHOP_V3_DENSITY_COUNTS;

export type MultiHopV3PerDensity = Readonly<Record<MultiHopV3Density, number>>;

export interface MultiHopV3Knobs {
  readonly corpusSizePerScenario: number;
  readonly bridgeTokenCollisions: MultiHopV3PerDensity;
  readonly domainLexicalOverlapShare: MultiHopV3PerDensity;
  readonly factTokenEcho: MultiHopV3PerDensity;
}

/**
 * Frozen calibrated knob values. Tuned ONLY against the calib split within
 * MULTIHOP_V3_KNOB_BOUNDS; see bench/lab/multihop/CALIBRATION-V3.md for the
 * full iteration log.
 */
export const MULTIHOP_V3_KNOBS: MultiHopV3Knobs = Object.freeze({
  corpusSizePerScenario: 17,
  bridgeTokenCollisions: Object.freeze({ low: 0, medium: 1, high: 2 }),
  domainLexicalOverlapShare: Object.freeze({ low: 0.3, medium: 0.4, high: 0.5 }),
  factTokenEcho: Object.freeze({ low: 0, medium: 1, high: 2 }),
});

/** Flat corpus size per scenario in every density stratum (knob-chosen; declared divergence from v2's hardcoded 24). */
export const MULTIHOP_V3_CORPUS_SIZE = MULTIHOP_V3_KNOBS.corpusSizePerScenario;

export interface MultiHopV3KnobInterval { readonly min: number; readonly max: number }
export type MultiHopV3PerDensityBounds = Readonly<Record<MultiHopV3Density, MultiHopV3KnobInterval>>;

/**
 * Pre-registered tuning intervals. v1/v2 endpoints per spec; the two
 * "measured" knobs take their per-density maxima measured from
 * bench/lab/datasets/multihop/v2/dev/input.jsonl ONLY (never v2 holdout) by
 * bench/lab/multihop/measure-v2-knobs.ts:
 *   bridgeTokenCollisions  low=1  medium=2 high=2
 *   factTokenEcho          low=2  medium=2 high=4
 */
export const MULTIHOP_V3_KNOB_BOUNDS = Object.freeze({
  corpusSizePerScenario: Object.freeze({ min: 11, max: 24 }),
  bridgeTokenCollisions: Object.freeze({
    low: Object.freeze({ min: 0, max: 1 }),
    medium: Object.freeze({ min: 0, max: 2 }),
    high: Object.freeze({ min: 0, max: 2 }),
  }),
  domainLexicalOverlapShare: Object.freeze({
    low: Object.freeze({ min: 0, max: 1 }),
    medium: Object.freeze({ min: 0, max: 1 }),
    high: Object.freeze({ min: 0, max: 1 }),
  }),
  factTokenEcho: Object.freeze({
    low: Object.freeze({ min: 0, max: 2 }),
    medium: Object.freeze({ min: 0, max: 2 }),
    high: Object.freeze({ min: 0, max: 4 }),
  }),
});

const DENSITIES = Object.freeze(['low', 'medium', 'high'] as const satisfies readonly MultiHopV3Density[]);

/** Import-time knob custody: every generator entry point validates against the pre-registered bounds. */
export function validateMultiHopV3Knobs(knobs: MultiHopV3Knobs): void {
  const inRange = (value: number, interval: MultiHopV3KnobInterval) => (
    Number.isFinite(value) && value >= interval.min && value <= interval.max
  );
  if (!Number.isInteger(knobs.corpusSizePerScenario)
    || !inRange(knobs.corpusSizePerScenario, MULTIHOP_V3_KNOB_BOUNDS.corpusSizePerScenario)) {
    throw new Error('multi-hop v3 knob corpusSizePerScenario is outside its pre-registered bounds');
  }
  for (const density of DENSITIES) {
    if (!Number.isInteger(knobs.bridgeTokenCollisions[density])
      || !inRange(knobs.bridgeTokenCollisions[density], MULTIHOP_V3_KNOB_BOUNDS.bridgeTokenCollisions[density])) {
      throw new Error(`multi-hop v3 knob bridgeTokenCollisions.${density} is outside its pre-registered bounds`);
    }
    if (!inRange(knobs.domainLexicalOverlapShare[density], MULTIHOP_V3_KNOB_BOUNDS.domainLexicalOverlapShare[density])) {
      throw new Error(`multi-hop v3 knob domainLexicalOverlapShare.${density} is outside its pre-registered bounds`);
    }
    if (!Number.isInteger(knobs.factTokenEcho[density])
      || !inRange(knobs.factTokenEcho[density], MULTIHOP_V3_KNOB_BOUNDS.factTokenEcho[density])) {
      throw new Error(`multi-hop v3 knob factTokenEcho.${density} is outside its pre-registered bounds`);
    }
  }
}

export const MULTIHOP_V3_FREEZE = Object.freeze({
  instrument: 'memberry-multihop-v3' as const,
  version: '3.0.0' as const,
  // D3 base-pinning rule: re-pinned to the D2 merge base by the orchestrator
  // immediately before merge; until then this is origin/master 52aa9d6.
  exactBaseCommit: '52aa9d6c880b7a29a99fe5c2537d9e76589af3c6' as const,
  publicOrderSeed: 'memberry-ret007-v3-order-2026-08-25' as const,
  seedCommitmentSha256: '79f4828348540695f7d7f23220c901d1135a19df51416993186db0f40c530f30' as const,
  orderKeyDerivation: 'sha256-utf8(seed+LF+scenario_id+LF+neutral_slot_id)' as const,
  controlSourceIdentity: Object.freeze({
    controlAdapterPath: 'bench/lab/adapters/memberry-retrieval-core.ts' as const,
    controlAdapterGitBlob: 'e138ed07531949b8fbe40ece620214e6ed604ac6' as const,
    registeredAdaptersGitBlob: '15ee2492a9e8f1419938b3218ec0460e260e1871' as const,
    runnerGitBlob: 'c0b885845d117f1d6e7a25bbfc87832e97ddee77' as const,
    systemsRegistryGitBlob: '33dac176ae948439dc6530d98680b3e15e6dd0ec' as const,
    experimentsRegistryGitBlob: '7a07dd7fd4709a98ab400fff535aa38a45ead174' as const,
  }),
  artifacts: Object.freeze({
    dev: Object.freeze({
      input: Object.freeze({ sha256: '1e2355d92e7ba8a11feae8b2107a4cebee0dd7e1724a93ed6ab927674ec23b9d', sizeBytes: 61316 }),
      oracle: Object.freeze({ sha256: '31a905c24893aa0155c47b755bf6d139c6b8c77b870ac1d52389892b2d534478', sizeBytes: 4860 }),
    }),
    holdout: Object.freeze({
      input: Object.freeze({ sha256: '1b8fe48cd40151494ea5b27bda4f3cc8a89d9c122bf147e926b229bb47f27792', sizeBytes: 61355 }),
      oracle: Object.freeze({ sha256: 'f3cb0b82a969d2059ebf26eee0cf69314ced0c0e2f88f7d71e2bf20472afffde', sizeBytes: 4860 }),
    }),
  }),
});

/** Verbatim copy of MULTIHOP_V2_CONTROL_HEADROOM values (v3 does not move the band). */
export const MULTIHOP_V3_CONTROL_HEADROOM = Object.freeze({
  minimumSuccessRateInclusive: 0.30,
  maximumSuccessRateInclusive: 0.70,
  minimumSuccessesPerStratumInclusive: 1,
  minimumFailuresPerStratumInclusive: 1,
});

/** Verbatim copy of the MULTIHOP_V2_POLICY shape with the v3 metric identity. */
export const MULTIHOP_V3_POLICY = Object.freeze({
  metric: 'strict-multi-hop-task-success-v3' as const,
  minimumPointDeltaExclusive: 0,
  minimumOneSidedLowerInclusive: 0,
  maximumQualityRegression: 0,
  maximumSafetyRegression: 0,
});

export const MULTIHOP_V3_QUALITY_METRICS = Object.freeze([
  'recallAtK', 'precisionAtK', 'reciprocalRank', 'ndcgAtK', 'answerCoverage',
  'staleSafety', 'isolationSafety',
] as const satisfies readonly (keyof ProbeMetrics)[]);

export const MULTIHOP_V3_SAFETY_METRICS = Object.freeze([
  'staleLeakRate', 'isolationLeakRate', 'duplicateRate', 'unknownResultRate',
] as const satisfies readonly (keyof ProbeMetrics)[]);

export type MultiHopV3PolicyFailure =
  | 'insufficient-paired-probes'
  | 'point-delta-not-positive'
  | 'one-sided-lower-below-zero'
  | 'comparison-failed'
  | `quality-regression:${(typeof MULTIHOP_V3_QUALITY_METRICS)[number]}`
  | `safety-regression:${(typeof MULTIHOP_V3_SAFETY_METRICS)[number]}`;

/** Closed aggregate adjudication: no scenario, probe, query, result, oracle, or binary lane escapes. */
export function evaluateMultiHopV3Policy(
  report: MultiHopV3AggregateReport,
  comparison: ComparisonReport,
): readonly MultiHopV3PolicyFailure[] {
  const failures: MultiHopV3PolicyFailure[] = [];
  if (report.interval.outcome !== 'measured') failures.push('insufficient-paired-probes');
  if (report.delta <= MULTIHOP_V3_POLICY.minimumPointDeltaExclusive) failures.push('point-delta-not-positive');
  if (report.interval.oneSidedLower === null
    || report.interval.oneSidedLower < MULTIHOP_V3_POLICY.minimumOneSidedLowerInclusive) {
    failures.push('one-sided-lower-below-zero');
  }
  if (!comparison.passed || comparison.failures.length > 0) failures.push('comparison-failed');
  const deltas = new Map(comparison.deltas.map((delta) => [delta.metric, delta]));
  for (const metric of MULTIHOP_V3_QUALITY_METRICS) {
    if ((deltas.get(metric)?.delta ?? Number.NEGATIVE_INFINITY) < -MULTIHOP_V3_POLICY.maximumQualityRegression) {
      failures.push(`quality-regression:${metric}`);
    }
  }
  for (const metric of MULTIHOP_V3_SAFETY_METRICS) {
    if ((deltas.get(metric)?.delta ?? Number.POSITIVE_INFINITY) > MULTIHOP_V3_POLICY.maximumSafetyRegression) {
      failures.push(`safety-regression:${metric}`);
    }
  }
  return Object.freeze([...new Set(failures)]);
}
