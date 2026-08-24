import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { types as nodeUtilTypes } from 'node:util';

import type { AdmissionC2RuntimePolicyReceiptV1 } from '../contracts/c2-runtime-policy-receipt.js';
import type {
  AdmissionFeatureScenarioInputV1,
  AdmissionFeatureScenarioOracleV1,
  AdmissionFeatureScenarioPredictionV1,
} from '../contract.js';
import type { AdmissionFeatureAgreementReportV1 } from '../scorer.js';
import {
  BLINDED_HOLDOUT_BASE_IMAGE,
  BLINDED_HOLDOUT_CANDIDATE_COMMIT_SHA,
  BLINDED_HOLDOUT_CURRENT_CHECKOUT_CANDIDATE_SUBTREE_OID,
  BLINDED_HOLDOUT_HISTORICAL_CANDIDATE_SUBTREE_OID,
  BLINDED_HOLDOUT_INPUT_SHA256,
  BLINDED_HOLDOUT_INTEGRATED_BASE_SHA,
  BLINDED_HOLDOUT_PLATFORM,
  BLINDED_HOLDOUT_POLICY_RECEIPT_CANONICAL_BYTES_SHA256,
  BLINDED_HOLDOUT_POLICY_RECEIPT_SHA256,
  BLINDED_HOLDOUT_REPOSITORY_ROOT_TREE_OID,
  buildBlindedHoldoutReceiptV2,
  blindedHoldoutOneShotKeyV2,
  canonicalBlindedHoldoutReceiptV2,
  canonicalBlindedHoldoutRuntimeEvidenceV2,
  createBlindedHoldoutRuntimeEvidenceV2,
  parseBlindedHoldoutReceiptV2,
  parseBlindedHoldoutRuntimeEvidenceV2,
  type BlindedHoldoutRuntimeEvidenceV2,
} from './blinded-holdout-artifact.js';

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/;
const PREDICTION_MAX_BYTES = 32_768;
const REGISTERED_PREFLIGHTS = new WeakSet<object>();
const REGISTERED_START_RECEIPTS = new WeakSet<object>();
const REGISTERED_TOMBSTONE_SPECS = new WeakSet<object>();
const REGISTERED_TOMBSTONE_EVIDENCE = new WeakSet<object>();
const NEUTRAL_POLICY_V2_MODULE = '../contracts/c2-runtime-policy-receipt-v2.js';
const NEUTRAL_POLICY_V2_PARSER_EXPORT = 'parseAdmissionC2RuntimePolicyReceiptV2';
const NEUTRAL_POLICY_V1_RECEIPT = new URL('../contracts/c2-runtime-policy-receipt.v1.json', import.meta.url);

type AdmissionC2RuntimePolicyReceiptV2 = Readonly<{
  receiptSha256: typeof BLINDED_HOLDOUT_POLICY_RECEIPT_SHA256;
  canonicalBytesSha256: typeof BLINDED_HOLDOUT_POLICY_RECEIPT_CANONICAL_BYTES_SHA256;
  binding: Readonly<{
    candidateCommitSha: typeof BLINDED_HOLDOUT_CANDIDATE_COMMIT_SHA;
    repositoryRootTreeOid: typeof BLINDED_HOLDOUT_REPOSITORY_ROOT_TREE_OID;
    candidateSubtreeOid: typeof BLINDED_HOLDOUT_HISTORICAL_CANDIDATE_SUBTREE_OID;
    inputSha256: typeof BLINDED_HOLDOUT_INPUT_SHA256;
  }>;
  policy: AdmissionC2RuntimePolicyReceiptV1['policy'];
}>;

export const BLINDED_HOLDOUT_TOMBSTONE_REF_PREFIX = 'refs/tags/memberry-mem002c3-burn/' as const;

export class BlindedHoldoutProtocolError extends Error {
  constructor(readonly code: string) {
    super(`mem002c3_protocol:${code}`);
    this.name = 'BlindedHoldoutProtocolError';
  }
}

function fail(code: string): never {
  throw new BlindedHoldoutProtocolError(code);
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

function plainRecord(value: unknown): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail('tombstone_response');
  return value as Record<string, unknown>;
}

export function validateBlindedHoldoutBurnAuthorityAbsenceV2(options: {
  readonly retiredV1LookupStatus: number;
  readonly retiredV2LookupStatus: number;
  readonly v3LookupStatus: number;
  readonly retiredV1EvidenceArtifactCount: number;
  readonly retiredV2EvidenceArtifactCount: number;
  readonly v3EvidenceArtifactCount: number;
  readonly knownFailedV1RunArtifactCount: number;
  readonly knownFailedV2RunArtifactCount: number;
}): true {
  const counts = [
    options.retiredV1EvidenceArtifactCount, options.retiredV2EvidenceArtifactCount,
    options.v3EvidenceArtifactCount, options.knownFailedV1RunArtifactCount,
    options.knownFailedV2RunArtifactCount,
  ];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) fail('burn_authority');
  if (options.v3LookupStatus === 200) fail('burn_preexisting');
  if (options.retiredV1LookupStatus !== 404 || options.v3LookupStatus !== 404) fail('burn_lookup');
  if (options.retiredV2LookupStatus !== 200) fail('burn_lookup');
  if (options.retiredV1EvidenceArtifactCount !== 0 || options.v3EvidenceArtifactCount !== 0
    || options.knownFailedV1RunArtifactCount !== 0) fail('legacy_authority');
  if (options.retiredV2EvidenceArtifactCount > 1 || options.knownFailedV2RunArtifactCount > 1) {
    fail('legacy_authority');
  }
  return true;
}

export interface BlindedHoldoutTombstoneSpecV2 {
  readonly schemaVersion: 'memberry.admission-feature-blinded-holdout-tombstone-spec.v2';
  readonly oneShotKey: `sha256:${string}`;
  readonly ref: `refs/tags/memberry-mem002c3-burn/${string}`;
  readonly apiRef: `tags/memberry-mem002c3-burn/${string}`;
  readonly targetSha: string;
}

export interface BlindedHoldoutTombstoneEvidenceV2 {
  readonly schemaVersion: 'memberry.admission-feature-blinded-holdout-tombstone.v2';
  readonly oneShotKey: `sha256:${string}`;
  readonly ref: `refs/tags/memberry-mem002c3-burn/${string}`;
  readonly targetSha: string;
  readonly preexisting: false;
  readonly creationStatus: 201;
  readonly verificationStatus: 200;
}

