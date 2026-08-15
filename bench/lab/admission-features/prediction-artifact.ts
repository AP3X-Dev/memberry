import { createHash } from 'node:crypto';
import { types as nodeUtilTypes } from 'node:util';

import { ADMISSION_FEATURE_CONTRACT_VERSION } from '../../../packages/core/src/admission-features.js';
import {
  ADMISSION_FEATURE_DATASET_ID,
  ADMISSION_FEATURE_DATASET_VERSION,
  ADMISSION_FEATURE_EVALUATION_CONTRACT_VERSION,
  parseAdmissionFeatureInputListV1,
  parseAdmissionFeaturePredictionListV1,
  type AdmissionFeatureScenarioInputV1,
  type AdmissionFeatureScenarioPredictionV1,
} from './contract.js';
import { loadAdmissionFeatureInputs } from './inputs.js';
import { loadAdmissionFeatureOracles } from './scorer-only/load.js';
import { scoreAdmissionFeatureAgreement, type AdmissionFeatureAgreementReportV1 } from './scorer.js';

export const ADMISSION_FEATURE_PREDICTION_ARTIFACT_VERSION = '1.0.0' as const;
export const ADMISSION_FEATURE_PREDICTION_ARTIFACT_MAX_BYTES = 32_768 as const;
const ADMISSION_FEATURE_FIXED_INPUT_HASH =
  'sha256:41ef02bbe9df03e4f7b4f95b248265a71635aefa7cbe69c585a1eb8647936b24' as const;
const ADMISSION_FEATURE_FIXED_SCENARIOS = Object.freeze([
  Object.freeze({ scenarioId: 'af-dev-001', split: 'dev' }),
  Object.freeze({ scenarioId: 'af-dev-002', split: 'dev' }),
  Object.freeze({ scenarioId: 'af-dev-003', split: 'dev' }),
  Object.freeze({ scenarioId: 'af-holdout-001', split: 'holdout' }),
  Object.freeze({ scenarioId: 'af-holdout-002', split: 'holdout' }),
  Object.freeze({ scenarioId: 'af-holdout-003', split: 'holdout' }),
] as const);

export interface AdmissionFeaturePredictionArtifactV1 {
  readonly artifactVersion: typeof ADMISSION_FEATURE_PREDICTION_ARTIFACT_VERSION;
  readonly datasetId: typeof ADMISSION_FEATURE_DATASET_ID;
  readonly datasetVersion: typeof ADMISSION_FEATURE_DATASET_VERSION;
  readonly evaluationContractVersion: typeof ADMISSION_FEATURE_EVALUATION_CONTRACT_VERSION;
  readonly featureContractVersion: typeof ADMISSION_FEATURE_CONTRACT_VERSION;
  readonly inputHash: `sha256:${string}`;
  readonly predictions: readonly AdmissionFeatureScenarioPredictionV1[];
}

export interface AdmissionFeaturePredictionEvidenceV1 {
  readonly evidenceMode: 'prediction-artifact';
  readonly predictionArtifactIdentity: `sha256:${string}`;
  readonly report: AdmissionFeatureAgreementReportV1;
}

export class AdmissionFeaturePredictionArtifactError extends Error {
  constructor(readonly code: string, readonly field: string) {
    super(`admission_feature_prediction_artifact:${code}:${field}`);
    this.name = 'AdmissionFeaturePredictionArtifactError';
  }
}

const ROOT_KEYS = [
  'artifactVersion', 'datasetId', 'datasetVersion', 'evaluationContractVersion',
  'featureContractVersion', 'inputHash', 'predictions',
] as const;
const canonicalByArtifact = new WeakMap<AdmissionFeaturePredictionArtifactV1, string>();
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get;

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function canonicalInputHash(inputs: readonly AdmissionFeatureScenarioInputV1[]): `sha256:${string}` {
  return sha256(JSON.stringify(inputs));
}

