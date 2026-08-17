import { createHash } from 'node:crypto';
import { types as nodeUtilTypes } from 'node:util';

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const RECEIPT_MAX_BYTES = 16_384;
const EVIDENCE_MAX_BYTES = 8_192;
const REGISTERED_RECEIPTS = new WeakSet<object>();

export interface AdmissionC2RuntimePolicyReceiptV1 {
  readonly schemaVersion: 'memberry.admission-c2-runtime-policy-receipt.v1';
  readonly receiptVersion: '1.0.0';
  readonly hashScope: 'sha256-canonical-json-without-receiptSha256';
  readonly policy: Readonly<{
    platform: 'linux/amd64';
    baseImage: string;
    pull: 'never';
    network: 'none';
    user: '65532:65532';
    environment: Readonly<{ LANG: 'C.UTF-8'; LC_ALL: 'C.UTF-8'; TZ: 'UTC' }>;
    rootFilesystem: 'read-only';
    mounts: Readonly<{ count: 0; tmpfs: readonly [] }>;
    capabilities: readonly [];
    noNewPrivileges: true;
    limits: Readonly<{
      cpu: '0.5'; memory: '128m'; memorySwap: '128m'; pids: 32; timeoutMs: 5000;
      stdinBytes: 32768; stdoutBytes: 32768; stderrBytes: 1024;
    }>;
    stdinTransport: 'attached-stdin';
    entrypoint: '/usr/local/bin/node';
    arguments: readonly [
      '--permission', '--allow-fs-write=/tmp/memberry-sandbox-write-probe',
      '--disable-proto=throw', '/app/worker.mjs', '-',
    ];
    stop: Readonly<{ action: 'docker container kill by inspected ID'; grace: 'none' }>;
  }>;
  readonly binding: Readonly<{
    candidateCommitSha: string;
    candidateTreeOid: string;
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
      workflowRunAttempt: 1;
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

function snapshotBytes(value: unknown, maximum: number): Uint8Array {
  if (typeof value !== 'object' || value === null || nodeUtilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Uint8Array.prototype) throw new Error('invalid receipt bytes');
  const bytes = value as Uint8Array;
  if (!Number.isSafeInteger(bytes.byteLength) || bytes.byteLength < 2 || bytes.byteLength > maximum
    || Reflect.ownKeys(bytes).length !== bytes.byteLength) throw new Error('invalid receipt bytes');
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

function parseJsonBytes(value: unknown, maximum: number): { value: unknown; bytes: Uint8Array; text: string } {
  const bytes = snapshotBytes(value, maximum);
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

function exactString(value: unknown, expected?: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')
    || (expected !== undefined && value !== expected)) throw new Error('invalid receipt string');
  return value;
}

function exactInteger(value: unknown, expected: number): number {
  if (value !== expected) throw new Error('invalid receipt integer');
  return expected;
}

function exactTrue(value: unknown): true {
  if (value !== true) throw new Error('invalid receipt boolean');
  return true;
}

function exactStringArray(value: unknown, expected?: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || Reflect.ownKeys(value).length !== value.length + 1) throw new Error('invalid receipt array');
  const result = value.map((entry, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || descriptor.enumerable !== true || descriptor.configurable !== true
      || descriptor.writable !== true) throw new Error('invalid receipt array descriptor');
    return exactString(descriptor.value, expected?.[index]);
  });
  if (expected !== undefined && result.length !== expected.length) throw new Error('invalid receipt array');
  return Object.freeze(result);
}

function exactSha256(value: unknown): `sha256:${string}` {
  const result = exactString(value);
  if (!SHA256_PATTERN.test(result)) throw new Error('invalid SHA-256 identity');
  return result as `sha256:${string}`;
}

function exactCommit(value: unknown, expected?: string): string {
  const result = exactString(value, expected);
  if (!COMMIT_PATTERN.test(result)) throw new Error('invalid Git identity');
  return result;
}

export function parseAdmissionC2RuntimePolicyReceiptV1(
  receiptBytes: unknown,
): AdmissionC2RuntimePolicyReceiptV1 {
  const parsed = parseJsonBytes(receiptBytes, RECEIPT_MAX_BYTES);
  const root = closedRecord(parsed.value, [
    'schemaVersion', 'receiptVersion', 'hashScope', 'policy', 'binding', 'receiptSha256',
  ]);
  exactString(root.schemaVersion, 'memberry.admission-c2-runtime-policy-receipt.v1');
  exactString(root.receiptVersion, '1.0.0');
  exactString(root.hashScope, 'sha256-canonical-json-without-receiptSha256');

  const rawPolicy = closedRecord(root.policy, [
    'platform', 'baseImage', 'pull', 'network', 'user', 'environment', 'rootFilesystem',
    'mounts', 'capabilities', 'noNewPrivileges', 'limits', 'stdinTransport', 'entrypoint',
    'arguments', 'stop',
  ]);
  const rawEnvironment = closedRecord(rawPolicy.environment, ['LANG', 'LC_ALL', 'TZ']);
  const rawMounts = closedRecord(rawPolicy.mounts, ['count', 'tmpfs']);
  const rawLimits = closedRecord(rawPolicy.limits, [
    'cpu', 'memory', 'memorySwap', 'pids', 'timeoutMs', 'stdinBytes', 'stdoutBytes', 'stderrBytes',
  ]);
  const rawStop = closedRecord(rawPolicy.stop, ['action', 'grace']);
  const policy = Object.freeze({
    platform: exactString(rawPolicy.platform, 'linux/amd64') as 'linux/amd64',
    baseImage: exactString(
      rawPolicy.baseImage,
      'node@sha256:7eb2c0c4b8cf6fd761f0e6a7fed8d3b8ad59186848f0eee59744e546f1b6a3e9',
    ),
    pull: exactString(rawPolicy.pull, 'never') as 'never',
    network: exactString(rawPolicy.network, 'none') as 'none',
    user: exactString(rawPolicy.user, '65532:65532') as '65532:65532',
    environment: Object.freeze({
      LANG: exactString(rawEnvironment.LANG, 'C.UTF-8') as 'C.UTF-8',
      LC_ALL: exactString(rawEnvironment.LC_ALL, 'C.UTF-8') as 'C.UTF-8',
      TZ: exactString(rawEnvironment.TZ, 'UTC') as 'UTC',
    }),
    rootFilesystem: exactString(rawPolicy.rootFilesystem, 'read-only') as 'read-only',
    mounts: Object.freeze({
      count: exactInteger(rawMounts.count, 0) as 0,
      tmpfs: exactStringArray(rawMounts.tmpfs, []) as readonly [],
    }),
    capabilities: exactStringArray(rawPolicy.capabilities, []) as readonly [],
    noNewPrivileges: exactTrue(rawPolicy.noNewPrivileges),
    limits: Object.freeze({
      cpu: exactString(rawLimits.cpu, '0.5') as '0.5',
      memory: exactString(rawLimits.memory, '128m') as '128m',
      memorySwap: exactString(rawLimits.memorySwap, '128m') as '128m',
      pids: exactInteger(rawLimits.pids, 32) as 32,
      timeoutMs: exactInteger(rawLimits.timeoutMs, 5_000) as 5000,
      stdinBytes: exactInteger(rawLimits.stdinBytes, 32_768) as 32768,
      stdoutBytes: exactInteger(rawLimits.stdoutBytes, 32_768) as 32768,
      stderrBytes: exactInteger(rawLimits.stderrBytes, 1_024) as 1024,
    }),
    stdinTransport: exactString(rawPolicy.stdinTransport, 'attached-stdin') as 'attached-stdin',
    entrypoint: exactString(rawPolicy.entrypoint, '/usr/local/bin/node') as '/usr/local/bin/node',
    arguments: exactStringArray(rawPolicy.arguments, [
      '--permission', '--allow-fs-write=/tmp/memberry-sandbox-write-probe',
      '--disable-proto=throw', '/app/worker.mjs', '-',
    ]) as AdmissionC2RuntimePolicyReceiptV1['policy']['arguments'],
    stop: Object.freeze({
      action: exactString(rawStop.action, 'docker container kill by inspected ID') as 'docker container kill by inspected ID',
      grace: exactString(rawStop.grace, 'none') as 'none',
    }),
  });
  const rawBinding = closedRecord(root.binding, [
    'candidateCommitSha', 'candidateTreeOid', 'candidateSha256', 'sourceSha256', 'imageSha256',
    'imageConfigSha256', 'nodeSha256', 'rootFsLayerSha256', 'inputSha256', 'outputSha256',
    'hostedEvidence',
  ]);
  const rawHosted = closedRecord(rawBinding.hostedEvidence, [
    'repository', 'workflowRunId', 'workflowRunAttempt', 'artifactId', 'artifactName',
    'artifactSha256', 'evidenceSchemaVersion', 'evidenceFileSha256', 'workflowFileSha256',
    'cleanupVerified',
  ]);
  const layers = exactStringArray(rawBinding.rootFsLayerSha256).map(exactSha256);
  if (layers.length !== 6) throw new Error('invalid rootfs identity');
  const binding = Object.freeze({
    candidateCommitSha: exactCommit(
      rawBinding.candidateCommitSha,
      '5a111761668d9370d5163f64e195f0dda44b55af',
    ),
    candidateTreeOid: exactCommit(rawBinding.candidateTreeOid, '94c75dd3a36a708ce6add1f10eaf606fa4ffea8d'),
    candidateSha256: exactSha256(rawBinding.candidateSha256),
    sourceSha256: exactSha256(rawBinding.sourceSha256),
    imageSha256: exactSha256(rawBinding.imageSha256),
    imageConfigSha256: exactSha256(rawBinding.imageConfigSha256),
    nodeSha256: exactSha256(rawBinding.nodeSha256),
    rootFsLayerSha256: Object.freeze(layers),
    inputSha256: exactSha256(rawBinding.inputSha256),
    outputSha256: exactSha256(rawBinding.outputSha256),
    hostedEvidence: Object.freeze({
      repository: exactString(rawHosted.repository, 'AP3X-Dev/memberry') as 'AP3X-Dev/memberry',
      workflowRunId: exactString(rawHosted.workflowRunId, '31988943734'),
      workflowRunAttempt: exactInteger(rawHosted.workflowRunAttempt, 1) as 1,
      artifactId: exactString(rawHosted.artifactId, '9274710637'),
      artifactName: exactString(
        rawHosted.artifactName,
        'memberry-admission-candidate-live-31988943734-1',
      ),
      artifactSha256: exactSha256(rawHosted.artifactSha256),
      evidenceSchemaVersion: exactString(
        rawHosted.evidenceSchemaVersion,
        'memberry.admission-feature-candidate-live-evidence.v1',
      ) as 'memberry.admission-feature-candidate-live-evidence.v1',
      evidenceFileSha256: exactSha256(rawHosted.evidenceFileSha256),
      workflowFileSha256: exactSha256(rawHosted.workflowFileSha256),
      cleanupVerified: exactTrue(rawHosted.cleanupVerified),
    }),
  });

  const payload = Object.freeze({
    schemaVersion: 'memberry.admission-c2-runtime-policy-receipt.v1' as const,
    receiptVersion: '1.0.0' as const,
    hashScope: 'sha256-canonical-json-without-receiptSha256' as const,
    policy,
    binding,
  });
  const receiptSha256 = exactSha256(root.receiptSha256);
  if (receiptSha256 !== sha256(JSON.stringify(payload))) throw new Error('receipt hash mismatch');
  const receipt = Object.freeze({ ...payload, receiptSha256 });
  if (parsed.text !== `${JSON.stringify(receipt)}\n`) throw new Error('noncanonical receipt');
  REGISTERED_RECEIPTS.add(receipt);
  return receipt;
}

function parseHostedEvidence(receipt: AdmissionC2RuntimePolicyReceiptV1, bytes: unknown): unknown {
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
    ok: raw.ok,
    cleanupVerified: raw.cleanupVerified,
    scenarioCount: exactInteger(raw.scenarioCount, 6),
    devScenarioCount: exactInteger(raw.devScenarioCount, 3),
    holdoutScenarioCount: exactInteger(raw.holdoutScenarioCount, 3),
    baseImage: exactString(raw.baseImage, receipt.policy.baseImage),
    candidateSha256: exactString(raw.candidateSha256, receipt.binding.candidateSha256),
    sourceSha256: exactString(raw.sourceSha256, receipt.binding.sourceSha256),
    imageSha256: exactString(raw.imageSha256, receipt.binding.imageSha256),
    imageConfigSha256: exactString(raw.imageConfigSha256, receipt.binding.imageConfigSha256),
    nodeSha256: exactString(raw.nodeSha256, receipt.binding.nodeSha256),
    rootFsLayerSha256: exactStringArray(raw.rootFsLayerSha256, receipt.binding.rootFsLayerSha256),
    inputSha256: exactString(raw.inputSha256, receipt.binding.inputSha256),
    outputSha256: exactString(raw.outputSha256, receipt.binding.outputSha256),
  };
  if (raw.ok !== true || raw.cleanupVerified !== true || parsed.text !== `${JSON.stringify(evidence)}\n`) {
    throw new Error('invalid hosted evidence');
  }
  return evidence;
}

