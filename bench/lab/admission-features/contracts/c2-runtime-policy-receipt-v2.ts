import { createHash } from 'node:crypto';
import { types as nodeUtilTypes } from 'node:util';

import {
  parseAdmissionC2RuntimePolicyReceiptV1,
  type AdmissionC2RuntimePolicyReceiptV1,
} from './c2-runtime-policy-receipt.js';

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const GIT_OID_PATTERN = /^[0-9a-f]{40}$/;
const RECEIPT_MAX_BYTES = 16_384;
const V1_SCHEMA = 'memberry.admission-c2-runtime-policy-receipt.v1';
const V1_CANONICAL_BYTES_SHA256 =
  'sha256:c55c3b8f66d32e529d5467d90f079dc4027d5dc62b2fcd3fbd6ece0200e63c70';
const REPOSITORY_ROOT_TREE_OID = '94c75dd3a36a708ce6add1f10eaf606fa4ffea8d';
const CANDIDATE_SUBTREE_OID = '03d7c50515f6ab767fd41b7d41bd231531a4ab58';
const INTRINSIC_ARRAY = Array;
const INTRINSIC_JSON = JSON;
const INTRINSIC_JSON_PARSE = JSON.parse;
const INTRINSIC_JSON_STRINGIFY = JSON.stringify;
const INTRINSIC_OBJECT = Object;
const INTRINSIC_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;

export interface AdmissionC2RuntimePolicyReceiptV2 {
  readonly schemaVersion: 'memberry.admission-c2-runtime-policy-receipt.v2';
  readonly receiptVersion: '2.0.0';
  readonly hashScope: 'sha256-canonical-json-without-receiptSha256';
  readonly legacyReceipt: Readonly<{
    schemaVersion: typeof V1_SCHEMA;
    receiptSha256: `sha256:${string}`;
    canonicalBytesSha256: `sha256:${string}`;
  }>;
  readonly policy: AdmissionC2RuntimePolicyReceiptV1['policy'];
  readonly binding: Readonly<{
    candidateCommitSha: string;
    repositoryRootTreeOid: string;
    candidateSubtreeOid: string;
    candidateSha256: `sha256:${string}`;
    sourceSha256: `sha256:${string}`;
    imageSha256: `sha256:${string}`;
    imageConfigSha256: `sha256:${string}`;
    nodeSha256: `sha256:${string}`;
    rootFsLayerSha256: readonly `sha256:${string}`[];
    inputSha256: `sha256:${string}`;
    outputSha256: `sha256:${string}`;
    hostedEvidence: AdmissionC2RuntimePolicyReceiptV1['binding']['hostedEvidence'];
  }>;
  readonly receiptSha256: `sha256:${string}`;
}

