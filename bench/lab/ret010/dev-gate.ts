#!/usr/bin/env tsx

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm,
} from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const RUNS_SUFFIX = ['node_modules', '.cache', 'memberry-lab', 'runs'] as const;
const RUNS_ROOT = resolve(REPO_ROOT, ...RUNS_SUFFIX);
const OUTPUT_LEAF = resolve(RUNS_ROOT, 'ret010-development');
const STAGING_LEAF = resolve(RUNS_ROOT, 'ret010-development.staging');
const FINALIZER_STAGING_LEAF = resolve(RUNS_ROOT, 'ret010-development.finalizer-staging');
const SUCCESS_FILES = [
  'recall-lane.json', 'precision-lane.json', 'efficiency-interval.json',
  'aggregate-result.json', 'custody-manifest.json',
] as const;
const FAILURE_FILE = 'failure-tombstone.json';
const SAFE_FAILURE = 'RET010_DEV_GATE_FAILED\n';
const CONTROL_ID = 'memberry-retrieval-core-disabled-v1';
const CANDIDATE_ID = 'memberry-retrieval-core-served-v1';
const DATASET_ID = 'memberry-ret010-dev-v1';
const MUTABLE_PATHS = [
  '.github/workflows/ci.yml',
  'bench/lab/adapters/memberry-retrieval-core.ts',
  'bench/lab/registered-adapters.ts',
  'bench/lab/registry/systems.json',
  'bench/lab/baselines/ci-gate.ts',
  'bench/lab/ret010/dev-gate.ts',
  'bench/lab/ret010/holdout-gate.mts',
  'bench/lab/__tests__/memberry-retrieval-core.test.ts',
  'bench/lab/__tests__/registered-adapters.test.ts',
  'bench/lab/baselines/__tests__/ci-gate-binding.test.ts',
  'bench/lab/ret010/__tests__/dev-gate.test.ts',
  'bench/lab/ret010/__tests__/holdout-gate.test.ts',
] as const;
const IMMUTABLE_DEPENDENCIES = [
  'bench/lab/stats.ts',
  'bench/lab/baselines/canonical.ts',
  'bench/lab/datasets/hash.ts',
  'packages/retrieval/src/served-reranker.ts',
  'packages/retrieval/src/reranker.ts',
  'packages/retrieval/src/assembler.ts',
] as const;
const CUSTODY_PATHS = [...MUTABLE_PATHS, ...IMMUTABLE_DEPENDENCIES] as const;

type FailureClass = 'harness' | 'infrastructure' | 'model' | 'metric' | 'safety' | 'custody';
type FailureStage = 'source-integrity' | 'registry' | 'load-dev' | 'recall-comparison'
  | 'precision-comparison' | 'efficiency' | 'quality-policy' | 'safety-policy'
  | 'response-effect' | 'artifact';
type JsonRecord = Record<string, unknown>;

interface CustodyIdentity {
  gitCommit: string;
  nodeMajor: '20' | '22';
  nodeVersion: string;
  workflowRunId: string;
  workflowRunAttempt: number;
}

export interface FailureContext {
  failureClass: FailureClass;
  stage: FailureStage;
}

interface FileStatusFixture {
  kind: 'directory' | 'file' | 'symlink' | 'junction' | 'reparse' | 'mount';
  realPathMatches: boolean;
}

type CustodyClassifier = (fixture: FileStatusFixture) => 'directory' | 'reject';
type MutationHook = (stage: 'after-create' | 'before-publish' | 'before-rename' | 'before-delete', path: string) => Promise<void>;
export interface RuntimeFileStatus {
  isDirectory: boolean;
  isSymbolicLink: boolean;
  dev: number | bigint;
  realPath: string;
  windowsReparseKind?: 'junction' | 'reparse';
}
type StatusAcquirer = (path: string) => Promise<RuntimeFileStatus>;

export function classifyCustodyComponent(fixture: FileStatusFixture): 'directory' | 'reject' {
  return fixture.kind === 'directory' && fixture.realPathMatches ? 'directory' : 'reject';
}

async function acquireRuntimeStatus(path: string): Promise<RuntimeFileStatus> {
  const info = await lstat(path);
  return {
    isDirectory: info.isDirectory(), isSymbolicLink: info.isSymbolicLink(), dev: info.dev,
    realPath: await realpath(path),
    ...(process.platform === 'win32' && info.isSymbolicLink() ? { windowsReparseKind: 'junction' as const } : {}),
  };
}

function statusKind(status: RuntimeFileStatus, mounts: Set<string>, parentDev?: number | bigint): FileStatusFixture['kind'] {
  if (status.windowsReparseKind === 'junction') return 'junction';
  if (status.windowsReparseKind === 'reparse') return 'reparse';
  if (status.isSymbolicLink) return 'symlink';
  if (mounts.has(status.realPath) || (parentDev !== undefined && status.dev !== parentDev)) return 'mount';
  return status.isDirectory ? 'directory' : 'file';
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key, index) => Object.keys(value)[index] === key);
}

function finite(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)
    && value >= minimum && value <= maximum;
}

