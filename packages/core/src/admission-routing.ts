import { createHash } from 'node:crypto';
import { types as nodeUtilTypes } from 'node:util';

import {
  parseAdmissionSafeFactsV1,
  type AdmissionSafeFactsV1,
  type AdmissionTier,
} from './admission.js';
import {
  parseAdmissionFeatureEnvelopeV1,
  type AdmissionFeatureDimension,
  type AdmissionFeatureEnvelopeV1,
} from './admission-features.js';

export const TIER_ROUTING_POLICY_ID = 'tier-routing-admission' as const;
export const TIER_ROUTING_POLICY_VERSION = '1.0.0' as const;
export const TIER_ROUTING_CONTRACT_VERSION = '1.0.0' as const;

export const TIER_ROUTING_DEFAULT_PROTECTED_SENSITIVITY_MIN_PERMILLE = 500 as const;
export const TIER_ROUTING_DEFAULT_CANDIDATE_DURABILITY_MIN_PERMILLE = 600 as const;
export const TIER_ROUTING_DEFAULT_CANDIDATE_EVIDENCE_QUALITY_MIN_PERMILLE = 600 as const;
export const TIER_ROUTING_DEFAULT_DISCARD_SALIENCE_MAX_PERMILLE = 100 as const;
export const TIER_ROUTING_DEFAULT_DISCARD_DURABILITY_MAX_PERMILLE = 200 as const;
export const TIER_ROUTING_DEFAULT_WORKING_DURABILITY_MAX_PERMILLE = 300 as const;

export const TIER_ROUTING_ENV_PROTECTED_SENSITIVITY_MIN_PERMILLE =
  'MEMBERRY_ADMISSION_ROUTING_PROTECTED_SENSITIVITY_MIN_PERMILLE' as const;
export const TIER_ROUTING_ENV_CANDIDATE_DURABILITY_MIN_PERMILLE =
  'MEMBERRY_ADMISSION_ROUTING_CANDIDATE_DURABILITY_MIN_PERMILLE' as const;
export const TIER_ROUTING_ENV_CANDIDATE_EVIDENCE_QUALITY_MIN_PERMILLE =
  'MEMBERRY_ADMISSION_ROUTING_CANDIDATE_EVIDENCE_QUALITY_MIN_PERMILLE' as const;
export const TIER_ROUTING_ENV_DISCARD_SALIENCE_MAX_PERMILLE =
  'MEMBERRY_ADMISSION_ROUTING_DISCARD_SALIENCE_MAX_PERMILLE' as const;
export const TIER_ROUTING_ENV_DISCARD_DURABILITY_MAX_PERMILLE =
  'MEMBERRY_ADMISSION_ROUTING_DISCARD_DURABILITY_MAX_PERMILLE' as const;
export const TIER_ROUTING_ENV_WORKING_DURABILITY_MAX_PERMILLE =
  'MEMBERRY_ADMISSION_ROUTING_WORKING_DURABILITY_MAX_PERMILLE' as const;

export type TierRoutingReasonCode =
  | 'capture-rejected'
  | 'capture-duplicate'
  | 'sensitivity-protected'
  | 'approved-decision-candidate'
  | 'feature-candidate'
  | 'feature-discard'
  | 'feature-working'
  | 'baseline-episodic-default'
  | 'features-unavailable-default';

/** All thresholds are integer permille on the closed 0..1000 grid. */
export interface TierRoutingConfigV1 {
  readonly protectedSensitivityMinPermille: number;
  readonly candidateDurabilityMinPermille: number;
  readonly candidateEvidenceQualityMinPermille: number;
  readonly discardSalienceMaxPermille: number;
  readonly discardDurabilityMaxPermille: number;
  readonly workingDurabilityMaxPermille: number;
}

export interface TierRoutingRecommendationV1 {
  readonly contractVersion: typeof TIER_ROUTING_CONTRACT_VERSION;
  readonly policyId: typeof TIER_ROUTING_POLICY_ID;
  readonly policyVersion: typeof TIER_ROUTING_POLICY_VERSION;
  readonly configIdentity: `sha256:${string}`;
  readonly recommendedTier: AdmissionTier;
  readonly reasonCode: TierRoutingReasonCode;
  readonly wouldChangeBaseline: boolean;
}

export type TierRoutingContractErrorCode =
  | 'not_object'
  | 'unknown_key'
  | 'missing_key'
  | 'invalid_type'
  | 'invalid_enum'
  | 'invalid_number'
  | 'out_of_bounds'
  | 'noncanonical'
  | 'invalid_state';

