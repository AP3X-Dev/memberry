// MEM-002 live deterministic feature producer.
//
// Derives the narrowed three-dimension v2 feature envelope from
// AdmissionSafeFactsV1 ONLY — no content, no clock, no I/O, no randomness.
// The mapping tables below are frozen policy (spec 2026-08-24 §3 and
// bench/lab/admission-features/fixtures/v3/MAPPING.md): any change is an
// extractor-version bump AND a TIER_ROUTING_POLICY_VERSION review.

import { parseAdmissionSafeFactsV1, type AdmissionSafeFactsV1 } from './admission.js';
import {
  ADMISSION_FEATURE_CONTRACT_VERSION_V2,
  ADMISSION_FEATURE_EXTRACTOR_ID_V2,
  ADMISSION_FEATURE_EXTRACTOR_VERSION_V2,
  parseAdmissionFeatureEnvelopeV2,
  type AdmissionFeatureEnvelopeV2,
} from './admission-features-v2.js';
import { ADMISSION_FEATURE_CONTRACT_ID, type AdmissionFeatureValueV1 } from './admission-features.js';

// §3.2 durability: memory-class base values on the closed 0..1000 grid.
// `unclassified` supplies no base — claiming a durability for a write that
// carried no memoryType would be invented signal, so the dimension stays
// unavailable and the D1 discount can never fire on it.
const DURABILITY_BASE_PERMILLE: Readonly<Record<AdmissionSafeFactsV1['memoryClass'], number | null>> = Object.freeze({
  decision: 900,
  architecture: 850,
  convention: 800,
  pattern: 750,
  preference: 650,
  fact: 600,
  general: 250,
  unclassified: null,
});

// §3.2 adjustment D1: a rejected/abandoned outcome discounts durability by
// 400 permille, floored at zero, applied after base lookup, never changing
// availability.
const D1_RETRACTED_OUTCOMES: ReadonlySet<AdmissionSafeFactsV1['outcome']> = new Set(['rejected', 'abandoned']);
const D1_DISCOUNT_PERMILLE = 400;

// §3.3 evidenceQuality: corroboration structure count over the content-safe
// markers hasSignals + hasEntities (hasModel is generation provenance, not
// corroborating structure). The ladder reuses the qualified lab
// evidenceSupport values: none 0 / single 450 / corroborated 1000.
const EVIDENCE_QUALITY_BY_COUNT: readonly number[] = Object.freeze([0, 450, 1_000]);

// §3.1 sensitivity: a permille mapping of the SAME preprocessor fact rule 3
// already consumes — a two-state detector supports only the grid extremes.
const SENSITIVITY_PERMILLE: Readonly<Record<AdmissionSafeFactsV1['sensitivity'], number>> = Object.freeze({
  'not-detected': 0,
  detected: 1_000,
});

function available(valuePermille: number): AdmissionFeatureValueV1 {
  return { availability: 'available', valuePermille };
}

function durability(facts: AdmissionSafeFactsV1): AdmissionFeatureValueV1 {
  const base = DURABILITY_BASE_PERMILLE[facts.memoryClass];
  if (base === null) return { availability: 'unavailable' };
  return available(D1_RETRACTED_OUTCOMES.has(facts.outcome)
    ? Math.max(0, base - D1_DISCOUNT_PERMILLE)
    : base);
}

function evidenceQuality(facts: AdmissionSafeFactsV1): AdmissionFeatureValueV1 {
  const count = (facts.hasSignals ? 1 : 0) + (facts.hasEntities ? 1 : 0);
  return available(EVIDENCE_QUALITY_BY_COUNT[count]!);
}

/**
 * Pure, synchronous, deterministic v2 envelope production. Re-parses its input
 * through the safe-facts contract and self-validates its own output, so a
 * returned envelope is always frozen and canonical.
 */
export function produceAdmissionFeatureEnvelopeV2(facts: AdmissionSafeFactsV1): AdmissionFeatureEnvelopeV2 {
  const safeFacts = parseAdmissionSafeFactsV1(facts);
  return parseAdmissionFeatureEnvelopeV2({
    contractId: ADMISSION_FEATURE_CONTRACT_ID,
    contractVersion: ADMISSION_FEATURE_CONTRACT_VERSION_V2,
    extractor: {
      id: ADMISSION_FEATURE_EXTRACTOR_ID_V2,
      version: ADMISSION_FEATURE_EXTRACTOR_VERSION_V2,
    },
    dimensions: {
      durability: durability(safeFacts),
      evidenceQuality: evidenceQuality(safeFacts),
      sensitivity: available(SENSITIVITY_PERMILLE[safeFacts.sensitivity]),
    },
  });
}
