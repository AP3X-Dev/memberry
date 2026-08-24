import { types as nodeUtilTypes } from 'node:util';

import {
  ADMISSION_FEATURE_CONTRACT_ID,
  ADMISSION_FEATURE_CONTRACT_VERSION,
  ADMISSION_FEATURE_EXTRACTOR_ID,
  ADMISSION_FEATURE_EXTRACTOR_VERSION,
  ADMISSION_FEATURE_DIMENSIONS,
  parseAdmissionFeatureEnvelopeV1,
  type AdmissionFeatureDimensionsV1,
  type AdmissionFeatureEnvelopeV1,
} from '../../../packages/core/src/admission-features.js';

export const ADMISSION_FEATURE_DATASET_ID = 'memberry.synthetic-admission-feature-labels' as const;
export const ADMISSION_FEATURE_DATASET_VERSION = '2.0.0' as const;
export const ADMISSION_FEATURE_EVALUATION_CONTRACT_VERSION = '1.0.0' as const;
export const ADMISSION_FEATURE_SCENARIO_LIMIT = 128 as const;

export type AdmissionFeatureFixtureSplit = 'dev' | 'holdout';

export interface AdmissionFeatureSyntheticSignalsV1 {
  readonly priority: 'none' | 'normal' | 'explicit' | 'unknown';
  readonly noveltyEvidence: 'none' | 'partial' | 'independent' | 'unknown';
  readonly retentionHorizon: 'transient' | 'session' | 'durable' | 'unknown';
  readonly evidenceSupport: 'none' | 'single' | 'corroborated' | 'unknown';
  readonly scopeBinding: 'missing' | 'inferred' | 'explicit' | 'unknown';
  readonly sensitivitySignal: 'none' | 'possible' | 'confirmed' | 'unknown';
}

export interface AdmissionFeatureScenarioInputV1 {
  readonly datasetId: typeof ADMISSION_FEATURE_DATASET_ID;
  readonly datasetVersion: typeof ADMISSION_FEATURE_DATASET_VERSION;
  readonly scenarioId: string;
  readonly split: AdmissionFeatureFixtureSplit;
  /** Opaque synthetic fixture identity. It carries no labels or source content. */
  readonly fixtureCode: string;
  /** Content-free categorical evidence for a future extractor under test. */
  readonly signals: AdmissionFeatureSyntheticSignalsV1;
}

export interface AdmissionFeatureScenarioOracleV1 {
  readonly scenarioId: string;
  readonly split: AdmissionFeatureFixtureSplit;
  readonly dimensions: AdmissionFeatureDimensionsV1;
}

export interface AdmissionFeatureScenarioPredictionV1 {
  readonly scenarioId: string;
  readonly split: AdmissionFeatureFixtureSplit;
  readonly features: AdmissionFeatureEnvelopeV1;
}

export class AdmissionFeatureEvaluationContractError extends Error {
  constructor(readonly code: string, readonly field: string) {
    super(`admission_feature_evaluation:${code}:${field}`);
    this.name = 'AdmissionFeatureEvaluationContractError';
  }
}

interface DataRecord {
  readonly source: object;
  readonly values: Readonly<Record<string, unknown>>;
}

function dataRecord(value: unknown, field: string, allowed: readonly string[], required = allowed): DataRecord {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
      throw new AdmissionFeatureEvaluationContractError('not_plain_object', field);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new AdmissionFeatureEvaluationContractError('not_plain_object', field);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > allowed.length) throw new AdmissionFeatureEvaluationContractError('unknown_key', field);
    const allowedKeys = new Set(allowed);
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== 'string' || !allowedKeys.has(key)) {
        throw new AdmissionFeatureEvaluationContractError('unknown_key', field);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new AdmissionFeatureEvaluationContractError('accessor_forbidden', `${field}.${key}`);
      }
      result[key] = descriptor.value;
    }
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(result, key)) {
        throw new AdmissionFeatureEvaluationContractError('missing_key', `${field}.${key}`);
      }
    }
    return { source: value, values: result };
  } catch (error) {
    if (error instanceof AdmissionFeatureEvaluationContractError) throw error;
    throw new AdmissionFeatureEvaluationContractError('invalid_container', field);
  }
}

