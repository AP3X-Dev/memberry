// MEM-002 productionization: v3 candidate adapter.
//
// The candidate under test is the PRODUCTION module
// packages/core/src/admission-feature-producer.ts — imported directly, with no
// lab copy of the mapping. This adapter only parses the v3 scenario inputs,
// completes them to safe facts through the production parser, and emits the v3
// prediction artifact. Container packaging (canonical networkless build,
// sandbox policy, runtime probes) is finalized with the custodian seal before
// the owner-gated dispatch, following the frozen candidate/ discipline.

import { pathToFileURL } from 'node:url';

import { produceAdmissionFeatureEnvelopeV2 } from '../../../../packages/core/src/admission-feature-producer.js';
import {
  ADMISSION_FEATURE_DATASET_ID_V3,
  ADMISSION_FEATURE_DATASET_VERSION_V3,
  completeAdmissionFeatureFactsV3,
  parseAdmissionFeatureInputListV3,
  type AdmissionFeatureScenarioInputV3,
  type AdmissionFeatureScenarioPredictionV3,
} from '../contract-v3.js';
import {
  ADMISSION_FEATURE_CONTRACT_VERSION_V2,
} from '../../../../packages/core/src/admission-features-v2.js';

export const ADMISSION_FEATURE_CANDIDATE_V3_ARTIFACT_VERSION = '1.0.0' as const;
const MAX_IO_BYTES = 32_768;

export interface AdmissionFeatureCandidateV3Artifact {
  readonly artifactVersion: typeof ADMISSION_FEATURE_CANDIDATE_V3_ARTIFACT_VERSION;
  readonly datasetId: typeof ADMISSION_FEATURE_DATASET_ID_V3;
  readonly datasetVersion: typeof ADMISSION_FEATURE_DATASET_VERSION_V3;
  readonly featureContractVersion: typeof ADMISSION_FEATURE_CONTRACT_VERSION_V2;
  readonly predictions: readonly AdmissionFeatureScenarioPredictionV3[];
}

export class CandidateAdmissionFeatureV3Error extends Error {
  constructor(readonly code: string, readonly field: string) {
    super(`admission_feature_candidate_v3:${code}:${field}`);
    this.name = 'CandidateAdmissionFeatureV3Error';
  }
}

function predict(input: AdmissionFeatureScenarioInputV3): AdmissionFeatureScenarioPredictionV3 {
  return Object.freeze({
    scenarioId: input.scenarioId,
    split: input.split,
    features: produceAdmissionFeatureEnvelopeV2(completeAdmissionFeatureFactsV3(input.facts)),
  });
}

/** Pure prediction pass over parsed v3 inputs — the exact scored surface. */
export function runAdmissionFeatureCandidateV3(
  inputs: unknown,
): AdmissionFeatureCandidateV3Artifact {
  const parsed = parseAdmissionFeatureInputListV3(inputs);
  return Object.freeze({
    artifactVersion: ADMISSION_FEATURE_CANDIDATE_V3_ARTIFACT_VERSION,
    datasetId: ADMISSION_FEATURE_DATASET_ID_V3,
    datasetVersion: ADMISSION_FEATURE_DATASET_VERSION_V3,
    featureContractVersion: ADMISSION_FEATURE_CONTRACT_VERSION_V2,
    predictions: Object.freeze(parsed.map((input) => predict(input))),
  });
}

/** Bounded bytes-in/bytes-out surface used by the container runtime. */
export function runAdmissionFeatureCandidateV3Bytes(bytes: Uint8Array): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_IO_BYTES) {
    throw new CandidateAdmissionFeatureV3Error('size_out_of_bounds', 'input');
  }
  let value: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('')) throw new Error('invalid');
    value = JSON.parse(text);
  } catch {
    throw new CandidateAdmissionFeatureV3Error('invalid_json', 'input');
  }
  const artifact = runAdmissionFeatureCandidateV3(value);
  const output = new TextEncoder().encode(JSON.stringify(artifact));
  if (output.byteLength < 1 || output.byteLength > MAX_IO_BYTES) {
    throw new CandidateAdmissionFeatureV3Error('size_out_of_bounds', 'artifact');
  }
  return output;
}

async function readStdin(): Promise<Uint8Array> {
  const buffer = new Uint8Array(MAX_IO_BYTES);
  let length = 0;
  for await (const chunk of process.stdin) {
    if (!(chunk instanceof Uint8Array) || length + chunk.byteLength > MAX_IO_BYTES) {
      throw new CandidateAdmissionFeatureV3Error('size_out_of_bounds', 'input');
    }
    buffer.set(chunk, length);
    length += chunk.byteLength;
  }
  if (length < 1) throw new CandidateAdmissionFeatureV3Error('size_out_of_bounds', 'input');
  return buffer.slice(0, length);
}

async function main(): Promise<void> {
  if (process.argv.length !== 3 || process.argv[2] !== '-') {
    process.stderr.write('admission_feature_candidate_v3:invalid_arguments:argv\n');
    process.exitCode = 20;
    return;
  }
  try {
    process.stdout.write(runAdmissionFeatureCandidateV3Bytes(await readStdin()));
  } catch (error) {
    const message = error instanceof CandidateAdmissionFeatureV3Error
      ? error.message
      : 'admission_feature_candidate_v3:input_invalid:input';
    process.stderr.write(`${message}\n`);
    process.exitCode = 21;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main();
}
