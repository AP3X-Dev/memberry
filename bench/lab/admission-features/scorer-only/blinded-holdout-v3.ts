// MEM-002 productionization: v3 blinded-holdout protocol driver.
//
// Mirrors the frozen blinded-holdout.ts subcommand surface (preflight, start,
// tombstone-authorize, burn-authority-authorize, tombstone-verify, input,
// score, finalize, verify) with the v3 substitutions: every identity
// expectation comes from the custodian seal (scorer-only/v3/seal.json, env
// SEAL_PATH) instead of frozen constants; the runtime policy is attested by
// the v4 C2 receipt chain; scoring emits BOTH per-split aggregates over the
// narrowed three-dimension envelope. `input` is the ONE seal-free subcommand:
// with SEAL_PATH absent it emits the canonical input bytes and their hash for
// seal authoring; whenever the seal exists it asserts the bytes hash to
// seal.inputSha256. The `score` subcommand recomputes the sealed oracle-byte
// hash via the single seal-free definition in load-v3.ts BEFORE any oracle
// open and fails loudly on mismatch.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { types as nodeUtilTypes } from 'node:util';

import type { AdmissionC2RuntimePolicyReceiptV4 } from '../contracts/c2-runtime-policy-receipt-v4.js';
import type {
  AdmissionFeatureScenarioInputV3,
  AdmissionFeatureScenarioOracleV3,
} from '../contract-v3.js';
import type { AdmissionFeatureAgreementReportV3 } from '../scorer-v3.js';
import type { AdmissionFeaturePredictionArtifactV3 } from '../prediction-artifact-v3.js';
import {
  BLINDED_HOLDOUT_RETIRED_V4_ONE_SHOT_KEY,
  BLINDED_HOLDOUT_V3_ARTIFACT_VERSION,
  BLINDED_HOLDOUT_V3_TOMBSTONE_REF_PREFIX,
  blindedHoldoutSealedOneShotKeyV3,
  parseBlindedHoldoutAggregateV3,
  parseBlindedHoldoutSealV3,
  validateBlindedHoldoutBurnAuthorityAbsenceV3,
  type BlindedHoldoutAggregateV3,
  type BlindedHoldoutSealV3,
} from './blinded-holdout-artifact-v3.js';

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/;
const PREDICTION_MAX_BYTES = 32_768;
const INPUT_MAX_BYTES = 32_768;
const MAX_RECEIPT_BYTES = 16_384;
const DEV_SCENARIO_COUNT = 14;
const REGISTERED_PREFLIGHTS = new WeakSet<object>();
const REGISTERED_START_RECEIPTS = new WeakSet<object>();
const REGISTERED_TOMBSTONE_SPECS = new WeakSet<object>();
const REGISTERED_TOMBSTONE_EVIDENCE = new WeakSet<object>();
const REGISTERED_RUNTIME_EVIDENCE = new WeakSet<object>();
const REGISTERED_RECEIPTS = new WeakSet<object>();
const NEUTRAL_POLICY_V4_MODULE = '../contracts/c2-runtime-policy-receipt-v4.js';
const NEUTRAL_POLICY_V4_PARSER_EXPORT = 'parseAdmissionC2RuntimePolicyReceiptV4';
const NEUTRAL_POLICY_V3_RECEIPT = new URL('../contracts/c2-runtime-policy-receipt.v3.json', import.meta.url);
const NEUTRAL_POLICY_V2_RECEIPT = new URL('../contracts/c2-runtime-policy-receipt.v2.json', import.meta.url);
const NEUTRAL_POLICY_V1_RECEIPT = new URL('../contracts/c2-runtime-policy-receipt.v1.json', import.meta.url);
const SEAL_PATH_ENV = 'SEAL_PATH';

export class BlindedHoldoutProtocolV3Error extends Error {
  constructor(readonly code: string) {
    super(`mem002prod_protocol:${code}`);
    this.name = 'BlindedHoldoutProtocolV3Error';
  }
}

function fail(code: string): never {
  throw new BlindedHoldoutProtocolV3Error(code);
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

function plainRecord(value: unknown, code: string): Record<string, unknown> {
  if (
    typeof value !== 'object' || value === null || Array.isArray(value)
    || nodeUtilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
  )
    fail(code);
  return value as Record<string, unknown>;
}

function closedRecord(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  const record = plainRecord(value, code);
  const ownKeys = Reflect.ownKeys(record);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    fail(code);
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) fail(code);
    result[key] = descriptor.value;
  }
  return result;
}

function exactJsonBytes(value: unknown, maximum: number, code: string): Uint8Array {
  if (typeof value !== 'object' || value === null || nodeUtilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Uint8Array.prototype) fail(code);
  const bytes = value as Uint8Array;
  if (!Number.isSafeInteger(bytes.byteLength) || bytes.byteLength < 2 || bytes.byteLength > maximum) fail(code);
  return Uint8Array.from(bytes);
}

function canonicalLine(bytes: Uint8Array, code: string): { text: string; raw: Record<string, unknown> } {
  let text: string;
  let raw: Record<string, unknown>;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!text.endsWith('\n') || text.includes('\r') || text.slice(0, -1).includes('\n')) fail(code);
    raw = plainRecord(JSON.parse(text.slice(0, -1)) as unknown, code);
  } catch (error) {
    if (error instanceof BlindedHoldoutProtocolV3Error) throw error;
    fail(code);
  }
  return { text, raw };
}

/**
 * Same content-secrecy discipline as the frozen v2 receipts, extended with the
 * v3 scenario-id scheme (af3-dev / af3-holdout ids). Applied to every canonical
 * byte surface this driver may publish.
 */
export function assertBlindedHoldoutSecretSafeV3(canonical: string): void {
  if (
    /"(?:scenarioId|features|dimensions|valuePermille|fixtureCode|predictions|stdout|stderr|rawPrediction)"/i.test(canonical)
    || /af-(?:dev|holdout)-[0-9]|af3-(?:dev|holdout)-[0-9]|case-[0-9]/i.test(canonical)
  )
    fail('secret_safety');
}

// ---------------------------------------------------------------------------
// Seal custody
// ---------------------------------------------------------------------------

function sealPath(): string | undefined {
  const value = process.env[SEAL_PATH_ENV];
  if (value === undefined) return undefined;
  if (value.length === 0 || /[\0\r\n]/.test(value)) fail('seal_path');
  return value;
}

async function loadSealV3(): Promise<BlindedHoldoutSealV3> {
  const path = sealPath();
  if (path === undefined) fail('seal_required');
  try {
    return parseBlindedHoldoutSealV3(new Uint8Array(await readFile(path)));
  } catch (error) {
    if (error instanceof Error && /^mem002prod_artifact:[a-z_]+$/.test(error.message)) throw error;
    fail('seal_required');
  }
}

/** Canonical serialized dev+holdout input bytes (v2 precedent: JSON.stringify of the parsed list). */
export async function sealedAdmissionFeatureInputBytesV3(repoRoot = process.cwd()): Promise<Uint8Array> {
  const { loadAdmissionFeatureInputsV3 } = await import('../inputs-v3.js');
  const inputs = await loadAdmissionFeatureInputsV3(['dev', 'holdout'], repoRoot);
  const bytes = new TextEncoder().encode(JSON.stringify(inputs));
  if (bytes.byteLength < 2 || bytes.byteLength > INPUT_MAX_BYTES) fail('input_identity');
  return bytes;
}