function denseArray(value: unknown, field: string): readonly unknown[] {
  try {
    if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      throw new AdmissionFeatureEvaluationContractError('not_plain_array', field);
    }
    const length = value.length;
    if (!Number.isSafeInteger(length) || length < 1 || length > ADMISSION_FEATURE_SCENARIO_LIMIT) {
      throw new AdmissionFeatureEvaluationContractError('invalid_length', field);
    }
    const expected = new Set<PropertyKey>(['length']);
    for (let index = 0; index < length; index += 1) expected.add(String(index));
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
      throw new AdmissionFeatureEvaluationContractError('invalid_array', field);
    }
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new AdmissionFeatureEvaluationContractError('accessor_forbidden', `${field}[]`);
      }
      result.push(descriptor.value);
    }
    return result;
  } catch (error) {
    if (error instanceof AdmissionFeatureEvaluationContractError) throw error;
    throw new AdmissionFeatureEvaluationContractError('invalid_container', field);
  }
}

function split(value: unknown, field: string): AdmissionFeatureFixtureSplit {
  if (value !== 'dev' && value !== 'holdout') {
    throw new AdmissionFeatureEvaluationContractError('invalid_enum', field);
  }
  return value;
}

function scenarioId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^af-(?:dev|holdout)-[0-9]{3}$/.test(value)) {
    throw new AdmissionFeatureEvaluationContractError('invalid_id', field);
  }
  return value;
}

function fixtureCode(value: unknown): string {
  if (typeof value !== 'string' || !/^case-[0-9]{3}$/.test(value)) {
    throw new AdmissionFeatureEvaluationContractError('invalid_id', 'input.fixtureCode');
  }
  return value;
}

function enumValue<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new AdmissionFeatureEvaluationContractError('invalid_enum', field);
  }
  return value as T;
}

function syntheticSignals(value: unknown): AdmissionFeatureSyntheticSignalsV1 {
  const keys = [
    'priority', 'noveltyEvidence', 'retentionHorizon', 'evidenceSupport',
    'scopeBinding', 'sensitivitySignal',
  ] as const;
  const record = dataRecord(value, 'input.signals', keys).values;
  return Object.freeze({
    priority: enumValue(record.priority, 'input.signals.priority', ['none', 'normal', 'explicit', 'unknown']),
    noveltyEvidence: enumValue(record.noveltyEvidence, 'input.signals.noveltyEvidence', ['none', 'partial', 'independent', 'unknown']),
    retentionHorizon: enumValue(record.retentionHorizon, 'input.signals.retentionHorizon', ['transient', 'session', 'durable', 'unknown']),
    evidenceSupport: enumValue(record.evidenceSupport, 'input.signals.evidenceSupport', ['none', 'single', 'corroborated', 'unknown']),
    scopeBinding: enumValue(record.scopeBinding, 'input.signals.scopeBinding', ['missing', 'inferred', 'explicit', 'unknown']),
    sensitivitySignal: enumValue(record.sensitivitySignal, 'input.signals.sensitivitySignal', ['none', 'possible', 'confirmed', 'unknown']),
  });
}

function featureEnvelope(dimensions: unknown): AdmissionFeatureEnvelopeV1 {
  return parseAdmissionFeatureEnvelopeV1({
    contractId: ADMISSION_FEATURE_CONTRACT_ID,
    contractVersion: ADMISSION_FEATURE_CONTRACT_VERSION,
    extractor: {
      id: ADMISSION_FEATURE_EXTRACTOR_ID,
      version: ADMISSION_FEATURE_EXTRACTOR_VERSION,
    },
    dimensions,
  });
}

