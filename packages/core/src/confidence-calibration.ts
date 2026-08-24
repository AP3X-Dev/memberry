// packages/core/src/confidence-calibration.ts
//
// MEM-004 / MEM-FR-5: pure confidence-calibration reporting. Compares stored
// confidence (integer permille) against observed correctness derived from
// reinforcement/correction/contradiction signal counts. Diagnostic only —
// nothing here writes back to stored confidence (MEM-FR-9).
import { createHash } from 'node:crypto';
import { types as nodeUtilTypes } from 'node:util';

export const CALIBRATION_CONTRACT_VERSION = '1.0.0' as const;
export const CALIBRATION_BIN_COUNT = 10 as const;

export const CALIBRATION_DEFAULT_REINFORCEMENT_WEIGHT = 10 as const;
export const CALIBRATION_DEFAULT_CORRECTION_WEIGHT = 50 as const;
export const CALIBRATION_DEFAULT_CONTRADICTION_WEIGHT = 30 as const;
export const CALIBRATION_DEFAULT_MIN_SIGNAL_WEIGHT = 10 as const;

export const CALIBRATION_ENV_REINFORCEMENT_WEIGHT =
  'MEMBERRY_CALIBRATION_REINFORCEMENT_WEIGHT' as const;
export const CALIBRATION_ENV_CORRECTION_WEIGHT =
  'MEMBERRY_CALIBRATION_CORRECTION_WEIGHT' as const;
export const CALIBRATION_ENV_CONTRADICTION_WEIGHT =
  'MEMBERRY_CALIBRATION_CONTRADICTION_WEIGHT' as const;
export const CALIBRATION_ENV_MIN_SIGNAL_WEIGHT =
  'MEMBERRY_CALIBRATION_MIN_SIGNAL_WEIGHT' as const;

export type CalibrationContractErrorCode =
  | 'not_object'
  | 'unknown_key'
  | 'missing_key'
  | 'invalid_type'
  | 'invalid_number'
  | 'out_of_bounds'
  | 'noncanonical';

/** Contract failures mention only closed field paths and codes, never input values. */
export class CalibrationContractError extends Error {
  constructor(
    readonly code: CalibrationContractErrorCode,
    readonly field: string,
  ) {
    super(`calibration_contract:${code}:${field}`);
    this.name = 'CalibrationContractError';
  }
}

/**
 * Content-free by construction: one observed semantic node reduced to its
 * stored confidence and per-type signal counts. No ids, text, tags, or
 * scopes cross this contract.
 */
export interface CalibrationObservationV1 {
  readonly confidencePermille: number;
  readonly reinforcements: number;
  readonly corrections: number;
  readonly contradictions: number;
}

export interface CalibrationConfigV1 {
  readonly signalWeights: {
    readonly reinforcement: number;
    readonly correction: number;
    readonly contradiction: number;
  };
  /** RAW weight-sum units on the same scale as signalWeights — NOT permille. */
  readonly minSignalWeight: number;
}

export interface ObservedCorrectnessV1 {
  readonly observed: boolean;
  readonly observedCorrectPermille: number | null;
}

export interface ReliabilityBinV1 {
  readonly lowerPermille: number;
  readonly upperPermille: number;
  readonly observedCount: number;
  readonly meanPredictedPermille: number;
  readonly observedCorrectPermille: number;
  readonly gapPermille: number;
  readonly empty: boolean;
}

export interface ReliabilityReportV1 {
  readonly contractVersion: typeof CALIBRATION_CONTRACT_VERSION;
  readonly configIdentity: `sha256:${string}`;
  readonly totalCount: number;
  readonly observedCount: number;
  readonly unobservedCount: number;
  readonly bins: readonly ReliabilityBinV1[];
  readonly expectedCalibrationErrorPermille: number;
  readonly maxCalibrationGapPermille: number;
  readonly brierPermille: number;
}

interface IntegerBounds {
  readonly min: number;
  readonly max: number;
}