export function buildBlindedHoldoutTombstoneSpecV2(targetSha: string): BlindedHoldoutTombstoneSpecV2 {
  const oneShotKey = blindedHoldoutOneShotKeyV2();
  const key = oneShotKey.slice('sha256:'.length);
  const spec = Object.freeze({
    schemaVersion: 'memberry.admission-feature-blinded-holdout-tombstone-spec.v2' as const,
    oneShotKey,
    ref: `${BLINDED_HOLDOUT_TOMBSTONE_REF_PREFIX}${key}` as const,
    apiRef: `tags/memberry-mem002c3-burn/${key}` as const,
    targetSha: exactCommit(targetSha),
  });
  REGISTERED_TOMBSTONE_SPECS.add(spec);
  return spec;
}

export function validateBlindedHoldoutTombstoneAbsenceV2(options: {
  readonly spec: BlindedHoldoutTombstoneSpecV2;
  readonly lookupStatus: number;
  readonly priorEvidenceArtifactCount: number;
}): BlindedHoldoutTombstoneSpecV2 {
  if (!REGISTERED_TOMBSTONE_SPECS.has(options.spec)) fail('tombstone_spec');
  if (!Number.isSafeInteger(options.priorEvidenceArtifactCount) || options.priorEvidenceArtifactCount < 0) {
    fail('tombstone_evidence');
  }
  if (options.priorEvidenceArtifactCount !== 0) fail('tombstone_evidence');
  if (options.lookupStatus === 200) fail('tombstone_preexisting');
  if (options.lookupStatus !== 404) fail('tombstone_lookup');
  return options.spec;
}

function exactGitHubRefResponse(value: unknown, spec: BlindedHoldoutTombstoneSpecV2): void {
  const response = plainRecord(value);
  const object = plainRecord(response.object);
  if (response.ref !== spec.ref || object.type !== 'commit' || object.sha !== spec.targetSha) {
    fail('tombstone_response');
  }
}

export function verifyBlindedHoldoutTombstoneCreationV2(options: {
  readonly spec: BlindedHoldoutTombstoneSpecV2;
  readonly createStatus: number;
  readonly createResponse: unknown;
  readonly verificationStatus: number;
  readonly verificationResponse: unknown;
}): BlindedHoldoutTombstoneEvidenceV2 {
  if (!REGISTERED_TOMBSTONE_SPECS.has(options.spec)) fail('tombstone_spec');
  if (options.createStatus === 422) fail('tombstone_race');
  if (options.createStatus !== 201) fail('tombstone_create');
  if (options.verificationStatus !== 200) fail('tombstone_verify');
  exactGitHubRefResponse(options.createResponse, options.spec);
  exactGitHubRefResponse(options.verificationResponse, options.spec);
  const evidence = Object.freeze({
    schemaVersion: 'memberry.admission-feature-blinded-holdout-tombstone.v2' as const,
    oneShotKey: options.spec.oneShotKey,
    ref: options.spec.ref,
    targetSha: options.spec.targetSha,
    preexisting: false as const,
    creationStatus: 201 as const,
    verificationStatus: 200 as const,
  });
  REGISTERED_TOMBSTONE_EVIDENCE.add(evidence);
  return evidence;
}

export function canonicalBlindedHoldoutTombstoneEvidenceV2(evidence: BlindedHoldoutTombstoneEvidenceV2): string {
  if (!REGISTERED_TOMBSTONE_EVIDENCE.has(evidence)) fail('tombstone_evidence');
  return `${JSON.stringify(evidence)}\n`;
}

export function parseBlindedHoldoutTombstoneEvidenceV2(bytes: unknown): BlindedHoldoutTombstoneEvidenceV2 {
  const copy = exactJsonBytes(bytes, 4_096);
  let text: string;
  let raw: Record<string, unknown>;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(copy);
    if (!text.endsWith('\n') || text.includes('\r') || text.slice(0, -1).includes('\n')) fail('tombstone_evidence');
    raw = plainRecord(JSON.parse(text.slice(0, -1)) as unknown);
  } catch (error) {
    if (error instanceof BlindedHoldoutProtocolError) throw error;
    fail('tombstone_evidence');
  }
  const keys = ['schemaVersion', 'oneShotKey', 'ref', 'targetSha', 'preexisting', 'creationStatus', 'verificationStatus'];
  if (Reflect.ownKeys(raw).length !== keys.length || Reflect.ownKeys(raw).some((key) => typeof key !== 'string' || !keys.includes(key))) {
    fail('tombstone_evidence');
  }
  const spec = buildBlindedHoldoutTombstoneSpecV2(raw.targetSha as string);
  if (
    raw.schemaVersion !== 'memberry.admission-feature-blinded-holdout-tombstone.v2' ||
    raw.oneShotKey !== spec.oneShotKey ||
    raw.ref !== spec.ref ||
    raw.preexisting !== false ||
    raw.creationStatus !== 201 ||
    raw.verificationStatus !== 200
  )
    fail('tombstone_evidence');
  const evidence = Object.freeze({
    schemaVersion: raw.schemaVersion,
    oneShotKey: raw.oneShotKey,
    ref: raw.ref,
    targetSha: spec.targetSha,
    preexisting: false as const,
    creationStatus: 201 as const,
    verificationStatus: 200 as const,
  }) as BlindedHoldoutTombstoneEvidenceV2;
  REGISTERED_TOMBSTONE_EVIDENCE.add(evidence);
  if (canonicalBlindedHoldoutTombstoneEvidenceV2(evidence) !== text) fail('tombstone_evidence');
  return evidence;
}

function validatePolicyReceipt(receipt: AdmissionC2RuntimePolicyReceiptV2): void {
  if (
    receipt.receiptSha256 !== BLINDED_HOLDOUT_POLICY_RECEIPT_SHA256 ||
    receipt.canonicalBytesSha256 !== BLINDED_HOLDOUT_POLICY_RECEIPT_CANONICAL_BYTES_SHA256 ||
    receipt.binding.candidateCommitSha !== BLINDED_HOLDOUT_CANDIDATE_COMMIT_SHA ||
    receipt.binding.repositoryRootTreeOid !== BLINDED_HOLDOUT_REPOSITORY_ROOT_TREE_OID ||
    receipt.binding.candidateSubtreeOid !== BLINDED_HOLDOUT_HISTORICAL_CANDIDATE_SUBTREE_OID ||
    receipt.binding.inputSha256 !== BLINDED_HOLDOUT_INPUT_SHA256 ||
    receipt.policy.platform !== BLINDED_HOLDOUT_PLATFORM ||
    receipt.policy.baseImage !== BLINDED_HOLDOUT_BASE_IMAGE ||
    receipt.policy.pull !== 'never' ||
    receipt.policy.network !== 'none' ||
    receipt.policy.user !== '65532:65532' ||
    receipt.policy.rootFilesystem !== 'read-only' ||
    receipt.policy.mounts.count !== 0 ||
    receipt.policy.mounts.tmpfs.length !== 0 ||
    receipt.policy.capabilities.length !== 0 ||
    receipt.policy.noNewPrivileges !== true ||
    receipt.policy.limits.cpu !== '0.5' ||
    receipt.policy.limits.memory !== '128m' ||
    receipt.policy.limits.memorySwap !== '128m' ||
    receipt.policy.limits.pids !== 32 ||
    receipt.policy.limits.timeoutMs !== 5_000 ||
    receipt.policy.limits.stdinBytes !== 32_768 ||
    receipt.policy.limits.stdoutBytes !== 32_768 ||
    receipt.policy.limits.stderrBytes !== 1_024 ||
    receipt.policy.stdinTransport !== 'attached-stdin' ||
    receipt.policy.stop.action !== 'docker container kill by inspected ID' ||
    receipt.policy.stop.grace !== 'none'
  )
    fail('policy_authority');
}

