import { describe, expect, it } from 'vitest';

import { parseAdmissionSafeFactsV1, type AdmissionSafeFactsV1 } from '../admission.js';
import {
  canonicalAdmissionFeatureEnvelopeV2,
  parseAdmissionFeatureEnvelopeV2,
} from '../admission-features-v2.js';
import { produceAdmissionFeatureEnvelopeV2 } from '../admission-feature-producer.js';

type FactsOverrides = {
  memoryClass?: string;
  outcome?: string;
  sensitivity?: string;
  hasSignals?: boolean;
  hasEntities?: boolean;
  hasModel?: boolean;
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

function dimension(
  envelope: ReturnType<typeof produceAdmissionFeatureEnvelopeV2>,
  name: 'durability' | 'evidenceQuality' | 'sensitivity',
): number | 'unavailable' {
  const value = envelope.dimensions[name];
  return value.availability === 'available' ? value.valuePermille : 'unavailable';
}

describe('MEM-002 live safe-facts feature producer', () => {
  it.each([
    ['decision', 900],
    ['architecture', 850],
    ['convention', 800],
    ['pattern', 750],
    ['preference', 650],
    ['fact', 600],
    ['general', 250],
  ])('maps memoryClass %s to base durability %i', (memoryClass, expected) => {
    const envelope = produceAdmissionFeatureEnvelopeV2(facts({ memoryClass }));
    expect(dimension(envelope, 'durability')).toBe(expected);
  });

  it('maps unclassified to durability unavailable (no invented signal)', () => {
    const envelope = produceAdmissionFeatureEnvelopeV2(facts({ memoryClass: 'unclassified' }));
    expect(dimension(envelope, 'durability')).toBe('unavailable');
  });

  it.each([
    ['rejected', 500],
    ['abandoned', 500],
  ])('applies the D1 retracted-outcome discount for %s (decision 900 - 400)', (outcome, expected) => {
    const envelope = produceAdmissionFeatureEnvelopeV2(facts({ memoryClass: 'decision', outcome }));
    expect(dimension(envelope, 'durability')).toBe(expected);
  });

  it.each([
    ['approved', 900],
    ['revised', 900],
    ['unspecified', 900],
  ])('applies no durability adjustment for outcome %s', (outcome, expected) => {
    const envelope = produceAdmissionFeatureEnvelopeV2(facts({ memoryClass: 'decision', outcome }));
    expect(dimension(envelope, 'durability')).toBe(expected);
  });

  it('floors the D1 discount at zero (general + rejected)', () => {
    const envelope = produceAdmissionFeatureEnvelopeV2(facts({ memoryClass: 'general', outcome: 'rejected' }));
    expect(dimension(envelope, 'durability')).toBe(0);
  });

  it('never fires D1 on an unavailable durability (unclassified + abandoned)', () => {
    const envelope = produceAdmissionFeatureEnvelopeV2(facts({ memoryClass: 'unclassified', outcome: 'abandoned' }));
    expect(dimension(envelope, 'durability')).toBe('unavailable');
  });

  it.each([
    [false, false, 0],
    [true, false, 450],
    [false, true, 450],
    [true, true, 1_000],
  ])('maps hasSignals=%s hasEntities=%s to evidenceQuality %i', (hasSignals, hasEntities, expected) => {
    const envelope = produceAdmissionFeatureEnvelopeV2(facts({ hasSignals, hasEntities }));
    expect(dimension(envelope, 'evidenceQuality')).toBe(expected);
  });

  it('ignores hasModel entirely (generation provenance is not corroboration)', () => {
    const withModel = produceAdmissionFeatureEnvelopeV2(facts({ hasSignals: true, hasModel: true }));
    const withoutModel = produceAdmissionFeatureEnvelopeV2(facts({ hasSignals: true, hasModel: false }));
    expect(canonicalAdmissionFeatureEnvelopeV2(withModel)).toBe(canonicalAdmissionFeatureEnvelopeV2(withoutModel));
  });

  it.each([
    ['not-detected', 0],
    ['detected', 1_000],
  ])('maps sensitivity %s to permille %i', (sensitivity, expected) => {
    const envelope = produceAdmissionFeatureEnvelopeV2(facts({ sensitivity }));
    expect(dimension(envelope, 'sensitivity')).toBe(expected);
  });

  it('emits a self-validated, frozen v2 envelope', () => {
    const envelope = produceAdmissionFeatureEnvelopeV2(facts());
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(envelope.contractVersion).toBe('2.0.0');
    expect(envelope.extractor).toEqual({ id: 'memberry.safe-facts-feature-producer', version: '1.0.0' });
    expect(() => parseAdmissionFeatureEnvelopeV2(envelope)).not.toThrow();
    expect(Object.keys(envelope.dimensions).sort()).toEqual(['durability', 'evidenceQuality', 'sensitivity']);
  });

  it('is byte-deterministic across repeated calls', () => {
    const input = facts({ memoryClass: 'decision', outcome: 'approved', hasSignals: true, hasEntities: true });
    expect(canonicalAdmissionFeatureEnvelopeV2(produceAdmissionFeatureEnvelopeV2(input)))
      .toBe(canonicalAdmissionFeatureEnvelopeV2(produceAdmissionFeatureEnvelopeV2(input)));
  });

  it('rejects unbranded garbage input through the safe-facts parser', () => {
    expect(() => produceAdmissionFeatureEnvelopeV2({ memoryClass: 'decision' } as never)).toThrow();
  });
});
