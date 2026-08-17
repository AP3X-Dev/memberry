import { createHash } from 'node:crypto';
import { types as nodeUtilTypes } from 'node:util';

const CREATE_HASH = createHash;

const OBJECT_CREATE = Object.create;
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_PROTOTYPE = Object.prototype;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_BUFFER_IS_VIEW = ArrayBuffer.isView;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const NODE_IS_PROXY = nodeUtilTypes.isProxy;
const BUFFER_BYTE_LENGTH = Buffer.byteLength;
const BUFFER_ALLOC_UNSAFE = Buffer.allocUnsafe;
const BUFFER_WRITE_UINT32_BE = Function.prototype.call.bind(Buffer.prototype.writeUInt32BE) as (
  buffer: Buffer,
  value: number,
  offset: number,
) => number;
const STRING_CHAR_CODE_AT = Function.prototype.call.bind(String.prototype.charCodeAt) as (
  input: string,
  index: number,
) => number;
const STRING_NORMALIZE = Function.prototype.call.bind(String.prototype.normalize) as (
  input: string,
  form?: 'NFC' | 'NFD' | 'NFKC' | 'NFKD',
) => string;
const STRING_STARTS_WITH = Function.prototype.call.bind(String.prototype.startsWith) as (
  input: string,
  search: string,
  position?: number,
) => boolean;
const STRING_ENDS_WITH = Function.prototype.call.bind(String.prototype.endsWith) as (
  input: string,
  search: string,
  endPosition?: number,
) => boolean;
const STRING_SLICE = Function.prototype.call.bind(String.prototype.slice) as (
  input: string,
  start: number,
  end?: number,
) => string;
const STRING_INDEX_OF = Function.prototype.call.bind(String.prototype.indexOf) as (
  input: string,
  search: string,
  position?: number,
) => number;
const WEAK_SET = WeakSet;
const WEAK_SET_HAS = Function.prototype.call.bind(WeakSet.prototype.has) as (
  set: WeakSet<object>,
  value: object,
) => boolean;
const WEAK_SET_ADD = Function.prototype.call.bind(WeakSet.prototype.add) as (
  set: WeakSet<object>,
  value: object,
) => WeakSet<object>;

const HASH_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(CREATE_HASH('sha256')) as object;
const HASH_UPDATE_DESCRIPTOR = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(HASH_PROTOTYPE, 'update');
const HASH_DIGEST_DESCRIPTOR = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(HASH_PROTOTYPE, 'digest');
if (HASH_UPDATE_DESCRIPTOR === undefined
  || !OBJECT_HAS_OWN(HASH_UPDATE_DESCRIPTOR, 'value')
  || typeof HASH_UPDATE_DESCRIPTOR.value !== 'function'
  || HASH_DIGEST_DESCRIPTOR === undefined
  || !OBJECT_HAS_OWN(HASH_DIGEST_DESCRIPTOR, 'value')
  || typeof HASH_DIGEST_DESCRIPTOR.value !== 'function') {
  throw new Error('memberry.repository-file-identity:hash-intrinsics-unavailable');
}
const HASH_UPDATE = Function.prototype.call.bind(HASH_UPDATE_DESCRIPTOR.value) as (
  hash: ReturnType<typeof CREATE_HASH>,
  data: string | Uint8Array,
  encoding?: BufferEncoding,
) => ReturnType<typeof CREATE_HASH>;
const HASH_DIGEST = Function.prototype.call.bind(HASH_DIGEST_DESCRIPTOR.value) as (
  hash: ReturnType<typeof CREATE_HASH>,
  encoding: 'hex',
) => string;

export const REPOSITORY_FILE_IDENTITY_CONTRACT_ID = 'memberry.repository-file-identity' as const;
export const REPOSITORY_FILE_IDENTITY_CONTRACT_VERSION = '1.0.0' as const;
export const REPOSITORY_FILE_IDENTITY_MAX_REPOSITORY_ID_BYTES = 128 as const;
export const REPOSITORY_FILE_IDENTITY_MAX_WORKTREE_ID_BYTES = 128 as const;
export const REPOSITORY_FILE_IDENTITY_MAX_BRANCH_REF_BYTES = 512 as const;
export const REPOSITORY_FILE_IDENTITY_MAX_PATH_BYTES = 4_096 as const;

const HEADS_PREFIX = 'refs/heads/';

export type RepositoryCheckoutIdentityV1 =
  | { readonly kind: 'branch'; readonly ref: string }
  | { readonly kind: 'detached' };

