import { types as nodeUtilTypes } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  TrustedAdmissionPreprocessorV1,
  parseAdmissionSafeFactsV1,
  type AdmissionSafeFactsV1,
} from '../admission.js';
import {
  ADMISSION_FEATURE_CONTRACT_ID,
  ADMISSION_FEATURE_CONTRACT_VERSION,
  ADMISSION_FEATURE_EXTRACTOR_ID,
  ADMISSION_FEATURE_EXTRACTOR_VERSION,
  type AdmissionFeatureDimension,
  type AdmissionFeatureEnvelopeV1,
} from '../admission-features.js';
import {
  DEFAULT_TIER_ROUTING_CONFIG,
  TIER_ROUTING_CONTRACT_VERSION,
  TIER_ROUTING_POLICY_ID,
  TIER_ROUTING_POLICY_VERSION,
  TierRoutingContractError,
  canonicalTierRoutingConfigV1,
  parseTierRoutingConfigV1,
  resolveTierRoutingConfig,
  routeAdmissionTierV1,
  tierRoutingConfigIdentityV1,
  type TierRoutingConfigV1,
} from '../admission-routing.js';

function safeFacts(overrides: Partial<Record<string, unknown>> = {}): AdmissionSafeFactsV1 {
  return parseAdmissionSafeFactsV1({
    contractVersion: '1.0.0',
    captureState: 'accepted-nonduplicate',
    memoryClass: 'unclassified',
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

/**
 * Builds an envelope where listed dimensions are available at the given
 * permille and all others are unavailable. Every dimension gets a fresh
 * object: parseAdmissionFeatureEnvelopeV1 rejects shared references.
 */
function envelope(values: Partial<Record<AdmissionFeatureDimension, number>> = {}): AdmissionFeatureEnvelopeV1 {
  const dimension = (key: AdmissionFeatureDimension) => (
    values[key] === undefined
      ? { availability: 'unavailable' as const }
      : { availability: 'available' as const, valuePermille: values[key] }
  );
  return {
    contractId: ADMISSION_FEATURE_CONTRACT_ID,
    contractVersion: ADMISSION_FEATURE_CONTRACT_VERSION,
    extractor: {
      id: ADMISSION_FEATURE_EXTRACTOR_ID,
      version: ADMISSION_FEATURE_EXTRACTOR_VERSION,
    },
    dimensions: {
      salience: dimension('salience'),
      novelty: dimension('novelty'),
      durability: dimension('durability'),
      evidenceQuality: dimension('evidenceQuality'),
      scopeConfidence: dimension('scopeConfidence'),
      sensitivity: dimension('sensitivity'),
    },
  };
}

function config(overrides: Partial<TierRoutingConfigV1> = {}): TierRoutingConfigV1 {
  return { ...DEFAULT_TIER_ROUTING_CONFIG, ...overrides };
}

function route(
  facts: AdmissionSafeFactsV1,
  features: AdmissionFeatureEnvelopeV1 | null,
  cfg: TierRoutingConfigV1 = DEFAULT_TIER_ROUTING_CONFIG,
) {
  return routeAdmissionTierV1(facts, features, cfg);
}

function expectConfigError(input: unknown, code: string, field: string): void {
  try {
    parseTierRoutingConfigV1(input);
    throw new Error('expected contract rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(TierRoutingContractError);
    expect(error).toMatchObject({ code, field });
    expect(String(error)).not.toContain('777');
  }
}

describe('MEM-003 tier routing — five path suites', () => {
  it('routes low-salience low-durability accepted input to discard', () => {
    const result = route(safeFacts(), envelope({ salience: 50, durability: 120 }));
    expect(result.recommendedTier).toBe('discard');
    expect(result.reasonCode).toBe('feature-discard');
    expect(result.wouldChangeBaseline).toBe(true);
  });

  it('routes short-durability accepted input to working', () => {
    const result = route(safeFacts(), envelope({ salience: 800, durability: 250 }));
    expect(result.recommendedTier).toBe('working');
    expect(result.reasonCode).toBe('feature-working');
    expect(result.wouldChangeBaseline).toBe(true);
  });

  it('routes mid-band accepted input to episodic (baseline parity)', () => {
    const result = route(safeFacts(), envelope({ salience: 500, durability: 450, evidenceQuality: 450 }));
    expect(result.recommendedTier).toBe('episodic');
    expect(result.reasonCode).toBe('baseline-episodic-default');
    expect(result.wouldChangeBaseline).toBe(false);
  });

  it('routes durable well-evidenced accepted input to semantic-candidate', () => {
    const result = route(safeFacts(), envelope({ durability: 700, evidenceQuality: 700 }));
    expect(result.recommendedTier).toBe('semantic-candidate');
    expect(result.reasonCode).toBe('feature-candidate');
    expect(result.wouldChangeBaseline).toBe(true);
  });

  it('routes sensitivity-detected accepted input to protected', () => {
    const result = route(safeFacts({ sensitivity: 'detected' }), envelope({ salience: 50, durability: 120 }));
    expect(result.recommendedTier).toBe('protected');
    expect(result.reasonCode).toBe('sensitivity-protected');
    expect(result.wouldChangeBaseline).toBe(true);
  });

  it('routes high sensitivity feature to protected even without the sensitivity fact', () => {
    const result = route(safeFacts(), envelope({ sensitivity: 900, durability: 800, evidenceQuality: 1_000 }));
    expect(result.recommendedTier).toBe('protected');
    expect(result.reasonCode).toBe('sensitivity-protected');
  });

  it('carries the fixed policy identity on every recommendation', () => {
    const result = route(safeFacts(), null);
    expect(result.contractVersion).toBe(TIER_ROUTING_CONTRACT_VERSION);
    expect(result.policyId).toBe(TIER_ROUTING_POLICY_ID);
    expect(result.policyVersion).toBe(TIER_ROUTING_POLICY_VERSION);
  });

  it('routes secret-bearing content to protected end-to-end through the preprocessor', () => {
    const facts = new TrustedAdmissionPreprocessorV1().preprocess({
      captureState: 'accepted-nonduplicate',
      task: 'Record the deployment credential decision.',
      content: `Authorization: Bearer ${'x'.repeat(24)}`,
      redactionConfigured: true,
      hasSignals: false,
      hasEntities: false,
      hasModel: false,
    });
    expect(facts.sensitivity).toBe('detected');
    const result = route(facts, envelope({ salience: 25, durability: 150 }));
    expect(result.recommendedTier).toBe('protected');
    expect(result.reasonCode).toBe('sensitivity-protected');
    expect(result.wouldChangeBaseline).toBe(true);
  });
});

describe('MEM-003 tier routing — precedence', () => {
  it('protected outranks candidate-grade features', () => {
    const result = route(
      safeFacts({ sensitivity: 'detected', memoryClass: 'decision', outcome: 'approved' }),
      envelope({ durability: 800, evidenceQuality: 1_000 }),
    );
    expect(result.recommendedTier).toBe('protected');
    expect(result.reasonCode).toBe('sensitivity-protected');
  });

  it('approved decision outranks discard-grade features', () => {
    const result = route(
      safeFacts({ memoryClass: 'decision', outcome: 'approved' }),
      envelope({ salience: 0, durability: 0 }),
    );
    expect(result.recommendedTier).toBe('semantic-candidate');
    expect(result.reasonCode).toBe('approved-decision-candidate');
    expect(result.wouldChangeBaseline).toBe(true);
  });

  it('rejected capture outranks sensitivity (baseline never stored it)', () => {
    const result = route(
      safeFacts({ captureState: 'rejected', sensitivity: 'detected' }),
      envelope({ sensitivity: 900 }),
    );
    expect(result.recommendedTier).toBe('discard');
    expect(result.reasonCode).toBe('capture-rejected');
    expect(result.wouldChangeBaseline).toBe(false);
  });

  it('duplicate capture outranks an approved decision', () => {
    const result = route(
      safeFacts({ captureState: 'duplicate', memoryClass: 'decision', outcome: 'approved' }),
      envelope({ durability: 800, evidenceQuality: 1_000 }),
    );
    expect(result.recommendedTier).toBe('discard');
    expect(result.reasonCode).toBe('capture-duplicate');
    expect(result.wouldChangeBaseline).toBe(false);
  });

  it('non-approved decisions get no promotion shortcut', () => {
    const result = route(safeFacts({ memoryClass: 'decision', outcome: 'revised' }), null);
    expect(result.recommendedTier).toBe('episodic');
  });
});

describe('MEM-003 tier routing — boundary values (default config)', () => {
  it('protected threshold: 500 routes protected, 499 does not', () => {
    expect(route(safeFacts(), envelope({ sensitivity: 500 })).recommendedTier).toBe('protected');
    const below = route(safeFacts(), envelope({ sensitivity: 499 }));
    expect(below.recommendedTier).toBe('episodic');
    expect(below.reasonCode).toBe('baseline-episodic-default');
  });

  it('candidate thresholds: both at min promote, either at min-1 does not', () => {
    expect(route(safeFacts(), envelope({ durability: 600, evidenceQuality: 600 })).reasonCode)
      .toBe('feature-candidate');
    expect(route(safeFacts(), envelope({ durability: 599, evidenceQuality: 600 })).recommendedTier)
      .toBe('episodic');
    expect(route(safeFacts(), envelope({ durability: 600, evidenceQuality: 599 })).recommendedTier)
      .toBe('episodic');
  });

  it('discard thresholds: max discards, max+1 on either axis escapes discard', () => {
    expect(route(safeFacts(), envelope({ salience: 100, durability: 200 })).reasonCode)
      .toBe('feature-discard');
    expect(route(safeFacts(), envelope({ salience: 101, durability: 200 })).reasonCode)
      .toBe('feature-working');
    expect(route(safeFacts(), envelope({ salience: 100, durability: 201 })).reasonCode)
      .toBe('feature-working');
  });

  it('rule-6/7 containment: salience 100 + durability 200 discards, durability 250 works', () => {
    expect(route(safeFacts(), envelope({ salience: 100, durability: 200 })).recommendedTier)
      .toBe('discard');
    expect(route(safeFacts(), envelope({ salience: 100, durability: 250 })).recommendedTier)
      .toBe('working');
  });

  it('working threshold: 300 routes working, 301 falls to episodic', () => {
    expect(route(safeFacts(), envelope({ durability: 300 })).reasonCode).toBe('feature-working');
    const above = route(safeFacts(), envelope({ durability: 301 }));
    expect(above.recommendedTier).toBe('episodic');
    expect(above.reasonCode).toBe('baseline-episodic-default');
  });
});

describe('MEM-003 tier routing — degradation', () => {
  it('null envelope degrades deterministically to episodic', () => {
    const result = route(safeFacts(), null);
    expect(result.recommendedTier).toBe('episodic');
    expect(result.reasonCode).toBe('features-unavailable-default');
    expect(result.wouldChangeBaseline).toBe(false);
  });

  it('unavailable durability skips candidate, discard, and working rules', () => {
    const result = route(safeFacts(), envelope({ salience: 0, evidenceQuality: 1_000 }));
    expect(result.recommendedTier).toBe('episodic');
    expect(result.reasonCode).toBe('baseline-episodic-default');
  });

  it('unavailable evidenceQuality skips only the candidate rule', () => {
    const result = route(safeFacts(), envelope({ durability: 800 }));
    expect(result.recommendedTier).toBe('episodic');
    expect(result.reasonCode).toBe('baseline-episodic-default');
  });

  it('unavailable salience skips only the discard rule', () => {
    const result = route(safeFacts(), envelope({ durability: 150 }));
    expect(result.reasonCode).toBe('feature-working');
  });

  it('unavailable sensitivity leaves protection to the sensitivity fact alone', () => {
    expect(route(safeFacts(), envelope({ durability: 700, evidenceQuality: 700 })).recommendedTier)
      .toBe('semantic-candidate');
    expect(route(safeFacts({ sensitivity: 'detected' }), envelope()).recommendedTier)
      .toBe('protected');
  });
});

describe('MEM-003 tier routing — config contract hostility', () => {
  it('rejects non-objects and prototype-poisoned objects', () => {
    expectConfigError(null, 'not_object', 'tierRoutingConfig');
    expectConfigError([], 'not_object', 'tierRoutingConfig');
    expectConfigError(777, 'not_object', 'tierRoutingConfig');
    expectConfigError(
      Object.assign(Object.create({ evil: 777 }), config()),
      'invalid_type',
      'tierRoutingConfig',
    );
    expectConfigError(
      JSON.parse(`{"__proto__":{},${JSON.stringify(config()).slice(1)}`),
      'unknown_key',
      'tierRoutingConfig',
    );
  });

  it('rejects proxies without firing their traps on field reads', () => {
    const proxy = new Proxy(config(), {
      get() { throw new Error('secret proxy trap'); },
    });
    expect(nodeUtilTypes.isProxy(proxy)).toBe(true);
    expectConfigError(proxy, 'invalid_type', 'tierRoutingConfig');
  });

  it('rejects unknown and missing keys by closed field path', () => {
    expectConfigError({ ...config(), extra: 777 }, 'unknown_key', 'tierRoutingConfig');
    const { workingDurabilityMaxPermille: _omitted, ...partial } = config();
    expectConfigError(partial, 'missing_key', 'tierRoutingConfig.workingDurabilityMaxPermille');
  });

  it('rejects non-integer, -0, NaN, and out-of-range permille values', () => {
    expectConfigError(config({ discardSalienceMaxPermille: 77.7 }), 'noncanonical', 'tierRoutingConfig.discardSalienceMaxPermille');
    expectConfigError(config({ discardSalienceMaxPermille: -0 }), 'noncanonical', 'tierRoutingConfig.discardSalienceMaxPermille');
    expectConfigError(config({ discardSalienceMaxPermille: Number.NaN }), 'invalid_number', 'tierRoutingConfig.discardSalienceMaxPermille');
    expectConfigError(config({ discardSalienceMaxPermille: Number.POSITIVE_INFINITY }), 'invalid_number', 'tierRoutingConfig.discardSalienceMaxPermille');
    expectConfigError(config({ candidateDurabilityMinPermille: 1_001 }), 'out_of_bounds', 'tierRoutingConfig.candidateDurabilityMinPermille');
    expectConfigError(config({ discardDurabilityMaxPermille: -1 }), 'out_of_bounds', 'tierRoutingConfig.discardDurabilityMaxPermille');
  });

  it('rejects degenerate no-op thresholds', () => {
    expectConfigError(config({ protectedSensitivityMinPermille: 0 }), 'out_of_bounds', 'tierRoutingConfig.protectedSensitivityMinPermille');
    expectConfigError(config({ candidateEvidenceQualityMinPermille: 0 }), 'out_of_bounds', 'tierRoutingConfig.candidateEvidenceQualityMinPermille');
    expectConfigError(config({ discardSalienceMaxPermille: 1_000 }), 'out_of_bounds', 'tierRoutingConfig.discardSalienceMaxPermille');
  });

  it('rejects band inversion and overlap as invalid_state', () => {
    expectConfigError(
      config({ workingDurabilityMaxPermille: 600 }),
      'invalid_state',
      'tierRoutingConfig',
    );
    expectConfigError(
      config({ workingDurabilityMaxPermille: 700 }),
      'invalid_state',
      'tierRoutingConfig',
    );
    expectConfigError(
      config({ discardDurabilityMaxPermille: 400, workingDurabilityMaxPermille: 300 }),
      'invalid_state',
      'tierRoutingConfig',
    );
  });

  it('accepts the defaults and returns a frozen config', () => {
    const parsed = parseTierRoutingConfigV1(config());
    expect(parsed).toEqual(DEFAULT_TIER_ROUTING_CONFIG);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(DEFAULT_TIER_ROUTING_CONFIG)).toBe(true);
  });
});

describe('MEM-003 tier routing — env resolution', () => {
  it('returns frozen defaults when every variable is unset', () => {
    const resolved = resolveTierRoutingConfig({});
    expect(resolved).toEqual(DEFAULT_TIER_ROUTING_CONFIG);
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it('applies digits-only overrides', () => {
    const resolved = resolveTierRoutingConfig({
      MEMBERRY_ADMISSION_ROUTING_PROTECTED_SENSITIVITY_MIN_PERMILLE: '400',
      MEMBERRY_ADMISSION_ROUTING_WORKING_DURABILITY_MAX_PERMILLE: ' 350 ',
    });
    expect(resolved.protectedSensitivityMinPermille).toBe(400);
    expect(resolved.workingDurabilityMaxPermille).toBe(350);
    expect(resolved.candidateDurabilityMinPermille).toBe(600);
  });

  it('rejects non-digit values by closed field path', () => {
    for (const raw of ['abc', '5.5', '-1', '1e3', '0x10']) {
      try {
        resolveTierRoutingConfig({ MEMBERRY_ADMISSION_ROUTING_DISCARD_SALIENCE_MAX_PERMILLE: raw });
        throw new Error('expected contract rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(TierRoutingContractError);
        expect(error).toMatchObject({ code: 'invalid_number', field: 'tierRoutingConfig.discardSalienceMaxPermille' });
        expect(String(error)).not.toContain(raw);
      }
    }
  });

  it('rejects out-of-range and band-violating combinations', () => {
    expect(() => resolveTierRoutingConfig({ MEMBERRY_ADMISSION_ROUTING_CANDIDATE_DURABILITY_MIN_PERMILLE: '1001' }))
      .toThrowError(new TierRoutingContractError('out_of_bounds', 'tierRoutingConfig.candidateDurabilityMinPermille'));
    expect(() => resolveTierRoutingConfig({ MEMBERRY_ADMISSION_ROUTING_WORKING_DURABILITY_MAX_PERMILLE: '600' }))
      .toThrowError(new TierRoutingContractError('invalid_state', 'tierRoutingConfig'));
  });
});

describe('MEM-003 tier routing — reachability from real extractor values', () => {
  // Only values the MEM-002 extractor can emit: salience 25/100/850,
  // durability 150/700/800, evidenceQuality 0/450/1000, sensitivity 0/50/900.
  it('reaches all five tiers under default config', () => {
    const protectedCase = route(safeFacts(), envelope({ salience: 850, durability: 800, evidenceQuality: 1_000, sensitivity: 900 }));
    expect(protectedCase.recommendedTier).toBe('protected');

    const candidate = route(safeFacts(), envelope({ salience: 850, durability: 800, evidenceQuality: 1_000, sensitivity: 0 }));
    expect(candidate.recommendedTier).toBe('semantic-candidate');
    expect(candidate.reasonCode).toBe('feature-candidate');

    const discard = route(safeFacts(), envelope({ salience: 25, durability: 150, evidenceQuality: 0, sensitivity: 0 }));
    expect(discard.recommendedTier).toBe('discard');
    expect(discard.reasonCode).toBe('feature-discard');

    const working = route(safeFacts(), envelope({ salience: 850, durability: 150, evidenceQuality: 0, sensitivity: 50 }));
    expect(working.recommendedTier).toBe('working');
    expect(working.reasonCode).toBe('feature-working');

    const episodic = route(safeFacts(), envelope({ salience: 100, durability: 700, evidenceQuality: 450, sensitivity: 50 }));
    expect(episodic.recommendedTier).toBe('episodic');
    expect(episodic.reasonCode).toBe('baseline-episodic-default');
  });

  it('extractor "possible" sensitivity (50) stays below the protected band by design', () => {
    expect(route(safeFacts(), envelope({ sensitivity: 50, durability: 700, evidenceQuality: 450 })).recommendedTier)
      .toBe('episodic');
  });
});

describe('MEM-003 tier routing — config identity', () => {
  it('is stable for identical configs and distinct across thresholds', () => {
    const base = tierRoutingConfigIdentityV1(config());
    expect(base).toBe(tierRoutingConfigIdentityV1({ ...DEFAULT_TIER_ROUTING_CONFIG }));
    expect(base).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(tierRoutingConfigIdentityV1(config({ workingDurabilityMaxPermille: 400 }))).not.toBe(base);
    expect(canonicalTierRoutingConfigV1(config())).toBe(JSON.stringify(DEFAULT_TIER_ROUTING_CONFIG));
  });

  it('recommendations carry the identity of the exact config used', () => {
    const custom = config({ workingDurabilityMaxPermille: 400 });
    expect(route(safeFacts(), null).configIdentity).toBe(tierRoutingConfigIdentityV1(DEFAULT_TIER_ROUTING_CONFIG));
    expect(route(safeFacts(), null, custom).configIdentity).toBe(tierRoutingConfigIdentityV1(custom));
  });
});

describe('MEM-003 tier routing — determinism and purity', () => {
  it('gives deeply-equal frozen outputs for identical inputs and never mutates inputs', () => {
    const facts = safeFacts({ memoryClass: 'decision', outcome: 'approved' });
    const features = envelope({ salience: 100, durability: 200 });
    const cfg = config();
    const factsSnapshot = structuredClone({ ...facts });
    const featuresSnapshot = structuredClone(features);
    const cfgSnapshot = structuredClone(cfg);

    const first = route(facts, features, cfg);
    const second = route(facts, features, cfg);
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => {
      'use strict';
      (first as { recommendedTier: string }).recommendedTier = 'discard';
    }).toThrow(TypeError);

    expect({ ...facts }).toEqual(factsSnapshot);
    expect(features).toEqual(featuresSnapshot);
    expect(cfg).toEqual(cfgSnapshot);
  });
});