function closedRecord(
  value: unknown,
  field: string,
  keys: readonly string[],
): Record<PropertyKey, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new CalibrationContractError('not_object', field);
    }
    if (nodeUtilTypes.isProxy(value)) throw new CalibrationContractError('invalid_type', field);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CalibrationContractError('invalid_type', field);
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length > keys.length) {
      throw new CalibrationContractError('unknown_key', field);
    }
    const allowed = new Set<PropertyKey>(keys);
    for (const key of ownKeys) {
      if (typeof key !== 'string' || !allowed.has(key)) {
        throw new CalibrationContractError('unknown_key', field);
      }
    }
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        throw new CalibrationContractError('missing_key', `${field}.${key}`);
      }
    }
    const clone = Object.create(null) as Record<PropertyKey, unknown>;
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new CalibrationContractError('invalid_type', field);
      }
      Object.defineProperty(clone, key, {
        value: descriptor.value,
        enumerable: descriptor.enumerable,
        configurable: true,
        writable: true,
      });
    }
    return clone;
  } catch (error) {
    if (error instanceof CalibrationContractError) throw error;
    throw new CalibrationContractError('invalid_type', field);
  }
}

function integerValue(value: unknown, field: string, bounds: IntegerBounds): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CalibrationContractError('invalid_number', field);
  }
  if (Object.is(value, -0) || !Number.isSafeInteger(value)) {
    throw new CalibrationContractError('noncanonical', field);
  }
  if (value < bounds.min || value > bounds.max) {
    throw new CalibrationContractError('out_of_bounds', field);
  }
  return value;
}

const OBSERVATION_KEYS = [
  'confidencePermille',
  'reinforcements',
  'corrections',
  'contradictions',
] as const;

const PERMILLE_BOUNDS: IntegerBounds = Object.freeze({ min: 0, max: 1_000 });
const COUNT_BOUNDS: IntegerBounds = Object.freeze({ min: 0, max: Number.MAX_SAFE_INTEGER });
const WEIGHT_BOUNDS: IntegerBounds = Object.freeze({ min: 1, max: 1_000 });
const MIN_SIGNAL_WEIGHT_BOUNDS: IntegerBounds = Object.freeze({ min: 1, max: 100_000 });

export function parseCalibrationObservationV1(value: unknown): CalibrationObservationV1 {
  const field = 'calibrationObservation';
  const input = closedRecord(value, field, OBSERVATION_KEYS);
  return Object.freeze({
    confidencePermille: integerValue(input.confidencePermille, `${field}.confidencePermille`, PERMILLE_BOUNDS),
    reinforcements: integerValue(input.reinforcements, `${field}.reinforcements`, COUNT_BOUNDS),
    corrections: integerValue(input.corrections, `${field}.corrections`, COUNT_BOUNDS),
    contradictions: integerValue(input.contradictions, `${field}.contradictions`, COUNT_BOUNDS),
  });
}

/** Stored float confidence (0..1 inclusive) to the closed integer permille grid. */
export function confidenceToPermille(x: number): number {
  const field = 'confidence';
  if (typeof x !== 'number' || !Number.isFinite(x)) {
    throw new CalibrationContractError('invalid_number', field);
  }
  if (Object.is(x, -0)) {
    throw new CalibrationContractError('noncanonical', field);
  }
  if (x < 0 || x > 1) {
    throw new CalibrationContractError('out_of_bounds', field);
  }
  return Math.round(x * 1000);
}

const CONFIG_KEYS = ['signalWeights', 'minSignalWeight'] as const;
const WEIGHT_KEYS = ['reinforcement', 'correction', 'contradiction'] as const;

export function parseCalibrationConfigV1(value: unknown): CalibrationConfigV1 {
  const field = 'calibrationConfig';
  const input = closedRecord(value, field, CONFIG_KEYS);
  const weights = closedRecord(input.signalWeights, `${field}.signalWeights`, WEIGHT_KEYS);
  return Object.freeze({
    signalWeights: Object.freeze({
      reinforcement: integerValue(weights.reinforcement, `${field}.signalWeights.reinforcement`, WEIGHT_BOUNDS),
      correction: integerValue(weights.correction, `${field}.signalWeights.correction`, WEIGHT_BOUNDS),
      contradiction: integerValue(weights.contradiction, `${field}.signalWeights.contradiction`, WEIGHT_BOUNDS),
    }),
    minSignalWeight: integerValue(input.minSignalWeight, `${field}.minSignalWeight`, MIN_SIGNAL_WEIGHT_BOUNDS),
  });
}

