import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAdmissionFeatureInputs } from '../inputs.js';
import type { AdmissionFeatureScenarioInputV1 } from '../contract.js';
import {
  buildAdmissionFeatureCandidateImageV1,
  classifyAdmissionCandidateBuildFailurePhaseV1,
  type AdmissionCandidateBuildFailurePhaseV1,
  type AdmissionCandidateBuildReceiptV1,
} from './build.js';
import {
  runAdmissionFeatureSandboxV1,
  type AdmissionSandboxResultV1,
} from './sandbox.js';

const EVIDENCE_PATH_ENV = 'MEMBERRY_ADMISSION_CANDIDATE_LIVE_EVIDENCE_PATH';
const EVIDENCE_DIRECTORY = 'memberry-admission-candidate-live';
const EVIDENCE_FILENAME = 'evidence.json';

type SandboxFailureCodeV1 = Extract<AdmissionSandboxResultV1, { readonly ok: false }>['failureCode'];
export type AdmissionFeatureCandidateLiveFailureCodeV1 = SandboxFailureCodeV1
  | 'INPUT_MANIFEST_INVALID'
  | 'EVIDENCE_PATH_INVALID'
  | 'EVIDENCE_PLATFORM_UNSUPPORTED'
  | 'EVIDENCE_PARENT_INVALID'
  | 'EVIDENCE_PARENT_CHANGED'
  | 'EVIDENCE_EXISTS'
  | 'EVIDENCE_LEAF_LINK'
  | 'EVIDENCE_LEAF_HARDLINK'
  | 'EVIDENCE_LEAF_INVALID'
  | 'EVIDENCE_WRITE_FAILED';

const FIXED_FAILURES_V1 = new WeakMap<object, AdmissionFeatureCandidateLiveFailureCodeV1>();
export type AdmissionFeatureCandidateLiveFailurePhaseV1 =
  | AdmissionCandidateBuildFailurePhaseV1
  | 'SANDBOX';
const FAILURE_PHASES_V1 = new WeakMap<object, AdmissionFeatureCandidateLiveFailurePhaseV1>();

function fixedFailureV1(
  code: AdmissionFeatureCandidateLiveFailureCodeV1,
  phase?: AdmissionFeatureCandidateLiveFailurePhaseV1,
): Error {
  const error = new Error(`admission_candidate_live:${code}`);
  FIXED_FAILURES_V1.set(error, code);
  if (phase !== undefined) FAILURE_PHASES_V1.set(error, phase);
  return error;
}

function phaseFailureV1(phase: AdmissionFeatureCandidateLiveFailurePhaseV1 | 'UNKNOWN'): Error {
  const error = new Error('admission_candidate_live:FAILED');
  if (phase !== 'UNKNOWN') FAILURE_PHASES_V1.set(error, phase);
  return error;
}

export function classifyAdmissionFeatureCandidateLiveFailureV1(
  error: unknown,
): AdmissionFeatureCandidateLiveFailureCodeV1 | 'FAILED' {
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
    return FIXED_FAILURES_V1.get(error) ?? 'FAILED';
  }
  return 'FAILED';
}

export function formatAdmissionFeatureCandidateLiveFailureV1(error: unknown): string {
  return `admission_candidate_live:${classifyAdmissionFeatureCandidateLiveFailureV1(error)}`;
}

export function classifyAdmissionFeatureCandidateLiveFailurePhaseV1(
  error: unknown,
): AdmissionFeatureCandidateLiveFailurePhaseV1 | 'UNKNOWN' {
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
    return FAILURE_PHASES_V1.get(error) ?? 'UNKNOWN';
  }
  return 'UNKNOWN';
}

export interface AdmissionFeatureCandidateLiveFailureEvidenceV1 {
  readonly schemaVersion: 'memberry.admission-feature-candidate-live-failure-phase.v1';
  readonly ok: false;
  readonly phase: AdmissionFeatureCandidateLiveFailurePhaseV1 | 'UNKNOWN';
}