function parseWorkflowEvidence(receipt: AdmissionC2RuntimePolicyReceiptV1, bytes: unknown): unknown {
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

export function verifyAdmissionC2HostedEvidenceV1(
  receipt: AdmissionC2RuntimePolicyReceiptV1,
  evidenceBytes: unknown,
  workflowBytes: unknown,
): boolean {
  try {
    if (!REGISTERED_RECEIPTS.has(receipt)) return false;
    parseHostedEvidence(receipt, evidenceBytes);
    parseWorkflowEvidence(receipt, workflowBytes);
    return true;
  } catch {
    return false;
  }
}

function dataProperty(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || nodeUtilTypes.isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error('invalid hosted metadata object');
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    throw new Error('invalid hosted metadata descriptor');
  }
  return descriptor.value;
}

/**
 * Verifies the content-free GitHub Actions artifact metadata returned by the
 * repository API. Extra API fields are ignored only after the required fields
 * have been read as own data properties without invoking accessors.
 */
export function verifyAdmissionC2HostedArtifactMetadataV1(
  receipt: AdmissionC2RuntimePolicyReceiptV1,
  metadata: unknown,
): boolean {
  try {
    if (!REGISTERED_RECEIPTS.has(receipt)) return false;
    const workflow = dataProperty(metadata, 'workflow_run');
    return dataProperty(metadata, 'id') === Number(receipt.binding.hostedEvidence.artifactId)
      && dataProperty(metadata, 'name') === receipt.binding.hostedEvidence.artifactName
      && dataProperty(metadata, 'digest') === receipt.binding.hostedEvidence.artifactSha256
      && dataProperty(metadata, 'expired') === false
      && dataProperty(workflow, 'id') === Number(receipt.binding.hostedEvidence.workflowRunId)
      && dataProperty(workflow, 'head_sha') === receipt.binding.candidateCommitSha
      && dataProperty(workflow, 'head_branch') === 'master';
  } catch {
    return false;
  }
}