/** Contract failures mention only closed field paths and codes, never input values. */
export class TierRoutingContractError extends Error {
  constructor(
    readonly code: TierRoutingContractErrorCode,
    readonly field: string,
  ) {
    super(`tier_routing_contract:${code}:${field}`);
    this.name = 'TierRoutingContractError';
  }
}

const CONFIG_KEYS = [
  'protectedSensitivityMinPermille',
  'candidateDurabilityMinPermille',
  'candidateEvidenceQualityMinPermille',
  'discardSalienceMaxPermille',
  'discardDurabilityMaxPermille',
  'workingDurabilityMaxPermille',
] as const;

type TierRoutingConfigKey = (typeof CONFIG_KEYS)[number];

interface ThresholdBounds {
  readonly min: number;
  readonly max: number;
}

// 0 on a >= rule (or 1000 on a <= rule) would make the conjunct a no-op and
// route every input through that rule; those degenerate settings are rejected.
const CONFIG_BOUNDS: Readonly<Record<TierRoutingConfigKey, ThresholdBounds>> = Object.freeze({
  protectedSensitivityMinPermille: Object.freeze({ min: 1, max: 1_000 }),
  candidateDurabilityMinPermille: Object.freeze({ min: 0, max: 1_000 }),
  candidateEvidenceQualityMinPermille: Object.freeze({ min: 1, max: 1_000 }),
  discardSalienceMaxPermille: Object.freeze({ min: 0, max: 999 }),
  discardDurabilityMaxPermille: Object.freeze({ min: 0, max: 1_000 }),
  workingDurabilityMaxPermille: Object.freeze({ min: 0, max: 1_000 }),
});

function configRecord(value: unknown, field: string): Record<PropertyKey, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TierRoutingContractError('not_object', field);
    }
    if (nodeUtilTypes.isProxy(value)) throw new TierRoutingContractError('invalid_type', field);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TierRoutingContractError('invalid_type', field);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > CONFIG_KEYS.length) {
      throw new TierRoutingContractError('unknown_key', field);
    }
    const allowed = new Set<PropertyKey>(CONFIG_KEYS);
    for (const key of keys) {
      if (typeof key !== 'string' || !allowed.has(key)) {
        throw new TierRoutingContractError('unknown_key', field);
      }
    }
    for (const key of CONFIG_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        throw new TierRoutingContractError('missing_key', `${field}.${key}`);
      }
    }
    const clone = Object.create(null) as Record<PropertyKey, unknown>;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new TierRoutingContractError('invalid_type', field);
      }
      Object.defineProperty(clone, key, {
        value: descriptor.value,
        enumerable: descriptor.enumerable,
        configurable: true,
        writable: true,
      });
    }
    return clone;
  } catch (error) {
    if (error instanceof TierRoutingContractError) throw error;
    throw new TierRoutingContractError('invalid_type', field);
  }
}

function permilleValue(value: unknown, field: string, bounds: ThresholdBounds): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TierRoutingContractError('invalid_number', field);
  }
  if (Object.is(value, -0) || !Number.isSafeInteger(value)) {
    throw new TierRoutingContractError('noncanonical', field);
  }
  if (value < bounds.min || value > bounds.max) {
    throw new TierRoutingContractError('out_of_bounds', field);
  }
  return value;
}

export function parseTierRoutingConfigV1(value: unknown): TierRoutingConfigV1 {
  const field = 'tierRoutingConfig';
  const input = configRecord(value, field);
  const parsed = {} as Record<TierRoutingConfigKey, number>;
  for (const key of CONFIG_KEYS) {
    parsed[key] = permilleValue(input[key], `${field}.${key}`, CONFIG_BOUNDS[key]);
  }
  // Bands must neither overlap nor invert: discard ⊆ working < candidate.
  if (parsed.discardDurabilityMaxPermille > parsed.workingDurabilityMaxPermille
    || parsed.workingDurabilityMaxPermille >= parsed.candidateDurabilityMinPermille) {
    throw new TierRoutingContractError('invalid_state', field);
  }
  return Object.freeze({
    protectedSensitivityMinPermille: parsed.protectedSensitivityMinPermille,
    candidateDurabilityMinPermille: parsed.candidateDurabilityMinPermille,
    candidateEvidenceQualityMinPermille: parsed.candidateEvidenceQualityMinPermille,
    discardSalienceMaxPermille: parsed.discardSalienceMaxPermille,
    discardDurabilityMaxPermille: parsed.discardDurabilityMaxPermille,
    workingDurabilityMaxPermille: parsed.workingDurabilityMaxPermille,
  });
}

