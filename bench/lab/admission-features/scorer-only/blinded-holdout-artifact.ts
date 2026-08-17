import { createHash } from 'node:crypto';
import { types as nodeUtilTypes } from 'node:util';

export const BLINDED_HOLDOUT_ARTIFACT_VERSION = '1.0.0' as const;
export const BLINDED_HOLDOUT_INTEGRATED_BASE_SHA = 'ac7372587044f539837827006052b15c65cac163' as const;
export const BLINDED_HOLDOUT_CANDIDATE_COMMIT_SHA = '5a111761668d9370d5163f64e195f0dda44b55af' as const;
export const BLINDED_HOLDOUT_CANDIDATE_TREE_OID = '94c75dd3a36a708ce6add1f10eaf606fa4ffea8d' as const;
export const BLINDED_HOLDOUT_INPUT_SHA256 =
  'sha256:41ef02bbe9df03e4f7b4f95b248265a71635aefa7cbe69c585a1eb8647936b24' as const;
export const BLINDED_HOLDOUT_ORACLE_SHA256 =
  'sha256:3a50b28cba28aa451967b3fbf3bcddfcc8c8f13f11c806cada1096d1f2807574' as const;
export const BLINDED_HOLDOUT_POLICY_RECEIPT_SHA256 =
  'sha256:5cc51d393a75d78854d408ea95aa1dcdc533f095e0feb562741d1b20ef8e7681' as const;
export const BLINDED_HOLDOUT_BASE_IMAGE =
  'node@sha256:7eb2c0c4b8cf6fd761f0e6a7fed8d3b8ad59186848f0eee59744e546f1b6a3e9' as const;
export const BLINDED_HOLDOUT_PLATFORM = 'linux/amd64' as const;

const CANDIDATE_SHA256 = 'sha256:474459f8359fe8a117547453dc1e728b4aab9a69f69f7faa4cf188e27e4742ca' as const;
const SOURCE_SHA256 = 'sha256:b8d5c385ed3ae3a3b0cb4c1212d601fbd23dc4a9d26f0765b9b314dc62b1b513' as const;
const IMAGE_SHA256 = 'sha256:a1cd73a3036419932ff777d0418690831495059a09d3ffbf9ae68b668d695843' as const;
const IMAGE_CONFIG_SHA256 = 'sha256:8b7290e652f24385d03b1190ba5d8522b50dcdc3181e06806165f09a5c40d1b2' as const;
const NODE_SHA256 = 'sha256:34347794817b8e5d2ac54e93131ac8456f2c37cf1e752dcd6ec8e8314c7ae4a4' as const;
const ROOT_FS_LAYER_SHA256 = Object.freeze([
  'sha256:cce92674e98722970ab3fdce76a2566f54db535beeb24f0b4397f070ab5f6987',
  'sha256:7caa14a5f75323e9d5aff5b7db25d8540e148e6344f829013e94dd3349324891',
  'sha256:05a5275213a25f7ac29087f5731944eb9cefe4f8bffd1a9c4617be35aeaa39c8',
  'sha256:b6ad516e7aba450d913b5495228e48f1883673a610e7be80522be720b0b121fe',
  'sha256:065b4018a258c14d5b5554ddd0c814c55a213e934271aa7c65c58e1769310e8e',
  'sha256:39a045d2d8c0b1942257ae49a5311b74ca0bfec46f3a4ea13ab2291c0ce11464',
] as const);

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/;
const MAX_RECEIPT_BYTES = 16_384;
const REGISTERED_RUNTIME_EVIDENCE = new WeakSet<object>();
const REGISTERED_RECEIPTS = new WeakSet<object>();

export interface BlindedHoldoutAggregateV1 {
  readonly scenarioCount: number;
  readonly dimensionCount: number;
  readonly agreementCount: number;
  readonly agreementPermille: number;
  readonly availabilityMismatchCount: number;
  readonly valueMismatchCount: number;
  readonly passed: boolean;
}

export interface BlindedHoldoutRuntimeEvidenceV1 {
  readonly nodeMajor: 20 | 22;
  readonly evidenceMode: 'sealed-candidate-prediction';
  readonly candidateRunCount: 1;
  readonly candidateStoppedBeforeOracle: true;
  readonly predictionSha256: `sha256:${string}`;
  readonly aggregate: BlindedHoldoutAggregateV1;
  readonly evidenceSha256: `sha256:${string}`;
}

