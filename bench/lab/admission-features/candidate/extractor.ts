import { createHash } from 'node:crypto';
import { types as nodeUtilTypes } from 'node:util';

export const ADMISSION_FEATURE_CANDIDATE_MAX_SCENARIOS = 128 as const;
export const ADMISSION_FEATURE_CANDIDATE_MAX_BYTES = 32_768 as const;

const DATASET_ID = 'memberry.synthetic-admission-feature-labels' as const;
const VERSION = '1.0.0' as const;
const DATASET_VERSION = '2.0.0' as const;
const CONTRACT_ID = 'memberry.admission-feature-envelope' as const;
const EXTRACTOR_ID = 'memberry.precomputed-feature-signals' as const;
const FIXED_INPUT_HASH =
  'sha256:457d5483b8c22f62415f5952ffa743936f0b34348cf72bafe315dd8432448428' as const;
const FIXED_SCENARIOS = Object.freeze([
  Object.freeze({ scenarioId: 'af-dev-001', split: 'dev' }),
  Object.freeze({ scenarioId: 'af-dev-002', split: 'dev' }),
  Object.freeze({ scenarioId: 'af-dev-003', split: 'dev' }),
  Object.freeze({ scenarioId: 'af-dev-004', split: 'dev' }),
  Object.freeze({ scenarioId: 'af-dev-005', split: 'dev' }),
  Object.freeze({ scenarioId: 'af-dev-006', split: 'dev' }),
  Object.freeze({ scenarioId: 'af-dev-007', split: 'dev' }),
  Object.freeze({ scenarioId: 'af-dev-008', split: 'dev' }),
  Object.freeze({ scenarioId: 'af-dev-009', split: 'dev' }),
  Object.freeze({ scenarioId: 'af-holdout-001', split: 'holdout' }),
  Object.freeze({ scenarioId: 'af-holdout-002', split: 'holdout' }),
  Object.freeze({ scenarioId: 'af-holdout-003', split: 'holdout' }),
  Object.freeze({ scenarioId: 'af-holdout-004', split: 'holdout' }),
] as const);

const SIGNAL_KEYS = [
  'priority',
  'noveltyEvidence',
  'retentionHorizon',
  'evidenceSupport',
  'scopeBinding',
  'sensitivitySignal',
] as const;
const INPUT_KEYS = [
  'datasetId',
  'datasetVersion',
  'scenarioId',
  'split',
  'fixtureCode',
  'signals',
] as const;

type Split = 'dev' | 'holdout';
type Availability = Readonly<{ availability: 'unavailable' }>
  | Readonly<{ availability: 'available'; valuePermille: number }>;

export interface CandidateAdmissionFeatureSignalsV1 {
  readonly priority: 'none' | 'normal' | 'explicit' | 'unknown';
  readonly noveltyEvidence: 'none' | 'partial' | 'independent' | 'unknown';
  readonly retentionHorizon: 'transient' | 'session' | 'durable' | 'unknown';
  readonly evidenceSupport: 'none' | 'single' | 'corroborated' | 'unknown';
  readonly scopeBinding: 'missing' | 'inferred' | 'explicit' | 'unknown';
  readonly sensitivitySignal: 'none' | 'possible' | 'confirmed' | 'unknown';
}

export interface CandidateAdmissionFeatureInputV1 {
  readonly datasetId: typeof DATASET_ID;
  readonly datasetVersion: typeof VERSION;
  readonly scenarioId: string;
  readonly split: Split;
  readonly fixtureCode: string;
  readonly signals: CandidateAdmissionFeatureSignalsV1;
}

export interface CandidateAdmissionFeatureEnvelopeV1 {
  readonly contractId: typeof CONTRACT_ID;
  readonly contractVersion: typeof VERSION;
  readonly extractor: Readonly<{ id: typeof EXTRACTOR_ID; version: typeof VERSION }>;
  readonly dimensions: Readonly<{
    salience: Availability;
    novelty: Availability;
    durability: Availability;
    evidenceQuality: Availability;
    scopeConfidence: Availability;
    sensitivity: Availability;
  }>;
}

export interface CandidateAdmissionFeaturePredictionV1 {
  readonly scenarioId: string;
  readonly split: Split;
  readonly features: CandidateAdmissionFeatureEnvelopeV1;
}

export class CandidateAdmissionFeatureError extends Error {
  constructor(readonly code: string, readonly field: string) {
    super(`admission_feature_candidate:${code}:${field}`);
    this.name = 'CandidateAdmissionFeatureError';
  }
}