export function admissionFeatureCandidateLiveFailureEvidenceV1(
  error: unknown,
): AdmissionFeatureCandidateLiveFailureEvidenceV1 {
  return Object.freeze({
    schemaVersion: 'memberry.admission-feature-candidate-live-failure-phase.v1',
    ok: false,
    phase: classifyAdmissionFeatureCandidateLiveFailurePhaseV1(error),
  });
}

export interface AdmissionFeatureCandidateLiveEvidenceV1 {
  readonly schemaVersion: 'memberry.admission-feature-candidate-live-evidence.v1';
  readonly ok: true;
  readonly cleanupVerified: true;
  readonly scenarioCount: 13;
  readonly devScenarioCount: 9;
  readonly holdoutScenarioCount: 4;
  readonly baseImage: string;
  readonly candidateSha256: `sha256:${string}`;
  readonly sourceSha256: `sha256:${string}`;
  readonly imageSha256: `sha256:${string}`;
  readonly imageConfigSha256: `sha256:${string}`;
  readonly nodeSha256: `sha256:${string}`;
  readonly rootFsLayerSha256: readonly string[];
  readonly inputSha256: `sha256:${string}`;
  readonly outputSha256: `sha256:${string}`;
}

function successfulEvidenceV1(
  receipt: AdmissionCandidateBuildReceiptV1,
  result: Extract<AdmissionSandboxResultV1, { readonly ok: true }>,
  inputs: readonly AdmissionFeatureScenarioInputV1[],
): AdmissionFeatureCandidateLiveEvidenceV1 {
  const devScenarioCount = inputs.filter((input) => input.split === 'dev').length;
  const holdoutScenarioCount = inputs.filter((input) => input.split === 'holdout').length;
  if (inputs.length !== 13 || devScenarioCount !== 9 || holdoutScenarioCount !== 4) {
    throw fixedFailureV1('INPUT_MANIFEST_INVALID', 'SOURCE_SNAPSHOT');
  }
  if (result.hashes.candidateSha256 !== receipt.candidateSha256
    || result.hashes.sourceSha256 !== receipt.sourceSha256
    || result.hashes.imageSha256 !== receipt.imageSha256) {
    throw fixedFailureV1('ATTESTATION_INVALID', 'SANDBOX');
  }
  return Object.freeze({
    schemaVersion: 'memberry.admission-feature-candidate-live-evidence.v1',
    ok: true,
    cleanupVerified: true,
    scenarioCount: 13,
    devScenarioCount: 9,
    holdoutScenarioCount: 4,
    baseImage: receipt.baseImage,
    candidateSha256: receipt.candidateSha256,
    sourceSha256: receipt.sourceSha256,
    imageSha256: receipt.imageSha256,
    imageConfigSha256: receipt.imageConfigSha256,
    nodeSha256: receipt.nodeSha256,
    rootFsLayerSha256: Object.freeze([...receipt.rootFsLayers]),
    inputSha256: result.hashes.inputSha256,
    outputSha256: result.hashes.outputSha256,
  });
}

/**
 * Test-visible orchestration core. Production execution is deliberately bound
 * to the closed public build and sandbox entry points; it exposes no runner or
 * executor override.
 */
export async function runAdmissionFeatureCandidateLiveCoreV1(
  inputs: readonly AdmissionFeatureScenarioInputV1[],
): Promise<AdmissionFeatureCandidateLiveEvidenceV1> {
  let receipt: AdmissionCandidateBuildReceiptV1;
  try {
    receipt = await buildAdmissionFeatureCandidateImageV1();
  } catch (error) {
    throw phaseFailureV1(classifyAdmissionCandidateBuildFailurePhaseV1(error));
  }
  let result: AdmissionSandboxResultV1;
  try {
    result = await runAdmissionFeatureSandboxV1({ receipt, inputs });
  } catch {
    throw phaseFailureV1('SANDBOX');
  }
  if (!result.ok) throw fixedFailureV1(result.failureCode, 'SANDBOX');
  return successfulEvidenceV1(receipt, result, inputs);
}

interface EvidenceAuthorityV1 {
  readonly parent: string;
  readonly path: string;
}

interface DirectoryIdentityV1 {
  readonly device: bigint;
  readonly inode: bigint;
  readonly owner: bigint;
  readonly mode: bigint;
}