export function parseAdmissionFeatureScenarioInputV1(value: unknown): AdmissionFeatureScenarioInputV1 {
  const record = dataRecord(
    value,
    'input',
    ['datasetId', 'datasetVersion', 'scenarioId', 'split', 'fixtureCode', 'signals'],
  ).values;
  if (record.datasetId !== ADMISSION_FEATURE_DATASET_ID) {
    throw new AdmissionFeatureEvaluationContractError('invalid_identity', 'input.datasetId');
  }
  if (record.datasetVersion !== ADMISSION_FEATURE_DATASET_VERSION) {
    throw new AdmissionFeatureEvaluationContractError('invalid_identity', 'input.datasetVersion');
  }
  const parsedSplit = split(record.split, 'input.split');
  const parsedId = scenarioId(record.scenarioId, 'input.scenarioId');
  if (!parsedId.startsWith(`af-${parsedSplit}-`)) {
    throw new AdmissionFeatureEvaluationContractError('split_mismatch', 'input.scenarioId');
  }
  return Object.freeze({
    datasetId: ADMISSION_FEATURE_DATASET_ID,
    datasetVersion: ADMISSION_FEATURE_DATASET_VERSION,
    scenarioId: parsedId,
    split: parsedSplit,
    fixtureCode: fixtureCode(record.fixtureCode),
    signals: syntheticSignals(record.signals),
  });
}

export function parseAdmissionFeatureScenarioOracleV1(value: unknown): AdmissionFeatureScenarioOracleV1 {
  const record = dataRecord(value, 'oracle', ['scenarioId', 'split', 'dimensions']).values;
  const parsedSplit = split(record.split, 'oracle.split');
  const parsedId = scenarioId(record.scenarioId, 'oracle.scenarioId');
  if (!parsedId.startsWith(`af-${parsedSplit}-`)) {
    throw new AdmissionFeatureEvaluationContractError('split_mismatch', 'oracle.scenarioId');
  }
  return Object.freeze({
    scenarioId: parsedId,
    split: parsedSplit,
    dimensions: featureEnvelope(record.dimensions).dimensions,
  });
}

export function parseAdmissionFeatureScenarioPredictionV1(value: unknown): AdmissionFeatureScenarioPredictionV1 {
  const record = dataRecord(value, 'prediction', ['scenarioId', 'split', 'features']).values;
  const parsedSplit = split(record.split, 'prediction.split');
  const parsedId = scenarioId(record.scenarioId, 'prediction.scenarioId');
  if (!parsedId.startsWith(`af-${parsedSplit}-`)) {
    throw new AdmissionFeatureEvaluationContractError('split_mismatch', 'prediction.scenarioId');
  }
  return Object.freeze({
    scenarioId: parsedId,
    split: parsedSplit,
    features: parseAdmissionFeatureEnvelopeV1(record.features),
  });
}

function parseList<T>(
  value: unknown,
  field: string,
  parse: (entry: unknown) => T & { readonly scenarioId: string },
): readonly T[] {
  const parsed = denseArray(value, field).map(parse);
  const ids = parsed.map(({ scenarioId: id }) => id);
  if (new Set(ids).size !== ids.length) {
    throw new AdmissionFeatureEvaluationContractError('duplicate_id', field);
  }
  return Object.freeze(parsed);
}

export function parseAdmissionFeatureInputListV1(value: unknown): readonly AdmissionFeatureScenarioInputV1[] {
  return parseList(value, 'inputs', parseAdmissionFeatureScenarioInputV1);
}

export function parseAdmissionFeatureOracleListV1(value: unknown): readonly AdmissionFeatureScenarioOracleV1[] {
  return parseList(value, 'oracles', parseAdmissionFeatureScenarioOracleV1);
}

export function parseAdmissionFeaturePredictionListV1(value: unknown): readonly AdmissionFeatureScenarioPredictionV1[] {
  return parseList(value, 'predictions', parseAdmissionFeatureScenarioPredictionV1);
}

export { ADMISSION_FEATURE_DIMENSIONS };