function plainRecord(
  value: unknown,
  field: string,
  allowed: readonly string[],
): Readonly<Record<string, unknown>> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
      throw new CandidateAdmissionFeatureError('not_plain_object', field);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CandidateAdmissionFeatureError('not_plain_object', field);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== allowed.length) {
      throw new CandidateAdmissionFeatureError('closed_keys', field);
    }
    const allowedKeys = new Set(allowed);
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== 'string' || !allowedKeys.has(key)) {
        throw new CandidateAdmissionFeatureError('closed_keys', field);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new CandidateAdmissionFeatureError('accessor_forbidden', `${field}.${key}`);
      }
      result[key] = descriptor.value;
    }
    for (const key of allowed) {
      if (!Object.prototype.hasOwnProperty.call(result, key)) {
        throw new CandidateAdmissionFeatureError('missing_key', `${field}.${key}`);
      }
    }
    return result;
  } catch (error) {
    if (error instanceof CandidateAdmissionFeatureError) throw error;
    throw new CandidateAdmissionFeatureError('invalid_container', field);
  }
}

function enumValue<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new CandidateAdmissionFeatureError('invalid_enum', field);
  }
  return value as T;
}

function parseSignals(value: unknown): CandidateAdmissionFeatureSignalsV1 {
  const record = plainRecord(value, 'signals', SIGNAL_KEYS);
  return Object.freeze({
    priority: enumValue(record.priority, 'signals.priority', ['none', 'normal', 'explicit', 'unknown']),
    noveltyEvidence: enumValue(
      record.noveltyEvidence,
      'signals.noveltyEvidence',
      ['none', 'partial', 'independent', 'unknown'],
    ),
    retentionHorizon: enumValue(
      record.retentionHorizon,
      'signals.retentionHorizon',
      ['transient', 'session', 'durable', 'unknown'],
    ),
    evidenceSupport: enumValue(
      record.evidenceSupport,
      'signals.evidenceSupport',
      ['none', 'single', 'corroborated', 'unknown'],
    ),
    scopeBinding: enumValue(
      record.scopeBinding,
      'signals.scopeBinding',
      ['missing', 'inferred', 'explicit', 'unknown'],
    ),
    sensitivitySignal: enumValue(
      record.sensitivitySignal,
      'signals.sensitivitySignal',
      ['none', 'possible', 'confirmed', 'unknown'],
    ),
  });
}

function parseInput(value: unknown): CandidateAdmissionFeatureInputV1 {
  const record = plainRecord(value, 'input', INPUT_KEYS);
  if (record.datasetId !== DATASET_ID) {
    throw new CandidateAdmissionFeatureError('invalid_identity', 'input.datasetId');
  }
  if (record.datasetVersion !== DATASET_VERSION) {
    throw new CandidateAdmissionFeatureError('invalid_identity', 'input.datasetVersion');
  }
  const split = enumValue(record.split, 'input.split', ['dev', 'holdout']);
  if (typeof record.scenarioId !== 'string' || !/^af-(?:dev|holdout)-[0-9]{3}$/.test(record.scenarioId)) {
    throw new CandidateAdmissionFeatureError('invalid_id', 'input.scenarioId');
  }
  if (!record.scenarioId.startsWith(`af-${split}-`)) {
    throw new CandidateAdmissionFeatureError('split_mismatch', 'input.scenarioId');
  }
  if (typeof record.fixtureCode !== 'string' || !/^case-[0-9]{3}$/.test(record.fixtureCode)) {
    throw new CandidateAdmissionFeatureError('invalid_id', 'input.fixtureCode');
  }
  return Object.freeze({
    datasetId: DATASET_ID,
    datasetVersion: DATASET_VERSION,
    scenarioId: record.scenarioId,
    split,
    fixtureCode: record.fixtureCode,
    signals: parseSignals(record.signals),
  });
}

function parseInputs(value: unknown): readonly CandidateAdmissionFeatureInputV1[] {
  try {
    if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      throw new CandidateAdmissionFeatureError('not_plain_array', 'inputs');
    }
    if (!Number.isSafeInteger(value.length) || value.length < 1
      || value.length > ADMISSION_FEATURE_CANDIDATE_MAX_SCENARIOS) {
      throw new CandidateAdmissionFeatureError('invalid_length', 'inputs');
    }
    const expectedKeys = new Set<PropertyKey>(['length']);
    for (let index = 0; index < value.length; index += 1) expectedKeys.add(String(index));
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.size || keys.some((key) => !expectedKeys.has(key))) {
      throw new CandidateAdmissionFeatureError('invalid_array', 'inputs');
    }
    const parsed: CandidateAdmissionFeatureInputV1[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new CandidateAdmissionFeatureError('accessor_forbidden', 'inputs[]');
      }
      parsed.push(parseInput(descriptor.value));
    }
    const ids = parsed.map(({ scenarioId }) => scenarioId);
    if (new Set(ids).size !== ids.length) {
      throw new CandidateAdmissionFeatureError('duplicate_id', 'inputs');
    }
    return Object.freeze(parsed);
  } catch (error) {
    if (error instanceof CandidateAdmissionFeatureError) throw error;
    throw new CandidateAdmissionFeatureError('invalid_container', 'inputs');
  }
}

