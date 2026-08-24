import { createHash } from 'node:crypto';
import { types as nodeUtilTypes } from 'node:util';

const TRUSTED_IS_PROXY = nodeUtilTypes.isProxy;
const TRUSTED_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const TRUSTED_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const TRUSTED_OWN_KEYS = Reflect.ownKeys;
const TRUSTED_OBJECT_PROTOTYPE = Object.prototype;
const TRUSTED_REGEXP_TEST = Function.prototype.call.bind(RegExp.prototype.test) as (pattern: RegExp, value: string) => boolean;

export const BLINDED_HOLDOUT_ARTIFACT_VERSION = '2.0.0' as const;
export const BLINDED_HOLDOUT_INTEGRATED_BASE_SHA = 'ee4723bf0dccff5ffc7ba05ec5c6ba8ee9ed9bce' as const;
export const BLINDED_HOLDOUT_CANDIDATE_COMMIT_SHA = 'ee4723bf0dccff5ffc7ba05ec5c6ba8ee9ed9bce' as const;
export const BLINDED_HOLDOUT_REPOSITORY_ROOT_TREE_OID = 'f6cc81d7b754778be7b772aa3ecddf6ec8e804d7' as const;
export const BLINDED_HOLDOUT_HISTORICAL_CANDIDATE_SUBTREE_OID = '08ce328eca824de833d9f762950b4b008a13f723' as const;
export const BLINDED_HOLDOUT_CURRENT_CHECKOUT_CANDIDATE_SUBTREE_OID = '08ce328eca824de833d9f762950b4b008a13f723' as const;
export const BLINDED_HOLDOUT_INPUT_SHA256 = 'sha256:457d5483b8c22f62415f5952ffa743936f0b34348cf72bafe315dd8432448428' as const;
export const BLINDED_HOLDOUT_ORACLE_SHA256 = 'sha256:840bc97373705daad00d0caa830335e07cfd54671437a7628a0f4e451c672441' as const;
export const BLINDED_HOLDOUT_POLICY_RECEIPT_SHA256 = 'sha256:2a87f47eed1236fbc41b368ca146597993f0d6ed787637f3fb951e029d9422b5' as const;
export const BLINDED_HOLDOUT_POLICY_RECEIPT_CANONICAL_BYTES_SHA256 =
  'sha256:f8c5ade63a13b24c5abfd39432f358651cf4fc9acf9ec50b33b2e482c9b5ab3c' as const;
export const BLINDED_HOLDOUT_BASE_IMAGE = 'node@sha256:7eb2c0c4b8cf6fd761f0e6a7fed8d3b8ad59186848f0eee59744e546f1b6a3e9' as const;
export const BLINDED_HOLDOUT_PLATFORM = 'linux/amd64' as const;

