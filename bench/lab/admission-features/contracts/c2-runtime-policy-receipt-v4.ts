// MEM-002 productionization: v4 runtime-policy attestation contract.
//
// Extends the C2 chain the way v3 extended v2: the retired v3 receipt (itself
// proven against the exact canonical v2/v1 bytes) supplies the immutable
// runtime policy and the retirement chain; the v4 binding carries the FRESH
// candidate/corpus/hosted-evidence identities of the productionization
// attempt (the live producer in packages/core/src). The frozen v1/v2/v3
// receipt files are never edited; no fallback path parses older bytes as v4.
// The canonical .v4.json instance is produced by the owner-gated hosted
// attestation run — it cannot exist before the evaluated commit does.

import { createHash } from 'node:crypto';
import { types as nodeUtilTypes } from 'node:util';

import {
  parseAdmissionC2RuntimePolicyReceiptV3,
  type AdmissionC2RuntimePolicyReceiptV3,
} from './c2-runtime-policy-receipt-v3.js';

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const GIT_OID_PATTERN = /^[0-9a-f]{40}$/;
const DIGITS_PATTERN = /^[1-9][0-9]{0,15}$/;
const RECEIPT_MAX_BYTES = 16_384;
const V3_SCHEMA = 'memberry.admission-c2-runtime-policy-receipt.v3';
const ROOT_FS_LAYER_COUNT = 6;

const REGISTERED_RECEIPTS = new WeakSet<object>();

export interface AdmissionC2RuntimePolicyReceiptV4 {
  readonly schemaVersion: 'memberry.admission-c2-runtime-policy-receipt.v4';
  readonly receiptVersion: '4.0.0';
  readonly hashScope: 'sha256-canonical-json-without-receiptSha256';
  readonly retiredReceipt: Readonly<{
    schemaVersion: typeof V3_SCHEMA;
    receiptSha256: `sha256:${string}`;
    canonicalBytesSha256: `sha256:${string}`;
  }>;
  readonly policy: AdmissionC2RuntimePolicyReceiptV3['policy'];
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
    hostedEvidence: Readonly<{
      repository: 'AP3X-Dev/memberry';
      workflowRunId: string;
      workflowRunAttempt: number;
      artifactId: string;
      artifactName: string;
      artifactSha256: `sha256:${string}`;
      evidenceSchemaVersion: 'memberry.admission-feature-candidate-live-evidence.v1';
      evidenceFileSha256: `sha256:${string}`;
      workflowFileSha256: `sha256:${string}`;
      cleanupVerified: true;
    }>;
  }>;
  readonly receiptSha256: `sha256:${string}`;
}

function sha256(bytes: Uint8Array | string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function snapshotBytes(value: unknown, maximumBytes: number): Uint8Array {
  if (typeof value !== 'object' || value === null || nodeUtilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Uint8Array.prototype) throw new Error('invalid receipt bytes');
  const bytes = value as Uint8Array;
  if (!Number.isSafeInteger(bytes.byteLength) || bytes.byteLength < 2
    || bytes.byteLength > maximumBytes) throw new Error('invalid receipt bytes');
  return Uint8Array.from(bytes);
}

function parseJsonBytes(
  value: unknown,
  maximumBytes: number,
): { value: unknown; bytes: Uint8Array; text: string } {
  const bytes = snapshotBytes(value, maximumBytes);
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
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error('invalid receipt descriptor');
    }
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

function anySha256(value: unknown): `sha256:${string}` {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error('invalid SHA-256 identity');
  }
  return value as `sha256:${string}`;
}

function exactSha256(value: unknown, expected: `sha256:${string}`): `sha256:${string}` {
  const result = anySha256(value);
  if (result !== expected) throw new Error('invalid SHA-256 identity');
  return result;
}

function anyGitOid(value: unknown): string {
  if (typeof value !== 'string' || !GIT_OID_PATTERN.test(value)) {
    throw new Error('invalid Git identity');
  }
  return value;
}

