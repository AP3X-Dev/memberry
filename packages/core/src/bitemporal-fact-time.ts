import { types as nodeUtilTypes } from 'node:util';

const OBJECT_CREATE = Object.create;
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_PROTOTYPE = Object.prototype;
const ARRAY_IS_ARRAY = Array.isArray;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const NODE_IS_PROXY = nodeUtilTypes.isProxy;
const INTRINSIC_DATE = Date;
const DATE_PARSE = Date.parse;
const DATE_TO_ISO_STRING = Function.prototype.call.bind(Date.prototype.toISOString) as (
  input: Date,
) => string;
const NUMBER_IS_FINITE = Number.isFinite;
const STRING_CHAR_CODE_AT = Function.prototype.call.bind(String.prototype.charCodeAt) as (
  input: string,
  index: number,
) => number;
const REGEXP_EXEC = Function.prototype.call.bind(RegExp.prototype.exec) as (
  pattern: RegExp,
  input: string,
) => RegExpExecArray | null;
const INTRINSIC_ERROR = Error;

export const BITEMPORAL_FACT_TIME_CONTRACT_ID = 'memberry.bitemporal-fact-time' as const;
export const BITEMPORAL_FACT_TIME_CONTRACT_VERSION = '1.0.0' as const;

export interface LegacyFactTimeV1 {
  readonly valid_at: string;
  readonly invalid_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface BitemporalFactTimeV1 {
  readonly contractId: typeof BITEMPORAL_FACT_TIME_CONTRACT_ID;
  readonly contractVersion: typeof BITEMPORAL_FACT_TIME_CONTRACT_VERSION;
  readonly valid_from: string;
  readonly valid_to: string | null;
  readonly recorded_from: string;
  readonly recorded_to: string | null;
}

export interface BitemporalFactTimePointV1 {
  readonly validAt: string;
  readonly recordedAt: string;
}

export type BitemporalFactTimeContractErrorCodeV1 =
  | 'invalid-legacy'
  | 'invalid-bitemporal'
  | 'invalid-point';

export class BitemporalFactTimeContractError extends INTRINSIC_ERROR {
  declare readonly code: BitemporalFactTimeContractErrorCodeV1;

