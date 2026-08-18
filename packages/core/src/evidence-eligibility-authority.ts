import { Buffer as NodeBuffer } from 'node:buffer';
import { types as nodeUtilTypes } from 'node:util';

const OBJECT_CREATE = Object.create;
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_PROTOTYPE = Object.prototype;
const ARRAY = Array;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_PROTOTYPE = Array.prototype;
const ARRAY_BUFFER_IS_VIEW = ArrayBuffer.isView;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const NODE_IS_PROXY = nodeUtilTypes.isProxy;
const BUFFER_BYTE_LENGTH = NodeBuffer.byteLength;
const INTRINSIC_STRING = String;
const STRING_CHAR_CODE_AT = Function.prototype.call.bind(String.prototype.charCodeAt) as (
  input: string,
  index: number,
) => number;
const REGEXP_EXEC = Function.prototype.call.bind(RegExp.prototype.exec) as (
  pattern: RegExp,
  input: string,
) => RegExpExecArray | null;
const INTRINSIC_DATE = Date;
const DATE_PARSE = Date.parse;
const DATE_TO_ISO_STRING = Function.prototype.call.bind(Date.prototype.toISOString) as (
  input: Date,
) => string;
const NUMBER_IS_FINITE = Number.isFinite;
const INTRINSIC_WEAK_SET = WeakSet;
const WEAK_SET_HAS = Function.prototype.call.bind(WeakSet.prototype.has) as (
  set: WeakSet<object>,
  value: object,
) => boolean;
const WEAK_SET_ADD = Function.prototype.call.bind(WeakSet.prototype.add) as (
  set: WeakSet<object>,
  value: object,
) => WeakSet<object>;
const INTRINSIC_ERROR = Error;

export const EVIDENCE_ELIGIBILITY_AUTHORITY_CONTRACT_ID =
  'memberry.evidence-eligibility-authority' as const;
export const EVIDENCE_ELIGIBILITY_AUTHORITY_CONTRACT_VERSION = '1.0.0' as const;
export const EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_CANDIDATES = 128 as const;
export const EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_AGGREGATE_STRING_BYTES = 32_768 as const;
export const EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_TENANT_ID_BYTES = 128 as const;
export const EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_PROJECT_SCOPE_BYTES = 136 as const;
export const EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_ENTITY_ID_BYTES = 200 as const;
export const EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_REF_BYTES = 64 as const;
export const EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_EVIDENCE_ID_BYTES = 200 as const;
export const EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_PROVENANCE_REF_BYTES = 200 as const;

const MAX_TEMPORAL_VALUE_BYTES = 32;
const MAX_LITERAL_BYTES = 64;

const SAFE_TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CANONICAL_PROJECT_SCOPE = /^project:[a-z0-9][a-z0-9._-]*$/;
const SAFE_ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/;
const SAFE_EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/;
const SAFE_PROVENANCE_REF = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/;
const CANONICAL_INSTANT = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

export type EvidenceEligibilityAuthoritySourceTypeV1 = 'semantic' | 'fact' | 'arch_entity';

export type EvidenceEligibilityAuthoritySourcePolicyV1 =
  | 'semantic-current-adjudicated-v1'
  | 'fact-current-source-owned-v1'
  | 'arch-current-closed-world-v1';

export type EvidenceEligibilityAuthorityTemporalFrameV1 =
  | { readonly mode: 'current' }
  | { readonly mode: 'as-of'; readonly asOf: string };

export interface EvidenceEligibilityAuthorityRecordTimeV1 {
  readonly mode: 'current';
}

export interface EvidenceEligibilityAuthorityDescriptorV1 {
  readonly ref: string;
  readonly sourceType: EvidenceEligibilityAuthoritySourceTypeV1;
  readonly evidenceId: string;
}