function exactInteger(value: unknown, expected: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value !== expected) {
    throw new Error('invalid receipt integer');
  }
  return value;
}

function exactTrue(value: unknown): true {
  if (value !== true) throw new Error('invalid receipt boolean');
  return value;
}

function exactJson(value: unknown, expected: unknown): void {
  if (JSON.stringify(value) !== JSON.stringify(expected)) throw new Error('retired receipt binding drift');
}

function sha256Layers(value: unknown): readonly `sha256:${string}`[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length !== ROOT_FS_LAYER_COUNT) throw new Error('invalid rootfs layers');
  const layers = value.map((entry) => anySha256(entry));
  if (new Set(layers).size !== layers.length) throw new Error('invalid rootfs layers');
  return Object.freeze(layers);
}

/**
 * Parses only the closed v4 schema. The retired v3 receipt is re-proven from
 * its exact canonical bytes (with its own v2/v1 chain); the v4 binding must
 * carry FRESH candidate, corpus, and hosted-run identities — every retired
 * identity reuse is rejected. The unchanged runtime policy is re-attested by
 * exact-JSON equality with the retired receipt's policy.
 */
export function parseAdmissionC2RuntimePolicyReceiptV4(
  receiptBytes: unknown,
  retiredV3ReceiptBytes: unknown,
  retiredV2ReceiptBytes: unknown,
  legacyV1ReceiptBytes: unknown,
): AdmissionC2RuntimePolicyReceiptV4 {
  const retiredParsedBytes = snapshotBytes(retiredV3ReceiptBytes, RECEIPT_MAX_BYTES);
  const retired = parseAdmissionC2RuntimePolicyReceiptV3(
    retiredParsedBytes,
    retiredV2ReceiptBytes,
    legacyV1ReceiptBytes,
  );
  const parsed = parseJsonBytes(receiptBytes, RECEIPT_MAX_BYTES);
  const root = closedRecord(parsed.value, [
    'schemaVersion', 'receiptVersion', 'hashScope', 'retiredReceipt', 'policy', 'binding',
    'receiptSha256',
  ]);
  exactString(root.schemaVersion, 'memberry.admission-c2-runtime-policy-receipt.v4');
  exactString(root.receiptVersion, '4.0.0');
  exactString(root.hashScope, 'sha256-canonical-json-without-receiptSha256');

  const rawRetired = closedRecord(root.retiredReceipt, [
    'schemaVersion', 'receiptSha256', 'canonicalBytesSha256',
  ]);
  const retiredReceipt = Object.freeze({
    schemaVersion: exactString(rawRetired.schemaVersion, V3_SCHEMA) as typeof V3_SCHEMA,
    receiptSha256: exactSha256(rawRetired.receiptSha256, retired.receiptSha256),
    canonicalBytesSha256: exactSha256(
      rawRetired.canonicalBytesSha256,
      sha256(retiredParsedBytes),
    ),
  });

  exactJson(root.policy, retired.policy);
  const rawBinding = closedRecord(root.binding, [
    'candidateCommitSha', 'repositoryRootTreeOid', 'candidateSubtreeOid', 'candidateSha256',
    'sourceSha256', 'imageSha256', 'imageConfigSha256', 'nodeSha256', 'rootFsLayerSha256',
    'inputSha256', 'outputSha256', 'hostedEvidence',
  ]);
  const candidateCommitSha = anyGitOid(rawBinding.candidateCommitSha);
  const repositoryRootTreeOid = anyGitOid(rawBinding.repositoryRootTreeOid);
  const candidateSubtreeOid = anyGitOid(rawBinding.candidateSubtreeOid);
  if (repositoryRootTreeOid === candidateSubtreeOid) throw new Error('tree identities must be distinct');
  if (
    candidateCommitSha === retired.binding.candidateCommitSha
    || repositoryRootTreeOid === retired.binding.repositoryRootTreeOid
    || candidateSubtreeOid === retired.binding.candidateSubtreeOid
  ) {
    throw new Error('retired candidate identity reuse');
  }
  const candidateSha256 = anySha256(rawBinding.candidateSha256);
  const sourceSha256 = anySha256(rawBinding.sourceSha256);
  if (candidateSha256 === retired.binding.candidateSha256
    || sourceSha256 === retired.binding.sourceSha256) {
    throw new Error('retired candidate identity reuse');
  }

  const rawHosted = closedRecord(rawBinding.hostedEvidence, [
    'repository', 'workflowRunId', 'workflowRunAttempt', 'artifactId', 'artifactName',
    'artifactSha256', 'evidenceSchemaVersion', 'evidenceFileSha256', 'workflowFileSha256',
    'cleanupVerified',
  ]);
  const workflowRunId = exactString(
    rawHosted.workflowRunId,
    String(rawHosted.workflowRunId),
  );
  if (!DIGITS_PATTERN.test(workflowRunId) || workflowRunId === retired.binding.hostedEvidence.workflowRunId) {
    throw new Error('invalid hosted run identity');
  }
  const workflowRunAttempt = exactInteger(rawHosted.workflowRunAttempt, 1);
  const artifactId = exactString(rawHosted.artifactId, String(rawHosted.artifactId));
  if (!DIGITS_PATTERN.test(artifactId)) throw new Error('invalid hosted artifact identity');
  const hostedEvidence = Object.freeze({
    repository: exactString(rawHosted.repository, 'AP3X-Dev/memberry') as 'AP3X-Dev/memberry',
    workflowRunId,
    workflowRunAttempt,
    artifactId,
    artifactName: exactString(
      rawHosted.artifactName,
      `memberry-admission-candidate-live-${workflowRunId}-${workflowRunAttempt}`,
    ),
    artifactSha256: anySha256(rawHosted.artifactSha256),
    evidenceSchemaVersion: exactString(
      rawHosted.evidenceSchemaVersion,
      'memberry.admission-feature-candidate-live-evidence.v1',
    ) as 'memberry.admission-feature-candidate-live-evidence.v1',
    evidenceFileSha256: anySha256(rawHosted.evidenceFileSha256),
    workflowFileSha256: anySha256(rawHosted.workflowFileSha256),
    cleanupVerified: exactTrue(rawHosted.cleanupVerified),
  });

  const binding = Object.freeze({
    candidateCommitSha,
    repositoryRootTreeOid,
    candidateSubtreeOid,
    candidateSha256,
    sourceSha256,
    imageSha256: anySha256(rawBinding.imageSha256),
    imageConfigSha256: anySha256(rawBinding.imageConfigSha256),
    // The runtime policy is unchanged, so the frozen base image (and its node
    // binary content hash) carries over exactly.
    nodeSha256: exactSha256(rawBinding.nodeSha256, retired.binding.nodeSha256),
    rootFsLayerSha256: sha256Layers(rawBinding.rootFsLayerSha256),
    inputSha256: anySha256(rawBinding.inputSha256),
    outputSha256: anySha256(rawBinding.outputSha256),
    hostedEvidence,
  });
  if (binding.inputSha256 === retired.binding.inputSha256
    || binding.outputSha256 === retired.binding.outputSha256) {
    throw new Error('retired corpus identity reuse');
  }

  const payload = Object.freeze({
    schemaVersion: 'memberry.admission-c2-runtime-policy-receipt.v4' as const,
    receiptVersion: '4.0.0' as const,
    hashScope: 'sha256-canonical-json-without-receiptSha256' as const,
    retiredReceipt,
    policy: retired.policy,
    binding,
  });
  const receiptSha256 = exactSha256(root.receiptSha256, sha256(JSON.stringify(payload)));
  const receipt = Object.freeze({ ...payload, receiptSha256 });
  if (parsed.text !== `${JSON.stringify(receipt)}\n`) throw new Error('noncanonical receipt');
  REGISTERED_RECEIPTS.add(receipt);
  return receipt;
}

export function isRegisteredAdmissionC2RuntimePolicyReceiptV4(receipt: object): boolean {
  return REGISTERED_RECEIPTS.has(receipt);
}
