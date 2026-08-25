// RET-007 v4 instrument policy — pre-registered constants for the FUNNEL
// control instrument. Every value below was fixed BEFORE any v4 dataset byte
// existed (spec docs/agent-runs/specs/2026-08-25-ret007-v4-instrument.md,
// "Pre-registered parameters"). Only MULTIHOP_V4_KNOBS (dataset knobs, tuned on
// calib inside MULTIHOP_V4_KNOB_BOUNDS) and MULTIHOP_V4_FREEZE.artifacts /
// controlSourceIdentity are filled in at the freeze; see CALIBRATION-V4.md.

import type { ComparisonReport, ProbeMetrics } from '../contracts/report.js';
import type { MultiHopV4AggregateReport } from './scorer-only-v4.js';

export const MULTIHOP_V4_K = 10;

/**
 * Funnel top-N is a CONSTANT by rule N = K + 2 — NOT a knob (failed attempt
 * 1c-c: tuning N tunes the candidate's ceiling). No bounds, no tuning. The
 * adapter carries its own literal 12 (it may not import this scorer-side
 * module); bench/lab/__tests__/memberry-retrieval-core-funnel.test.ts pins the
 * two literals equal.
 */
export const MULTIHOP_V4_FUNNEL_TOP_N = 12;
export const MULTIHOP_V4_FUNNEL_TOP_N_RULE = 'N = K + 2' as const;

export const MULTIHOP_V4_CONTROL_ADAPTER_ID = 'memberry-retrieval-core-funnel-v1';
export const MULTIHOP_V4_CONTROL_ADAPTER_CLASS = 'production-core-fixture-adapter' as const;
export const MULTIHOP_V4_CONTROL_EXECUTION_MODE = 'fixture' as const;
export const MULTIHOP_V4_CANDIDATE_EXECUTION_MODE = 'fixture' as const;

export type MultiHopV4Split = 'calib' | 'dev' | 'holdout' | 'twin';
/** Splits the D3 verdict reads. Twin is recorded evidence only; calib is never in a receipt. */
export type MultiHopV4ScoredSplit = 'dev' | 'holdout';
export type MultiHopV4Density = 'low' | 'medium' | 'high';
export type MultiHopV4PerDensity = Readonly<Record<MultiHopV4Density, number>>;

export const MULTIHOP_V4_SPLITS = Object.freeze(['calib', 'dev', 'holdout', 'twin'] as const satisfies readonly MultiHopV4Split[]);
export const MULTIHOP_V4_DENSITIES = Object.freeze(['low', 'medium', 'high'] as const satisfies readonly MultiHopV4Density[]);
export const MULTIHOP_V4_FAMILIES = Object.freeze(['routing', 'assignment', 'component', 'custody', 'maintenance'] as const);
export type MultiHopV4Family = (typeof MULTIHOP_V4_FAMILIES)[number];

export const MULTIHOP_V4_PROBES = Object.freeze({ calib: 45, dev: 60, holdout: 100, twin: 30 } as const satisfies Record<MultiHopV4Split, number>);

export const MULTIHOP_V4_DENSITY_COUNTS = Object.freeze({
  calib: Object.freeze({ low: 15, medium: 15, high: 15 }),
  dev: Object.freeze({ low: 20, medium: 20, high: 20 }),
  holdout: Object.freeze({ low: 34, medium: 33, high: 33 }),
  twin: Object.freeze({ low: 10, medium: 10, high: 10 }),
} as const satisfies Record<MultiHopV4Split, MultiHopV4PerDensity>);

/**
 * Pre-registered (family x density) cell counts per split, family order =
 * MULTIHOP_V4_FAMILIES. Rows sum to the density counts; columns sum to an
 * equal per-family total (calib 9, dev 12, holdout 20, twin 6).
 */
export const MULTIHOP_V4_CELL_COUNTS = Object.freeze({
  calib: Object.freeze({ low: [3, 3, 3, 3, 3], medium: [3, 3, 3, 3, 3], high: [3, 3, 3, 3, 3] }),
  dev: Object.freeze({ low: [4, 4, 4, 4, 4], medium: [4, 4, 4, 4, 4], high: [4, 4, 4, 4, 4] }),
  holdout: Object.freeze({ low: [7, 7, 7, 7, 6], medium: [7, 7, 6, 6, 7], high: [6, 6, 7, 7, 7] }),
  twin: Object.freeze({ low: [2, 2, 2, 2, 2], medium: [2, 2, 2, 2, 2], high: [2, 2, 2, 2, 2] }),
} as const satisfies Record<MultiHopV4Split, Readonly<Record<MultiHopV4Density, readonly number[]>>>);

