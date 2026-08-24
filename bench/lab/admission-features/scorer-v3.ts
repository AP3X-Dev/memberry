// MEM-002 productionization: v3 agreement scorer for the live producer.
//
// Same agreement-counting semantics as the frozen scorer.ts, applied over the
// narrowed ADMISSION_FEATURE_DIMENSIONS_V2 (3 cells per scenario), with the
// same per-split pass rule at the SAME frozen gate value re-declared here
// (scorer.ts and its policy object are not touched). `unavailable` is scored
// as an explicit label, never skipped.

import {
  ADMISSION_FEATURE_DIMENSIONS_V2,
  ADMISSION_FEATURE_EVALUATION_CONTRACT_VERSION_V3,
  parseAdmissionFeatureInputListV3,
  parseAdmissionFeatureOracleListV3,
  parseAdmissionFeaturePredictionListV3,
  type AdmissionFeatureFixtureSplitV3,
  type AdmissionFeatureScenarioInputV3,
  type AdmissionFeatureScenarioOracleV3,
  type AdmissionFeatureScenarioPredictionV3,
} from './contract-v3.js';
import type { AdmissionFeatureValueV1 } from '../../../packages/core/src/admission-features.js';

export const ADMISSION_FEATURE_AGREEMENT_POLICY_V3 = Object.freeze({
  requiredAgreementPermille: 1_000,
});

export interface AdmissionFeatureAgreementMetricsV3 {
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

export interface AdmissionFeatureAgreementReportV3 {
  readonly contractVersion: typeof ADMISSION_FEATURE_EVALUATION_CONTRACT_VERSION_V3;
  readonly policy: typeof ADMISSION_FEATURE_AGREEMENT_POLICY_V3;
  readonly metrics: AdmissionFeatureAgreementMetricsV3;
  readonly splits: Readonly<Record<AdmissionFeatureFixtureSplitV3, AdmissionFeatureAgreementMetricsV3>>;
  readonly failures: readonly string[];
  readonly passed: boolean;
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

function metrics(counts: MutableCounts): AdmissionFeatureAgreementMetricsV3 {
  return Object.freeze({
    ...counts,
    agreementPermille: counts.dimensionCount === 0
      ? 0
      : Math.floor((counts.agreementCount * 1_000) / counts.dimensionCount),
  });
}

function recordComparison(
  counts: MutableCounts,
  expected: AdmissionFeatureValueV1,
  actual: AdmissionFeatureValueV1 | undefined,
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

export function scoreAdmissionFeatureAgreementV3(options: {
  inputs: readonly AdmissionFeatureScenarioInputV3[];
  oracles: readonly AdmissionFeatureScenarioOracleV3[];
  predictions: readonly AdmissionFeatureScenarioPredictionV3[];
  /** Splits that must be non-empty. The dev gate scores ['dev'] before the
   *  holdout fixtures exist; the one-shot holdout run requires both. */
  requiredSplits?: readonly AdmissionFeatureFixtureSplitV3[];
}): AdmissionFeatureAgreementReportV3 {
  const inputs = parseAdmissionFeatureInputListV3(options.inputs);
  const oracles = parseAdmissionFeatureOracleListV3(options.oracles);
  const predictions = parseAdmissionFeaturePredictionListV3(options.predictions);
  const requiredSplits = options.requiredSplits ?? (['dev', 'holdout'] as const);
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
  const splitCounts: Record<AdmissionFeatureFixtureSplitV3, MutableCounts> = {
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
    for (const dimension of ADMISSION_FEATURE_DIMENSIONS_V2) {
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
  if (resultMetrics.agreementPermille < ADMISSION_FEATURE_AGREEMENT_POLICY_V3.requiredAgreementPermille) {
    failures.push(`agreementPermille: expected at least ${ADMISSION_FEATURE_AGREEMENT_POLICY_V3.requiredAgreementPermille}`);
  }
  for (const split of requiredSplits) {
    if (splits[split].scenarioCount === 0) failures.push(`${split}: no scenarios`);
    if (splits[split].agreementPermille < ADMISSION_FEATURE_AGREEMENT_POLICY_V3.requiredAgreementPermille) {
      failures.push(`${split}.agreementPermille: expected at least ${ADMISSION_FEATURE_AGREEMENT_POLICY_V3.requiredAgreementPermille}`);
    }
  }
  const uniqueFailures = Object.freeze([...new Set(failures)]);
  return Object.freeze({
    contractVersion: ADMISSION_FEATURE_EVALUATION_CONTRACT_VERSION_V3,
    policy: ADMISSION_FEATURE_AGREEMENT_POLICY_V3,
    metrics: resultMetrics,
    splits,
    failures: uniqueFailures,
    passed: uniqueFailures.length === 0,
  });
}
