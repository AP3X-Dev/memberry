import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const DIRECTORY = 'memberry-candidate-channel-live';
const AUTHORITY_FILENAME = 'evidence.json';
const FILENAME = 'ret004b-evidence.json';
const AUTHORITY_ENV = 'MEMBERRY_RET003B_EVIDENCE_PATH';
const BYTES = '{"contract":"RET-004B","mode":"required","disposable":true,"realBootstrap":true,"centralHttpAuthentication":true,"authorityBound":true,"baselineByteParity":true,"contentFreeObservation":true,"localReferenceProvider":true,"shutdownDrained":true,"cleanupCount":0}\n';

type Code = 'INPUT_INVALID' | 'PATH_INVALID' | 'PLATFORM_UNSUPPORTED' | 'PARENT_INVALID'
  | 'PARENT_CHANGED' | 'LEAF_LINK' | 'LEAF_HARDLINK' | 'EXISTS' | 'LEAF_INVALID' | 'WRITE_FAILED';
export class RerankerShadowLiveEvidenceError extends Error {
  constructor(readonly code: Code) { super(`ret004b_live:${code.toLowerCase()}`); this.name = 'RerankerShadowLiveEvidenceError'; }
}
interface Stats { dev: bigint; ino: bigint; uid: bigint; mode: bigint; nlink: bigint; size: bigint; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }
interface Identity { dev: bigint; ino: bigint; uid: bigint; mode: bigint; nlink: bigint; size?: bigint }
const fail = (code: Code) => new RerankerShadowLiveEvidenceError(code);

export function rerankerShadowEvidenceAuthorityV1(): Readonly<{ parent: string; path: string }> {
  const root = process.env['RUNNER_TEMP']; const requested = process.env[AUTHORITY_ENV];
  if (typeof root !== 'string' || root.length === 0 || root.includes('\0') || !isAbsolute(root) || resolve(root) !== root) throw fail('PATH_INVALID');
  const parent = join(root, DIRECTORY);
  const authorityPath = join(parent, AUTHORITY_FILENAME);
  const path = join(parent, FILENAME);
  if (requested !== authorityPath) throw fail('PATH_INVALID');
  return Object.freeze({ parent, path });
}
function uid(): bigint {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function' || !fsConstants.O_NOFOLLOW) throw fail('PLATFORM_UNSUPPORTED');
  return BigInt(process.getuid());
}
async function parentIdentity(path: string, owner: bigint): Promise<Identity> {
  try {
    const s = await lstat(path, { bigint: true }) as unknown as Stats;
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== owner || s.nlink < 1n
      || (s.mode & 0o7777n) !== 0o700n || await realpath(path) !== path) throw fail('PARENT_INVALID');
    return Object.freeze({ dev: s.dev, ino: s.ino, uid: s.uid, mode: s.mode, nlink: s.nlink });
  } catch (error) { if (error instanceof RerankerShadowLiveEvidenceError) throw error; throw fail('PARENT_INVALID'); }
}
function same(a: Identity, b: Identity): boolean { return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode && a.nlink === b.nlink; }
async function rejectLeaf(path: string): Promise<void> {
  try { const s = await lstat(path, { bigint: true }) as unknown as Stats; if (s.isSymbolicLink()) throw fail('LEAF_LINK'); if (s.nlink !== 1n) throw fail('LEAF_HARDLINK'); throw fail('EXISTS'); }
  catch (error) { if (error instanceof RerankerShadowLiveEvidenceError) throw error; if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw fail('WRITE_FAILED'); }
}
function leaf(s: Stats, owner: bigint, size: bigint, expected?: Identity): Identity {
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== owner || (s.mode & 0o7777n) !== 0o600n || s.nlink !== 1n || s.size !== size) throw fail('LEAF_INVALID');
  const value = Object.freeze({ dev: s.dev, ino: s.ino, uid: s.uid, mode: s.mode, nlink: s.nlink, size: s.size });
  if (expected && !same(value, expected)) throw fail('LEAF_INVALID'); return value;
}
export async function writeRerankerShadowLiveEvidenceTestCoreV1(afterOpen?: () => Promise<void>): Promise<void> {
  const authority = rerankerShadowEvidenceAuthorityV1(); const owner = uid(); const parent = await parentIdentity(authority.parent, owner); await rejectLeaf(authority.path);
  let handle: Awaited<ReturnType<typeof open>> | undefined; let closed = false;
  try {
    handle = await open(authority.path, fsConstants.O_NOFOLLOW | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    if (afterOpen) await afterOpen();
    if (!same(await parentIdentity(authority.parent, owner), parent)) throw fail('PARENT_CHANGED');
    const opened = leaf(await handle.stat({ bigint: true }) as unknown as Stats, owner, 0n);
    await handle.writeFile(BYTES, 'utf8'); await handle.sync(); const size = BigInt(Buffer.byteLength(BYTES));
    leaf(await handle.stat({ bigint: true }) as unknown as Stats, owner, size, opened);
    if (!same(await parentIdentity(authority.parent, owner), parent)) throw fail('PARENT_CHANGED');
    await handle.close(); closed = true; leaf(await lstat(authority.path, { bigint: true }) as unknown as Stats, owner, size, opened);
  } catch (error) {
    if (handle && !closed) try { await handle.close(); } catch { throw fail('WRITE_FAILED'); }
    if (error instanceof RerankerShadowLiveEvidenceError) throw error;
    const code = (error as NodeJS.ErrnoException).code; if (code === 'EEXIST') throw fail('EXISTS'); if (code === 'ELOOP') throw fail('LEAF_LINK'); throw fail('WRITE_FAILED');
  }
}
export async function writeRerankerShadowLiveEvidenceV1(...unexpected: readonly unknown[]): Promise<void> {
  if (unexpected.length !== 0) throw fail('INPUT_INVALID');
  return writeRerankerShadowLiveEvidenceTestCoreV1();
}
