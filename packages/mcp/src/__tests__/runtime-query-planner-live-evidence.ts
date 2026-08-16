import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const EVIDENCE_DIRECTORY = 'memberry-retrieval-planner-live';
const EVIDENCE_FILENAME = 'evidence.json';
const EVIDENCE_PATH_ENV = 'MEMBERRY_RET002C2_EVIDENCE_PATH';
const SUCCESS_EVIDENCE = '{"contract":"RET-002C2","mode":"required","disposable":true,"centralHttpAuthentication":true,"unauthenticatedStatus":401,"ordinaryResolvedCount":1,"tracedResolvedCount":1,"askResolvedCount":1,"rejectedControlCount":4,"cleanupCount":0}\n';

type PlannerEvidenceFailureCode =
  | 'EVIDENCE_INPUT_INVALID'
  | 'EVIDENCE_PATH_INVALID'
  | 'EVIDENCE_PLATFORM_UNSUPPORTED'
  | 'EVIDENCE_PARENT_INVALID'
  | 'EVIDENCE_PARENT_CHANGED'
  | 'EVIDENCE_LEAF_LINK'
  | 'EVIDENCE_LEAF_HARDLINK'
  | 'EVIDENCE_LEAF_INVALID'
  | 'EVIDENCE_EXISTS'
  | 'EVIDENCE_WRITE_FAILED';

export class PlannerLiveEvidenceError extends Error {
  constructor(readonly code: PlannerEvidenceFailureCode) {
    super(`ret002c2_live:${code.toLowerCase()}`);
    this.name = 'PlannerLiveEvidenceError';
  }
}

interface EvidenceAuthority {
  readonly parent: string;
  readonly path: string;
}

interface DirectoryIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly owner: bigint;
  readonly mode: bigint;
  readonly links: bigint;
}

interface FileIdentity extends DirectoryIdentity {
  readonly size: bigint;
}

interface BigIntStats {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

function failure(code: PlannerEvidenceFailureCode): PlannerLiveEvidenceError {
  return new PlannerLiveEvidenceError(code);
}

export function plannerEvidenceAuthorityV1(): EvidenceAuthority {
  const runnerTemp = process.env['RUNNER_TEMP'];
  const requestedPath = process.env[EVIDENCE_PATH_ENV];
  if (typeof runnerTemp !== 'string' || runnerTemp.length === 0 || runnerTemp.includes('\0')
    || !isAbsolute(runnerTemp) || resolve(runnerTemp) !== runnerTemp) {
    throw failure('EVIDENCE_PATH_INVALID');
  }
  const parent = join(runnerTemp, EVIDENCE_DIRECTORY);
  const path = join(parent, EVIDENCE_FILENAME);
  if (requestedPath !== path) throw failure('EVIDENCE_PATH_INVALID');
  return Object.freeze({ parent, path });
}

export function hasExactPlannerEvidenceParentPermissionsV1(mode: bigint): boolean {
  return (mode & 0o7777n) === 0o700n;
}

function currentUid(): bigint {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function'
    || typeof fsConstants.O_NOFOLLOW !== 'number' || fsConstants.O_NOFOLLOW === 0) {
    throw failure('EVIDENCE_PLATFORM_UNSUPPORTED');
  }
  return BigInt(process.getuid());
}

async function directoryIdentity(path: string, owner: bigint): Promise<DirectoryIdentity> {
  try {
    const stats = await lstat(path, { bigint: true }) as unknown as BigIntStats;
    if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== owner
      || stats.nlink < 1n || !hasExactPlannerEvidenceParentPermissionsV1(stats.mode)
      || await realpath(path) !== path) {
      throw failure('EVIDENCE_PARENT_INVALID');
    }
    return Object.freeze({
      device: stats.dev, inode: stats.ino, owner: stats.uid, mode: stats.mode, links: stats.nlink,
    });
  } catch (error) {
    if (error instanceof PlannerLiveEvidenceError) throw error;
    throw failure('EVIDENCE_PARENT_INVALID');
  }
}

function sameDirectory(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.device === right.device && left.inode === right.inode
    && left.owner === right.owner && left.mode === right.mode && left.links === right.links;
}