/**
 * Loader battery caps (Verdict 2 P2-4): cap = ceil(n / 28) + 1 per split for
 * domain, query-form and lexical-skeleton counts; minDistinct = ceil(n / cap)
 * (the pigeonhole floor implied by the cap).
 */
export const MULTIHOP_V4_BATTERY = Object.freeze({
  calib: Object.freeze({ probes: 45, cap: 3, minDistinct: 15, familyCount: 9 }),
  dev: Object.freeze({ probes: 60, cap: 4, minDistinct: 15, familyCount: 12 }),
  holdout: Object.freeze({ probes: 100, cap: 5, minDistinct: 20, familyCount: 20 }),
  twin: Object.freeze({ probes: 30, cap: 3, minDistinct: 10, familyCount: 6 }),
} as const satisfies Record<MultiHopV4Split, { probes: number; cap: number; minDistinct: number; familyCount: number }>);

export interface MultiHopV4Knobs {
  readonly corpusSizePerScenario: number;
  readonly bridgeTokenCollisions: MultiHopV4PerDensity;
  readonly domainLexicalOverlapShare: MultiHopV4PerDensity;
  readonly factTokenEcho: MultiHopV4PerDensity;
}

export interface MultiHopV4KnobInterval { readonly min: number; readonly max: number }

/**
 * Carried from MULTIHOP_V3_KNOB_BOUNDS EXCEPT: corpusSizePerScenario in
 * [14, 24] (declared divergence from v3 min 11 so that N = 12 < corpus always)
 * and bridgeTokenCollisions max 1 in every stratum (C1: at most one clone).
 */
