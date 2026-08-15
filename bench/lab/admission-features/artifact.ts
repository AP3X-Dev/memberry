import { createHash } from 'node:crypto';

import {
  ADMISSION_FEATURE_DATASET_ID,
  ADMISSION_FEATURE_DATASET_VERSION,
  ADMISSION_FEATURE_EVALUATION_CONTRACT_VERSION,
  parseAdmissionFeatureInputListV1,
  parseAdmissionFeatureOracleListV1,
  type AdmissionFeatureScenarioInputV1,
  type AdmissionFeatureScenarioOracleV1,
} from './contract.js';
import {
  admissionFeatureAgreementEvidenceIdentity,
  type AdmissionFeatureAgreementReportV1,
} from './scorer.js';

export const ADMISSION_FEATURE_ARTIFACT_VERSION = '1.0.0' as const;

export interface AdmissionFeatureEvaluationArtifactV1 {
  readonly artifactVersion: typeof ADMISSION_FEATURE_ARTIFACT_VERSION;
  readonly evaluationContractVersion: typeof ADMISSION_FEATURE_EVALUATION_CONTRACT_VERSION;
  readonly dataset: {
    readonly id: typeof ADMISSION_FEATURE_DATASET_ID;
    readonly version: typeof ADMISSION_FEATURE_DATASET_VERSION;
    readonly inputHash: `sha256:${string}`;
    readonly oracleHash: `sha256:${string}`;
  };
  readonly evidenceMode: 'scorer-conformance';
  readonly report: AdmissionFeatureAgreementReportV1;
}

const registeredArtifacts = new WeakSet<AdmissionFeatureEvaluationArtifactV1>();

function hashCanonical(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

export function buildAdmissionFeatureEvaluationArtifact(options: {
  inputs: readonly AdmissionFeatureScenarioInputV1[];
  oracles: readonly AdmissionFeatureScenarioOracleV1[];
  report: AdmissionFeatureAgreementReportV1;
}): AdmissionFeatureEvaluationArtifactV1 {
  const inputs = parseAdmissionFeatureInputListV1(options.inputs);
  const oracles = parseAdmissionFeatureOracleListV1(options.oracles);
  const evidence = admissionFeatureAgreementEvidenceIdentity(options.report);
  const inputHash = hashCanonical(inputs);
  const oracleHash = hashCanonical(oracles);
  if (!evidence || evidence.inputHash !== inputHash || evidence.oracleHash !== oracleHash) {
    throw new Error('admission_feature_artifact:unregistered_or_mismatched_evidence');
  }
  const artifact = Object.freeze({
    artifactVersion: ADMISSION_FEATURE_ARTIFACT_VERSION,
    evaluationContractVersion: ADMISSION_FEATURE_EVALUATION_CONTRACT_VERSION,
    dataset: Object.freeze({
      id: ADMISSION_FEATURE_DATASET_ID,
      version: ADMISSION_FEATURE_DATASET_VERSION,
      inputHash,
      oracleHash,
    }),
    evidenceMode: 'scorer-conformance',
    report: options.report,
  });
  registeredArtifacts.add(artifact);
  return artifact;
}

export function canonicalAdmissionFeatureEvaluationArtifact(artifact: AdmissionFeatureEvaluationArtifactV1): string {
  if (!registeredArtifacts.has(artifact)) throw new Error('admission_feature_artifact:unregistered');
  return JSON.stringify(artifact);
}

export function admissionFeatureEvaluationArtifactIdentity(artifact: AdmissionFeatureEvaluationArtifactV1): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalAdmissionFeatureEvaluationArtifact(artifact), 'utf8').digest('hex')}`;
}