export const DEFAULT_TIER_ROUTING_CONFIG: TierRoutingConfigV1 = parseTierRoutingConfigV1({
  protectedSensitivityMinPermille: TIER_ROUTING_DEFAULT_PROTECTED_SENSITIVITY_MIN_PERMILLE,
  candidateDurabilityMinPermille: TIER_ROUTING_DEFAULT_CANDIDATE_DURABILITY_MIN_PERMILLE,
  candidateEvidenceQualityMinPermille: TIER_ROUTING_DEFAULT_CANDIDATE_EVIDENCE_QUALITY_MIN_PERMILLE,
  discardSalienceMaxPermille: TIER_ROUTING_DEFAULT_DISCARD_SALIENCE_MAX_PERMILLE,
  discardDurabilityMaxPermille: TIER_ROUTING_DEFAULT_DISCARD_DURABILITY_MAX_PERMILLE,
  workingDurabilityMaxPermille: TIER_ROUTING_DEFAULT_WORKING_DURABILITY_MAX_PERMILLE,
});

const ENV_VAR_BY_KEY: Readonly<Record<TierRoutingConfigKey, string>> = Object.freeze({
  protectedSensitivityMinPermille: TIER_ROUTING_ENV_PROTECTED_SENSITIVITY_MIN_PERMILLE,
  candidateDurabilityMinPermille: TIER_ROUTING_ENV_CANDIDATE_DURABILITY_MIN_PERMILLE,
  candidateEvidenceQualityMinPermille: TIER_ROUTING_ENV_CANDIDATE_EVIDENCE_QUALITY_MIN_PERMILLE,
  discardSalienceMaxPermille: TIER_ROUTING_ENV_DISCARD_SALIENCE_MAX_PERMILLE,
  discardDurabilityMaxPermille: TIER_ROUTING_ENV_DISCARD_DURABILITY_MAX_PERMILLE,
  workingDurabilityMaxPermille: TIER_ROUTING_ENV_WORKING_DURABILITY_MAX_PERMILLE,
});

/**
 * Environment resolution for the routing thresholds. Unset variables keep the
 * frozen defaults; set variables must be digits-only, and the combined result
 * must still satisfy the full config contract (bounds and band invariant).
 * Activation is staged separately through MEMBERRY_ADMISSION_ROUTING_V1
 * (resolveAdmissionRoutingModeV1): `disabled` (default) or `shadow`, which
 * only records sibling recommendations inside the admission shadow attempt.
 * `served` is a reserved token — enforcement that changes what is stored is
 * destructive-class and stays owner-gated for a later packet.
 */
export function resolveTierRoutingConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): TierRoutingConfigV1 {
  const candidate = {} as Record<TierRoutingConfigKey, number>;
  for (const key of CONFIG_KEYS) {
    const raw = env[ENV_VAR_BY_KEY[key]]?.trim();
    if (raw === undefined || raw === '') {
      candidate[key] = DEFAULT_TIER_ROUTING_CONFIG[key];
      continue;
    }
    if (!/^[0-9]+$/.test(raw)) {
      throw new TierRoutingContractError('invalid_number', `tierRoutingConfig.${key}`);
    }
    candidate[key] = Number(raw);
  }
  return parseTierRoutingConfigV1({ ...candidate });
}

/** Fixed-key JSON representation used only for deterministic config identity. */
export function canonicalTierRoutingConfigV1(config: unknown): string {
  return JSON.stringify(parseTierRoutingConfigV1(config));
}