export const DEFAULT_CALIBRATION_CONFIG: CalibrationConfigV1 = parseCalibrationConfigV1({
  signalWeights: {
    reinforcement: CALIBRATION_DEFAULT_REINFORCEMENT_WEIGHT,
    correction: CALIBRATION_DEFAULT_CORRECTION_WEIGHT,
    contradiction: CALIBRATION_DEFAULT_CONTRADICTION_WEIGHT,
  },
  minSignalWeight: CALIBRATION_DEFAULT_MIN_SIGNAL_WEIGHT,
});

/**
 * Environment resolution for the report-side calibration weights. Unset
 * variables keep the frozen defaults; set variables must be digits-only, and
 * the combined result must still satisfy the full config contract.
 */
export function resolveCalibrationConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CalibrationConfigV1 {
  const resolve = (envVar: string, fallback: number, fieldPath: string): number => {
    const raw = env[envVar]?.trim();
    if (raw === undefined || raw === '') return fallback;
    if (!/^[0-9]+$/.test(raw)) {
      throw new CalibrationContractError('invalid_number', fieldPath);
    }
    return Number(raw);
  };
  const defaults = DEFAULT_CALIBRATION_CONFIG;
  return parseCalibrationConfigV1({
    signalWeights: {
      reinforcement: resolve(
        CALIBRATION_ENV_REINFORCEMENT_WEIGHT,
        defaults.signalWeights.reinforcement,
        'calibrationConfig.signalWeights.reinforcement',
      ),
      correction: resolve(
        CALIBRATION_ENV_CORRECTION_WEIGHT,
        defaults.signalWeights.correction,
        'calibrationConfig.signalWeights.correction',
      ),
      contradiction: resolve(
        CALIBRATION_ENV_CONTRADICTION_WEIGHT,
        defaults.signalWeights.contradiction,
        'calibrationConfig.signalWeights.contradiction',
      ),
    },
    minSignalWeight: resolve(
      CALIBRATION_ENV_MIN_SIGNAL_WEIGHT,
      defaults.minSignalWeight,
      'calibrationConfig.minSignalWeight',
    ),
  });
}

/** Fixed-key JSON representation used only for deterministic config identity. */
export function canonicalCalibrationConfigV1(config: unknown): string {
  return JSON.stringify(parseCalibrationConfigV1(config));
}

