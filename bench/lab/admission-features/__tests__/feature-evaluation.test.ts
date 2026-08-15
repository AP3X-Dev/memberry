import { describe, expect, it } from 'vitest';

import {
  ADMISSION_FEATURE_AGREEMENT_POLICY,
  ADMISSION_FEATURE_DATASET_ID,
  ADMISSION_FEATURE_DATASET_VERSION,
  admissionFeatureEvaluationArtifactIdentity,
  buildAdmissionFeatureEvaluationArtifact,
  canonicalAdmissionFeatureEvaluationArtifact,
  loadAdmissionFeatureInputs,
  scoreAdmissionFeatureAgreement,
} from '../index.js';
import { loadAdmissionFeatureOracles } from '../scorer-only/load.js';

function exactPredictions(oracles: Awaited<ReturnType<typeof loadAdmissionFeatureOracles>>) {
  return oracles.map((oracle) => ({
    scenarioId: oracle.scenarioId,
    split: oracle.split,
    features: {
      contractId: 'memberry.admission-feature-envelope' as const,
      contractVersion: '1.0.0' as const,
      extractor: {
        id: 'memberry.precomputed-feature-signals' as const,
        version: '1.0.0' as const,
      },
      dimensions: structuredClone(oracle.dimensions),
    },
  }));
}

describe('MEM-002B admission feature evaluation contract', () => {
  it('loads physically separated versioned dev and holdout fixtures', async () => {
    const inputs = await loadAdmissionFeatureInputs();
    const oracles = await loadAdmissionFeatureOracles();

    expect(ADMISSION_FEATURE_DATASET_ID).toBe('memberry.synthetic-admission-feature-labels');
    expect(ADMISSION_FEATURE_DATASET_VERSION).toBe('1.0.0');
    expect(inputs).toHaveLength(6);
    expect(oracles).toHaveLength(6);
    expect(new Set(inputs.map(({ split }) => split))).toEqual(new Set(['dev', 'holdout']));
    expect(new Set(oracles.map(({ split }) => split))).toEqual(new Set(['dev', 'holdout']));
    expect(JSON.stringify(inputs)).not.toMatch(/dimensions|valuePermille|oracle|expected/i);
  });

  it('passes exact labels at the frozen 1000-permille threshold and scores unavailable explicitly', async () => {
    const inputs = await loadAdmissionFeatureInputs();
    const oracles = await loadAdmissionFeatureOracles();
    const report = scoreAdmissionFeatureAgreement({ inputs, oracles, predictions: exactPredictions(oracles) });

    expect(ADMISSION_FEATURE_AGREEMENT_POLICY.requiredAgreementPermille).toBe(1_000);
    expect(report.passed).toBe(true);
    expect(report.metrics.agreementPermille).toBe(1_000);
    expect(report.metrics.dimensionCount).toBe(36);
    expect(report.metrics.unavailableLabelCount).toBeGreaterThan(0);
    expect(report.metrics.unavailableAgreementCount).toBe(report.metrics.unavailableLabelCount);
    expect(report.metrics.availabilityMismatchCount).toBe(0);
    expect(report.metrics.valueMismatchCount).toBe(0);
    expect(report.splits.dev.agreementPermille).toBe(1_000);
    expect(report.splits.holdout.agreementPermille).toBe(1_000);
  });

  it('fails the gate for one valid one-permille disagreement', async () => {
    const inputs = await loadAdmissionFeatureInputs();
    const oracles = await loadAdmissionFeatureOracles();
    const predictions = exactPredictions(oracles);
    const first = predictions[0]!;
    const salience = first.features.dimensions.salience;
    if (salience.availability !== 'available' || salience.valuePermille >= 1_000) {
      throw new Error('fixture requires an incrementable salience label');
    }
    (first.features.dimensions as {
      salience: { availability: 'available'; valuePermille: number } | { availability: 'unavailable' };
    }).salience = {
      availability: 'available',
      valuePermille: salience.valuePermille + 1,
    };

    const report = scoreAdmissionFeatureAgreement({ inputs, oracles, predictions });
    expect(report.passed).toBe(false);
    expect(report.metrics.agreementCount).toBe(35);
    expect(report.metrics.agreementPermille).toBe(972);
    expect(report.metrics.valueMismatchCount).toBe(1);
    expect(report.failures).toContain('agreementPermille: expected at least 1000');
  });

  it('produces a fixed runtime-neutral artifact and SHA-256 identity', async () => {
    const inputs = await loadAdmissionFeatureInputs();
    const oracles = await loadAdmissionFeatureOracles();
    const report = scoreAdmissionFeatureAgreement({ inputs, oracles, predictions: exactPredictions(oracles) });
    const artifact = buildAdmissionFeatureEvaluationArtifact({ inputs, oracles, report });
    const canonical = canonicalAdmissionFeatureEvaluationArtifact(artifact);

    expect(canonical).toBe(canonicalAdmissionFeatureEvaluationArtifact(buildAdmissionFeatureEvaluationArtifact({ inputs, oracles, report })));
    expect(canonical).not.toMatch(/node|platform|arch|timestamp|secret|password|token|credential/i);
    expect(artifact.dataset.inputHash).toBe('sha256:41ef02bbe9df03e4f7b4f95b248265a71635aefa7cbe69c585a1eb8647936b24');
    expect(artifact.dataset.oracleHash).toBe('sha256:3a50b28cba28aa451967b3fbf3bcddfcc8c8f13f11c806cada1096d1f2807574');
    expect(admissionFeatureEvaluationArtifactIdentity(artifact)).toBe(
      'sha256:986e27b44324f1283058b38ea2f4916f366d2a28a9fd2db1389b53b0f3e49a55',
    );

    const forgedReport = structuredClone(report);
    expect(() => buildAdmissionFeatureEvaluationArtifact({ inputs, oracles, report: forgedReport }))
      .toThrow('unregistered_or_mismatched_evidence');
    expect(() => canonicalAdmissionFeatureEvaluationArtifact(structuredClone(artifact)))
      .toThrow('admission_feature_artifact:unregistered');
  });

  it('keeps scorer-only loaders out of the public barrel', async () => {
    const publicApi = await import('../index.js');
    expect('loadAdmissionFeatureOracles' in publicApi).toBe(false);
  });
});