export interface EvidenceEligibilityAuthorityRequestV1 {
  readonly contractId: typeof EVIDENCE_ELIGIBILITY_AUTHORITY_CONTRACT_ID;
  readonly contractVersion: typeof EVIDENCE_ELIGIBILITY_AUTHORITY_CONTRACT_VERSION;
  readonly tenantId: string;
  readonly projectScope: string;
  readonly resolvedEntityId: string;
  readonly temporalFrame: EvidenceEligibilityAuthorityTemporalFrameV1;
  readonly recordTime: EvidenceEligibilityAuthorityRecordTimeV1;
  readonly candidates: readonly EvidenceEligibilityAuthorityDescriptorV1[];
}

export interface EvidenceEligibilityAuthorityProvenanceV1 {
  readonly policy: EvidenceEligibilityAuthoritySourcePolicyV1;
  readonly ref: string;
}

export interface EvidenceEligibilityAuthorityReceiptV1
  extends EvidenceEligibilityAuthorityDescriptorV1 {
  readonly lifecycle: 'active' | 'inactive';
  readonly temporal: 'in-frame' | 'out-of-frame';
  readonly supersession: 'clear' | 'superseded';
  readonly contradiction: 'clear' | 'withheld';
  readonly provenance: EvidenceEligibilityAuthorityProvenanceV1;
}

export type EvidenceEligibilityAuthorityUnsupportedCodeV1 =
  | 'source-policy-unavailable'
  | 'temporal-history-unavailable'
  | 'adjudication-pending'
  | 'adjudication-coverage-gap'
  | 'record-time-unavailable';

interface EvidenceEligibilityAuthorityAuthorityEchoV1 {
  readonly contractId: typeof EVIDENCE_ELIGIBILITY_AUTHORITY_CONTRACT_ID;
  readonly contractVersion: typeof EVIDENCE_ELIGIBILITY_AUTHORITY_CONTRACT_VERSION;
  readonly tenantId: string;
  readonly projectScope: string;
  readonly resolvedEntityId: string;
  readonly temporalFrame: EvidenceEligibilityAuthorityTemporalFrameV1;
  readonly recordTime: EvidenceEligibilityAuthorityRecordTimeV1;
}

export interface EvidenceEligibilityAuthoritySupportedResultV1
  extends EvidenceEligibilityAuthorityAuthorityEchoV1 {
  readonly outcome: 'supported';
  readonly recordedAt: string;
  readonly receipts: readonly EvidenceEligibilityAuthorityReceiptV1[];
}

export interface EvidenceEligibilityAuthorityUnsupportedResultV1
  extends EvidenceEligibilityAuthorityAuthorityEchoV1 {
  readonly outcome: 'unsupported';
  readonly code: EvidenceEligibilityAuthorityUnsupportedCodeV1;
}

export type EvidenceEligibilityAuthorityResultV1 =
  | EvidenceEligibilityAuthoritySupportedResultV1
  | EvidenceEligibilityAuthorityUnsupportedResultV1;

export type EvidenceEligibilityAuthorityContractErrorCodeV1 =
  | 'invalid-request'
  | 'invalid-result'
  | 'budget-exceeded';

export class EvidenceEligibilityAuthorityContractError extends INTRINSIC_ERROR {
  declare readonly code: EvidenceEligibilityAuthorityContractErrorCodeV1;