function sha256(bytes: Uint8Array | string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function requireIntrinsicDataProperty(owner: object, key: PropertyKey, expected: unknown): void {
  const descriptor = INTRINSIC_GET_OWN_PROPERTY_DESCRIPTOR(owner, key);
  if (!descriptor || !('value' in descriptor) || descriptor.value !== expected
    || descriptor.writable !== true || descriptor.enumerable !== false
    || descriptor.configurable !== true) {
    throw new Error('unsafe canonical serialization environment');
  }
}

function requireCanonicalSerializationEnvironment(): void {
  requireIntrinsicDataProperty(globalThis, 'Array', INTRINSIC_ARRAY);
  requireIntrinsicDataProperty(globalThis, 'JSON', INTRINSIC_JSON);
  requireIntrinsicDataProperty(globalThis, 'Object', INTRINSIC_OBJECT);
  requireIntrinsicDataProperty(INTRINSIC_JSON, 'parse', INTRINSIC_JSON_PARSE);
  requireIntrinsicDataProperty(INTRINSIC_JSON, 'stringify', INTRINSIC_JSON_STRINGIFY);
  requireIntrinsicDataProperty(
    INTRINSIC_OBJECT,
    'getOwnPropertyDescriptor',
    INTRINSIC_GET_OWN_PROPERTY_DESCRIPTOR,
  );
  if (INTRINSIC_GET_OWN_PROPERTY_DESCRIPTOR(INTRINSIC_OBJECT.prototype, 'toJSON') !== undefined
    || INTRINSIC_GET_OWN_PROPERTY_DESCRIPTOR(INTRINSIC_ARRAY.prototype, 'toJSON') !== undefined) {
    throw new Error('unsafe canonical serialization environment');
  }
}

function snapshotBytes(value: unknown): Uint8Array {
  if (typeof value !== 'object' || value === null || nodeUtilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Uint8Array.prototype) throw new Error('invalid receipt bytes');
  const bytes = value as Uint8Array;
  if (!Number.isSafeInteger(bytes.byteLength) || bytes.byteLength < 2
    || bytes.byteLength > RECEIPT_MAX_BYTES || Reflect.ownKeys(bytes).length !== bytes.byteLength) {
    throw new Error('invalid receipt bytes');
  }
  const result = new Uint8Array(bytes.byteLength);
  for (let index = 0; index < bytes.byteLength; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(bytes, String(index));
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || descriptor.enumerable !== true || descriptor.configurable !== true
      || descriptor.writable !== true || typeof descriptor.value !== 'number') {
      throw new Error('invalid receipt bytes');
    }
    result[index] = descriptor.value;
  }
  return result;
}

function parseJsonBytes(value: unknown): { value: unknown; bytes: Uint8Array; text: string } {
  const bytes = snapshotBytes(value);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\r') || !text.endsWith('\n') || text.slice(0, -1).includes('\n')) {
    throw new Error('noncanonical JSON bytes');
  }
  return { value: JSON.parse(text.slice(0, -1)) as unknown, bytes, text };
}

function closedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeUtilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('invalid receipt object');
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    throw new Error('invalid receipt keys');
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || descriptor.enumerable !== true || descriptor.configurable !== true
      || descriptor.writable !== true) throw new Error('invalid receipt descriptor');
    result[key] = descriptor.value;
  }
  return result;
}

function exactString(value: unknown, expected: string): string {
  if (typeof value !== 'string' || value !== expected || value.includes('\0')) {
    throw new Error('invalid receipt string');
  }
  return value;
}

function exactSha256(value: unknown, expected: `sha256:${string}`): `sha256:${string}` {
  const result = exactString(value, expected);
  if (!SHA256_PATTERN.test(result)) throw new Error('invalid SHA-256 identity');
  return result as `sha256:${string}`;
}

function exactGitOid(value: unknown, expected: string): string {
  const result = exactString(value, expected);
  if (!GIT_OID_PATTERN.test(result)) throw new Error('invalid Git identity');
  return result;
}

function exactJson(value: unknown, expected: unknown): void {
  if (JSON.stringify(value) !== JSON.stringify(expected)) throw new Error('legacy receipt binding drift');
}

/**
 * Parses only the closed v2 schema and proves it against the exact canonical
 * v1 neutral authority. The v1 parser is never attempted on v2 bytes, and v2
 * has no compatibility or fallback path for the ambiguous candidateTreeOid.
 */