function normalizeNumber(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalBytes(record: JsonRecord): Buffer {
  return Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
}

function environmentIdentity(): CustodyIdentity {
  const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const major = process.versions.node.split('.')[0];
  const workflowRunId = process.env.GITHUB_RUN_ID ?? '';
  const attemptText = process.env.GITHUB_RUN_ATTEMPT ?? '';
  const attempt = /^[1-9][0-9]*$/.test(attemptText) ? Number(attemptText) : Number.NaN;
  if (!/^[0-9a-f]{40}$/.test(gitCommit) || (major !== '20' && major !== '22')
    || !/^v(?:20|22)\.[0-9]+\.[0-9]+$/.test(process.version)
    || !/^[1-9][0-9]*$/.test(workflowRunId)
    || !Number.isSafeInteger(attempt) || attempt < 1) throw new Error('custody');
  return {
    gitCommit,
    nodeMajor: major,
    nodeVersion: process.version,
    workflowRunId,
    workflowRunAttempt: attempt,
  };
}

function pathComponents(root: string, target: string): string[] {
  const suffix = relative(root, target);
  if (!suffix || suffix.startsWith('..') || resolve(root, suffix) !== resolve(target)) throw new Error('custody');
  const parts = suffix.split(sep).filter(Boolean);
  return parts.map((_, index) => resolve(root, ...parts.slice(0, index + 1)));
}

async function linuxMountPoints(): Promise<Set<string>> {
  if (process.platform !== 'linux') return new Set();
  try {
    const text = await readFile('/proc/self/mountinfo', 'utf8');
    return new Set(text.split('\n').flatMap((line) => {
      const fields = line.split(' ');
      if (fields.length < 5) return [];
      return [fields[4]!.replace(/\\040/g, ' ')];
    }));
  } catch {
    throw new Error('custody');
  }
}

async function validateDirectoryChain(
  target: string,
  create = false,
  custodyRoot = REPO_ROOT,
  classifier: CustodyClassifier = classifyCustodyComponent,
  acquireStatus: StatusAcquirer = acquireRuntimeStatus,
): Promise<void> {
  const rootStatus = await acquireStatus(custodyRoot);
  const repositoryReal = rootStatus.realPath;
  const mounts = await linuxMountPoints();
  if (classifier({ kind: statusKind(rootStatus, mounts), realPathMatches: repositoryReal === resolve(custodyRoot) }) !== 'directory') throw new Error('custody');
  let parent = custodyRoot;
  let parentDev = rootStatus.dev;
  for (const component of pathComponents(custodyRoot, target)) {
    if (create) await mkdir(component).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const status = await acquireStatus(component);
    if (classifier({ kind: statusKind(status, mounts, parentDev), realPathMatches: status.realPath === component }) !== 'directory') throw new Error('custody');
    parent = component;
    parentDev = status.dev;
  }
  if (resolve(parent) !== resolve(target)) throw new Error('custody');
}

export async function validateCustodyChainForTest(
  root: string,
  target: string,
  classifier?: CustodyClassifier,
  acquireStatus?: StatusAcquirer,
): Promise<void> {
  await validateDirectoryChain(resolve(target), false, resolve(root), classifier, acquireStatus);
}

async function validateRunsRoot(create = false): Promise<void> {
  await validateDirectoryChain(RUNS_ROOT, create);
  const repositoryReal = await realpath(REPO_ROOT);
  const runsReal = await realpath(RUNS_ROOT);
  const expected = resolve(repositoryReal, ...RUNS_SUFFIX);
  if (runsReal !== expected || !runsReal.endsWith(`${sep}${RUNS_SUFFIX.join(sep)}`)) throw new Error('custody');
}

async function safeRemoveLeaf(path: string): Promise<void> {
  await validateRunsRoot(false);
  try {
    await quarantineRemoveLeaf(REPO_ROOT, RUNS_ROOT, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function directoryIdentity(path: string): Promise<{ dev: number | bigint; ino: number | bigint }> {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('custody');
  return { dev: info.dev, ino: info.ino };
}

function sameIdentity(left: { dev: number | bigint; ino: number | bigint }, right: { dev: number | bigint; ino: number | bigint }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function quarantineAnyLeaf(
  custodyRoot: string,
  parent: string,
  path: string,
): Promise<{ quarantineParent: string; quarantine: string; identity: { dev: number | bigint; ino: number | bigint } }> {
  await validateDirectoryChain(parent, false, custodyRoot);
  const observed = await lstat(path, { bigint: true });
  const identity = { dev: observed.dev, ino: observed.ino };
  const quarantineParent = await mkdtemp(resolve(parent, '.ret010-quarantine-'));
  await validateDirectoryChain(quarantineParent, false, custodyRoot);
  const quarantine = resolve(quarantineParent, 'leaf');
  await absentPath(quarantine);
  await validateDirectoryChain(parent, false, custodyRoot);
  const immediate = await lstat(path, { bigint: true });
  if (immediate.dev !== identity.dev || immediate.ino !== identity.ino) throw new Error('custody');
  await rename(path, quarantine);
  const moved = await lstat(quarantine, { bigint: true });
  if (moved.dev !== identity.dev || moved.ino !== identity.ino) throw new Error('custody');
  await absentPath(path);
  return { quarantineParent, quarantine, identity };
}

async function quarantineRemoveLeaf(
  custodyRoot: string,
  parent: string,
  path: string,
  hook?: MutationHook,
): Promise<void> {
  await validateDirectoryChain(parent, false, custodyRoot);
  const before = await directoryIdentity(path);
  await hook?.('before-rename', path);
  const moved = await quarantineAnyLeaf(custodyRoot, parent, path);
  if (!sameIdentity(before, moved.identity)) throw new Error('custody');
  const { quarantineParent, quarantine } = moved;
  await hook?.('before-delete', quarantine);
  await validateDirectoryChain(parent, false, custodyRoot);
  const final = await directoryIdentity(quarantine);
  if (!sameIdentity(before, final)) throw new Error('custody');
  await rm(quarantine, { recursive: true, force: false });
  await rm(quarantineParent, { recursive: false, force: false });
}

export async function removeCustodyLeafForTest(root: string, parent: string, path: string, hook?: MutationHook): Promise<void> {
  await quarantineRemoveLeaf(resolve(root), resolve(parent), resolve(path), hook);
}

async function cleanBoundary(): Promise<void> {
  await validateRunsRoot(true);
  await safeRemoveLeaf(OUTPUT_LEAF);
  await safeRemoveLeaf(STAGING_LEAF);
  await safeRemoveLeaf(FINALIZER_STAGING_LEAF);
  await validateRunsRoot(false);
}

async function writeExclusive(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); } finally { await handle.close(); }
}

async function publishBundle(
  records: Readonly<Record<string, JsonRecord>>,
  expectedIdentity?: CustodyIdentity,
  stagingLeaf = STAGING_LEAF,
): Promise<void> {
  await validateRunsRoot(false);
  await safeRemoveLeaf(stagingLeaf);
  await createVerifiedLeaf(REPO_ROOT, RUNS_ROOT, stagingLeaf);
  for (const [name, record] of Object.entries(records)) await writeExclusive(resolve(stagingLeaf, name), canonicalBytes(record));
  await verifyDirectory(stagingLeaf, Object.keys(records).sort());
  await validateDirectoryChain(stagingLeaf, false);
  await validateRunsRoot(false);
  try { await lstat(OUTPUT_LEAF); throw new Error('custody'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await renameVerifiedLeaf(
    REPO_ROOT, RUNS_ROOT, stagingLeaf, OUTPUT_LEAF, undefined,
    expectedIdentity ? async () => {
      await assertSourceIntegrity(expectedIdentity.gitCommit);
      if (JSON.stringify(environmentIdentity()) !== JSON.stringify(expectedIdentity)) throw new Error('custody');
      await validateRunsRoot(false);
      await absentPath(OUTPUT_LEAF);
    } : undefined,
  );
  await verifyDirectory(OUTPUT_LEAF, Object.keys(records).sort());
}

async function createVerifiedLeaf(custodyRoot: string, parent: string, path: string, hook?: MutationHook): Promise<void> {
  await validateDirectoryChain(parent, false, custodyRoot);
  await mkdir(path);
  await hook?.('after-create', path);
  try {
    await validateDirectoryChain(path, false, custodyRoot);
    await directoryIdentity(path);
  } catch (error) {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory()) await rm(path, { force: true, recursive: false });
      else {
        await quarantineAnyLeaf(custodyRoot, parent, path);
      }
    } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'custody'); }
    throw error;
  }
}

async function renameVerifiedLeaf(
  custodyRoot: string,
  parent: string,
  source: string,
  destination: string,
  hook?: MutationHook,
  preRename?: () => Promise<void>,
): Promise<void> {
  await validateDirectoryChain(parent, false, custodyRoot);
  const identity = await directoryIdentity(source);
  await hook?.('before-publish', source);
  await validateDirectoryChain(parent, false, custodyRoot);
  await preRename?.();
  await validateDirectoryChain(parent, false, custodyRoot);
  let immediate: { dev: number | bigint; ino: number | bigint };
  try { immediate = await directoryIdentity(source); }
  catch (error) {
    try { await quarantineAnyLeaf(custodyRoot, parent, source); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'custody'); }
    throw error;
  }
  if (!sameIdentity(identity, immediate)) {
    await quarantineAnyLeaf(custodyRoot, parent, source);
    throw new Error('custody');
  }
  await absentPath(destination);
  await rename(source, destination);
  try {
    await validateDirectoryChain(destination, false, custodyRoot);
    if (!sameIdentity(identity, await directoryIdentity(destination))) throw new Error('custody');
  } catch (error) {
    try { await quarantineAnyLeaf(custodyRoot, parent, destination); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'custody'); }
    throw error;
  }
}