  constructor(code: EvidenceEligibilityAuthorityContractErrorCodeV1) {
    super(`evidence_eligibility_authority_contract:${code}`);
    OBJECT_DEFINE_PROPERTY(this, 'name', {
      value: 'EvidenceEligibilityAuthorityContractError',
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
class BudgetExceeded extends INTRINSIC_ERROR {}

interface ParseState {
  readonly seen: WeakSet<object>;
  stringBytes: number;
}

interface EnteredRecord {
  readonly snapshot: Record<string, unknown>;
  readonly keyCount: number;
}

const REQUEST_KEYS = OBJECT_FREEZE([
  'contractId',
  'contractVersion',
  'tenantId',
  'projectScope',
  'resolvedEntityId',
  'temporalFrame',
  'recordTime',
  'candidates',
] as const);
const DESCRIPTOR_KEYS = OBJECT_FREEZE(['ref', 'sourceType', 'evidenceId'] as const);
const TEMPORAL_KEYS = OBJECT_FREEZE(['mode', 'asOf'] as const);
const CURRENT_TEMPORAL_KEYS = OBJECT_FREEZE(['mode'] as const);
const AS_OF_TEMPORAL_KEYS = OBJECT_FREEZE(['mode', 'asOf'] as const);
const RECORD_TIME_KEYS = OBJECT_FREEZE(['mode'] as const);
const SUPPORTED_RESULT_KEYS = OBJECT_FREEZE([
  'contractId',
  'contractVersion',
  'outcome',
  'tenantId',
  'projectScope',
  'resolvedEntityId',
  'temporalFrame',
  'recordTime',
  'recordedAt',
  'receipts',
] as const);
const UNSUPPORTED_RESULT_KEYS = OBJECT_FREEZE([
  'contractId',
  'contractVersion',
  'outcome',
  'tenantId',
  'projectScope',
  'resolvedEntityId',
  'temporalFrame',
  'recordTime',
  'code',
] as const);
const RECEIPT_KEYS = OBJECT_FREEZE([
  'ref',
  'sourceType',
  'evidenceId',
  'lifecycle',
  'temporal',
  'supersession',
  'contradiction',
  'provenance',
] as const);
const PROVENANCE_KEYS = OBJECT_FREEZE(['policy', 'ref'] as const);

const ARRAY_INDEX_KEYS = new ARRAY<string>(EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_CANDIDATES);
for (let index = 0; index < ARRAY_INDEX_KEYS.length; index += 1) {
  OBJECT_DEFINE_PROPERTY(ARRAY_INDEX_KEYS, index, {
    value: INTRINSIC_STRING(index),
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
OBJECT_FREEZE(ARRAY_INDEX_KEYS);

function freshState(): ParseState {
  return { seen: new INTRINSIC_WEAK_SET<object>(), stringBytes: 0 };
}

function isPrivateError(error: unknown, prototype: object): boolean {
  return typeof error === 'object'
    && error !== null
    && !NODE_IS_PROXY(error)
    && OBJECT_GET_PROTOTYPE_OF(error) === prototype;
}

function containsKey(keys: readonly string[], key: string): boolean {
  for (let index = 0; index < keys.length; index += 1) {
    if (keys[index] === key) return true;
  }
  return false;
}

function defineField(record: Record<string, unknown>, key: string, value: unknown): void {
  OBJECT_DEFINE_PROPERTY(record, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function defineArrayItem<T>(target: T[], index: number, value: T): void {
  OBJECT_DEFINE_PROPERTY(target, ARRAY_INDEX_KEYS[index]!, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function nullRecord<T extends object>(fields: T): Readonly<T> {
  const output = OBJECT_CREATE(null) as Record<string, unknown>;
  const keys = REFLECT_OWN_KEYS(fields);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    if (typeof key !== 'string') throw new InvalidValue();
    const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(fields, key);
    if (descriptor === undefined || !OBJECT_HAS_OWN(descriptor, 'value')) throw new InvalidValue();
    defineField(output, key, descriptor.value);
  }
  return OBJECT_FREEZE(output) as Readonly<T>;
}

function enterRecord(
  input: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  state: ParseState,
): EnteredRecord {
  try {
    if (typeof input !== 'object'
      || input === null
      || NODE_IS_PROXY(input)
      || ARRAY_IS_ARRAY(input)
      || ARRAY_BUFFER_IS_VIEW(input)) throw new InvalidValue();
    const prototype = OBJECT_GET_PROTOTYPE_OF(input);
    if (prototype !== OBJECT_PROTOTYPE && prototype !== null) throw new InvalidValue();
    if (WEAK_SET_HAS(state.seen, input)) throw new InvalidValue();
    WEAK_SET_ADD(state.seen, input);
    const keys = REFLECT_OWN_KEYS(input);
    if (keys.length < requiredKeys.length || keys.length > allowedKeys.length) {
      throw new InvalidValue();
    }
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!;
      if (typeof key !== 'string' || !containsKey(allowedKeys, key)) throw new InvalidValue();
    }
    const snapshot = OBJECT_CREATE(null) as Record<string, unknown>;
    for (let index = 0; index < allowedKeys.length; index += 1) {
      const key = allowedKeys[index]!;
      const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(input, key);
      if (descriptor === undefined) continue;
      if (!OBJECT_HAS_OWN(descriptor, 'value') || descriptor.enumerable !== true) {
        throw new InvalidValue();
      }
      defineField(snapshot, key, descriptor.value);
    }
    for (let index = 0; index < requiredKeys.length; index += 1) {
      if (!OBJECT_HAS_OWN(snapshot, requiredKeys[index]!)) throw new InvalidValue();
    }
    return { snapshot, keyCount: keys.length };
  } catch (error) {
    if (isPrivateError(error, InvalidValue.prototype)) throw error;
    throw new InvalidValue();
  }
}

function requireExactVariant(entered: EnteredRecord, keys: readonly string[]): void {
  if (entered.keyCount !== keys.length) throw new InvalidValue();
  for (let index = 0; index < keys.length; index += 1) {
    if (!OBJECT_HAS_OWN(entered.snapshot, keys[index]!)) throw new InvalidValue();
  }
}

function denseArray(input: unknown, state: ParseState): readonly unknown[] {
  try {
    if (typeof input !== 'object'
      || input === null
      || NODE_IS_PROXY(input)
      || !ARRAY_IS_ARRAY(input)
      || ARRAY_BUFFER_IS_VIEW(input)) throw new InvalidValue();
    const prototype = OBJECT_GET_PROTOTYPE_OF(input);
    if (prototype !== ARRAY_PROTOTYPE && prototype !== null) throw new InvalidValue();
    if (WEAK_SET_HAS(state.seen, input)) throw new InvalidValue();
    WEAK_SET_ADD(state.seen, input);
    const lengthDescriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(input, 'length');
    if (lengthDescriptor === undefined
      || !OBJECT_HAS_OWN(lengthDescriptor, 'value')
      || !NUMBER_IS_SAFE_INTEGER(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || lengthDescriptor.enumerable !== false
      || lengthDescriptor.configurable !== false) throw new InvalidValue();
    const length = lengthDescriptor.value as number;
    if (length > EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_CANDIDATES) throw new BudgetExceeded();
    const keys = REFLECT_OWN_KEYS(input);
    if (keys.length !== length + 1) throw new InvalidValue();
    const output = new ARRAY<unknown>(length);
    for (let index = 0; index < length; index += 1) {
      const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(input, ARRAY_INDEX_KEYS[index]!);
      if (descriptor === undefined
        || !OBJECT_HAS_OWN(descriptor, 'value')
        || descriptor.enumerable !== true) throw new InvalidValue();
      defineArrayItem(output, index, descriptor.value);
    }
    return OBJECT_FREEZE(output);
  } catch (error) {
    if (isPrivateError(error, InvalidValue.prototype)
      || isPrivateError(error, BudgetExceeded.prototype)) throw error;
    throw new InvalidValue();
  }
}

function validUnicode(input: string): boolean {
  for (let index = 0; index < input.length; index += 1) {
    const code = STRING_CHAR_CODE_AT(input, index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < input.length ? STRING_CHAR_CODE_AT(input, index + 1) : -1;
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function boundedString(
  input: unknown,
  maxBytes: number,
  state: ParseState,
  pattern?: RegExp,
): string {
  if (typeof input !== 'string' || input.length === 0) throw new InvalidValue();
  if (input.length > maxBytes) throw new BudgetExceeded();
  if (!validUnicode(input)) throw new InvalidValue();
  const bytes = BUFFER_BYTE_LENGTH(input, 'utf8');
  if (bytes > maxBytes) throw new BudgetExceeded();
  if (pattern !== undefined && REGEXP_EXEC(pattern, input) === null) throw new InvalidValue();
  state.stringBytes += bytes;
  if (state.stringBytes > EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_AGGREGATE_STRING_BYTES) {
    throw new BudgetExceeded();
  }
  return input;
}

function literal<T extends string>(
  input: unknown,
  values: readonly T[],
  state: ParseState,
): T {
  const value = boundedString(input, MAX_LITERAL_BYTES, state);
  for (let index = 0; index < values.length; index += 1) {
    if (value === values[index]) return values[index]!;
  }
  throw new InvalidValue();
}

function canonicalInstant(input: unknown, state: ParseState): string {
  const value = boundedString(input, MAX_TEMPORAL_VALUE_BYTES, state);
  if (value.length !== 24 || REGEXP_EXEC(CANONICAL_INSTANT, value) === null) {
    throw new InvalidValue();
  }
  const milliseconds = DATE_PARSE(value);
  if (!NUMBER_IS_FINITE(milliseconds)) throw new InvalidValue();
  const canonical = DATE_TO_ISO_STRING(new INTRINSIC_DATE(milliseconds));
  if (canonical !== value) throw new InvalidValue();
  return value;
}

function temporalFrame(
  input: unknown,
  state: ParseState,
): EvidenceEligibilityAuthorityTemporalFrameV1 {
  const entered = enterRecord(input, TEMPORAL_KEYS, CURRENT_TEMPORAL_KEYS, state);
  const mode = literal(entered.snapshot.mode, ['current', 'as-of'] as const, state);
  if (mode === 'current') {
    requireExactVariant(entered, CURRENT_TEMPORAL_KEYS);
    return nullRecord({ mode });
  }
  requireExactVariant(entered, AS_OF_TEMPORAL_KEYS);
  return nullRecord({ mode, asOf: canonicalInstant(entered.snapshot.asOf, state) });
}

function recordTime(
  input: unknown,
  state: ParseState,
): EvidenceEligibilityAuthorityRecordTimeV1 {
  const entered = enterRecord(input, RECORD_TIME_KEYS, RECORD_TIME_KEYS, state);
  const mode = literal(entered.snapshot.mode, ['current'] as const, state);
  return nullRecord({ mode });
}

function sourceType(
  input: unknown,
  state: ParseState,
): EvidenceEligibilityAuthoritySourceTypeV1 {
  return literal(input, ['semantic', 'fact', 'arch_entity'] as const, state);
}

function descriptorValue(
  input: unknown,
  state: ParseState,
): EvidenceEligibilityAuthorityDescriptorV1 {
  const entered = enterRecord(input, DESCRIPTOR_KEYS, DESCRIPTOR_KEYS, state);
  return nullRecord({
    ref: boundedString(
      entered.snapshot.ref,
      EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_REF_BYTES,
      state,
      SAFE_REF,
    ),
    sourceType: sourceType(entered.snapshot.sourceType, state),
    evidenceId: boundedString(
      entered.snapshot.evidenceId,
      EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_EVIDENCE_ID_BYTES,
      state,
      SAFE_EVIDENCE_ID,
    ),
  });
}

function sameDescriptor(
  left: EvidenceEligibilityAuthorityDescriptorV1,
  right: EvidenceEligibilityAuthorityDescriptorV1,
): boolean {
  return left.ref === right.ref
    && left.sourceType === right.sourceType
    && left.evidenceId === right.evidenceId;
}

function descriptorArray(
  input: unknown,
  state: ParseState,
): readonly EvidenceEligibilityAuthorityDescriptorV1[] {
  const raw = denseArray(input, state);
  const output = new ARRAY<EvidenceEligibilityAuthorityDescriptorV1>(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    const parsed = descriptorValue(raw[index], state);
    for (let prior = 0; prior < index; prior += 1) {
      const earlier = output[prior]!;
      if (parsed.ref === earlier.ref
        || (parsed.sourceType === earlier.sourceType && parsed.evidenceId === earlier.evidenceId)) {
        throw new InvalidValue();
      }
    }
    defineArrayItem(output, index, parsed);
  }
  return OBJECT_FREEZE(output);
}

function parseRequest(input: unknown): EvidenceEligibilityAuthorityRequestV1 {
  const state = freshState();
  const entered = enterRecord(input, REQUEST_KEYS, REQUEST_KEYS, state);
  const contractId = literal(
    entered.snapshot.contractId,
    [EVIDENCE_ELIGIBILITY_AUTHORITY_CONTRACT_ID] as const,
    state,
  );
  const contractVersion = literal(
    entered.snapshot.contractVersion,
    [EVIDENCE_ELIGIBILITY_AUTHORITY_CONTRACT_VERSION] as const,
    state,
  );
  return nullRecord({
    contractId,
    contractVersion,
    tenantId: boundedString(
      entered.snapshot.tenantId,
      EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_TENANT_ID_BYTES,
      state,
      SAFE_TENANT_ID,
    ),
    projectScope: boundedString(
      entered.snapshot.projectScope,
      EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_PROJECT_SCOPE_BYTES,
      state,
      CANONICAL_PROJECT_SCOPE,
    ),
    resolvedEntityId: boundedString(
      entered.snapshot.resolvedEntityId,
      EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_ENTITY_ID_BYTES,
      state,
      SAFE_ENTITY_ID,
    ),
    temporalFrame: temporalFrame(entered.snapshot.temporalFrame, state),
    recordTime: recordTime(entered.snapshot.recordTime, state),
    candidates: descriptorArray(entered.snapshot.candidates, state),
  });
}

function sameTemporalFrame(
  left: EvidenceEligibilityAuthorityTemporalFrameV1,
  right: EvidenceEligibilityAuthorityTemporalFrameV1,
): boolean {
  return left.mode === right.mode
    && (left.mode === 'current' || (right.mode === 'as-of' && left.asOf === right.asOf));
}

function requireAuthorityEcho(
  entered: EnteredRecord,
  request: EvidenceEligibilityAuthorityRequestV1,
  state: ParseState,
): EvidenceEligibilityAuthorityAuthorityEchoV1 {
  const contractId = literal(
    entered.snapshot.contractId,
    [EVIDENCE_ELIGIBILITY_AUTHORITY_CONTRACT_ID] as const,
    state,
  );
  const contractVersion = literal(
    entered.snapshot.contractVersion,
    [EVIDENCE_ELIGIBILITY_AUTHORITY_CONTRACT_VERSION] as const,
    state,
  );
  const tenantId = boundedString(
    entered.snapshot.tenantId,
    EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_TENANT_ID_BYTES,
    state,
    SAFE_TENANT_ID,
  );
  const projectScope = boundedString(
    entered.snapshot.projectScope,
    EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_PROJECT_SCOPE_BYTES,
    state,
    CANONICAL_PROJECT_SCOPE,
  );
  const resolvedEntityId = boundedString(
    entered.snapshot.resolvedEntityId,
    EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_ENTITY_ID_BYTES,
    state,
    SAFE_ENTITY_ID,
  );
  const parsedTemporalFrame = temporalFrame(entered.snapshot.temporalFrame, state);
  const parsedRecordTime = recordTime(entered.snapshot.recordTime, state);
  if (tenantId !== request.tenantId
    || projectScope !== request.projectScope
    || resolvedEntityId !== request.resolvedEntityId
    || !sameTemporalFrame(parsedTemporalFrame, request.temporalFrame)
    || parsedRecordTime.mode !== request.recordTime.mode) throw new InvalidValue();
  return nullRecord({
    contractId,
    contractVersion,
    tenantId,
    projectScope,
    resolvedEntityId,
    temporalFrame: parsedTemporalFrame,
    recordTime: parsedRecordTime,
  });
}

function expectedPolicy(
  value: EvidenceEligibilityAuthoritySourceTypeV1,
): EvidenceEligibilityAuthoritySourcePolicyV1 {
  switch (value) {
    case 'semantic': return 'semantic-current-adjudicated-v1';
    case 'fact': return 'fact-current-source-owned-v1';
    case 'arch_entity': return 'arch-current-closed-world-v1';
  }
}

function provenanceValue(
  input: unknown,
  expectedSource: EvidenceEligibilityAuthoritySourceTypeV1,
  state: ParseState,
): EvidenceEligibilityAuthorityProvenanceV1 {
  const entered = enterRecord(input, PROVENANCE_KEYS, PROVENANCE_KEYS, state);
  const policy = literal(entered.snapshot.policy, [expectedPolicy(expectedSource)] as const, state);
  const ref = boundedString(
    entered.snapshot.ref,
    EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_PROVENANCE_REF_BYTES,
    state,
    SAFE_PROVENANCE_REF,
  );
  return nullRecord({ policy, ref });
}

function receiptValue(
  input: unknown,
  expected: EvidenceEligibilityAuthorityDescriptorV1,
  state: ParseState,
): EvidenceEligibilityAuthorityReceiptV1 {
  const entered = enterRecord(input, RECEIPT_KEYS, RECEIPT_KEYS, state);
  const parsedDescriptor = nullRecord({
    ref: boundedString(
      entered.snapshot.ref,
      EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_REF_BYTES,
      state,
      SAFE_REF,
    ),
    sourceType: sourceType(entered.snapshot.sourceType, state),
    evidenceId: boundedString(
      entered.snapshot.evidenceId,
      EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_EVIDENCE_ID_BYTES,
      state,
      SAFE_EVIDENCE_ID,
    ),
  });
  if (!sameDescriptor(parsedDescriptor, expected)) throw new InvalidValue();
  const lifecycle = literal(entered.snapshot.lifecycle, ['active', 'inactive'] as const, state);
  const temporal = literal(entered.snapshot.temporal, ['in-frame', 'out-of-frame'] as const, state);
  const supersession = literal(entered.snapshot.supersession, ['clear', 'superseded'] as const, state);
  const contradiction = literal(entered.snapshot.contradiction, ['clear', 'withheld'] as const, state);
  const provenance = provenanceValue(entered.snapshot.provenance, parsedDescriptor.sourceType, state);

  // V1 is intentionally narrower than the eventual historical authority:
  // semantic raw/pending contradiction signals cannot produce receipts;
  // facts alone may expose the source-owned disputed/withheld state; and the
  // current architecture policy has neither history nor contradiction state.
  if (parsedDescriptor.sourceType === 'semantic' && contradiction !== 'clear') {
    throw new InvalidValue();
  }
  if (parsedDescriptor.sourceType === 'fact'
    && contradiction === 'withheld'
    && lifecycle !== 'active') throw new InvalidValue();
  if (parsedDescriptor.sourceType === 'arch_entity'
    && (temporal !== 'in-frame'
      || supersession !== 'clear'
      || contradiction !== 'clear')) throw new InvalidValue();

  return nullRecord({
    ref: parsedDescriptor.ref,
    sourceType: parsedDescriptor.sourceType,
    evidenceId: parsedDescriptor.evidenceId,
    lifecycle,
    temporal,
    supersession,
    contradiction,
    provenance,
  });
}

function receiptArray(
  input: unknown,
  request: EvidenceEligibilityAuthorityRequestV1,
  state: ParseState,
): readonly EvidenceEligibilityAuthorityReceiptV1[] {
  const raw = denseArray(input, state);
  if (raw.length !== request.candidates.length) throw new InvalidValue();
  const output = new ARRAY<EvidenceEligibilityAuthorityReceiptV1>(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    defineArrayItem(output, index, receiptValue(raw[index], request.candidates[index]!, state));
  }
  return OBJECT_FREEZE(output);
}

function unsupportedCode(
  input: unknown,
  request: EvidenceEligibilityAuthorityRequestV1,
  state: ParseState,
): EvidenceEligibilityAuthorityUnsupportedCodeV1 {
  const code = literal(input, [
    'source-policy-unavailable',
    'temporal-history-unavailable',
    'adjudication-pending',
    'adjudication-coverage-gap',
    'record-time-unavailable',
  ] as const, state);
  if (request.temporalFrame.mode === 'as-of') {
    if (code !== 'temporal-history-unavailable') throw new InvalidValue();
    return code;
  }
  if (code === 'temporal-history-unavailable') throw new InvalidValue();
  if (code === 'adjudication-pending' || code === 'adjudication-coverage-gap') {
    let semantic = false;
    for (let index = 0; index < request.candidates.length; index += 1) {
      if (request.candidates[index]!.sourceType === 'semantic') semantic = true;
    }
    if (!semantic) throw new InvalidValue();
  }
  return code;
}

function parseSupportedResult(
  input: unknown,
  request: EvidenceEligibilityAuthorityRequestV1,
): EvidenceEligibilityAuthoritySupportedResultV1 {
  if (request.temporalFrame.mode !== 'current') throw new InvalidValue();
  const state = freshState();
  const entered = enterRecord(input, SUPPORTED_RESULT_KEYS, SUPPORTED_RESULT_KEYS, state);
  const echo = requireAuthorityEcho(entered, request, state);
  const outcome = literal(entered.snapshot.outcome, ['supported'] as const, state);
  const recordedAt = canonicalInstant(entered.snapshot.recordedAt, state);
  const receipts = receiptArray(entered.snapshot.receipts, request, state);
  return nullRecord({
    contractId: echo.contractId,
    contractVersion: echo.contractVersion,
    outcome,
    tenantId: echo.tenantId,
    projectScope: echo.projectScope,
    resolvedEntityId: echo.resolvedEntityId,
    temporalFrame: echo.temporalFrame,
    recordTime: echo.recordTime,
    recordedAt,
    receipts,
  });
}

function parseUnsupportedResult(
  input: unknown,
  request: EvidenceEligibilityAuthorityRequestV1,
): EvidenceEligibilityAuthorityUnsupportedResultV1 {
  const state = freshState();
  const entered = enterRecord(input, UNSUPPORTED_RESULT_KEYS, UNSUPPORTED_RESULT_KEYS, state);
  const echo = requireAuthorityEcho(entered, request, state);
  const outcome = literal(entered.snapshot.outcome, ['unsupported'] as const, state);
  const code = unsupportedCode(entered.snapshot.code, request, state);
  return nullRecord({
    contractId: echo.contractId,
    contractVersion: echo.contractVersion,
    outcome,
    tenantId: echo.tenantId,
    projectScope: echo.projectScope,
    resolvedEntityId: echo.resolvedEntityId,
    temporalFrame: echo.temporalFrame,
    recordTime: echo.recordTime,
    code,
  });
}

export function parseEvidenceEligibilityAuthorityRequestV1(
  input: unknown,
): EvidenceEligibilityAuthorityRequestV1 {
  try {
    return parseRequest(input);
  } catch (error) {
    throw new EvidenceEligibilityAuthorityContractError(
      isPrivateError(error, BudgetExceeded.prototype) ? 'budget-exceeded' : 'invalid-request',
    );
  }
}

export function emitEvidenceEligibilityAuthorityRequestV1(
  input: unknown,
): EvidenceEligibilityAuthorityRequestV1 {
  return parseEvidenceEligibilityAuthorityRequestV1(input);
}

/**
 * Canonicalize a provider result against an already authenticated request.
 * This validates unknown bytes only; it does not create, seal, or authenticate
 * an authority receipt. A later private provider boundary owns that authority.
 */
export function parseEvidenceEligibilityAuthorityResultV1(
  input: unknown,
  expectedRequest: unknown,
): EvidenceEligibilityAuthorityResultV1 {
  const request = parseEvidenceEligibilityAuthorityRequestV1(expectedRequest);
  try {
    if (typeof input !== 'object' || input === null || NODE_IS_PROXY(input) || ARRAY_IS_ARRAY(input)) {
      throw new InvalidValue();
    }
    const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(input, 'outcome');
    if (descriptor === undefined
      || !OBJECT_HAS_OWN(descriptor, 'value')
      || descriptor.enumerable !== true) throw new InvalidValue();
    if (descriptor.value === 'supported') return parseSupportedResult(input, request);
    if (descriptor.value === 'unsupported') return parseUnsupportedResult(input, request);
    throw new InvalidValue();
  } catch (error) {
    throw new EvidenceEligibilityAuthorityContractError(
      isPrivateError(error, BudgetExceeded.prototype) ? 'budget-exceeded' : 'invalid-result',
    );
  }
}