/** Content-free, cross-runtime identity for a resolved routing configuration. */
export function tierRoutingConfigIdentityV1(config: unknown): `sha256:${string}` {
  const canonical = canonicalTierRoutingConfigV1(config);
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

export const ADMISSION_ROUTING_MODE_ENV = 'MEMBERRY_ADMISSION_ROUTING_V1' as const;

export type AdmissionRoutingModeV1 = 'disabled' | 'shadow';

export type AdmissionRoutingModeErrorCode =
  | 'invalid_mode'
  | 'served_not_qualified'
  | 'prerequisite_unavailable';

/** Closed configuration failures name only the code, never the supplied value. */
export class AdmissionRoutingModeError extends Error {
  constructor(readonly code: AdmissionRoutingModeErrorCode) {
    super(`admission_routing:${code}`);
    this.name = 'AdmissionRoutingModeError';
  }
}

/**
 * Strict staging-flag resolution: exact strings only, no trimming, coercion,
 * aliases, or value reflection. `served` parses but is rejected — the token is
 * reserved so the staging ladder stays explicit while enforcement remains
 * owner-gated.
 */
export function resolveAdmissionRoutingModeV1(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AdmissionRoutingModeV1 {
  const raw = env[ADMISSION_ROUTING_MODE_ENV];
  if (raw === undefined || raw === '' || raw === 'disabled') return 'disabled';
  if (raw === 'shadow') return 'shadow';
  if (raw === 'served') throw new AdmissionRoutingModeError('served_not_qualified');
  throw new AdmissionRoutingModeError('invalid_mode');
}

function dimensionValue(
  envelope: AdmissionFeatureEnvelopeV1 | null,
  dimension: AdmissionFeatureDimension,
): number | null {
  if (envelope === null) return null;
  const value = envelope.dimensions[dimension];
  return value.availability === 'available' ? value.valuePermille : null;
}

/**
 * Pure, deterministic five-tier routing policy over content-free inputs.
 * Shadow-side only: the live seam records recommendations as sidecars without
 * consuming them, so the baseline episodic route (MEM-FR-3) is untouched by
 * construction.
 */
export function routeAdmissionTierV1(
  facts: AdmissionSafeFactsV1,
  envelope: AdmissionFeatureEnvelopeV1 | null,
  config: TierRoutingConfigV1,
): TierRoutingRecommendationV1 {
  const safeFacts = parseAdmissionSafeFactsV1(facts);
  const features = envelope === null ? null : parseAdmissionFeatureEnvelopeV1(envelope);
  const resolvedConfig = parseTierRoutingConfigV1(config);
  const configIdentity = tierRoutingConfigIdentityV1(resolvedConfig);

  const decide = (): { readonly tier: AdmissionTier; readonly reason: TierRoutingReasonCode } => {
    // Rules 1–2: non-accepted capture states short-circuit all scoring, so the
    // policy can never recommend storing something the baseline refused.
    if (safeFacts.captureState === 'rejected') {
      return { tier: 'discard', reason: 'capture-rejected' };
    }
    if (safeFacts.captureState === 'duplicate') {
      return { tier: 'discard', reason: 'capture-duplicate' };
    }

    const sensitivity = dimensionValue(features, 'sensitivity');
    if (safeFacts.sensitivity === 'detected'
      || (sensitivity !== null && sensitivity >= resolvedConfig.protectedSensitivityMinPermille)) {
      // Protected outranks every scoring rule: sensitive content is never
      // auto-discarded or auto-promoted (MEM-FR-9, SEC-FR-7).
      return { tier: 'protected', reason: 'sensitivity-protected' };
    }

    if (safeFacts.memoryClass === 'decision' && safeFacts.outcome === 'approved') {
      return { tier: 'semantic-candidate', reason: 'approved-decision-candidate' };
    }

    const durability = dimensionValue(features, 'durability');
    const evidenceQuality = dimensionValue(features, 'evidenceQuality');
    if (durability !== null && evidenceQuality !== null
      && durability >= resolvedConfig.candidateDurabilityMinPermille
      && evidenceQuality >= resolvedConfig.candidateEvidenceQualityMinPermille) {
      return { tier: 'semantic-candidate', reason: 'feature-candidate' };
    }

    const salience = dimensionValue(features, 'salience');
    if (salience !== null && durability !== null
      && salience <= resolvedConfig.discardSalienceMaxPermille
      && durability <= resolvedConfig.discardDurabilityMaxPermille) {
      return { tier: 'discard', reason: 'feature-discard' };
    }

    if (durability !== null && durability <= resolvedConfig.workingDurabilityMaxPermille) {
      return { tier: 'working', reason: 'feature-working' };
    }

    return features !== null
      ? { tier: 'episodic', reason: 'baseline-episodic-default' }
      : { tier: 'episodic', reason: 'features-unavailable-default' };
  };

  const { tier, reason } = decide();
  const wouldChangeBaseline = safeFacts.captureState === 'accepted-nonduplicate'
    ? tier !== 'episodic'
    : false;

  return Object.freeze({
    contractVersion: TIER_ROUTING_CONTRACT_VERSION,
    policyId: TIER_ROUTING_POLICY_ID,
    policyVersion: TIER_ROUTING_POLICY_VERSION,
    configIdentity,
    recommendedTier: tier,
    reasonCode: reason,
    wouldChangeBaseline,
  });
}
