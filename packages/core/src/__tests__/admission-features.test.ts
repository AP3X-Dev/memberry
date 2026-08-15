import { types as nodeUtilTypes } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  ADMISSION_FEATURE_CONTRACT_ID,
  ADMISSION_FEATURE_CONTRACT_VERSION,
  ADMISSION_FEATURE_EXTRACTOR_ID,
  ADMISSION_FEATURE_EXTRACTOR_VERSION,
  AdmissionFeatureContractError,
  admissionFeatureEnvelopeIdentityV1,
  canonicalAdmissionFeatureEnvelopeV1,
  parseAdmissionFeatureEnvelopeV1,
} from '../admission-features.js';

const unavailable = () => ({ availability: 'unavailable' as const });
const available = (valuePermille: number) => ({ availability: 'available' as const, valuePermille });

function handFixture() {
  return {
    contractId: ADMISSION_FEATURE_CONTRACT_ID,
    contractVersion: ADMISSION_FEATURE_CONTRACT_VERSION,
    extractor: {
      id: ADMISSION_FEATURE_EXTRACTOR_ID,
      version: ADMISSION_FEATURE_EXTRACTOR_VERSION,
    },
    dimensions: {
      salience: available(0),
      novelty: available(250),
      durability: available(500),
      evidenceQuality: available(750),
      scopeConfidence: available(1_000),
      sensitivity: unavailable(),
    },
  };
}

