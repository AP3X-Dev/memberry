import { createHash } from 'node:crypto';

import {
  ADMISSION_FEATURE_DIMENSIONS,
  ADMISSION_FEATURE_EVALUATION_CONTRACT_VERSION,
  parseAdmissionFeatureInputListV1,
  parseAdmissionFeatureOracleListV1,
  parseAdmissionFeaturePredictionListV1,
  type AdmissionFeatureFixtureSplit,
  type AdmissionFeatureScenarioInputV1,
  type AdmissionFeatureScenarioOracleV1,
  type AdmissionFeatureScenarioPredictionV1,
} from './contract.js';

export const ADMISSION_FEATURE_AGREEMENT_POLICY = Object.freeze({
  requiredAgreementPermille: 1_000,
});

export interface AdmissionFeatureAgreementMetricsV1 {
  readonly scenarioCount: number;
  readonly dimensionCount: number;
  readonly agreementCount: number;
  readonly agreementPermille: number;
  readonly availableLabelCount: number;
  readonly unavailableLabelCount: number;
  readonly availableAgreementCount: number;
  readonly unavailableAgreementCount: number;
  readonly availabilityMismatchCount: number;
  readonly valueMismatchCount: number;
}

export interface AdmissionFeatureAgreementReportV1 {
  readonly contractVersion: typeof ADMISSION_FEATURE_EVALUATION_CONTRACT_VERSION;
  readonly policy: typeof ADMISSION_FEATURE_AGREEMENT_POLICY;
  readonly metrics: AdmissionFeatureAgreementMetricsV1;
  readonly splits: Readonly<Record<AdmissionFeatureFixtureSplit, AdmissionFeatureAgreementMetricsV1>>;
  readonly failures: readonly string[];
  readonly passed: boolean;
}

interface EvidenceIdentity {
  readonly inputHash: `sha256:${string}`;
  readonly oracleHash: `sha256:${string}`;
}

const registeredEvidence = new WeakMap<AdmissionFeatureAgreementReportV1, EvidenceIdentity>();