function exactBytes(value: unknown): Uint8Array {
  if (typeof value !== 'object' || value === null || nodeUtilTypes.isProxy(value)
    || (!Buffer.isBuffer(value) && Object.getPrototypeOf(value) !== Uint8Array.prototype)
    || !typedArrayByteLength || !typedArrayBuffer) {
    throw new AdmissionFeaturePredictionArtifactError('bytes_required', 'artifact');
  }
  let byteLength: number;
  let buffer: ArrayBufferLike;
  try {
    byteLength = Reflect.apply(typedArrayByteLength, value, []) as number;
    buffer = Reflect.apply(typedArrayBuffer, value, []) as ArrayBufferLike;
  } catch {
    throw new AdmissionFeaturePredictionArtifactError('bytes_required', 'artifact');
  }
  if (typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer) {
    throw new AdmissionFeaturePredictionArtifactError('bytes_required', 'artifact');
  }
  if (!Number.isSafeInteger(byteLength) || byteLength < 1
    || byteLength > ADMISSION_FEATURE_PREDICTION_ARTIFACT_MAX_BYTES) {
    throw new AdmissionFeaturePredictionArtifactError('size_out_of_bounds', 'artifact');
  }
  const copy = new Uint8Array(byteLength);
  try { Reflect.apply(Uint8Array.prototype.set, copy, [value]); }
  catch { throw new AdmissionFeaturePredictionArtifactError('bytes_required', 'artifact'); }
  return copy;
}

function closedRoot(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AdmissionFeaturePredictionArtifactError('not_object', 'artifact');
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new AdmissionFeaturePredictionArtifactError('not_plain_object', 'artifact');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== ROOT_KEYS.length) {
    throw new AdmissionFeaturePredictionArtifactError('closed_keys', 'artifact');
  }
  const allowed = new Set<string>(ROOT_KEYS);
  const record = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new AdmissionFeaturePredictionArtifactError('closed_keys', 'artifact');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new AdmissionFeaturePredictionArtifactError('invalid_property', `artifact.${key}`);
    }
    record[key] = descriptor.value;
  }
  for (const key of ROOT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new AdmissionFeaturePredictionArtifactError('missing_key', `artifact.${key}`);
    }
  }
  return record;
}

function validateCorpusIdentity(
  inputs: readonly AdmissionFeatureScenarioInputV1[],
  predictions: readonly AdmissionFeatureScenarioPredictionV1[],
): void {
  if (canonicalInputHash(inputs) !== ADMISSION_FEATURE_FIXED_INPUT_HASH) {
    throw new AdmissionFeaturePredictionArtifactError('input_corpus', 'fixtureInputs');
  }
  if (inputs.length !== ADMISSION_FEATURE_FIXED_SCENARIOS.length
    || predictions.length !== ADMISSION_FEATURE_FIXED_SCENARIOS.length) {
    throw new AdmissionFeaturePredictionArtifactError('scenario_count', 'artifact.predictions');
  }
  for (let index = 0; index < ADMISSION_FEATURE_FIXED_SCENARIOS.length; index += 1) {
    const input = inputs[index]!;
    const prediction = predictions[index]!;
    const fixed = ADMISSION_FEATURE_FIXED_SCENARIOS[index]!;
    if (input.scenarioId !== fixed.scenarioId || input.split !== fixed.split) {
      throw new AdmissionFeaturePredictionArtifactError('input_corpus', `fixtureInputs[${index}]`);
    }
    if (prediction.scenarioId !== fixed.scenarioId) {
      throw new AdmissionFeaturePredictionArtifactError('scenario_id', `artifact.predictions[${index}].scenarioId`);
    }
    if (prediction.split !== fixed.split) {
      throw new AdmissionFeaturePredictionArtifactError('scenario_split', `artifact.predictions[${index}].split`);
    }
  }
}

function canonicalArtifact(
  inputs: readonly AdmissionFeatureScenarioInputV1[],
  predictions: readonly AdmissionFeatureScenarioPredictionV1[],
): AdmissionFeaturePredictionArtifactV1 {
  validateCorpusIdentity(inputs, predictions);
  return Object.freeze({
    artifactVersion: ADMISSION_FEATURE_PREDICTION_ARTIFACT_VERSION,
    datasetId: ADMISSION_FEATURE_DATASET_ID,
    datasetVersion: ADMISSION_FEATURE_DATASET_VERSION,
    evaluationContractVersion: ADMISSION_FEATURE_EVALUATION_CONTRACT_VERSION,
    featureContractVersion: ADMISSION_FEATURE_CONTRACT_VERSION,
    inputHash: ADMISSION_FEATURE_FIXED_INPUT_HASH,
    predictions,
  });
}