function expectContractError(input: unknown, code: string, field: string): void {
  try {
    parseAdmissionFeatureEnvelopeV1(input);
    throw new Error('expected contract rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(AdmissionFeatureContractError);
    expect(error).toMatchObject({ code, field });
    expect(String(error)).not.toContain('secret');
  }
}

describe('MEM-002A admission feature envelope contract', () => {
  it('accepts hand-authored boundary fixtures and returns a deeply frozen copy', () => {
    const input = handFixture();
    const parsed = parseAdmissionFeatureEnvelopeV1(input);

    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parsed.extractor).not.toBe(input.extractor);
    expect(parsed.dimensions).not.toBe(input.dimensions);
    expect(parsed.dimensions.salience).not.toBe(input.dimensions.salience);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.extractor)).toBe(true);
    expect(Object.isFrozen(parsed.dimensions)).toBe(true);
    for (const value of Object.values(parsed.dimensions)) expect(Object.isFrozen(value)).toBe(true);
  });

  it('supports explicit unavailable for every fixed dimension', () => {
    const input = handFixture();
    for (const key of Object.keys(input.dimensions) as Array<keyof typeof input.dimensions>) {
      input.dimensions[key] = unavailable() as never;
    }
    expect(parseAdmissionFeatureEnvelopeV1(input).dimensions).toEqual({
      salience: unavailable(),
      novelty: unavailable(),
      durability: unavailable(),
      evidenceQuality: unavailable(),
      scopeConfidence: unavailable(),
      sensitivity: unavailable(),
    });
  });

  it('has a fixed canonical serialization and SHA-256 identity across Node versions', () => {
    const canonical = canonicalAdmissionFeatureEnvelopeV1(handFixture());
    const expected = '{"contractId":"memberry.admission-feature-envelope","contractVersion":"1.0.0","extractor":{"id":"memberry.precomputed-feature-signals","version":"1.0.0"},"dimensions":{"salience":{"availability":"available","valuePermille":0},"novelty":{"availability":"available","valuePermille":250},"durability":{"availability":"available","valuePermille":500},"evidenceQuality":{"availability":"available","valuePermille":750},"scopeConfidence":{"availability":"available","valuePermille":1000},"sensitivity":{"availability":"unavailable"}}}';

    expect(canonical).toBe(expected);
    expect(admissionFeatureEnvelopeIdentityV1(handFixture())).toBe(
      'sha256:7c589c70ede05c6ba50fb9151e12276a5a9637424531e99e75c221be00f15c76',
    );
  });

  it.each([
    ['root array', [], 'not_object', 'featureEnvelope'],
    ['unknown root key', { ...handFixture(), rawContent: 'secret-root' }, 'unknown_key', 'featureEnvelope'],
    ['missing root key', (() => { const value = handFixture() as Record<string, unknown>; delete value.extractor; return value; })(), 'missing_key', 'featureEnvelope.extractor'],
    ['wrong contract identity', { ...handFixture(), contractId: 'secret-contract' }, 'invalid_identity', 'featureEnvelope.contractId'],
    ['wrong contract version', { ...handFixture(), contractVersion: '2.0.0' }, 'invalid_identity', 'featureEnvelope.contractVersion'],
    ['unknown extractor key', { ...handFixture(), extractor: { ...handFixture().extractor, metadata: 'secret-extractor' } }, 'unknown_key', 'featureEnvelope.extractor'],
    ['wrong extractor id', { ...handFixture(), extractor: { ...handFixture().extractor, id: 'secret-extractor' } }, 'invalid_identity', 'featureEnvelope.extractor.id'],
    ['wrong extractor version', { ...handFixture(), extractor: { ...handFixture().extractor, version: '99.0.0' } }, 'invalid_identity', 'featureEnvelope.extractor.version'],
    ['unknown dimension', { ...handFixture(), dimensions: { ...handFixture().dimensions, content: available(0.5) } }, 'unknown_key', 'featureEnvelope.dimensions'],
    ['missing dimension', (() => { const dimensions = { ...handFixture().dimensions } as Record<string, unknown>; delete dimensions.novelty; return { ...handFixture(), dimensions }; })(), 'missing_key', 'featureEnvelope.dimensions.novelty'],
    ['dimension array', { ...handFixture(), dimensions: [] }, 'not_object', 'featureEnvelope.dimensions'],
    ['unknown feature key', { ...handFixture(), dimensions: { ...handFixture().dimensions, salience: { ...available(0.5), content: 'secret-feature' } } }, 'unknown_key', 'featureEnvelope.dimensions.salience'],
    ['missing value', { ...handFixture(), dimensions: { ...handFixture().dimensions, salience: { availability: 'available' } } }, 'missing_key', 'featureEnvelope.dimensions.salience.valuePermille'],
    ['value with unavailable', { ...handFixture(), dimensions: { ...handFixture().dimensions, salience: { availability: 'unavailable', valuePermille: 500 } } }, 'unknown_key', 'featureEnvelope.dimensions.salience'],
    ['invalid availability', { ...handFixture(), dimensions: { ...handFixture().dimensions, salience: { availability: 'secret-state' } } }, 'invalid_enum', 'featureEnvelope.dimensions.salience.availability'],
    ['negative', { ...handFixture(), dimensions: { ...handFixture().dimensions, salience: available(-1) } }, 'out_of_bounds', 'featureEnvelope.dimensions.salience.valuePermille'],
    ['above one thousand', { ...handFixture(), dimensions: { ...handFixture().dimensions, salience: available(1_001) } }, 'out_of_bounds', 'featureEnvelope.dimensions.salience.valuePermille'],
    ['off-grid decimal', { ...handFixture(), dimensions: { ...handFixture().dimensions, salience: available(0.5) } }, 'noncanonical', 'featureEnvelope.dimensions.salience.valuePermille'],
    ['NaN', { ...handFixture(), dimensions: { ...handFixture().dimensions, salience: available(Number.NaN) } }, 'invalid_number', 'featureEnvelope.dimensions.salience.valuePermille'],
    ['infinity', { ...handFixture(), dimensions: { ...handFixture().dimensions, salience: available(Number.POSITIVE_INFINITY) } }, 'invalid_number', 'featureEnvelope.dimensions.salience.valuePermille'],
    ['negative zero', { ...handFixture(), dimensions: { ...handFixture().dimensions, salience: available(-0) } }, 'noncanonical', 'featureEnvelope.dimensions.salience.valuePermille'],
  ])('rejects %s without reflecting hostile values', (_name, input, code, field) => {
    expectContractError(input, code, field);
  });

  it('rejects the exact mantissa covert-channel regression', () => {
    const input = handFixture();
    input.dimensions.salience = available(0.51016486309724);
    expectContractError(input, 'noncanonical', 'featureEnvelope.dimensions.salience.valuePermille');
  });

  it('accepts only the documented integer permille grid including both boundaries', () => {
    for (const valuePermille of [0, 1, 499, 500, 999, 1_000]) {
      const input = handFixture();
      input.dimensions.salience = available(valuePermille);
      expect(parseAdmissionFeatureEnvelopeV1(input).dimensions.salience).toEqual({
        availability: 'available',
        valuePermille,
      });
    }
  });

  it('rejects proxies without triggering traps', () => {
    let traps = 0;
    const proxy = new Proxy(handFixture(), {
      get() { traps += 1; throw new Error('secret proxy trap'); },
      ownKeys() { traps += 1; throw new Error('secret proxy trap'); },
      getOwnPropertyDescriptor() { traps += 1; throw new Error('secret proxy trap'); },
    });
    expect(nodeUtilTypes.isProxy(proxy)).toBe(true);
    expectContractError(proxy, 'invalid_type', 'featureEnvelope');
    expect(traps).toBe(0);
  });

  it('rejects accessors without invoking them', () => {
    const input = handFixture();
    let invoked = 0;
    Object.defineProperty(input.dimensions.salience, 'valuePermille', {
      enumerable: true,
      get() { invoked += 1; throw new Error('secret accessor'); },
    });
    expectContractError(input, 'invalid_type', 'featureEnvelope.dimensions.salience');
    expect(invoked).toBe(0);
  });

  it('rejects sparse arrays and custom prototypes', () => {
    const sparse: unknown[] = [];
    sparse.length = 6;
    expectContractError({ ...handFixture(), dimensions: sparse }, 'not_object', 'featureEnvelope.dimensions');

    const custom = Object.create({ secret: 'prototype-data' }) as Record<string, unknown>;
    Object.assign(custom, handFixture().dimensions);
    expectContractError({ ...handFixture(), dimensions: custom }, 'invalid_type', 'featureEnvelope.dimensions');
  });

  it('preflights amplified unknown root and dimension keys before cloning', () => {
    const largeRoot = handFixture() as Record<string, unknown>;
    for (let index = 0; index < 250_000; index += 1) largeRoot[`unknownRoot${index}`] = index;
    const rootStarted = performance.now();
    expectContractError(largeRoot, 'unknown_key', 'featureEnvelope');
    expect(performance.now() - rootStarted).toBeLessThan(750);

    const dimensions = handFixture().dimensions as Record<string, unknown>;
    for (let index = 0; index < 250_000; index += 1) dimensions[`unknownDimension${index}`] = index;
    const dimensionStarted = performance.now();
    expectContractError({ ...handFixture(), dimensions }, 'unknown_key', 'featureEnvelope.dimensions');
    expect(performance.now() - dimensionStarted).toBeLessThan(750);
  });

  it('rejects shared references and cycles before canonicalization', () => {
    const shared = available(500);
    const input = handFixture();
    input.dimensions.salience = shared;
    input.dimensions.novelty = shared;
    expectContractError(input, 'shared_reference', 'featureEnvelope.dimensions.novelty');

    const cyclic = handFixture();
    cyclic.dimensions.salience = cyclic.dimensions as never;
    expectContractError(cyclic, 'cyclic_reference', 'featureEnvelope.dimensions.salience');
  });

  it('exposes no field that can carry raw content, task, credentials, or arbitrary metadata', () => {
    const hostile = JSON.parse(JSON.stringify(handFixture())) as Record<string, unknown>;
    for (const field of ['content', 'task', 'credential', 'token', 'metadata']) {
      hostile[field] = `secret-${field}`;
      expectContractError(hostile, 'unknown_key', 'featureEnvelope');
      delete hostile[field];
    }
    const parsed = parseAdmissionFeatureEnvelopeV1(handFixture());
    expect(JSON.stringify(parsed)).not.toMatch(/content|task|credential|token|metadata/i);
  });
});
