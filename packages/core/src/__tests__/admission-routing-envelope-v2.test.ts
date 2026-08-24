import { describe, expect, it } from 'vitest';

import { parseAdmissionSafeFactsV1, type AdmissionSafeFactsV1 } from '../admission.js';
import { DEFAULT_TIER_ROUTING_CONFIG, routeAdmissionTierV1 } from '../admission-routing.js';
import { produceAdmissionFeatureEnvelopeV2 } from '../admission-feature-producer.js';
import type { AdmissionFeatureEnvelopeV2 } from '../admission-features-v2.js';

type FactsOverrides = {
  memoryClass?: string;
  outcome?: string;
  sensitivity?: string;
  hasSignals?: boolean;
  hasEntities?: boolean;
};

function facts(overrides: FactsOverrides = {}): AdmissionSafeFactsV1 {
  return parseAdmissionSafeFactsV1({
    contractVersion: '1.0.0',
    captureState: 'accepted-nonduplicate',
    memoryClass: 'general',
    outcome: 'unspecified',
    tenantScope: 'resolved',
    projectScope: 'resolved',
    sensitivity: 'not-detected',
    redactionConfigured: true,
    hasSignals: false,
    hasEntities: false,
    hasModel: false,
    ...overrides,
  });
}

function v2Envelope(dimensions: Record<string, unknown>): AdmissionFeatureEnvelopeV2 {
  return {
    contractId: 'memberry.admission-feature-envelope',
    contractVersion: '2.0.0',
    extractor: { id: 'memberry.safe-facts-feature-producer', version: '1.0.0' },
    dimensions,
  } as AdmissionFeatureEnvelopeV2;
}

function v1Envelope(): unknown {
  return {
    contractId: 'memberry.admission-feature-envelope',
    contractVersion: '1.0.0',
    extractor: { id: 'memberry.precomputed-feature-signals', version: '1.0.0' },
    dimensions: {
      salience: { availability: 'available', valuePermille: 50 },
      novelty: { availability: 'unavailable' },
      durability: { availability: 'available', valuePermille: 100 },
      evidenceQuality: { availability: 'unavailable' },
      scopeConfidence: { availability: 'unavailable' },
      sensitivity: { availability: 'unavailable' },
    },
  };
}

// The full §5.2 dev-table inputs: every producer table row and edge.
const DEV_TABLE: readonly FactsOverrides[] = [
  { memoryClass: 'decision', outcome: 'approved', hasSignals: true, hasEntities: true },
  { memoryClass: 'decision', outcome: 'rejected', hasSignals: true },
  { memoryClass: 'architecture' },
  { memoryClass: 'convention', outcome: 'approved', hasSignals: true, hasEntities: true },
  { memoryClass: 'pattern', outcome: 'revised', hasEntities: true },
  { memoryClass: 'preference' },
  { memoryClass: 'fact', outcome: 'approved', hasSignals: true, hasEntities: true },
  { memoryClass: 'fact', outcome: 'abandoned', hasSignals: true, hasEntities: true },
  { memoryClass: 'general' },
  { memoryClass: 'general', outcome: 'rejected', hasSignals: true },
  { memoryClass: 'unclassified', hasEntities: true },
  { memoryClass: 'decision', outcome: 'approved', hasSignals: true, hasEntities: true, sensitivity: 'detected' },
  { memoryClass: 'general', sensitivity: 'detected' },
  { memoryClass: 'unclassified', outcome: 'abandoned' },
];

describe('MEM-002 routeAdmissionTierV1 over produced v2 envelopes', () => {
  it('rule 5: convention + corroborated envelope routes feature-candidate', () => {
    const input = facts({ memoryClass: 'convention', outcome: 'approved', hasSignals: true, hasEntities: true });
    const recommendation = routeAdmissionTierV1(input, produceAdmissionFeatureEnvelopeV2(input), DEFAULT_TIER_ROUTING_CONFIG);
    expect(recommendation).toMatchObject({
      recommendedTier: 'semantic-candidate',
      reasonCode: 'feature-candidate',
      wouldChangeBaseline: true,
    });
  });

  it('rule 7: general envelope routes feature-working', () => {
    const input = facts({ memoryClass: 'general' });
    const recommendation = routeAdmissionTierV1(input, produceAdmissionFeatureEnvelopeV2(input), DEFAULT_TIER_ROUTING_CONFIG);
    expect(recommendation).toMatchObject({ recommendedTier: 'working', reasonCode: 'feature-working' });
  });

  it('rule 3 envelope arm: sensitivity 1000 protects even when the facts arm is silent', () => {
    const envelope = v2Envelope({
      durability: { availability: 'available', valuePermille: 900 },
      evidenceQuality: { availability: 'available', valuePermille: 1_000 },
      sensitivity: { availability: 'available', valuePermille: 1_000 },
    });
    const recommendation = routeAdmissionTierV1(facts(), envelope, DEFAULT_TIER_ROUTING_CONFIG);
    expect(recommendation).toMatchObject({ recommendedTier: 'protected', reasonCode: 'sensitivity-protected' });
  });

  it('a produced envelope that fires no rule yields baseline-episodic-default, not features-unavailable-default', () => {
    const input = facts({ memoryClass: 'fact', hasSignals: true });
    const recommendation = routeAdmissionTierV1(input, produceAdmissionFeatureEnvelopeV2(input), DEFAULT_TIER_ROUTING_CONFIG);
    expect(recommendation).toMatchObject({ recommendedTier: 'episodic', reasonCode: 'baseline-episodic-default' });
  });

  it('rule 6 is dormant-by-absence: no dev-table envelope can reach feature-discard', () => {
    for (const overrides of DEV_TABLE) {
      const input = facts(overrides);
      const recommendation = routeAdmissionTierV1(input, produceAdmissionFeatureEnvelopeV2(input), DEFAULT_TIER_ROUTING_CONFIG);
      expect(recommendation.reasonCode).not.toBe('feature-discard');
    }
  });

  it('regression: null and v1 envelopes still route exactly as before', () => {
    expect(routeAdmissionTierV1(facts(), null, DEFAULT_TIER_ROUTING_CONFIG)).toMatchObject({
      recommendedTier: 'episodic',
      reasonCode: 'features-unavailable-default',
    });
    // v1 low salience + low durability still reaches rule 6.
    expect(routeAdmissionTierV1(facts(), v1Envelope() as never, DEFAULT_TIER_ROUTING_CONFIG)).toMatchObject({
      recommendedTier: 'discard',
      reasonCode: 'feature-discard',
    });
  });

  it('rejects an envelope whose contractVersion is an accessor without executing it', () => {
    const hostile = v2Envelope({
      durability: { availability: 'unavailable' },
      evidenceQuality: { availability: 'unavailable' },
      sensitivity: { availability: 'unavailable' },
    }) as { contractVersion: unknown };
    let executed = false;
    Object.defineProperty(hostile, 'contractVersion', {
      get: () => { executed = true; return '2.0.0'; },
      enumerable: true,
      configurable: true,
    });
    expect(() => routeAdmissionTierV1(facts(), hostile as never, DEFAULT_TIER_ROUTING_CONFIG)).toThrow();
    expect(executed).toBe(false);
  });
});