export function parseAdmissionFeaturePredictionArtifactV1(
  bytes: unknown,
  fixtureInputs: readonly AdmissionFeatureScenarioInputV1[],
): AdmissionFeaturePredictionArtifactV1 {
  const canonicalInputs = parseAdmissionFeatureInputListV1(fixtureInputs);
  const copy = exactBytes(bytes);
  let text: string;
  let decoded: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(copy);
    decoded = JSON.parse(text) as unknown;
  } catch {
    throw new AdmissionFeaturePredictionArtifactError('invalid_json', 'artifact');
  }
  const record = closedRoot(decoded);
  if (record.artifactVersion !== ADMISSION_FEATURE_PREDICTION_ARTIFACT_VERSION) {
    throw new AdmissionFeaturePredictionArtifactError('version', 'artifact.artifactVersion');
  }
  if (record.datasetId !== ADMISSION_FEATURE_DATASET_ID) {
    throw new AdmissionFeaturePredictionArtifactError('identity', 'artifact.datasetId');
  }
  if (record.datasetVersion !== ADMISSION_FEATURE_DATASET_VERSION) {
    throw new AdmissionFeaturePredictionArtifactError('version', 'artifact.datasetVersion');
  }
  if (record.evaluationContractVersion !== ADMISSION_FEATURE_EVALUATION_CONTRACT_VERSION) {
    throw new AdmissionFeaturePredictionArtifactError('version', 'artifact.evaluationContractVersion');
  }
  if (record.featureContractVersion !== ADMISSION_FEATURE_CONTRACT_VERSION) {
    throw new AdmissionFeaturePredictionArtifactError('version', 'artifact.featureContractVersion');
  }
  if (record.inputHash !== ADMISSION_FEATURE_FIXED_INPUT_HASH) {
    throw new AdmissionFeaturePredictionArtifactError('input_hash', 'artifact.inputHash');
  }
  let predictions: readonly AdmissionFeatureScenarioPredictionV1[];
  try { predictions = parseAdmissionFeaturePredictionListV1(record.predictions); }
  catch { throw new AdmissionFeaturePredictionArtifactError('prediction_contract', 'artifact.predictions'); }
  const artifact = canonicalArtifact(canonicalInputs, predictions);
  const canonical = JSON.stringify(artifact);
  if (text !== canonical) {
    throw new AdmissionFeaturePredictionArtifactError('noncanonical_json', 'artifact');
  }
  canonicalByArtifact.set(artifact, canonical);
  return artifact;
}

export function encodeAdmissionFeaturePredictionArtifactV1(options: {
  inputs: readonly AdmissionFeatureScenarioInputV1[];
  predictions: readonly AdmissionFeatureScenarioPredictionV1[];
}): Uint8Array {
  const inputs = parseAdmissionFeatureInputListV1(options.inputs);
  const predictions = parseAdmissionFeaturePredictionListV1(options.predictions);
  const artifact = canonicalArtifact(inputs, predictions);
  const bytes = new TextEncoder().encode(JSON.stringify(artifact));
  // Keep encoding and acceptance on one contract path.
  parseAdmissionFeaturePredictionArtifactV1(bytes, inputs);
  return bytes;
}

export function admissionFeaturePredictionArtifactIdentityV1(
  artifact: AdmissionFeaturePredictionArtifactV1,
): `sha256:${string}` {
  const canonical = canonicalByArtifact.get(artifact);
  if (!canonical) throw new AdmissionFeaturePredictionArtifactError('unregistered', 'artifact');
  return sha256(canonical);
}

/** External boundary: only canonical prediction bytes enter; no code or callback is accepted. */
export async function runAdmissionFeaturePredictionEvidence(
  bytes: unknown,
): Promise<AdmissionFeaturePredictionEvidenceV1> {
  const inputs = await loadAdmissionFeatureInputs();
  const artifact = parseAdmissionFeaturePredictionArtifactV1(bytes, inputs);
  const predictionArtifactIdentity = admissionFeaturePredictionArtifactIdentityV1(artifact);
  // Scorer-only labels are opened only after byte, schema, corpus, canonical,
  // deep-freeze, and SHA checks have all completed.
  const oracles = await loadAdmissionFeatureOracles();
  const report = scoreAdmissionFeatureAgreement({ inputs, oracles, predictions: artifact.predictions });
  return Object.freeze({ evidenceMode: 'prediction-artifact', predictionArtifactIdentity, report });
}