export type RepositoryCommitIdentityV1 =
  | { readonly algorithm: 'sha1'; readonly oid: string }
  | { readonly algorithm: 'sha256'; readonly oid: string };

export interface RepositoryFileIdentityV1 {
  readonly contractId: typeof REPOSITORY_FILE_IDENTITY_CONTRACT_ID;
  readonly contractVersion: typeof REPOSITORY_FILE_IDENTITY_CONTRACT_VERSION;
  readonly repositoryId: string;
  readonly worktreeId: string;
  readonly checkout: RepositoryCheckoutIdentityV1;
  readonly commit: RepositoryCommitIdentityV1;
  readonly repositoryRelativePath: string;
}

export type RepositoryFileIdentityContractErrorCodeV1 =
  | 'invalid-identity'
  | 'budget-exceeded'
  | 'scope-key-failed';

export class RepositoryFileIdentityContractError extends Error {
  declare readonly code: RepositoryFileIdentityContractErrorCodeV1;

  constructor(code: RepositoryFileIdentityContractErrorCodeV1) {
    super(code);
    OBJECT_DEFINE_PROPERTY(this, 'name', {
      value: 'RepositoryFileIdentityContractError',
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

class InvalidIdentity extends Error {}
class BudgetExceeded extends Error {}

interface ParseState {
  readonly seen: WeakSet<object>;
}

type NullRecord = Record<string, unknown>;

function isPrivateError(error: unknown, prototype: object): boolean {
  return typeof error === 'object'
    && error !== null
    && !NODE_IS_PROXY(error)
    && OBJECT_GET_PROTOTYPE_OF(error) === prototype;
}

function nullRecord<T extends object>(fields: T): Readonly<T> {
  const output = OBJECT_CREATE(null) as T;
  const keys = REFLECT_OWN_KEYS(fields);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(fields, key);
    if (descriptor === undefined || !OBJECT_HAS_OWN(descriptor, 'value')) throw new InvalidIdentity();
    OBJECT_DEFINE_PROPERTY(output, key, descriptor);
  }
  return OBJECT_FREEZE(output);
}

function arrayContains<T>(values: readonly T[], value: T): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }
  return false;
}

function closedRecord(
  input: unknown,
  allowed: readonly string[],
  required: readonly string[],
  state: ParseState,
): NullRecord {
  try {
    if (typeof input !== 'object'
      || input === null
      || NODE_IS_PROXY(input)
      || ARRAY_IS_ARRAY(input)
      || ARRAY_BUFFER_IS_VIEW(input)) {
      throw new InvalidIdentity();
    }
    const prototype = OBJECT_GET_PROTOTYPE_OF(input);
    if (prototype !== OBJECT_PROTOTYPE && prototype !== null) throw new InvalidIdentity();
    if (WEAK_SET_HAS(state.seen, input)) throw new InvalidIdentity();
    WEAK_SET_ADD(state.seen, input);
    const keys = REFLECT_OWN_KEYS(input);
    if (keys.length > allowed.length) throw new InvalidIdentity();
    const snapshot = OBJECT_CREATE(null) as NullRecord;
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!;
      if (typeof key !== 'string' || !arrayContains(allowed, key)) throw new InvalidIdentity();
      const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(input, key);
      if (descriptor === undefined
        || !OBJECT_HAS_OWN(descriptor, 'value')
        || descriptor.enumerable !== true) {
        throw new InvalidIdentity();
      }
      snapshot[key] = descriptor.value;
    }
    for (let index = 0; index < required.length; index += 1) {
      if (!OBJECT_HAS_OWN(snapshot, required[index]!)) throw new InvalidIdentity();
    }
    return snapshot;
  } catch (error) {
    if (isPrivateError(error, InvalidIdentity.prototype)) throw error;
    throw new InvalidIdentity();
  }
}

function exactRecord(input: unknown, keys: readonly string[], state: ParseState): NullRecord {
  return closedRecord(input, keys, keys, state);
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

function boundedString(input: unknown, maxBytes: number): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new InvalidIdentity();
  }
  if (input.length > maxBytes) throw new BudgetExceeded();
  if (!validUnicode(input)) throw new InvalidIdentity();
  if (BUFFER_BYTE_LENGTH(input, 'utf8') > maxBytes) throw new BudgetExceeded();
  return input;
}

