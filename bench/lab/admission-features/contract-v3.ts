// MEM-002 productionization: v3 evaluation contract for the LIVE producer.
//
// The v1/v2 instruments score six-dimension v1 envelopes over synthetic lab
// signals and are frozen evidence. The candidate under test here is the
// production module packages/core/src/admission-feature-producer.ts, whose
// input is the safe-facts record and whose output is the narrowed
// three-dimension v2 envelope — hence a new dataset version and new scenario
// input/oracle/prediction shapes. Parsing discipline mirrors contract.ts.

import { types as nodeUtilTypes } from 'node:util';

import {
  parseAdmissionSafeFactsV1,
  type AdmissionSafeFactsV1,
} from '../../../packages/core/src/admission.js';
import { ADMISSION_FEATURE_CONTRACT_ID } from '../../../packages/core/src/admission-features.js';
import {
  ADMISSION_FEATURE_CONTRACT_VERSION_V2,
  ADMISSION_FEATURE_DIMENSIONS_V2,
  ADMISSION_FEATURE_EXTRACTOR_ID_V2,
  ADMISSION_FEATURE_EXTRACTOR_VERSION_V2,
  parseAdmissionFeatureEnvelopeV2,
  type AdmissionFeatureDimensionsV2,
  type AdmissionFeatureEnvelopeV2,
} from '../../../packages/core/src/admission-features-v2.js';

export const ADMISSION_FEATURE_DATASET_ID_V3 = 'memberry.synthetic-admission-feature-labels' as const;
export const ADMISSION_FEATURE_DATASET_VERSION_V3 = '3.0.0' as const;
export const ADMISSION_FEATURE_EVALUATION_CONTRACT_VERSION_V3 = '1.0.0' as const;
export const ADMISSION_FEATURE_SCENARIO_LIMIT_V3 = 128 as const;

export type AdmissionFeatureFixtureSplitV3 = 'dev' | 'holdout';

/**
 * The producer's exact input surface: the five safe facts it reads. The lab
 * completes them to a full AdmissionSafeFactsV1 with fixed neutral values
 * (see completeAdmissionFeatureFactsV3) — none of which the producer consumes.
 */
export interface AdmissionFeatureScenarioFactsV3 {
  readonly memoryClass: AdmissionSafeFactsV1['memoryClass'];
  readonly outcome: AdmissionSafeFactsV1['outcome'];
  readonly sensitivity: AdmissionSafeFactsV1['sensitivity'];
  readonly hasSignals: boolean;
  readonly hasEntities: boolean;
}

export interface AdmissionFeatureScenarioInputV3 {
  readonly datasetId: typeof ADMISSION_FEATURE_DATASET_ID_V3;
  readonly datasetVersion: typeof ADMISSION_FEATURE_DATASET_VERSION_V3;
  readonly scenarioId: string;
  readonly split: AdmissionFeatureFixtureSplitV3;
  /** Opaque synthetic fixture identity. It carries no labels or source content. */
  readonly fixtureCode: string;
  /** Content-free producer input: closed five-key safe-facts subset. */
  readonly facts: AdmissionFeatureScenarioFactsV3;
}

export interface AdmissionFeatureScenarioOracleV3 {
  readonly scenarioId: string;
  readonly split: AdmissionFeatureFixtureSplitV3;
  readonly dimensions: AdmissionFeatureDimensionsV2;
}

export interface AdmissionFeatureScenarioPredictionV3 {
  readonly scenarioId: string;
  readonly split: AdmissionFeatureFixtureSplitV3;
  readonly features: AdmissionFeatureEnvelopeV2;
}

export class AdmissionFeatureEvaluationContractErrorV3 extends Error {
  constructor(readonly code: string, readonly field: string) {
    super(`admission_feature_evaluation_v3:${code}:${field}`);
    this.name = 'AdmissionFeatureEvaluationContractErrorV3';
  }
}