export interface BlindedHoldoutPreflightV2 {
  readonly oneShotKey: `sha256:${string}`;
  readonly repository: 'AP3X-Dev/memberry';
  readonly workflowRunId: string;
  readonly workflowRunAttempt: 1;
  readonly priorAuthoritativeReceiptCount: 0;
  readonly integratedBaseSha: typeof BLINDED_HOLDOUT_INTEGRATED_BASE_SHA;
  readonly evaluatedCommitSha: string;
  readonly candidateCommitSha: typeof BLINDED_HOLDOUT_CANDIDATE_COMMIT_SHA;
  readonly repositoryRootTreeOid: typeof BLINDED_HOLDOUT_REPOSITORY_ROOT_TREE_OID;
  readonly historicalCandidateSubtreeOid: typeof BLINDED_HOLDOUT_HISTORICAL_CANDIDATE_SUBTREE_OID;
  readonly currentCheckoutCandidateSubtreeOid: typeof BLINDED_HOLDOUT_CURRENT_CHECKOUT_CANDIDATE_SUBTREE_OID;
  readonly policyReceiptSha256: typeof BLINDED_HOLDOUT_POLICY_RECEIPT_SHA256;
  readonly policyReceiptCanonicalBytesSha256: typeof BLINDED_HOLDOUT_POLICY_RECEIPT_CANONICAL_BYTES_SHA256;
  readonly policy: AdmissionC2RuntimePolicyReceiptV2['policy'];
}

export function validateBlindedHoldoutPreflightV2(options: {
  receipt: AdmissionC2RuntimePolicyReceiptV2;
  eventName: string;
  repository: string;
  workflowRunId: string;
  workflowRunAttempt: number;
  priorAuthoritativeReceiptCount: number;
  evaluatedCommitSha: string;
  observedCheckoutCommitSha: string;
  integratedBaseIsAncestor: boolean;
  candidateSubtreeClean: boolean;
  candidateContextOnly: boolean;
  observedPlatform: string;
  observedBaseImage: string;
  observedCandidateCommitSha: string;
  observedRepositoryRootTreeOid: string;
  observedHistoricalCandidateSubtreeOid: string;
  observedCheckoutCandidateSubtreeOid: string;
  observedInputSha256: string;
}): BlindedHoldoutPreflightV2 {
  validatePolicyReceipt(options.receipt);
  if (options.eventName !== 'workflow_dispatch') fail('workflow_event');
  if (options.repository !== 'AP3X-Dev/memberry' || !RUN_ID_PATTERN.test(options.workflowRunId)) fail('workflow_identity');
  if (options.workflowRunAttempt !== 1) fail('workflow_attempt');
  if (options.priorAuthoritativeReceiptCount !== 0) fail('duplicate_attempt');
  const evaluatedCommitSha = exactCommit(options.evaluatedCommitSha);
  if (exactCommit(options.observedCheckoutCommitSha) !== evaluatedCommitSha) fail('checkout_commit');
  if (options.integratedBaseIsAncestor !== true) fail('base_ancestry');
  if (options.candidateSubtreeClean !== true) fail('candidate_dirty');
  if (options.candidateContextOnly !== true) fail('candidate_context');
  if (options.observedPlatform !== options.receipt.policy.platform) fail('platform');
  if (options.observedBaseImage !== options.receipt.policy.baseImage) fail('base_image');
  if (
    options.observedCandidateCommitSha !== options.receipt.binding.candidateCommitSha ||
    options.observedRepositoryRootTreeOid !== BLINDED_HOLDOUT_REPOSITORY_ROOT_TREE_OID ||
    options.observedHistoricalCandidateSubtreeOid !== BLINDED_HOLDOUT_HISTORICAL_CANDIDATE_SUBTREE_OID ||
    options.observedCheckoutCandidateSubtreeOid !== BLINDED_HOLDOUT_CURRENT_CHECKOUT_CANDIDATE_SUBTREE_OID
  ) {
    fail('candidate_identity');
  }
  if (options.observedInputSha256 !== options.receipt.binding.inputSha256) fail('input_identity');
  const preflight = Object.freeze({
    oneShotKey: blindedHoldoutOneShotKeyV2(),
    repository: 'AP3X-Dev/memberry' as const,
    workflowRunId: options.workflowRunId,
    workflowRunAttempt: 1 as const,
    priorAuthoritativeReceiptCount: 0 as const,
    integratedBaseSha: BLINDED_HOLDOUT_INTEGRATED_BASE_SHA,
    evaluatedCommitSha,
    candidateCommitSha: BLINDED_HOLDOUT_CANDIDATE_COMMIT_SHA,
    repositoryRootTreeOid: BLINDED_HOLDOUT_REPOSITORY_ROOT_TREE_OID,
    historicalCandidateSubtreeOid: BLINDED_HOLDOUT_HISTORICAL_CANDIDATE_SUBTREE_OID,
    currentCheckoutCandidateSubtreeOid: BLINDED_HOLDOUT_CURRENT_CHECKOUT_CANDIDATE_SUBTREE_OID,
    policyReceiptSha256: BLINDED_HOLDOUT_POLICY_RECEIPT_SHA256,
    policyReceiptCanonicalBytesSha256: BLINDED_HOLDOUT_POLICY_RECEIPT_CANONICAL_BYTES_SHA256,
    policy: options.receipt.policy,
  });
  REGISTERED_PREFLIGHTS.add(preflight);
  return preflight;
}

