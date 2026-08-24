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
    expect(ADMISSION_FEATURE_DATASET_VERSION).toBe('2.0.0');
    expect(inputs).toHaveLength(13);
    expect(oracles).toHaveLength(13);
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
    expect(report.metrics.dimensionCount).toBe(78);
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
    expect(report.metrics.agreementCount).toBe(77);
    expect(report.metrics.agreementPermille).toBe(987);
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
    expect(artifact.dataset.inputHash).toBe('sha256:457d5483b8c22f62415f5952ffa743936f0b34348cf72bafe315dd8432448428');
    expect(artifact.dataset.oracleHash).toBe('sha256:840bc97373705daad00d0caa830335e07cfd54671437a7628a0f4e451c672441');
    expect(admissionFeatureEvaluationArtifactIdentity(artifact)).toBe(
      'sha256:68647278b4f91e2959f1e00054480ab17a5a8b82487cdc024b133fbb54692460',
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