async function assertParentStable(
  authority: EvidenceAuthority,
  owner: bigint,
  expected: DirectoryIdentity,
): Promise<void> {
  const observed = await directoryIdentity(authority.parent, owner);
  if (!sameDirectory(observed, expected)) throw failure('EVIDENCE_PARENT_CHANGED');
}

async function rejectPreexistingLeaf(path: string): Promise<void> {
  try {
    const stats = await lstat(path, { bigint: true }) as unknown as BigIntStats;
    if (stats.isSymbolicLink()) throw failure('EVIDENCE_LEAF_LINK');
    if (stats.nlink !== 1n) throw failure('EVIDENCE_LEAF_HARDLINK');
    throw failure('EVIDENCE_EXISTS');
  } catch (error) {
    if (error instanceof PlannerLiveEvidenceError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw failure('EVIDENCE_WRITE_FAILED');
  }
}

function validateLeaf(
  stats: BigIntStats,
  owner: bigint,
  expected?: FileIdentity,
  expectedSize?: bigint,
): FileIdentity {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== owner
    || (stats.mode & 0o7777n) !== 0o600n) throw failure('EVIDENCE_LEAF_INVALID');
  if (stats.nlink !== 1n) throw failure('EVIDENCE_LEAF_HARDLINK');
  if (expectedSize !== undefined && stats.size !== expectedSize) throw failure('EVIDENCE_WRITE_FAILED');
  const identity = Object.freeze({
    device: stats.dev,
    inode: stats.ino,
    owner: stats.uid,
    mode: stats.mode,
    links: stats.nlink,
    size: stats.size,
  });
  if (expected !== undefined && (identity.device !== expected.device
    || identity.inode !== expected.inode || identity.owner !== expected.owner
    || identity.mode !== expected.mode || identity.links !== expected.links)) {
    throw failure('EVIDENCE_LEAF_INVALID');
  }
  return identity;
}

export async function writePlannerLiveEvidenceTestCoreV1(
  afterOpen?: () => Promise<void>,
): Promise<void> {
  const authority = plannerEvidenceAuthorityV1();
  const owner = currentUid();
  const parent = await directoryIdentity(authority.parent, owner);
  await rejectPreexistingLeaf(authority.path);
  const expectedSize = BigInt(Buffer.byteLength(SUCCESS_EVIDENCE, 'utf8'));
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let closed = false;
  try {
    handle = await open(
      authority.path,
      fsConstants.O_NOFOLLOW | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    if (afterOpen !== undefined) await afterOpen();
    await assertParentStable(authority, owner, parent);
    const openedLeaf = validateLeaf(
      await handle.stat({ bigint: true }) as unknown as BigIntStats,
      owner,
      undefined,
      0n,
    );
    await handle.writeFile(SUCCESS_EVIDENCE, { encoding: 'utf8' });
    await handle.sync();
    validateLeaf(
      await handle.stat({ bigint: true }) as unknown as BigIntStats,
      owner,
      openedLeaf,
      expectedSize,
    );
    await assertParentStable(authority, owner, parent);
    await handle.close();
    closed = true;
    const closedLeaf = validateLeaf(
      await lstat(authority.path, { bigint: true }) as unknown as BigIntStats,
      owner,
      openedLeaf,
      expectedSize,
    );
    if (closedLeaf.device !== openedLeaf.device || closedLeaf.inode !== openedLeaf.inode
      || closedLeaf.links !== openedLeaf.links) throw failure('EVIDENCE_LEAF_INVALID');
    await assertParentStable(authority, owner, parent);
  } catch (error) {
    if (handle !== undefined && !closed) {
      try {
        await handle.close();
      } catch {
        throw failure('EVIDENCE_WRITE_FAILED');
      }
    }
    if (error instanceof PlannerLiveEvidenceError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw failure('EVIDENCE_EXISTS');
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw failure('EVIDENCE_LEAF_LINK');
    throw failure('EVIDENCE_WRITE_FAILED');
  }
}

export async function writePlannerLiveEvidenceV1(
  ...unexpected: readonly unknown[]
): Promise<void> {
  if (unexpected.length !== 0) throw failure('EVIDENCE_INPUT_INVALID');
  return writePlannerLiveEvidenceTestCoreV1();
}