export const BLINDED_HOLDOUT_CANDIDATE_SHA256 = 'sha256:778331a12e3720b1373c600f49ef7bd6299946ed10ddfde465b61f2f5c9ec982' as const;
export const BLINDED_HOLDOUT_RETIRED_V1_ONE_SHOT_KEY = 'sha256:334f7e05460d405878a758a6172057fbc1fdac5d3696fc5a8dbe17b8ab070935' as const;
export const BLINDED_HOLDOUT_RETIRED_V2_ONE_SHOT_KEY = 'sha256:e500407fcd48106f66131f75a3e6ee2f127758ae0c6f8b37835c968672c9bc98' as const;
export const BLINDED_HOLDOUT_RETIRED_V3_ONE_SHOT_KEY = 'sha256:af2a1940244599d61fe2ab48a922a08966fcad6549f792c4feee4f9d0979305b' as const;
const SOURCE_SHA256 = 'sha256:6f8dd8edaecc6de8003a29e760f695847682938007ea8342ac315f064b80d457' as const;
const IMAGE_SHA256 = 'sha256:fbf47a6a3361de44348ab2838b50462f5bf8892a8f5c5d04a4e909dbe0126b69' as const;
const IMAGE_CONFIG_SHA256 = 'sha256:939cef37326b1e89e43f27ef90b8f69c73feb10b7353ef973931f6373b32eefa' as const;
const NODE_SHA256 = 'sha256:34347794817b8e5d2ac54e93131ac8456f2c37cf1e752dcd6ec8e8314c7ae4a4' as const;
const ROOT_FS_LAYER_SHA256 = Object.freeze([
  'sha256:cce92674e98722970ab3fdce76a2566f54db535beeb24f0b4397f070ab5f6987',
  'sha256:7caa14a5f75323e9d5aff5b7db25d8540e148e6344f829013e94dd3349324891',
  'sha256:05a5275213a25f7ac29087f5731944eb9cefe4f8bffd1a9c4617be35aeaa39c8',
  'sha256:b6ad516e7aba450d913b5495228e48f1883673a610e7be80522be720b0b121fe',
  'sha256:db2c35d3556db51b3a5576e5dfb8db025e2f09dbbec40e95d38c7d3b8e96c8c3',
  'sha256:677819df3f45e5d5f0aa109ced5f5e15485084141eed7b7211252fc8d781e636',
] as const);

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const KEY_SCHEMA_PATTERN = /^memberry\.admission-feature-blinded-holdout-key\.v[1-9][0-9]*$/;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/;
const MAX_RECEIPT_BYTES = 16_384;
const REGISTERED_RUNTIME_EVIDENCE = new WeakSet<object>();
const REGISTERED_RECEIPTS = new WeakSet<object>();

export interface BlindedHoldoutAggregateV2 {
  readonly scenarioCount: number;
  readonly dimensionCount: number;
  readonly agreementCount: number;
  readonly agreementPermille: number;
  readonly availabilityMismatchCount: number;
  readonly valueMismatchCount: number;
  readonly passed: boolean;
}

export interface BlindedHoldoutRuntimeEvidenceV2 {
  readonly nodeMajor: 20 | 22;
  readonly evidenceMode: 'sealed-candidate-prediction';
  readonly candidateRunCount: 1;
  readonly candidateStoppedBeforeOracle: true;
  readonly predictionSha256: `sha256:${string}`;
  readonly aggregate: BlindedHoldoutAggregateV2;
  readonly evidenceSha256: `sha256:${string}`;
}

export interface BlindedHoldoutCleanupV2 {
  readonly candidateStopped: true;
  readonly containerRemoved: true;
  readonly imageRemoved: true;
  readonly predictionRemoved: true;
  readonly temporaryFilesRemoved: true;
  readonly noRawArtifactsPublished: true;
}

