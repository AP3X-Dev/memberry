import { createHash } from 'node:crypto';
import { types as nodeUtilTypes } from 'node:util';

import {
  ADMISSION_FEATURE_CONTRACT_ID,
  ADMISSION_FEATURE_VALUE_MAX_PERMILLE,
  ADMISSION_FEATURE_VALUE_MIN_PERMILLE,
  AdmissionFeatureContractError,
  type AdmissionFeatureValueV1,
} from './admission-features.js';

export { AdmissionFeatureContractError } from './admission-features.js';

export const ADMISSION_FEATURE_CONTRACT_VERSION_V2 = '2.0.0' as const;
export const ADMISSION_FEATURE_EXTRACTOR_ID_V2 = 'memberry.safe-facts-feature-producer' as const;
export const ADMISSION_FEATURE_EXTRACTOR_VERSION_V2 = '1.0.0' as const;

/**
 * The v2 envelope is closed on exactly THREE dimensions. salience, novelty,
 * and scopeConfidence are removed from the produced contract (MEM-002
 * productionization): they are unknown_key violations if present, not
 * silently-unavailable placeholders.
 */
export const ADMISSION_FEATURE_DIMENSIONS_V2 = [
  'durability',
  'evidenceQuality',
  'sensitivity',
] as const;

export type AdmissionFeatureDimensionV2 = (typeof ADMISSION_FEATURE_DIMENSIONS_V2)[number];

export type AdmissionFeatureDimensionsV2 = Readonly<Record<AdmissionFeatureDimensionV2, AdmissionFeatureValueV1>>;

export interface AdmissionFeatureExtractorIdentityV2 {
  readonly id: typeof ADMISSION_FEATURE_EXTRACTOR_ID_V2;
  readonly version: typeof ADMISSION_FEATURE_EXTRACTOR_VERSION_V2;
}

/**
 * A content-free feature envelope. It intentionally has no extension bag:
 * raw task/content, identifiers, credentials, and arbitrary metadata cannot be
 * represented by this contract.
 */
export interface AdmissionFeatureEnvelopeV2 {
  readonly contractId: typeof ADMISSION_FEATURE_CONTRACT_ID;
  readonly contractVersion: typeof ADMISSION_FEATURE_CONTRACT_VERSION_V2;
  readonly extractor: AdmissionFeatureExtractorIdentityV2;
  readonly dimensions: AdmissionFeatureDimensionsV2;
}

interface TraversalState {
  readonly seen: WeakSet<object>;
  readonly active: WeakSet<object>;
}

interface EnteredRecord {
  readonly source: object;
  readonly value: Record<PropertyKey, unknown>;
}

function enterRecord(
  value: unknown,
  field: string,
  state: TraversalState,
  allowed: readonly string[],
  required: readonly string[],
): EnteredRecord {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new AdmissionFeatureContractError('not_object', field);
    }
    if (nodeUtilTypes.isProxy(value)) {
      throw new AdmissionFeatureContractError('invalid_type', field);
    }
    if (state.active.has(value)) {
      throw new AdmissionFeatureContractError('cyclic_reference', field);
    }
    if (state.seen.has(value)) {
      throw new AdmissionFeatureContractError('shared_reference', field);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new AdmissionFeatureContractError('invalid_type', field);
    }

    // Closed objects are bounded before any descriptor walk or clone. This
    // prevents large unknown-key inputs from amplifying parser memory/work.
    const keys = Reflect.ownKeys(value);
    if (keys.length > allowed.length) {
      throw new AdmissionFeatureContractError('unknown_key', field);
    }
    const allowedKeys = new Set(allowed);
    for (const key of keys) {
      if (typeof key !== 'string' || !allowedKeys.has(key)) {
        throw new AdmissionFeatureContractError('unknown_key', field);
      }
    }
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        throw new AdmissionFeatureContractError('missing_key', `${field}.${key}`);
      }
    }

    const descriptors: Array<readonly [PropertyKey, PropertyDescriptor & { value: unknown }]> = [];
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new AdmissionFeatureContractError('invalid_type', field);
      }
      descriptors.push([key, descriptor as PropertyDescriptor & { value: unknown }]);
    }

    state.seen.add(value);
    state.active.add(value);
    const clone = Object.create(null) as Record<PropertyKey, unknown>;
    for (const [key, descriptor] of descriptors) {
      Object.defineProperty(clone, key, {
        value: descriptor.value,
        enumerable: descriptor.enumerable,
        configurable: true,
        writable: true,
      });
    }
    return { source: value, value: clone };
  } catch (error) {
    if (error instanceof AdmissionFeatureContractError) throw error;
    throw new AdmissionFeatureContractError('invalid_type', field);
  }
}

function leaveRecord(record: EnteredRecord, state: TraversalState): void {
  state.active.delete(record.source);
}

function parseFeatureValue(
  input: unknown,
  field: string,
  state: TraversalState,
): AdmissionFeatureValueV1 {
  const entered = enterRecord(input, field, state, ['availability', 'valuePermille'], ['availability']);
  try {
    const availability = entered.value.availability;
    if (availability === 'unavailable') {
      if (Object.prototype.hasOwnProperty.call(entered.value, 'valuePermille')) {
        throw new AdmissionFeatureContractError('unknown_key', field);
      }
      return Object.freeze({ availability: 'unavailable' });
    }
    if (availability !== 'available') {
      throw new AdmissionFeatureContractError('invalid_enum', `${field}.availability`);
    }
    if (!Object.prototype.hasOwnProperty.call(entered.value, 'valuePermille')) {
      throw new AdmissionFeatureContractError('missing_key', `${field}.valuePermille`);
    }
    const valuePermille = entered.value.valuePermille;
    if (typeof valuePermille !== 'number' || !Number.isFinite(valuePermille)) {
      throw new AdmissionFeatureContractError('invalid_number', `${field}.valuePermille`);
    }
    if (Object.is(valuePermille, -0) || !Number.isSafeInteger(valuePermille)) {
      throw new AdmissionFeatureContractError('noncanonical', `${field}.valuePermille`);
    }
    if (valuePermille < ADMISSION_FEATURE_VALUE_MIN_PERMILLE
      || valuePermille > ADMISSION_FEATURE_VALUE_MAX_PERMILLE) {
      throw new AdmissionFeatureContractError('out_of_bounds', `${field}.valuePermille`);
    }
    return Object.freeze({ availability: 'available', valuePermille });
  } finally {
    leaveRecord(entered, state);
  }
}