export interface BlindedHoldoutCleanupV1 {
  readonly candidateStopped: true;
  readonly containerRemoved: true;
  readonly imageRemoved: true;
  readonly predictionRemoved: true;
  readonly temporaryFilesRemoved: true;
  readonly noRawArtifactsPublished: true;
}

export interface BlindedHoldoutReceiptV1 {
  readonly schemaVersion: 'memberry.admission-feature-blinded-holdout-receipt.v1';
  readonly receiptVersion: typeof BLINDED_HOLDOUT_ARTIFACT_VERSION;
  readonly packetId: 'MEM-002C3';
  readonly evidenceMode: 'blinded-holdout';
  readonly oneShotKey: `sha256:${string}`;
  readonly policyReceiptSha256: typeof BLINDED_HOLDOUT_POLICY_RECEIPT_SHA256;
  readonly integratedBaseSha: typeof BLINDED_HOLDOUT_INTEGRATED_BASE_SHA;
  readonly evaluatedCommitSha: string;
  readonly candidateCommitSha: typeof BLINDED_HOLDOUT_CANDIDATE_COMMIT_SHA;
  readonly candidateTreeOid: typeof BLINDED_HOLDOUT_CANDIDATE_TREE_OID;
  readonly candidateSha256: typeof CANDIDATE_SHA256;
  readonly sourceSha256: typeof SOURCE_SHA256;
  readonly imageSha256: typeof IMAGE_SHA256;
  readonly imageConfigSha256: typeof IMAGE_CONFIG_SHA256;
  readonly nodeSha256: typeof NODE_SHA256;
  readonly rootFsLayerSha256: typeof ROOT_FS_LAYER_SHA256;
  readonly platform: typeof BLINDED_HOLDOUT_PLATFORM;
  readonly baseImage: typeof BLINDED_HOLDOUT_BASE_IMAGE;
  readonly inputSha256: typeof BLINDED_HOLDOUT_INPUT_SHA256;
  readonly oracleSha256: typeof BLINDED_HOLDOUT_ORACLE_SHA256;
  readonly scorerSha256: `sha256:${string}`;
  readonly predictionSha256: `sha256:${string}`;
  readonly startReceiptSha256: `sha256:${string}`;
  readonly tombstone: Readonly<{
    ref: `refs/tags/memberry-mem002c3-burn/${string}`;
    targetSha: string;
    preexisting: false;
    creationStatus: 201;
    verificationStatus: 200;
  }>;
  readonly workflow: Readonly<{
    repository: 'AP3X-Dev/memberry';
    runId: string;
    runAttempt: 1;
    priorAuthoritativeReceiptCount: 0;
  }>;
  readonly candidateRunCount: 1;
  readonly runtimes: readonly [BlindedHoldoutRuntimeEvidenceV1, BlindedHoldoutRuntimeEvidenceV1];
  readonly aggregate: BlindedHoldoutAggregateV1;
  readonly cleanup: BlindedHoldoutCleanupV1;
  readonly outcome: 'passed' | 'failed';
  readonly receiptSha256: `sha256:${string}`;
}

export class BlindedHoldoutArtifactError extends Error {
  constructor(readonly code: string) {
    super(`mem002c3_artifact:${code}`);
    this.name = 'BlindedHoldoutArtifactError';
  }
}

function fail(code: string): never {
  throw new BlindedHoldoutArtifactError(code);
}

function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function exactSha256(value: unknown): `sha256:${string}` {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) fail('identity');
  return value as `sha256:${string}`;
}

function exactCommit(value: unknown): string {
  if (typeof value !== 'string' || !COMMIT_PATTERN.test(value)) fail('identity');
  return value;
}

function exactInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail('aggregate');
  }
  return value as number;
}

function closedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeUtilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) fail('shape');
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    fail('shape');
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) fail('shape');
    result[key] = descriptor.value;
  }
  return result;
}