export interface BlindedHoldoutReceiptV2 {
  readonly schemaVersion: 'memberry.admission-feature-blinded-holdout-receipt.v2';
  readonly receiptVersion: typeof BLINDED_HOLDOUT_ARTIFACT_VERSION;
  readonly packetId: 'MEM-002C3';
  readonly evidenceMode: 'blinded-holdout';
  readonly oneShotKey: `sha256:${string}`;
  readonly policyReceiptSha256: typeof BLINDED_HOLDOUT_POLICY_RECEIPT_SHA256;
  readonly policyReceiptCanonicalBytesSha256: typeof BLINDED_HOLDOUT_POLICY_RECEIPT_CANONICAL_BYTES_SHA256;
  readonly integratedBaseSha: typeof BLINDED_HOLDOUT_INTEGRATED_BASE_SHA;
  readonly evaluatedCommitSha: string;
  readonly candidateCommitSha: typeof BLINDED_HOLDOUT_CANDIDATE_COMMIT_SHA;
  readonly repositoryRootTreeOid: typeof BLINDED_HOLDOUT_REPOSITORY_ROOT_TREE_OID;
  readonly historicalCandidateSubtreeOid: typeof BLINDED_HOLDOUT_HISTORICAL_CANDIDATE_SUBTREE_OID;
  readonly currentCheckoutCandidateSubtreeOid: typeof BLINDED_HOLDOUT_CURRENT_CHECKOUT_CANDIDATE_SUBTREE_OID;
  readonly candidateSha256: typeof BLINDED_HOLDOUT_CANDIDATE_SHA256;
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
  readonly runtimes: readonly [BlindedHoldoutRuntimeEvidenceV2, BlindedHoldoutRuntimeEvidenceV2];
  readonly aggregate: BlindedHoldoutAggregateV2;
  readonly cleanup: BlindedHoldoutCleanupV2;
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
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail('shape');
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

function aggregate(value: BlindedHoldoutAggregateV2): BlindedHoldoutAggregateV2 {
  const record = closedRecord(value, [
    'scenarioCount',
    'dimensionCount',
    'agreementCount',
    'agreementPermille',
    'availabilityMismatchCount',
    'valueMismatchCount',
    'passed',
  ]);
  const scenarioCount = exactInteger(record.scenarioCount, 4, 4);
  const dimensionCount = exactInteger(record.dimensionCount, 24, 24);
  const agreementCount = exactInteger(record.agreementCount, 0, 24);
  const agreementPermille = exactInteger(record.agreementPermille, 0, 1_000);
  const availabilityMismatchCount = exactInteger(record.availabilityMismatchCount, 0, 24);
  const valueMismatchCount = exactInteger(record.valueMismatchCount, 0, 24);
  const passed = record.passed;
  const expectedPermille = Math.floor((agreementCount * 1_000) / dimensionCount);
  const exactPass = agreementCount === 24 && agreementPermille === 1_000 && availabilityMismatchCount === 0 && valueMismatchCount === 0;
  if (
    agreementPermille !== expectedPermille ||
    availabilityMismatchCount + valueMismatchCount !== dimensionCount - agreementCount ||
    typeof passed !== 'boolean' ||
    passed !== exactPass
  )
    fail('aggregate');
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

export function createBlindedHoldoutRuntimeEvidenceV2(options: {
  nodeMajor: 20 | 22;
  evidenceMode: 'sealed-candidate-prediction';
  candidateRunCount: 1;
  candidateStoppedBeforeOracle: true;
  predictionSha256: `sha256:${string}`;
  aggregate: BlindedHoldoutAggregateV2;
}): BlindedHoldoutRuntimeEvidenceV2 {
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
  const evidence = Object.freeze({
    ...payload,
    evidenceSha256: sha256(JSON.stringify(payload)),
  });
  REGISTERED_RUNTIME_EVIDENCE.add(evidence);
  return evidence;
}

export function canonicalBlindedHoldoutRuntimeEvidenceV2(evidence: BlindedHoldoutRuntimeEvidenceV2): string {
  if (!REGISTERED_RUNTIME_EVIDENCE.has(evidence)) fail('unregistered_runtime');
  const canonical = `${JSON.stringify(evidence)}\n`;
  secretSafe(canonical);
  return canonical;
}

export function parseBlindedHoldoutRuntimeEvidenceV2(bytes: unknown): BlindedHoldoutRuntimeEvidenceV2 {
  const copy = snapshotBytes(bytes);
  let text: string;
  let raw: Record<string, unknown>;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(copy);
    if (!text.endsWith('\n') || text.includes('\r') || text.slice(0, -1).includes('\n')) fail('canonical');
    raw = closedRecord(JSON.parse(text.slice(0, -1)) as unknown, [
      'nodeMajor',
      'evidenceMode',
      'candidateRunCount',
      'candidateStoppedBeforeOracle',
      'predictionSha256',
      'aggregate',
      'evidenceSha256',
    ]);
  } catch (error) {
    if (error instanceof BlindedHoldoutArtifactError) throw error;
    fail('canonical');
  }
  const evidence = createBlindedHoldoutRuntimeEvidenceV2({
    nodeMajor: raw.nodeMajor as 20 | 22,
    evidenceMode: raw.evidenceMode as 'sealed-candidate-prediction',
    candidateRunCount: raw.candidateRunCount as 1,
    candidateStoppedBeforeOracle: raw.candidateStoppedBeforeOracle as true,
    predictionSha256: raw.predictionSha256 as `sha256:${string}`,
    aggregate: raw.aggregate as BlindedHoldoutAggregateV2,
  });
  if (evidence.evidenceSha256 !== raw.evidenceSha256 || canonicalBlindedHoldoutRuntimeEvidenceV2(evidence) !== text) fail('hash');
  return evidence;
}

export interface BlindedHoldoutStablePairV2 {
  readonly schemaVersion: string;
  readonly candidateSubtreeOid: string;
  readonly candidateSha256: string;
  readonly inputSha256: string;
  readonly oracleSha256: string;
}

const DEFAULT_STABLE_PAIR = Object.freeze({
  schemaVersion: 'memberry.admission-feature-blinded-holdout-key.v3',
  candidateSubtreeOid: BLINDED_HOLDOUT_HISTORICAL_CANDIDATE_SUBTREE_OID,
  candidateSha256: BLINDED_HOLDOUT_CANDIDATE_SHA256,
  inputSha256: BLINDED_HOLDOUT_INPUT_SHA256,
  oracleSha256: BLINDED_HOLDOUT_ORACLE_SHA256,
});

const STABLE_PAIR_KEYS = ['schemaVersion', 'candidateSubtreeOid', 'candidateSha256', 'inputSha256', 'oracleSha256'] as const;

function snapshotStablePair(identity: unknown): BlindedHoldoutStablePairV2 {
  if (typeof identity !== 'object' || identity === null || TRUSTED_IS_PROXY(identity)) fail('identity');
  if (TRUSTED_GET_PROTOTYPE_OF(identity) !== TRUSTED_OBJECT_PROTOTYPE) fail('identity');
  const ownKeys = TRUSTED_OWN_KEYS(identity);
  if (ownKeys.length !== STABLE_PAIR_KEYS.length) fail('identity');
  for (const key of ownKeys) {
    if (typeof key !== 'string') fail('identity');
    let registered = false;
    for (const expected of STABLE_PAIR_KEYS) {
      if (key === expected) {
        registered = true;
        break;
      }
    }
    if (!registered) fail('identity');
  }
  const values: string[] = [];
  for (const key of STABLE_PAIR_KEYS) {
    const descriptor = TRUSTED_GET_OWN_PROPERTY_DESCRIPTOR(identity, key);
    if (!descriptor || descriptor.enumerable !== true || !('value' in descriptor) || typeof descriptor.value !== 'string') {
      fail('identity');
    }
    values.push(descriptor.value);
  }
  return {
    schemaVersion: values[0]!,
    candidateSubtreeOid: values[1]!,
    candidateSha256: values[2]!,
    inputSha256: values[3]!,
    oracleSha256: values[4]!,
  };
}

export function blindedHoldoutOneShotKeyV2(identity: BlindedHoldoutStablePairV2 = DEFAULT_STABLE_PAIR): `sha256:${string}` {
  const snapshot = snapshotStablePair(identity);
  if (
    !TRUSTED_REGEXP_TEST(KEY_SCHEMA_PATTERN, snapshot.schemaVersion) ||
    !TRUSTED_REGEXP_TEST(COMMIT_PATTERN, snapshot.candidateSubtreeOid) ||
    !TRUSTED_REGEXP_TEST(SHA256_PATTERN, snapshot.candidateSha256) ||
    !TRUSTED_REGEXP_TEST(SHA256_PATTERN, snapshot.inputSha256) ||
    !TRUSTED_REGEXP_TEST(SHA256_PATTERN, snapshot.oracleSha256)
  )
    fail('identity');
  const canonical = `{"schemaVersion":"${snapshot.schemaVersion}","candidateSubtreeOid":"${snapshot.candidateSubtreeOid}","candidateSha256":"${snapshot.candidateSha256}","inputSha256":"${snapshot.inputSha256}","oracleSha256":"${snapshot.oracleSha256}"}`;
  return sha256(canonical);
}

function cleanup(value: BlindedHoldoutCleanupV2): BlindedHoldoutCleanupV2 {
  const record = closedRecord(value, [
    'candidateStopped',
    'containerRemoved',
    'imageRemoved',
    'predictionRemoved',
    'temporaryFilesRemoved',
    'noRawArtifactsPublished',
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
  if (
    /"(?:scenarioId|features|dimensions|valuePermille|fixtureCode|predictions|stdout|stderr|rawPrediction)"/i.test(canonical) ||
    /af-(?:dev|holdout)-[0-9]|case-[0-9]/i.test(canonical)
  )
    fail('secret_safety');
}

export function buildBlindedHoldoutReceiptV2(options: {
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
  runtimes: readonly [BlindedHoldoutRuntimeEvidenceV2, BlindedHoldoutRuntimeEvidenceV2];
  cleanup: BlindedHoldoutCleanupV2;
}): BlindedHoldoutReceiptV2 {
  if (options.workflowRunAttempt !== 1) fail('attempt');
  if (options.priorAuthoritativeReceiptCount !== 0) fail('duplicate_attempt');
  if (options.candidateRunCount !== 1) fail('candidate_run_count');
  if (!RUN_ID_PATTERN.test(options.workflowRunId)) fail('attempt');
  if (
    !Array.isArray(options.runtimes) ||
    options.runtimes.length !== 2 ||
    options.runtimes.some((entry) => !REGISTERED_RUNTIME_EVIDENCE.has(entry))
  )
    fail('runtime');
  const [node20, node22] = options.runtimes;
  if (node20.nodeMajor !== 20 || node22.nodeMajor !== 22) fail('runtime');
  const predictionSha256 = exactSha256(options.predictionSha256);
  if (node20.predictionSha256 !== predictionSha256 || node22.predictionSha256 !== predictionSha256) {
    fail('runtime_divergence');
  }
  if (JSON.stringify(node20.aggregate) !== JSON.stringify(node22.aggregate)) fail('runtime_divergence');
  const resultAggregate = aggregate(node20.aggregate);
  const evaluatedCommitSha = exactCommit(options.evaluatedCommitSha);
  const tombstone = closedRecord(options.tombstone, ['ref', 'targetSha', 'preexisting', 'creationStatus', 'verificationStatus']);
  const expectedTombstoneRef = `refs/tags/memberry-mem002c3-burn/${blindedHoldoutOneShotKeyV2().slice(7)}`;
  if (
    tombstone.ref !== expectedTombstoneRef ||
    tombstone.targetSha !== evaluatedCommitSha ||
    tombstone.preexisting !== false ||
    tombstone.creationStatus !== 201 ||
    tombstone.verificationStatus !== 200
  )
    fail('tombstone');
  const payload = Object.freeze({
    schemaVersion: 'memberry.admission-feature-blinded-holdout-receipt.v2' as const,
    receiptVersion: BLINDED_HOLDOUT_ARTIFACT_VERSION,
    packetId: 'MEM-002C3' as const,
    evidenceMode: 'blinded-holdout' as const,
    oneShotKey: blindedHoldoutOneShotKeyV2(),
    policyReceiptSha256: BLINDED_HOLDOUT_POLICY_RECEIPT_SHA256,
    policyReceiptCanonicalBytesSha256: BLINDED_HOLDOUT_POLICY_RECEIPT_CANONICAL_BYTES_SHA256,
    integratedBaseSha: BLINDED_HOLDOUT_INTEGRATED_BASE_SHA,
    evaluatedCommitSha,
    candidateCommitSha: BLINDED_HOLDOUT_CANDIDATE_COMMIT_SHA,
    repositoryRootTreeOid: BLINDED_HOLDOUT_REPOSITORY_ROOT_TREE_OID,
    historicalCandidateSubtreeOid: BLINDED_HOLDOUT_HISTORICAL_CANDIDATE_SUBTREE_OID,
    currentCheckoutCandidateSubtreeOid: BLINDED_HOLDOUT_CURRENT_CHECKOUT_CANDIDATE_SUBTREE_OID,
    candidateSha256: BLINDED_HOLDOUT_CANDIDATE_SHA256,
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
    runtimes: Object.freeze([node20, node22]) as readonly [BlindedHoldoutRuntimeEvidenceV2, BlindedHoldoutRuntimeEvidenceV2],
    aggregate: resultAggregate,
    cleanup: cleanup(options.cleanup),
    outcome: resultAggregate.passed ? ('passed' as const) : ('failed' as const),
  });
  const receipt = Object.freeze({
    ...payload,
    receiptSha256: sha256(JSON.stringify(payload)),
  });
  secretSafe(JSON.stringify(receipt));
  REGISTERED_RECEIPTS.add(receipt);
  return receipt;
}

export function canonicalBlindedHoldoutReceiptV2(receipt: BlindedHoldoutReceiptV2): string {
  if (!REGISTERED_RECEIPTS.has(receipt)) fail('unregistered');
  const canonical = `${JSON.stringify(receipt)}\n`;
  secretSafe(canonical);
  return canonical;
}

function snapshotBytes(value: unknown): Uint8Array {
  if (typeof value !== 'object' || value === null || nodeUtilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Uint8Array.prototype)
    fail('bytes');
  const bytes = value as Uint8Array;
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_RECEIPT_BYTES) fail('bytes');
  return Uint8Array.from(bytes);
}

export function parseBlindedHoldoutReceiptV2(bytes: unknown): BlindedHoldoutReceiptV2 {
  const copy = snapshotBytes(bytes);
  let text: string;
  let raw: Record<string, unknown>;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(copy);
    if (!text.endsWith('\n') || text.includes('\r') || text.slice(0, -1).includes('\n')) fail('canonical');
    raw = closedRecord(JSON.parse(text.slice(0, -1)) as unknown, [
      'schemaVersion',
      'receiptVersion',
      'packetId',
      'evidenceMode',
      'oneShotKey',
      'policyReceiptSha256',
      'policyReceiptCanonicalBytesSha256',
      'integratedBaseSha',
      'evaluatedCommitSha',
      'candidateCommitSha',
      'repositoryRootTreeOid',
      'historicalCandidateSubtreeOid',
      'currentCheckoutCandidateSubtreeOid',
      'candidateSha256',
      'sourceSha256',
      'imageSha256',
      'imageConfigSha256',
      'nodeSha256',
      'rootFsLayerSha256',
      'platform',
      'baseImage',
      'inputSha256',
      'oracleSha256',
      'scorerSha256',
      'predictionSha256',
      'startReceiptSha256',
      'workflow',
      'candidateRunCount',
      'tombstone',
      'runtimes',
      'aggregate',
      'cleanup',
      'outcome',
      'receiptSha256',
    ]);
  } catch (error) {
    if (error instanceof BlindedHoldoutArtifactError) throw error;
    fail('canonical');
  }
  if (
    raw.schemaVersion !== 'memberry.admission-feature-blinded-holdout-receipt.v2' ||
    raw.receiptVersion !== BLINDED_HOLDOUT_ARTIFACT_VERSION ||
    raw.packetId !== 'MEM-002C3' ||
    raw.evidenceMode !== 'blinded-holdout' ||
    raw.oneShotKey !== blindedHoldoutOneShotKeyV2() ||
    raw.policyReceiptSha256 !== BLINDED_HOLDOUT_POLICY_RECEIPT_SHA256 ||
    raw.policyReceiptCanonicalBytesSha256 !== BLINDED_HOLDOUT_POLICY_RECEIPT_CANONICAL_BYTES_SHA256 ||
    raw.integratedBaseSha !== BLINDED_HOLDOUT_INTEGRATED_BASE_SHA ||
    raw.candidateCommitSha !== BLINDED_HOLDOUT_CANDIDATE_COMMIT_SHA ||
    raw.repositoryRootTreeOid !== BLINDED_HOLDOUT_REPOSITORY_ROOT_TREE_OID ||
    raw.historicalCandidateSubtreeOid !== BLINDED_HOLDOUT_HISTORICAL_CANDIDATE_SUBTREE_OID ||
    raw.currentCheckoutCandidateSubtreeOid !== BLINDED_HOLDOUT_CURRENT_CHECKOUT_CANDIDATE_SUBTREE_OID ||
    raw.candidateSha256 !== BLINDED_HOLDOUT_CANDIDATE_SHA256 ||
    raw.sourceSha256 !== SOURCE_SHA256 ||
    raw.imageSha256 !== IMAGE_SHA256 ||
    raw.imageConfigSha256 !== IMAGE_CONFIG_SHA256 ||
    raw.nodeSha256 !== NODE_SHA256 ||
    raw.platform !== BLINDED_HOLDOUT_PLATFORM ||
    raw.baseImage !== BLINDED_HOLDOUT_BASE_IMAGE ||
    raw.inputSha256 !== BLINDED_HOLDOUT_INPUT_SHA256 ||
    raw.oracleSha256 !== BLINDED_HOLDOUT_ORACLE_SHA256
  )
    fail('identity');
  if (!Array.isArray(raw.rootFsLayerSha256) || JSON.stringify(raw.rootFsLayerSha256) !== JSON.stringify(ROOT_FS_LAYER_SHA256))
    fail('identity');
  const workflow = closedRecord(raw.workflow, ['repository', 'runId', 'runAttempt', 'priorAuthoritativeReceiptCount']);
  if (
    workflow.repository !== 'AP3X-Dev/memberry' ||
    workflow.runAttempt !== 1 ||
    workflow.priorAuthoritativeReceiptCount !== 0 ||
    typeof workflow.runId !== 'string'
  )
    fail('attempt');
  if (!Array.isArray(raw.runtimes) || raw.runtimes.length !== 2) fail('runtime');
  const reconstructed = raw.runtimes.map((entry) => {
    const value = closedRecord(entry, [
      'nodeMajor',
      'evidenceMode',
      'candidateRunCount',
      'candidateStoppedBeforeOracle',
      'predictionSha256',
      'aggregate',
      'evidenceSha256',
    ]);
    const evidence = createBlindedHoldoutRuntimeEvidenceV2({
      nodeMajor: value.nodeMajor as 20 | 22,
      evidenceMode: value.evidenceMode as 'sealed-candidate-prediction',
      candidateRunCount: value.candidateRunCount as 1,
      candidateStoppedBeforeOracle: value.candidateStoppedBeforeOracle as true,
      predictionSha256: value.predictionSha256 as `sha256:${string}`,
      aggregate: value.aggregate as BlindedHoldoutAggregateV2,
    });
    if (evidence.evidenceSha256 !== value.evidenceSha256) fail('runtime');
    return evidence;
  }) as [BlindedHoldoutRuntimeEvidenceV2, BlindedHoldoutRuntimeEvidenceV2];
  const receipt = buildBlindedHoldoutReceiptV2({
    evaluatedCommitSha: raw.evaluatedCommitSha as string,
    scorerSha256: raw.scorerSha256 as `sha256:${string}`,
    predictionSha256: raw.predictionSha256 as `sha256:${string}`,
    startReceiptSha256: raw.startReceiptSha256 as `sha256:${string}`,
    tombstone: raw.tombstone as BlindedHoldoutReceiptV2['tombstone'],
    workflowRunId: workflow.runId as string,
    workflowRunAttempt: workflow.runAttempt as 1,
    priorAuthoritativeReceiptCount: workflow.priorAuthoritativeReceiptCount as 0,
    candidateRunCount: raw.candidateRunCount as 1,
    runtimes: reconstructed,
    cleanup: raw.cleanup as BlindedHoldoutCleanupV2,
  });
  if (
    receipt.receiptSha256 !== raw.receiptSha256 ||
    canonicalBlindedHoldoutReceiptV2(receipt) !== text ||
    JSON.stringify(receipt.aggregate) !== JSON.stringify(raw.aggregate) ||
    receipt.outcome !== raw.outcome
  ) {
    fail('hash');
  }
  return receipt;
}

export function blindedHoldoutReceiptIdentityV2(receipt: BlindedHoldoutReceiptV2): `sha256:${string}` {
  return sha256(canonicalBlindedHoldoutReceiptV2(receipt));
}