function dataRecord(
  value: unknown,
  field: string,
  allowed: readonly string[],
  required = allowed,
): Readonly<Record<string, unknown>> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
      throw new AdmissionFeatureEvaluationContractErrorV3('not_plain_object', field);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new AdmissionFeatureEvaluationContractErrorV3('not_plain_object', field);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > allowed.length) throw new AdmissionFeatureEvaluationContractErrorV3('unknown_key', field);
    const allowedKeys = new Set(allowed);
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== 'string' || !allowedKeys.has(key)) {
        throw new AdmissionFeatureEvaluationContractErrorV3('unknown_key', field);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new AdmissionFeatureEvaluationContractErrorV3('accessor_forbidden', `${field}.${key}`);
      }
      result[key] = descriptor.value;
    }
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(result, key)) {
        throw new AdmissionFeatureEvaluationContractErrorV3('missing_key', `${field}.${key}`);
      }
    }
    return result;
  } catch (error) {
    if (error instanceof AdmissionFeatureEvaluationContractErrorV3) throw error;
    throw new AdmissionFeatureEvaluationContractErrorV3('invalid_container', field);
  }
}

function denseArray(value: unknown, field: string): readonly unknown[] {
  try {
    if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      throw new AdmissionFeatureEvaluationContractErrorV3('not_plain_array', field);
    }
    const length = value.length;
    if (!Number.isSafeInteger(length) || length < 1 || length > ADMISSION_FEATURE_SCENARIO_LIMIT_V3) {
      throw new AdmissionFeatureEvaluationContractErrorV3('invalid_length', field);
    }
    const expected = new Set<PropertyKey>(['length']);
    for (let index = 0; index < length; index += 1) expected.add(String(index));
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
      throw new AdmissionFeatureEvaluationContractErrorV3('invalid_array', field);
    }
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new AdmissionFeatureEvaluationContractErrorV3('accessor_forbidden', `${field}[]`);
      }
      result.push(descriptor.value);
    }
    return result;
  } catch (error) {
    if (error instanceof AdmissionFeatureEvaluationContractErrorV3) throw error;
    throw new AdmissionFeatureEvaluationContractErrorV3('invalid_container', field);
  }
}

function split(value: unknown, field: string): AdmissionFeatureFixtureSplitV3 {
  if (value !== 'dev' && value !== 'holdout') {
    throw new AdmissionFeatureEvaluationContractErrorV3('invalid_enum', field);
  }
  return value;
}

function scenarioId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^af3-(?:dev|holdout)-[0-9]{3}$/.test(value)) {
    throw new AdmissionFeatureEvaluationContractErrorV3('invalid_id', field);
  }
  return value;
}

function fixtureCode(value: unknown): string {
  if (typeof value !== 'string' || !/^case-[0-9]{3}$/.test(value)) {
    throw new AdmissionFeatureEvaluationContractErrorV3('invalid_id', 'input.fixtureCode');
  }
  return value;
}

function enumValue<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new AdmissionFeatureEvaluationContractErrorV3('invalid_enum', field);
  }
  return value as T;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new AdmissionFeatureEvaluationContractErrorV3('invalid_type', field);
  }
  return value;
}

function scenarioFacts(value: unknown): AdmissionFeatureScenarioFactsV3 {
  const keys = ['memoryClass', 'outcome', 'sensitivity', 'hasSignals', 'hasEntities'] as const;
  const record = dataRecord(value, 'input.facts', keys);
  return Object.freeze({
    memoryClass: enumValue(record.memoryClass, 'input.facts.memoryClass', [
      'decision', 'pattern', 'convention', 'architecture', 'preference', 'fact', 'general', 'unclassified',
    ]),
    outcome: enumValue(record.outcome, 'input.facts.outcome', [
      'approved', 'revised', 'rejected', 'abandoned', 'unspecified',
    ]),
    sensitivity: enumValue(record.sensitivity, 'input.facts.sensitivity', ['detected', 'not-detected']),
    hasSignals: booleanValue(record.hasSignals, 'input.facts.hasSignals'),
    hasEntities: booleanValue(record.hasEntities, 'input.facts.hasEntities'),
  });
}

/**
 * Complete the five scenario facts to a full branded AdmissionSafeFactsV1
 * through the production parser. The fixed neutral values are documented
 * here and NOT consumed by the producer: contractVersion '1.0.0',
 * captureState 'accepted-nonduplicate', tenantScope 'resolved', projectScope
 * 'resolved', redactionConfigured true, hasModel false.
 */
export function completeAdmissionFeatureFactsV3(facts: AdmissionFeatureScenarioFactsV3): AdmissionSafeFactsV1 {
  return parseAdmissionSafeFactsV1({
    contractVersion: '1.0.0',
    captureState: 'accepted-nonduplicate',
    memoryClass: facts.memoryClass,
    outcome: facts.outcome,
    tenantScope: 'resolved',
    projectScope: 'resolved',
    sensitivity: facts.sensitivity,
    redactionConfigured: true,
    hasSignals: facts.hasSignals,
    hasEntities: facts.hasEntities,
    hasModel: false,
  });
}