function aggregate(value: BlindedHoldoutAggregateV1): BlindedHoldoutAggregateV1 {
  const record = closedRecord(value, [
    'scenarioCount', 'dimensionCount', 'agreementCount', 'agreementPermille',
    'availabilityMismatchCount', 'valueMismatchCount', 'passed',
  ]);
  const scenarioCount = exactInteger(record.scenarioCount, 3, 3);
  const dimensionCount = exactInteger(record.dimensionCount, 18, 18);
  const agreementCount = exactInteger(record.agreementCount, 0, 18);
  const agreementPermille = exactInteger(record.agreementPermille, 0, 1_000);
  const availabilityMismatchCount = exactInteger(record.availabilityMismatchCount, 0, 18);
  const valueMismatchCount = exactInteger(record.valueMismatchCount, 0, 18);
  const passed = record.passed;
  const expectedPermille = Math.floor((agreementCount * 1_000) / dimensionCount);
  const exactPass = agreementCount === 18 && agreementPermille === 1_000
    && availabilityMismatchCount === 0 && valueMismatchCount === 0;
  if (agreementPermille !== expectedPermille
    || availabilityMismatchCount + valueMismatchCount !== dimensionCount - agreementCount
    || typeof passed !== 'boolean' || passed !== exactPass) fail('aggregate');
  return Object.freeze({
    scenarioCount,
    dimensionCount,
    agreementCount,
    agreementPermille,
    availabilityMismatchCount,
    valueMismatchCount,
    passed,
  });
}

export function createBlindedHoldoutRuntimeEvidenceV1(options: {
  nodeMajor: 20 | 22;
  evidenceMode: 'sealed-candidate-prediction';
  candidateRunCount: 1;
  candidateStoppedBeforeOracle: true;
  predictionSha256: `sha256:${string}`;
  aggregate: BlindedHoldoutAggregateV1;
}): BlindedHoldoutRuntimeEvidenceV1 {
  if (options.nodeMajor !== 20 && options.nodeMajor !== 22) fail('runtime');
  if (options.evidenceMode !== 'sealed-candidate-prediction') fail('runtime');
  if (options.candidateRunCount !== 1 || options.candidateStoppedBeforeOracle !== true) fail('runtime');
  const payload = Object.freeze({
    nodeMajor: options.nodeMajor,
    evidenceMode: options.evidenceMode,
    candidateRunCount: options.candidateRunCount,
    candidateStoppedBeforeOracle: options.candidateStoppedBeforeOracle,
    predictionSha256: exactSha256(options.predictionSha256),
    aggregate: aggregate(options.aggregate),
  });
  const evidence = Object.freeze({ ...payload, evidenceSha256: sha256(JSON.stringify(payload)) });
  REGISTERED_RUNTIME_EVIDENCE.add(evidence);
  return evidence;
}

export function canonicalBlindedHoldoutRuntimeEvidenceV1(evidence: BlindedHoldoutRuntimeEvidenceV1): string {
  if (!REGISTERED_RUNTIME_EVIDENCE.has(evidence)) fail('unregistered_runtime');
  const canonical = `${JSON.stringify(evidence)}\n`;
  secretSafe(canonical);
  return canonical;
}

export function parseBlindedHoldoutRuntimeEvidenceV1(bytes: unknown): BlindedHoldoutRuntimeEvidenceV1 {
  const copy = snapshotBytes(bytes);
  let text: string;
  let raw: Record<string, unknown>;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(copy);
    if (!text.endsWith('\n') || text.includes('\r') || text.slice(0, -1).includes('\n')) fail('canonical');
    raw = closedRecord(JSON.parse(text.slice(0, -1)) as unknown, [
      'nodeMajor', 'evidenceMode', 'candidateRunCount', 'candidateStoppedBeforeOracle',
      'predictionSha256', 'aggregate', 'evidenceSha256',
    ]);
  } catch (error) {
    if (error instanceof BlindedHoldoutArtifactError) throw error;
    fail('canonical');
  }
  const evidence = createBlindedHoldoutRuntimeEvidenceV1({
    nodeMajor: raw.nodeMajor as 20 | 22,
    evidenceMode: raw.evidenceMode as 'sealed-candidate-prediction',
    candidateRunCount: raw.candidateRunCount as 1,
    candidateStoppedBeforeOracle: raw.candidateStoppedBeforeOracle as true,
    predictionSha256: raw.predictionSha256 as `sha256:${string}`,
    aggregate: raw.aggregate as BlindedHoldoutAggregateV1,
  });
  if (evidence.evidenceSha256 !== raw.evidenceSha256
    || canonicalBlindedHoldoutRuntimeEvidenceV1(evidence) !== text) fail('hash');
  return evidence;
}