export interface BlindedHoldoutStartReceiptV2 {
  readonly schemaVersion: 'memberry.admission-feature-blinded-holdout-start.v2';
  readonly oneShotKey: `sha256:${string}`;
  readonly state: 'burned-before-candidate-start';
  readonly repository: 'AP3X-Dev/memberry';
  readonly workflowRunId: string;
  readonly workflowRunAttempt: 1;
  readonly priorAuthoritativeReceiptCount: 0;
  readonly candidateRunCount: 0;
  readonly tombstoneRef: `refs/tags/memberry-mem002c3-burn/${string}`;
  readonly tombstoneTargetSha: string;
  readonly tombstoneCreationStatus: 201;
  readonly tombstoneVerificationStatus: 200;
  readonly repositoryRootTreeOid: typeof BLINDED_HOLDOUT_REPOSITORY_ROOT_TREE_OID;
  readonly historicalCandidateSubtreeOid: typeof BLINDED_HOLDOUT_HISTORICAL_CANDIDATE_SUBTREE_OID;
  readonly currentCheckoutCandidateSubtreeOid: typeof BLINDED_HOLDOUT_CURRENT_CHECKOUT_CANDIDATE_SUBTREE_OID;
  readonly policyReceiptSha256: typeof BLINDED_HOLDOUT_POLICY_RECEIPT_SHA256;
  readonly policyReceiptCanonicalBytesSha256: typeof BLINDED_HOLDOUT_POLICY_RECEIPT_CANONICAL_BYTES_SHA256;
  readonly receiptSha256: `sha256:${string}`;
}

export function buildBlindedHoldoutStartReceiptV2(
  preflight: BlindedHoldoutPreflightV2,
  tombstone: BlindedHoldoutTombstoneEvidenceV2,
): BlindedHoldoutStartReceiptV2 {
  if (!REGISTERED_PREFLIGHTS.has(preflight)) fail('unregistered_preflight');
  if (
    !REGISTERED_TOMBSTONE_EVIDENCE.has(tombstone) ||
    tombstone.oneShotKey !== preflight.oneShotKey ||
    tombstone.targetSha !== preflight.evaluatedCommitSha
  )
    fail('tombstone_evidence');
  const payload = Object.freeze({
    schemaVersion: 'memberry.admission-feature-blinded-holdout-start.v2' as const,
    oneShotKey: preflight.oneShotKey,
    state: 'burned-before-candidate-start' as const,
    repository: preflight.repository,
    workflowRunId: preflight.workflowRunId,
    workflowRunAttempt: preflight.workflowRunAttempt,
    priorAuthoritativeReceiptCount: preflight.priorAuthoritativeReceiptCount,
    candidateRunCount: 0 as const,
    tombstoneRef: tombstone.ref,
    tombstoneTargetSha: tombstone.targetSha,
    tombstoneCreationStatus: tombstone.creationStatus,
    tombstoneVerificationStatus: tombstone.verificationStatus,
    repositoryRootTreeOid: preflight.repositoryRootTreeOid,
    historicalCandidateSubtreeOid: preflight.historicalCandidateSubtreeOid,
    currentCheckoutCandidateSubtreeOid: preflight.currentCheckoutCandidateSubtreeOid,
    policyReceiptSha256: preflight.policyReceiptSha256,
    policyReceiptCanonicalBytesSha256: preflight.policyReceiptCanonicalBytesSha256,
  });
  const receipt = Object.freeze({
    ...payload,
    receiptSha256: sha256(JSON.stringify(payload)),
  });
  REGISTERED_START_RECEIPTS.add(receipt);
  return receipt;
}

export function canonicalBlindedHoldoutStartReceiptV2(receipt: BlindedHoldoutStartReceiptV2): string {
  if (!REGISTERED_START_RECEIPTS.has(receipt)) fail('unregistered_start_receipt');
  return `${JSON.stringify(receipt)}\n`;
}

export function parseBlindedHoldoutStartReceiptV2(bytes: unknown): BlindedHoldoutStartReceiptV2 {
  const copy = exactJsonBytes(bytes, 8_192);
  let text: string;
  let raw: Record<string, unknown>;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(copy);
    if (!text.endsWith('\n') || text.includes('\r') || text.slice(0, -1).includes('\n')) fail('start_receipt');
    const value = JSON.parse(text.slice(0, -1)) as unknown;
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      nodeUtilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      fail('start_receipt');
    raw = value as Record<string, unknown>;
    const keys = [
      'schemaVersion',
      'oneShotKey',
      'state',
      'repository',
      'workflowRunId',
      'workflowRunAttempt',
      'priorAuthoritativeReceiptCount',
      'candidateRunCount',
      'tombstoneRef',
      'tombstoneTargetSha',
      'tombstoneCreationStatus',
      'tombstoneVerificationStatus',
      'repositoryRootTreeOid',
      'historicalCandidateSubtreeOid',
      'currentCheckoutCandidateSubtreeOid',
      'policyReceiptSha256',
      'policyReceiptCanonicalBytesSha256',
      'receiptSha256',
    ];
    if (Reflect.ownKeys(raw).length !== keys.length || Reflect.ownKeys(raw).some((key) => typeof key !== 'string' || !keys.includes(key)))
      fail('start_receipt');
  } catch (error) {
    if (error instanceof BlindedHoldoutProtocolError) throw error;
    fail('start_receipt');
  }
  if (
    raw.schemaVersion !== 'memberry.admission-feature-blinded-holdout-start.v2' ||
    raw.oneShotKey !== blindedHoldoutOneShotKeyV2() ||
    raw.state !== 'burned-before-candidate-start' ||
    raw.repository !== 'AP3X-Dev/memberry' ||
    typeof raw.workflowRunId !== 'string' ||
    !RUN_ID_PATTERN.test(raw.workflowRunId) ||
    raw.workflowRunAttempt !== 1 ||
    raw.priorAuthoritativeReceiptCount !== 0 ||
    raw.candidateRunCount !== 0 ||
    raw.tombstoneRef !== `${BLINDED_HOLDOUT_TOMBSTONE_REF_PREFIX}${blindedHoldoutOneShotKeyV2().slice(7)}` ||
    typeof raw.tombstoneTargetSha !== 'string' ||
    !COMMIT_PATTERN.test(raw.tombstoneTargetSha) ||
    raw.tombstoneCreationStatus !== 201 ||
    raw.tombstoneVerificationStatus !== 200 ||
    raw.repositoryRootTreeOid !== BLINDED_HOLDOUT_REPOSITORY_ROOT_TREE_OID ||
    raw.historicalCandidateSubtreeOid !== BLINDED_HOLDOUT_HISTORICAL_CANDIDATE_SUBTREE_OID ||
    raw.currentCheckoutCandidateSubtreeOid !== BLINDED_HOLDOUT_CURRENT_CHECKOUT_CANDIDATE_SUBTREE_OID ||
    raw.policyReceiptSha256 !== BLINDED_HOLDOUT_POLICY_RECEIPT_SHA256 ||
    raw.policyReceiptCanonicalBytesSha256 !== BLINDED_HOLDOUT_POLICY_RECEIPT_CANONICAL_BYTES_SHA256
  ) {
    fail('start_receipt');
  }
  const payload = {
    schemaVersion: raw.schemaVersion,
    oneShotKey: raw.oneShotKey,
    state: raw.state,
    repository: raw.repository,
    workflowRunId: raw.workflowRunId,
    workflowRunAttempt: raw.workflowRunAttempt,
    priorAuthoritativeReceiptCount: raw.priorAuthoritativeReceiptCount,
    candidateRunCount: raw.candidateRunCount,
    tombstoneRef: raw.tombstoneRef,
    tombstoneTargetSha: raw.tombstoneTargetSha,
    tombstoneCreationStatus: raw.tombstoneCreationStatus,
    tombstoneVerificationStatus: raw.tombstoneVerificationStatus,
    repositoryRootTreeOid: raw.repositoryRootTreeOid,
    historicalCandidateSubtreeOid: raw.historicalCandidateSubtreeOid,
    currentCheckoutCandidateSubtreeOid: raw.currentCheckoutCandidateSubtreeOid,
    policyReceiptSha256: raw.policyReceiptSha256,
    policyReceiptCanonicalBytesSha256: raw.policyReceiptCanonicalBytesSha256,
  };
  if (raw.receiptSha256 !== sha256(JSON.stringify(payload))) fail('start_receipt');
  const receipt = Object.freeze({
    ...payload,
    receiptSha256: raw.receiptSha256,
  }) as BlindedHoldoutStartReceiptV2;
  REGISTERED_START_RECEIPTS.add(receipt);
  if (canonicalBlindedHoldoutStartReceiptV2(receipt) !== text) fail('start_receipt');
  return receipt;
}