const unavailable = (): Availability => Object.freeze({ availability: 'unavailable' });

function available(valuePermille: number): Availability {
  if (!Number.isSafeInteger(valuePermille) || valuePermille < 0 || valuePermille > 1_000) {
    throw new CandidateAdmissionFeatureError('invalid_value', 'dimensions');
  }
  return Object.freeze({ availability: 'available', valuePermille });
}

function mapped<T extends string>(category: T, values: Readonly<Record<T, number | undefined>>): Availability {
  const value = values[category];
  return value === undefined ? unavailable() : available(value);
}

/**
 * Pure, content-free C1 extraction implementing the public v2 labeling function
 * (fixtures/v2/MAPPING.md): per-dimension base tables plus two floor-at-zero
 * adjustment rules, all fully determined by the permitted DEV evidence.
 */
export function extractAdmissionFeatureEnvelopeV1(signals: unknown): CandidateAdmissionFeatureEnvelopeV1 {
  const parsed = parseSignals(signals);

  const salience = mapped(parsed.priority, {
    none: 25, normal: 100, explicit: 850, unknown: undefined,
  });

  const noveltyBase = {
    none: 50, partial: 500, independent: 900, unknown: undefined,
  }[parsed.noveltyEvidence];
  const novelty = noveltyBase === undefined
    ? unavailable()
    : available(Math.max(0, noveltyBase - (parsed.evidenceSupport === 'corroborated' ? 300 : 0)));

  const durability = mapped(parsed.retentionHorizon, {
    transient: 150, session: 700, durable: 800, unknown: undefined,
  });
  const evidenceQuality = mapped(parsed.evidenceSupport, {
    none: 0, single: 450, corroborated: 1_000, unknown: undefined,
  });

  const scopeBase = {
    missing: 100, inferred: 600, explicit: 1_000, unknown: undefined,
  }[parsed.scopeBinding];
  const scopeReduction = parsed.sensitivitySignal === 'possible'
    ? 100
    : parsed.sensitivitySignal === 'confirmed' ? 250 : 0;
  const scopeConfidence = scopeBase === undefined
    ? unavailable()
    : available(Math.max(0, scopeBase - scopeReduction));

  const sensitivity = mapped(parsed.sensitivitySignal, {
    none: 0, possible: 50, confirmed: 900, unknown: undefined,
  });

  return Object.freeze({
    contractId: CONTRACT_ID,
    contractVersion: VERSION,
    extractor: Object.freeze({ id: EXTRACTOR_ID, version: VERSION }),
    dimensions: Object.freeze({
      salience,
      novelty,
      durability,
      evidenceQuality,
      scopeConfidence,
      sensitivity,
    }),
  });
}

export function predictAdmissionFeatureScenarioV1(value: unknown): CandidateAdmissionFeaturePredictionV1 {
  const input = parseInput(value);
  return Object.freeze({
    scenarioId: input.scenarioId,
    split: input.split,
    features: extractAdmissionFeatureEnvelopeV1(input.signals),
  });
}

export function predictAdmissionFeatureScenariosV1(
  value: unknown,
): readonly CandidateAdmissionFeaturePredictionV1[] {
  const inputs = parseInputs(value);
  return Object.freeze(inputs.map((input) => predictAdmissionFeatureScenarioV1(input)));
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export function encodeAdmissionFeatureCandidateArtifactV1(value: unknown): Uint8Array {
  const inputs = parseInputs(value);
  if (sha256(JSON.stringify(inputs)) !== FIXED_INPUT_HASH) {
    throw new CandidateAdmissionFeatureError('input_corpus', 'inputs');
  }
  if (inputs.length !== FIXED_SCENARIOS.length) {
    throw new CandidateAdmissionFeatureError('scenario_count', 'inputs');
  }
  for (let index = 0; index < FIXED_SCENARIOS.length; index += 1) {
    const input = inputs[index]!;
    const fixed = FIXED_SCENARIOS[index]!;
    if (input.scenarioId !== fixed.scenarioId || input.split !== fixed.split) {
      throw new CandidateAdmissionFeatureError('input_corpus', `inputs[${index}]`);
    }
  }

  const artifact = Object.freeze({
    artifactVersion: VERSION,
    datasetId: DATASET_ID,
    datasetVersion: DATASET_VERSION,
    evaluationContractVersion: VERSION,
    featureContractVersion: VERSION,
    inputHash: FIXED_INPUT_HASH,
    predictions: predictAdmissionFeatureScenariosV1(inputs),
  });
  const bytes = new TextEncoder().encode(JSON.stringify(artifact));
  if (bytes.byteLength < 1 || bytes.byteLength > ADMISSION_FEATURE_CANDIDATE_MAX_BYTES) {
    throw new CandidateAdmissionFeatureError('size_out_of_bounds', 'artifact');
  }
  return bytes;
}