interface FileIdentityV1 extends DirectoryIdentityV1 {
  readonly size: bigint;
}

interface BigIntFileStatsV1 {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

function evidenceAuthorityV1(): EvidenceAuthorityV1 {
  const runnerTemp = process.env['RUNNER_TEMP'];
  const requestedPath = process.env[EVIDENCE_PATH_ENV];
  if (typeof runnerTemp !== 'string' || runnerTemp.length === 0 || runnerTemp.includes('\0')
    || !isAbsolute(runnerTemp) || resolve(runnerTemp) !== runnerTemp) {
    throw fixedFailureV1('EVIDENCE_PATH_INVALID');
  }
  const parent = join(runnerTemp, EVIDENCE_DIRECTORY);
  const path = join(parent, EVIDENCE_FILENAME);
  if (requestedPath !== path) throw fixedFailureV1('EVIDENCE_PATH_INVALID');
  return Object.freeze({ parent, path });
}

function currentUidV1(): bigint {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function'
    || typeof fsConstants.O_NOFOLLOW !== 'number' || fsConstants.O_NOFOLLOW === 0) {
    throw fixedFailureV1('EVIDENCE_PLATFORM_UNSUPPORTED');
  }
  return BigInt(process.getuid());
}

export function hasExactEvidenceParentPermissionsV1(mode: bigint): boolean {
  return (mode & 0o7777n) === 0o700n;
}

async function directoryIdentityV1(path: string, owner: bigint): Promise<DirectoryIdentityV1> {
  try {
    const stats = await lstat(path, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== owner
      || !hasExactEvidenceParentPermissionsV1(stats.mode)
      || await realpath(path) !== path) {
      throw fixedFailureV1('EVIDENCE_PARENT_INVALID');
    }
    return Object.freeze({
      device: stats.dev,
      inode: stats.ino,
      owner: stats.uid,
      mode: stats.mode,
    });
  } catch (error) {
    if (classifyAdmissionFeatureCandidateLiveFailureV1(error) !== 'FAILED') throw error;
    throw fixedFailureV1('EVIDENCE_PARENT_INVALID');
  }
}

function sameDirectoryIdentityV1(left: DirectoryIdentityV1, right: DirectoryIdentityV1): boolean {
  return left.device === right.device && left.inode === right.inode
    && left.owner === right.owner && left.mode === right.mode;
}

async function assertParentStableV1(
  authority: EvidenceAuthorityV1,
  owner: bigint,
  expected: DirectoryIdentityV1,
): Promise<void> {
  const observed = await directoryIdentityV1(authority.parent, owner);
  if (!sameDirectoryIdentityV1(observed, expected)) {
    throw fixedFailureV1('EVIDENCE_PARENT_CHANGED');
  }
}

async function rejectPreexistingLeafV1(path: string): Promise<void> {
  try {
    const stats = await lstat(path, { bigint: true });
    if (stats.isSymbolicLink()) throw fixedFailureV1('EVIDENCE_LEAF_LINK');
    if (stats.nlink !== 1n) throw fixedFailureV1('EVIDENCE_LEAF_HARDLINK');
    throw fixedFailureV1('EVIDENCE_EXISTS');
  } catch (error) {
    if (classifyAdmissionFeatureCandidateLiveFailureV1(error) !== 'FAILED') throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw fixedFailureV1('EVIDENCE_WRITE_FAILED');
  }
}

function validateLeafV1(
  stats: BigIntFileStatsV1,
  owner: bigint,
  expected?: FileIdentityV1,
  expectedSize?: bigint,
): FileIdentityV1 {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== owner
    || (stats.mode & 0o777n) !== 0o600n) {
    throw fixedFailureV1('EVIDENCE_LEAF_INVALID');
  }
  if (stats.nlink !== 1n) throw fixedFailureV1('EVIDENCE_LEAF_HARDLINK');
  if (expectedSize !== undefined && stats.size !== expectedSize) {
    throw fixedFailureV1('EVIDENCE_WRITE_FAILED');
  }
  const identity = Object.freeze({
    device: stats.dev,
    inode: stats.ino,
    owner: stats.uid,
    mode: stats.mode,
    size: stats.size,
  });
  if (expected !== undefined && (identity.device !== expected.device
    || identity.inode !== expected.inode || identity.owner !== expected.owner
    || identity.mode !== expected.mode)) {
    throw fixedFailureV1('EVIDENCE_LEAF_INVALID');
  }
  return identity;
}