export function parseAdmissionC2RuntimePolicyReceiptV2(
  receiptBytes: unknown,
  legacyReceiptBytes: unknown,
): AdmissionC2RuntimePolicyReceiptV2 {
  requireCanonicalSerializationEnvironment();
  const legacyParsedBytes = snapshotBytes(legacyReceiptBytes);
  const legacy = parseAdmissionC2RuntimePolicyReceiptV1(legacyParsedBytes);
  const parsed = parseJsonBytes(receiptBytes);
  const root = closedRecord(parsed.value, [
    'schemaVersion', 'receiptVersion', 'hashScope', 'legacyReceipt', 'policy', 'binding',
    'receiptSha256',
  ]);
  exactString(root.schemaVersion, 'memberry.admission-c2-runtime-policy-receipt.v2');
  exactString(root.receiptVersion, '2.0.0');
  exactString(root.hashScope, 'sha256-canonical-json-without-receiptSha256');

  const rawLegacy = closedRecord(root.legacyReceipt, [
    'schemaVersion', 'receiptSha256', 'canonicalBytesSha256',
  ]);
  const legacyReceipt = Object.freeze({
    schemaVersion: exactString(rawLegacy.schemaVersion, V1_SCHEMA) as typeof V1_SCHEMA,
    receiptSha256: exactSha256(rawLegacy.receiptSha256, legacy.receiptSha256),
    canonicalBytesSha256: exactSha256(
      rawLegacy.canonicalBytesSha256,
      V1_CANONICAL_BYTES_SHA256,
    ),
  });
  if (legacyReceipt.canonicalBytesSha256 !== sha256(legacyParsedBytes)) {
    throw new Error('legacy receipt byte hash mismatch');
  }

  exactJson(root.policy, legacy.policy);
  const rawBinding = closedRecord(root.binding, [
    'candidateCommitSha', 'repositoryRootTreeOid', 'candidateSubtreeOid', 'candidateSha256',
    'sourceSha256', 'imageSha256', 'imageConfigSha256', 'nodeSha256', 'rootFsLayerSha256',
    'inputSha256', 'outputSha256', 'hostedEvidence',
  ]);
  exactJson(rawBinding.hostedEvidence, legacy.binding.hostedEvidence);
  exactJson(rawBinding.rootFsLayerSha256, legacy.binding.rootFsLayerSha256);
  const repositoryRootTreeOid = exactGitOid(
    rawBinding.repositoryRootTreeOid,
    REPOSITORY_ROOT_TREE_OID,
  );
  const candidateSubtreeOid = exactGitOid(rawBinding.candidateSubtreeOid, CANDIDATE_SUBTREE_OID);
  if (repositoryRootTreeOid === candidateSubtreeOid) throw new Error('tree identities must be distinct');

  const binding = Object.freeze({
    candidateCommitSha: exactString(rawBinding.candidateCommitSha, legacy.binding.candidateCommitSha),
    repositoryRootTreeOid,
    candidateSubtreeOid,
    candidateSha256: exactSha256(rawBinding.candidateSha256, legacy.binding.candidateSha256),
    sourceSha256: exactSha256(rawBinding.sourceSha256, legacy.binding.sourceSha256),
    imageSha256: exactSha256(rawBinding.imageSha256, legacy.binding.imageSha256),
    imageConfigSha256: exactSha256(
      rawBinding.imageConfigSha256,
      legacy.binding.imageConfigSha256,
    ),
    nodeSha256: exactSha256(rawBinding.nodeSha256, legacy.binding.nodeSha256),
    rootFsLayerSha256: legacy.binding.rootFsLayerSha256,
    inputSha256: exactSha256(rawBinding.inputSha256, legacy.binding.inputSha256),
    outputSha256: exactSha256(rawBinding.outputSha256, legacy.binding.outputSha256),
    hostedEvidence: legacy.binding.hostedEvidence,
  });

  const payload = Object.freeze({
    schemaVersion: 'memberry.admission-c2-runtime-policy-receipt.v2' as const,
    receiptVersion: '2.0.0' as const,
    hashScope: 'sha256-canonical-json-without-receiptSha256' as const,
    legacyReceipt,
    policy: legacy.policy,
    binding,
  });
  const receiptSha256 = exactSha256(root.receiptSha256, sha256(JSON.stringify(payload)));
  const receipt = Object.freeze({ ...payload, receiptSha256 });
  if (parsed.text !== `${JSON.stringify(receipt)}\n`) throw new Error('noncanonical receipt');
  return receipt;
}
