import { describe, expect, it } from 'vitest';

import {
  ADMISSION_FEATURE_CONTRACT_VERSION_V2,
  ADMISSION_FEATURE_DIMENSIONS_V2,
  ADMISSION_FEATURE_EXTRACTOR_ID_V2,
  ADMISSION_FEATURE_EXTRACTOR_VERSION_V2,
  ADMISSION_FEATURE_PRODUCER_MODE_ENV,
  AdmissionFeatureContractError,
  AdmissionFeatureProducerModeError,
  admissionFeatureEnvelopeIdentityV2,
  canonicalAdmissionFeatureEnvelopeV2,
  parseAdmissionFeatureEnvelopeV2,
  resolveAdmissionFeatureProducerModeV1,
} from '../admission-features-v2.js';

type MutableEnvelope = {
  contractId: string;
  contractVersion: string;
  extractor: { id: string; version: string };
  dimensions: Record<string, unknown>;
};

function envelope(overrides: Partial<MutableEnvelope> = {}): MutableEnvelope {
  return {
    contractId: 'memberry.admission-feature-envelope',
    contractVersion: '2.0.0',
    extractor: { id: 'memberry.safe-facts-feature-producer', version: '1.0.0' },
    dimensions: {
      durability: { availability: 'available', valuePermille: 900 },
      evidenceQuality: { availability: 'available', valuePermille: 450 },
      sensitivity: { availability: 'available', valuePermille: 0 },
    },
    ...overrides,
  };
}

function failure(input: unknown): AdmissionFeatureContractError {
  try {
    parseAdmissionFeatureEnvelopeV2(input);
  } catch (error) {
    if (error instanceof AdmissionFeatureContractError) return error;
    throw error;
  }
  throw new Error('expected parse to fail');
}