  constructor(code: BitemporalFactTimeContractErrorCodeV1) {
    super(`bitemporal_fact_time_contract:${code}`);
    OBJECT_DEFINE_PROPERTY(this, 'name', {
      value: 'BitemporalFactTimeContractError',
      writable: true,
      enumerable: false,
      configurable: true,
    });
    OBJECT_DEFINE_PROPERTY(this, 'code', {
      value: code,
      writable: false,
      enumerable: true,
      configurable: false,
    });
  }
}

class InvalidValue extends INTRINSIC_ERROR {}

interface ParsedInstant {
  readonly value: string;
  readonly milliseconds: number;
}

const LEGACY_KEYS = OBJECT_FREEZE(['valid_at', 'invalid_at', 'created_at', 'updated_at'] as const);
const BITEMPORAL_KEYS = OBJECT_FREEZE([
  'contractId', 'contractVersion', 'valid_from', 'valid_to', 'recorded_from', 'recorded_to',
] as const);
const POINT_KEYS = OBJECT_FREEZE(['validAt', 'recordedAt'] as const);
const CANONICAL_INSTANT = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

function containsKey(keys: readonly string[], key: string): boolean {
  for (let index = 0; index < keys.length; index += 1) {
    if (keys[index] === key) return true;
  }
  return false;
}

function exactRecord(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof input !== 'object'
    || input === null
    || NODE_IS_PROXY(input)
    || ARRAY_IS_ARRAY(input)) throw new InvalidValue();
  const prototype = OBJECT_GET_PROTOTYPE_OF(input);
  if (prototype !== OBJECT_PROTOTYPE && prototype !== null) throw new InvalidValue();
  const ownKeys = REFLECT_OWN_KEYS(input);
  if (ownKeys.length !== keys.length) throw new InvalidValue();
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index]!;
    if (typeof key !== 'string' || !containsKey(keys, key)) throw new InvalidValue();
  }
  const snapshot = OBJECT_CREATE(null) as Record<string, unknown>;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(input, key);
    if (descriptor === undefined
      || !OBJECT_HAS_OWN(descriptor, 'value')
      || descriptor.enumerable !== true) throw new InvalidValue();
    OBJECT_DEFINE_PROPERTY(snapshot, key, {
      value: descriptor.value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return snapshot;
}

function canonicalInstant(input: unknown): ParsedInstant {
  if (typeof input !== 'string' || input.length !== 24) throw new InvalidValue();
  for (let index = 0; index < input.length; index += 1) {
    const code = STRING_CHAR_CODE_AT(input, index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < input.length ? STRING_CHAR_CODE_AT(input, index + 1) : -1;
      if (next < 0xdc00 || next > 0xdfff) throw new InvalidValue();
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new InvalidValue();
    }
  }
  if (REGEXP_EXEC(CANONICAL_INSTANT, input) === null) throw new InvalidValue();
  const milliseconds = DATE_PARSE(input);
  if (!NUMBER_IS_FINITE(milliseconds)) throw new InvalidValue();
  const canonical = DATE_TO_ISO_STRING(new INTRINSIC_DATE(milliseconds));
  if (canonical !== input) throw new InvalidValue();
  return { value: input, milliseconds };
}

function nullableInstant(input: unknown): ParsedInstant | null {
  return input === null ? null : canonicalInstant(input);
}

function requireStrictInterval(start: ParsedInstant, end: ParsedInstant | null): void {
  if (end !== null && end.milliseconds <= start.milliseconds) throw new InvalidValue();
}

function defineField(record: Record<string, unknown>, key: string, value: unknown): void {
  OBJECT_DEFINE_PROPERTY(record, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function frozenLegacy(
  validAt: string,
  invalidAt: string | null,
  createdAt: string,
  updatedAt: string,
): LegacyFactTimeV1 {
  const result = OBJECT_CREATE(null) as Record<string, unknown>;
  defineField(result, 'valid_at', validAt);
  defineField(result, 'invalid_at', invalidAt);
  defineField(result, 'created_at', createdAt);
  defineField(result, 'updated_at', updatedAt);
  return OBJECT_FREEZE(result) as unknown as LegacyFactTimeV1;
}

function frozenBitemporal(
  validFrom: string,
  validTo: string | null,
  recordedFrom: string,
  recordedTo: string | null,
): BitemporalFactTimeV1 {
  const result = OBJECT_CREATE(null) as Record<string, unknown>;
  defineField(result, 'contractId', BITEMPORAL_FACT_TIME_CONTRACT_ID);
  defineField(result, 'contractVersion', BITEMPORAL_FACT_TIME_CONTRACT_VERSION);
  defineField(result, 'valid_from', validFrom);
  defineField(result, 'valid_to', validTo);
  defineField(result, 'recorded_from', recordedFrom);
  defineField(result, 'recorded_to', recordedTo);
  return OBJECT_FREEZE(result) as unknown as BitemporalFactTimeV1;
}

function parseLegacy(input: unknown): LegacyFactTimeV1 {
  const snapshot = exactRecord(input, LEGACY_KEYS);
  const validAt = canonicalInstant(snapshot.valid_at);
  const invalidAt = nullableInstant(snapshot.invalid_at);
  const createdAt = canonicalInstant(snapshot.created_at);
  const updatedAt = canonicalInstant(snapshot.updated_at);
  requireStrictInterval(validAt, invalidAt);
  if (updatedAt.milliseconds < createdAt.milliseconds) throw new InvalidValue();
  return frozenLegacy(validAt.value, invalidAt?.value ?? null, createdAt.value, updatedAt.value);
}

function parseBitemporal(input: unknown): BitemporalFactTimeV1 {
  const snapshot = exactRecord(input, BITEMPORAL_KEYS);
  if (snapshot.contractId !== BITEMPORAL_FACT_TIME_CONTRACT_ID
    || snapshot.contractVersion !== BITEMPORAL_FACT_TIME_CONTRACT_VERSION) throw new InvalidValue();
  const validFrom = canonicalInstant(snapshot.valid_from);
  const validTo = nullableInstant(snapshot.valid_to);
  const recordedFrom = canonicalInstant(snapshot.recorded_from);
  const recordedTo = nullableInstant(snapshot.recorded_to);
  requireStrictInterval(validFrom, validTo);
  requireStrictInterval(recordedFrom, recordedTo);
  return frozenBitemporal(
    validFrom.value,
    validTo?.value ?? null,
    recordedFrom.value,
    recordedTo?.value ?? null,
  );
}

function parsePoint(input: unknown): BitemporalFactTimePointV1 {
  const snapshot = exactRecord(input, POINT_KEYS);
  const validAt = canonicalInstant(snapshot.validAt);
  const recordedAt = canonicalInstant(snapshot.recordedAt);
  const result = OBJECT_CREATE(null) as Record<string, unknown>;
  defineField(result, 'validAt', validAt.value);
  defineField(result, 'recordedAt', recordedAt.value);
  return OBJECT_FREEZE(result) as unknown as BitemporalFactTimePointV1;
}

export function parseLegacyFactTimeV1(input: unknown): LegacyFactTimeV1 {
  try {
    return parseLegacy(input);
  } catch {
    throw new BitemporalFactTimeContractError('invalid-legacy');
  }
}

export function migrateLegacyFactTimeV1(input: unknown): BitemporalFactTimeV1 {
  const parsed = parseLegacyFactTimeV1(input);
  return frozenBitemporal(parsed.valid_at, parsed.invalid_at, parsed.created_at, null);
}

export function parseBitemporalFactTimeV1(input: unknown): BitemporalFactTimeV1 {
  try {
    return parseBitemporal(input);
  } catch {
    throw new BitemporalFactTimeContractError('invalid-bitemporal');
  }
}

export function emitBitemporalFactTimeV1(input: unknown): BitemporalFactTimeV1 {
  return parseBitemporalFactTimeV1(input);
}

function parseVisibilityPoint(input: unknown): BitemporalFactTimePointV1 {
  try {
    return parsePoint(input);
  } catch {
    throw new BitemporalFactTimeContractError('invalid-point');
  }
}

function containsInstant(start: string, end: string | null, point: string): boolean {
  const startMilliseconds = DATE_PARSE(start);
  const pointMilliseconds = DATE_PARSE(point);
  return pointMilliseconds >= startMilliseconds
    && (end === null || pointMilliseconds < DATE_PARSE(end));
}

export function isBitemporalFactVisibleV1(input: unknown, point: unknown): boolean {
  const parsed = parseBitemporalFactTimeV1(input);
  const parsedPoint = parseVisibilityPoint(point);
  return containsInstant(parsed.valid_from, parsed.valid_to, parsedPoint.validAt)
    && containsInstant(parsed.recorded_from, parsed.recorded_to, parsedPoint.recordedAt);
}