export function blindedHoldoutOneShotKeyV1(): `sha256:${string}` {
  return sha256(JSON.stringify({
    schemaVersion: 'memberry.admission-feature-blinded-holdout-key.v1',
    candidateCommitSha: BLINDED_HOLDOUT_CANDIDATE_COMMIT_SHA,
    candidateTreeOid: BLINDED_HOLDOUT_CANDIDATE_TREE_OID,
    inputSha256: BLINDED_HOLDOUT_INPUT_SHA256,
    oracleSha256: BLINDED_HOLDOUT_ORACLE_SHA256,
    policyReceiptSha256: BLINDED_HOLDOUT_POLICY_RECEIPT_SHA256,
  }));
}

function cleanup(value: BlindedHoldoutCleanupV1): BlindedHoldoutCleanupV1 {
  const record = closedRecord(value, [
    'candidateStopped', 'containerRemoved', 'imageRemoved', 'predictionRemoved',
    'temporaryFilesRemoved', 'noRawArtifactsPublished',
  ]);
  if (Object.values(record).some((entry) => entry !== true)) fail('cleanup');
  return Object.freeze({
    candidateStopped: true,
    containerRemoved: true,
    imageRemoved: true,
    predictionRemoved: true,
    temporaryFilesRemoved: true,
    noRawArtifactsPublished: true,
  });
}

function secretSafe(canonical: string): void {
  if (/"(?:scenarioId|features|dimensions|valuePermille|fixtureCode|predictions|stdout|stderr|rawPrediction)"/i.test(canonical)
    || /af-(?:dev|holdout)-[0-9]|case-[0-9]/i.test(canonical)) fail('secret_safety');
}

export function buildBlindedHoldoutReceiptV1(options: {
  evaluatedCommitSha: string;
  scorerSha256: `sha256:${string}`;
  predictionSha256: `sha256:${string}`;
  startReceiptSha256: `sha256:${string}`;
  tombstone: Readonly<{
    ref: `refs/tags/memberry-mem002c3-burn/${string}`;
    targetSha: string;
    preexisting: false;
    creationStatus: 201;
    verificationStatus: 200;
  }>;
  workflowRunId: string;
  workflowRunAttempt: 1;
  priorAuthoritativeReceiptCount: 0;
  candidateRunCount: 1;
  runtimes: readonly [BlindedHoldoutRuntimeEvidenceV1, BlindedHoldoutRuntimeEvidenceV1];
  cleanup: BlindedHoldoutCleanupV1;
}): BlindedHoldoutReceiptV1 {
  if (options.workflowRunAttempt !== 1) fail('attempt');
  if (options.priorAuthoritativeReceiptCount !== 0) fail('duplicate_attempt');
  if (options.candidateRunCount !== 1) fail('candidate_run_count');
  if (!RUN_ID_PATTERN.test(options.workflowRunId)) fail('attempt');
  if (!Array.isArray(options.runtimes) || options.runtimes.length !== 2
    || options.runtimes.some((entry) => !REGISTERED_RUNTIME_EVIDENCE.has(entry))) fail('runtime');
  const [node20, node22] = options.runtimes;
  if (node20.nodeMajor !== 20 || node22.nodeMajor !== 22) fail('runtime');
  const predictionSha256 = exactSha256(options.predictionSha256);
  if (node20.predictionSha256 !== predictionSha256 || node22.predictionSha256 !== predictionSha256) {
    fail('runtime_divergence');
  }
  if (JSON.stringify(node20.aggregate) !== JSON.stringify(node22.aggregate)) fail('runtime_divergence');
  const resultAggregate = aggregate(node20.aggregate);
  const evaluatedCommitSha = exactCommit(options.evaluatedCommitSha);
  const tombstone = closedRecord(options.tombstone, [
    'ref', 'targetSha', 'preexisting', 'creationStatus', 'verificationStatus',
  ]);
  const expectedTombstoneRef = `refs/tags/memberry-mem002c3-burn/${blindedHoldoutOneShotKeyV1().slice(7)}`;
  if (tombstone.ref !== expectedTombstoneRef || tombstone.targetSha !== evaluatedCommitSha
    || tombstone.preexisting !== false || tombstone.creationStatus !== 201
    || tombstone.verificationStatus !== 200) fail('tombstone');
  const payload = Object.freeze({
    schemaVersion: 'memberry.admission-feature-blinded-holdout-receipt.v1' as const,
    receiptVersion: BLINDED_HOLDOUT_ARTIFACT_VERSION,
    packetId: 'MEM-002C3' as const,
    evidenceMode: 'blinded-holdout' as const,
    oneShotKey: blindedHoldoutOneShotKeyV1(),
    policyReceiptSha256: BLINDED_HOLDOUT_POLICY_RECEIPT_SHA256,
    integratedBaseSha: BLINDED_HOLDOUT_INTEGRATED_BASE_SHA,
    evaluatedCommitSha,
    candidateCommitSha: BLINDED_HOLDOUT_CANDIDATE_COMMIT_SHA,
    candidateTreeOid: BLINDED_HOLDOUT_CANDIDATE_TREE_OID,
    candidateSha256: CANDIDATE_SHA256,
    sourceSha256: SOURCE_SHA256,
    imageSha256: IMAGE_SHA256,
    imageConfigSha256: IMAGE_CONFIG_SHA256,
    nodeSha256: NODE_SHA256,
    rootFsLayerSha256: ROOT_FS_LAYER_SHA256,
    platform: BLINDED_HOLDOUT_PLATFORM,
    baseImage: BLINDED_HOLDOUT_BASE_IMAGE,
    inputSha256: BLINDED_HOLDOUT_INPUT_SHA256,
    oracleSha256: BLINDED_HOLDOUT_ORACLE_SHA256,
    scorerSha256: exactSha256(options.scorerSha256),
    predictionSha256,
    startReceiptSha256: exactSha256(options.startReceiptSha256),
    tombstone: Object.freeze({
      ref: tombstone.ref as `refs/tags/memberry-mem002c3-burn/${string}`,
      targetSha: evaluatedCommitSha,
      preexisting: false as const,
      creationStatus: 201 as const,
      verificationStatus: 200 as const,
    }),
    workflow: Object.freeze({
      repository: 'AP3X-Dev/memberry' as const,
      runId: options.workflowRunId,
      runAttempt: 1 as const,
      priorAuthoritativeReceiptCount: 0 as const,
    }),
    candidateRunCount: 1 as const,
    runtimes: Object.freeze([node20, node22]) as readonly [BlindedHoldoutRuntimeEvidenceV1, BlindedHoldoutRuntimeEvidenceV1],
    aggregate: resultAggregate,
    cleanup: cleanup(options.cleanup),
    outcome: resultAggregate.passed ? 'passed' as const : 'failed' as const,
  });
  const receipt = Object.freeze({ ...payload, receiptSha256: sha256(JSON.stringify(payload)) });
  secretSafe(JSON.stringify(receipt));
  REGISTERED_RECEIPTS.add(receipt);
  return receipt;
}