export function assertSealedInputBytesV3(seal: BlindedHoldoutSealV3, bytes: Uint8Array): void {
  if (sha256(bytes) !== seal.inputSha256) fail('input_identity');
}

export function assertSealedOracleBytesV3(seal: BlindedHoldoutSealV3, bytes: Uint8Array): void {
  if (sha256(bytes) !== seal.oracleSha256) fail('oracle_identity');
}

// ---------------------------------------------------------------------------
// Policy receipt (v4 chain)
// ---------------------------------------------------------------------------

async function loadPolicyReceiptV4(path: string, seal: BlindedHoldoutSealV3): Promise<Readonly<{
  receipt: AdmissionC2RuntimePolicyReceiptV4;
  canonicalBytesSha256: `sha256:${string}`;
}>> {
  try {
    const neutralModule = (await import(NEUTRAL_POLICY_V4_MODULE)) as Record<string, unknown>;
    const parser = neutralModule[NEUTRAL_POLICY_V4_PARSER_EXPORT];
    if (typeof parser !== 'function') fail('policy_authority');
    const [receiptBytes, v3Bytes, v2Bytes, v1Bytes] = await Promise.all([
      readFile(path), readFile(NEUTRAL_POLICY_V3_RECEIPT),
      readFile(NEUTRAL_POLICY_V2_RECEIPT), readFile(NEUTRAL_POLICY_V1_RECEIPT),
    ]);
    const receipt = parser(
      new Uint8Array(receiptBytes), new Uint8Array(v3Bytes),
      new Uint8Array(v2Bytes), new Uint8Array(v1Bytes),
    ) as AdmissionC2RuntimePolicyReceiptV4;
    if (
      receipt.binding.candidateCommitSha !== seal.candidateCommitSha
      || receipt.binding.repositoryRootTreeOid !== seal.repositoryRootTreeOid
      || receipt.binding.candidateSubtreeOid !== seal.candidateSubtreeOid
      || receipt.binding.candidateSha256 !== seal.candidateSha256
    )
      fail('policy_authority');
    return Object.freeze({ receipt, canonicalBytesSha256: sha256(new Uint8Array(receiptBytes)) });
  } catch {
    fail('policy_authority');
  }
}

// ---------------------------------------------------------------------------
// Tombstone (same append-only namespace, v3 schemas, seal-derived key)
// ---------------------------------------------------------------------------

export interface BlindedHoldoutTombstoneSpecV3 {
  readonly schemaVersion: 'memberry.admission-feature-blinded-holdout-tombstone-spec.v3';
  readonly oneShotKey: `sha256:${string}`;
  readonly ref: `refs/tags/memberry-mem002c3-burn/${string}`;
  readonly apiRef: `tags/memberry-mem002c3-burn/${string}`;
  readonly targetSha: string;
}

export interface BlindedHoldoutTombstoneEvidenceV3 {
  readonly schemaVersion: 'memberry.admission-feature-blinded-holdout-tombstone.v3';
  readonly oneShotKey: `sha256:${string}`;
  readonly ref: `refs/tags/memberry-mem002c3-burn/${string}`;
  readonly targetSha: string;
  readonly preexisting: false;
  readonly creationStatus: 201;
  readonly verificationStatus: 200;
}

export function buildBlindedHoldoutTombstoneSpecV3(
  seal: BlindedHoldoutSealV3,
  targetSha: string,
): BlindedHoldoutTombstoneSpecV3 {
  const oneShotKey = blindedHoldoutSealedOneShotKeyV3(seal);
  const key = oneShotKey.slice('sha256:'.length);
  const spec = Object.freeze({
    schemaVersion: 'memberry.admission-feature-blinded-holdout-tombstone-spec.v3' as const,
    oneShotKey,
    ref: `${BLINDED_HOLDOUT_V3_TOMBSTONE_REF_PREFIX}${key}` as const,
    apiRef: `tags/memberry-mem002c3-burn/${key}` as const,
    targetSha: exactCommit(targetSha),
  });
  REGISTERED_TOMBSTONE_SPECS.add(spec);
  return spec;
}

export function validateBlindedHoldoutTombstoneAbsenceV3(options: {
  readonly spec: BlindedHoldoutTombstoneSpecV3;
  readonly lookupStatus: number;
  readonly priorEvidenceArtifactCount: number;
}): BlindedHoldoutTombstoneSpecV3 {
  if (!REGISTERED_TOMBSTONE_SPECS.has(options.spec)) fail('tombstone_spec');
  if (!Number.isSafeInteger(options.priorEvidenceArtifactCount) || options.priorEvidenceArtifactCount < 0) {
    fail('tombstone_evidence');
  }
  if (options.priorEvidenceArtifactCount !== 0) fail('tombstone_evidence');
  if (options.lookupStatus === 200) fail('tombstone_preexisting');
  if (options.lookupStatus !== 404) fail('tombstone_lookup');
  return options.spec;
}

function exactGitHubRefResponse(value: unknown, spec: BlindedHoldoutTombstoneSpecV3): void {
  const response = plainRecord(value, 'tombstone_response');
  const object = plainRecord(response.object, 'tombstone_response');
  if (response.ref !== spec.ref || object.type !== 'commit' || object.sha !== spec.targetSha) {
    fail('tombstone_response');
  }
}

