// MEM-002 productionization: strict parser for the v3 candidate artifact.
//
// The candidate-v3 worker emits a bounded JSON artifact over the v3 scenario
// inputs. This is the single host-side definition of that artifact's shape,
// shared by the live proof and the sealed-prediction scoring path. Parsing
// discipline mirrors prediction-artifact.ts: bounded bytes, closed record,
// exact identity constants, and exact input-order binding.

import { types as nodeUtilTypes } from 'node:util';

import {
  ADMISSION_FEATURE_DATASET_ID_V3,
  ADMISSION_FEATURE_DATASET_VERSION_V3,
  parseAdmissionFeaturePredictionListV3,
  type AdmissionFeatureScenarioInputV3,
  type AdmissionFeatureScenarioPredictionV3,
} from './contract-v3.js';
import {
  ADMISSION_FEATURE_CONTRACT_VERSION_V2,
} from '../../../packages/core/src/admission-features-v2.js';

export const ADMISSION_FEATURE_PREDICTION_ARTIFACT_VERSION_V3 = '1.0.0' as const;
const ARTIFACT_MAX_BYTES = 32_768;
const ARTIFACT_KEYS = [
  'artifactVersion', 'datasetId', 'datasetVersion', 'featureContractVersion', 'predictions',
] as const;

export interface AdmissionFeaturePredictionArtifactV3 {
  readonly artifactVersion: typeof ADMISSION_FEATURE_PREDICTION_ARTIFACT_VERSION_V3;
  readonly datasetId: typeof ADMISSION_FEATURE_DATASET_ID_V3;
  readonly datasetVersion: typeof ADMISSION_FEATURE_DATASET_VERSION_V3;
  readonly featureContractVersion: typeof ADMISSION_FEATURE_CONTRACT_VERSION_V2;
  readonly predictions: readonly AdmissionFeatureScenarioPredictionV3[];
}

export class AdmissionFeaturePredictionArtifactV3Error extends Error {
  constructor(readonly code: string) {
    super(`admission_feature_prediction_artifact_v3:${code}`);
    this.name = 'AdmissionFeaturePredictionArtifactV3Error';
  }
}

function fail(code: string): never {
  throw new AdmissionFeaturePredictionArtifactV3Error(code);
}

export function parseAdmissionFeaturePredictionArtifactV3(
  bytes: Uint8Array,
  inputs: readonly AdmissionFeatureScenarioInputV3[],
): AdmissionFeaturePredictionArtifactV3 {
  if (typeof bytes !== 'object' || bytes === null || nodeUtilTypes.isProxy(bytes)
    || Object.getPrototypeOf(bytes) !== Uint8Array.prototype) fail('bytes');
  if (bytes.byteLength < 2 || bytes.byteLength > ARTIFACT_MAX_BYTES) fail('bytes');
  let raw: Record<string, unknown>;
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes))) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || nodeUtilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('shape');
    raw = value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AdmissionFeaturePredictionArtifactV3Error) throw error;
    fail('invalid_json');
  }
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== ARTIFACT_KEYS.length
    || keys.some((key) => typeof key !== 'string' || !(ARTIFACT_KEYS as readonly string[]).includes(key))) {
    fail('shape');
  }
  if (raw.artifactVersion !== ADMISSION_FEATURE_PREDICTION_ARTIFACT_VERSION_V3
    || raw.datasetId !== ADMISSION_FEATURE_DATASET_ID_V3
    || raw.datasetVersion !== ADMISSION_FEATURE_DATASET_VERSION_V3
    || raw.featureContractVersion !== ADMISSION_FEATURE_CONTRACT_VERSION_V2) fail('identity');
  const predictions = parseAdmissionFeaturePredictionListV3(raw.predictions);
  if (predictions.length !== inputs.length
    || predictions.some((prediction, index) => prediction.scenarioId !== inputs[index]!.scenarioId
      || prediction.split !== inputs[index]!.split)) fail('order');
  return Object.freeze({
    artifactVersion: ADMISSION_FEATURE_PREDICTION_ARTIFACT_VERSION_V3,
    datasetId: ADMISSION_FEATURE_DATASET_ID_V3,
    datasetVersion: ADMISSION_FEATURE_DATASET_VERSION_V3,
    featureContractVersion: ADMISSION_FEATURE_CONTRACT_VERSION_V2,
    predictions,
  });
}