export function buildBlindedHoldoutDockerCreateArgs(receipt: AdmissionC2RuntimePolicyReceiptV2, imageReference: string): readonly string[] {
  validatePolicyReceipt(receipt);
  if (typeof imageReference !== 'string' || imageReference.length === 0 || /[\0\r\n]/.test(imageReference)) {
    fail('image_reference');
  }
  const { policy } = receipt;
  return Object.freeze([
    'container',
    'create',
    '--interactive',
    '--network',
    policy.network,
    '--user',
    policy.user,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--cpus',
    policy.limits.cpu,
    '--memory',
    policy.limits.memory,
    '--memory-swap',
    policy.limits.memorySwap,
    '--pids-limit',
    String(policy.limits.pids),
    '--env',
    `LANG=${policy.environment.LANG}`,
    '--env',
    `LC_ALL=${policy.environment.LC_ALL}`,
    '--env',
    `TZ=${policy.environment.TZ}`,
    '--entrypoint',
    policy.entrypoint,
    imageReference,
    ...policy.arguments,
  ]);
}

function exactPredictionBytes(value: unknown): Uint8Array {
  if (typeof value !== 'object' || value === null || nodeUtilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Uint8Array.prototype)
    fail('prediction_validation');
  const bytes = value as Uint8Array;
  if (!Number.isSafeInteger(bytes.byteLength) || bytes.byteLength < 1 || bytes.byteLength > PREDICTION_MAX_BYTES) {
    fail('prediction_validation');
  }
  return Uint8Array.from(bytes);
}

function exactJsonBytes(value: unknown, maximum: number): Uint8Array {
  if (typeof value !== 'object' || value === null || nodeUtilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Uint8Array.prototype)
    fail('bytes');
  const bytes = value as Uint8Array;
  if (!Number.isSafeInteger(bytes.byteLength) || bytes.byteLength < 2 || bytes.byteLength > maximum) fail('bytes');
  return Uint8Array.from(bytes);
}

export async function scoreSealedBlindedHoldoutV2<
  TArtifact extends {
    readonly predictions: readonly AdmissionFeatureScenarioPredictionV1[];
  },
>(options: {
  nodeMajor: 20 | 22;
  candidateRunCount: number;
  candidateStopped: boolean;
  evidenceMode: string;
  predictionBytes: unknown;
  loadInputs: () => Promise<readonly AdmissionFeatureScenarioInputV1[]>;
  parsePrediction: (bytes: Uint8Array, inputs: readonly AdmissionFeatureScenarioInputV1[]) => TArtifact;
  loadOracles: () => Promise<readonly AdmissionFeatureScenarioOracleV1[]>;
  score: (options: {
    inputs: readonly AdmissionFeatureScenarioInputV1[];
    oracles: readonly AdmissionFeatureScenarioOracleV1[];
    predictions: readonly AdmissionFeatureScenarioPredictionV1[];
  }) => AdmissionFeatureAgreementReportV1;
}): Promise<BlindedHoldoutRuntimeEvidenceV2> {
  if (options.nodeMajor !== 20 && options.nodeMajor !== 22) fail('runtime');
  if (options.candidateRunCount !== 1) fail('candidate_run_count');
  if (options.candidateStopped !== true) fail('candidate_not_stopped');
  if (options.evidenceMode !== 'sealed-candidate-prediction') fail('evidence_mode');
  const bytes = exactPredictionBytes(options.predictionBytes);
  let inputs: readonly AdmissionFeatureScenarioInputV1[];
  let artifact: TArtifact;
  try {
    inputs = await options.loadInputs();
    artifact = options.parsePrediction(bytes, inputs);
  } catch {
    fail('prediction_validation');
  }
  let oracles: readonly AdmissionFeatureScenarioOracleV1[];
  try {
    oracles = await options.loadOracles();
  } catch {
    fail('oracle_access');
  }
  let report: AdmissionFeatureAgreementReportV1;
  try {
    report = options.score({
      inputs,
      oracles,
      predictions: artifact.predictions,
    });
  } catch {
    fail('scoring');
  }
  const holdout = report.splits.holdout;
  const aggregate = Object.freeze({
    scenarioCount: holdout.scenarioCount,
    dimensionCount: holdout.dimensionCount,
    agreementCount: holdout.agreementCount,
    agreementPermille: holdout.agreementPermille,
    availabilityMismatchCount: holdout.availabilityMismatchCount,
    valueMismatchCount: holdout.valueMismatchCount,
    passed:
      report.passed &&
      holdout.scenarioCount === 3 &&
      holdout.dimensionCount === 18 &&
      holdout.agreementCount === 18 &&
      holdout.agreementPermille === 1_000 &&
      holdout.availabilityMismatchCount === 0 &&
      holdout.valueMismatchCount === 0,
  });
  return createBlindedHoldoutRuntimeEvidenceV2({
    nodeMajor: options.nodeMajor,
    evidenceMode: 'sealed-candidate-prediction',
    candidateRunCount: 1,
    candidateStoppedBeforeOracle: true,
    predictionSha256: exactSha256(sha256(bytes)),
    aggregate,
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value)) fail('environment');
  return value;
}

function exactEnvironment(name: string, expected: string): string {
  const value = requiredEnvironment(name);
  if (value !== expected) fail('environment');
  return value;
}

function exactTrueEnvironment(name: string): true {
  exactEnvironment(name, 'true');
  return true;
}