export function verifyBlindedHoldoutTombstoneCreationV3(options: {
  readonly spec: BlindedHoldoutTombstoneSpecV3;
  readonly createStatus: number;
  readonly createResponse: unknown;
  readonly verificationStatus: number;
  readonly verificationResponse: unknown;
}): BlindedHoldoutTombstoneEvidenceV3 {
  if (!REGISTERED_TOMBSTONE_SPECS.has(options.spec)) fail('tombstone_spec');
  if (options.createStatus === 422) fail('tombstone_race');
  if (options.createStatus !== 201) fail('tombstone_create');
  if (options.verificationStatus !== 200) fail('tombstone_verify');
  exactGitHubRefResponse(options.createResponse, options.spec);
  exactGitHubRefResponse(options.verificationResponse, options.spec);
  const evidence = Object.freeze({
    schemaVersion: 'memberry.admission-feature-blinded-holdout-tombstone.v3' as const,
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

export function canonicalBlindedHoldoutTombstoneEvidenceV3(evidence: BlindedHoldoutTombstoneEvidenceV3): string {
  if (!REGISTERED_TOMBSTONE_EVIDENCE.has(evidence)) fail('tombstone_evidence');
  return `${JSON.stringify(evidence)}\n`;
}

export function parseBlindedHoldoutTombstoneEvidenceV3(
  seal: BlindedHoldoutSealV3,
  bytes: unknown,
): BlindedHoldoutTombstoneEvidenceV3 {
  const copy = exactJsonBytes(bytes, 4_096, 'tombstone_evidence');
  const { text, raw } = canonicalLine(copy, 'tombstone_evidence');
  const keys = ['schemaVersion', 'oneShotKey', 'ref', 'targetSha', 'preexisting', 'creationStatus', 'verificationStatus'];
  if (Reflect.ownKeys(raw).length !== keys.length
    || Reflect.ownKeys(raw).some((key) => typeof key !== 'string' || !keys.includes(key))) {
    fail('tombstone_evidence');
  }
  const spec = buildBlindedHoldoutTombstoneSpecV3(seal, raw.targetSha as string);
  if (
    raw.schemaVersion !== 'memberry.admission-feature-blinded-holdout-tombstone.v3'
    || raw.oneShotKey !== spec.oneShotKey
    || raw.ref !== spec.ref
    || raw.preexisting !== false
    || raw.creationStatus !== 201
    || raw.verificationStatus !== 200
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
  }) as BlindedHoldoutTombstoneEvidenceV3;
  REGISTERED_TOMBSTONE_EVIDENCE.add(evidence);
  if (canonicalBlindedHoldoutTombstoneEvidenceV3(evidence) !== text) fail('tombstone_evidence');
  return evidence;
}

// ---------------------------------------------------------------------------
// Preflight and start
// ---------------------------------------------------------------------------

export interface BlindedHoldoutPreflightV3 {
  readonly oneShotKey: `sha256:${string}`;
  readonly repository: 'AP3X-Dev/memberry';
  readonly workflowRunId: string;
  readonly workflowRunAttempt: 1;
  readonly priorAuthoritativeReceiptCount: 0;
  readonly seal: BlindedHoldoutSealV3;
  readonly evaluatedCommitSha: string;
  readonly policyReceiptSha256: `sha256:${string}`;
  readonly policyReceiptCanonicalBytesSha256: `sha256:${string}`;
}

export function validateBlindedHoldoutPreflightV3(options: {
  seal: BlindedHoldoutSealV3;
  policyReceiptSha256: `sha256:${string}`;
  policyReceiptCanonicalBytesSha256: `sha256:${string}`;
  observedPlatform: string;
  observedBaseImage: string;
  expectedPlatform: string;
  expectedBaseImage: string;
  eventName: string;
  repository: string;
  workflowRunId: string;
  workflowRunAttempt: number;
  priorAuthoritativeReceiptCount: number;
  evaluatedCommitSha: string;
  observedCheckoutCommitSha: string;
  integratedBaseIsAncestor: boolean;
  candidateSubtreeClean: boolean;
  coreSubtreeClean: boolean;
  candidateContextOnly: boolean;
  observedCandidateCommitSha: string;
  observedRepositoryRootTreeOid: string;
  observedCandidateSubtreeOid: string;
  observedCoreSubtreeOid: string;
  observedInputSha256: string;
}): BlindedHoldoutPreflightV3 {
  const { seal } = options;
  if (options.eventName !== 'workflow_dispatch') fail('workflow_event');
  if (options.repository !== 'AP3X-Dev/memberry' || !RUN_ID_PATTERN.test(options.workflowRunId)) fail('workflow_identity');
  if (options.workflowRunAttempt !== 1) fail('workflow_attempt');
  if (options.priorAuthoritativeReceiptCount !== 0) fail('duplicate_attempt');
  const evaluatedCommitSha = exactCommit(options.evaluatedCommitSha);
  if (exactCommit(options.observedCheckoutCommitSha) !== evaluatedCommitSha) fail('checkout_commit');
  if (options.integratedBaseIsAncestor !== true) fail('base_ancestry');
  if (options.candidateSubtreeClean !== true || options.coreSubtreeClean !== true) fail('candidate_dirty');
  if (options.candidateContextOnly !== true) fail('candidate_context');
  if (options.observedPlatform !== options.expectedPlatform) fail('platform');
  if (options.observedBaseImage !== options.expectedBaseImage) fail('base_image');
  if (
    options.observedCandidateCommitSha !== seal.candidateCommitSha
    || options.observedRepositoryRootTreeOid !== seal.repositoryRootTreeOid
    || options.observedCandidateSubtreeOid !== seal.candidateSubtreeOid
    || options.observedCoreSubtreeOid !== seal.coreSubtreeOid
  )
    fail('candidate_identity');
  if (options.observedInputSha256 !== seal.inputSha256) fail('input_identity');
  const preflight = Object.freeze({
    oneShotKey: blindedHoldoutSealedOneShotKeyV3(seal),
    repository: 'AP3X-Dev/memberry' as const,
    workflowRunId: options.workflowRunId,
    workflowRunAttempt: 1 as const,
    priorAuthoritativeReceiptCount: 0 as const,
    seal,
    evaluatedCommitSha,
    policyReceiptSha256: exactSha256(options.policyReceiptSha256),
    policyReceiptCanonicalBytesSha256: exactSha256(options.policyReceiptCanonicalBytesSha256),
  });
  REGISTERED_PREFLIGHTS.add(preflight);
  return preflight;
}

export interface BlindedHoldoutStartReceiptV3 {
  readonly schemaVersion: 'memberry.admission-feature-blinded-holdout-start.v3';
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
  readonly repositoryRootTreeOid: string;
  readonly candidateSubtreeOid: string;
  readonly coreSubtreeOid: string;
  readonly policyReceiptSha256: `sha256:${string}`;
  readonly policyReceiptCanonicalBytesSha256: `sha256:${string}`;
  readonly receiptSha256: `sha256:${string}`;
}

export function buildBlindedHoldoutStartReceiptV3(
  preflight: BlindedHoldoutPreflightV3,
  tombstone: BlindedHoldoutTombstoneEvidenceV3,
): BlindedHoldoutStartReceiptV3 {
  if (!REGISTERED_PREFLIGHTS.has(preflight)) fail('unregistered_preflight');
  if (
    !REGISTERED_TOMBSTONE_EVIDENCE.has(tombstone)
    || tombstone.oneShotKey !== preflight.oneShotKey
    || tombstone.targetSha !== preflight.evaluatedCommitSha
  )
    fail('tombstone_evidence');
  const payload = Object.freeze({
    schemaVersion: 'memberry.admission-feature-blinded-holdout-start.v3' as const,
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
    repositoryRootTreeOid: preflight.seal.repositoryRootTreeOid,
    candidateSubtreeOid: preflight.seal.candidateSubtreeOid,
    coreSubtreeOid: preflight.seal.coreSubtreeOid,
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

export function canonicalBlindedHoldoutStartReceiptV3(receipt: BlindedHoldoutStartReceiptV3): string {
  if (!REGISTERED_START_RECEIPTS.has(receipt)) fail('unregistered_start_receipt');
  return `${JSON.stringify(receipt)}\n`;
}

export function parseBlindedHoldoutStartReceiptV3(
  seal: BlindedHoldoutSealV3,
  bytes: unknown,
): BlindedHoldoutStartReceiptV3 {
  const copy = exactJsonBytes(bytes, 8_192, 'start_receipt');
  const { text, raw } = canonicalLine(copy, 'start_receipt');
  const record = closedRecord(raw, [
    'schemaVersion', 'oneShotKey', 'state', 'repository', 'workflowRunId', 'workflowRunAttempt',
    'priorAuthoritativeReceiptCount', 'candidateRunCount', 'tombstoneRef', 'tombstoneTargetSha',
    'tombstoneCreationStatus', 'tombstoneVerificationStatus', 'repositoryRootTreeOid',
    'candidateSubtreeOid', 'coreSubtreeOid', 'policyReceiptSha256',
    'policyReceiptCanonicalBytesSha256', 'receiptSha256',
  ], 'start_receipt');
  const oneShotKey = blindedHoldoutSealedOneShotKeyV3(seal);
  if (
    record.schemaVersion !== 'memberry.admission-feature-blinded-holdout-start.v3'
    || record.oneShotKey !== oneShotKey
    || record.state !== 'burned-before-candidate-start'
    || record.repository !== 'AP3X-Dev/memberry'
    || typeof record.workflowRunId !== 'string'
    || !RUN_ID_PATTERN.test(record.workflowRunId)
    || record.workflowRunAttempt !== 1
    || record.priorAuthoritativeReceiptCount !== 0
    || record.candidateRunCount !== 0
    || record.tombstoneRef !== `${BLINDED_HOLDOUT_V3_TOMBSTONE_REF_PREFIX}${oneShotKey.slice(7)}`
    || typeof record.tombstoneTargetSha !== 'string'
    || !COMMIT_PATTERN.test(record.tombstoneTargetSha)
    || record.tombstoneCreationStatus !== 201
    || record.tombstoneVerificationStatus !== 200
    || record.repositoryRootTreeOid !== seal.repositoryRootTreeOid
    || record.candidateSubtreeOid !== seal.candidateSubtreeOid
    || record.coreSubtreeOid !== seal.coreSubtreeOid
    || typeof record.policyReceiptSha256 !== 'string'
    || !SHA256_PATTERN.test(record.policyReceiptSha256)
    || typeof record.policyReceiptCanonicalBytesSha256 !== 'string'
    || !SHA256_PATTERN.test(record.policyReceiptCanonicalBytesSha256)
  )
    fail('start_receipt');
  const payload = {
    schemaVersion: record.schemaVersion,
    oneShotKey: record.oneShotKey,
    state: record.state,
    repository: record.repository,
    workflowRunId: record.workflowRunId,
    workflowRunAttempt: record.workflowRunAttempt,
    priorAuthoritativeReceiptCount: record.priorAuthoritativeReceiptCount,
    candidateRunCount: record.candidateRunCount,
    tombstoneRef: record.tombstoneRef,
    tombstoneTargetSha: record.tombstoneTargetSha,
    tombstoneCreationStatus: record.tombstoneCreationStatus,
    tombstoneVerificationStatus: record.tombstoneVerificationStatus,
    repositoryRootTreeOid: record.repositoryRootTreeOid,
    candidateSubtreeOid: record.candidateSubtreeOid,
    coreSubtreeOid: record.coreSubtreeOid,
    policyReceiptSha256: record.policyReceiptSha256,
    policyReceiptCanonicalBytesSha256: record.policyReceiptCanonicalBytesSha256,
  };
  if (record.receiptSha256 !== sha256(JSON.stringify(payload))) fail('start_receipt');
  const receipt = Object.freeze({
    ...payload,
    receiptSha256: record.receiptSha256,
  }) as BlindedHoldoutStartReceiptV3;
  REGISTERED_START_RECEIPTS.add(receipt);
  if (canonicalBlindedHoldoutStartReceiptV3(receipt) !== text) fail('start_receipt');
  return receipt;
}

// ---------------------------------------------------------------------------
// Runtime evidence (both per-split aggregates)
// ---------------------------------------------------------------------------

export interface BlindedHoldoutRuntimeEvidenceV3 {
  readonly nodeMajor: 20 | 22;
  readonly evidenceMode: 'sealed-candidate-prediction';
  readonly candidateRunCount: 1;
  readonly candidateStoppedBeforeOracle: true;
  readonly predictionSha256: `sha256:${string}`;
  readonly devAggregate: BlindedHoldoutAggregateV3;
  readonly holdoutAggregate: BlindedHoldoutAggregateV3;
  readonly evidenceSha256: `sha256:${string}`;
}

export function createBlindedHoldoutRuntimeEvidenceV3(options: {
  nodeMajor: 20 | 22;
  evidenceMode: 'sealed-candidate-prediction';
  candidateRunCount: 1;
  candidateStoppedBeforeOracle: true;
  predictionSha256: `sha256:${string}`;
  devAggregate: BlindedHoldoutAggregateV3;
  holdoutAggregate: BlindedHoldoutAggregateV3;
}): BlindedHoldoutRuntimeEvidenceV3 {
  if (options.nodeMajor !== 20 && options.nodeMajor !== 22) fail('runtime');
  if (options.evidenceMode !== 'sealed-candidate-prediction') fail('runtime');
  if (options.candidateRunCount !== 1 || options.candidateStoppedBeforeOracle !== true) fail('runtime');
  const payload = Object.freeze({
    nodeMajor: options.nodeMajor,
    evidenceMode: options.evidenceMode,
    candidateRunCount: options.candidateRunCount,
    candidateStoppedBeforeOracle: options.candidateStoppedBeforeOracle,
    predictionSha256: exactSha256(options.predictionSha256),
    devAggregate: parseBlindedHoldoutAggregateV3(options.devAggregate),
    holdoutAggregate: parseBlindedHoldoutAggregateV3(options.holdoutAggregate),
  });
  const evidence = Object.freeze({
    ...payload,
    evidenceSha256: sha256(JSON.stringify(payload)),
  });
  REGISTERED_RUNTIME_EVIDENCE.add(evidence);
  return evidence;
}

export function canonicalBlindedHoldoutRuntimeEvidenceV3(evidence: BlindedHoldoutRuntimeEvidenceV3): string {
  if (!REGISTERED_RUNTIME_EVIDENCE.has(evidence)) fail('unregistered_runtime');
  const canonical = `${JSON.stringify(evidence)}\n`;
  assertBlindedHoldoutSecretSafeV3(canonical);
  return canonical;
}

export function parseBlindedHoldoutRuntimeEvidenceV3(bytes: unknown): BlindedHoldoutRuntimeEvidenceV3 {
  const copy = exactJsonBytes(bytes, 4_096, 'canonical');
  const { text, raw } = canonicalLine(copy, 'canonical');
  const record = closedRecord(raw, [
    'nodeMajor', 'evidenceMode', 'candidateRunCount', 'candidateStoppedBeforeOracle',
    'predictionSha256', 'devAggregate', 'holdoutAggregate', 'evidenceSha256',
  ], 'canonical');
  const evidence = createBlindedHoldoutRuntimeEvidenceV3({
    nodeMajor: record.nodeMajor as 20 | 22,
    evidenceMode: record.evidenceMode as 'sealed-candidate-prediction',
    candidateRunCount: record.candidateRunCount as 1,
    candidateStoppedBeforeOracle: record.candidateStoppedBeforeOracle as true,
    predictionSha256: record.predictionSha256 as `sha256:${string}`,
    devAggregate: record.devAggregate as BlindedHoldoutAggregateV3,
    holdoutAggregate: record.holdoutAggregate as BlindedHoldoutAggregateV3,
  });
  if (evidence.evidenceSha256 !== record.evidenceSha256
    || canonicalBlindedHoldoutRuntimeEvidenceV3(evidence) !== text) fail('hash');
  return evidence;
}

// ---------------------------------------------------------------------------
// Scoring over sealed prediction bytes
// ---------------------------------------------------------------------------

function splitAggregate(
  report: AdmissionFeatureAgreementReportV3,
  split: 'dev' | 'holdout',
): BlindedHoldoutAggregateV3 {
  const metrics = report.splits[split];
  return Object.freeze({
    scenarioCount: metrics.scenarioCount,
    dimensionCount: metrics.dimensionCount,
    agreementCount: metrics.agreementCount,
    agreementPermille: metrics.agreementPermille,
    availabilityMismatchCount: metrics.availabilityMismatchCount,
    valueMismatchCount: metrics.valueMismatchCount,
    passed: metrics.dimensionCount === metrics.scenarioCount * 3
      && metrics.agreementCount === metrics.dimensionCount
      && metrics.agreementPermille === 1_000
      && metrics.availabilityMismatchCount === 0
      && metrics.valueMismatchCount === 0,
  });
}

export async function scoreSealedBlindedHoldoutV3(options: {
  nodeMajor: 20 | 22;
  candidateRunCount: number;
  candidateStopped: boolean;
  evidenceMode: string;
  seal: BlindedHoldoutSealV3;
  predictionBytes: unknown;
  loadInputs: () => Promise<readonly AdmissionFeatureScenarioInputV3[]>;
  parsePrediction: (
    bytes: Uint8Array,
    inputs: readonly AdmissionFeatureScenarioInputV3[],
  ) => AdmissionFeaturePredictionArtifactV3;
  loadOracleBytes: () => Promise<Uint8Array>;
  loadOracles: () => Promise<readonly AdmissionFeatureScenarioOracleV3[]>;
  score: (options: {
    inputs: readonly AdmissionFeatureScenarioInputV3[];
    oracles: readonly AdmissionFeatureScenarioOracleV3[];
    predictions: AdmissionFeaturePredictionArtifactV3['predictions'];
  }) => AdmissionFeatureAgreementReportV3;
}): Promise<BlindedHoldoutRuntimeEvidenceV3> {
  if (options.nodeMajor !== 20 && options.nodeMajor !== 22) fail('runtime');
  if (options.candidateRunCount !== 1) fail('candidate_run_count');
  if (options.candidateStopped !== true) fail('candidate_not_stopped');
  if (options.evidenceMode !== 'sealed-candidate-prediction') fail('evidence_mode');
  const bytes = exactJsonBytes(options.predictionBytes, PREDICTION_MAX_BYTES, 'prediction_validation');
  let inputs: readonly AdmissionFeatureScenarioInputV3[];
  let artifact: AdmissionFeaturePredictionArtifactV3;
  try {
    inputs = await options.loadInputs();
    if (inputs.filter(({ split }) => split === 'dev').length !== DEV_SCENARIO_COUNT) fail('input_identity');
    assertSealedInputBytesV3(options.seal, new TextEncoder().encode(JSON.stringify(inputs)));
    artifact = options.parsePrediction(bytes, inputs);
  } catch (error) {
    if (error instanceof BlindedHoldoutProtocolV3Error
      && (error.code === 'input_identity' || error.code === 'oracle_identity')) throw error;
    fail('prediction_validation');
  }
  // The sealed oracle-byte hash is recomputed via the single seal-free
  // definition in load-v3.ts BEFORE any oracle open; a mismatch aborts loudly.
  assertSealedOracleBytesV3(options.seal, await options.loadOracleBytes().catch(() => fail('oracle_access')));
  let oracles: readonly AdmissionFeatureScenarioOracleV3[];
  try {
    oracles = await options.loadOracles();
  } catch {
    fail('oracle_access');
  }
  let report: AdmissionFeatureAgreementReportV3;
  try {
    report = options.score({
      inputs,
      oracles,
      predictions: artifact.predictions,
    });
  } catch {
    fail('scoring');
  }
  return createBlindedHoldoutRuntimeEvidenceV3({
    nodeMajor: options.nodeMajor,
    evidenceMode: 'sealed-candidate-prediction',
    candidateRunCount: 1,
    candidateStoppedBeforeOracle: true,
    predictionSha256: exactSha256(sha256(bytes)),
    devAggregate: splitAggregate(report, 'dev'),
    holdoutAggregate: splitAggregate(report, 'holdout'),
  });
}

// ---------------------------------------------------------------------------
// Content-free public receipt (v3)
// ---------------------------------------------------------------------------

export interface BlindedHoldoutCleanupV3 {
  readonly candidateStopped: true;
  readonly containerRemoved: true;
  readonly imageRemoved: true;
  readonly predictionRemoved: true;
  readonly temporaryFilesRemoved: true;
  readonly noRawArtifactsPublished: true;
}

export interface BlindedHoldoutReceiptV3 {
  readonly schemaVersion: 'memberry.admission-feature-blinded-holdout-receipt.v3';
  readonly receiptVersion: typeof BLINDED_HOLDOUT_V3_ARTIFACT_VERSION;
  readonly packetId: 'MEM-002PROD';
  readonly evidenceMode: 'blinded-holdout';
  readonly oneShotKey: `sha256:${string}`;
  readonly seal: BlindedHoldoutSealV3;
  readonly policyReceiptSha256: `sha256:${string}`;
  readonly policyReceiptCanonicalBytesSha256: `sha256:${string}`;
  readonly evaluatedCommitSha: string;
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
  readonly runtimes: readonly [BlindedHoldoutRuntimeEvidenceV3, BlindedHoldoutRuntimeEvidenceV3];
  readonly devAggregate: BlindedHoldoutAggregateV3;
  readonly holdoutAggregate: BlindedHoldoutAggregateV3;
  readonly cleanup: BlindedHoldoutCleanupV3;
  readonly outcome: 'passed' | 'failed';
  readonly receiptSha256: `sha256:${string}`;
}

function cleanup(value: BlindedHoldoutCleanupV3): BlindedHoldoutCleanupV3 {
  const record = closedRecord(value, [
    'candidateStopped', 'containerRemoved', 'imageRemoved', 'predictionRemoved',
    'temporaryFilesRemoved', 'noRawArtifactsPublished',
  ], 'cleanup');
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

export function buildBlindedHoldoutReceiptV3(options: {
  seal: BlindedHoldoutSealV3;
  policyReceiptSha256: `sha256:${string}`;
  policyReceiptCanonicalBytesSha256: `sha256:${string}`;
  evaluatedCommitSha: string;
  scorerSha256: `sha256:${string}`;
  predictionSha256: `sha256:${string}`;
  startReceiptSha256: `sha256:${string}`;
  tombstone: BlindedHoldoutReceiptV3['tombstone'];
  workflowRunId: string;
  workflowRunAttempt: 1;
  priorAuthoritativeReceiptCount: 0;
  candidateRunCount: 1;
  runtimes: readonly [BlindedHoldoutRuntimeEvidenceV3, BlindedHoldoutRuntimeEvidenceV3];
  cleanup: BlindedHoldoutCleanupV3;
}): BlindedHoldoutReceiptV3 {
  if (options.workflowRunAttempt !== 1) fail('attempt');
  if (options.priorAuthoritativeReceiptCount !== 0) fail('duplicate_attempt');
  if (options.candidateRunCount !== 1) fail('candidate_run_count');
  if (!RUN_ID_PATTERN.test(options.workflowRunId)) fail('attempt');
  if (
    !Array.isArray(options.runtimes)
    || options.runtimes.length !== 2
    || options.runtimes.some((entry) => !REGISTERED_RUNTIME_EVIDENCE.has(entry))
  )
    fail('runtime');
  const [node20, node22] = options.runtimes;
  if (node20.nodeMajor !== 20 || node22.nodeMajor !== 22) fail('runtime');
  const predictionSha256 = exactSha256(options.predictionSha256);
  if (node20.predictionSha256 !== predictionSha256 || node22.predictionSha256 !== predictionSha256) {
    fail('runtime_divergence');
  }
  // Bit-identity rule across Node majors (v2 rule carried forward).
  if (JSON.stringify(node20.devAggregate) !== JSON.stringify(node22.devAggregate)
    || JSON.stringify(node20.holdoutAggregate) !== JSON.stringify(node22.holdoutAggregate)) {
    fail('runtime_divergence');
  }
  const devAggregate = parseBlindedHoldoutAggregateV3(node20.devAggregate);
  const holdoutAggregate = parseBlindedHoldoutAggregateV3(node20.holdoutAggregate);
  const oneShotKey = blindedHoldoutSealedOneShotKeyV3(options.seal);
  const evaluatedCommitSha = exactCommit(options.evaluatedCommitSha);
  const tombstone = closedRecord(options.tombstone, [
    'ref', 'targetSha', 'preexisting', 'creationStatus', 'verificationStatus',
  ], 'tombstone');
  if (
    tombstone.ref !== `${BLINDED_HOLDOUT_V3_TOMBSTONE_REF_PREFIX}${oneShotKey.slice(7)}`
    || tombstone.targetSha !== evaluatedCommitSha
    || tombstone.preexisting !== false
    || tombstone.creationStatus !== 201
    || tombstone.verificationStatus !== 200
  )
    fail('tombstone');
  const payload = Object.freeze({
    schemaVersion: 'memberry.admission-feature-blinded-holdout-receipt.v3' as const,
    receiptVersion: BLINDED_HOLDOUT_V3_ARTIFACT_VERSION,
    packetId: 'MEM-002PROD' as const,
    evidenceMode: 'blinded-holdout' as const,
    oneShotKey,
    seal: options.seal,
    policyReceiptSha256: exactSha256(options.policyReceiptSha256),
    policyReceiptCanonicalBytesSha256: exactSha256(options.policyReceiptCanonicalBytesSha256),
    evaluatedCommitSha,
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
    runtimes: Object.freeze([node20, node22]) as readonly [BlindedHoldoutRuntimeEvidenceV3, BlindedHoldoutRuntimeEvidenceV3],
    devAggregate,
    holdoutAggregate,
    cleanup: cleanup(options.cleanup),
    // Promotion demands BOTH splits at the frozen gate.
    outcome: devAggregate.passed && holdoutAggregate.passed ? ('passed' as const) : ('failed' as const),
  });
  const receipt = Object.freeze({
    ...payload,
    receiptSha256: sha256(JSON.stringify(payload)),
  });
  assertBlindedHoldoutSecretSafeV3(JSON.stringify(receipt));
  REGISTERED_RECEIPTS.add(receipt);
  return receipt;
}

export function canonicalBlindedHoldoutReceiptV3(receipt: BlindedHoldoutReceiptV3): string {
  if (!REGISTERED_RECEIPTS.has(receipt)) fail('unregistered');
  const canonical = `${JSON.stringify(receipt)}\n`;
  assertBlindedHoldoutSecretSafeV3(canonical);
  return canonical;
}

export function parseBlindedHoldoutReceiptV3(
  seal: BlindedHoldoutSealV3,
  bytes: unknown,
): BlindedHoldoutReceiptV3 {
  const copy = exactJsonBytes(bytes, MAX_RECEIPT_BYTES, 'canonical');
  const { text, raw } = canonicalLine(copy, 'canonical');
  const record = closedRecord(raw, [
    'schemaVersion', 'receiptVersion', 'packetId', 'evidenceMode', 'oneShotKey', 'seal',
    'policyReceiptSha256', 'policyReceiptCanonicalBytesSha256', 'evaluatedCommitSha',
    'scorerSha256', 'predictionSha256', 'startReceiptSha256', 'tombstone', 'workflow',
    'candidateRunCount', 'runtimes', 'devAggregate', 'holdoutAggregate', 'cleanup',
    'outcome', 'receiptSha256',
  ], 'canonical');
  if (
    record.schemaVersion !== 'memberry.admission-feature-blinded-holdout-receipt.v3'
    || record.receiptVersion !== BLINDED_HOLDOUT_V3_ARTIFACT_VERSION
    || record.packetId !== 'MEM-002PROD'
    || record.evidenceMode !== 'blinded-holdout'
    || record.oneShotKey !== blindedHoldoutSealedOneShotKeyV3(seal)
    || JSON.stringify(record.seal) !== JSON.stringify(seal)
  )
    fail('identity');
  const workflow = closedRecord(record.workflow, [
    'repository', 'runId', 'runAttempt', 'priorAuthoritativeReceiptCount',
  ], 'attempt');
  if (
    workflow.repository !== 'AP3X-Dev/memberry'
    || workflow.runAttempt !== 1
    || workflow.priorAuthoritativeReceiptCount !== 0
    || typeof workflow.runId !== 'string'
  )
    fail('attempt');
  if (!Array.isArray(record.runtimes) || record.runtimes.length !== 2) fail('runtime');
  const reconstructed = record.runtimes.map((entry) => {
    const value = closedRecord(entry, [
      'nodeMajor', 'evidenceMode', 'candidateRunCount', 'candidateStoppedBeforeOracle',
      'predictionSha256', 'devAggregate', 'holdoutAggregate', 'evidenceSha256',
    ], 'runtime');
    const evidence = createBlindedHoldoutRuntimeEvidenceV3({
      nodeMajor: value.nodeMajor as 20 | 22,
      evidenceMode: value.evidenceMode as 'sealed-candidate-prediction',
      candidateRunCount: value.candidateRunCount as 1,
      candidateStoppedBeforeOracle: value.candidateStoppedBeforeOracle as true,
      predictionSha256: value.predictionSha256 as `sha256:${string}`,
      devAggregate: value.devAggregate as BlindedHoldoutAggregateV3,
      holdoutAggregate: value.holdoutAggregate as BlindedHoldoutAggregateV3,
    });
    if (evidence.evidenceSha256 !== value.evidenceSha256) fail('runtime');
    return evidence;
  }) as [BlindedHoldoutRuntimeEvidenceV3, BlindedHoldoutRuntimeEvidenceV3];
  const receipt = buildBlindedHoldoutReceiptV3({
    seal,
    policyReceiptSha256: record.policyReceiptSha256 as `sha256:${string}`,
    policyReceiptCanonicalBytesSha256: record.policyReceiptCanonicalBytesSha256 as `sha256:${string}`,
    evaluatedCommitSha: record.evaluatedCommitSha as string,
    scorerSha256: record.scorerSha256 as `sha256:${string}`,
    predictionSha256: record.predictionSha256 as `sha256:${string}`,
    startReceiptSha256: record.startReceiptSha256 as `sha256:${string}`,
    tombstone: record.tombstone as BlindedHoldoutReceiptV3['tombstone'],
    workflowRunId: workflow.runId as string,
    workflowRunAttempt: workflow.runAttempt as 1,
    priorAuthoritativeReceiptCount: workflow.priorAuthoritativeReceiptCount as 0,
    candidateRunCount: record.candidateRunCount as 1,
    runtimes: reconstructed,
    cleanup: record.cleanup as BlindedHoldoutCleanupV3,
  });
  if (
    receipt.receiptSha256 !== record.receiptSha256
    || canonicalBlindedHoldoutReceiptV3(receipt) !== text
    || JSON.stringify(receipt.devAggregate) !== JSON.stringify(record.devAggregate)
    || JSON.stringify(receipt.holdoutAggregate) !== JSON.stringify(record.holdoutAggregate)
    || receipt.outcome !== record.outcome
  ) {
    fail('hash');
  }
  return receipt;
}

export function assertBlindedHoldoutPromotionV3(receipt: { readonly outcome: string }): void {
  if (receipt.outcome !== 'passed') fail('agreement');
}

// ---------------------------------------------------------------------------
// Command surface
// ---------------------------------------------------------------------------

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
    execFileSync('git', ['merge-base', '--is-ancestor', base, head], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function preflightFromEnvironment(receiptPath: string): Promise<BlindedHoldoutPreflightV3> {
  const seal = await loadSealV3();
  const policy = await loadPolicyReceiptV4(receiptPath, seal);
  const head = gitText(['rev-parse', 'HEAD']);
  const candidateStatus = gitText([
    'status', '--porcelain=v1', '--untracked-files=all', '--', 'bench/lab/admission-features/candidate-v3',
  ]);
  const coreStatus = gitText([
    'status', '--porcelain=v1', '--untracked-files=all', '--', 'packages/core/src',
  ]);
  return validateBlindedHoldoutPreflightV3({
    seal,
    policyReceiptSha256: policy.receipt.receiptSha256,
    policyReceiptCanonicalBytesSha256: policy.canonicalBytesSha256,
    observedPlatform: exactEnvironment('MEMBERRY_OBSERVED_PLATFORM', policy.receipt.policy.platform),
    observedBaseImage: exactEnvironment('MEMBERRY_OBSERVED_BASE_IMAGE', policy.receipt.policy.baseImage),
    expectedPlatform: policy.receipt.policy.platform,
    expectedBaseImage: policy.receipt.policy.baseImage,
    eventName: exactEnvironment('GITHUB_EVENT_NAME', 'workflow_dispatch'),
    repository: exactEnvironment('GITHUB_REPOSITORY', 'AP3X-Dev/memberry'),
    workflowRunId: requiredEnvironment('GITHUB_RUN_ID'),
    workflowRunAttempt: Number(requiredEnvironment('GITHUB_RUN_ATTEMPT')),
    priorAuthoritativeReceiptCount: Number(requiredEnvironment('MEMBERRY_PRIOR_AUTHORITATIVE_RECEIPTS')),
    evaluatedCommitSha: exactEnvironment('GITHUB_SHA', head),
    observedCheckoutCommitSha: head,
    integratedBaseIsAncestor: gitAncestor(seal.integratedBaseSha, head),
    candidateSubtreeClean: candidateStatus.length === 0,
    coreSubtreeClean: coreStatus.length === 0,
    candidateContextOnly: exactEnvironment('MEMBERRY_CANDIDATE_CONTEXT_ONLY', 'true') === 'true',
    observedCandidateCommitSha: exactEnvironment('MEMBERRY_OBSERVED_CANDIDATE_COMMIT_SHA', seal.candidateCommitSha),
    observedRepositoryRootTreeOid: exactEnvironment('MEMBERRY_OBSERVED_REPOSITORY_ROOT_TREE_OID', seal.repositoryRootTreeOid),
    observedCandidateSubtreeOid: exactEnvironment('MEMBERRY_OBSERVED_CANDIDATE_SUBTREE_OID', seal.candidateSubtreeOid),
    observedCoreSubtreeOid: exactEnvironment('MEMBERRY_OBSERVED_CORE_SUBTREE_OID', seal.coreSubtreeOid),
    observedInputSha256: exactEnvironment('MEMBERRY_OBSERVED_INPUT_SHA256', seal.inputSha256),
  });
}

async function commandPreflight(receiptPath: string, outputPath: string): Promise<void> {
  const preflight = await preflightFromEnvironment(receiptPath);
  const output = `${JSON.stringify({
    schemaVersion: 'memberry.admission-feature-blinded-holdout-preflight.v3',
    oneShotKey: preflight.oneShotKey,
    policyReceiptSha256: preflight.policyReceiptSha256,
    policyReceiptCanonicalBytesSha256: preflight.policyReceiptCanonicalBytesSha256,
    integratedBaseSha: preflight.seal.integratedBaseSha,
    evaluatedCommitSha: preflight.evaluatedCommitSha,
    candidateCommitSha: preflight.seal.candidateCommitSha,
    repositoryRootTreeOid: preflight.seal.repositoryRootTreeOid,
    candidateSubtreeOid: preflight.seal.candidateSubtreeOid,
    coreSubtreeOid: preflight.seal.coreSubtreeOid,
    workflowRunId: preflight.workflowRunId,
    workflowRunAttempt: preflight.workflowRunAttempt,
    priorAuthoritativeReceiptCount: preflight.priorAuthoritativeReceiptCount,
  })}\n`;
  await writeFile(outputPath, output, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

async function commandStart(receiptPath: string, tombstonePath: string, outputPath: string): Promise<void> {
  const preflight = await preflightFromEnvironment(receiptPath);
  const tombstone = parseBlindedHoldoutTombstoneEvidenceV3(
    preflight.seal,
    new Uint8Array(await readFile(tombstonePath)),
  );
  await writeFile(
    outputPath,
    canonicalBlindedHoldoutStartReceiptV3(buildBlindedHoldoutStartReceiptV3(preflight, tombstone)),
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  );
}

async function commandTombstoneAuthorize(
  targetSha: string,
  lookupStatus: string,
  priorEvidenceArtifactCount: string,
  outputPath: string,
): Promise<void> {
  const seal = await loadSealV3();
  const spec = buildBlindedHoldoutTombstoneSpecV3(seal, targetSha);
  validateBlindedHoldoutTombstoneAbsenceV3({
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

async function commandBurnAuthorityAuthorize(counts: readonly string[]): Promise<void> {
  await loadSealV3();
  validateBlindedHoldoutBurnAuthorityAbsenceV3({
    retiredV1LookupStatus: Number(counts[0]),
    retiredV2LookupStatus: Number(counts[1]),
    retiredV3LookupStatus: Number(counts[2]),
    retiredV4LookupStatus: Number(counts[3]),
    currentLookupStatus: Number(counts[4]),
    retiredV1EvidenceArtifactCount: Number(counts[5]),
    retiredV2EvidenceArtifactCount: Number(counts[6]),
    retiredV3EvidenceArtifactCount: Number(counts[7]),
    retiredV4EvidenceArtifactCount: Number(counts[8]),
    currentEvidenceArtifactCount: Number(counts[9]),
    knownFailedV1RunArtifactCount: Number(counts[10]),
    knownFailedV2RunArtifactCount: Number(counts[11]),
    knownFailedV3RunArtifactCount: Number(counts[12]),
  });
  process.stdout.write('{"ok":true,"schemaVersion":"memberry.admission-feature-blinded-holdout-burn-authority.v5"}\n');
}

async function readApiResponse(path: string): Promise<unknown> {
  const copy = exactJsonBytes(new Uint8Array(await readFile(path)), 32_768, 'tombstone_response');
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
  const seal = await loadSealV3();
  const spec = buildBlindedHoldoutTombstoneSpecV3(seal, targetSha);
  const evidence = verifyBlindedHoldoutTombstoneCreationV3({
    spec,
    createStatus: Number(createStatus),
    createResponse: await readApiResponse(createResponsePath),
    verificationStatus: Number(verificationStatus),
    verificationResponse: await readApiResponse(verificationResponsePath),
  });
  await writeFile(outputPath, canonicalBlindedHoldoutTombstoneEvidenceV3(evidence), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}

async function commandInput(outputPath: string): Promise<void> {
  const bytes = await sealedAdmissionFeatureInputBytesV3();
  if (sealPath() === undefined) {
    // Seal authoring mode (the ONE seal-free surface): emit the bytes plus
    // their hash so the custodian can compute seal.inputSha256 (spec 2.2).
    await writeFile(outputPath, bytes, { mode: 0o600, flag: 'wx' });
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 'memberry.admission-feature-blinded-holdout-input.v3',
      inputSha256: sha256(bytes),
    })}\n`);
    return;
  }
  assertSealedInputBytesV3(await loadSealV3(), bytes);
  await writeFile(outputPath, bytes, { mode: 0o600, flag: 'wx' });
}

async function commandScore(predictionPath: string, outputPath: string): Promise<void> {
  exactEnvironment('MEMBERRY_CANDIDATE_STOPPED', 'true');
  exactEnvironment('MEMBERRY_CANDIDATE_RUN_COUNT', '1');
  const expectedNodeMajor = Number(requiredEnvironment('MEMBERRY_EXPECTED_NODE_MAJOR'));
  const observedNodeMajor = Number(process.versions.node.split('.')[0]);
  if ((expectedNodeMajor !== 20 && expectedNodeMajor !== 22) || observedNodeMajor !== expectedNodeMajor) fail('runtime');
  const seal = await loadSealV3();
  const predictionBytes = new Uint8Array(await readFile(predictionPath));
  const { loadAdmissionFeatureInputsV3 } = await import('../inputs-v3.js');
  const { parseAdmissionFeaturePredictionArtifactV3 } = await import('../prediction-artifact-v3.js');
  const { scoreAdmissionFeatureAgreementV3 } = await import('../scorer-v3.js');
  const evidence = await scoreSealedBlindedHoldoutV3({
    nodeMajor: expectedNodeMajor,
    candidateRunCount: 1,
    candidateStopped: true,
    evidenceMode: 'sealed-candidate-prediction',
    seal,
    predictionBytes,
    loadInputs: () => loadAdmissionFeatureInputsV3(['dev', 'holdout']),
    parsePrediction: parseAdmissionFeaturePredictionArtifactV3,
    // The custody module import is delayed until the sealed bytes have passed
    // bounded parsing and the oracle-byte hash has been recomputed.
    loadOracleBytes: async () => {
      const { sealedAdmissionFeatureOracleBytesV3 } = await import('./load-v3.js');
      return sealedAdmissionFeatureOracleBytesV3();
    },
    loadOracles: async () => {
      const { loadAdmissionFeatureOraclesV3 } = await import('./load-v3.js');
      return loadAdmissionFeatureOraclesV3(['dev', 'holdout']);
    },
    score: ({ inputs, oracles, predictions }) => scoreAdmissionFeatureAgreementV3({
      inputs, oracles, predictions, requiredSplits: ['dev', 'holdout'],
    }),
  });
  await writeFile(outputPath, canonicalBlindedHoldoutRuntimeEvidenceV3(evidence), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}

export async function removeBlindedHoldoutPrivateEvidenceV3(options: {
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
    resolvedPath: resolve(path!),
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

async function commandFinalize(
  receiptPath: string,
  node20Path: string,
  node22Path: string,
  startPath: string,
  preflightPath: string,
  custodyDirectory: string,
  outputPath: string,
): Promise<void> {
  const seal = await loadSealV3();
  const policy = await loadPolicyReceiptV4(receiptPath, seal);
  const start = parseBlindedHoldoutStartReceiptV3(seal, new Uint8Array(await readFile(startPath)));
  if (
    start.policyReceiptSha256 !== policy.receipt.receiptSha256
    || start.policyReceiptCanonicalBytesSha256 !== policy.canonicalBytesSha256
  )
    fail('policy_authority');
  if (start.workflowRunId !== exactEnvironment('GITHUB_RUN_ID', start.workflowRunId)) fail('start_receipt');
  const node20 = parseBlindedHoldoutRuntimeEvidenceV3(new Uint8Array(await readFile(node20Path)));
  const node22 = parseBlindedHoldoutRuntimeEvidenceV3(new Uint8Array(await readFile(node22Path)));
  await removeBlindedHoldoutPrivateEvidenceV3({
    custodyDirectory,
    node20Path,
    node22Path,
    preflightPath,
  });
  const cleanupEvidence = {
    candidateStopped: exactTrueEnvironment('MEMBERRY_CLEANUP_CANDIDATE_STOPPED'),
    containerRemoved: exactTrueEnvironment('MEMBERRY_CLEANUP_CONTAINER_REMOVED'),
    imageRemoved: exactTrueEnvironment('MEMBERRY_CLEANUP_IMAGE_REMOVED'),
    predictionRemoved: exactTrueEnvironment('MEMBERRY_CLEANUP_PREDICTION_REMOVED'),
    temporaryFilesRemoved: exactTrueEnvironment('MEMBERRY_CLEANUP_TEMPORARY_FILES_REMOVED'),
    noRawArtifactsPublished: exactTrueEnvironment('MEMBERRY_NO_RAW_ARTIFACTS_PUBLISHED'),
  } as const;
  const receipt = buildBlindedHoldoutReceiptV3({
    seal,
    policyReceiptSha256: start.policyReceiptSha256,
    policyReceiptCanonicalBytesSha256: start.policyReceiptCanonicalBytesSha256,
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
    cleanup: cleanupEvidence,
  });
  await writeFile(outputPath, canonicalBlindedHoldoutReceiptV3(receipt), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}

async function commandVerify(receiptPath: string): Promise<void> {
  const seal = await loadSealV3();
  const receipt = parseBlindedHoldoutReceiptV3(seal, new Uint8Array(await readFile(receiptPath)));
  assertBlindedHoldoutPromotionV3(receipt);
  process.stdout.write('{"ok":true,"schemaVersion":"memberry.admission-feature-blinded-holdout-receipt.v3"}\n');
}

async function main(args: readonly string[]): Promise<void> {
  const [command, ...paths] = args;
  if (command === 'preflight' && paths.length === 2) return commandPreflight(paths[0]!, paths[1]!);
  if (command === 'start' && paths.length === 3) return commandStart(paths[0]!, paths[1]!, paths[2]!);
  if (command === 'tombstone-authorize' && paths.length === 4) {
    return commandTombstoneAuthorize(paths[0]!, paths[1]!, paths[2]!, paths[3]!);
  }
  if (command === 'burn-authority-authorize' && paths.length === 13) {
    return commandBurnAuthorityAuthorize(paths);
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

export { BLINDED_HOLDOUT_RETIRED_V4_ONE_SHOT_KEY };

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/scorer-only/blinded-holdout-v3.ts')) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    const message =
      error instanceof BlindedHoldoutProtocolV3Error
        ? error.message
        : error instanceof Error && /^mem002prod_artifact:[a-z_]+$/.test(error.message)
          ? error.message
          : 'mem002prod_protocol:unexpected';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
