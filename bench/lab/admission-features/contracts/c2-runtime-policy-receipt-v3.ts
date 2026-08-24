import { createHash } from 'node:crypto';
import { types as nodeUtilTypes } from 'node:util';

import {
  parseAdmissionC2RuntimePolicyReceiptV2,
  type AdmissionC2RuntimePolicyReceiptV2,
} from './c2-runtime-policy-receipt-v2.js';

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const GIT_OID_PATTERN = /^[0-9a-f]{40}$/;
const DIGITS_PATTERN = /^[1-9][0-9]{0,15}$/;
const RECEIPT_MAX_BYTES = 16_384;
const EVIDENCE_MAX_BYTES = 16_384;
const V2_SCHEMA = 'memberry.admission-c2-runtime-policy-receipt.v2';
const CANDIDATE_COMMIT_SHA = 'ee4723bf0dccff5ffc7ba05ec5c6ba8ee9ed9bce';
const REPOSITORY_ROOT_TREE_OID = 'f6cc81d7b754778be7b772aa3ecddf6ec8e804d7';
const CANDIDATE_SUBTREE_OID = '08ce328eca824de833d9f762950b4b008a13f723';
const SCENARIO_COUNT = 13;
const DEV_SCENARIO_COUNT = 9;
const HOLDOUT_SCENARIO_COUNT = 4;
const ROOT_FS_LAYER_COUNT = 6;
const INTRINSIC_ARRAY = Array;
const INTRINSIC_JSON = JSON;
const INTRINSIC_JSON_PARSE = JSON.parse;
const INTRINSIC_JSON_STRINGIFY = JSON.stringify;
const INTRINSIC_OBJECT = Object;
const INTRINSIC_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;

const REGISTERED_RECEIPTS = new WeakSet<object>();