/** Content-free, cross-runtime identity for a resolved calibration configuration. */
export function calibrationConfigIdentityV1(config: unknown): `sha256:${string}` {
  const canonical = canonicalCalibrationConfigV1(config);
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/**
 * Weighted observed-correctness for one node. Exported: MEM-008 consumes it
 * per-proposal and must not fork this math. A node is observed iff its total
 * signal weight reaches minSignalWeight (raw weight-sum units).
 */
export function observedCorrectnessV1(
  observation: CalibrationObservationV1,
  config: CalibrationConfigV1,
): ObservedCorrectnessV1 {
  const obs = parseCalibrationObservationV1(observation);
  const cfg = parseCalibrationConfigV1(config);
  const correctWeight = obs.reinforcements * cfg.signalWeights.reinforcement;
  const incorrectWeight =
    obs.corrections * cfg.signalWeights.correction
    + obs.contradictions * cfg.signalWeights.contradiction;
  const totalWeight = correctWeight + incorrectWeight;
  const observed = totalWeight >= cfg.minSignalWeight;
  return Object.freeze({
    observed,
    observedCorrectPermille: observed ? Math.round((1000 * correctWeight) / totalWeight) : null,
  });
}

interface BinAccumulator {
  observedCount: number;
  sumPredictedPermille: number;
  sumCorrectWeight: number;
  sumTotalWeight: number;
}

/**
 * Deterministic pooled reliability report. Bin math sums integer weights over
 * each bin's observed nodes and divides once (per-node rounded values are
 * never averaged), so input array order cannot affect any output byte.
 */
export function buildReliabilityReportV1(
  observations: readonly CalibrationObservationV1[],
  config: CalibrationConfigV1,
): ReliabilityReportV1 {
  if (!Array.isArray(observations)) {
    throw new CalibrationContractError('invalid_type', 'calibrationObservations');
  }
  const cfg = parseCalibrationConfigV1(config);
  const configIdentity = calibrationConfigIdentityV1(cfg);

  const accumulators: BinAccumulator[] = Array.from({ length: CALIBRATION_BIN_COUNT }, () => ({
    observedCount: 0,
    sumPredictedPermille: 0,
    sumCorrectWeight: 0,
    sumTotalWeight: 0,
  }));

  let observedCount = 0;
  let unobservedCount = 0;
  let sumSquaredErrorPermille = 0;

  for (const raw of observations) {
    const obs = parseCalibrationObservationV1(raw);
    const correctness = observedCorrectnessV1(obs, cfg);
    if (!correctness.observed || correctness.observedCorrectPermille === null) {
      unobservedCount += 1;
      continue;
    }
    observedCount += 1;
    // Half-open [k·100, (k+1)·100) bins; 1000 lands in the last bin.
    const binIndex = Math.min(CALIBRATION_BIN_COUNT - 1, Math.floor(obs.confidencePermille / 100));
    const bin = accumulators[binIndex]!;
    bin.observedCount += 1;
    bin.sumPredictedPermille += obs.confidencePermille;
    const correctWeight = obs.reinforcements * cfg.signalWeights.reinforcement;
    const totalWeight = correctWeight
      + obs.corrections * cfg.signalWeights.correction
      + obs.contradictions * cfg.signalWeights.contradiction;
    bin.sumCorrectWeight += correctWeight;
    bin.sumTotalWeight += totalWeight;
    const error = obs.confidencePermille - correctness.observedCorrectPermille;
    sumSquaredErrorPermille += error * error;
  }

  let weightedAbsoluteGap = 0;
  let maxCalibrationGapPermille = 0;
  const bins = accumulators.map((acc, index) => {
    const lowerPermille = index * 100;
    const upperPermille = lowerPermille + 100;
    if (acc.observedCount === 0) {
      // Null-free sentinel; consumers MUST filter on `empty` before averaging.
      return Object.freeze({
        lowerPermille,
        upperPermille,
        observedCount: 0,
        meanPredictedPermille: lowerPermille + 50,
        observedCorrectPermille: lowerPermille + 50,
        gapPermille: 0,
        empty: true,
      });
    }
    const meanPredictedPermille = Math.round(acc.sumPredictedPermille / acc.observedCount);
    const observedCorrectPermille = Math.round((1000 * acc.sumCorrectWeight) / acc.sumTotalWeight);
    const gapPermille = meanPredictedPermille - observedCorrectPermille;
    weightedAbsoluteGap += acc.observedCount * Math.abs(gapPermille);
    if (Math.abs(gapPermille) > maxCalibrationGapPermille) {
      maxCalibrationGapPermille = Math.abs(gapPermille);
    }
    return Object.freeze({
      lowerPermille,
      upperPermille,
      observedCount: acc.observedCount,
      meanPredictedPermille,
      observedCorrectPermille,
      gapPermille,
      empty: false,
    });
  });

  return Object.freeze({
    contractVersion: CALIBRATION_CONTRACT_VERSION,
    configIdentity,
    totalCount: observations.length,
    observedCount,
    unobservedCount,
    bins: Object.freeze(bins),
    expectedCalibrationErrorPermille:
      observedCount === 0 ? 0 : Math.round(weightedAbsoluteGap / observedCount),
    maxCalibrationGapPermille,
    brierPermille:
      observedCount === 0 ? 0 : Math.round(sumSquaredErrorPermille / (1000 * observedCount)),
  });
}

/** Content-free, cross-runtime identity over the canonical fixed-key report JSON. */
export function reportIdentityV1(report: ReliabilityReportV1): `sha256:${string}` {
  if (typeof report !== 'object' || report === null) {
    throw new CalibrationContractError('not_object', 'reliabilityReport');
  }
  const canonical = JSON.stringify({
    contractVersion: report.contractVersion,
    configIdentity: report.configIdentity,
    totalCount: report.totalCount,
    observedCount: report.observedCount,
    unobservedCount: report.unobservedCount,
    bins: report.bins.map((bin) => ({
      lowerPermille: bin.lowerPermille,
      upperPermille: bin.upperPermille,
      observedCount: bin.observedCount,
      meanPredictedPermille: bin.meanPredictedPermille,
      observedCorrectPermille: bin.observedCorrectPermille,
      gapPermille: bin.gapPermille,
      empty: bin.empty,
    })),
    expectedCalibrationErrorPermille: report.expectedCalibrationErrorPermille,
    maxCalibrationGapPermille: report.maxCalibrationGapPermille,
    brierPermille: report.brierPermille,
  });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}