function hashCanonical(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

export function admissionFeatureAgreementEvidenceIdentity(
  report: AdmissionFeatureAgreementReportV1,
): EvidenceIdentity | undefined {
  return registeredEvidence.get(report);
}

interface MutableCounts {
  scenarioCount: number;
  dimensionCount: number;
  agreementCount: number;
  availableLabelCount: number;
  unavailableLabelCount: number;
  availableAgreementCount: number;
  unavailableAgreementCount: number;
  availabilityMismatchCount: number;
  valueMismatchCount: number;
}

function emptyCounts(): MutableCounts {
  return {
    scenarioCount: 0,
    dimensionCount: 0,
    agreementCount: 0,
    availableLabelCount: 0,
    unavailableLabelCount: 0,
    availableAgreementCount: 0,
    unavailableAgreementCount: 0,
    availabilityMismatchCount: 0,
    valueMismatchCount: 0,
  };
}

function metrics(counts: MutableCounts): AdmissionFeatureAgreementMetricsV1 {
  return Object.freeze({
    ...counts,
    agreementPermille: counts.dimensionCount === 0
      ? 0
      : Math.floor((counts.agreementCount * 1_000) / counts.dimensionCount),
  });
}

function recordComparison(
  counts: MutableCounts,
  expected: AdmissionFeatureScenarioOracleV1['dimensions'][keyof AdmissionFeatureScenarioOracleV1['dimensions']],
  actual: AdmissionFeatureScenarioPredictionV1['features']['dimensions'][keyof AdmissionFeatureScenarioPredictionV1['features']['dimensions']] | undefined,
): void {
  counts.dimensionCount += 1;
  if (expected.availability === 'unavailable') counts.unavailableLabelCount += 1;
  else counts.availableLabelCount += 1;
  if (!actual || actual.availability !== expected.availability) {
    counts.availabilityMismatchCount += 1;
    return;
  }
  if (expected.availability === 'unavailable') {
    counts.agreementCount += 1;
    counts.unavailableAgreementCount += 1;
    return;
  }
  if (actual.availability === 'available' && actual.valuePermille === expected.valuePermille) {
    counts.agreementCount += 1;
    counts.availableAgreementCount += 1;
  } else {
    counts.valueMismatchCount += 1;
  }
}

function idsExactlyMatch(required: readonly string[], actual: readonly string[]): boolean {
  return actual.length === required.length
    && new Set(actual).size === actual.length
    && required.every((id) => actual.includes(id));
}

export function scoreAdmissionFeatureAgreement(options: {
  inputs: readonly AdmissionFeatureScenarioInputV1[];
  oracles: readonly AdmissionFeatureScenarioOracleV1[];
  predictions: readonly AdmissionFeatureScenarioPredictionV1[];
}): AdmissionFeatureAgreementReportV1 {
  const inputs = parseAdmissionFeatureInputListV1(options.inputs);
  const oracles = parseAdmissionFeatureOracleListV1(options.oracles);
  const predictions = parseAdmissionFeaturePredictionListV1(options.predictions);
  const requiredIds = inputs.map(({ scenarioId }) => scenarioId);
  const failures: string[] = [];
  if (!idsExactlyMatch(requiredIds, oracles.map(({ scenarioId }) => scenarioId))) {
    failures.push('oracle IDs must exactly match fixture inputs');
  }
  if (!idsExactlyMatch(requiredIds, predictions.map(({ scenarioId }) => scenarioId))) {
    failures.push('prediction IDs must exactly match fixture inputs');
  }

  const byOracle = new Map(oracles.map((value) => [value.scenarioId, value]));
  const byPrediction = new Map(predictions.map((value) => [value.scenarioId, value]));
  const total = emptyCounts();
  const splitCounts: Record<AdmissionFeatureFixtureSplit, MutableCounts> = {
    dev: emptyCounts(),
    holdout: emptyCounts(),
  };
  for (const input of inputs) {
    total.scenarioCount += 1;
    splitCounts[input.split].scenarioCount += 1;
    const oracle = byOracle.get(input.scenarioId);
    const prediction = byPrediction.get(input.scenarioId);
    if (oracle?.split !== input.split) failures.push(`${input.scenarioId}: oracle split mismatch`);
    if (prediction?.split !== input.split) failures.push(`${input.scenarioId}: prediction split mismatch`);
    for (const dimension of ADMISSION_FEATURE_DIMENSIONS) {
      if (!oracle) {
        total.dimensionCount += 1;
        splitCounts[input.split].dimensionCount += 1;
        total.availabilityMismatchCount += 1;
        splitCounts[input.split].availabilityMismatchCount += 1;
        continue;
      }
      recordComparison(total, oracle.dimensions[dimension], prediction?.features.dimensions[dimension]);
      recordComparison(splitCounts[input.split], oracle.dimensions[dimension], prediction?.features.dimensions[dimension]);
    }
  }
  const resultMetrics = metrics(total);
  const splits = Object.freeze({ dev: metrics(splitCounts.dev), holdout: metrics(splitCounts.holdout) });
  if (resultMetrics.agreementPermille < ADMISSION_FEATURE_AGREEMENT_POLICY.requiredAgreementPermille) {
    failures.push(`agreementPermille: expected at least ${ADMISSION_FEATURE_AGREEMENT_POLICY.requiredAgreementPermille}`);
  }
  for (const split of ['dev', 'holdout'] as const) {
    if (splits[split].scenarioCount === 0) failures.push(`${split}: no scenarios`);
    if (splits[split].agreementPermille < ADMISSION_FEATURE_AGREEMENT_POLICY.requiredAgreementPermille) {
      failures.push(`${split}.agreementPermille: expected at least ${ADMISSION_FEATURE_AGREEMENT_POLICY.requiredAgreementPermille}`);
    }
  }
  const uniqueFailures = Object.freeze([...new Set(failures)]);
  const report = Object.freeze({
    contractVersion: ADMISSION_FEATURE_EVALUATION_CONTRACT_VERSION,
    policy: ADMISSION_FEATURE_AGREEMENT_POLICY,
    metrics: resultMetrics,
    splits,
    failures: uniqueFailures,
    passed: uniqueFailures.length === 0,
  });
  registeredEvidence.set(report, Object.freeze({
    inputHash: hashCanonical(inputs),
    oracleHash: hashCanonical(oracles),
  }));
  return report;
}