function featureEnvelope(dimensions: unknown): AdmissionFeatureEnvelopeV2 {
  return parseAdmissionFeatureEnvelopeV2({
    contractId: ADMISSION_FEATURE_CONTRACT_ID,
    contractVersion: ADMISSION_FEATURE_CONTRACT_VERSION_V2,
    extractor: {
      id: ADMISSION_FEATURE_EXTRACTOR_ID_V2,
      version: ADMISSION_FEATURE_EXTRACTOR_VERSION_V2,
    },
    dimensions,
  });
}

export function parseAdmissionFeatureScenarioInputV3(value: unknown): AdmissionFeatureScenarioInputV3 {
  const record = dataRecord(
    value,
    'input',
    ['datasetId', 'datasetVersion', 'scenarioId', 'split', 'fixtureCode', 'facts'],
  );
  if (record.datasetId !== ADMISSION_FEATURE_DATASET_ID_V3) {
    throw new AdmissionFeatureEvaluationContractErrorV3('invalid_identity', 'input.datasetId');
  }
  if (record.datasetVersion !== ADMISSION_FEATURE_DATASET_VERSION_V3) {
    throw new AdmissionFeatureEvaluationContractErrorV3('invalid_identity', 'input.datasetVersion');
  }
  const parsedSplit = split(record.split, 'input.split');
  const parsedId = scenarioId(record.scenarioId, 'input.scenarioId');
  if (!parsedId.startsWith(`af3-${parsedSplit}-`)) {
    throw new AdmissionFeatureEvaluationContractErrorV3('split_mismatch', 'input.scenarioId');
  }
  return Object.freeze({
    datasetId: ADMISSION_FEATURE_DATASET_ID_V3,
    datasetVersion: ADMISSION_FEATURE_DATASET_VERSION_V3,
    scenarioId: parsedId,
    split: parsedSplit,
    fixtureCode: fixtureCode(record.fixtureCode),
    facts: scenarioFacts(record.facts),
  });
}

export function parseAdmissionFeatureScenarioOracleV3(value: unknown): AdmissionFeatureScenarioOracleV3 {
  const record = dataRecord(value, 'oracle', ['scenarioId', 'split', 'dimensions']);
  const parsedSplit = split(record.split, 'oracle.split');
  const parsedId = scenarioId(record.scenarioId, 'oracle.scenarioId');
  if (!parsedId.startsWith(`af3-${parsedSplit}-`)) {
    throw new AdmissionFeatureEvaluationContractErrorV3('split_mismatch', 'oracle.scenarioId');
  }
  return Object.freeze({
    scenarioId: parsedId,
    split: parsedSplit,
    dimensions: featureEnvelope(record.dimensions).dimensions,
  });
}

export function parseAdmissionFeatureScenarioPredictionV3(value: unknown): AdmissionFeatureScenarioPredictionV3 {
  const record = dataRecord(value, 'prediction', ['scenarioId', 'split', 'features']);
  const parsedSplit = split(record.split, 'prediction.split');
  const parsedId = scenarioId(record.scenarioId, 'prediction.scenarioId');
  if (!parsedId.startsWith(`af3-${parsedSplit}-`)) {
    throw new AdmissionFeatureEvaluationContractErrorV3('split_mismatch', 'prediction.scenarioId');
  }
  return Object.freeze({
    scenarioId: parsedId,
    split: parsedSplit,
    features: parseAdmissionFeatureEnvelopeV2(record.features),
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
    throw new AdmissionFeatureEvaluationContractErrorV3('duplicate_id', field);
  }
  return Object.freeze(parsed);
}

export function parseAdmissionFeatureInputListV3(value: unknown): readonly AdmissionFeatureScenarioInputV3[] {
  return parseList(value, 'inputs', parseAdmissionFeatureScenarioInputV3);
}

export function parseAdmissionFeatureOracleListV3(value: unknown): readonly AdmissionFeatureScenarioOracleV3[] {
  return parseList(value, 'oracles', parseAdmissionFeatureScenarioOracleV3);
}

export function parseAdmissionFeaturePredictionListV3(value: unknown): readonly AdmissionFeatureScenarioPredictionV3[] {
  return parseList(value, 'predictions', parseAdmissionFeatureScenarioPredictionV3);
}

export { ADMISSION_FEATURE_DIMENSIONS_V2 };
