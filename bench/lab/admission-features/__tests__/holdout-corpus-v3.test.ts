// MEM-002 seal-time packet: v3 holdout corpus INPUT constraints (labels are
// custodian-sealed material and are never asserted, loaded, or derived here).

import { describe, expect, it } from 'vitest';

import { loadAdmissionFeatureInputsV3 } from '../inputs-v3.js';
import type { AdmissionFeatureScenarioFactsV3 } from '../contract-v3.js';

const HOLDOUT_SCENARIO_COUNT = 6;
const DEV_SCENARIO_COUNT = 14;

function combination(facts: AdmissionFeatureScenarioFactsV3): string {
  return [
    facts.memoryClass, facts.outcome, facts.sensitivity,
    String(facts.hasSignals), String(facts.hasEntities),
  ].join('|');
}

describe('MEM-002 v3 holdout corpus inputs', () => {
  it('carries six holdout scenarios with sequential ids alongside the frozen dev split', async () => {
    const inputs = await loadAdmissionFeatureInputsV3(['dev', 'holdout']);
    const holdout = inputs.filter(({ split }) => split === 'holdout');
    expect(inputs).toHaveLength(DEV_SCENARIO_COUNT + HOLDOUT_SCENARIO_COUNT);
    expect(holdout.map(({ scenarioId }) => scenarioId)).toEqual(
      Array.from({ length: HOLDOUT_SCENARIO_COUNT }, (_, index) => `af3-holdout-${String(index + 1).padStart(3, '0')}`),
    );
    expect(new Set(holdout.map(({ fixtureCode }) => fixtureCode)).size).toBe(HOLDOUT_SCENARIO_COUNT);
  });

  it('uses only dev-seen category values in combinations that never co-occur in dev', async () => {
    const inputs = await loadAdmissionFeatureInputsV3(['dev', 'holdout']);
    const dev = inputs.filter(({ split }) => split === 'dev');
    const holdout = inputs.filter(({ split }) => split === 'holdout');
    const devCombinations = new Set(dev.map(({ facts }) => combination(facts)));
    const devSeen = {
      memoryClass: new Set(dev.map(({ facts }) => facts.memoryClass)),
      outcome: new Set(dev.map(({ facts }) => facts.outcome)),
      sensitivity: new Set(dev.map(({ facts }) => facts.sensitivity)),
    };
    const holdoutCombinations = holdout.map(({ facts }) => combination(facts));
    expect(new Set(holdoutCombinations).size).toBe(HOLDOUT_SCENARIO_COUNT);
    for (const input of holdout) {
      expect(devSeen.memoryClass.has(input.facts.memoryClass)).toBe(true);
      expect(devSeen.outcome.has(input.facts.outcome)).toBe(true);
      expect(devSeen.sensitivity.has(input.facts.sensitivity)).toBe(true);
      expect(devCombinations.has(combination(input.facts))).toBe(false);
    }
  });
});