function literal<T extends string>(input: unknown, allowed: readonly T[]): T {
  if (typeof input !== 'string' || !arrayContains(allowed, input as T)) throw new InvalidIdentity();
  return input as T;
}

function isAsciiAlphaNumeric(code: number): boolean {
  return (code >= 0x30 && code <= 0x39)
    || (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a);
}

function assignedId(input: unknown, maxBytes: number): string {
  const value = boundedString(input, maxBytes);
  if (!isAsciiAlphaNumeric(STRING_CHAR_CODE_AT(value, 0))) throw new InvalidIdentity();
  for (let index = 1; index < value.length; index += 1) {
    const code = STRING_CHAR_CODE_AT(value, index);
    if (!isAsciiAlphaNumeric(code)
      && code !== 0x2e
      && code !== 0x5f
      && code !== 0x3a
      && code !== 0x2d) {
      throw new InvalidIdentity();
    }
  }
  return value;
}

function isControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

function assertCanonicalUnicode(value: string): void {
  if (STRING_NORMALIZE(value, 'NFC') !== value) throw new InvalidIdentity();
}

function validateRefSegment(value: string, start: number, end: number, first: boolean): void {
  if (start >= end || STRING_CHAR_CODE_AT(value, start) === 0x2e) throw new InvalidIdentity();
  if (first && STRING_CHAR_CODE_AT(value, start) === 0x2d) throw new InvalidIdentity();
  if (STRING_CHAR_CODE_AT(value, end - 1) === 0x2e) throw new InvalidIdentity();
  const segment = STRING_SLICE(value, start, end);
  if (STRING_ENDS_WITH(segment, '.lock')) throw new InvalidIdentity();
}

function branchRef(input: unknown): string {
  const value = boundedString(input, REPOSITORY_FILE_IDENTITY_MAX_BRANCH_REF_BYTES);
  assertCanonicalUnicode(value);
  if (!STRING_STARTS_WITH(value, HEADS_PREFIX) || value.length === HEADS_PREFIX.length) {
    throw new InvalidIdentity();
  }
  if (STRING_INDEX_OF(value, '..') !== -1 || STRING_INDEX_OF(value, '@{') !== -1) {
    throw new InvalidIdentity();
  }
  let segmentStart = HEADS_PREFIX.length;
  let first = true;
  for (let index = segmentStart; index < value.length; index += 1) {
    const code = STRING_CHAR_CODE_AT(value, index);
    if (isControl(code)
      || code === 0x20
      || code === 0x7e
      || code === 0x5e
      || code === 0x3a
      || code === 0x3f
      || code === 0x2a
      || code === 0x5b
      || code === 0x5c) {
      throw new InvalidIdentity();
    }
    if (code === 0x2f) {
      validateRefSegment(value, segmentStart, index, first);
      segmentStart = index + 1;
      first = false;
    }
  }
  validateRefSegment(value, segmentStart, value.length, first);
  return value;
}

function checkoutIdentity(input: unknown, state: ParseState): RepositoryCheckoutIdentityV1 {
  const root = closedRecord(input, ['kind', 'ref'], ['kind'], state);
  const kind = literal(root.kind, ['branch', 'detached'] as const);
  if (kind === 'detached') {
    if (REFLECT_OWN_KEYS(root).length !== 1) throw new InvalidIdentity();
    return nullRecord({ kind });
  }
  if (REFLECT_OWN_KEYS(root).length !== 2 || !OBJECT_HAS_OWN(root, 'ref')) {
    throw new InvalidIdentity();
  }
  return nullRecord({ kind, ref: branchRef(root.ref) });
}

function isLowerHex(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = STRING_CHAR_CODE_AT(value, index);
    if (!((code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x66))) return false;
  }
  return true;
}

function commitIdentity(input: unknown, state: ParseState): RepositoryCommitIdentityV1 {
  const root = exactRecord(input, ['algorithm', 'oid'], state);
  const algorithm = literal(root.algorithm, ['sha1', 'sha256'] as const);
  if (typeof root.oid !== 'string'
    || root.oid.length !== (algorithm === 'sha1' ? 40 : 64)
    || !isLowerHex(root.oid)) {
    throw new InvalidIdentity();
  }
  return nullRecord({ algorithm, oid: root.oid });
}

function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function validatePathSegment(value: string, start: number, end: number): void {
  if (start >= end) throw new InvalidIdentity();
  if ((end - start === 1 && STRING_CHAR_CODE_AT(value, start) === 0x2e)
    || (end - start === 2
      && STRING_CHAR_CODE_AT(value, start) === 0x2e
      && STRING_CHAR_CODE_AT(value, start + 1) === 0x2e)) {
    throw new InvalidIdentity();
  }
}

