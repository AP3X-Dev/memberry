import { describe, expect, it } from 'vitest';

import { produceAdmissionFeatureEnvelopeV2 } from '../../../../packages/core/src/admission-feature-producer.js';
import {
  ADMISSION_FEATURE_DATASET_ID_V3,
  ADMISSION_FEATURE_DATASET_VERSION_V3,
  completeAdmissionFeatureFactsV3,
  type AdmissionFeatureScenarioInputV3,
} from '../contract-v3.js';
import { loadAdmissionFeatureInputsV3 } from '../inputs-v3.js';
import { ADMISSION_FEATURE_AGREEMENT_POLICY_V3, scoreAdmissionFeatureAgreementV3 } from '../scorer-v3.js';
import { loadAdmissionFeatureOraclesV3 } from '../scorer-only/load-v3.js';

function predictions(inputs: readonly AdmissionFeatureScenarioInputV3[]) {
  return inputs.map((input) => ({
    scenarioId: input.scenarioId,
    split: input.split,
    features: produceAdmissionFeatureEnvelopeV2(completeAdmissionFeatureFactsV3(input.facts)),
  }));
}

describe('MEM-002 productionization v3 dev gate', () => {
  it('loads the 14-scenario label-free dev split', async () => {
    const inputs = await loadAdmissionFeatureInputsV3(['dev']);

    expect(ADMISSION_FEATURE_DATASET_ID_V3).toBe('memberry.synthetic-admission-feature-labels');
    expect(ADMISSION_FEATURE_DATASET_VERSION_V3).toBe('3.0.0');
    expect(inputs).toHaveLength(14);
    expect(new Set(inputs.map(({ split }) => split))).toEqual(new Set(['dev']));
    expect(JSON.stringify(inputs)).not.toMatch(/dimensions|valuePermille|oracle|expected/i);
  });

  it('the LIVE producer agrees with the dev oracle at the frozen 1000-permille gate (42/42 cells)', async () => {
    const inputs = await loadAdmissionFeatureInputsV3(['dev']);
    const oracles = await loadAdmissionFeatureOraclesV3(['dev']);
    const report = scoreAdmissionFeatureAgreementV3({
      inputs,
      oracles,
      predictions: predictions(inputs),
      requiredSplits: ['dev'],
    });

    expect(ADMISSION_FEATURE_AGREEMENT_POLICY_V3.requiredAgreementPermille).toBe(1_000);
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.metrics.agreementPermille).toBe(1_000);
    expect(report.metrics.dimensionCount).toBe(42);
    expect(report.metrics.agreementCount).toBe(42);
    expect(report.metrics.unavailableLabelCount).toBe(2);
    expect(report.metrics.unavailableAgreementCount).toBe(2);
    expect(report.metrics.availabilityMismatchCount).toBe(0);
    expect(report.metrics.valueMismatchCount).toBe(0);
    expect(report.splits.dev.agreementPermille).toBe(1_000);
  });

  it('fails the gate for one valid one-permille disagreement', async () => {
    const inputs = await loadAdmissionFeatureInputsV3(['dev']);
    const oracles = await loadAdmissionFeatureOraclesV3(['dev']);
    const predicted = predictions(inputs);
    const first = predicted[0]!;
    const durability = first.features.dimensions.durability;
    if (durability.availability !== 'available' || durability.valuePermille >= 1_000) {
      throw new Error('fixture requires an incrementable durability prediction');
    }
    predicted[0] = {
      ...first,
      features: {
        ...first.features,
        dimensions: {
          ...first.features.dimensions,
          durability: { availability: 'available', valuePermille: durability.valuePermille + 1 },
        },
      },
    };

    const report = scoreAdmissionFeatureAgreementV3({
      inputs,
      oracles,
      predictions: predicted,
      requiredSplits: ['dev'],
    });
    expect(report.passed).toBe(false);
    expect(report.metrics.agreementCount).toBe(41);
    expect(report.metrics.valueMismatchCount).toBe(1);
    expect(report.failures).toContain('agreementPermille: expected at least 1000');
  });

  it('requires both splits by default (the one-shot holdout discipline)', async () => {
    const inputs = await loadAdmissionFeatureInputsV3(['dev']);
    const oracles = await loadAdmissionFeatureOraclesV3(['dev']);
    const report = scoreAdmissionFeatureAgreementV3({ inputs, oracles, predictions: predictions(inputs) });
    expect(report.passed).toBe(false);
    expect(report.failures).toContain('holdout: no scenarios');
  });
});