export interface AdmissionC2RuntimePolicyReceiptV3 {
  readonly schemaVersion: 'memberry.admission-c2-runtime-policy-receipt.v3';
  readonly receiptVersion: '3.0.0';
  readonly hashScope: 'sha256-canonical-json-without-receiptSha256';
  readonly retiredReceipt: Readonly<{
    schemaVersion: typeof V2_SCHEMA;
    receiptSha256: `sha256:${string}`;
    canonicalBytesSha256: `sha256:${string}`;
  }>;
  readonly policy: AdmissionC2RuntimePolicyReceiptV2['policy'];
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

function snapshotBytes(value: unknown, maximumBytes: number): Uint8Array {
  if (typeof value !== 'object' || value === null || nodeUtilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Uint8Array.prototype) throw new Error('invalid receipt bytes');
  const bytes = value as Uint8Array;
  if (!Number.isSafeInteger(bytes.byteLength) || bytes.byteLength < 2
    || bytes.byteLength > maximumBytes || Reflect.ownKeys(bytes).length !== bytes.byteLength) {
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

function exactGitOid(value: unknown, expected: string): string {
  const result = exactString(value, expected);
  if (!GIT_OID_PATTERN.test(result)) throw new Error('invalid Git identity');
  return result;
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
 * Parses only the closed v3 schema for the corpus-v2 candidate attestation.
 * The retired v2 receipt (itself proven against the exact canonical v1 bytes)
 * supplies the immutable runtime policy and the retirement chain; the v3
 * binding carries the fresh candidate, corpus, and hosted-evidence identities
 * observed by the attested run. No fallback path parses v1 or v2 bytes as v3.
 */
export function parseAdmissionC2RuntimePolicyReceiptV3(
  receiptBytes: unknown,
  retiredV2ReceiptBytes: unknown,
  legacyV1ReceiptBytes: unknown,
): AdmissionC2RuntimePolicyReceiptV3 {
  requireCanonicalSerializationEnvironment();
  const retiredParsedBytes = snapshotBytes(retiredV2ReceiptBytes, RECEIPT_MAX_BYTES);
  const retired = parseAdmissionC2RuntimePolicyReceiptV2(retiredParsedBytes, legacyV1ReceiptBytes);
  const parsed = parseJsonBytes(receiptBytes, RECEIPT_MAX_BYTES);
  const root = closedRecord(parsed.value, [
    'schemaVersion', 'receiptVersion', 'hashScope', 'retiredReceipt', 'policy', 'binding',
    'receiptSha256',
  ]);
  exactString(root.schemaVersion, 'memberry.admission-c2-runtime-policy-receipt.v3');
  exactString(root.receiptVersion, '3.0.0');
  exactString(root.hashScope, 'sha256-canonical-json-without-receiptSha256');

  const rawRetired = closedRecord(root.retiredReceipt, [
    'schemaVersion', 'receiptSha256', 'canonicalBytesSha256',
  ]);
  const retiredReceipt = Object.freeze({
    schemaVersion: exactString(rawRetired.schemaVersion, V2_SCHEMA) as typeof V2_SCHEMA,
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
  const repositoryRootTreeOid = exactGitOid(
    rawBinding.repositoryRootTreeOid,
    REPOSITORY_ROOT_TREE_OID,
  );
  const candidateSubtreeOid = exactGitOid(rawBinding.candidateSubtreeOid, CANDIDATE_SUBTREE_OID);
  if (repositoryRootTreeOid === candidateSubtreeOid) throw new Error('tree identities must be distinct');
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
    candidateCommitSha: exactGitOid(rawBinding.candidateCommitSha, CANDIDATE_COMMIT_SHA),
    repositoryRootTreeOid,
    candidateSubtreeOid,
    candidateSha256,
    sourceSha256,
    imageSha256: anySha256(rawBinding.imageSha256),
    imageConfigSha256: anySha256(rawBinding.imageConfigSha256),
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
    schemaVersion: 'memberry.admission-c2-runtime-policy-receipt.v3' as const,
    receiptVersion: '3.0.0' as const,
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

function parseHostedEvidenceV3(receipt: AdmissionC2RuntimePolicyReceiptV3, bytes: unknown): unknown {
  const parsed = parseJsonBytes(bytes, EVIDENCE_MAX_BYTES);
  if (sha256(parsed.bytes) !== receipt.binding.hostedEvidence.evidenceFileSha256) {
    throw new Error('hosted evidence file hash mismatch');
  }
  const raw = closedRecord(parsed.value, [
    'schemaVersion', 'ok', 'cleanupVerified', 'scenarioCount', 'devScenarioCount',
    'holdoutScenarioCount', 'baseImage', 'candidateSha256', 'sourceSha256', 'imageSha256',
    'imageConfigSha256', 'nodeSha256', 'rootFsLayerSha256', 'inputSha256', 'outputSha256',
  ]);
  const evidence = {
    schemaVersion: exactString(raw.schemaVersion, receipt.binding.hostedEvidence.evidenceSchemaVersion),
    ok: exactTrue(raw.ok),
    cleanupVerified: exactTrue(raw.cleanupVerified),
    scenarioCount: exactInteger(raw.scenarioCount, SCENARIO_COUNT),
    devScenarioCount: exactInteger(raw.devScenarioCount, DEV_SCENARIO_COUNT),
    holdoutScenarioCount: exactInteger(raw.holdoutScenarioCount, HOLDOUT_SCENARIO_COUNT),
    baseImage: exactString(raw.baseImage, receipt.policy.baseImage),
    candidateSha256: exactString(raw.candidateSha256, receipt.binding.candidateSha256),
    sourceSha256: exactString(raw.sourceSha256, receipt.binding.sourceSha256),
    imageSha256: exactString(raw.imageSha256, receipt.binding.imageSha256),
    imageConfigSha256: exactString(raw.imageConfigSha256, receipt.binding.imageConfigSha256),
    nodeSha256: exactString(raw.nodeSha256, receipt.binding.nodeSha256),
    rootFsLayerSha256: sha256Layers(raw.rootFsLayerSha256).map((layer, index) => exactString(
      layer,
      receipt.binding.rootFsLayerSha256[index]!,
    )),
    inputSha256: exactString(raw.inputSha256, receipt.binding.inputSha256),
    outputSha256: exactString(raw.outputSha256, receipt.binding.outputSha256),
  };
  if (parsed.text !== `${JSON.stringify(evidence)}\n`) throw new Error('invalid hosted evidence');
  return evidence;
}

function parseWorkflowEvidenceV3(receipt: AdmissionC2RuntimePolicyReceiptV3, bytes: unknown): unknown {
  const parsed = parseJsonBytes(bytes, EVIDENCE_MAX_BYTES);
  if (sha256(parsed.bytes) !== receipt.binding.hostedEvidence.workflowFileSha256) {
    throw new Error('workflow evidence file hash mismatch');
  }
  const raw = closedRecord(parsed.value, ['repository', 'sha', 'run_id', 'run_attempt']);
  const workflow = {
    repository: exactString(raw.repository, receipt.binding.hostedEvidence.repository),
    sha: exactString(raw.sha, receipt.binding.candidateCommitSha),
    run_id: exactString(raw.run_id, receipt.binding.hostedEvidence.workflowRunId),
    run_attempt: exactString(raw.run_attempt, String(receipt.binding.hostedEvidence.workflowRunAttempt)),
  };
  if (parsed.text !== `${JSON.stringify(workflow)}\n`) throw new Error('noncanonical workflow evidence');
  return workflow;
}

export function verifyAdmissionC2HostedEvidenceV3(
  receipt: AdmissionC2RuntimePolicyReceiptV3,
  evidenceBytes: unknown,
  workflowBytes: unknown,
): boolean {
  try {
    if (!REGISTERED_RECEIPTS.has(receipt)) return false;
    parseHostedEvidenceV3(receipt, evidenceBytes);
    parseWorkflowEvidenceV3(receipt, workflowBytes);
    return true;
  } catch {
    return false;
  }
}
