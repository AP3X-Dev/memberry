import { createHash } from 'node:crypto';
import { types as nodeUtilTypes } from 'node:util';

export const ADMISSION_FEATURE_CONTRACT_ID = 'memberry.admission-feature-envelope' as const;
export const ADMISSION_FEATURE_CONTRACT_VERSION = '1.0.0' as const;
export const ADMISSION_FEATURE_EXTRACTOR_ID = 'memberry.precomputed-feature-signals' as const;
export const ADMISSION_FEATURE_EXTRACTOR_VERSION = '1.0.0' as const;
export const ADMISSION_FEATURE_VALUE_MIN_PERMILLE = 0 as const;
export const ADMISSION_FEATURE_VALUE_MAX_PERMILLE = 1_000 as const;

export const ADMISSION_FEATURE_DIMENSIONS = [
  'salience',
  'novelty',
  'durability',
  'evidenceQuality',
  'scopeConfidence',
  'sensitivity',
] as const;

export type AdmissionFeatureDimension = (typeof ADMISSION_FEATURE_DIMENSIONS)[number];

export interface AdmissionFeatureAvailableV1 {
  readonly availability: 'available';
  /** Integer thousandths on the closed 0..1000 grid. Floats are forbidden. */
  readonly valuePermille: number;
}

export interface AdmissionFeatureUnavailableV1 {
  readonly availability: 'unavailable';
}

export type AdmissionFeatureValueV1 = AdmissionFeatureAvailableV1 | AdmissionFeatureUnavailableV1;

export type AdmissionFeatureDimensionsV1 = Readonly<Record<AdmissionFeatureDimension, AdmissionFeatureValueV1>>;

export interface AdmissionFeatureExtractorIdentityV1 {
  readonly id: typeof ADMISSION_FEATURE_EXTRACTOR_ID;
  readonly version: typeof ADMISSION_FEATURE_EXTRACTOR_VERSION;
}

/**
 * A content-free feature envelope. It intentionally has no extension bag:
 * raw task/content, identifiers, credentials, and arbitrary metadata cannot be
 * represented by this contract.
 */
export interface AdmissionFeatureEnvelopeV1 {
  readonly contractId: typeof ADMISSION_FEATURE_CONTRACT_ID;
  readonly contractVersion: typeof ADMISSION_FEATURE_CONTRACT_VERSION;
  readonly extractor: AdmissionFeatureExtractorIdentityV1;
  readonly dimensions: AdmissionFeatureDimensionsV1;
}

export type AdmissionFeatureContractErrorCode =
  | 'not_object'
  | 'invalid_type'
  | 'unknown_key'
  | 'missing_key'
  | 'invalid_identity'
  | 'invalid_enum'
  | 'invalid_number'
  | 'out_of_bounds'
  | 'noncanonical'
  | 'shared_reference'
  | 'cyclic_reference';

/** Failures expose only closed schema paths and codes, never supplied values. */
export class AdmissionFeatureContractError extends Error {
  constructor(
    readonly code: AdmissionFeatureContractErrorCode,
    readonly field: string,
  ) {
    super(`admission_feature_contract:${code}:${field}`);
    this.name = 'AdmissionFeatureContractError';
  }
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
): AdmissionFeatureExtractorIdentityV1 {
  const field = 'featureEnvelope.extractor';
  const entered = enterRecord(input, field, state, ['id', 'version'], ['id', 'version']);
  try {
    if (entered.value.id !== ADMISSION_FEATURE_EXTRACTOR_ID) {
      throw new AdmissionFeatureContractError('invalid_identity', `${field}.id`);
    }
    if (entered.value.version !== ADMISSION_FEATURE_EXTRACTOR_VERSION) {
      throw new AdmissionFeatureContractError('invalid_identity', `${field}.version`);
    }
    return Object.freeze({
      id: ADMISSION_FEATURE_EXTRACTOR_ID,
      version: ADMISSION_FEATURE_EXTRACTOR_VERSION,
    });
  } finally {
    leaveRecord(entered, state);
  }
}

function parseDimensions(
  input: unknown,
  state: TraversalState,
): AdmissionFeatureDimensionsV1 {
  const field = 'featureEnvelope.dimensions';
  const entered = enterRecord(input, field, state, ADMISSION_FEATURE_DIMENSIONS, ADMISSION_FEATURE_DIMENSIONS);
  try {
    return Object.freeze({
      salience: parseFeatureValue(entered.value.salience, `${field}.salience`, state),
      novelty: parseFeatureValue(entered.value.novelty, `${field}.novelty`, state),
      durability: parseFeatureValue(entered.value.durability, `${field}.durability`, state),
      evidenceQuality: parseFeatureValue(entered.value.evidenceQuality, `${field}.evidenceQuality`, state),
      scopeConfidence: parseFeatureValue(entered.value.scopeConfidence, `${field}.scopeConfidence`, state),
      sensitivity: parseFeatureValue(entered.value.sensitivity, `${field}.sensitivity`, state),
    });
  } finally {
    leaveRecord(entered, state);
  }
}

export function parseAdmissionFeatureEnvelopeV1(input: unknown): AdmissionFeatureEnvelopeV1 {
  const state: TraversalState = { seen: new WeakSet(), active: new WeakSet() };
  const field = 'featureEnvelope';
  const keys = ['contractId', 'contractVersion', 'extractor', 'dimensions'] as const;
  const entered = enterRecord(input, field, state, keys, keys);
  try {
    if (entered.value.contractId !== ADMISSION_FEATURE_CONTRACT_ID) {
      throw new AdmissionFeatureContractError('invalid_identity', `${field}.contractId`);
    }
    if (entered.value.contractVersion !== ADMISSION_FEATURE_CONTRACT_VERSION) {
      throw new AdmissionFeatureContractError('invalid_identity', `${field}.contractVersion`);
    }
    const extractor = parseExtractor(entered.value.extractor, state);
    const dimensions = parseDimensions(entered.value.dimensions, state);
    return Object.freeze({
      contractId: ADMISSION_FEATURE_CONTRACT_ID,
      contractVersion: ADMISSION_FEATURE_CONTRACT_VERSION,
      extractor,
      dimensions,
    });
  } finally {
    leaveRecord(entered, state);
  }
}

/** Fixed-key JSON representation used only for deterministic evidence identity. */
export function canonicalAdmissionFeatureEnvelopeV1(input: unknown): string {
  return JSON.stringify(parseAdmissionFeatureEnvelopeV1(input));
}

/** Content-free, cross-runtime identity for an already-derived feature envelope. */
export function admissionFeatureEnvelopeIdentityV1(input: unknown): `sha256:${string}` {
  const canonical = canonicalAdmissionFeatureEnvelopeV1(input);
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}