function gitText(args: readonly string[]): string {
  try {
    return execFileSync('git', [...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    fail('git');
  }
}

function gitAncestor(base: string, head: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', base, head], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

async function loadPolicyReceipt(path: string): Promise<AdmissionC2RuntimePolicyReceiptV2> {
  try {
    const neutralModule = (await import(NEUTRAL_POLICY_V2_MODULE)) as Record<string, unknown>;
    const parser = neutralModule[NEUTRAL_POLICY_V2_PARSER_EXPORT];
    if (typeof parser !== 'function') fail('policy_authority');
    const [receiptBytes, legacyReceiptBytes] = await Promise.all([readFile(path), readFile(NEUTRAL_POLICY_V1_RECEIPT)]);
    const parsedReceipt = parser(
      new Uint8Array(receiptBytes),
      new Uint8Array(legacyReceiptBytes),
    ) as Omit<AdmissionC2RuntimePolicyReceiptV2, 'canonicalBytesSha256'>;
    if (
      parsedReceipt.receiptSha256 !== BLINDED_HOLDOUT_POLICY_RECEIPT_SHA256 ||
      sha256(new Uint8Array(receiptBytes)) !== BLINDED_HOLDOUT_POLICY_RECEIPT_CANONICAL_BYTES_SHA256
    )
      fail('policy_authority');
    const receipt = Object.freeze({
      receiptSha256: parsedReceipt.receiptSha256,
      canonicalBytesSha256: BLINDED_HOLDOUT_POLICY_RECEIPT_CANONICAL_BYTES_SHA256,
      binding: parsedReceipt.binding,
      policy: parsedReceipt.policy,
    });
    validatePolicyReceipt(receipt);
    return receipt;
  } catch {
    fail('policy_authority');
  }
}

async function commandPreflight(receiptPath: string, outputPath: string): Promise<void> {
  const receipt = await loadPolicyReceipt(receiptPath);
  const head = gitText(['rev-parse', 'HEAD']);
  const candidateStatus = gitText(['status', '--porcelain=v1', '--untracked-files=all', '--', 'bench/lab/admission-features/candidate']);
  const preflight = validateBlindedHoldoutPreflightV2({
    receipt,
    eventName: exactEnvironment('GITHUB_EVENT_NAME', 'workflow_dispatch'),
    repository: exactEnvironment('GITHUB_REPOSITORY', 'AP3X-Dev/memberry'),
    workflowRunId: requiredEnvironment('GITHUB_RUN_ID'),
    workflowRunAttempt: Number(requiredEnvironment('GITHUB_RUN_ATTEMPT')),
    priorAuthoritativeReceiptCount: Number(requiredEnvironment('MEMBERRY_PRIOR_AUTHORITATIVE_RECEIPTS')),
    evaluatedCommitSha: exactEnvironment('GITHUB_SHA', head),
    observedCheckoutCommitSha: head,
    integratedBaseIsAncestor: gitAncestor(BLINDED_HOLDOUT_INTEGRATED_BASE_SHA, head),
    candidateSubtreeClean: candidateStatus.length === 0,
    candidateContextOnly: exactEnvironment('MEMBERRY_CANDIDATE_CONTEXT_ONLY', 'true') === 'true',
    observedPlatform: exactEnvironment('MEMBERRY_OBSERVED_PLATFORM', receipt.policy.platform),
    observedBaseImage: exactEnvironment('MEMBERRY_OBSERVED_BASE_IMAGE', receipt.policy.baseImage),
    observedCandidateCommitSha: exactEnvironment('MEMBERRY_OBSERVED_CANDIDATE_COMMIT_SHA', receipt.binding.candidateCommitSha),
    observedRepositoryRootTreeOid: exactEnvironment('MEMBERRY_OBSERVED_REPOSITORY_ROOT_TREE_OID', BLINDED_HOLDOUT_REPOSITORY_ROOT_TREE_OID),
    observedHistoricalCandidateSubtreeOid: exactEnvironment(
      'MEMBERRY_OBSERVED_HISTORICAL_CANDIDATE_SUBTREE_OID',
      BLINDED_HOLDOUT_HISTORICAL_CANDIDATE_SUBTREE_OID,
    ),
    observedCheckoutCandidateSubtreeOid: exactEnvironment(
      'MEMBERRY_OBSERVED_CURRENT_CHECKOUT_CANDIDATE_SUBTREE_OID',
      BLINDED_HOLDOUT_CURRENT_CHECKOUT_CANDIDATE_SUBTREE_OID,
    ),
    observedInputSha256: exactEnvironment('MEMBERRY_OBSERVED_INPUT_SHA256', receipt.binding.inputSha256),
  });
  const output = `${JSON.stringify({
    schemaVersion: 'memberry.admission-feature-blinded-holdout-preflight.v2',
    oneShotKey: preflight.oneShotKey,
    policyReceiptSha256: preflight.policyReceiptSha256,
    policyReceiptCanonicalBytesSha256: preflight.policyReceiptCanonicalBytesSha256,
    integratedBaseSha: preflight.integratedBaseSha,
    evaluatedCommitSha: preflight.evaluatedCommitSha,
    candidateCommitSha: preflight.candidateCommitSha,
    repositoryRootTreeOid: preflight.repositoryRootTreeOid,
    historicalCandidateSubtreeOid: preflight.historicalCandidateSubtreeOid,
    currentCheckoutCandidateSubtreeOid: preflight.currentCheckoutCandidateSubtreeOid,
    workflowRunId: preflight.workflowRunId,
    workflowRunAttempt: preflight.workflowRunAttempt,
    priorAuthoritativeReceiptCount: preflight.priorAuthoritativeReceiptCount,
  })}\n`;
  await writeFile(outputPath, output, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}

async function commandStart(receiptPath: string, tombstonePath: string, outputPath: string): Promise<void> {
  const receipt = await loadPolicyReceipt(receiptPath);
  const head = gitText(['rev-parse', 'HEAD']);
  const preflight = validateBlindedHoldoutPreflightV2({
    receipt,
    eventName: exactEnvironment('GITHUB_EVENT_NAME', 'workflow_dispatch'),
    repository: exactEnvironment('GITHUB_REPOSITORY', 'AP3X-Dev/memberry'),
    workflowRunId: requiredEnvironment('GITHUB_RUN_ID'),
    workflowRunAttempt: Number(requiredEnvironment('GITHUB_RUN_ATTEMPT')),
    priorAuthoritativeReceiptCount: Number(requiredEnvironment('MEMBERRY_PRIOR_AUTHORITATIVE_RECEIPTS')),
    evaluatedCommitSha: exactEnvironment('GITHUB_SHA', head),
    observedCheckoutCommitSha: head,
    integratedBaseIsAncestor: gitAncestor(BLINDED_HOLDOUT_INTEGRATED_BASE_SHA, head),
    candidateSubtreeClean:
      gitText(['status', '--porcelain=v1', '--untracked-files=all', '--', 'bench/lab/admission-features/candidate']).length === 0,
    candidateContextOnly: exactEnvironment('MEMBERRY_CANDIDATE_CONTEXT_ONLY', 'true') === 'true',
    observedPlatform: exactEnvironment('MEMBERRY_OBSERVED_PLATFORM', receipt.policy.platform),
    observedBaseImage: exactEnvironment('MEMBERRY_OBSERVED_BASE_IMAGE', receipt.policy.baseImage),
    observedCandidateCommitSha: exactEnvironment('MEMBERRY_OBSERVED_CANDIDATE_COMMIT_SHA', receipt.binding.candidateCommitSha),
    observedRepositoryRootTreeOid: exactEnvironment('MEMBERRY_OBSERVED_REPOSITORY_ROOT_TREE_OID', BLINDED_HOLDOUT_REPOSITORY_ROOT_TREE_OID),
    observedHistoricalCandidateSubtreeOid: exactEnvironment(
      'MEMBERRY_OBSERVED_HISTORICAL_CANDIDATE_SUBTREE_OID',
      BLINDED_HOLDOUT_HISTORICAL_CANDIDATE_SUBTREE_OID,
    ),
    observedCheckoutCandidateSubtreeOid: exactEnvironment(
      'MEMBERRY_OBSERVED_CURRENT_CHECKOUT_CANDIDATE_SUBTREE_OID',
      BLINDED_HOLDOUT_CURRENT_CHECKOUT_CANDIDATE_SUBTREE_OID,
    ),
    observedInputSha256: exactEnvironment('MEMBERRY_OBSERVED_INPUT_SHA256', receipt.binding.inputSha256),
  });
  const tombstone = parseBlindedHoldoutTombstoneEvidenceV2(new Uint8Array(await readFile(tombstonePath)));
  await writeFile(outputPath, canonicalBlindedHoldoutStartReceiptV2(buildBlindedHoldoutStartReceiptV2(preflight, tombstone)), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}

async function commandTombstoneAuthorize(
  targetSha: string,
  lookupStatus: string,
  priorEvidenceArtifactCount: string,
  outputPath: string,
): Promise<void> {
  const spec = buildBlindedHoldoutTombstoneSpecV2(targetSha);
  validateBlindedHoldoutTombstoneAbsenceV2({
    spec,
    lookupStatus: Number(lookupStatus),
    priorEvidenceArtifactCount: Number(priorEvidenceArtifactCount),
  });
  await writeFile(outputPath, `${JSON.stringify({ ref: spec.ref, sha: spec.targetSha })}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}

async function commandBurnAuthorityAuthorize(
  retiredV1LookupStatus: string,
  retiredV2LookupStatus: string,
  v3LookupStatus: string,
  retiredV1EvidenceArtifactCount: string,
  retiredV2EvidenceArtifactCount: string,
  v3EvidenceArtifactCount: string,
  knownFailedV1RunArtifactCount: string,
  knownFailedV2RunArtifactCount: string,
): Promise<void> {
  validateBlindedHoldoutBurnAuthorityAbsenceV2({
    retiredV1LookupStatus: Number(retiredV1LookupStatus),
    retiredV2LookupStatus: Number(retiredV2LookupStatus),
    v3LookupStatus: Number(v3LookupStatus),
    retiredV1EvidenceArtifactCount: Number(retiredV1EvidenceArtifactCount),
    retiredV2EvidenceArtifactCount: Number(retiredV2EvidenceArtifactCount),
    v3EvidenceArtifactCount: Number(v3EvidenceArtifactCount),
    knownFailedV1RunArtifactCount: Number(knownFailedV1RunArtifactCount),
    knownFailedV2RunArtifactCount: Number(knownFailedV2RunArtifactCount),
  });
  process.stdout.write('{"ok":true,"schemaVersion":"memberry.admission-feature-blinded-holdout-burn-authority.v3"}\n');
}

async function readApiResponse(path: string): Promise<unknown> {
  const copy = exactJsonBytes(new Uint8Array(await readFile(path)), 32_768);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(copy));
  } catch {
    fail('tombstone_response');
  }
}

async function commandTombstoneVerify(
  targetSha: string,
  createStatus: string,
  createResponsePath: string,
  verificationStatus: string,
  verificationResponsePath: string,
  outputPath: string,
): Promise<void> {
  const spec = buildBlindedHoldoutTombstoneSpecV2(targetSha);
  const evidence = verifyBlindedHoldoutTombstoneCreationV2({
    spec,
    createStatus: Number(createStatus),
    createResponse: await readApiResponse(createResponsePath),
    verificationStatus: Number(verificationStatus),
    verificationResponse: await readApiResponse(verificationResponsePath),
  });
  await writeFile(outputPath, canonicalBlindedHoldoutTombstoneEvidenceV2(evidence), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}

async function commandInput(outputPath: string): Promise<void> {
  const { loadAdmissionFeatureInputs } = await import('../inputs.js');
  const bytes = new TextEncoder().encode(JSON.stringify(await loadAdmissionFeatureInputs()));
  if (bytes.byteLength > 32_768 || sha256(bytes) !== BLINDED_HOLDOUT_INPUT_SHA256) fail('input_identity');
  await writeFile(outputPath, bytes, { mode: 0o600, flag: 'wx' });
}

async function commandScore(predictionPath: string, outputPath: string): Promise<void> {
  exactEnvironment('MEMBERRY_CANDIDATE_STOPPED', 'true');
  exactEnvironment('MEMBERRY_CANDIDATE_RUN_COUNT', '1');
  const expectedNodeMajor = Number(requiredEnvironment('MEMBERRY_EXPECTED_NODE_MAJOR'));
  const observedNodeMajor = Number(process.versions.node.split('.')[0]);
  if ((expectedNodeMajor !== 20 && expectedNodeMajor !== 22) || observedNodeMajor !== expectedNodeMajor) fail('runtime');
  const predictionBytes = new Uint8Array(await readFile(predictionPath));
  const { loadAdmissionFeatureInputs } = await import('../inputs.js');
  const { parseAdmissionFeaturePredictionArtifactV1 } = await import('../prediction-artifact.js');
  const { scoreAdmissionFeatureAgreement } = await import('../scorer.js');
  const evidence = await scoreSealedBlindedHoldoutV2({
    nodeMajor: expectedNodeMajor,
    candidateRunCount: 1,
    candidateStopped: true,
    evidenceMode: 'sealed-candidate-prediction',
    predictionBytes,
    loadInputs: loadAdmissionFeatureInputs,
    parsePrediction: parseAdmissionFeaturePredictionArtifactV1,
    // Importing the custody module is itself delayed until the sealed bytes
    // have passed bounded parsing and corpus/order validation.
    loadOracles: async () => {
      const { loadAdmissionFeatureOracles } = await import('./load.js');
      return loadAdmissionFeatureOracles();
    },
    score: scoreAdmissionFeatureAgreement,
  });
  await writeFile(outputPath, canonicalBlindedHoldoutRuntimeEvidenceV2(evidence), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}

async function commandFinalize(
  receiptPath: string,
  node20Path: string,
  node22Path: string,
  startPath: string,
  preflightPath: string,
  custodyDirectory: string,
  outputPath: string,
): Promise<void> {
  const policyReceipt = await loadPolicyReceipt(receiptPath);
  const start = parseBlindedHoldoutStartReceiptV2(new Uint8Array(await readFile(startPath)));
  if (
    start.policyReceiptSha256 !== policyReceipt.receiptSha256 ||
    start.policyReceiptCanonicalBytesSha256 !== policyReceipt.canonicalBytesSha256
  )
    fail('policy_authority');
  if (start.workflowRunId !== exactEnvironment('GITHUB_RUN_ID', start.workflowRunId)) fail('start_receipt');
  const node20 = parseBlindedHoldoutRuntimeEvidenceV2(new Uint8Array(await readFile(node20Path)));
  const node22 = parseBlindedHoldoutRuntimeEvidenceV2(new Uint8Array(await readFile(node22Path)));
  await removeBlindedHoldoutPrivateEvidenceV2({
    custodyDirectory,
    node20Path,
    node22Path,
    preflightPath,
  });
  const cleanup = {
    candidateStopped: exactTrueEnvironment('MEMBERRY_CLEANUP_CANDIDATE_STOPPED'),
    containerRemoved: exactTrueEnvironment('MEMBERRY_CLEANUP_CONTAINER_REMOVED'),
    imageRemoved: exactTrueEnvironment('MEMBERRY_CLEANUP_IMAGE_REMOVED'),
    predictionRemoved: exactTrueEnvironment('MEMBERRY_CLEANUP_PREDICTION_REMOVED'),
    temporaryFilesRemoved: exactTrueEnvironment('MEMBERRY_CLEANUP_TEMPORARY_FILES_REMOVED'),
    noRawArtifactsPublished: exactTrueEnvironment('MEMBERRY_NO_RAW_ARTIFACTS_PUBLISHED'),
  } as const;
  const receipt = buildBlindedHoldoutReceiptV2({
    evaluatedCommitSha: exactEnvironment('GITHUB_SHA', start.tombstoneTargetSha),
    scorerSha256: exactSha256(requiredEnvironment('MEMBERRY_SCORER_SHA256')),
    predictionSha256: node20.predictionSha256,
    startReceiptSha256: start.receiptSha256,
    tombstone: {
      ref: start.tombstoneRef,
      targetSha: start.tombstoneTargetSha,
      preexisting: false,
      creationStatus: start.tombstoneCreationStatus,
      verificationStatus: start.tombstoneVerificationStatus,
    },
    workflowRunId: start.workflowRunId,
    workflowRunAttempt: 1,
    priorAuthoritativeReceiptCount: 0,
    candidateRunCount: 1,
    runtimes: [node20, node22],
    cleanup,
  });
  await writeFile(outputPath, canonicalBlindedHoldoutReceiptV2(receipt), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}

export async function removeBlindedHoldoutPrivateEvidenceV2(options: {
  readonly custodyDirectory: string;
  readonly node20Path: string;
  readonly node22Path: string;
  readonly preflightPath: string;
}): Promise<void> {
  const { custodyDirectory, node20Path, node22Path, preflightPath } = options;
  const custodyRoot = resolve(custodyDirectory);
  const custodyFiles = [
    [node20Path, 'node20.json'],
    [node22Path, 'node22.json'],
    [preflightPath, 'preflight.json'],
  ].map(([path, expectedName]) => ({
    resolvedPath: resolve(path),
    expectedName,
  }));
  if (
    custodyFiles.some(({ resolvedPath, expectedName }) => dirname(resolvedPath) !== custodyRoot || basename(resolvedPath) !== expectedName)
  )
    fail('cleanup');
  for (const { resolvedPath } of custodyFiles) {
    await unlink(resolvedPath).catch(() => fail('cleanup'));
  }
  if ((await readdir(custodyRoot)).length !== 0) fail('cleanup');
}

async function commandVerify(receiptPath: string): Promise<void> {
  const receipt = parseBlindedHoldoutReceiptV2(new Uint8Array(await readFile(receiptPath)));
  assertBlindedHoldoutPromotionV2(receipt);
  process.stdout.write('{"ok":true,"schemaVersion":"memberry.admission-feature-blinded-holdout-receipt.v2"}\n');
}

export function assertBlindedHoldoutPromotionV2(receipt: { readonly outcome: string }): void {
  if (receipt.outcome !== 'passed') fail('agreement');
}

async function main(args: readonly string[]): Promise<void> {
  const [command, ...paths] = args;
  if (command === 'preflight' && paths.length === 2) return commandPreflight(paths[0]!, paths[1]!);
  if (command === 'start' && paths.length === 3) return commandStart(paths[0]!, paths[1]!, paths[2]!);
  if (command === 'tombstone-authorize' && paths.length === 4) {
    return commandTombstoneAuthorize(paths[0]!, paths[1]!, paths[2]!, paths[3]!);
  }
  if (command === 'burn-authority-authorize' && paths.length === 8) {
    return commandBurnAuthorityAuthorize(
      paths[0]!, paths[1]!, paths[2]!, paths[3]!, paths[4]!, paths[5]!, paths[6]!, paths[7]!,
    );
  }
  if (command === 'tombstone-verify' && paths.length === 6) {
    return commandTombstoneVerify(paths[0]!, paths[1]!, paths[2]!, paths[3]!, paths[4]!, paths[5]!);
  }
  if (command === 'input' && paths.length === 1) return commandInput(paths[0]!);
  if (command === 'score' && paths.length === 2) return commandScore(paths[0]!, paths[1]!);
  if (command === 'finalize' && paths.length === 7) {
    return commandFinalize(paths[0]!, paths[1]!, paths[2]!, paths[3]!, paths[4]!, paths[5]!, paths[6]!);
  }
  if (command === 'verify' && paths.length === 1) return commandVerify(paths[0]!);
  fail('command');
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/scorer-only/blinded-holdout.ts')) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    const message =
      error instanceof BlindedHoldoutProtocolError
        ? error.message
        : error instanceof Error && /^mem002c3_artifact:[a-z_]+$/.test(error.message)
          ? error.message
          : 'mem002c3_protocol:unexpected';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