export function canonicalBlindedHoldoutReceiptV1(receipt: BlindedHoldoutReceiptV1): string {
  if (!REGISTERED_RECEIPTS.has(receipt)) fail('unregistered');
  const canonical = `${JSON.stringify(receipt)}\n`;
  secretSafe(canonical);
  return canonical;
}

function snapshotBytes(value: unknown): Uint8Array {
  if (typeof value !== 'object' || value === null || nodeUtilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Uint8Array.prototype) fail('bytes');
  const bytes = value as Uint8Array;
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_RECEIPT_BYTES) fail('bytes');
  return Uint8Array.from(bytes);
}

export function parseBlindedHoldoutReceiptV1(bytes: unknown): BlindedHoldoutReceiptV1 {
  const copy = snapshotBytes(bytes);
  let text: string;
  let raw: Record<string, unknown>;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(copy);
    if (!text.endsWith('\n') || text.includes('\r') || text.slice(0, -1).includes('\n')) fail('canonical');
    raw = closedRecord(JSON.parse(text.slice(0, -1)) as unknown, [
      'schemaVersion', 'receiptVersion', 'packetId', 'evidenceMode', 'oneShotKey',
      'policyReceiptSha256', 'integratedBaseSha', 'evaluatedCommitSha', 'candidateCommitSha',
      'candidateTreeOid', 'candidateSha256', 'sourceSha256', 'imageSha256', 'imageConfigSha256',
      'nodeSha256', 'rootFsLayerSha256', 'platform', 'baseImage', 'inputSha256', 'oracleSha256',
      'scorerSha256', 'predictionSha256', 'startReceiptSha256', 'workflow', 'candidateRunCount',
      'tombstone', 'runtimes', 'aggregate', 'cleanup', 'outcome', 'receiptSha256',
    ]);
  } catch (error) {
    if (error instanceof BlindedHoldoutArtifactError) throw error;
    fail('canonical');
  }
  if (raw.schemaVersion !== 'memberry.admission-feature-blinded-holdout-receipt.v1'
    || raw.receiptVersion !== BLINDED_HOLDOUT_ARTIFACT_VERSION
    || raw.packetId !== 'MEM-002C3' || raw.evidenceMode !== 'blinded-holdout'
    || raw.oneShotKey !== blindedHoldoutOneShotKeyV1()
    || raw.policyReceiptSha256 !== BLINDED_HOLDOUT_POLICY_RECEIPT_SHA256
    || raw.integratedBaseSha !== BLINDED_HOLDOUT_INTEGRATED_BASE_SHA
    || raw.candidateCommitSha !== BLINDED_HOLDOUT_CANDIDATE_COMMIT_SHA
    || raw.candidateTreeOid !== BLINDED_HOLDOUT_CANDIDATE_TREE_OID
    || raw.candidateSha256 !== CANDIDATE_SHA256 || raw.sourceSha256 !== SOURCE_SHA256
    || raw.imageSha256 !== IMAGE_SHA256 || raw.imageConfigSha256 !== IMAGE_CONFIG_SHA256
    || raw.nodeSha256 !== NODE_SHA256 || raw.platform !== BLINDED_HOLDOUT_PLATFORM
    || raw.baseImage !== BLINDED_HOLDOUT_BASE_IMAGE || raw.inputSha256 !== BLINDED_HOLDOUT_INPUT_SHA256
    || raw.oracleSha256 !== BLINDED_HOLDOUT_ORACLE_SHA256) fail('identity');
  if (!Array.isArray(raw.rootFsLayerSha256)
    || JSON.stringify(raw.rootFsLayerSha256) !== JSON.stringify(ROOT_FS_LAYER_SHA256)) fail('identity');
  const workflow = closedRecord(raw.workflow, ['repository', 'runId', 'runAttempt', 'priorAuthoritativeReceiptCount']);
  if (workflow.repository !== 'AP3X-Dev/memberry' || workflow.runAttempt !== 1
    || workflow.priorAuthoritativeReceiptCount !== 0 || typeof workflow.runId !== 'string') fail('attempt');
  if (!Array.isArray(raw.runtimes) || raw.runtimes.length !== 2) fail('runtime');
  const reconstructed = raw.runtimes.map((entry) => {
    const value = closedRecord(entry, [
      'nodeMajor', 'evidenceMode', 'candidateRunCount', 'candidateStoppedBeforeOracle',
      'predictionSha256', 'aggregate', 'evidenceSha256',
    ]);
    const evidence = createBlindedHoldoutRuntimeEvidenceV1({
      nodeMajor: value.nodeMajor as 20 | 22,
      evidenceMode: value.evidenceMode as 'sealed-candidate-prediction',
      candidateRunCount: value.candidateRunCount as 1,
      candidateStoppedBeforeOracle: value.candidateStoppedBeforeOracle as true,
      predictionSha256: value.predictionSha256 as `sha256:${string}`,
      aggregate: value.aggregate as BlindedHoldoutAggregateV1,
    });
    if (evidence.evidenceSha256 !== value.evidenceSha256) fail('runtime');
    return evidence;
  }) as [BlindedHoldoutRuntimeEvidenceV1, BlindedHoldoutRuntimeEvidenceV1];
  const receipt = buildBlindedHoldoutReceiptV1({
    evaluatedCommitSha: raw.evaluatedCommitSha as string,
    scorerSha256: raw.scorerSha256 as `sha256:${string}`,
    predictionSha256: raw.predictionSha256 as `sha256:${string}`,
    startReceiptSha256: raw.startReceiptSha256 as `sha256:${string}`,
    tombstone: raw.tombstone as BlindedHoldoutReceiptV1['tombstone'],
    workflowRunId: workflow.runId as string,
    workflowRunAttempt: workflow.runAttempt as 1,
    priorAuthoritativeReceiptCount: workflow.priorAuthoritativeReceiptCount as 0,
    candidateRunCount: raw.candidateRunCount as 1,
    runtimes: reconstructed,
    cleanup: raw.cleanup as BlindedHoldoutCleanupV1,
  });
  if (receipt.receiptSha256 !== raw.receiptSha256 || canonicalBlindedHoldoutReceiptV1(receipt) !== text
    || JSON.stringify(receipt.aggregate) !== JSON.stringify(raw.aggregate) || receipt.outcome !== raw.outcome) {
    fail('hash');
  }
  return receipt;
}

export function blindedHoldoutReceiptIdentityV1(receipt: BlindedHoldoutReceiptV1): `sha256:${string}` {
  return sha256(canonicalBlindedHoldoutReceiptV1(receipt));
}