export const MULTIHOP_V4_KNOB_BOUNDS = Object.freeze({
  corpusSizePerScenario: Object.freeze({ min: 14, max: 24 }),
  bridgeTokenCollisions: Object.freeze({
    low: Object.freeze({ min: 0, max: 1 }),
    medium: Object.freeze({ min: 0, max: 1 }),
    high: Object.freeze({ min: 0, max: 1 }),
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

/**
 * C2 (iv): each distractor's token overlap with the probe (Jaccard over the
 * funnel tokenizer's token sets) must lie inside this band. Pre-registered.
 */
export const MULTIHOP_V4_DISTRACTOR_PROBE_OVERLAP_BAND = Object.freeze({ min: 0, max: 0.5 });

/**
 * Frozen calibrated knob values. Tuned ONLY against the calib split within
 * MULTIHOP_V4_KNOB_BOUNDS; see bench/lab/multihop/CALIBRATION-V4.md.
 */
export const MULTIHOP_V4_KNOBS: MultiHopV4Knobs = Object.freeze({
  corpusSizePerScenario: 22,
  bridgeTokenCollisions: Object.freeze({ low: 0, medium: 1, high: 1 }),
  domainLexicalOverlapShare: Object.freeze({ low: 0.8, medium: 0.85, high: 0.85 }),
  factTokenEcho: Object.freeze({ low: 0, medium: 0, high: 0 }),
});

export const MULTIHOP_V4_CORPUS_SIZE = MULTIHOP_V4_KNOBS.corpusSizePerScenario;

export function validateMultiHopV4Knobs(knobs: MultiHopV4Knobs): void {
  const inRange = (value: number, interval: MultiHopV4KnobInterval) => (
    Number.isFinite(value) && value >= interval.min && value <= interval.max
  );
  if (!Number.isInteger(knobs.corpusSizePerScenario)
    || !inRange(knobs.corpusSizePerScenario, MULTIHOP_V4_KNOB_BOUNDS.corpusSizePerScenario)) {
    throw new Error('multi-hop v4 knob corpusSizePerScenario is outside its pre-registered bounds');
  }
  if (knobs.corpusSizePerScenario <= MULTIHOP_V4_FUNNEL_TOP_N) {
    throw new Error('multi-hop v4 knob corpusSizePerScenario must exceed the funnel top-N');
  }
  for (const density of MULTIHOP_V4_DENSITIES) {
    if (!Number.isInteger(knobs.bridgeTokenCollisions[density])
      || !inRange(knobs.bridgeTokenCollisions[density], MULTIHOP_V4_KNOB_BOUNDS.bridgeTokenCollisions[density])) {
      throw new Error(`multi-hop v4 knob bridgeTokenCollisions.${density} is outside its pre-registered bounds`);
    }
    if (!inRange(knobs.domainLexicalOverlapShare[density], MULTIHOP_V4_KNOB_BOUNDS.domainLexicalOverlapShare[density])) {
      throw new Error(`multi-hop v4 knob domainLexicalOverlapShare.${density} is outside its pre-registered bounds`);
    }
    if (!Number.isInteger(knobs.factTokenEcho[density])
      || !inRange(knobs.factTokenEcho[density], MULTIHOP_V4_KNOB_BOUNDS.factTokenEcho[density])) {
      throw new Error(`multi-hop v4 knob factTokenEcho.${density} is outside its pre-registered bounds`);
    }
  }
}

/** Verbatim copy of MULTIHOP_V2_CONTROL_HEADROOM values (v4 does not move the band). */
export const MULTIHOP_V4_CONTROL_HEADROOM = Object.freeze({
  minimumSuccessRateInclusive: 0.30,
  maximumSuccessRateInclusive: 0.70,
  minimumSuccessesPerStratumInclusive: 1,
  minimumFailuresPerStratumInclusive: 1,
});

/**
 * Calib acceptance (Decision 1c + Verdict 2 P2-1/P2-2). H = share of calib
 * scenarios whose memory B is NOT in the pass-1 funnel emission; score-driven
 * share = among B-withheld scenarios, the share where B's BM25 score is
 * STRICTLY below the N-th emitted score (not a corpus-order tie).
 * Ledger line: delta_max ~= H x capture; if the frozen H < 0.30 the D3 record
 * must flag that the achievable delta may sit near the +10 reporting threshold.
 */
export const MULTIHOP_V4_CALIB_ACCEPTANCE = Object.freeze({
  minimumSuccessRateInclusive: 0.42,
  maximumSuccessRateInclusive: 0.58,
  minimumSuccessesPerStratumInclusive: 3,
  minimumFailuresPerStratumInclusive: 3,
  minimumHeadroomInclusive: 0.25,
  minimumScoreDrivenShareInclusive: 0.80,
  headroomLedgerFlagBelow: 0.30,
});

/** Verbatim copy of the MULTIHOP_V2_POLICY shape with the v4 metric identity. */
export const MULTIHOP_V4_POLICY = Object.freeze({
  metric: 'strict-multi-hop-task-success-v4' as const,
  minimumPointDeltaExclusive: 0,
  minimumOneSidedLowerInclusive: 0,
  maximumQualityRegression: 0,
  maximumSafetyRegression: 0,
  /** Pre-registered REPORTED minimum meaningful delta (points); power caveat in the spec. */
  reportedMinimumMeaningfulDeltaPoints: 10,
});

/**
 * Pre-registered candidate bridge-derivation policies (D1 registers, D4/D5
 * build). Types only — no implementation exists in this tree (custody:
 * candidateAbsentAtQualification).
 */
export const MULTIHOP_V4_BRIDGE_DERIVATION = Object.freeze(['evidence-bridge', 'fact-lexical'] as const);
export type MultiHopV4BridgeDerivation = (typeof MULTIHOP_V4_BRIDGE_DERIVATION)[number];

export const MULTIHOP_V4_QUALITY_METRICS = Object.freeze([
  'recallAtK', 'precisionAtK', 'reciprocalRank', 'ndcgAtK', 'answerCoverage',
  'staleSafety', 'isolationSafety',
] as const satisfies readonly (keyof ProbeMetrics)[]);

export const MULTIHOP_V4_SAFETY_METRICS = Object.freeze([
  'staleLeakRate', 'isolationLeakRate', 'duplicateRate', 'unknownResultRate',
] as const satisfies readonly (keyof ProbeMetrics)[]);

export const MULTIHOP_V4_FREEZE = Object.freeze({
  instrument: 'memberry-multihop-v4' as const,
  version: '4.0.0' as const,
  // D3 base-pinning rule: re-pinned to the D2 merge base by the orchestrator
  // immediately before merge; until then this is origin/master 8bfd235.
  exactBaseCommit: '534de13fbaa6b24719a0b6e7390451542987caee' as const,
  publicOrderSeed: 'memberry-ret007-v4-order-2026-08-25' as const,
  seedCommitmentSha256: '1129e51ad78067a9fe1b2740517dd8a136de9edadcd0a4bf3864be84e0327bb2' as const,
  orderKeyDerivation: 'sha256-utf8(seed+LF+scenario_id+LF+neutral_slot_id)' as const,
  funnelTopN: MULTIHOP_V4_FUNNEL_TOP_N,
  funnelTopNRule: MULTIHOP_V4_FUNNEL_TOP_N_RULE,
  batteryCapRule: 'cap = ceil(n / 28) + 1; minDistinct = ceil(n / cap)' as const,
  // Six pinned blobs: the five v3 control-identity paths plus the funnel
  // adapter, all taken at the v4 base (git hash-object of the committed file).
  controlSourceIdentity: Object.freeze({
    controlAdapterPath: 'bench/lab/adapters/memberry-retrieval-core-funnel.ts' as const,
    controlAdapterGitBlob: 'd4cdc0319b8858c81eb9fe635868f82950e6ae5c' as const,
    productionCoreAdapterPath: 'bench/lab/adapters/memberry-retrieval-core.ts' as const,
    productionCoreAdapterGitBlob: 'e138ed07531949b8fbe40ece620214e6ed604ac6' as const,
    registeredAdaptersGitBlob: 'a3b58bde31c87314a7c1b966a63bd4a63f61743a' as const,
    runnerGitBlob: 'c0b885845d117f1d6e7a25bbfc87832e97ddee77' as const,
    systemsRegistryGitBlob: '6941f75a4ebb64cc9571d61fbc03b9555af46ecf' as const,
    experimentsRegistryGitBlob: '7a07dd7fd4709a98ab400fff535aa38a45ead174' as const,
  }),
  artifacts: Object.freeze({
    calib: Object.freeze({
      input: Object.freeze({ sha256: '327534e989dd7a0c725f40be7a8652d4d60348b4de5fc2d423b2f9f703b6392b', sizeBytes: 185397 }),
      oracle: Object.freeze({ sha256: 'f64da5b503d38317d8a7678d9c75bd38186ee57cdc92fdd035e451ef07d9aa4a', sizeBytes: 10935 }),
    }),
    dev: Object.freeze({
      input: Object.freeze({ sha256: '85f350fd97d9478a1722fd1d879e49d10cea2a3ea4b68c2d6a5d7862425d7682', sizeBytes: 246597 }),
      oracle: Object.freeze({ sha256: 'f76c0fd419aa142bfa01b2ce5f886f0b30a69441f64e17b9bbdda86223b28905', sizeBytes: 14580 }),
    }),
    holdout: Object.freeze({
      input: Object.freeze({ sha256: 'c2413af69f29633ef3703808940051aeaa8109f1a61f7a613e9f7abcba91afba', sizeBytes: 412289 }),
      oracle: Object.freeze({ sha256: '6defc85646d8fa5ed127bc42a8cb7fda3062fc61c13609ef246307270b54e989', sizeBytes: 24400 }),
    }),
    twin: Object.freeze({
      input: Object.freeze({ sha256: 'de0e168e0ad19fc50e934c3a9a8352e74fbb809ccff9b0c0dcb53cdbd465f31f', sizeBytes: 124141 }),
      oracle: Object.freeze({ sha256: '3646fad33ee0ac091c088b1289f84d5a03fc7ede46d2cd3321c182df9f484731', sizeBytes: 7290 }),
    }),
  }),
});

export type MultiHopV4PolicyFailure =
  | 'insufficient-paired-probes'
  | 'point-delta-not-positive'
  | 'one-sided-lower-below-zero'
  | 'comparison-failed'
  | `quality-regression:${(typeof MULTIHOP_V4_QUALITY_METRICS)[number]}`
  | `safety-regression:${(typeof MULTIHOP_V4_SAFETY_METRICS)[number]}`;

/** Closed aggregate adjudication: no scenario, probe, query, result, oracle, or binary lane escapes. */
export function evaluateMultiHopV4Policy(
  report: MultiHopV4AggregateReport,
  comparison: ComparisonReport,
): readonly MultiHopV4PolicyFailure[] {
  const failures: MultiHopV4PolicyFailure[] = [];
  if (report.interval.outcome !== 'measured') failures.push('insufficient-paired-probes');
  if (report.delta <= MULTIHOP_V4_POLICY.minimumPointDeltaExclusive) failures.push('point-delta-not-positive');
  if (report.interval.oneSidedLower === null
    || report.interval.oneSidedLower < MULTIHOP_V4_POLICY.minimumOneSidedLowerInclusive) {
    failures.push('one-sided-lower-below-zero');
  }
  if (!comparison.passed || comparison.failures.length > 0) failures.push('comparison-failed');
  const deltas = new Map(comparison.deltas.map((delta) => [delta.metric, delta]));
  for (const metric of MULTIHOP_V4_QUALITY_METRICS) {
    if ((deltas.get(metric)?.delta ?? Number.NEGATIVE_INFINITY) < -MULTIHOP_V4_POLICY.maximumQualityRegression) {
      failures.push(`quality-regression:${metric}`);
    }
  }
  for (const metric of MULTIHOP_V4_SAFETY_METRICS) {
    if ((deltas.get(metric)?.delta ?? Number.POSITIVE_INFINITY) > MULTIHOP_V4_POLICY.maximumSafetyRegression) {
      failures.push(`safety-regression:${metric}`);
    }
  }
  return Object.freeze([...new Set(failures)]);
}