function parseExtractor(
  input: unknown,
  state: TraversalState,
): AdmissionFeatureExtractorIdentityV2 {
  const field = 'featureEnvelope.extractor';
  const entered = enterRecord(input, field, state, ['id', 'version'], ['id', 'version']);
  try {
    if (entered.value.id !== ADMISSION_FEATURE_EXTRACTOR_ID_V2) {
      throw new AdmissionFeatureContractError('invalid_identity', `${field}.id`);
    }
    if (entered.value.version !== ADMISSION_FEATURE_EXTRACTOR_VERSION_V2) {
      throw new AdmissionFeatureContractError('invalid_identity', `${field}.version`);
    }
    return Object.freeze({
      id: ADMISSION_FEATURE_EXTRACTOR_ID_V2,
      version: ADMISSION_FEATURE_EXTRACTOR_VERSION_V2,
    });
  } finally {
    leaveRecord(entered, state);
  }
}

function parseDimensions(
  input: unknown,
  state: TraversalState,
): AdmissionFeatureDimensionsV2 {
  const field = 'featureEnvelope.dimensions';
  const entered = enterRecord(input, field, state, ADMISSION_FEATURE_DIMENSIONS_V2, ADMISSION_FEATURE_DIMENSIONS_V2);
  try {
    return Object.freeze({
      durability: parseFeatureValue(entered.value.durability, `${field}.durability`, state),
      evidenceQuality: parseFeatureValue(entered.value.evidenceQuality, `${field}.evidenceQuality`, state),
      sensitivity: parseFeatureValue(entered.value.sensitivity, `${field}.sensitivity`, state),
    });
  } finally {
    leaveRecord(entered, state);
  }
}

export function parseAdmissionFeatureEnvelopeV2(input: unknown): AdmissionFeatureEnvelopeV2 {
  const state: TraversalState = { seen: new WeakSet(), active: new WeakSet() };
  const field = 'featureEnvelope';
  const keys = ['contractId', 'contractVersion', 'extractor', 'dimensions'] as const;
  const entered = enterRecord(input, field, state, keys, keys);
  try {
    if (entered.value.contractId !== ADMISSION_FEATURE_CONTRACT_ID) {
      throw new AdmissionFeatureContractError('invalid_identity', `${field}.contractId`);
    }
    if (entered.value.contractVersion !== ADMISSION_FEATURE_CONTRACT_VERSION_V2) {
      throw new AdmissionFeatureContractError('invalid_identity', `${field}.contractVersion`);
    }
    const extractor = parseExtractor(entered.value.extractor, state);
    const dimensions = parseDimensions(entered.value.dimensions, state);
    return Object.freeze({
      contractId: ADMISSION_FEATURE_CONTRACT_ID,
      contractVersion: ADMISSION_FEATURE_CONTRACT_VERSION_V2,
      extractor,
      dimensions,
    });
  } finally {
    leaveRecord(entered, state);
  }
}

/** Fixed-key JSON representation used only for deterministic evidence identity. */
export function canonicalAdmissionFeatureEnvelopeV2(input: unknown): string {
  return JSON.stringify(parseAdmissionFeatureEnvelopeV2(input));
}

/** Content-free, cross-runtime identity for an already-derived feature envelope. */
export function admissionFeatureEnvelopeIdentityV2(input: unknown): `sha256:${string}` {
  const canonical = canonicalAdmissionFeatureEnvelopeV2(input);
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

export const ADMISSION_FEATURE_PRODUCER_MODE_ENV = 'MEMBERRY_ADMISSION_FEATURE_PRODUCER_V1' as const;

export type AdmissionFeatureProducerModeV1 = 'disabled' | 'live';

export type AdmissionFeatureProducerModeErrorCode =
  | 'invalid_mode'
  | 'prerequisite_unavailable';

/** Closed configuration failures name only the code, never the supplied value. */
export class AdmissionFeatureProducerModeError extends Error {
  constructor(readonly code: AdmissionFeatureProducerModeErrorCode) {
    super(`admission_feature_producer:${code}`);
    this.name = 'AdmissionFeatureProducerModeError';
  }
}

/**
 * Strict staging-flag resolution: exact strings only, no trimming, coercion,
 * aliases, or value reflection. `live` activates the deterministic safe-facts
 * feature producer inside the routing shadow continuation; it requires
 * MEMBERRY_ADMISSION_ROUTING_V1=shadow (enforced in the services factory).
 */
export function resolveAdmissionFeatureProducerModeV1(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AdmissionFeatureProducerModeV1 {
  const raw = env[ADMISSION_FEATURE_PRODUCER_MODE_ENV];
  if (raw === undefined || raw === '' || raw === 'disabled') return 'disabled';
  if (raw === 'live') return 'live';
  throw new AdmissionFeatureProducerModeError('invalid_mode');
}