function repositoryPath(input: unknown): string {
  const value = boundedString(input, REPOSITORY_FILE_IDENTITY_MAX_PATH_BYTES);
  assertCanonicalUnicode(value);
  if (STRING_CHAR_CODE_AT(value, 0) === 0x2f
    || (value.length >= 2
      && isAsciiLetter(STRING_CHAR_CODE_AT(value, 0))
      && STRING_CHAR_CODE_AT(value, 1) === 0x3a)) {
    throw new InvalidIdentity();
  }
  let segmentStart = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = STRING_CHAR_CODE_AT(value, index);
    if (isControl(code) || code === 0x5c) throw new InvalidIdentity();
    if (code === 0x2f) {
      validatePathSegment(value, segmentStart, index);
      segmentStart = index + 1;
    }
  }
  validatePathSegment(value, segmentStart, value.length);
  return value;
}

function parseIdentity(input: unknown): RepositoryFileIdentityV1 {
  const state: ParseState = { seen: new WEAK_SET<object>() };
  const root = exactRecord(input, [
    'contractId',
    'contractVersion',
    'repositoryId',
    'worktreeId',
    'checkout',
    'commit',
    'repositoryRelativePath',
  ], state);
  const contractId = literal(root.contractId, [REPOSITORY_FILE_IDENTITY_CONTRACT_ID] as const);
  const contractVersion = literal(
    root.contractVersion,
    [REPOSITORY_FILE_IDENTITY_CONTRACT_VERSION] as const,
  );
  const repositoryId = assignedId(
    root.repositoryId,
    REPOSITORY_FILE_IDENTITY_MAX_REPOSITORY_ID_BYTES,
  );
  const worktreeId = assignedId(
    root.worktreeId,
    REPOSITORY_FILE_IDENTITY_MAX_WORKTREE_ID_BYTES,
  );
  const checkout = checkoutIdentity(root.checkout, state);
  const commit = commitIdentity(root.commit, state);
  const repositoryRelativePath = repositoryPath(root.repositoryRelativePath);
  return nullRecord({
    contractId,
    contractVersion,
    repositoryId,
    worktreeId,
    checkout,
    commit,
    repositoryRelativePath,
  });
}

export function parseRepositoryFileIdentityV1(input: unknown): RepositoryFileIdentityV1 {
  try {
    return parseIdentity(input);
  } catch (error) {
    throw new RepositoryFileIdentityContractError(
      isPrivateError(error, BudgetExceeded.prototype) ? 'budget-exceeded' : 'invalid-identity',
    );
  }
}

// The v1 preimage is exactly nine fields in the call-site order below. Each
// UTF-8 field is preceded by its unsigned 32-bit big-endian byte length.
function updateLengthPrefixedField(
  hash: ReturnType<typeof CREATE_HASH>,
  value: string,
): void {
  const byteLength = BUFFER_BYTE_LENGTH(value, 'utf8');
  const prefix = BUFFER_ALLOC_UNSAFE(4);
  BUFFER_WRITE_UINT32_BE(prefix, byteLength, 0);
  HASH_UPDATE(hash, prefix);
  HASH_UPDATE(hash, value, 'utf8');
}

export function repositoryFileScopeKeyV1(input: unknown): string {
  const identity = parseRepositoryFileIdentityV1(input);
  try {
    const hash = CREATE_HASH('sha256');
    if (OBJECT_GET_PROTOTYPE_OF(hash) !== HASH_PROTOTYPE) throw new InvalidIdentity();
    updateLengthPrefixedField(hash, identity.contractId);
    updateLengthPrefixedField(hash, identity.contractVersion);
    updateLengthPrefixedField(hash, identity.repositoryId);
    updateLengthPrefixedField(hash, identity.worktreeId);
    updateLengthPrefixedField(hash, identity.checkout.kind);
    updateLengthPrefixedField(hash, identity.checkout.kind === 'branch' ? identity.checkout.ref : '');
    updateLengthPrefixedField(hash, identity.commit.algorithm);
    updateLengthPrefixedField(hash, identity.commit.oid);
    updateLengthPrefixedField(hash, identity.repositoryRelativePath);
    return HASH_DIGEST(hash, 'hex');
  } catch {
    throw new RepositoryFileIdentityContractError('scope-key-failed');
  }
}