describe('MEM-002 admission feature envelope v2 contract', () => {
  it('pins the closed three-dimension set and the new extractor identity', () => {
    expect(ADMISSION_FEATURE_DIMENSIONS_V2).toEqual(['durability', 'evidenceQuality', 'sensitivity']);
    expect(ADMISSION_FEATURE_CONTRACT_VERSION_V2).toBe('2.0.0');
    expect(ADMISSION_FEATURE_EXTRACTOR_ID_V2).toBe('memberry.safe-facts-feature-producer');
    expect(ADMISSION_FEATURE_EXTRACTOR_VERSION_V2).toBe('1.0.0');

    const parsed = parseAdmissionFeatureEnvelopeV2(envelope());
    expect(Object.keys(parsed.dimensions).sort()).toEqual(['durability', 'evidenceQuality', 'sensitivity']);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.dimensions)).toBe(true);
  });

  it.each(['salience', 'novelty', 'scopeConfidence'])('rejects a removed %s dimension as unknown_key', (dimension) => {
    const input = envelope();
    input.dimensions[dimension] = { availability: 'unavailable' };
    expect(failure(input).code).toBe('unknown_key');
  });

  it('rejects a missing dimension as missing_key', () => {
    const input = envelope();
    delete input.dimensions['sensitivity'];
    expect(failure(input).code).toBe('missing_key');
  });

  it.each([
    ['contractId', envelope({ contractId: 'memberry.other-envelope' })],
    ['contractVersion', envelope({ contractVersion: '1.0.0' })],
    ['extractor id', envelope({ extractor: { id: 'memberry.precomputed-feature-signals', version: '1.0.0' } })],
    ['extractor version', envelope({ extractor: { id: 'memberry.safe-facts-feature-producer', version: '1.0.1' } })],
  ])('rejects a wrong %s as invalid_identity', (_label, input) => {
    expect(failure(input).code).toBe('invalid_identity');
  });

  it.each([
    ['float', 450.5, 'noncanonical'],
    ['negative zero', -0, 'noncanonical'],
    ['below grid', -1, 'out_of_bounds'],
    ['above grid', 1_001, 'out_of_bounds'],
    ['NaN', Number.NaN, 'invalid_number'],
    ['string', '450', 'invalid_number'],
  ])('rejects an off-grid permille (%s) with %s', (_label, valuePermille, code) => {
    const input = envelope();
    input.dimensions['durability'] = { availability: 'available', valuePermille };
    expect(failure(input).code).toBe(code);
  });

  it('rejects tagged-union mixing: unavailable with a valuePermille is unknown_key', () => {
    const input = envelope();
    input.dimensions['durability'] = { availability: 'unavailable', valuePermille: 100 };
    expect(failure(input).code).toBe('unknown_key');
  });

  it('accepts a genuinely unavailable dimension', () => {
    const input = envelope();
    input.dimensions['durability'] = { availability: 'unavailable' };
    expect(parseAdmissionFeatureEnvelopeV2(input).dimensions.durability).toEqual({ availability: 'unavailable' });
  });

  it('produces a deterministic canonical form and sha256 identity', () => {
    const first = admissionFeatureEnvelopeIdentityV2(envelope());
    const second = admissionFeatureEnvelopeIdentityV2(envelope());
    expect(first).toBe(second);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(canonicalAdmissionFeatureEnvelopeV2(envelope())).toBe(canonicalAdmissionFeatureEnvelopeV2(envelope()));

    const changed = envelope();
    changed.dimensions['sensitivity'] = { availability: 'available', valuePermille: 1_000 };
    expect(admissionFeatureEnvelopeIdentityV2(changed)).not.toBe(first);
  });

  it('rejects proxies, custom prototypes, shared references, and cycles', () => {
    expect(failure(new Proxy(envelope(), {})).code).toBe('invalid_type');

    class Hostile {}
    const withPrototype = Object.assign(new Hostile(), envelope());
    expect(failure(withPrototype).code).toBe('invalid_type');

    const shared = { availability: 'unavailable' };
    const sharedInput = envelope();
    sharedInput.dimensions['durability'] = shared;
    sharedInput.dimensions['evidenceQuality'] = shared;
    expect(failure(sharedInput).code).toBe('shared_reference');

    const cyclic = envelope();
    (cyclic.dimensions as Record<string, unknown>)['durability'] = cyclic;
    expect(['cyclic_reference', 'unknown_key']).toContain(failure(cyclic).code);
  });

  it('rejects accessor properties without executing them', () => {
    const input = envelope();
    let executed = false;
    Object.defineProperty(input, 'contractVersion', {
      get: () => { executed = true; return '2.0.0'; },
      enumerable: true,
      configurable: true,
    });
    expect(failure(input).code).toBe('invalid_type');
    expect(executed).toBe(false);
  });
});

describe('MEM-002 producer staging flag', () => {
  it('pins the env var name and resolves unset/empty/disabled to disabled', () => {
    expect(ADMISSION_FEATURE_PRODUCER_MODE_ENV).toBe('MEMBERRY_ADMISSION_FEATURE_PRODUCER_V1');
    expect(resolveAdmissionFeatureProducerModeV1({})).toBe('disabled');
    expect(resolveAdmissionFeatureProducerModeV1({ MEMBERRY_ADMISSION_FEATURE_PRODUCER_V1: '' })).toBe('disabled');
    expect(resolveAdmissionFeatureProducerModeV1({ MEMBERRY_ADMISSION_FEATURE_PRODUCER_V1: 'disabled' })).toBe('disabled');
  });

  it('resolves the exact live token', () => {
    expect(resolveAdmissionFeatureProducerModeV1({ MEMBERRY_ADMISSION_FEATURE_PRODUCER_V1: 'live' })).toBe('live');
  });

  it.each(['LIVE', ' live', 'live ', 'true', '1', 'shadow'])('rejects a non-exact token (%j) with a typed error', (raw) => {
    expect(() => resolveAdmissionFeatureProducerModeV1({ MEMBERRY_ADMISSION_FEATURE_PRODUCER_V1: raw }))
      .toThrow(AdmissionFeatureProducerModeError);
    try {
      resolveAdmissionFeatureProducerModeV1({ MEMBERRY_ADMISSION_FEATURE_PRODUCER_V1: raw });
    } catch (error) {
      expect((error as AdmissionFeatureProducerModeError).code).toBe('invalid_mode');
      expect((error as Error).message).not.toContain(raw.trim());
    }
  });
});