async function absentPath(path: string): Promise<void> {
  try { await lstat(path); throw new Error('custody'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function createCustodyLeafForTest(root: string, parent: string, path: string, hook?: MutationHook): Promise<void> {
  await createVerifiedLeaf(resolve(root), resolve(parent), resolve(path), hook);
}

export async function renameCustodyLeafForTest(root: string, parent: string, source: string, destination: string, hook?: MutationHook): Promise<void> {
  await renameVerifiedLeaf(resolve(root), resolve(parent), resolve(source), resolve(destination), hook);
}

async function verifyDirectory(root: string, allowlist: readonly string[]): Promise<Record<string, Buffer>> {
  const rootIdentity = await directoryIdentity(root);
  const entries = await readdir(root);
  if (JSON.stringify(entries.sort()) !== JSON.stringify([...allowlist].sort())) throw new Error('artifact');
  const verified: Record<string, Buffer> = {};
  for (const name of entries) {
    const path = resolve(root, name);
    const info = await lstat(path, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('artifact');
    const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || info.dev !== opened.dev || info.ino !== opened.ino) throw new Error('artifact');
      bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (!after.isFile() || info.dev !== after.dev || info.ino !== after.ino) throw new Error('artifact');
    } finally { await handle.close(); }
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error('artifact');
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    if (!isRecord(parsed) || !bytes.equals(canonicalBytes(parsed))) throw new Error('artifact');
    verified[name] = bytes;
  }
  if (!sameIdentity(rootIdentity, await directoryIdentity(root))) throw new Error('artifact');
  return verified;
}

function gitOutput(args: readonly string[]): Buffer {
  return execFileSync('git', [...args], { cwd: REPO_ROOT, encoding: null, maxBuffer: 8 * 1024 * 1024 });
}

async function assertSourceIntegrity(expectedCommit?: string): Promise<string> {
  const head = gitOutput(['rev-parse', 'HEAD']).toString('utf8').trim();
  if (!/^[0-9a-f]{40}$/.test(head) || (expectedCommit !== undefined && head !== expectedCommit)) throw new Error('custody');
  if (gitOutput(['status', '--porcelain=v1', '--untracked-files=all']).length !== 0) throw new Error('custody');
  for (const path of CUSTODY_PATHS) {
    const entry = gitOutput(['ls-tree', 'HEAD', '--', path]).toString('utf8').trim();
    const match = /^([0-9]{6}) blob ([0-9a-f]{40})\t(.+)$/.exec(entry);
    if (!match || match[3] !== path || (match[1] !== '100644' && match[1] !== '100755')) throw new Error('custody');
    const absolute = resolve(REPO_ROOT, path);
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()
      || (process.platform !== 'win32' && ((info.mode & 0o111) !== 0) !== (match[1] === '100755'))) throw new Error('custody');
    const work = await readFile(absolute);
    const blob = gitOutput(['cat-file', 'blob', `HEAD:${path}`]);
    if (!work.equals(blob)) throw new Error('custody');
  }
  return head;
}

async function gitBlob(path: string): Promise<string> {
  const output = gitOutput(['rev-parse', `HEAD:${path}`]).toString('utf8').trim();
  if (!/^[0-9a-f]{40}$/.test(output)) throw new Error('custody');
  return output;
}

function gitBytesAt(commit: string, path: string): Buffer {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('custody');
  return gitOutput(['cat-file', 'blob', `${commit}:${path}`]);
}

function gitBlobAt(commit: string, path: string): string {
  const output = gitOutput(['rev-parse', `${commit}:${path}`]).toString('utf8').trim();
  if (!/^[0-9a-f]{40}$/.test(output)) throw new Error('custody');
  return output;
}

function textLf(bytes: Buffer): Buffer {
  return Buffer.from(bytes.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8');
}

function validateFrozenDatasetAt(sourceCommit: string): { descriptorSha256: string; inputSha256: string; oracleSha256: string } {
  const registry = JSON.parse(gitBytesAt(sourceCommit, 'bench/lab/registry/datasets.json').toString('utf8')) as unknown;
  if (!isRecord(registry) || registry.schemaVersion !== 1 || !Array.isArray(registry.datasets)) throw new Error('artifact');
  const matches = registry.datasets.filter((entry) => isRecord(entry) && (entry.id === DATASET_ID || entry.suite === 'ret010-development'));
  if (matches.length !== 1) throw new Error('artifact');
  const descriptor = matches[0] as JsonRecord;
  const descriptorKeys = ['id', 'version', 'suite', 'kind', 'split', 'oracleAccess', 'requiredInCi', 'source', 'license', 'dataPolicy', 'acquisition', 'artifacts'];
  if (!exactKeys(descriptor, descriptorKeys) || descriptor.id !== DATASET_ID || descriptor.version !== 'ret010-dev-v1'
    || descriptor.suite !== 'ret010-development' || descriptor.kind !== 'repository' || descriptor.split !== 'dev'
    || descriptor.oracleAccess !== 'scorer-only' || descriptor.requiredInCi !== false || !Array.isArray(descriptor.artifacts)
    || descriptor.artifacts.length !== 2) throw new Error('artifact');
  const source = recordValue(descriptor.source);
  if (!exactKeys(source, ['url', 'revision', 'path']) || source.url !== null || source.revision !== 'ret010-dev-v1'
    || source.path !== 'bench/lab/datasets/ret010/v1/dev') throw new Error('artifact');
  const license = recordValue(descriptor.license);
  const dataPolicy = recordValue(descriptor.dataPolicy);
  const acquisition = recordValue(descriptor.acquisition);
  if (!exactKeys(license, ['status', 'spdx', 'url', 'usage']) || license.status !== 'internal'
    || license.spdx !== null || license.url !== null || license.usage !== 'repository-tests-only'
    || !exactKeys(dataPolicy, ['reviewStatus', 'containsPersonalData', 'containsSecrets', 'containsCustomerData', 'exclusions'])
    || dataPolicy.reviewStatus !== 'verified' || dataPolicy.containsPersonalData !== false
    || dataPolicy.containsSecrets !== false || dataPolicy.containsCustomerData !== false
    || JSON.stringify(dataPolicy.exclusions) !== JSON.stringify(['real user memory', 'credentials', 'private customer data', 'production tenant identifiers'])
    || !exactKeys(acquisition, ['status']) || acquisition.status !== 'bundled') throw new Error('artifact');
  const expected = [
    { role: 'input', access: 'adapter', fileName: 'input.jsonl', repositoryPath: 'bench/lab/datasets/ret010/v1/dev/input.jsonl' },
    { role: 'oracle', access: 'scorer', fileName: 'oracle.jsonl', repositoryPath: 'bench/lab/datasets/ret010/v1/dev/oracle.jsonl' },
  ];
  const digests: string[] = [];
  descriptor.artifacts.forEach((raw, index) => {
    const artifact = recordValue(raw);
    if (!exactKeys(artifact, ['role', 'access', 'fileName', 'repositoryPath', 'hashMode', 'sha256', 'sizeBytes'])
      || artifact.role !== expected[index]!.role || artifact.access !== expected[index]!.access
      || artifact.fileName !== expected[index]!.fileName || artifact.repositoryPath !== expected[index]!.repositoryPath
      || artifact.hashMode !== 'text-lf' || !/^[0-9a-f]{64}$/.test(String(artifact.sha256))
      || !Number.isSafeInteger(artifact.sizeBytes) || (artifact.sizeBytes as number) < 1) throw new Error('artifact');
    const normalized = textLf(gitBytesAt(sourceCommit, String(artifact.repositoryPath)));
    const digest = sha256(normalized);
    if (digest !== artifact.sha256 || normalized.byteLength !== artifact.sizeBytes) throw new Error('artifact');
    digests.push(digest);
  });
  return {
    descriptorSha256: sha256(Buffer.from(`${JSON.stringify(descriptor)}\n`)),
    inputSha256: digests[0]!, oracleSha256: digests[1]!,
  };
}

function recordValue(value: unknown): JsonRecord {
  if (!isRecord(value)) throw new Error('artifact');
  return value;
}

async function assertDevelopmentBindingSource(sourceCommit: string): Promise<void> {
  const queue = ['bench/lab/ret010/load-dev.ts', 'bench/lab/ret010/dev-gate.ts'];
  const visited = new Set<string>();
  const forbiddenPath = /(?:^|\/)(?:g2|holdout)(?:\/|[-_.])|datasets\/load-suite/i;
  const resolveTracked = (importer: string, specifier: string): string => {
    const base = resolve(REPO_ROOT, dirname(importer), specifier);
    const candidates = [
      base, base.replace(/\.js$/i, '.ts'), base.replace(/\.mjs$/i, '.mts'),
      resolve(base, 'index.ts'),
    ];
    for (const candidate of [...new Set(candidates)]) {
      const path = relative(REPO_ROOT, candidate).replace(/\\/g, '/');
      if (path.startsWith('../')) continue;
      try { gitBytesAt(sourceCommit, path); return path; } catch { /* next exact Git path */ }
    }
    throw new Error('registry');
  };
  while (queue.length > 0) {
    const path = queue.shift()!;
    if (visited.has(path)) continue;
    visited.add(path);
    if (forbiddenPath.test(path)) throw new Error('registry');
    const bytes = gitBytesAt(sourceCommit, path);
    const absolute = resolve(REPO_ROOT, path);
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink() || !(await readFile(absolute)).equals(bytes)) throw new Error('registry');
    const source = bytes.toString('utf8');
    const importCalls = source.match(/\bimport\s*\(/g) ?? [];
    const literalDynamic = [...source.matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g)];
    if (importCalls.length !== literalDynamic.length) throw new Error('registry');
    const specifiers = [
      ...source.matchAll(/(?:\bfrom\s*|\bimport\s*)(['"])([^'"]+)\1/g),
      ...literalDynamic,
    ].map((match) => match[2]!).filter((specifier) => specifier.startsWith('.'));
    for (const specifier of specifiers) {
      if (/g2|holdout|datasets\/load-suite/i.test(specifier)) throw new Error('registry');
      const resolvedPath = resolveTracked(path, specifier);
      const requested = resolve(dirname(absolute), specifier);
      for (const shadow of [requested, requested.replace(/\.js$/i, '.mjs'), requested.replace(/\.js$/i, '.cjs')]) {
        const shadowPath = relative(REPO_ROOT, shadow).replace(/\\/g, '/');
        if (shadowPath !== resolvedPath) {
          try { await lstat(shadow); throw new Error('registry'); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
      }
      queue.push(resolvedPath);
    }
  }
  const loadSource = gitBytesAt(sourceCommit, 'bench/lab/ret010/load-dev.ts').toString('utf8');
  for (const forbidden of ['memberry-g2', 'holdout', 'datasets/g2', 'loadG2HoldoutScenariosForScoring', 'datasets/load-suite']) {
    if (loadSource.toLowerCase().includes(forbidden.toLowerCase())) throw new Error('registry');
  }
  if ((loadSource.match(/memberry-ret010-dev-v1/g) ?? []).length !== 1
    || !loadSource.includes("if (descriptor.split !== 'dev')")
    || loadSource.includes('datasetId: string') || loadSource.includes('split: LabScenarioSplit')) throw new Error('registry');
  const gateSource = gitBytesAt(sourceCommit, 'bench/lab/ret010/dev-gate.ts').toString('utf8');
  const dynamicImports = [...gateSource.matchAll(/import\('([^']+)'\)/g)].map((match) => match[1]);
  const expectedImports = [
    './load-dev.js', '../registered-adapters.js', '../stats.js',
    '../../../packages/retrieval/src/served-reranker.js',
    './load-dev.js', '../registered-adapters.js', '../stats.js',
  ];
  if (JSON.stringify(dynamicImports.sort()) !== JSON.stringify(expectedImports.sort())
    || (gateSource.match(/splits: \['dev'\]/g) ?? []).length !== 4
    || !gateSource.includes("runId: 'ret010-development-recall', controlId: CONTROL_ID, candidateId: CANDIDATE_ID")
    || !gateSource.includes("runId: 'ret010-development-precision', controlId: CONTROL_ID, candidateId: CANDIDATE_ID")
    || !gateSource.includes('scenarios: scenarios.slice(0, 10)')
    || !gateSource.includes('scenarios: scenarios.slice(10)')) throw new Error('registry');
}

function assertExperimentRegistry(sourceCommit: string): void {
  const parsed = JSON.parse(gitBytesAt(sourceCommit, 'bench/lab/registry/experiments.json').toString('utf8')) as unknown;
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.experiments)) throw new Error('registry');
  const matches = parsed.experiments.filter((raw) => isRecord(raw) && raw.id === 'retrieval-reranker-v1');
  const expected = {
    id: 'retrieval-reranker-v1', owner: 'retrieval-engine', flag: 'MEMBERRY_RERANKER_V1',
    defaultEnabled: false, control: 'memberry-live-mcp',
    rollback: 'Set MEMBERRY_RERANKER_V1=disabled or unset it, then restart. Local reranking is non-persistent; shadow observations remain content-free.',
  };
  if (matches.length !== 1 || JSON.stringify(matches[0]) !== JSON.stringify(expected)) throw new Error('registry');
}

function reportProbePairs(report: any): Array<{ scenarioId: string; probeId: string; controlCoverage: number; controlTokens: number; candidateCoverage: number; candidateTokens: number }> {
  const candidate = new Map<string, any>();
  for (const scenario of report.candidate.scenarioReports) for (const probe of scenario.probes) {
    candidate.set(`${scenario.scenarioId}\0${probe.probeId}`, probe);
  }
  return report.control.scenarioReports.flatMap((scenario: any) => scenario.probes.map((probe: any) => {
    const paired = candidate.get(`${scenario.scenarioId}\0${probe.probeId}`);
    if (!paired) throw new Error('metric');
    return {
      scenarioId: scenario.scenarioId, probeId: probe.probeId,
      controlCoverage: probe.metrics.answerCoverage, controlTokens: probe.contextTokens ?? 0,
      candidateCoverage: paired.metrics.answerCoverage, candidateTokens: paired.contextTokens ?? 0,
    };
  }));
}

function qualifyingCount(report: any): number {
  const candidates = new Map<string, readonly string[]>();
  for (const scenario of report.candidate.scenarioReports) for (const probe of scenario.probes) {
    candidates.set(`${scenario.scenarioId}\0${probe.probeId}`, probe.resultIds);
  }
  const controls: (readonly string[])[] = [];
  const pairedCandidates: (readonly string[])[] = [];
  for (const scenario of report.control.scenarioReports) for (const probe of scenario.probes) {
    const candidate = candidates.get(`${scenario.scenarioId}\0${probe.probeId}`);
    if (!candidate) throw new Error('metric');
    controls.push(probe.resultIds as readonly string[]);
    pairedCandidates.push(candidate);
  }
  return qualifyingConjunctionCount(controls, pairedCandidates);
}

export function qualifyingConjunctionCount(
  controls: readonly (readonly string[])[],
  candidates: readonly (readonly string[])[],
): number {
  if (controls.length !== candidates.length) throw new Error('metric');
  let count = 0;
  for (let index = 0; index < controls.length; index += 1) {
    const control = controls[index]!;
    const candidate = candidates[index]!;
    if (new Set(control).size !== control.length || new Set(candidate).size !== candidate.length) throw new Error('metric');
    const candidatePosition = new Map(candidate.map((id, position) => [id, position]));
    const shared = control.filter((id) => candidatePosition.has(id));
    let orderChanged = false;
    for (let left = 0; left < shared.length && !orderChanged; left += 1) {
      for (let right = left + 1; right < shared.length; right += 1) {
        if (candidatePosition.get(shared[left]!)! > candidatePosition.get(shared[right]!)!) {
          orderChanged = true;
          break;
        }
      }
    }
    const controlSet = new Set(control);
    const candidateSet = new Set(candidate);
    const selectionChanged = control.length !== candidate.length
      || candidate.some((id) => !controlSet.has(id)) || control.some((id) => !candidateSet.has(id));
    if (orderChanged && selectionChanged) count += 1;
  }
  return count;
}

function laneRecord(lane: 'recall-at-10' | 'precision-at-5', report: any, count: number): JsonRecord {
  const metric = (name: string): number => normalizeNumber(report.candidate.metrics[name]);
  const arm = (value: any): JsonRecord => ({
    recallAtK: normalizeNumber(value.metrics.recallAtK),
    precisionAtK: normalizeNumber(value.metrics.precisionAtK),
    staleLeakRate: normalizeNumber(value.metrics.staleLeakRate),
    isolationLeakRate: normalizeNumber(value.metrics.isolationLeakRate),
    duplicateRate: normalizeNumber(value.metrics.duplicateRate),
    unknownResultRate: normalizeNumber(value.metrics.unknownResultRate),
  });
  return {
    schemaVersion: '1', lane, datasetId: DATASET_ID, split: 'dev',
    controlAdapterId: CONTROL_ID, candidateAdapterId: CANDIDATE_ID,
    scenarioCount: 10, probeCount: 10, k: lane === 'recall-at-10' ? 10 : 5,
    control: arm(report.control), candidate: arm(report.candidate),
    delta: {
      recallAtK: normalizeNumber(metric('recallAtK') - report.control.metrics.recallAtK),
      precisionAtK: normalizeNumber(metric('precisionAtK') - report.control.metrics.precisionAtK),
    },
    qualifyingCaseCount: count, passed: true,
  };
}

function policyShape(value: unknown): any {
  const expected = {
    schemaVersion: 1, controlAdapterId: CONTROL_ID, candidateAdapterId: CANDIDATE_ID,
    dataset: { id: DATASET_ID, split: 'dev' },
    lanes: {
      recall: { dimension: 'recall', probes: 10, k: 10, minimumDelta: 0 },
      precision: { dimension: 'precision', probes: 10, k: 5, minimumDelta: 0.05 },
    },
    safety: {
      maxStaleLeakRate: 0, maxIsolationLeakRate: 0, maxDuplicateRate: 0, maxUnknownResultRate: 0,
    },
    pairedVectorOrder: ['recall', 'precision'],
    withinLaneSortKeys: ['scenarioId', 'probeId'],
    efficiency: {
      outcome: 'measured', method: 'paired-bootstrap', confidenceLevel: 0.95,
      minimumPointDeltaExclusive: 0, minimumOneSided95LowerBound: 0,
      resamples: 2000, minimumPairedProbes: 10, seedRule: 'vector-derived',
    },
  };
  if (!isRecord(value) || JSON.stringify(value) !== JSON.stringify(expected)) throw new Error('metric');
  return value;
}

function assertQualityPolicy(policy: any, recall: JsonRecord, precision: JsonRecord, interval: any): void {
  const rd = (recall.delta as JsonRecord).recallAtK as number;
  const pd = (precision.delta as JsonRecord).precisionAtK as number;
  if (rd < policy.lanes.recall.minimumDelta || pd < policy.lanes.precision.minimumDelta) throw new Error('metric');
  if (interval.outcome !== policy.efficiency.outcome || interval.pairedProbes !== 20
    || interval.resamples !== policy.efficiency.resamples || interval.level !== policy.efficiency.confidenceLevel
    || !(interval.point > policy.efficiency.minimumPointDeltaExclusive)
    || interval.oneSidedLower < policy.efficiency.minimumOneSided95LowerBound) throw new Error('metric');
}

function assertSafetyPolicy(policy: any, recall: JsonRecord, precision: JsonRecord): void {
  for (const lane of [recall, precision]) {
    const candidate = lane.candidate as JsonRecord;
    if ((candidate.staleLeakRate as number) > policy.safety.maxStaleLeakRate
      || (candidate.isolationLeakRate as number) > policy.safety.maxIsolationLeakRate
      || (candidate.duplicateRate as number) > policy.safety.maxDuplicateRate
      || (candidate.unknownResultRate as number) > policy.safety.maxUnknownResultRate) throw new Error('safety');
  }
}

function assertPolicy(policy: any, recall: JsonRecord, precision: JsonRecord, interval: any): void {
  assertQualityPolicy(policy, recall, precision, interval);
  assertSafetyPolicy(policy, recall, precision);
}

function failureContext(error: unknown, current: FailureContext): FailureContext {
  const marker = error instanceof Error ? error.message : '';
  if (marker === 'custody' || marker === 'artifact') return { failureClass: 'custody', stage: current.stage };
  if (marker === 'safety') return { failureClass: 'safety', stage: current.stage };
  if (marker === 'metric' || marker === 'response-effect') return { failureClass: 'metric', stage: current.stage };
  if (marker === 'comparison') return { failureClass: 'model', stage: current.stage };
  return current;
}

function tombstone(identity: CustodyIdentity, context: FailureContext): JsonRecord {
  return {
    schemaVersion: '1', decision: 'failed', failureClass: context.failureClass, stage: context.stage,
    gitCommit: identity.gitCommit, nodeMajor: identity.nodeMajor, nodeVersion: identity.nodeVersion,
    workflowRunId: identity.workflowRunId, workflowRunAttempt: identity.workflowRunAttempt,
  };
}

export function validateFailureTombstoneForTest(value: unknown): void {
  const item = recordValue(value);
  if (!exactKeys(item, ['schemaVersion', 'decision', 'failureClass', 'stage', 'gitCommit', 'nodeMajor', 'nodeVersion', 'workflowRunId', 'workflowRunAttempt'])
    || item.schemaVersion !== '1' || item.decision !== 'failed'
    || typeof item.failureClass !== 'string' || !['harness', 'infrastructure', 'model', 'metric', 'safety', 'custody'].includes(item.failureClass)
    || typeof item.stage !== 'string' || !['source-integrity', 'registry', 'load-dev', 'recall-comparison', 'precision-comparison', 'efficiency', 'quality-policy', 'safety-policy', 'response-effect', 'artifact'].includes(item.stage)
    || typeof item.gitCommit !== 'string' || !/^[0-9a-f]{40}$/.test(item.gitCommit) || (item.nodeMajor !== '20' && item.nodeMajor !== '22')
    || typeof item.nodeVersion !== 'string' || !new RegExp(`^v${item.nodeMajor}\\.[0-9]+\\.[0-9]+$`).test(item.nodeVersion)
    || typeof item.workflowRunId !== 'string' || !/^[1-9][0-9]*$/.test(item.workflowRunId) || !Number.isSafeInteger(item.workflowRunAttempt)
    || (item.workflowRunAttempt as number) < 1) throw new Error('artifact');
}

async function publishFailure(
  identity: CustodyIdentity,
  context: FailureContext,
  stagingLeaf = STAGING_LEAF,
): Promise<void> {
  await cleanBoundary();
  await publishBundle({ [FAILURE_FILE]: tombstone(identity, context) }, identity, stagingLeaf);
}

export interface FailureBoundaryDependencies {
  publish(): Promise<void>;
  validateCurrent(): Promise<void>;
  primaryCleanup(): Promise<void>;
  fallbackCleanup(): Promise<void>;
  proveAbsent(): Promise<void>;
}

async function ensureFailureBoundary(dependencies: FailureBoundaryDependencies): Promise<'tombstone' | 'absent'> {
  try {
    await dependencies.publish();
    await dependencies.validateCurrent();
    return 'tombstone';
  } catch (publicationError) {
    try { await dependencies.primaryCleanup(); }
    catch (cleanupError) {
      try { await dependencies.fallbackCleanup(); }
      catch (fallbackError) { throw new AggregateError([publicationError, cleanupError, fallbackError], 'custody'); }
    }
    await dependencies.proveAbsent();
    return 'absent';
  }
}

async function validateCurrentFailure(identity: CustodyIdentity, context: FailureContext): Promise<void> {
  const verified = await verifyDirectory(OUTPUT_LEAF, [FAILURE_FILE]);
  const value = parseCanonical(verified[FAILURE_FILE]!);
  validateFailureTombstoneForTest(value);
  if (!canonicalBytes(value).equals(canonicalBytes(tombstone(identity, context)))) throw new Error('custody');
  await absentPath(STAGING_LEAF);
  await absentPath(FINALIZER_STAGING_LEAF);
}

async function provePublicLeavesAbsent(): Promise<void> {
  await validateRunsRoot(false);
  await absentPath(OUTPUT_LEAF);
  await absentPath(STAGING_LEAF);
  await absentPath(FINALIZER_STAGING_LEAF);
}

async function publishFailureOrProveAbsent(identity: CustodyIdentity, context: FailureContext): Promise<'tombstone' | 'absent'> {
  return ensureFailureBoundary({
    publish: async () => publishFailure(identity, context),
    validateCurrent: async () => validateCurrentFailure(identity, context),
    primaryCleanup: cleanBoundary,
    fallbackCleanup: async () => {
      await safeRemoveLeaf(OUTPUT_LEAF); await safeRemoveLeaf(STAGING_LEAF); await safeRemoveLeaf(FINALIZER_STAGING_LEAF);
    },
    proveAbsent: provePublicLeavesAbsent,
  });
}

export async function ensureFailureBoundaryForTest(dependencies: FailureBoundaryDependencies): Promise<'tombstone' | 'absent'> {
  return ensureFailureBoundary(dependencies);
}

export interface FinalizerFailureDependencies {
  cleanupPublic(): Promise<void>;
  cleanupGateStage(): Promise<void>;
  cleanupFinalizerStage(): Promise<void>;
  publishCurrentTombstone(): Promise<void>;
  verifyCurrentTombstone(): Promise<void>;
  proveAllStagingAbsent(): Promise<void>;
  proveAllAbsent(): Promise<void>;
}

async function finalizeFailureBoundary(dependencies: FinalizerFailureDependencies): Promise<void> {
  const cleanupAll = async (): Promise<unknown[]> => {
    const failures: unknown[] = [];
    for (const cleanup of [dependencies.cleanupPublic, dependencies.cleanupGateStage, dependencies.cleanupFinalizerStage]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    return failures;
  };
  const initialCleanupFailures = await cleanupAll();
  if (initialCleanupFailures.length > 0) {
    try { await dependencies.proveAllAbsent(); }
    catch (absenceError) { initialCleanupFailures.push(absenceError); }
    throw new AggregateError(initialCleanupFailures, 'custody');
  }
  try {
    await dependencies.publishCurrentTombstone();
    await dependencies.verifyCurrentTombstone();
    await dependencies.proveAllStagingAbsent();
  } catch (primaryError) {
    const failures = [primaryError, ...await cleanupAll()];
    try { await dependencies.proveAllAbsent(); } catch (absenceError) { failures.push(absenceError); }
    throw new AggregateError(failures, 'custody');
  }
}

export async function finalizeFailureBoundaryForTest(dependencies: FinalizerFailureDependencies): Promise<void> {
  await finalizeFailureBoundary(dependencies);
}

async function finalizeCurrentFailure(identity: CustodyIdentity, context: FailureContext): Promise<void> {
  await validateRunsRoot(true);
  await finalizeFailureBoundary({
    cleanupPublic: async () => safeRemoveLeaf(OUTPUT_LEAF),
    cleanupGateStage: async () => safeRemoveLeaf(STAGING_LEAF),
    cleanupFinalizerStage: async () => safeRemoveLeaf(FINALIZER_STAGING_LEAF),
    publishCurrentTombstone: async () => {
      await publishBundle({ [FAILURE_FILE]: tombstone(identity, context) }, identity, FINALIZER_STAGING_LEAF);
    },
    verifyCurrentTombstone: async () => validateCurrentFailure(identity, context),
    proveAllStagingAbsent: async () => { await absentPath(STAGING_LEAF); await absentPath(FINALIZER_STAGING_LEAF); },
    proveAllAbsent: provePublicLeavesAbsent,
  });
}

export interface DevelopmentRunHooks {
  beforeStage?(context: FailureContext): Promise<void>;
  onFailure?(context: FailureContext): Promise<void>;
  onSuppressedOutput?(stdout: string, stderr: string): Promise<void>;
  beforeOperation?(operation: 'dataset' | 'provider' | 'blobs' | 'aggregate' | 'publication', context: FailureContext): Promise<void>;
  suppressProcessFailure?: boolean;
}

export async function runDevelopment(hooks: DevelopmentRunHooks = {}): Promise<'passed' | 'failed'> {
  let identity: CustodyIdentity | undefined;
  let context: FailureContext = { failureClass: 'custody', stage: 'source-integrity' };
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  let suppressedStdout = '';
  let suppressedStderr = '';
  let outputRestored = false;
  const restoreOutput = (): void => {
    if (outputRestored) return;
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    outputRestored = true;
  };
  process.stdout.write = ((chunk: unknown) => { suppressedStdout += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { suppressedStderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk); return true; }) as typeof process.stderr.write;
  const enter = async (next: FailureContext): Promise<void> => {
    context = next;
    await hooks.beforeStage?.(context);
  };
  try {
    identity = environmentIdentity();
    await cleanBoundary();
    await enter(context);
    const head = await assertSourceIntegrity(identity.gitCommit);
    await enter({ failureClass: 'custody', stage: 'registry' });
    await assertDevelopmentBindingSource(head);
    assertExperimentRegistry(head);
    await enter({ failureClass: 'harness', stage: 'load-dev' });
    const [{ loadRet010DevScenarios }, { compareRegisteredAdapters }, statsModule, servedModule] = await Promise.all([
      import('./load-dev.js'), import('../registered-adapters.js'), import('../stats.js'),
      import('../../../packages/retrieval/src/served-reranker.js'),
    ]);
    const scenarios = await loadRet010DevScenarios(REPO_ROOT);
    if (scenarios.length !== 20) throw new Error('metric');
    const basePolicy = {
      minRecallAtK: 0, minPrecisionAtK: 0, minAnswerCoverage: 0,
      maxStaleLeakRate: 0, maxIsolationLeakRate: 0, maxDuplicateRate: 0, maxUnknownResultRate: 0,
      maxQualityRegression: 1,
    };
    await enter({ failureClass: 'model', stage: 'recall-comparison' });
    const recallReport = await compareRegisteredAdapters({
      runId: 'ret010-development-recall', controlId: CONTROL_ID, candidateId: CANDIDATE_ID,
      scenarios: scenarios.slice(0, 10), splits: ['dev'], policy: basePolicy, repoRoot: REPO_ROOT,
    });
    await enter({ failureClass: 'model', stage: 'precision-comparison' });
    const precisionReport = await compareRegisteredAdapters({
      runId: 'ret010-development-precision', controlId: CONTROL_ID, candidateId: CANDIDATE_ID,
      scenarios: scenarios.slice(10), splits: ['dev'], policy: basePolicy, repoRoot: REPO_ROOT,
    });
    if (!recallReport.passed || !precisionReport.passed) throw new Error('comparison');
    await enter({ failureClass: 'metric', stage: 'response-effect' });
    const recallCount = qualifyingCount(recallReport);
    const precisionCount = qualifyingCount(precisionReport);
    const totalQualifying = recallCount + precisionCount;
    if (totalQualifying < 1 || totalQualifying > 20) throw new Error('response-effect');
    const recall = laneRecord('recall-at-10', recallReport, recallCount);
    const precision = laneRecord('precision-at-5', precisionReport, precisionCount);
    await enter({ failureClass: 'metric', stage: 'efficiency' });
    const orderPairs = (values: ReturnType<typeof reportProbePairs>) => values
      .sort((a, b) => a.scenarioId.localeCompare(b.scenarioId) || a.probeId.localeCompare(b.probeId));
    const pairs = [...orderPairs(reportProbePairs(recallReport)), ...orderPairs(reportProbePairs(precisionReport))];
    const measured = statsModule.pairedEfficiencyInterval(pairs);
    if (measured.outcome !== 'measured') throw new Error('metric');
    const interval: JsonRecord = {
      schemaVersion: '1', metric: 'task-success-per-1k-tokens', outcome: 'measured',
      pairedProbes: 20, resamples: 2000, level: 0.95, seed: measured.seed,
      point: normalizeNumber(measured.point!), lower: normalizeNumber(measured.lower!),
      upper: normalizeNumber(measured.upper!), oneSidedLower: normalizeNumber(measured.oneSidedLower!),
    };
    const policyBytes = await readFile(resolve(HERE, 'dev-policy.json'));
    const policy = policyShape(JSON.parse(policyBytes.toString('utf8')));
    await enter({ failureClass: 'metric', stage: 'quality-policy' });
    assertQualityPolicy(policy, recall, precision, interval);
    await enter({ failureClass: 'safety', stage: 'safety-policy' });
    assertSafetyPolicy(policy, recall, precision);
    await enter({ failureClass: 'custody', stage: 'artifact' });
    const recallBytes = canonicalBytes(recall);
    const precisionBytes = canonicalBytes(precision);
    const intervalBytes = canonicalBytes(interval);
    await hooks.beforeOperation?.('dataset', context);
    const dataset = validateFrozenDatasetAt(head);
    await hooks.beforeOperation?.('provider', context);
    const providerIdentity = servedModule.SERVED_RERANKER_PROVIDER_IDENTITY;
    await hooks.beforeOperation?.('blobs', context);
    const modelBlob = await gitBlob('packages/retrieval/src/served-reranker.ts');
    const providerContractBlob = await gitBlob('packages/retrieval/src/reranker.ts');
    const adapterBlob = await gitBlob('bench/lab/adapters/memberry-retrieval-core.ts');
    await hooks.beforeOperation?.('aggregate', context);
    const aggregate: JsonRecord = {
      schemaVersion: '1', decision: 'passed', datasetId: DATASET_ID, split: 'dev',
      controlAdapterId: CONTROL_ID, candidateAdapterId: CANDIDATE_ID,
      providerIdentity: {
        providerId: providerIdentity.providerId, modelId: providerIdentity.modelId,
        calibrationId: providerIdentity.calibrationId, locality: providerIdentity.locality,
      },
      sourceCommit: head,
      modelBlob, providerContractBlob, adapterBlob,
      datasetDescriptorSha256: dataset.descriptorSha256,
      inputSha256: dataset.inputSha256,
      oracleSha256: dataset.oracleSha256,
      devPolicySha256: sha256(policyBytes), recallLaneSha256: sha256(recallBytes),
      precisionLaneSha256: sha256(precisionBytes), efficiencyIntervalSha256: sha256(intervalBytes),
      seed: measured.seed,
      quality: {
        recallDelta: (recall.delta as JsonRecord).recallAtK,
        precisionDelta: (precision.delta as JsonRecord).precisionAtK,
        efficiencyPoint: interval.point, efficiencyOneSidedLower: interval.oneSidedLower,
      },
      safety: {
        staleLeakRate: 0, isolationLeakRate: 0, duplicateRate: 0, unknownResultRate: 0,
      },
      responseEffect: { sameCaseOrderAndSelectionChanged: true, qualifyingCaseCount: totalQualifying },
      passed: true,
    };
    const aggregateBytes = canonicalBytes(aggregate);
    const manifest: JsonRecord = {
      schemaVersion: '1', decision: 'passed', gitCommit: identity.gitCommit,
      nodeMajor: identity.nodeMajor, nodeVersion: identity.nodeVersion,
      workflowRunId: identity.workflowRunId, workflowRunAttempt: identity.workflowRunAttempt,
      recallLaneSha256: sha256(recallBytes), precisionLaneSha256: sha256(precisionBytes),
      efficiencyIntervalSha256: sha256(intervalBytes), aggregateResultSha256: sha256(aggregateBytes),
    };
    await hooks.beforeOperation?.('publication', context);
    await assertSourceIntegrity(head);
    await publishBundle({
      'recall-lane.json': recall, 'precision-lane.json': precision,
      'efficiency-interval.json': interval, 'aggregate-result.json': aggregate,
      'custody-manifest.json': manifest,
    }, identity);
    restoreOutput();
    await hooks.onSuppressedOutput?.(suppressedStdout, suppressedStderr);
    return 'passed';
  } catch (error) {
    context = failureContext(error, context);
    let boundaryError: unknown;
    try {
      if (identity !== undefined) await publishFailureOrProveAbsent(identity, context);
      else { await cleanBoundary(); await provePublicLeavesAbsent(); }
    } catch (failure) { boundaryError = failure; }
    try { await hooks.onFailure?.(context); } finally { restoreOutput(); }
    await hooks.onSuppressedOutput?.(suppressedStdout, suppressedStderr);
    if (!hooks.suppressProcessFailure) {
      process.stderr.write(SAFE_FAILURE);
      process.exitCode = 1;
    }
    if (boundaryError !== undefined && hooks.suppressProcessFailure) throw boundaryError;
    return 'failed';
  }
}

function parseCanonical(bytes: Buffer): JsonRecord {
  const value = JSON.parse(bytes.toString('utf8')) as unknown;
  if (!isRecord(value) || !bytes.equals(canonicalBytes(value))) throw new Error('artifact');
  return value;
}

function validateLane(record: JsonRecord, lane: 'recall-at-10' | 'precision-at-5'): void {
  const keys = ['schemaVersion', 'lane', 'datasetId', 'split', 'controlAdapterId', 'candidateAdapterId', 'scenarioCount', 'probeCount', 'k', 'control', 'candidate', 'delta', 'qualifyingCaseCount', 'passed'];
  if (!exactKeys(record, keys) || record.schemaVersion !== '1' || record.lane !== lane
    || record.datasetId !== DATASET_ID || record.split !== 'dev' || record.controlAdapterId !== CONTROL_ID
    || record.candidateAdapterId !== CANDIDATE_ID || record.scenarioCount !== 10 || record.probeCount !== 10
    || record.k !== (lane === 'recall-at-10' ? 10 : 5) || record.passed !== true
    || !Number.isInteger(record.qualifyingCaseCount) || (record.qualifyingCaseCount as number) < 0
    || (record.qualifyingCaseCount as number) > 10) throw new Error('artifact');
  for (const armName of ['control', 'candidate']) {
    const arm = record[armName];
    const armKeys = ['recallAtK', 'precisionAtK', 'staleLeakRate', 'isolationLeakRate', 'duplicateRate', 'unknownResultRate'];
    if (!isRecord(arm) || !exactKeys(arm, armKeys) || armKeys.some((key) => !finite(arm[key], 0, 1))) throw new Error('artifact');
  }
  const delta = record.delta;
  if (!isRecord(delta) || !exactKeys(delta, ['recallAtK', 'precisionAtK'])
    || !finite(delta.recallAtK, -1, 1) || !finite(delta.precisionAtK, -1, 1)) throw new Error('artifact');
}

function validateInterval(record: JsonRecord): void {
  const keys = ['schemaVersion', 'metric', 'outcome', 'pairedProbes', 'resamples', 'level', 'seed', 'point', 'lower', 'upper', 'oneSidedLower'];
  if (!exactKeys(record, keys) || record.schemaVersion !== '1' || record.metric !== 'task-success-per-1k-tokens'
    || record.outcome !== 'measured' || record.pairedProbes !== 20 || record.resamples !== 2000 || record.level !== 0.95
    || !Number.isInteger(record.seed) || (record.seed as number) < 0 || (record.seed as number) > 0xffffffff
    || ['point', 'lower', 'upper', 'oneSidedLower'].some((key) => !finite(record[key], -Number.MAX_VALUE, Number.MAX_VALUE))) throw new Error('artifact');
}

function validateAggregate(record: JsonRecord): void {
  const keys = [
    'schemaVersion', 'decision', 'datasetId', 'split', 'controlAdapterId', 'candidateAdapterId',
    'providerIdentity', 'sourceCommit', 'modelBlob', 'providerContractBlob', 'adapterBlob',
    'datasetDescriptorSha256', 'inputSha256', 'oracleSha256', 'devPolicySha256',
    'recallLaneSha256', 'precisionLaneSha256', 'efficiencyIntervalSha256', 'seed',
    'quality', 'safety', 'responseEffect', 'passed',
  ];
  if (!exactKeys(record, keys) || record.schemaVersion !== '1' || record.decision !== 'passed'
    || record.datasetId !== DATASET_ID || record.split !== 'dev' || record.controlAdapterId !== CONTROL_ID
    || record.candidateAdapterId !== CANDIDATE_ID || record.passed !== true
    || !/^[0-9a-f]{40}$/.test(String(record.sourceCommit))
    || ['modelBlob', 'providerContractBlob', 'adapterBlob'].some((key) => !/^[0-9a-f]{40}$/.test(String(record[key])))
    || ['datasetDescriptorSha256', 'inputSha256', 'oracleSha256', 'devPolicySha256', 'recallLaneSha256', 'precisionLaneSha256', 'efficiencyIntervalSha256']
      .some((key) => !/^[0-9a-f]{64}$/.test(String(record[key])))
    || !Number.isInteger(record.seed) || (record.seed as number) < 0 || (record.seed as number) > 0xffffffff) throw new Error('artifact');
  const provider = record.providerIdentity;
  if (!isRecord(provider) || !exactKeys(provider, ['providerId', 'modelId', 'calibrationId', 'locality'])
    || provider.providerId !== 'memberry.local.lexical' || provider.modelId !== 'bm25f-query-v1'
    || provider.calibrationId !== 'fixed-blend-v1' || provider.locality !== 'local') throw new Error('artifact');
  const quality = record.quality;
  if (!isRecord(quality) || !exactKeys(quality, ['recallDelta', 'precisionDelta', 'efficiencyPoint', 'efficiencyOneSidedLower'])
    || Object.values(quality).some((value) => !finite(value, -Number.MAX_VALUE, Number.MAX_VALUE))) throw new Error('artifact');
  const safety = record.safety;
  if (!isRecord(safety) || !exactKeys(safety, ['staleLeakRate', 'isolationLeakRate', 'duplicateRate', 'unknownResultRate'])
    || Object.values(safety).some((value) => value !== 0)) throw new Error('artifact');
  const response = record.responseEffect;
  if (!isRecord(response) || !exactKeys(response, ['sameCaseOrderAndSelectionChanged', 'qualifyingCaseCount'])
    || response.sameCaseOrderAndSelectionChanged !== true || !Number.isInteger(response.qualifyingCaseCount)
    || (response.qualifyingCaseCount as number) < 1 || (response.qualifyingCaseCount as number) > 20) throw new Error('artifact');
}

async function readSuccessBundle(root: string): Promise<{ records: Record<string, JsonRecord>; bytes: Record<string, Buffer> }> {
  const verified = await verifyDirectory(root, [...SUCCESS_FILES]);
  const records: Record<string, JsonRecord> = {};
  const bytes: Record<string, Buffer> = {};
  for (const name of SUCCESS_FILES) {
    bytes[name] = verified[name]!;
    records[name] = parseCanonical(bytes[name]!);
  }
  validateLane(records['recall-lane.json']!, 'recall-at-10');
  validateLane(records['precision-lane.json']!, 'precision-at-5');
  validateInterval(records['efficiency-interval.json']!);
  validateAggregate(records['aggregate-result.json']!);
  return { records, bytes };
}

async function validateSuccessBundle(root: string, identity?: CustodyIdentity): Promise<{ records: Record<string, JsonRecord>; bytes: Record<string, Buffer> }> {
  const bundle = await readSuccessBundle(root);
  const recall = bundle.records['recall-lane.json']!;
  const precision = bundle.records['precision-lane.json']!;
  const interval = bundle.records['efficiency-interval.json']!;
  const aggregate = bundle.records['aggregate-result.json']!;
  const manifest = bundle.records['custody-manifest.json']!;
  const manifestKeys = ['schemaVersion', 'decision', 'gitCommit', 'nodeMajor', 'nodeVersion', 'workflowRunId', 'workflowRunAttempt', 'recallLaneSha256', 'precisionLaneSha256', 'efficiencyIntervalSha256', 'aggregateResultSha256'];
  const recallControl = recall.control as JsonRecord; const recallCandidate = recall.candidate as JsonRecord;
  const precisionControl = precision.control as JsonRecord; const precisionCandidate = precision.candidate as JsonRecord;
  const recallDelta = recall.delta as JsonRecord; const precisionDelta = precision.delta as JsonRecord;
  const qualifying = (recall.qualifyingCaseCount as number) + (precision.qualifyingCaseCount as number);
  if (recallDelta.recallAtK !== (recallCandidate.recallAtK as number) - (recallControl.recallAtK as number)
    || recallDelta.precisionAtK !== (recallCandidate.precisionAtK as number) - (recallControl.precisionAtK as number)
    || precisionDelta.recallAtK !== (precisionCandidate.recallAtK as number) - (precisionControl.recallAtK as number)
    || precisionDelta.precisionAtK !== (precisionCandidate.precisionAtK as number) - (precisionControl.precisionAtK as number)
    || (recallDelta.recallAtK as number) < 0 || (precisionDelta.precisionAtK as number) < 0.05
    || (interval.point as number) <= 0 || (interval.oneSidedLower as number) < 0
    || qualifying < 1 || qualifying > 20
    || (aggregate.responseEffect as JsonRecord).qualifyingCaseCount !== qualifying
    || Object.values(recallCandidate).slice(2).some((value) => value !== 0)
    || Object.values(precisionCandidate).slice(2).some((value) => value !== 0)) throw new Error('artifact');
  if (!exactKeys(manifest, manifestKeys) || manifest.schemaVersion !== '1' || manifest.decision !== 'passed'
    || manifest.gitCommit !== aggregate.sourceCommit
    || manifest.recallLaneSha256 !== sha256(bundle.bytes['recall-lane.json']!)
    || manifest.precisionLaneSha256 !== sha256(bundle.bytes['precision-lane.json']!)
    || manifest.efficiencyIntervalSha256 !== sha256(bundle.bytes['efficiency-interval.json']!)
    || manifest.aggregateResultSha256 !== sha256(bundle.bytes['aggregate-result.json']!)
    || aggregate.recallLaneSha256 !== manifest.recallLaneSha256
    || aggregate.precisionLaneSha256 !== manifest.precisionLaneSha256
    || aggregate.efficiencyIntervalSha256 !== manifest.efficiencyIntervalSha256
    || aggregate.seed !== interval.seed
    || (aggregate.quality as JsonRecord).recallDelta !== (recall.delta as JsonRecord).recallAtK
    || (aggregate.quality as JsonRecord).precisionDelta !== (precision.delta as JsonRecord).precisionAtK
    || (aggregate.quality as JsonRecord).efficiencyPoint !== interval.point
    || (aggregate.quality as JsonRecord).efficiencyOneSidedLower !== interval.oneSidedLower
    || (manifest.nodeMajor !== '20' && manifest.nodeMajor !== '22')
    || !/^[0-9]+$/.test(String(manifest.workflowRunId))
    || !Number.isSafeInteger(manifest.workflowRunAttempt) || (manifest.workflowRunAttempt as number) < 1
    || !new RegExp(`^v${manifest.nodeMajor}\\.[0-9]+\\.[0-9]+$`).test(String(manifest.nodeVersion))) throw new Error('artifact');
  if (identity && (manifest.gitCommit !== identity.gitCommit || manifest.nodeMajor !== identity.nodeMajor
    || manifest.nodeVersion !== identity.nodeVersion || manifest.workflowRunId !== identity.workflowRunId
    || manifest.workflowRunAttempt !== identity.workflowRunAttempt)) throw new Error('custody');
  return bundle;
}

async function validateCurrentHeadSuccessBundle(root: string, identity: CustodyIdentity): Promise<void> {
  const bundle = await validateSuccessBundle(root, identity);
  const aggregate = bundle.records['aggregate-result.json']!;
  const dataset = validateFrozenDatasetAt(identity.gitCommit);
  if (aggregate.sourceCommit !== identity.gitCommit
    || aggregate.modelBlob !== gitBlobAt(identity.gitCommit, 'packages/retrieval/src/served-reranker.ts')
    || aggregate.providerContractBlob !== gitBlobAt(identity.gitCommit, 'packages/retrieval/src/reranker.ts')
    || aggregate.adapterBlob !== gitBlobAt(identity.gitCommit, 'bench/lab/adapters/memberry-retrieval-core.ts')
    || aggregate.datasetDescriptorSha256 !== dataset.descriptorSha256
    || aggregate.inputSha256 !== dataset.inputSha256
    || aggregate.oracleSha256 !== dataset.oracleSha256
    || aggregate.devPolicySha256 !== sha256(gitBytesAt(identity.gitCommit, 'bench/lab/ret010/dev-policy.json'))) throw new Error('custody');
}

export async function validateSuccessBundleForTest(root: string): Promise<void> {
  await validateSuccessBundle(resolve(root));
}

async function validateBundlePair(node20Root: string, node22Root: string) {
  const bundles = await Promise.all([validateSuccessBundle(resolve(node20Root)), validateSuccessBundle(resolve(node22Root))]);
  const manifests = bundles.map((bundle) => bundle.records['custody-manifest.json']!);
  if (new Set(manifests.map((manifest) => manifest.nodeMajor)).size !== 2
    || !manifests.some((manifest) => manifest.nodeMajor === '20') || !manifests.some((manifest) => manifest.nodeMajor === '22')
    || !bundles[0]!.bytes['aggregate-result.json']!.equals(bundles[1]!.bytes['aggregate-result.json']!)
    || manifests[0]!.gitCommit !== manifests[1]!.gitCommit
    || manifests[0]!.workflowRunId !== manifests[1]!.workflowRunId
    || manifests[0]!.workflowRunAttempt !== manifests[1]!.workflowRunAttempt) throw new Error('artifact');
  return { bundles, manifests };
}

export async function validateBundlePairForTest(node20Root: string, node22Root: string): Promise<void> {
  await validateBundlePair(resolve(node20Root), resolve(node22Root));
}

interface HostedMetadata {
  schemaVersion: '1';
  repository: 'AP3X-Dev/memberry';
  headSha: string;
  runId: string;
  runAttempt: number;
  workflowConclusion: 'success';
  jobs: Array<{ nodeMajor: '20' | '22'; conclusion: 'success'; artifactName: string }>;
}

function hostedMetadata(value: unknown): HostedMetadata {
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'repository', 'headSha', 'runId', 'runAttempt', 'workflowConclusion', 'jobs'])
    || value.schemaVersion !== '1' || value.repository !== 'AP3X-Dev/memberry'
    || !/^[0-9a-f]{40}$/.test(String(value.headSha)) || !/^[0-9]+$/.test(String(value.runId))
    || !Number.isSafeInteger(value.runAttempt) || (value.runAttempt as number) < 1
    || value.workflowConclusion !== 'success' || !Array.isArray(value.jobs) || value.jobs.length !== 2) throw new Error('artifact');
  const jobs = value.jobs.map((raw) => {
    if (!isRecord(raw) || !exactKeys(raw, ['nodeMajor', 'conclusion', 'artifactName'])
      || (raw.nodeMajor !== '20' && raw.nodeMajor !== '22') || raw.conclusion !== 'success'
      || typeof raw.artifactName !== 'string') throw new Error('artifact');
    return raw;
  });
  if (new Set(jobs.map((job) => job.nodeMajor)).size !== 2) throw new Error('artifact');
  return value as unknown as HostedMetadata;
}

export function validateHostedMetadataForTest(value: unknown): void {
  hostedMetadata(value);
}

async function recomputeDevelopmentRecords(sourceCommit: string): Promise<{
  recall: JsonRecord; precision: JsonRecord; interval: JsonRecord;
}> {
  await assertSourceIntegrity(sourceCommit);
  const [{ loadRet010DevScenarios }, { compareRegisteredAdapters }, statsModule] = await Promise.all([
    import('./load-dev.js'), import('../registered-adapters.js'), import('../stats.js'),
  ]);
  const scenarios = await loadRet010DevScenarios(REPO_ROOT);
  if (scenarios.length !== 20) throw new Error('artifact');
  const basePolicy = {
    minRecallAtK: 0, minPrecisionAtK: 0, minAnswerCoverage: 0,
    maxStaleLeakRate: 0, maxIsolationLeakRate: 0, maxDuplicateRate: 0, maxUnknownResultRate: 0,
    maxQualityRegression: 1,
  };
  const recallReport = await compareRegisteredAdapters({
    runId: 'ret010-development-recall', controlId: CONTROL_ID, candidateId: CANDIDATE_ID,
    scenarios: scenarios.slice(0, 10), splits: ['dev'], policy: basePolicy, repoRoot: REPO_ROOT,
  });
  const precisionReport = await compareRegisteredAdapters({
    runId: 'ret010-development-precision', controlId: CONTROL_ID, candidateId: CANDIDATE_ID,
    scenarios: scenarios.slice(10), splits: ['dev'], policy: basePolicy, repoRoot: REPO_ROOT,
  });
  if (!recallReport.passed || !precisionReport.passed) throw new Error('artifact');
  const recall = laneRecord('recall-at-10', recallReport, qualifyingCount(recallReport));
  const precision = laneRecord('precision-at-5', precisionReport, qualifyingCount(precisionReport));
  const orderPairs = (values: ReturnType<typeof reportProbePairs>) => values
    .sort((a, b) => a.scenarioId.localeCompare(b.scenarioId) || a.probeId.localeCompare(b.probeId));
  const pairs = [...orderPairs(reportProbePairs(recallReport)), ...orderPairs(reportProbePairs(precisionReport))];
  const measured = statsModule.pairedEfficiencyInterval(pairs);
  if (measured.outcome !== 'measured' || measured.pairedProbes !== 20 || measured.resamples !== 2000
    || measured.level !== 0.95 || measured.seed !== statsModule.pairedVectorSeed(pairs)) throw new Error('artifact');
  const interval: JsonRecord = {
    schemaVersion: '1', metric: 'task-success-per-1k-tokens', outcome: 'measured', pairedProbes: 20,
    resamples: 2000, level: 0.95, seed: measured.seed, point: normalizeNumber(measured.point!),
    lower: normalizeNumber(measured.lower!), upper: normalizeNumber(measured.upper!),
    oneSidedLower: normalizeNumber(measured.oneSidedLower!),
  };
  const policy = policyShape(JSON.parse(gitBytesAt(sourceCommit, 'bench/lab/ret010/dev-policy.json').toString('utf8')));
  assertPolicy(policy, recall, precision, interval);
  return { recall, precision, interval };
}

export async function verifyDevelopmentBundles(
  node20Root: string,
  node22Root: string,
  metadataPath: string,
): Promise<JsonRecord> {
  const pair = await validateBundlePair(node20Root, node22Root);
  const { bundles, manifests } = pair;
  const metadata = hostedMetadata(JSON.parse(await readFile(resolve(metadataPath), 'utf8')));
  const aggregateBytes = bundles[0]!.bytes['aggregate-result.json']!;
  const aggregate = bundles[0]!.records['aggregate-result.json']!;
  const recall = bundles[0]!.records['recall-lane.json']!;
  const precision = bundles[0]!.records['precision-lane.json']!;
  const interval = bundles[0]!.records['efficiency-interval.json']!;
  const recomputed = await recomputeDevelopmentRecords(String(aggregate.sourceCommit));
  if (!canonicalBytes(recomputed.recall).equals(bundles[0]!.bytes['recall-lane.json']!)
    || !canonicalBytes(recomputed.precision).equals(bundles[0]!.bytes['precision-lane.json']!)
    || !canonicalBytes(recomputed.interval).equals(bundles[0]!.bytes['efficiency-interval.json']!)) throw new Error('artifact');
  const count = (recall.qualifyingCaseCount as number) + (precision.qualifyingCaseCount as number);
  const response = aggregate.responseEffect;
  if (!isRecord(response) || !exactKeys(response, ['sameCaseOrderAndSelectionChanged', 'qualifyingCaseCount'])
    || response.sameCaseOrderAndSelectionChanged !== true || response.qualifyingCaseCount !== count || count < 1 || count > 20) throw new Error('artifact');
  const policy = policyShape(JSON.parse(await readFile(resolve(HERE, 'dev-policy.json'), 'utf8')));
  assertPolicy(policy, recall, precision, interval);
  if (aggregate.recallLaneSha256 !== sha256(bundles[0]!.bytes['recall-lane.json']!)
    || aggregate.precisionLaneSha256 !== sha256(bundles[0]!.bytes['precision-lane.json']!)
    || aggregate.efficiencyIntervalSha256 !== sha256(bundles[0]!.bytes['efficiency-interval.json']!)
    || aggregate.recallLaneSha256 !== sha256(bundles[1]!.bytes['recall-lane.json']!)
    || aggregate.precisionLaneSha256 !== sha256(bundles[1]!.bytes['precision-lane.json']!)
    || aggregate.efficiencyIntervalSha256 !== sha256(bundles[1]!.bytes['efficiency-interval.json']!)
    || aggregate.seed !== interval.seed
    || (aggregate.quality as JsonRecord).recallDelta !== (recall.delta as JsonRecord).recallAtK
    || (aggregate.quality as JsonRecord).precisionDelta !== (precision.delta as JsonRecord).precisionAtK
    || (aggregate.quality as JsonRecord).efficiencyPoint !== interval.point
    || (aggregate.quality as JsonRecord).efficiencyOneSidedLower !== interval.oneSidedLower) throw new Error('artifact');
  const sourceCommit = String(aggregate.sourceCommit);
  if (aggregate.modelBlob !== gitBlobAt(sourceCommit, 'packages/retrieval/src/served-reranker.ts')
    || aggregate.providerContractBlob !== gitBlobAt(sourceCommit, 'packages/retrieval/src/reranker.ts')
    || aggregate.adapterBlob !== gitBlobAt(sourceCommit, 'bench/lab/adapters/memberry-retrieval-core.ts')) throw new Error('artifact');
  const dataset = validateFrozenDatasetAt(sourceCommit);
  if (aggregate.datasetDescriptorSha256 !== dataset.descriptorSha256
    || aggregate.inputSha256 !== dataset.inputSha256
    || aggregate.oracleSha256 !== dataset.oracleSha256
    || aggregate.devPolicySha256 !== sha256(gitBytesAt(sourceCommit, 'bench/lab/ret010/dev-policy.json'))) throw new Error('artifact');
  const aggregateDigest = sha256(aggregateBytes);
  for (const [index, bundle] of bundles.entries()) {
    const manifest = manifests[index]!;
    const expectedKeys = ['schemaVersion', 'decision', 'gitCommit', 'nodeMajor', 'nodeVersion', 'workflowRunId', 'workflowRunAttempt', 'recallLaneSha256', 'precisionLaneSha256', 'efficiencyIntervalSha256', 'aggregateResultSha256'];
    if (!exactKeys(manifest, expectedKeys) || manifest.schemaVersion !== '1' || manifest.decision !== 'passed'
      || manifest.gitCommit !== aggregate.sourceCommit || manifest.aggregateResultSha256 !== aggregateDigest
      || manifest.recallLaneSha256 !== sha256(bundle.bytes['recall-lane.json']!)
      || manifest.precisionLaneSha256 !== sha256(bundle.bytes['precision-lane.json']!)
      || manifest.efficiencyIntervalSha256 !== sha256(bundle.bytes['efficiency-interval.json']!)
      || !new RegExp(`^v${manifest.nodeMajor}\\.[0-9]+\\.[0-9]+$`).test(String(manifest.nodeVersion))) throw new Error('artifact');
  }
  if (metadata.headSha !== aggregate.sourceCommit || metadata.runId !== manifests[0]!.workflowRunId
    || metadata.runAttempt !== manifests[0]!.workflowRunAttempt) throw new Error('artifact');
  for (const manifest of manifests) {
    const job = metadata.jobs.find((entry) => entry.nodeMajor === manifest.nodeMajor);
    const expectedName = `memberry-ret010-development-node-${manifest.nodeMajor}-${metadata.runId}-${metadata.runAttempt}`;
    if (!job || job.artifactName !== expectedName) throw new Error('artifact');
  }
  const node20Index = manifests[0]!.nodeMajor === '20' ? 0 : 1;
  const node22Index = node20Index === 0 ? 1 : 0;
  return {
    schemaVersion: '1', decision: 'verified', sourceCommit: aggregate.sourceCommit,
    modelBlob: aggregate.modelBlob, providerContractBlob: aggregate.providerContractBlob,
    adapterBlob: aggregate.adapterBlob,
    aggregateResultSha256: aggregateDigest,
    node20ManifestSha256: sha256(bundles[node20Index]!.bytes['custody-manifest.json']!),
    node22ManifestSha256: sha256(bundles[node22Index]!.bytes['custody-manifest.json']!),
    node20Version: manifests[node20Index]!.nodeVersion, node22Version: manifests[node22Index]!.nodeVersion,
    workflowRunId: manifests[0]!.workflowRunId,
    workflowRunAttempt: manifests[0]!.workflowRunAttempt,
    datasetDescriptorSha256: aggregate.datasetDescriptorSha256, inputSha256: aggregate.inputSha256,
    oracleSha256: aggregate.oracleSha256, devPolicySha256: aggregate.devPolicySha256, seed: aggregate.seed,
  };
}

export async function finalizeCurrentRun(gateSucceeded: boolean): Promise<void> {
  const identity = environmentIdentity();
  try {
    if (!gateSucceeded) {
      await finalizeCurrentFailure(identity, { failureClass: 'custody', stage: 'artifact' });
      return;
    }
    const head = await assertSourceIntegrity(identity.gitCommit);
    if (head !== identity.gitCommit) throw new Error('custody');
    await validateRunsRoot(false);
    await validateDirectoryChain(OUTPUT_LEAF, false);
    await validateCurrentHeadSuccessBundle(OUTPUT_LEAF, identity);
    const currentIdentity = environmentIdentity();
    if (JSON.stringify(currentIdentity) !== JSON.stringify(identity)) throw new Error('custody');
    await assertSourceIntegrity(identity.gitCommit);
    await validateRunsRoot(false);
    await validateDirectoryChain(OUTPUT_LEAF, false);
    await validateCurrentHeadSuccessBundle(OUTPUT_LEAF, identity);
  } catch (error) {
    try { await finalizeCurrentFailure(identity, failureContext(error, { failureClass: 'custody', stage: 'artifact' })); }
    catch (finalizerError) { throw new AggregateError([error, finalizerError], 'custody'); }
    throw new Error('custody');
  }
}

async function main(): Promise<void> {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'run') { await runDevelopment(); return; }
  if (mode === 'finalize') {
    try { await finalizeCurrentRun(args[0] === 'success'); }
    catch { process.stderr.write(SAFE_FAILURE); process.exitCode = 1; }
    return;
  }
  if (mode === 'verify' && args.length === 3) {
    try { process.stdout.write(canonicalBytes(await verifyDevelopmentBundles(args[0]!, args[1]!, args[2]!))); }
    catch { process.stderr.write(SAFE_FAILURE); process.exitCode = 1; }
    return;
  }
  process.stderr.write(SAFE_FAILURE);
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