async function writeEvidenceCoreV1(
  evidence: AdmissionFeatureCandidateLiveEvidenceV1 | AdmissionFeatureCandidateLiveFailureEvidenceV1,
  afterOpen?: () => Promise<void>,
): Promise<void> {
  const authority = evidenceAuthorityV1();
  const owner = currentUidV1();
  const parent = await directoryIdentityV1(authority.parent, owner);
  await rejectPreexistingLeafV1(authority.path);
  const serialized = `${JSON.stringify(evidence)}\n`;
  const expectedSize = BigInt(Buffer.byteLength(serialized, 'utf8'));
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let closed = false;
  try {
    handle = await open(
      authority.path,
      fsConstants.O_NOFOLLOW | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    if (afterOpen !== undefined) await afterOpen();
    await assertParentStableV1(authority, owner, parent);
    const openedLeaf = validateLeafV1(await handle.stat({ bigint: true }), owner, undefined, 0n);
    await handle.writeFile(serialized, { encoding: 'utf8' });
    await handle.sync();
    validateLeafV1(await handle.stat({ bigint: true }), owner, openedLeaf, expectedSize);
    await assertParentStableV1(authority, owner, parent);
    await handle.close();
    closed = true;
    const closedLeaf = validateLeafV1(await lstat(authority.path, { bigint: true }), owner, openedLeaf, expectedSize);
    if (closedLeaf.device !== openedLeaf.device || closedLeaf.inode !== openedLeaf.inode) {
      throw fixedFailureV1('EVIDENCE_LEAF_INVALID');
    }
    await assertParentStableV1(authority, owner, parent);
  } catch (error) {
    if (handle !== undefined && !closed) {
      try {
        await handle.close();
      } catch {
        throw fixedFailureV1('EVIDENCE_WRITE_FAILED');
      }
    }
    if (classifyAdmissionFeatureCandidateLiveFailureV1(error) !== 'FAILED') throw error;
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw fixedFailureV1('EVIDENCE_EXISTS');
    }
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw fixedFailureV1('EVIDENCE_LEAF_LINK');
    }
    throw fixedFailureV1('EVIDENCE_WRITE_FAILED');
  }
}

export async function writeAdmissionFeatureCandidateLiveEvidenceV1(
  evidence: AdmissionFeatureCandidateLiveEvidenceV1,
): Promise<void> {
  await writeEvidenceCoreV1(evidence);
}

export async function writeAdmissionFeatureCandidateLiveFailureEvidenceV1(
  error: unknown,
): Promise<void> {
  await writeEvidenceCoreV1(admissionFeatureCandidateLiveFailureEvidenceV1(error));
}

/** @internal Deterministic race barrier for the focused filesystem tests only. */
export async function writeAdmissionFeatureCandidateLiveEvidenceTestCoreV1(
  evidence: AdmissionFeatureCandidateLiveEvidenceV1,
  afterOpen: () => Promise<void>,
): Promise<void> {
  await writeEvidenceCoreV1(evidence, afterOpen);
}

async function main(): Promise<void> {
  const inputs = await loadAdmissionFeatureInputs();
  const evidence = await runAdmissionFeatureCandidateLiveCoreV1(inputs);
  const serialized = `${JSON.stringify(evidence)}\n`;
  await writeAdmissionFeatureCandidateLiveEvidenceV1(evidence);
  process.stdout.write(serialized);
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  void main().catch(async (error: unknown) => {
    try {
      await writeAdmissionFeatureCandidateLiveFailureEvidenceV1(error);
    } catch {
      // The public failure remains fixed even when the optional phase artifact cannot be written.
    }
    process.stderr.write(`${formatAdmissionFeatureCandidateLiveFailureV1(error)}\n`);
    process.exitCode = 1;
  });
}
