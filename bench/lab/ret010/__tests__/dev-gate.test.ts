import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { constants as fsConstants } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { createRequire } from 'node:module';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const GATE = resolve(ROOT, 'bench/lab/ret010/dev-gate.cjs');
const require = createRequire(import.meta.url);
const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

type DevFinalizeHooks = {
  randomBytes?: () => Buffer;
  beforeUploadPathOutput?: (paths: { evaluation: string; upload: string }) => Promise<void>;
  closeHandle?: (owner: { absolute: string; handle: { close(): Promise<void> } }) => Promise<void>;
};
type DevTestGate = {
  __testFinalize(environment: NodeJS.ProcessEnv, hooks?: DevFinalizeHooks): Promise<void>;
  __testGhToken(environment: NodeJS.ProcessEnv, hooks: Record<string, unknown>): Promise<{
    buffer: Buffer; length: number;
  }>;
  __testHttpRequest(url: string, headers: Record<string, string>, status: number, maximum: number,
    timeout: number, hooks: Record<string, unknown>): Promise<{
      status: number; rawHeaders: string[]; body: Buffer;
    }>;
  __testResolvePublicHost(host: string, hooks: Record<string, unknown>): Promise<{
    host: string; address: string; family: number;
  }>;
  __testProductionTransport(token: { buffer: Buffer; length: number }, hooks: Record<string, unknown>): {
    request(request: { kind: string; url: string }): Promise<unknown>;
  };
  __testWipeToken(token: { buffer: Buffer; length: number }): void;
  __testFixedFailureExit(mode: string, hooks: Record<string, unknown>): void;
  __testMetadata(response: RawResponse, allowLink?: boolean): unknown;
  __testArchiveResponse(response: RawResponse): Buffer;
  __testArtifactRedirect(response: RawResponse): string;
  __testPages(transport: { request(request: RequestDescriptor): Promise<RawResponse> },
    base: string, collection: 'jobs' | 'artifacts'): Promise<readonly HostedEntry[]>;
  __testNormalizedEntries(values: Record<string, unknown>[], total: number): readonly HostedEntry[];
  __testHostedSelection(run: Record<string, unknown>, jobs: readonly HostedEntry[],
    artifacts: readonly HostedEntry[], head: string, runId: string): HostedSelection;
  __testAuthenticatedArchive(bytes: Buffer, digest: string, inspect: (bytes: Buffer) => unknown): unknown;
  __testZip(bytes: Buffer, hooks?: {
    beforeReconstruct?: (entry: { name: string }) => void;
    inflateRaw?: (input: Buffer, options: Record<string, unknown>) => unknown;
    crc32?: (bytes: Buffer) => number;
  }): Record<string, Buffer>;
  __testZipAggregateSize(sizes: number[]): number;
  __testPostCloseBundleAudit(leaf: string, identities: Array<Record<string, unknown>>,
    io?: Record<string, unknown>): Promise<void>;
  __testExtractVerifiedBundle(files: Record<string, Buffer>, marker: Record<string, unknown>, hooks?: {
    beforeCreateFile?: (value: { leaf: string; name: string; absolute: string }) => Promise<void>;
    afterWrite?: (value: { leaf: string; name: string; absolute: string }) => Promise<void>;
    closeHandle?: (owner: { name?: string; kind: 'file' | 'directory'; absolute: string;
      handle: { close(): Promise<void> } }) => Promise<void>;
    writeDestination?: (owner: unknown, source: Buffer) => Promise<{ bytesWritten: number }>;
    readDestination?: (owner: unknown, destination: Buffer) => Promise<{ bytesRead: number }>;
  }): Promise<string>;
  __testVerifyAuthenticatedBundle(bytes: Buffer, serviceDigest: string, expected: {
    head: string; major: string; runId: string; attempt: string;
  }, hooks?: Record<string, unknown>): Promise<Record<string, unknown>>;
  __testDatasetDescriptor(pins: Record<string, { bytes: Buffer }>): string;
  __testValidatePolicy(pins: Record<string, { bytes: Buffer }>): Record<string, unknown>;
  __testValidatePinnedLiterals(pins: Record<string, { blob: string; sha256: string }>): void;
  __testValidateSuccess(records: Record<string, Buffer>, expected: Record<string, string>): void;
};
type RawResponse = { status: number; rawHeaders: string[]; body: Buffer };
type RequestDescriptor = Readonly<{ kind: string; url: string }>;
type HostedEntry = Readonly<{ value: Record<string, unknown>; id: string }>;
type HostedSelection = Readonly<{
  runId: string; attempt: string;
  selected: Readonly<Record<'20' | '22', Readonly<{
    name: string; id: string; digest: string; size: number; archiveUrl: string;
  }>>>;
}>;

async function loadInstrumentedGate(transform?: (source: string) => string): Promise<DevTestGate> {
  const source = transform ? transform(await readFile(GATE, 'utf8')) : await readFile(GATE, 'utf8');
  const productionExport = 'module.exports = Object.freeze({ createVerifyHostedVerifier });';
  const testExport = 'module.exports = Object.freeze({ createVerifyHostedVerifier, __testFinalize: finalize, __testGhToken: ghToken, __testHttpRequest: httpRequest, __testResolvePublicHost: resolvePublicHost, __testProductionTransport: productionTransport, __testWipeToken: wipeToken, __testFixedFailureExit: fixedFailureExit, __testMetadata: metadata, __testArchiveResponse: archiveResponse, __testArtifactRedirect: artifactRedirect, __testPages: pages, __testNormalizedEntries: normalizedEntries, __testHostedSelection: hostedSelection, __testAuthenticatedArchive: authenticatedArchive, __testZip: zip, __testZipAggregateSize: zipAggregateSize, __testPostCloseBundleAudit: postCloseBundleAudit, __testExtractVerifiedBundle: extractVerifiedBundle, __testVerifyAuthenticatedBundle: verifyAuthenticatedBundle, __testDatasetDescriptor: datasetDescriptor, __testValidatePolicy: validatePolicy, __testValidatePinnedLiterals: validatePinnedLiterals, __testValidateSuccess: validateSuccess });';
  expect(source.match(new RegExp(productionExport.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1);
  const instrumented = source.replace(productionExport, testExport);
  expect(instrumented.replace(testExport, productionExport)).toBe(source);

  const moduleApi = require('node:module') as {
    Module: (new (id?: string) => {
      filename: string; paths: string[]; exports: unknown;
      _compile(sourceText: string, filename: string): void;
    }) & { _nodeModulePaths(path: string): string[] };
  };
  const instance = new moduleApi.Module(GATE);
  instance.filename = GATE;
  instance.paths = moduleApi.Module._nodeModulePaths(ROOT);
  instance._compile(instrumented, GATE);
  return instance.exports as DevTestGate;
}

type FactoryOrderingGate = {
  createVerifyHostedVerifier(options: {
    transport: { request(request: RequestDescriptor): Promise<RawResponse> };
    __testPins: Record<string, unknown>;
    __testInspect(bytes: Buffer): unknown;
  }): (head: string, runId: string) => Promise<Buffer>;
};
async function loadFactoryOrderingGate(): Promise<FactoryOrderingGate> {
  const source = await readFile(GATE, 'utf8');
  const originals = [
    "keys(options, ['transport']);",
    'const pins = await sourcePins(scope, head);',
    'bundles[major] = await verifyAuthenticatedBundle(archiveBytes, selected[major].digest,\n        { head, major, runId, attempt });',
  ];
  const replacements = [
    "keys(options, ['transport', '__testPins', '__testInspect']);",
    'const pins = options.__testPins;',
    'bundles[major] = authenticatedArchive(archiveBytes, selected[major].digest, options.__testInspect);',
  ];
  let instrumented = source;
  for (let index = 0; index < originals.length; index += 1) {
    expect(instrumented.split(originals[index]!)).toHaveLength(2);
    instrumented = instrumented.replace(originals[index]!, replacements[index]!);
  }
  let restored = instrumented;
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    restored = restored.replace(replacements[index]!, originals[index]!);
  }
  expect(restored).toBe(source);
  const moduleApi = require('node:module') as {
    Module: (new (id?: string) => {
      filename: string; paths: string[]; exports: unknown;
      _compile(sourceText: string, filename: string): void;
    }) & { _nodeModulePaths(path: string): string[] };
  };
  const instance = new moduleApi.Module(GATE);
  instance.filename = GATE;
  instance.paths = moduleApi.Module._nodeModulePaths(ROOT);
  instance._compile(instrumented, GATE);
  return instance.exports as FactoryOrderingGate;
}

function fakeClock(failFirstCancel = false) {
  type Timer = { at: number; callback: () => void; cancelled: boolean; ordinal: number };
  let current = 0;
  let ordinal = 0;
  let cancelAttempts = 0;
  const timers: Timer[] = [];
  const runDue = () => {
    for (;;) {
      const due = timers
        .filter((timer) => !timer.cancelled && timer.at <= current)
        .sort((left, right) => left.at - right.at || left.ordinal - right.ordinal)[0];
      if (!due) return;
      due.cancelled = true;
      due.callback();
    }
  };
  return {
    hooks: {
      now: () => current,
      schedule: (delay: number, callback: () => void) => {
        const timer = { at: current + delay, callback, cancelled: false, ordinal: ordinal++ };
        timers.push(timer);
        return timer;
      },
      cancel: (timer: Timer) => {
        cancelAttempts += 1;
        timer.cancelled = true;
        if (failFirstCancel && cancelAttempts === 1) throw new Error('injected-timer-close-failure');
      },
    },
    set(value: number) { current = value; },
    advance(value: number) { current = value; runDue(); },
    cancelAttempts: () => cancelAttempts,
  };
}

function fakeGhChild(options: {
  closeOnKill?: boolean; killFailure?: 'throw' | 'false'; stdoutDestroyFailure?: boolean;
  stderrDestroyFailure?: boolean; childUnrefFailure?: boolean; stdoutUnrefFailure?: boolean;
  stderrUnrefFailure?: boolean;
} = {}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { destroy(): void; unref(): void };
    stderr: EventEmitter & { destroy(): void; unref(): void };
    kill(signal?: string): boolean; unref(): void;
  };
  child.stdout = new EventEmitter() as typeof child.stdout;
  child.stderr = new EventEmitter() as typeof child.stderr;
  const kills: (string | undefined)[] = [];
  const pipeDisposals = { stdoutDestroy: 0, stderrDestroy: 0, stdoutUnref: 0, stderrUnref: 0, childUnref: 0 };
  child.stdout.destroy = () => {
    pipeDisposals.stdoutDestroy += 1;
    if (options.stdoutDestroyFailure) throw new Error('stdout-destroy-failure');
  };
  child.stdout.unref = () => {
    pipeDisposals.stdoutUnref += 1;
    if (options.stdoutUnrefFailure) throw new Error('stdout-unref-failure');
  };
  child.stderr.destroy = () => {
    pipeDisposals.stderrDestroy += 1;
    if (options.stderrDestroyFailure) throw new Error('stderr-destroy-failure');
  };
  child.stderr.unref = () => {
    pipeDisposals.stderrUnref += 1;
    if (options.stderrUnrefFailure) throw new Error('stderr-unref-failure');
  };
  child.unref = () => {
    pipeDisposals.childUnref += 1;
    if (options.childUnrefFailure) throw new Error('child-unref-failure');
  };
  child.kill = (signal) => {
    kills.push(signal);
    if (options.killFailure === 'throw') throw new Error('kill-failure');
    if (options.killFailure === 'false') return false;
    if (options.closeOnKill !== false) child.emit('close', null, signal ?? 'SIGTERM');
    return true;
  };
  return { child, kills, pipeDisposals };
}

function ghTestEnvironment(): NodeJS.ProcessEnv {
  const configParent = resolve(tmpdir(), 'memberry-ret010-gh-test-config');
  return process.platform === 'win32' ? { APPDATA: configParent } : { HOME: configParent };
}

function fakeHttp(clock: ReturnType<typeof fakeClock>, destroyFailure = false, failures: {
  requestDestroy?: boolean; responseDestroy?: boolean; socketDestroy?: boolean;
  requestUnref?: boolean; responseUnref?: boolean; socketUnref?: boolean;
  deferClose?: boolean;
} = {}) {
  const request = new EventEmitter() as EventEmitter & { destroy(error?: Error): void; unref(): void };
  const response = new EventEmitter() as EventEmitter & {
    statusCode: number; rawHeaders: string[]; complete: boolean; destroy(): void; unref(): void;
  };
  const socket = new EventEmitter() as EventEmitter & { destroy(): void; unref(): void };
  response.statusCode = 200;
  response.rawHeaders = ['content-type', 'application/json'];
  response.complete = true;
  let receive: ((response: typeof response) => void) | undefined;
  let destroys = 0;
  let gets = 0;
  let requestOptions: Record<string, unknown> | undefined;
  const disposals = {
    requestDestroy: 0, responseDestroy: 0, socketDestroy: 0,
    requestUnref: 0, responseUnref: 0, socketUnref: 0,
  };
  request.destroy = () => {
    destroys += 1;
    disposals.requestDestroy += 1;
    if (destroyFailure || failures.requestDestroy) throw new Error('injected-request-destroy-failure');
    if (!failures.deferClose) request.emit('close');
  };
  request.unref = () => {
    disposals.requestUnref += 1;
    if (failures.requestUnref) throw new Error('injected-request-unref-failure');
  };
  response.destroy = () => {
    disposals.responseDestroy += 1;
    if (failures.responseDestroy) throw new Error('injected-response-destroy-failure');
    if (!failures.deferClose) response.emit('close');
  };
  response.unref = () => {
    disposals.responseUnref += 1;
    if (failures.responseUnref) throw new Error('injected-response-unref-failure');
  };
  socket.destroy = () => {
    disposals.socketDestroy += 1;
    if (failures.socketDestroy) throw new Error('injected-socket-destroy-failure');
    if (!failures.deferClose) socket.emit('close');
  };
  socket.unref = () => {
    disposals.socketUnref += 1;
    if (failures.socketUnref) throw new Error('injected-socket-unref-failure');
  };
  const hooks = {
    ...clock.hooks,
    get: (_url: string, options: Record<string, unknown>, callback: (incoming: typeof response) => void) => {
      gets += 1;
      requestOptions = options;
      receive = callback;
      return request;
    },
  };
  return {
    hooks, request, response, socket,
    connect() {
      request.emit('socket', socket);
      receive!(response);
    },
    destroys: () => destroys,
    gets: () => gets,
    options: () => requestOptions!,
    disposals: () => ({ ...disposals }),
  };
}

async function developmentFailureFixture(ordinal: number) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const nodeMajor = process.versions.node.split('.')[0]!;
  const workflowRunId = `${process.pid}${Date.now()}${ordinal}`;
  const workflowRunAttempt = '1';
  const runs = resolve(ROOT, 'node_modules/.cache/memberry-lab/runs');
  await mkdir(runs, { recursive: true });
  const evaluation = resolve(runs,
    `ret010-development-run-${workflowRunId}-attempt-${workflowRunAttempt}-node-${nodeMajor}`);
  await mkdir(evaluation, { recursive: false });
  const tombstone = {
    schemaVersion: '1', decision: 'failed', failureClass: 'custody', stage: 'artifact',
    gitCommit: head, nodeMajor, nodeVersion: process.version,
    workflowRunId, workflowRunAttempt,
  };
  await writeFile(resolve(evaluation, 'failure-tombstone.json'), `${JSON.stringify(tombstone)}\n`);
  const temporary = await mkdtemp(join(tmpdir(), 'memberry-ret010-dev-finalizer-'));
  temporaryRoots.push(temporary, evaluation);
  const output = resolve(temporary, 'github-output');
  await writeFile(output, '');
  return {
    evaluation, output, runs,
    environment: developmentFinalizerEnvironment(process.env, {
      GITHUB_RUN_ID: workflowRunId, GITHUB_RUN_ATTEMPT: workflowRunAttempt,
      RET010_DEVELOPMENT_GATE_OUTCOME: 'failure', GITHUB_OUTPUT: output,
    }),
  };
}

function developmentFinalizerEnvironment(source: NodeJS.ProcessEnv, required: Readonly<{
  GITHUB_RUN_ID: string;
  GITHUB_RUN_ATTEMPT: string;
  RET010_DEVELOPMENT_GATE_OUTCOME: 'failure';
  GITHUB_OUTPUT: string;
}>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
  for (const [name, value] of Object.entries(source)) {
    const folded = name.toUpperCase();
    if (folded.startsWith('NODE_') || folded.startsWith('GITHUB_')
      || folded.startsWith('RET010_') || folded === 'RUNNER_TEMP'
      || folded === 'VITEST' || folded.startsWith('VITEST_')
      || folded === 'TINIPOOL' || folded.startsWith('TINIPOOL_')) continue;
    Object.defineProperty(environment, name, {
      value, enumerable: true, writable: true, configurable: true,
    });
  }
  for (const [name, value] of Object.entries(required)) Object.defineProperty(environment, name, {
    value, enumerable: true, writable: true, configurable: true,
  });
  return environment;
}

const HOSTED_HEAD = 'a'.repeat(40);
const HOSTED_RUN_ID = '1000';
const HOSTED_BASE = `https://api.github.com/repos/AP3X-Dev/memberry/actions/runs/${HOSTED_RUN_ID}`;
function jsonResponse(value: unknown, framing: 'length' | 'chunked' | 'none' = 'length',
  extraHeaders: string[] = [], status = 200): RawResponse {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const rawHeaders = ['Content-Type', 'application/json'];
  if (framing === 'length') rawHeaders.push('Content-Length', String(body.length));
  if (framing === 'chunked') rawHeaders.push('Transfer-Encoding', 'chunked');
  rawHeaders.push(...extraHeaders);
  return { status, rawHeaders, body };
}
function replaceJsonBody(response: RawResponse, value: unknown): void {
  response.body = Buffer.from(JSON.stringify(value));
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    if (response.rawHeaders[index]!.toLowerCase() === 'content-length') {
      response.rawHeaders[index + 1] = String(response.body.length);
    }
  }
}
function replaceHeader(response: RawResponse, name: string, values: string[]): void {
  const kept: string[] = [];
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    if (response.rawHeaders[index]!.toLowerCase() !== name.toLowerCase()) {
      kept.push(response.rawHeaders[index]!, response.rawHeaders[index + 1]!);
    }
  }
  for (const value of values) kept.push(name, value);
  response.rawHeaders = kept;
}
function canonicalPageLink(collection: string, page: number, last: number): string | undefined {
  if (page === last) return undefined;
  const pathname = `/repos/AP3X-Dev/memberry/actions/runs/${HOSTED_RUN_ID}/${collection}`;
  const target = (value: number) =>
    `<https://api.github.com${pathname}?per_page=100&page=${value}>`;
  const members = [`${target(page + 1)}; rel="next"`, `${target(1)}; rel="first"`];
  if (page > 1) members.push(`${target(page - 1)}; rel="prev"`);
  members.push(`${target(last)}; rel="last"`);
  return members.join(', ');
}
function pageFixture(total: number, collection: 'jobs' | 'artifacts',
  mutate?: (response: RawResponse, page: number, last: number) => void) {
  const calls: string[] = [];
  const last = Math.max(1, Math.ceil(total / 100));
  return {
    calls,
    transport: {
      request: async (request: RequestDescriptor) => {
        calls.push(request.url);
        const match = /[?&]page=([0-9]+)$/.exec(request.url);
        const page = Number(match?.[1]);
        const count = total > 1000 ? 100 : page < last ? 100 : total - 100 * (last - 1);
        const first = (page - 1) * 100;
        const rows = Array.from({ length: count }, (_, index) => ({ id: first + index + 1 }));
        const link = canonicalPageLink(collection, page, last);
        const response = jsonResponse({ total_count: total, [collection]: rows }, 'length',
          link ? ['Link', link] : []);
        mutate?.(response, page, last);
        return response;
      },
    },
  };
}
function hostedFixture() {
  const run = {
    id: 1000, run_attempt: 2, head_sha: HOSTED_HEAD, status: 'completed', conclusion: 'success',
    path: '.github/workflows/ci.yml', name: 'CI',
    repository: { id: 9, full_name: 'AP3X-Dev/memberry' },
  };
  const jobs = ['20', '22'].map((major, index) => ({
    id: 200 + index, name: `unit (${major})`, run_id: 1000, run_attempt: 2,
    head_sha: HOSTED_HEAD, status: 'completed', conclusion: 'success', workflow_name: 'CI',
  }));
  const artifacts = ['20', '22'].map((major, index) => {
    const id = 300 + index;
    return {
      id, name: `memberry-ret010-development-node-${major}-1000-2`, expired: false,
      digest: `sha256:${String(index + 1).repeat(64)}`, size_in_bytes: 3,
      archive_download_url:
        `https://api.github.com/repos/AP3X-Dev/memberry/actions/artifacts/${id}/zip`,
      workflow_run: { id: 1000, repository_id: 9, head_repository_id: 9, head_sha: HOSTED_HEAD },
    };
  });
  return { run, jobs, artifacts };
}
function setHostedIdentity(fixture: ReturnType<typeof hostedFixture>, path: string, value: unknown): void {
  const [scope, ordinal, field] = path.split('.');
  if (scope === 'run') {
    (fixture.run as unknown as Record<string, unknown>)[ordinal!] = value; return;
  }
  if (scope === 'repository') {
    (fixture.run.repository as Record<string, unknown>)[ordinal!] = value; return;
  }
  const index = ordinal === '20' ? 0 : 1;
  if (scope === 'job') {
    (fixture.jobs[index]! as unknown as Record<string, unknown>)[field!] = value; return;
  }
  if (scope === 'artifact') {
    (fixture.artifacts[index]! as unknown as Record<string, unknown>)[field!] = value; return;
  }
  if (scope === 'artifactRun') {
    (fixture.artifacts[index]!.workflow_run as Record<string, unknown>)[field!] = value; return;
  }
  throw new Error('test-path');
}
const HOSTED_IDENTITY_PATHS = Object.freeze([
  'run.id', 'run.run_attempt', 'repository.id',
  'job.20.id', 'job.20.run_id', 'job.20.run_attempt',
  'job.22.id', 'job.22.run_id', 'job.22.run_attempt',
  'artifact.20.id', 'artifactRun.20.id', 'artifactRun.20.repository_id',
  'artifactRun.20.head_repository_id',
  'artifact.22.id', 'artifactRun.22.id', 'artifactRun.22.repository_id',
  'artifactRun.22.head_repository_id',
]);
const INVALID_RAW_IDENTITIES = Object.freeze([
  ['fraction', 1.5], ['zero', 0], ['negative', -1], ['string', '1'], ['null', null],
  ['missing', undefined], ['unsafe', Number.MAX_SAFE_INTEGER + 1],
] as const);
function setObjectPath(root: unknown, pathValue: string, value: unknown): void {
  const parts = pathValue.split('.');
  let current = root as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) current = current[part] as Record<string, unknown>;
  current[parts[parts.length - 1]!] = value;
}
function canonicalJson(value: unknown): Buffer { return Buffer.from(`${JSON.stringify(value)}\n`); }
function digest(value: Buffer): string { return createHash('sha256').update(value).digest('hex'); }
const ZIP_NAMES = Object.freeze([
  'recall-lane.json', 'precision-lane.json', 'efficiency-interval.json',
  'aggregate-result.json', 'custody-manifest.json', 'upload-complete.json',
]);
const CLOSE_OWNER_ORDINALS = Object.freeze(Array.from({ length: 24 }, (_, index) => index + 1));
type ZipEntryOptions = {
  centralName?: Buffer; localName?: Buffer; content?: Buffer; method?: 0 | 8; flags?: number;
  madeBy?: number; external?: number; descriptor?: false | 'signed' | 'unsigned';
  compressedSuffix?: Buffer; compressedTruncate?: number; centralCrc?: number; descriptorCrc?: number;
  descriptorCompressed?: number; descriptorUncompressed?: number;
  centralCompressed?: number; centralUncompressed?: number;
  localCrc?: number; localCompressed?: number; localUncompressed?: number;
};
type ZipFixture = {
  bytes: Buffer;
  entries: Array<{
    id: string; localStart: number; localNameStart: number; dataStart: number; dataEnd: number;
    descriptorStart: number; centralStart: number; centralNameStart: number;
  }>;
  centralStart: number; eocd: number; contents: Record<string, Buffer>;
};
function testCrc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zipFixture(overrides: Partial<Record<string, ZipEntryOptions>> = {},
  order: readonly string[] = ZIP_NAMES): ZipFixture {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const entries: ZipFixture['entries'] = [];
  const contents: Record<string, Buffer> = Object.create(null) as Record<string, Buffer>;
  let localCursor = 0;
  for (const [ordinal, id] of order.entries()) {
    const options = overrides[id] ?? {};
    const centralName = options.centralName ?? Buffer.from(id, 'ascii');
    const localName = options.localName ?? Buffer.from(centralName);
    const content = options.content ?? Buffer.from(`payload-${ordinal}\n`, 'ascii');
    const method = options.method ?? 0;
    const flags = options.flags ?? (options.descriptor ? 0x0008 : 0);
    const descriptor = options.descriptor ?? ((flags & 0x0008) ? 'signed' : false);
    const compressedComplete = method === 8 ? deflateRawSync(content) : Buffer.from(content);
    const compressedBase = options.compressedTruncate === undefined ? compressedComplete
      : compressedComplete.subarray(0, Math.max(0, compressedComplete.length - options.compressedTruncate));
    const compressedBytes = Buffer.concat([compressedBase, options.compressedSuffix ?? Buffer.alloc(0)]);
    const crc = options.centralCrc ?? testCrc32(content);
    const compressed = options.centralCompressed ?? compressedBytes.length;
    const uncompressed = options.centralUncompressed ?? content.length;
    const local = Buffer.alloc(30 + localName.length + compressedBytes.length
      + (descriptor === 'signed' ? 16 : descriptor === 'unsigned' ? 12 : 0));
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(options.localCrc ?? (flags & 8 ? 0 : crc), 14);
    local.writeUInt32LE(options.localCompressed ?? (flags & 8 ? 0 : compressed), 18);
    local.writeUInt32LE(options.localUncompressed ?? (flags & 8 ? 0 : uncompressed), 22);
    local.writeUInt16LE(localName.length, 26); local.writeUInt16LE(0, 28);
    localName.copy(local, 30); compressedBytes.copy(local, 30 + localName.length);
    const descriptorStart = localCursor + 30 + localName.length + compressedBytes.length;
    if (descriptor) {
      let at = 30 + localName.length + compressedBytes.length;
      if (descriptor === 'signed') { local.writeUInt32LE(0x08074b50, at); at += 4; }
      local.writeUInt32LE(options.descriptorCrc ?? crc, at);
      local.writeUInt32LE(options.descriptorCompressed ?? compressed, at + 4);
      local.writeUInt32LE(options.descriptorUncompressed ?? uncompressed, at + 8);
    }
    const central = Buffer.alloc(46 + centralName.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(options.madeBy ?? 0x0314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed, 20);
    central.writeUInt32LE(uncompressed, 24); central.writeUInt16LE(centralName.length, 28);
    central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(options.external ?? ((0o100600 << 16) >>> 0), 38);
    central.writeUInt32LE(localCursor, 42); centralName.copy(central, 46);
    entries.push({
      id, localStart: localCursor, localNameStart: localCursor + 30,
      dataStart: localCursor + 30 + localName.length,
      dataEnd: localCursor + 30 + localName.length + compressedBytes.length,
      descriptorStart, centralStart: 0, centralNameStart: 0,
    });
    contents[id] = content;
    locals.push(local); centrals.push(central); localCursor += local.length;
  }
  const centralStart = localCursor;
  let centralCursor = centralStart;
  for (let index = 0; index < centrals.length; index += 1) {
    entries[index]!.centralStart = centralCursor;
    entries[index]!.centralNameStart = centralCursor + 46;
    centralCursor += centrals[index]!.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(6, 8); eocd.writeUInt16LE(6, 10);
  eocd.writeUInt32LE(centralBytes.length, 12); eocd.writeUInt32LE(centralStart, 16);
  return { bytes: Buffer.concat([...locals, centralBytes, eocd]), entries,
    centralStart, eocd: centralCursor, contents };
}
type SemanticMutable = {
  recall: { candidate: Record<string, number>; delta: Record<string, number>;
    qualifyingCaseCount: number };
  precision: { candidate: Record<string, number>; delta: Record<string, number>;
    qualifyingCaseCount: number };
  interval: { point: number; lower: number; upper: number; oneSidedLower: number };
  aggregate: { quality: Record<string, number>; safety: Record<string, number>;
    responseEffect: { sameCaseOrderAndSelectionChanged: boolean; qualifyingCaseCount: number } };
};
function semanticFixture(mutate?: (state: SemanticMutable) => void) {
  const arm = (recallAtK: number, precisionAtK: number) => ({
    recallAtK, precisionAtK, staleLeakRate: 0, isolationLeakRate: 0,
    duplicateRate: 0, unknownResultRate: 0,
  });
  const recall = {
    schemaVersion: '1', lane: 'recall-at-10', datasetId: 'memberry-ret010-dev-v1', split: 'dev',
    controlAdapterId: 'memberry-retrieval-core-disabled-v1',
    candidateAdapterId: 'memberry-retrieval-core-served-v1', scenarioCount: 10, probeCount: 10, k: 10,
    control: arm(0.4, 0.4), candidate: arm(0.4, 0.4),
    delta: { recallAtK: 0, precisionAtK: 0 }, qualifyingCaseCount: 1, passed: true,
  };
  const precision = {
    ...recall, lane: 'precision-at-5', k: 5, control: arm(0.4, 0), candidate: arm(0.4, 0.05),
    delta: { recallAtK: 0, precisionAtK: 0.05 }, qualifyingCaseCount: 0,
  };
  const interval = {
    schemaVersion: '1', metric: 'task-success-per-1k-tokens', outcome: 'measured', pairedProbes: 20,
    resamples: 2000, level: 0.95, seed: 1, point: 0.001, lower: 0,
    upper: 0.002, oneSidedLower: 0,
  };
  const aggregate = {
    schemaVersion: '1', decision: 'passed', datasetId: 'memberry-ret010-dev-v1', split: 'dev',
    controlAdapterId: 'memberry-retrieval-core-disabled-v1',
    candidateAdapterId: 'memberry-retrieval-core-served-v1',
    providerIdentity: { providerId: 'memberry.local.lexical', modelId: 'bm25f-query-v1',
      calibrationId: 'fixed-blend-v1', locality: 'local' },
    sourceCommit: HOSTED_HEAD, modelBlob: 'b'.repeat(40), providerContractBlob: 'c'.repeat(40),
    adapterBlob: 'd'.repeat(40), statisticsBlob: 'e'.repeat(40),
    datasetDescriptorSha256: '1'.repeat(64), inputSha256: '2'.repeat(64),
    oracleSha256: '3'.repeat(64), devPolicySha256: '4'.repeat(64),
    recallLaneSha256: '', precisionLaneSha256: '', efficiencyIntervalSha256: '', seed: 1,
    quality: { recallDelta: 0, precisionDelta: 0.05, efficiencyPoint: 0.001,
      efficiencyOneSidedLower: 0 },
    safety: { staleLeakRate: 0, isolationLeakRate: 0, duplicateRate: 0, unknownResultRate: 0 },
    responseEffect: { sameCaseOrderAndSelectionChanged: true, qualifyingCaseCount: 1 }, passed: true,
  };
  const state = { recall, precision, interval, aggregate } as SemanticMutable;
  mutate?.(state);
  const records: Record<string, Buffer> = {
    'recall-lane.json': canonicalJson(recall),
    'precision-lane.json': canonicalJson(precision),
    'efficiency-interval.json': canonicalJson(interval),
  };
  aggregate.recallLaneSha256 = digest(records['recall-lane.json']!);
  aggregate.precisionLaneSha256 = digest(records['precision-lane.json']!);
  aggregate.efficiencyIntervalSha256 = digest(records['efficiency-interval.json']!);
  records['aggregate-result.json'] = canonicalJson(aggregate);
  records['custody-manifest.json'] = canonicalJson({
    schemaVersion: '1', decision: 'passed', gitCommit: HOSTED_HEAD, nodeMajor: '20',
    nodeVersion: 'v20.18.2', workflowRunId: '1000', workflowRunAttempt: '2',
    recallLaneSha256: digest(records['recall-lane.json']!),
    precisionLaneSha256: digest(records['precision-lane.json']!),
    efficiencyIntervalSha256: digest(records['efficiency-interval.json']!),
    aggregateResultSha256: digest(records['aggregate-result.json']!),
  });
  return { records, expected: { gitCommit: HOSTED_HEAD, nodeMajor: '20', nodeVersion: 'v20.18.2',
    workflowRunId: '1000', workflowRunAttempt: '2' } };
}
function authenticatedSemanticBundle(mutate?: (state: SemanticMutable) => void) {
  const semantic = semanticFixture(mutate);
  const marker = {
    schemaVersion: '1', decision: 'complete', bundleKind: 'success', gitCommit: HOSTED_HEAD,
    nodeMajor: '20', nodeVersion: 'v20.18.2', workflowRunId: '1000', workflowRunAttempt: '2',
    uploadLeafName: `ret010-upload-${'9'.repeat(64)}`, allowlist: [...ZIP_NAMES],
    payloadSha256: {
      recallLaneSha256: digest(semantic.records['recall-lane.json']!),
      precisionLaneSha256: digest(semantic.records['precision-lane.json']!),
      efficiencyIntervalSha256: digest(semantic.records['efficiency-interval.json']!),
      aggregateResultSha256: digest(semantic.records['aggregate-result.json']!),
      custodyManifestSha256: digest(semantic.records['custody-manifest.json']!),
    },
  };
  const records = { ...semantic.records, 'upload-complete.json': canonicalJson(marker) };
  const overrides = Object.fromEntries(Object.entries(records).map(([name, content]) => [name, { content }]));
  const archive = zipFixture(overrides, ['upload-complete.json', ...ZIP_NAMES.slice(0, -1)]);
  return { semantic, marker, records, archive };
}
async function postCloseAuditFixture() {
  const parent = await mkdtemp(join(tmpdir(), 'ret010-post-close-'));
  const leaf = resolve(parent, `ret010-upload-${'8'.repeat(64)}`);
  await mkdir(leaf);
  const identities: Array<Record<string, unknown>> = [];
  const add = async (absolute: string, kind: 'file' | 'directory', source?: Buffer) => {
    const stat = await lstat(absolute, { bigint: true });
    identities.push({ absolute, kind, maximum: 2_000_000, source,
      snapshot: Object.freeze({ dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size }) });
  };
  await add(parent, 'directory'); await add(leaf, 'directory');
  for (const [ordinal, name] of ZIP_NAMES.entries()) {
    const source = Buffer.from(`post-close-${ordinal}\n`); const absolute = resolve(leaf, name);
    await writeFile(absolute, source); await add(absolute, 'file', source);
  }
  return { parent, leaf, identities };
}

describe('RET-010E CommonJS executable boundary', () => {
  it('isolates the exact finalizer child from worker bootstrap and hosted identity controls', () => {
    const environment = developmentFinalizerEnvironment({
      PATH: 'safe-path', HOME: 'safe-home', NODE_CHANNEL_FD: '3', Node_Options: '--inspect',
      VITEST: 'true', VITEST_POOL_ID: '7', TINIPOOL_WORKER_ID: '4',
      GITHUB_SHA: 'hosted-sha', RUNNER_TEMP: '/hosted', RET010_OTHER: 'hosted-control',
    }, {
      GITHUB_RUN_ID: '17', GITHUB_RUN_ATTEMPT: '2',
      RET010_DEVELOPMENT_GATE_OUTCOME: 'failure', GITHUB_OUTPUT: '/safe/output',
    });
    expect(Object.keys(environment)).toEqual([
      'PATH', 'HOME', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT',
      'RET010_DEVELOPMENT_GATE_OUTCOME', 'GITHUB_OUTPUT',
    ]);
    expect(environment).toMatchObject({
      PATH: 'safe-path', HOME: 'safe-home', GITHUB_RUN_ID: '17', GITHUB_RUN_ATTEMPT: '2',
      RET010_DEVELOPMENT_GATE_OUTCOME: 'failure', GITHUB_OUTPUT: '/safe/output',
    });
  });

  it('is accepted by plain Node syntax checking and exports only the hosted factory', () => {
    expect(() => execFileSync(process.execPath, ['--check', GATE], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 3_000, killSignal: 'SIGKILL',
    })).not.toThrow();
    const exported = require(GATE) as Record<string, unknown>;
    expect(Object.keys(exported)).toEqual(['createVerifyHostedVerifier']);
    expect(typeof exported.createVerifyHostedVerifier).toBe('function');
  });

  it('rejects loader-free run before importing TypeScript with a fixed value-free channel', () => {
    const result = spawnSync(process.execPath, [GATE, 'run'], {
      cwd: ROOT, encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined },
      timeout: 3_000, killSignal: 'SIGKILL',
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('RET010_DEV_GATE_FAILED\n');
  });

  it('rejects malformed loader-free verify-hosted argv before token acquisition', () => {
    const result = spawnSync(process.execPath, [GATE, 'verify-hosted', 'bad', '0'], {
      cwd: ROOT, encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined },
      timeout: 3_000, killSignal: 'SIGKILL',
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('RET010_DEV_RECEIPT_VERIFY_FAILED\n');
  });

  it('runs the exact production verify-hosted CLI and emits no approval for a denied session', () => {
    const environment = { ...process.env, GITHUB_RET010_TEST_DENIED: '1' };
    delete environment.NODE_OPTIONS;
    delete environment.NODE_PATH;
    const result = spawnSync(process.execPath, [GATE, 'verify-hosted', 'a'.repeat(40), '1'], {
      cwd: ROOT, encoding: 'utf8', env: environment, timeout: 3_000, killSignal: 'SIGKILL',
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('RET010_DEV_RECEIPT_VERIFY_FAILED\n');
  });

  it.each(([
    ['NODE_DEBUG', 'http'],
    ['NODE_DEBUG', ''],
    ['NoDe_DeBuG', 'http'],
    ['NODE_DEBUG_NATIVE', 'TLS'],
    ['NoDe_DeBuG_NaTiVe', ''],
  ] as const))('denies inherited %s before token or transport construction', async (name, value) => {
    const gate = await loadInstrumentedGate();
    const environment = ghTestEnvironment();
    Object.defineProperty(environment, name, { value, enumerable: true, configurable: true });
    let spawns = 0;
    let allocations = 0;
    await expect(gate.__testGhToken(environment, {
      spawn: () => { spawns += 1; throw new Error('must-not-spawn'); },
      allocateToken: () => { allocations += 1; return Buffer.alloc(4096, 0x7f); },
    })).rejects.toThrow('ret010');
    expect(spawns).toBe(0);
    expect(allocations).toBe(0);

    const cliEnvironment = { ...process.env };
    for (const inherited of Object.keys(cliEnvironment)) {
      if (['NODE_DEBUG', 'NODE_DEBUG_NATIVE'].includes(inherited.toUpperCase())) delete cliEnvironment[inherited];
    }
    Object.defineProperty(cliEnvironment, name, { value, enumerable: true, configurable: true });
    delete cliEnvironment.NODE_OPTIONS;
    delete cliEnvironment.NODE_PATH;
    const result = spawnSync(process.execPath, [GATE, 'verify-hosted', 'a'.repeat(40), '1'], {
      cwd: ROOT, encoding: 'utf8', env: cliEnvironment, timeout: 3_000, killSignal: 'SIGKILL',
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('RET010_DEV_RECEIPT_VERIFY_FAILED\n');
  });

  it('completes case-fold collision detection before NODE_DEBUG denial', async () => {
    const gate = await loadInstrumentedGate();
    const environment = ghTestEnvironment();
    Object.defineProperty(environment, 'NODE_DEBUG', { value: 'http', enumerable: true });
    Object.defineProperty(environment, 'node_debug', { value: '', enumerable: true });
    let spawns = 0;
    let allocations = 0;
    await expect(gate.__testGhToken(environment, {
      spawn: () => { spawns += 1; throw new Error('must-not-spawn'); },
      allocateToken: () => { allocations += 1; return Buffer.alloc(4096, 0x7f); },
    })).rejects.toThrow('ret010');
    expect(spawns).toBe(0);
    expect(allocations).toBe(0);
  });

  it('synchronously emits the fixed sentinel and forcibly exits despite a live handle', () => {
    const script = String.raw`
      const fs = require('node:fs');
      const Module = require('node:module');
      const path = require('node:path');
      const gate = process.argv[1];
      const production = 'module.exports = Object.freeze({ createVerifyHostedVerifier });';
      const test = 'module.exports = Object.freeze({ createVerifyHostedVerifier, fixedFailureExit });';
      const original = fs.readFileSync(gate, 'utf8');
      const source = original.replace(production, test);
      if (source.replace(test, production) !== original) process.exit(2);
      const instance = new Module(gate);
      instance.filename = gate;
      instance.paths = Module._nodeModulePaths(path.dirname(gate));
      instance._compile(source, gate);
      setInterval(() => {}, 1000);
      instance.exports.fixedFailureExit('verify-hosted');
    `;
    const result = spawnSync(process.execPath, ['-e', script, GATE], {
      cwd: ROOT, encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL',
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('RET010_DEV_RECEIPT_VERIFY_FAILED\n');
  });

  it.each([
    ['full', Number.MAX_SAFE_INTEGER],
    ['short', 3],
    ['one-byte', 1],
  ] as const)('writes the complete exact sentinel through %s positive writes', async (_label, limit) => {
    const gate = await loadInstrumentedGate();
    const chunks: Buffer[] = [];
    const exits: number[] = [];
    gate.__testFixedFailureExit('verify-hosted', {
      write: (fd: number, message: Buffer, offset: number, remaining: number, position: null) => {
        expect(fd).toBe(2);
        expect(position).toBeNull();
        const written = Math.min(limit, remaining);
        chunks.push(Buffer.from(message.subarray(offset, offset + written)));
        return written;
      },
      exit: (code: number) => { exits.push(code); },
    });
    expect(Buffer.concat(chunks).toString('utf8')).toBe('RET010_DEV_RECEIPT_VERIFY_FAILED\n');
    expect(exits).toEqual([1]);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 0.5],
    ['oversized', 999],
    ['throw', 'throw'],
  ] as const)('forces exit without alternate bytes after a %s fixed-write failure', async (_label, outcome) => {
    const gate = await loadInstrumentedGate();
    const chunks: Buffer[] = [];
    const exits: number[] = [];
    gate.__testFixedFailureExit('verify-hosted', {
      write: (_fd: number, message: Buffer, offset: number, remaining: number) => {
        if (outcome === 'throw') throw new Error('injected-write-failure');
        if (typeof outcome === 'number' && outcome > 0 && outcome <= remaining) {
          chunks.push(Buffer.from(message.subarray(offset, offset + outcome)));
        }
        return outcome;
      },
      exit: (code: number) => { exits.push(code); },
    });
    const emitted = Buffer.concat(chunks).toString('utf8');
    expect('RET010_DEV_RECEIPT_VERIFY_FAILED\n'.startsWith(emitted)).toBe(true);
    expect(exits).toEqual([1]);
  });

  it('rejects hostile semantic inputs through the hermetic factory without transport use', async () => {
    const exported = require(GATE) as {
      createVerifyHostedVerifier(options: { transport: { request(): Promise<never> } }):
        (head: string, runId: string) => Promise<Buffer>;
    };
    let calls = 0;
    const verify = exported.createVerifyHostedVerifier({
      transport: { request: async () => { calls += 1; throw new Error('sentinel'); } },
    });
    await expect(verify('A'.repeat(40), '1')).rejects.toThrow('ret010');
    await expect(verify('a'.repeat(40), '01')).rejects.toThrow('ret010');
    expect(calls).toBe(0);
  });

  it.each([
    'none', 'length', 'chunked',
  ] as const)('accepts exact metadata framing: %s', async (framing) => {
    const gate = await loadInstrumentedGate();
    expect(gate.__testMetadata(jsonResponse({ ok: true }, framing))).toEqual({ ok: true });
  });

  it('accepts a completely framed metadata body at the exact byte cap', async () => {
    const gate = await loadInstrumentedGate();
    const body = Buffer.alloc(8_388_608, 0x20); body.write('{}', 0, 'ascii');
    expect(gate.__testMetadata({ status: 200,
      rawHeaders: ['Content-Type', 'application/json', 'Content-Length', String(body.length)],
      body })).toEqual({});
  });

  it.each([
    'both', 'duplicate-length', 'conflicting-length', 'duplicate-transfer',
    'transfer-case', 'transfer-gzip', 'length-leading-zero', 'length-signed', 'length-space',
    'length-unsafe', 'length-mismatch', 'missing-type', 'duplicate-type', 'wrong-type-case',
    'wrong-charset', 'extra-type-parameter', 'status', 'location', 'encoding', 'run-link',
    'odd-raw-headers', 'too-many-headers', 'oversized-headers', 'malformed-json',
    'duplicate-json-key', 'oversized-body',
  ] as const)('rejects hostile metadata framing/body: %s', async (label) => {
    const gate = await loadInstrumentedGate();
    const response = jsonResponse({ ok: true });
    if (label === 'both') response.rawHeaders.push('Transfer-Encoding', 'chunked');
    if (label === 'duplicate-length') response.rawHeaders.push('Content-Length', String(response.body.length));
    if (label === 'conflicting-length') response.rawHeaders.push('Content-Length', '1');
    if (label === 'duplicate-transfer') {
      replaceHeader(response, 'Content-Length', []);
      response.rawHeaders.push('Transfer-Encoding', 'chunked', 'Transfer-Encoding', 'chunked');
    }
    if (label === 'transfer-case' || label === 'transfer-gzip') {
      replaceHeader(response, 'Content-Length', []);
      response.rawHeaders.push('Transfer-Encoding', label === 'transfer-case' ? 'Chunked' : 'gzip');
    }
    if (label.startsWith('length-')) replaceHeader(response, 'Content-Length', [{
      'length-leading-zero': `0${response.body.length}`, 'length-signed': `+${response.body.length}`,
      'length-space': ` ${response.body.length}`, 'length-unsafe': '9007199254740992',
      'length-mismatch': String(response.body.length + 1),
    }[label]!]);
    if (label === 'missing-type') replaceHeader(response, 'Content-Type', []);
    if (label === 'duplicate-type') response.rawHeaders.push('Content-Type', 'application/json');
    if (label === 'wrong-type-case') replaceHeader(response, 'Content-Type', ['Application/JSON']);
    if (label === 'wrong-charset') replaceHeader(response, 'Content-Type', ['application/json; charset=UTF-8']);
    if (label === 'extra-type-parameter') replaceHeader(response, 'Content-Type', ['application/json; x=1']);
    if (label === 'status') response.status = 201;
    if (label === 'location') response.rawHeaders.push('Location', 'https://example.invalid/');
    if (label === 'encoding') response.rawHeaders.push('Content-Encoding', 'gzip');
    if (label === 'run-link') response.rawHeaders.push('Link', '<https://api.github.com/>; rel="next"');
    if (label === 'odd-raw-headers') response.rawHeaders.push('odd');
    if (label === 'too-many-headers') {
      for (let index = 0; index < 127; index += 1) response.rawHeaders.push(`X-${index}`, 'x');
    }
    if (label === 'oversized-headers') response.rawHeaders.push('X-Large', 'x'.repeat(65536));
    if (label === 'malformed-json') {
      response.body = Buffer.from('{'); replaceHeader(response, 'Content-Length', ['1']);
    }
    if (label === 'duplicate-json-key') {
      response.body = Buffer.from('{"x":1,"x":2}');
      replaceHeader(response, 'Content-Length', [String(response.body.length)]);
    }
    if (label === 'oversized-body') {
      response.body = Buffer.alloc(8_388_609, 0x20);
      replaceHeader(response, 'Content-Length', [String(response.body.length)]);
    }
    expect(() => gate.__testMetadata(response)).toThrow('ret010');
  });

  it('permits one canonical Link only on collection metadata', async () => {
    const gate = await loadInstrumentedGate();
    const link = `<https://api.github.com/repos/AP3X-Dev/memberry/actions/runs/1000/jobs?per_page=100&page=2>; rel="next"`;
    const response = jsonResponse({ total_count: 101, jobs: Array.from({ length: 100 }, (_, id) => ({ id: id + 1 })) },
      'length', ['Link', link]);
    expect(gate.__testMetadata(response, true)).toMatchObject({ total_count: 101 });
  });

  it.each(['absent-length', 'zero-length'] as const)(
    'accepts exact zero-body artifact redirect framing: %s', async (label) => {
      const gate = await loadInstrumentedGate();
      const response: RawResponse = { status: 302,
        rawHeaders: ['Location', 'https://artifact.example/archive'], body: Buffer.alloc(0) };
      if (label === 'zero-length') response.rawHeaders.push('Content-Length', '0');
      expect(gate.__testArtifactRedirect(response)).toBe('https://artifact.example/archive');
    },
  );

  it.each([
    'status', 'body', 'missing-location', 'duplicate-location', 'cookie', 'encoding', 'transfer',
    'duplicate-length', 'nonzero-length', 'leading-zero-length',
  ] as const)('rejects artifact redirect framing drift: %s', async (label) => {
    const gate = await loadInstrumentedGate();
    const response: RawResponse = { status: 302,
      rawHeaders: ['Location', 'https://artifact.example/archive', 'Content-Length', '0'],
      body: Buffer.alloc(0) };
    if (label === 'status') response.status = 200;
    if (label === 'body') response.body = Buffer.from('x');
    if (label === 'missing-location') replaceHeader(response, 'Location', []);
    if (label === 'duplicate-location') response.rawHeaders.push('Location', 'https://artifact.example/archive');
    if (label === 'cookie') response.rawHeaders.push('Set-Cookie', 'x=1');
    if (label === 'encoding') response.rawHeaders.push('Content-Encoding', 'gzip');
    if (label === 'transfer') response.rawHeaders.push('Transfer-Encoding', 'chunked');
    if (label === 'duplicate-length') response.rawHeaders.push('Content-Length', '0');
    if (label === 'nonzero-length') replaceHeader(response, 'Content-Length', ['1']);
    if (label === 'leading-zero-length') replaceHeader(response, 'Content-Length', ['00']);
    expect(() => gate.__testArtifactRedirect(response)).toThrow('ret010');
  });

  it.each(['length', 'chunked', 'unframed'] as const)(
    'accepts archive framing allowed by the frozen response profile: %s', async (label) => {
      const gate = await loadInstrumentedGate();
      const body = Buffer.from('zip');
      const response: RawResponse = { status: 200, rawHeaders: [], body };
      if (label === 'length') response.rawHeaders.push('Content-Length', '3');
      if (label === 'chunked') response.rawHeaders.push('Transfer-Encoding', 'chunked');
      expect(gate.__testArchiveResponse(response)).toBe(body);
    },
  );

  it('accepts archive bytes at the exact service cap before ZIP inspection', async () => {
    const gate = await loadInstrumentedGate();
    const body = Buffer.alloc(67_108_864);
    expect(gate.__testArchiveResponse({ status: 200,
      rawHeaders: ['Content-Length', String(body.length)], body })).toBe(body);
  });

  it.each([
    'status', 'location', 'cookie', 'encoding', 'both', 'duplicate-length', 'duplicate-transfer',
    'transfer-case', 'transfer-gzip', 'length-leading-zero', 'length-signed', 'length-space',
    'length-unsafe', 'length-mismatch', 'oversized-body',
  ] as const)('rejects archive framing drift: %s', async (label) => {
    const gate = await loadInstrumentedGate();
    const response: RawResponse = { status: 200, rawHeaders: ['Content-Length', '3'],
      body: Buffer.from('zip') };
    if (label === 'status') response.status = 206;
    if (label === 'location') response.rawHeaders.push('Location', 'https://second.invalid/');
    if (label === 'cookie') response.rawHeaders.push('Set-Cookie', 'x=1');
    if (label === 'encoding') response.rawHeaders.push('Content-Encoding', 'gzip');
    if (label === 'both') response.rawHeaders.push('Transfer-Encoding', 'chunked');
    if (label === 'duplicate-length') response.rawHeaders.push('Content-Length', '3');
    if (label === 'duplicate-transfer') {
      replaceHeader(response, 'Content-Length', []);
      response.rawHeaders.push('Transfer-Encoding', 'chunked', 'Transfer-Encoding', 'chunked');
    }
    if (label === 'transfer-case' || label === 'transfer-gzip') {
      replaceHeader(response, 'Content-Length', []);
      response.rawHeaders.push('Transfer-Encoding', label === 'transfer-case' ? 'Chunked' : 'gzip');
    }
    if (label.startsWith('length-')) replaceHeader(response, 'Content-Length', [{
      'length-leading-zero': '03', 'length-signed': '+3', 'length-space': ' 3',
      'length-unsafe': '9007199254740992', 'length-mismatch': '2',
    }[label]!]);
    if (label === 'oversized-body') {
      response.body = Buffer.alloc(67_108_865);
      replaceHeader(response, 'Content-Length', [String(response.body.length)]);
    }
    expect(() => gate.__testArchiveResponse(response)).toThrow('ret010');
  });

  it('authenticates the service digest before invoking any ZIP inspection callback', async () => {
    const gate = await loadInstrumentedGate();
    const bytes = Buffer.from('not-a-zip');
    let inspections = 0;
    expect(() => gate.__testAuthenticatedArchive(bytes, '0'.repeat(64), () => {
      inspections += 1;
      throw new Error('zip-trap');
    })).toThrow('ret010');
    expect(inspections).toBe(0);
    const expected = digest(bytes);
    expect(() => gate.__testAuthenticatedArchive(bytes, expected, () => {
      inspections += 1;
      throw new Error('zip-trap');
    })).toThrow('zip-trap');
    expect(inspections).toBe(1);
  });

  it('wires service-digest authentication before ZIP inspection in the exact hosted factory', async () => {
    const gate = await loadFactoryOrderingGate();
    const fixture = hostedFixture();
    const responses: RawResponse[] = [
      jsonResponse(fixture.run),
      jsonResponse({ total_count: 2, jobs: fixture.jobs }),
      jsonResponse({ total_count: 2, artifacts: fixture.artifacts }),
      { status: 302, rawHeaders: ['Location', 'https://artifact.example/archive',
        'Content-Length', '0'], body: Buffer.alloc(0) },
      { status: 200, rawHeaders: ['Content-Length', '3'], body: Buffer.from('zip') },
    ];
    const requests: RequestDescriptor[] = [];
    let inspections = 0;
    const verify = gate.createVerifyHostedVerifier({
      transport: { request: async (request) => {
        requests.push(request);
        const response = responses.shift();
        if (!response) throw new Error('unexpected-request');
        return response;
      } },
      __testPins: { 'bench/lab/ret010/dev-policy.json': {
        bytes: await readFile(resolve(ROOT, 'bench/lab/ret010/dev-policy.json')),
      } },
      __testInspect: () => { inspections += 1; throw new Error('zip-trap'); },
    });
    await expect(verify(HOSTED_HEAD, HOSTED_RUN_ID)).rejects.toThrow('ret010');
    expect(inspections).toBe(0);
    expect(requests.map(({ kind, url }) => [kind, url])).toEqual([
      ['metadata', HOSTED_BASE],
      ['metadata', `${HOSTED_BASE}/jobs?per_page=100&page=1`],
      ['metadata', `${HOSTED_BASE}/artifacts?per_page=100&page=1`],
      ['artifact-api', 'https://api.github.com/repos/AP3X-Dev/memberry/actions/artifacts/300/zip'],
      ['archive', 'https://artifact.example/archive'],
    ]);
  });

  it('accepts the complete stored/deflated, descriptor, flag, host, and permission ZIP32 profile', async () => {
    const gate = await loadInstrumentedGate();
    const fixture = zipFixture({
      'recall-lane.json': { madeBy: 0x0014, external: 0 },
      'precision-lane.json': { method: 8, flags: 0x0800 },
      'efficiency-interval.json': { method: 8, flags: 0x0808, descriptor: 'signed' },
      'aggregate-result.json': { flags: 0x0008, descriptor: 'unsigned', madeBy: 0x0014, external: 0x20 },
      'custody-manifest.json': { external: ((0o100000 << 16) >>> 0) },
      'upload-complete.json': { madeBy: 0x032d, external: (((0o100777 << 16) | 0x20) >>> 0) },
    });
    const parsed = gate.__testZip(fixture.bytes);
    expect(Object.keys(parsed).sort()).toEqual([...ZIP_NAMES].sort());
    for (const name of ZIP_NAMES) expect(parsed[name]).toEqual(fixture.contents[name]);
  });

  it('finishes the entire structural walk before reconstructing even a physically-first marker', async () => {
    const gate = await loadInstrumentedGate();
    const order = ['upload-complete.json', ...ZIP_NAMES.slice(0, -1)];
    const fixture = zipFixture({ 'upload-complete.json': { method: 8 } }, order);
    const last = fixture.entries[fixture.entries.length - 1]!;
    fixture.bytes.writeUInt32LE(last.localStart + 1, last.centralStart + 42);
    let reconstructions = 0;
    expect(() => gate.__testZip(fixture.bytes, {
      beforeReconstruct: () => { reconstructions += 1; },
    })).toThrow('ret010');
    expect(reconstructions).toBe(0);
  });

  it('accepts exact 2,000,000-byte entries and the exact 12,000,000-byte aggregate', async () => {
    const gate = await loadInstrumentedGate(); const content = Buffer.alloc(2_000_000);
    const overrides = Object.fromEntries(ZIP_NAMES.map((name) => [name, {
      content, centralCrc: 0, flags: 8, descriptor: 'signed' as const, descriptorCrc: 0,
    }]));
    const fixture = zipFixture(overrides);
    const parsed = gate.__testZip(fixture.bytes, { crc32: () => 0 });
    expect(Object.values(parsed).reduce((total, bytes) => total + bytes.length, 0)).toBe(12_000_000);
  });

  it('rejects one consistent 2,000,001-byte entry while the aggregate remains below 12,000,000', async () => {
    const gate = await loadInstrumentedGate(); const small = Buffer.from('x');
    const above = Buffer.alloc(2_000_001);
    const overrides = Object.fromEntries(ZIP_NAMES.map((name, index) => [name, {
      content: index === 0 ? above : small, centralCrc: 0,
      flags: 8, descriptor: 'signed' as const, descriptorCrc: 0,
    }]));
    const fixture = zipFixture(overrides); let reconstructions = 0;
    expect(() => gate.__testZip(fixture.bytes, {
      beforeReconstruct: () => { reconstructions += 1; }, crc32: () => 0,
    })).toThrow('ret010');
    expect(reconstructions).toBe(0);
  });

  it('tests aggregate arithmetic independently at exact 12,000,000 and 12,000,001', async () => {
    const gate = await loadInstrumentedGate();
    expect(gate.__testZipAggregateSize([2_000_000, 2_000_000, 2_000_000,
      2_000_000, 2_000_000, 2_000_000])).toBe(12_000_000);
    expect(() => gate.__testZipAggregateSize([2_000_001, 2_000_000, 2_000_000,
      2_000_000, 2_000_000, 2_000_000])).toThrow('ret010');
  });

  it('reaches the actual CRC branch for structurally consistent wrong CRC authority', async () => {
    const gate = await loadInstrumentedGate();
    const fixture = zipFixture({ 'recall-lane.json': { centralCrc: 0 } });
    let reconstructions = 0;
    expect(() => gate.__testZip(fixture.bytes, {
      beforeReconstruct: () => { reconstructions += 1; },
    })).toThrow('ret010');
    expect(reconstructions).toBe(1);
  });

  it.each([
    ['needed-19', (zip: ZipFixture) => zip.bytes.writeUInt16LE(19, zip.entries[0]!.centralStart + 6)],
    ['needed-21-local', (zip: ZipFixture) => zip.bytes.writeUInt16LE(21, zip.entries[0]!.localStart + 4)],
    ['made-by-host', (zip: ZipFixture) => zip.bytes.writeUInt16LE(0x0214, zip.entries[0]!.centralStart + 4)],
    ['made-by-version', (zip: ZipFixture) => zip.bytes.writeUInt16LE(0x0315, zip.entries[0]!.centralStart + 4)],
    ['internal-attribute', (zip: ZipFixture) => zip.bytes.writeUInt16LE(1, zip.entries[0]!.centralStart + 36)],
    ['dos-external', (zip: ZipFixture) => {
      zip.bytes.writeUInt16LE(0x0014, zip.entries[0]!.centralStart + 4);
      zip.bytes.writeUInt32LE(1, zip.entries[0]!.centralStart + 38);
    }],
    ['unix-directory', (zip: ZipFixture) => zip.bytes.writeUInt32LE((0o040755 << 16) >>> 0,
      zip.entries[0]!.centralStart + 38)],
    ['unix-link', (zip: ZipFixture) => zip.bytes.writeUInt32LE((0o120777 << 16) >>> 0,
      zip.entries[0]!.centralStart + 38)],
    ['unix-special-bit', (zip: ZipFixture) => zip.bytes.writeUInt32LE((0o104600 << 16) >>> 0,
      zip.entries[0]!.centralStart + 38)],
    ['unix-lower-attribute', (zip: ZipFixture) => zip.bytes.writeUInt32LE(((0o100600 << 16) | 1) >>> 0,
      zip.entries[0]!.centralStart + 38)],
    ['forbidden-flag', (zip: ZipFixture) => zip.bytes.writeUInt16LE(1, zip.entries[0]!.centralStart + 8)],
    ['method', (zip: ZipFixture) => zip.bytes.writeUInt16LE(9, zip.entries[0]!.centralStart + 10)],
    ['extra', (zip: ZipFixture) => zip.bytes.writeUInt16LE(1, zip.entries[0]!.centralStart + 30)],
    ['comment', (zip: ZipFixture) => zip.bytes.writeUInt16LE(1, zip.entries[0]!.centralStart + 32)],
    ['disk-start', (zip: ZipFixture) => zip.bytes.writeUInt16LE(1, zip.entries[0]!.centralStart + 34)],
    ['entry-cap', (zip: ZipFixture) => zip.bytes.writeUInt32LE(2_000_001,
      zip.entries[0]!.centralStart + 24)],
    ['zip32-size-sentinel', (zip: ZipFixture) => zip.bytes.writeUInt32LE(0xffffffff,
      zip.entries[0]!.centralStart + 20)],
    ['zip32-offset-sentinel', (zip: ZipFixture) => zip.bytes.writeUInt32LE(0xffffffff,
      zip.entries[0]!.centralStart + 42)],
    ['local-extra', (zip: ZipFixture) => zip.bytes.writeUInt16LE(1, zip.entries[0]!.localStart + 28)],
    ['local-method-mismatch', (zip: ZipFixture) => zip.bytes.writeUInt16LE(8, zip.entries[0]!.localStart + 8)],
    ['local-flag-mismatch', (zip: ZipFixture) => zip.bytes.writeUInt16LE(0x0800,
      zip.entries[0]!.localStart + 6)],
    ['local-crc-mismatch', (zip: ZipFixture) => zip.bytes.writeUInt32LE(0,
      zip.entries[0]!.localStart + 14)],
    ['local-size-mismatch', (zip: ZipFixture) => zip.bytes.writeUInt32LE(0,
      zip.entries[0]!.localStart + 18)],
    ['local-uncompressed-mismatch', (zip: ZipFixture) => zip.bytes.writeUInt32LE(0,
      zip.entries[0]!.localStart + 22)],
  ] as const)('rejects exact ZIP32 header/profile drift: %s', async (_label, mutate) => {
    const gate = await loadInstrumentedGate(); const fixture = zipFixture();
    mutate(fixture);
    expect(() => gate.__testZip(fixture.bytes)).toThrow('ret010');
  });

  it('rejects every non-profile made-by host/version component and every forbidden flag bit', async () => {
    const gate = await loadInstrumentedGate(); const baseline = zipFixture(); const first = baseline.entries[0]!;
    for (let host = 0; host <= 0xff; host += 1) {
      if (host === 0 || host === 3) continue;
      const bytes = Buffer.from(baseline.bytes); bytes.writeUInt16LE((host << 8) | 20, first.centralStart + 4);
      expect(() => gate.__testZip(bytes)).toThrow('ret010');
    }
    for (const host of [0, 3]) {
      for (let version = 0; version <= 0xff; version += 1) {
        if (version === 20 || (host === 3 && version === 45)) continue;
        const bytes = Buffer.from(baseline.bytes);
        bytes.writeUInt16LE((host << 8) | version, first.centralStart + 4);
        expect(() => gate.__testZip(bytes)).toThrow('ret010');
      }
    }
    for (let bitIndex = 0; bitIndex < 16; bitIndex += 1) {
      const bit = 2 ** bitIndex;
      if (bit === 0x0008 || bit === 0x0800) continue;
      const bytes = Buffer.from(baseline.bytes);
      bytes.writeUInt16LE(bit, first.centralStart + 8); bytes.writeUInt16LE(bit, first.localStart + 6);
      expect(() => gate.__testZip(bytes)).toThrow('ret010');
    }
  });

  it.each([
    ['fifo', 0o010600], ['character-device', 0o020600], ['block-device', 0o060600],
    ['socket', 0o140600], ['setuid', 0o104600], ['setgid', 0o102600], ['sticky', 0o101600],
  ] as const)('rejects Unix non-regular/special mode: %s', async (_label, mode) => {
    const gate = await loadInstrumentedGate(); const fixture = zipFixture();
    fixture.bytes.writeUInt32LE((mode << 16) >>> 0, fixture.entries[0]!.centralStart + 38);
    expect(() => gate.__testZip(fixture.bytes)).toThrow('ret010');
  });

  it.each([
    ['lossy-high-bit-local-name', (zip: ZipFixture) => { zip.bytes[zip.entries[0]!.localNameStart] = 0xf2; }],
    ['nested-matching-name', (zip: ZipFixture) => {
      zip.bytes[zip.entries[0]!.centralNameStart + 6] = 0x2f;
      zip.bytes[zip.entries[0]!.localNameStart + 6] = 0x2f;
    }],
    ['alternate-separator-matching-name', (zip: ZipFixture) => {
      zip.bytes[zip.entries[0]!.centralNameStart + 6] = 0x5c;
      zip.bytes[zip.entries[0]!.localNameStart + 6] = 0x5c;
    }],
    ['non-ascii-matching-name', (zip: ZipFixture) => {
      zip.bytes[zip.entries[0]!.centralNameStart] = 0x80;
      zip.bytes[zip.entries[0]!.localNameStart] = 0x80;
    }],
    ['duplicate-central-name', (zip: ZipFixture) => {
      const first = zip.entries[3]!; const second = zip.entries[4]!;
      zip.bytes.copy(zip.bytes, second.centralNameStart, first.centralNameStart,
        first.centralNameStart + Buffer.byteLength(first.id));
      zip.bytes.copy(zip.bytes, second.localNameStart, first.localNameStart,
        first.localNameStart + Buffer.byteLength(first.id));
    }],
  ] as const)('rejects byte/path/name ambiguity: %s', async (_label, mutate) => {
    const gate = await loadInstrumentedGate(); const fixture = zipFixture();
    mutate(fixture);
    expect(() => gate.__testZip(fixture.bytes)).toThrow('ret010');
  });

  it.each([
    ['descriptor-local-authority', () => zipFixture({ 'recall-lane.json': {
      flags: 8, descriptor: 'signed', localCrc: 1,
    } })],
    ['descriptor-local-compressed-authority', () => zipFixture({ 'recall-lane.json': {
      flags: 8, descriptor: 'signed', localCompressed: 1,
    } })],
    ['descriptor-local-uncompressed-authority', () => zipFixture({ 'recall-lane.json': {
      flags: 8, descriptor: 'signed', localUncompressed: 1,
    } })],
    ['descriptor-crc', () => zipFixture({ 'recall-lane.json': {
      flags: 8, descriptor: 'signed', descriptorCrc: 1,
    } })],
    ['descriptor-compressed', () => zipFixture({ 'recall-lane.json': {
      flags: 8, descriptor: 'signed', descriptorCompressed: 1,
    } })],
    ['descriptor-uncompressed', () => zipFixture({ 'recall-lane.json': {
      flags: 8, descriptor: 'signed', descriptorUncompressed: 1,
    } })],
    ['descriptor-missing', () => zipFixture({ 'recall-lane.json': {
      flags: 8, descriptor: false,
    } })],
    ['descriptor-when-bit-clear', () => zipFixture({ 'recall-lane.json': {
      flags: 0, descriptor: 'signed',
    } })],
    ['unsigned-signature-ambiguity', () => zipFixture({ 'recall-lane.json': {
      flags: 8, descriptor: 'unsigned', centralCrc: 0x08074b50, descriptorCrc: 0x08074b50,
    } })],
    ['deflate-trailing-input', () => zipFixture({ 'recall-lane.json': {
      method: 8, compressedSuffix: Buffer.from([0]),
    } })],
    ['deflate-output-underrun', () => zipFixture({ 'recall-lane.json': {
      method: 8, centralUncompressed: 100,
    } })],
    ['deflate-output-overrun', () => zipFixture({ 'recall-lane.json': {
      method: 8, centralUncompressed: 1,
    } })],
    ['deflate-truncated-eof', () => zipFixture({ 'recall-lane.json': {
      method: 8, compressedTruncate: 1,
    } })],
    ['stored-size-contradiction', () => zipFixture({ 'recall-lane.json': {
      centralUncompressed: 1, localUncompressed: 1,
    } })],
  ] as const)('rejects descriptor/inflate authority drift: %s', async (_label, create) => {
    const gate = await loadInstrumentedGate();
    expect(() => gate.__testZip(create().bytes)).toThrow('ret010');
  });

  it.each([
    ['offset-not-derived', (zip: ZipFixture) => zip.bytes.writeUInt32LE(1,
      zip.entries[0]!.centralStart + 42)],
    ['duplicate-start', (zip: ZipFixture) => zip.bytes.writeUInt32LE(zip.entries[0]!.localStart,
      zip.entries[1]!.centralStart + 42)],
    ['central-size-gap', (zip: ZipFixture) => zip.bytes.writeUInt32LE(zip.eocd - zip.centralStart - 1,
      zip.eocd + 12)],
    ['central-start-overlap', (zip: ZipFixture) => zip.bytes.writeUInt32LE(zip.centralStart - 1,
      zip.eocd + 16)],
    ['zip64-central-size-sentinel', (zip: ZipFixture) => zip.bytes.writeUInt32LE(0xffffffff,
      zip.eocd + 12)],
    ['zip64-central-start-sentinel', (zip: ZipFixture) => zip.bytes.writeUInt32LE(0xffffffff,
      zip.eocd + 16)],
    ['multi-disk', (zip: ZipFixture) => zip.bytes.writeUInt16LE(1, zip.eocd + 4)],
    ['central-directory-disk', (zip: ZipFixture) => zip.bytes.writeUInt16LE(1, zip.eocd + 6)],
    ['entries-on-disk', (zip: ZipFixture) => zip.bytes.writeUInt16LE(5, zip.eocd + 8)],
    ['count', (zip: ZipFixture) => zip.bytes.writeUInt16LE(5, zip.eocd + 10)],
    ['comment', (zip: ZipFixture) => zip.bytes.writeUInt16LE(1, zip.eocd + 20)],
  ] as const)('rejects offset/range/EOCD accounting drift: %s', async (_label, mutate) => {
    const gate = await loadInstrumentedGate(); const fixture = zipFixture(); mutate(fixture);
    expect(() => gate.__testZip(fixture.bytes)).toThrow('ret010');
  });

  it('accepts raw EOCD signature bytes inside an authenticated payload', async () => {
    const gate = await loadInstrumentedGate();
    const content = Buffer.from([0x50, 0x4b, 0x05, 0x06, 0x0a]);
    const fixture = zipFixture({ 'recall-lane.json': { content } });
    expect(gate.__testZip(fixture.bytes)['recall-lane.json']).toEqual(content);
  });

  it('rejects every structurally unaccounted prefix, suffix, and appended EOCD record', async () => {
    const gate = await loadInstrumentedGate(); const fixture = zipFixture();
    expect(() => gate.__testZip(Buffer.concat([Buffer.from([0]), fixture.bytes]))).toThrow('ret010');
    expect(() => gate.__testZip(Buffer.concat([fixture.bytes, Buffer.from([0])]))).toThrow('ret010');
    const appendedEocd = Buffer.concat([fixture.bytes, fixture.bytes.subarray(fixture.eocd)]);
    expect(() => gate.__testZip(appendedEocd)).toThrow('ret010');
  });

  it('reconstructs the exact marker leaf and rereads every retained destination byte', async () => {
    const gate = await loadInstrumentedGate(); const fixture = zipFixture();
    const marker = { uploadLeafName: `ret010-upload-${'a'.repeat(64)}`, allowlist: [...ZIP_NAMES] };
    const leaf = await gate.__testExtractVerifiedBundle(fixture.contents, marker);
    temporaryRoots.push(resolve(leaf, '..'));
    expect(leaf.endsWith(marker.uploadLeafName)).toBe(true);
    for (const name of ZIP_NAMES) expect(await readFile(resolve(leaf, name))).toEqual(fixture.contents[name]);
  });

  it.each([
    ['marker-prefix', { uploadLeafName: `wrong-${'a'.repeat(64)}`, allowlist: [...ZIP_NAMES] }],
    ['marker-uppercase', { uploadLeafName: `ret010-upload-${'A'.repeat(64)}`, allowlist: [...ZIP_NAMES] }],
    ['marker-nested', { uploadLeafName: `ret010-upload-${'a'.repeat(63)}/a`, allowlist: [...ZIP_NAMES] }],
    ['allowlist-reordered', { uploadLeafName: `ret010-upload-${'a'.repeat(64)}`,
      allowlist: [...ZIP_NAMES].reverse() }],
    ['allowlist-missing', { uploadLeafName: `ret010-upload-${'a'.repeat(64)}`,
      allowlist: ZIP_NAMES.slice(0, -1) }],
  ] as const)('rejects marker leaf/allowlist substitution: %s', async (_label, marker) => {
    const gate = await loadInstrumentedGate(); const fixture = zipFixture();
    await expect(gate.__testExtractVerifiedBundle(fixture.contents,
      marker as unknown as Record<string, unknown>)).rejects.toThrow('ret010');
  });

  it('rejects missing, extra, and non-buffer extracted source sets before creating a parent', async () => {
    const gate = await loadInstrumentedGate(); const fixture = zipFixture();
    const marker = { uploadLeafName: `ret010-upload-${'e'.repeat(64)}`, allowlist: [...ZIP_NAMES] };
    const missing = { ...fixture.contents }; delete missing['recall-lane.json'];
    const extra = { ...fixture.contents, 'extra.json': Buffer.from('{}\n') };
    const nonBuffer = { ...fixture.contents, 'recall-lane.json': 'not-bytes' } as unknown as Record<string, Buffer>;
    await expect(gate.__testExtractVerifiedBundle(missing, marker)).rejects.toThrow('ret010');
    await expect(gate.__testExtractVerifiedBundle(extra, marker)).rejects.toThrow('ret010');
    await expect(gate.__testExtractVerifiedBundle(nonBuffer, marker)).rejects.toThrow('ret010');
  });

  it('rejects extraction collision and closes each retained directory owner once', async () => {
    const gate = await loadInstrumentedGate(); const fixture = zipFixture();
    const marker = { uploadLeafName: `ret010-upload-${'b'.repeat(64)}`, allowlist: [...ZIP_NAMES] };
    const attempts: object[] = []; let parent = '';
    await expect(gate.__testExtractVerifiedBundle(fixture.contents, marker, {
      beforeCreateFile: async ({ leaf, absolute }) => {
        parent = resolve(leaf, '..'); await writeFile(absolute, 'collision');
      },
      closeHandle: async (owner) => { attempts.push(owner); await owner.handle.close(); },
    })).rejects.toThrow();
    if (parent) temporaryRoots.push(parent);
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts).size).toBe(2);
  });

  it('rejects destination substitution and still closes every acquired owner once', async () => {
    const gate = await loadInstrumentedGate(); const fixture = zipFixture();
    const marker = { uploadLeafName: `ret010-upload-${'c'.repeat(64)}`, allowlist: [...ZIP_NAMES] };
    const attempts: object[] = []; let parent = ''; let injected = false;
    await expect(gate.__testExtractVerifiedBundle(fixture.contents, marker, {
      beforeCreateFile: async ({ leaf }) => { parent = resolve(leaf, '..'); },
      afterWrite: async ({ absolute }) => {
        if (!injected) { injected = true; await writeFile(absolute, 'substituted'); }
      },
      closeHandle: async (owner) => { attempts.push(owner); await owner.handle.close(); },
    })).rejects.toThrow();
    if (parent) temporaryRoots.push(parent);
    expect(attempts).toHaveLength(3);
    expect(new Set(attempts).size).toBe(3);
  });

  it('pins all archive sources before extraction and rejects later caller-buffer mutation', async () => {
    const gate = await loadInstrumentedGate(); const fixture = zipFixture();
    const marker = { uploadLeafName: `ret010-upload-${'f'.repeat(64)}`, allowlist: [...ZIP_NAMES] };
    const attempts: object[] = []; let parent = ''; let injected = false;
    await expect(gate.__testExtractVerifiedBundle(fixture.contents, marker, {
      beforeCreateFile: async ({ leaf }) => { parent = resolve(leaf, '..'); },
      afterWrite: async () => {
        if (!injected) {
          injected = true; const source = fixture.contents['upload-complete.json']!;
          source[0] = source[0]! ^ 0xff;
        }
      },
      closeHandle: async (owner) => { attempts.push(owner); await owner.handle.close(); },
    })).rejects.toThrow('ret010');
    if (parent) temporaryRoots.push(parent);
    expect(attempts).toHaveLength(8);
    expect(new Set(attempts).size).toBe(8);
  });

  it.each(['write', 'read'] as const)('rejects a partial extraction %s and closes all acquired owners',
    async (operation) => {
      const gate = await loadInstrumentedGate(); const fixture = zipFixture();
      const marker = { uploadLeafName: `ret010-upload-${(operation === 'write' ? '1' : '2').repeat(64)}`,
        allowlist: [...ZIP_NAMES] };
      const attempts: object[] = []; let parent = '';
      await expect(gate.__testExtractVerifiedBundle(fixture.contents, marker, {
        beforeCreateFile: async ({ leaf }) => { parent = resolve(leaf, '..'); },
        ...(operation === 'write'
          ? { writeDestination: async (_owner: unknown, source: Buffer) => ({ bytesWritten: source.length - 1 }) }
          : { readDestination: async (_owner: unknown, destination: Buffer) => ({
            bytesRead: destination.length - 1,
          }) }),
        closeHandle: async (owner) => { attempts.push(owner); await owner.handle.close(); },
      })).rejects.toThrow('ret010');
      if (parent) temporaryRoots.push(parent);
      expect(attempts).toHaveLength(3);
      expect(new Set(attempts).size).toBe(3);
    });

  it('rejects a destination path swap during close after archive authentication', async () => {
    const gate = await loadInstrumentedGate(); const fixture = authenticatedSemanticBundle();
    const attempts: object[] = []; let parent = ''; let swapped = false;
    await expect(gate.__testVerifyAuthenticatedBundle(fixture.archive.bytes, digest(fixture.archive.bytes),
      { head: HOSTED_HEAD, major: '20', runId: '1000', attempt: '2' }, { extraction: {
        beforeCreateFile: async ({ leaf }: { leaf: string }) => { parent = resolve(leaf, '..'); },
        closeHandle: async (owner: { name?: string; absolute: string; handle: { close(): Promise<void> } }) => {
          attempts.push(owner); await owner.handle.close();
          if (!swapped && owner.name === 'upload-complete.json') {
            swapped = true; await rm(owner.absolute, { force: true });
            await writeFile(owner.absolute, 'replacement');
          }
        },
      },
      })).rejects.toThrow('ret010');
    if (parent) temporaryRoots.push(parent);
    expect(attempts).toHaveLength(16);
    expect(new Set(attempts).size).toBe(16);
  });

  it('rejects same-inode destination byte mutation during close after archive authentication', async () => {
    const gate = await loadInstrumentedGate(); const fixture = authenticatedSemanticBundle();
    const attempts: object[] = []; let parent = ''; let mutated = false;
    await expect(gate.__testVerifyAuthenticatedBundle(fixture.archive.bytes, digest(fixture.archive.bytes),
      { head: HOSTED_HEAD, major: '20', runId: '1000', attempt: '2' }, { extraction: {
        beforeCreateFile: async ({ leaf }: { leaf: string }) => { parent = resolve(leaf, '..'); },
        closeHandle: async (owner: { name?: string; absolute: string; handle: { close(): Promise<void> } }) => {
          attempts.push(owner); await owner.handle.close();
          if (!mutated && owner.name === 'upload-complete.json') {
            mutated = true;
            await writeFile(owner.absolute, Buffer.alloc(fixture.records['upload-complete.json']!.length, 0x20));
          }
        },
      } })).rejects.toThrow('ret010');
    if (parent) temporaryRoots.push(parent);
    expect(attempts).toHaveLength(16);
    expect(new Set(attempts).size).toBe(16);
  });

  it.each(CLOSE_OWNER_ORDINALS)(
    'rejects close-time mutation at explicit owner/stage ordinal %s', async (targetOrdinal) => {
      const gate = await loadInstrumentedGate(); const fixture = authenticatedSemanticBundle();
      const attempts: object[] = []; let leaf = ''; let injected = false;
      await expect(gate.__testVerifyAuthenticatedBundle(fixture.archive.bytes, digest(fixture.archive.bytes),
        { head: HOSTED_HEAD, major: '20', runId: '1000', attempt: '2' }, { extraction: {
          beforeCreateFile: async (value: { leaf: string }) => { leaf = value.leaf; },
          closeHandle: async (owner: { name?: string; kind: 'file' | 'directory'; absolute: string;
            handle: { close(): Promise<void> } }) => {
            attempts.push(owner); await owner.handle.close();
            if (attempts.length !== targetOrdinal) return;
            injected = true;
            if (owner.kind === 'directory') {
              if (targetOrdinal % 8 === 7) {
                await writeFile(resolve(leaf, `extra-${targetOrdinal}.json`), 'extra');
              } else await rm(resolve(leaf, 'recall-lane.json'), { force: true });
            } else if (targetOrdinal % 2 === 0) {
              const source = fixture.records[owner.name!]!;
              await rm(owner.absolute, { force: true }); await writeFile(owner.absolute, source);
            } else {
              const source = fixture.records[owner.name!]!;
              await writeFile(owner.absolute, Buffer.alloc(source.length, 0x20));
            }
          },
        } })).rejects.toThrow('ret010');
      if (leaf) temporaryRoots.push(resolve(leaf, '..'));
      expect(injected).toBe(true);
      expect(attempts.length).toBeGreaterThanOrEqual(targetOrdinal);
      expect(new Set(attempts).size).toBe(attempts.length);
    },
  );

  it.each(CLOSE_OWNER_ORDINALS)(
    'drains the complete explicit stage after close failure at owner ordinal %s', async (targetOrdinal) => {
      const gate = await loadInstrumentedGate(); const fixture = zipFixture();
      const marker = { uploadLeafName: `ret010-upload-${targetOrdinal.toString(16).padStart(64, '0')}`,
        allowlist: [...ZIP_NAMES] };
      const attempts: object[] = []; let parent = '';
      await expect(gate.__testExtractVerifiedBundle(fixture.contents, marker, {
        beforeCreateFile: async ({ leaf }) => { parent = resolve(leaf, '..'); },
        closeHandle: async (owner) => {
          attempts.push(owner); await owner.handle.close();
          if (attempts.length === targetOrdinal) throw new Error('injected-close-failure');
        },
      })).rejects.toThrow();
      if (parent) temporaryRoots.push(parent);
      expect(attempts).toHaveLength(Math.ceil(targetOrdinal / 8) * 8);
      expect(new Set(attempts).size).toBe(attempts.length);
    },
  );

  it.each([1, 6, 7, 12, 13, 18] as const)(
    'rejects partial explicit read at custody read ordinal %s', async (targetRead) => {
      const gate = await loadInstrumentedGate(); const fixture = zipFixture();
      const marker = { uploadLeafName: `ret010-upload-${targetRead.toString(16).padStart(64, '0')}`,
        allowlist: [...ZIP_NAMES] };
      let reads = 0; let parent = '';
      await expect(gate.__testExtractVerifiedBundle(fixture.contents, marker, {
        beforeCreateFile: async ({ leaf }) => { parent = resolve(leaf, '..'); },
        readDestination: async (owner: unknown, destination: Buffer) => {
          reads += 1;
          const value = owner as { handle: { read(buffer: Buffer, offset: number,
            length: number, position: number): Promise<{ bytesRead: number }> } };
          if (reads === targetRead) return { bytesRead: Math.max(0, destination.length - 1) };
          return value.handle.read(destination, 0, destination.length, 0);
        },
      })).rejects.toThrow('ret010');
      if (parent) temporaryRoots.push(parent);
      expect(reads).toBe(targetRead);
    },
  );

  it('accepts the exact final unhooked post-close filesystem state', async () => {
    const gate = await loadInstrumentedGate(); const fixture = await postCloseAuditFixture();
    temporaryRoots.push(fixture.parent);
    await expect(gate.__testPostCloseBundleAudit(fixture.leaf, fixture.identities)).resolves.toBeUndefined();
  });

  it.each(['partial-read', 'implicit-close-error'] as const)(
    'rejects final unhooked post-close I/O failure: %s', async (failure) => {
      const gate = await loadInstrumentedGate(); const fixture = await postCloseAuditFixture();
      temporaryRoots.push(fixture.parent);
      const io = {
        ...fsPromises,
        readFile: failure === 'partial-read'
          ? async (absolute: string) => (await readFile(absolute)).subarray(0, -1)
          : async () => { throw new Error('injected-implicit-close-error'); },
      };
      const pending = gate.__testPostCloseBundleAudit(fixture.leaf, fixture.identities, io);
      if (failure === 'partial-read') await expect(pending).rejects.toThrow('ret010');
      else await expect(pending).rejects.toThrow('injected-implicit-close-error');
    },
  );

  it('supplies effective O_NOFOLLOW when a regular path becomes a symlink between lstat and open', async () => {
    const syntheticNoFollow = 0x20000;
    const syntheticFlagPlumbing = process.platform !== 'linux';
    const expectedNoFollow = syntheticFlagPlumbing ? syntheticNoFollow : fsConstants.O_NOFOLLOW;
    if (!syntheticFlagPlumbing) {
      expect(typeof fsConstants.O_NOFOLLOW).toBe('number');
      expect(fsConstants.O_NOFOLLOW).not.toBe(0);
    }
    const gate = await loadInstrumentedGate(syntheticFlagPlumbing
      ? (source) => source.replaceAll('fs.constants.O_NOFOLLOW', String(syntheticNoFollow))
      : undefined);
    const fixture = await postCloseAuditFixture();
    temporaryRoots.push(fixture.parent);
    const audited = resolve(fixture.leaf, 'recall-lane.json');
    const parked = resolve(fixture.parent, 'recall-lane.parked');
    const target = resolve(fixture.parent, 'nofollow-target.json');
    const probeTarget = resolve(fixture.parent, 'nofollow-probe-target.json');
    const probeLink = resolve(fixture.parent, 'nofollow-probe-link.json');
    const identity = fixture.identities.find((value) => value.absolute === audited)!;
    await writeFile(target, identity.source as Buffer);
    await writeFile(probeTarget, Buffer.from('symlink-capability-probe'));
    try {
      await symlink(probeTarget, probeLink, 'file');
      expect((await lstat(probeLink)).isSymbolicLink()).toBe(true);
    } finally {
      await rm(probeLink, { force: true });
    }
    let observedFlag: unknown; let openedTarget = false; let raceSymlinkCreated = false;
    const io = {
      ...fsPromises,
      readFile: async (absolute: string, options: { flag?: number } = {}) => {
        if (absolute !== audited) return fsPromises.readFile(absolute, options);
        observedFlag = options.flag;
        let moved = false;
        try {
          await rename(audited, parked);
          moved = true;
          await symlink(target, audited, 'file');
          raceSymlinkCreated = true;
          if (syntheticFlagPlumbing
            && typeof options.flag === 'number'
            && (options.flag & syntheticNoFollow) === syntheticNoFollow) {
            const error = new Error('synthetic O_NOFOLLOW rejection') as NodeJS.ErrnoException;
            error.code = 'ELOOP';
            throw error;
          }
          const bytes = await fsPromises.readFile(audited, options);
          openedTarget = true;
          return bytes;
        } finally {
          if (moved) {
            try { await rm(audited, { force: true }); }
            finally { await rename(parked, audited); }
          }
        }
      },
    };
    await expect(gate.__testPostCloseBundleAudit(fixture.leaf, fixture.identities, io)).rejects.toThrow();
    expect(raceSymlinkCreated).toBe(true);
    expect(typeof observedFlag).toBe('number');
    expect(expectedNoFollow).not.toBe(0);
    expect(observedFlag).toBe(fsConstants.O_RDONLY | expectedNoFollow);
    expect(openedTarget).toBe(false);
    const restored = await lstat(audited);
    expect(restored.isFile()).toBe(true);
    expect(restored.isSymbolicLink()).toBe(false);
    expect(await readFile(audited)).toEqual(identity.source as Buffer);
  });

  it('drains all retained extraction owners once after an injected close failure', async () => {
    const gate = await loadInstrumentedGate(); const fixture = zipFixture();
    const marker = { uploadLeafName: `ret010-upload-${'d'.repeat(64)}`, allowlist: [...ZIP_NAMES] };
    const attempts: object[] = []; let parent = ''; let injected = false;
    await expect(gate.__testExtractVerifiedBundle(fixture.contents, marker, {
      beforeCreateFile: async ({ leaf }) => { parent = resolve(leaf, '..'); },
      closeHandle: async (owner) => {
        attempts.push(owner); await owner.handle.close();
        if (!injected) { injected = true; throw new Error('injected-close-failure'); }
      },
    })).rejects.toThrow();
    if (parent) temporaryRoots.push(parent);
    expect(attempts).toHaveLength(8);
    expect(new Set(attempts).size).toBe(8);
  });

  it('executes the real authenticated ZIP-to-marker-to-extraction-to-semantic composition', async () => {
    const gate = await loadInstrumentedGate(); const fixture = authenticatedSemanticBundle();
    const attempts: object[] = []; let parent = '';
    const bundle = await gate.__testVerifyAuthenticatedBundle(fixture.archive.bytes,
      digest(fixture.archive.bytes), { head: HOSTED_HEAD, major: '20', runId: '1000', attempt: '2' }, {
        extraction: {
          beforeCreateFile: async ({ leaf }: { leaf: string }) => { parent = resolve(leaf, '..'); },
          closeHandle: async (owner: { handle: { close(): Promise<void> } }) => {
            attempts.push(owner); await owner.handle.close();
          },
        },
      });
    if (parent) temporaryRoots.push(parent);
    expect(bundle.marker).toMatchObject({ uploadLeafName: fixture.marker.uploadLeafName });
    expect(attempts).toHaveLength(24);
    expect(new Set(attempts).size).toBe(24);
  });

  it('extracts and closes before trusting a marker-consistent but semantically invalid payload', async () => {
    const gate = await loadInstrumentedGate();
    const fixture = authenticatedSemanticBundle((state) => { state.aggregate.safety.staleLeakRate = 0.001; });
    const attempts: object[] = []; let parent = '';
    await expect(gate.__testVerifyAuthenticatedBundle(fixture.archive.bytes,
      digest(fixture.archive.bytes), { head: HOSTED_HEAD, major: '20', runId: '1000', attempt: '2' }, {
        extraction: {
          beforeCreateFile: async ({ leaf }: { leaf: string }) => { parent = resolve(leaf, '..'); },
          closeHandle: async (owner: { handle: { close(): Promise<void> } }) => {
            attempts.push(owner); await owner.handle.close();
          },
        },
      })).rejects.toThrow('ret010');
    if (parent) temporaryRoots.push(parent);
    expect(attempts).toHaveLength(24);
    expect(new Set(attempts).size).toBe(24);
  });

  it('wires production through the sole authenticated bundle composition after archive framing', async () => {
    const source = await readFile(GATE, 'utf8');
    const factory = source.slice(source.indexOf('function createVerifyHostedVerifier'),
      source.indexOf('\nfunction environmentPolicy'));
    expect(factory).toContain('await verifyAuthenticatedBundle(archiveBytes, selected[major].digest');
    expect(factory).not.toContain('verifyBundle(files');
    expect(factory).not.toContain('extractVerifiedBundle(files');
    expect(source).toContain('await postCloseBundleAudit(firstCustody.leaf, sealedIdentities);');
    expect(source).toContain('const bytes = await io.readFile(absolute, {');
  });

  it.each([0, 1, 99, 100, 101, 999, 1000] as const)(
    'fetches the exact total-derived pagination for %s records', async (total) => {
      const gate = await loadInstrumentedGate();
      const fixture = pageFixture(total, 'jobs');
      const entries = await gate.__testPages(fixture.transport, HOSTED_BASE, 'jobs');
      expect(entries).toHaveLength(total);
      expect(fixture.calls).toHaveLength(Math.max(1, Math.ceil(total / 100)));
      expect(entries.map(({ id }) => id)).toEqual(
        Array.from({ length: total }, (_, index) => String(index + 1)));
    },
  );

  it('rejects total 1001 before requesting a second page', async () => {
    const gate = await loadInstrumentedGate();
    const fixture = pageFixture(1001, 'artifacts');
    await expect(gate.__testPages(fixture.transport, HOSTED_BASE, 'artifacts')).rejects.toThrow('ret010');
    expect(fixture.calls).toHaveLength(1);
  });

  it.each([
    ['unsafe', Number.MAX_SAFE_INTEGER + 1], ['fractional', 1.5], ['negative', -1],
    ['string', '1'], ['null', null], ['missing', undefined], ['duplicate', 'duplicate'],
  ] as const)('rejects noncanonical pagination total: %s', async (_label, value) => {
    const gate = await loadInstrumentedGate();
    const transport = { request: async () => {
      if (value === 'duplicate') {
        const body = Buffer.from('{"total_count":0,"total_count":0,"jobs":[]}');
        return jsonResponse(body);
      }
      const body: Record<string, unknown> = { jobs: [] };
      if (value !== undefined) body.total_count = value;
      return jsonResponse(body);
    } };
    await expect(gate.__testPages(transport, HOSTED_BASE, 'jobs')).rejects.toThrow('ret010');
  });

  it.each([
    'missing-next', 'next-on-final', 'gap', 'cycle', 'duplicate-link-header', 'duplicate-next',
    'comma-without-space', 'query-order', 'encoded-query', 'wrong-origin', 'wrong-path',
    'extra-parameter', 'relation-case', 'unquoted-relation', 'multi-relation', 'unknown-relation',
    'empty-member', 'unstable-total', 'missing-record', 'extra-record', 'duplicate-id',
  ] as const)('rejects pagination/link authority drift: %s', async (label) => {
    const gate = await loadInstrumentedGate();
    const total = label === 'next-on-final' ? 1 : 101;
    const fixture = pageFixture(total, 'jobs', (response, page, last) => {
      const linkIndex = response.rawHeaders.findIndex((value) => value.toLowerCase() === 'link');
      const canonical = canonicalPageLink('jobs', page, last);
      if (label === 'missing-next' && page === 1) replaceHeader(response, 'Link', []);
      if (label === 'next-on-final') replaceHeader(response, 'Link', [
        '<https://api.github.com/repos/AP3X-Dev/memberry/actions/runs/1000/jobs?per_page=100&page=2>; rel="next"',
      ]);
      if (page === 1 && canonical && ['gap', 'cycle', 'duplicate-next', 'comma-without-space',
        'query-order', 'encoded-query', 'wrong-origin', 'wrong-path', 'extra-parameter',
        'relation-case', 'unquoted-relation', 'multi-relation', 'unknown-relation',
        'empty-member'].includes(label)) {
        const variants: Record<string, string> = {
          gap: canonical.replace('page=2', 'page=3'), cycle: canonical.replace('page=2', 'page=1'),
          'duplicate-next': `${canonical}, <https://api.github.com/repos/AP3X-Dev/memberry/actions/runs/1000/jobs?per_page=100&page=2>; rel="next"`,
          'comma-without-space': canonical.replace(', ', ','),
          'query-order': canonical.replace('per_page=100&page=2', 'page=2&per_page=100'),
          'encoded-query': canonical.replace('page=2', 'page=%32'),
          'wrong-origin': canonical.replace('https://api.github.com', 'https://github.com'),
          'wrong-path': canonical.replace('/jobs?', '/artifacts?'),
          'extra-parameter': canonical.replace('; rel="next"', '; rel="next"; x="1"'),
          'relation-case': canonical.replace('rel="next"', 'rel="Next"'),
          'unquoted-relation': canonical.replace('rel="next"', 'rel=next'),
          'multi-relation': canonical.replace('rel="next"', 'rel="next last"'),
          'unknown-relation': canonical.replace('rel="next"', 'rel="up"'),
          'empty-member': `${canonical}, `,
        };
        replaceHeader(response, 'Link', [variants[label]!]);
      }
      if (label === 'duplicate-link-header' && page === 1 && linkIndex >= 0) {
        response.rawHeaders.push('Link', response.rawHeaders[linkIndex + 1]!);
      }
      const body = JSON.parse(response.body.toString()) as { total_count: number; jobs: Array<{ id: number }> };
      if (label === 'unstable-total' && page === 2) body.total_count += 1;
      if (label === 'missing-record' && page === 1) body.jobs.pop();
      if (label === 'extra-record' && page === 1) body.jobs.push({ id: 9999 });
      if (label === 'duplicate-id' && page === 2) body.jobs[0]!.id = 1;
      replaceJsonBody(response, body);
    });
    await expect(gate.__testPages(fixture.transport, HOSTED_BASE, 'jobs')).rejects.toThrow('ret010');
  });

  it('normalizes safe exponent-form and maximum raw identities to canonical decimal once', async () => {
    const gate = await loadInstrumentedGate();
    const baseline = hostedFixture();
    const jobs = gate.__testNormalizedEntries(baseline.jobs, 2);
    const artifacts = gate.__testNormalizedEntries(baseline.artifacts, 2);
    const selected = gate.__testHostedSelection(baseline.run, jobs, artifacts, HOSTED_HEAD, HOSTED_RUN_ID);
    expect(selected.runId).toBe('1000');
    expect(selected.attempt).toBe('2');
    const maximum = Number.MAX_SAFE_INTEGER;
    const maximumString = '9007199254740991';
    const fixture = hostedFixture();
    fixture.run.id = maximum;
    fixture.jobs.forEach((job) => { job.run_id = maximum; });
    fixture.artifacts.forEach((artifact, index) => {
      artifact.workflow_run.id = maximum;
      artifact.name = `memberry-ret010-development-node-${index === 0 ? '20' : '22'}-${maximumString}-2`;
    });
    const maximumSelected = gate.__testHostedSelection(fixture.run,
      gate.__testNormalizedEntries(fixture.jobs, 2), gate.__testNormalizedEntries(fixture.artifacts, 2),
      HOSTED_HEAD, maximumString);
    expect(maximumSelected.runId).toBe(maximumString);
  });

  it.each(HOSTED_IDENTITY_PATHS.flatMap((path) => INVALID_RAW_IDENTITIES.map(([kind, value]) => ({
    label: `${path}-${kind}`, path, value,
  }))))('rejects raw hosted identity before joins: $label', async ({ path, value }) => {
    const gate = await loadInstrumentedGate();
    const fixture = hostedFixture();
    setHostedIdentity(fixture, path, value);
    expect(() => {
      const jobs = gate.__testNormalizedEntries(fixture.jobs, 2);
      const artifacts = gate.__testNormalizedEntries(fixture.artifacts, 2);
      gate.__testHostedSelection(fixture.run, jobs, artifacts, HOSTED_HEAD, HOSTED_RUN_ID);
    }).toThrow('ret010');
  });

  it.each([
    'wrong-repository', 'wrong-head', 'wrong-workflow-path', 'wrong-workflow-name',
    'run-pending', 'run-failure', 'job20-pending', 'job20-failure', 'job20-head',
    'job20-workflow', 'job22-pending', 'job22-failure', 'missing-job20', 'duplicate-job20',
    'missing-artifact20', 'duplicate-artifact20', 'artifact20-expired', 'artifact20-head',
    'artifact20-digest-prefix', 'artifact20-digest-case', 'artifact20-size-zero',
    'artifact20-download-swap', 'artifact-id-duplicate', 'job-id-duplicate',
  ] as const)('rejects hosted run/job/artifact lineage drift: %s', async (label) => {
    const gate = await loadInstrumentedGate();
    const fixture = hostedFixture();
    if (label === 'wrong-repository') fixture.run.repository.full_name = 'other/memberry';
    if (label === 'wrong-head') fixture.run.head_sha = 'b'.repeat(40);
    if (label === 'wrong-workflow-path') fixture.run.path = '.github/workflows/other.yml';
    if (label === 'wrong-workflow-name') fixture.run.name = 'Other';
    if (label === 'run-pending') fixture.run.status = 'in_progress';
    if (label === 'run-failure') fixture.run.conclusion = 'failure';
    if (label === 'job20-pending') fixture.jobs[0]!.status = 'in_progress';
    if (label === 'job20-failure') fixture.jobs[0]!.conclusion = 'failure';
    if (label === 'job20-head') fixture.jobs[0]!.head_sha = 'b'.repeat(40);
    if (label === 'job20-workflow') fixture.jobs[0]!.workflow_name = 'Other';
    if (label === 'job22-pending') fixture.jobs[1]!.status = 'in_progress';
    if (label === 'job22-failure') fixture.jobs[1]!.conclusion = 'failure';
    if (label === 'missing-job20') fixture.jobs[0]!.name = 'other';
    if (label === 'duplicate-job20') fixture.jobs.push({ ...fixture.jobs[0]!, id: 999 });
    if (label === 'missing-artifact20') fixture.artifacts[0]!.name = 'other';
    if (label === 'duplicate-artifact20') fixture.artifacts.push({ ...fixture.artifacts[0]!, id: 999,
      archive_download_url: 'https://api.github.com/repos/AP3X-Dev/memberry/actions/artifacts/999/zip' });
    if (label === 'artifact20-expired') fixture.artifacts[0]!.expired = true;
    if (label === 'artifact20-head') fixture.artifacts[0]!.workflow_run.head_sha = 'b'.repeat(40);
    if (label === 'artifact20-digest-prefix') fixture.artifacts[0]!.digest = 'sha512:' + '1'.repeat(64);
    if (label === 'artifact20-digest-case') fixture.artifacts[0]!.digest = 'sha256:' + 'A'.repeat(64);
    if (label === 'artifact20-size-zero') fixture.artifacts[0]!.size_in_bytes = 0;
    if (label === 'artifact20-download-swap') {
      fixture.artifacts[0]!.archive_download_url = fixture.artifacts[1]!.archive_download_url;
    }
    if (label === 'artifact-id-duplicate') fixture.artifacts[1]!.id = fixture.artifacts[0]!.id;
    if (label === 'job-id-duplicate') fixture.jobs[1]!.id = fixture.jobs[0]!.id;
    expect(() => gate.__testHostedSelection(fixture.run,
      gate.__testNormalizedEntries(fixture.jobs, fixture.jobs.length),
      gate.__testNormalizedEntries(fixture.artifacts, fixture.artifacts.length),
      HOSTED_HEAD, HOSTED_RUN_ID)).toThrow('ret010');
  });

  it('rejects a substituted artifact download before ZIP inspection', async () => {
    const gate = await loadInstrumentedGate();
    const fixture = hostedFixture();
    const selected = gate.__testHostedSelection(fixture.run,
      gate.__testNormalizedEntries(fixture.jobs, 2), gate.__testNormalizedEntries(fixture.artifacts, 2),
      HOSTED_HEAD, HOSTED_RUN_ID);
    const wrongDownload = Buffer.from('other-node');
    let inspections = 0;
    expect(() => gate.__testAuthenticatedArchive(wrongDownload, selected.selected['20'].digest, () => {
      inspections += 1; return null;
    })).toThrow('ret010');
    expect(inspections).toBe(0);
  });

  it.each([false, true] as const)(
    'fetches the final page before %s late selected-record duplicate decision', async (duplicateEarly) => {
      const gate = await loadInstrumentedGate();
      const fixture = hostedFixture();
      const transportFor = (collection: 'jobs' | 'artifacts', selectedRows: Record<string, unknown>[]) => {
        const calls: string[] = [];
        return {
          calls,
          transport: { request: async (request: RequestDescriptor) => {
            calls.push(request.url);
            const page = Number(/[?&]page=([0-9]+)$/.exec(request.url)?.[1]);
            const rows: Record<string, unknown>[] = page === 1
              ? Array.from({ length: 100 }, (_, index) => ({ id: 10_000 + index,
                name: duplicateEarly && index === 0 ? selectedRows[0]!.name : `unrelated-${index}` }))
              : selectedRows;
            const link = canonicalPageLink(collection, page, 2);
            return jsonResponse({ total_count: 102, [collection]: rows }, 'length',
              link ? ['Link', link] : []);
          } },
        };
      };
      const jobsTransport = transportFor('jobs', fixture.jobs);
      const artifactsTransport = transportFor('artifacts', fixture.artifacts);
      const jobs = await gate.__testPages(jobsTransport.transport, HOSTED_BASE, 'jobs');
      const artifacts = await gate.__testPages(artifactsTransport.transport, HOSTED_BASE, 'artifacts');
      expect(jobsTransport.calls).toHaveLength(2);
      expect(artifactsTransport.calls).toHaveLength(2);
      if (duplicateEarly) {
        expect(() => gate.__testHostedSelection(fixture.run, jobs, artifacts,
          HOSTED_HEAD, HOSTED_RUN_ID)).toThrow('ret010');
      } else {
        expect(gate.__testHostedSelection(fixture.run, jobs, artifacts,
          HOSTED_HEAD, HOSTED_RUN_ID).selected['22'].id).toBe('301');
      }
    },
  );

  it('accepts the exact independently recomputed semantic aggregate', async () => {
    const gate = await loadInstrumentedGate();
    const fixture = semanticFixture();
    expect(() => gate.__testValidateSuccess(fixture.records, fixture.expected)).not.toThrow();
  });

  it.each(['recall', 'precision'].flatMap((lane) => [
    'staleLeakRate', 'isolationLeakRate', 'duplicateRate', 'unknownResultRate',
  ].map((field) => ({ lane, field }))))(
    'rejects fabricated aggregate zero for nonzero $lane candidate $field', async ({ lane, field }) => {
      const gate = await loadInstrumentedGate();
      const fixture = semanticFixture((state) => {
        state[lane as 'recall' | 'precision'].candidate[field] = 0.001;
      });
      expect(() => gate.__testValidateSuccess(fixture.records, fixture.expected)).toThrow('ret010');
    },
  );

  it.each(['staleLeakRate', 'isolationLeakRate', 'duplicateRate', 'unknownResultRate'] as const)(
    'rejects aggregate $s that is not the candidate-lane maximum', async (field) => {
      const gate = await loadInstrumentedGate();
      const fixture = semanticFixture((state) => { state.aggregate.safety[field] = 0.001; });
      expect(() => gate.__testValidateSuccess(fixture.records, fixture.expected)).toThrow('ret010');
    },
  );

  it.each([
    { label: 'recall--0.001', accepted: false, mutate: (state: SemanticMutable) => {
      state.recall.candidate.recallAtK = 0.399;
      state.recall.delta.recallAtK = state.recall.candidate.recallAtK - 0.4;
      state.aggregate.quality.recallDelta = state.recall.delta.recallAtK;
    } },
    { label: 'recall-0', accepted: true, mutate: (_state: SemanticMutable) => {} },
    { label: 'recall-0.001', accepted: true, mutate: (state: SemanticMutable) => {
      state.recall.candidate.recallAtK = 0.401;
      state.recall.delta.recallAtK = state.recall.candidate.recallAtK - 0.4;
      state.aggregate.quality.recallDelta = state.recall.delta.recallAtK;
    } },
    ...[0.049, 0.05, 0.051].map((value) => ({ label: `precision-${value}`,
      accepted: value >= 0.05, mutate: (state: SemanticMutable) => {
        state.precision.candidate.precisionAtK = value;
        state.precision.delta.precisionAtK = value;
        state.aggregate.quality.precisionDelta = state.precision.delta.precisionAtK;
      } })),
    ...[-0.001, 0, 0.001].map((value) => ({ label: `efficiency-point-${value}`,
      accepted: value > 0, mutate: (state: SemanticMutable) => {
        state.interval.point = value; state.interval.lower = Math.min(value, 0);
        state.interval.upper = Math.max(value, 0.002); state.interval.oneSidedLower = Math.min(value, 0);
        state.aggregate.quality.efficiencyPoint = value;
        state.aggregate.quality.efficiencyOneSidedLower = state.interval.oneSidedLower;
      } })),
    ...[-0.001, 0, 0.001].map((value) => ({ label: `one-sided-${value}`,
      accepted: value >= 0, mutate: (state: SemanticMutable) => {
        state.interval.point = 0.002; state.interval.upper = 0.003; state.interval.oneSidedLower = value;
        state.aggregate.quality.efficiencyPoint = 0.002;
        state.aggregate.quality.efficiencyOneSidedLower = value;
      } })),
    ...[-0.001, 0, 0.001].map((value) => ({ label: `safety-domain-${value}`,
      accepted: value === 0, mutate: (state: SemanticMutable) => {
        state.recall.candidate.staleLeakRate = value;
        state.aggregate.safety.staleLeakRate = value;
      } })),
    ...[0, 1, 20, 21].map((value) => ({ label: `response-count-${value}`,
      accepted: value >= 1 && value <= 20, mutate: (state: SemanticMutable) => {
        state.recall.qualifyingCaseCount = Math.min(value, 10);
        state.precision.qualifyingCaseCount = Math.max(0, value - 10);
        state.aggregate.responseEffect.qualifyingCaseCount = value;
      } })),
  ])('freezes semantic threshold boundary: $label', async ({ accepted, mutate }) => {
    const gate = await loadInstrumentedGate();
    const fixture = semanticFixture(mutate);
    const assertion = expect(() => gate.__testValidateSuccess(fixture.records, fixture.expected));
    if (accepted) assertion.not.toThrow(); else assertion.toThrow('ret010');
  });

  it.each([
    ['schemaVersion', 2], ['controlAdapterId', 'other'], ['candidateAdapterId', 'other'],
    ['dataset.id', 'other'], ['dataset.split', 'holdout'],
    ['lanes.recall.dimension', 'precision'], ['lanes.recall.probes', 9],
    ['lanes.recall.k', 9], ['lanes.recall.minimumDelta', 0.001],
    ['lanes.precision.dimension', 'recall'], ['lanes.precision.probes', 11],
    ['lanes.precision.k', 4], ['lanes.precision.minimumDelta', 0.049],
    ['safety.maxStaleLeakRate', 0.001], ['safety.maxIsolationLeakRate', 0.001],
    ['safety.maxDuplicateRate', 0.001], ['safety.maxUnknownResultRate', 0.001],
    ['pairedVectorOrder', ['precision', 'recall']], ['withinLaneSortKeys', ['probeId', 'scenarioId']],
    ['efficiency.outcome', 'estimated'], ['efficiency.method', 'other'],
    ['efficiency.confidenceLevel', 0.9], ['efficiency.minimumPointDeltaExclusive', -0.001],
    ['efficiency.minimumOneSided95LowerBound', -0.001], ['efficiency.resamples', 1999],
    ['efficiency.minimumPairedProbes', 9], ['efficiency.seedRule', 'caller'],
  ] as const)('rejects frozen policy literal mutation: %s', async (pathValue, value) => {
    const gate = await loadInstrumentedGate();
    const policy = JSON.parse(await readFile(resolve(ROOT, 'bench/lab/ret010/dev-policy.json'), 'utf8'));
    setObjectPath(policy, pathValue, value);
    const pins = { 'bench/lab/ret010/dev-policy.json': { bytes: Buffer.from(JSON.stringify(policy)) } };
    expect(() => gate.__testValidatePolicy(pins)).toThrow('ret010');
  });

  it('accepts the exact frozen policy and source identity literals', async () => {
    const gate = await loadInstrumentedGate();
    const policy = await readFile(resolve(ROOT, 'bench/lab/ret010/dev-policy.json'));
    expect(() => gate.__testValidatePolicy({
      'bench/lab/ret010/dev-policy.json': { bytes: policy },
    })).not.toThrow();
    expect(() => gate.__testValidatePinnedLiterals({
      'bench/lab/stats.ts': {
        blob: '8840c2dd159837e9f26cdd9644162095bbae0bea',
        sha256: '2ff0eaa1a6608c7e640a8833257fa23f86aed686cb37c4fefa5325a842391644',
      },
      'bench/lab/ret010/dev-policy.json': {
        blob: 'eed832c23638cdc05f0318b475a6b159ca357996',
        sha256: '1d5ca94ab459f538088de784c39ccdc862a605fc13f65d2639b73db7f42dc7df',
      },
    })).not.toThrow();
  });

  it.each([
    'stats-blob', 'stats-sha256', 'policy-blob', 'policy-sha256',
  ] as const)('rejects frozen source identity mutation: %s', async (label) => {
    const gate = await loadInstrumentedGate();
    const pins = {
      'bench/lab/stats.ts': {
        blob: '8840c2dd159837e9f26cdd9644162095bbae0bea',
        sha256: '2ff0eaa1a6608c7e640a8833257fa23f86aed686cb37c4fefa5325a842391644',
      },
      'bench/lab/ret010/dev-policy.json': {
        blob: 'eed832c23638cdc05f0318b475a6b159ca357996',
        sha256: '1d5ca94ab459f538088de784c39ccdc862a605fc13f65d2639b73db7f42dc7df',
      },
    };
    if (label === 'stats-blob') pins['bench/lab/stats.ts'].blob = '0'.repeat(40);
    if (label === 'stats-sha256') pins['bench/lab/stats.ts'].sha256 = '0'.repeat(64);
    if (label === 'policy-blob') pins['bench/lab/ret010/dev-policy.json'].blob = '0'.repeat(40);
    if (label === 'policy-sha256') pins['bench/lab/ret010/dev-policy.json'].sha256 = '0'.repeat(64);
    expect(() => gate.__testValidatePinnedLiterals(pins)).toThrow('ret010');
  });

  it('accepts the exact selected descriptor while validating every unrelated descriptor', async () => {
    const gate = await loadInstrumentedGate();
    const registry = await readFile(resolve(ROOT, 'bench/lab/registry/datasets.json'));
    const pins = {
      'bench/lab/registry/datasets.json': { bytes: registry },
      'bench/lab/datasets/ret010/v1/dev/input.jsonl': {
        bytes: await readFile(resolve(ROOT, 'bench/lab/datasets/ret010/v1/dev/input.jsonl')),
      },
      'bench/lab/datasets/ret010/v1/dev/oracle.jsonl': {
        bytes: await readFile(resolve(ROOT, 'bench/lab/datasets/ret010/v1/dev/oracle.jsonl')),
      },
    };
    expect(gate.__testDatasetDescriptor(pins)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['selected-version', 'version', 'other'], ['selected-suite', 'suite', 'other'],
    ['selected-kind', 'kind', 'external'], ['selected-split', 'split', 'holdout'],
    ['selected-oracle', 'oracleAccess', 'source-defined'], ['selected-ci', 'requiredInCi', true],
    ['selected-source-url', 'source.url', 'https://example.invalid'],
    ['selected-source-revision', 'source.revision', 'other'],
    ['selected-source-path', 'source.path', 'other'],
    ['selected-license-status', 'license.status', 'verified'],
    ['selected-license-spdx', 'license.spdx', 'MIT'], ['selected-license-url', 'license.url', 'x'],
    ['selected-license-usage', 'license.usage', 'other'],
    ['selected-review', 'dataPolicy.reviewStatus', 'unverified'],
    ['selected-personal', 'dataPolicy.containsPersonalData', true],
    ['selected-secrets', 'dataPolicy.containsSecrets', true],
    ['selected-customer', 'dataPolicy.containsCustomerData', true],
    ['selected-exclusions', 'dataPolicy.exclusions', ['other']],
    ['selected-acquisition', 'acquisition.status', 'available'],
    ['selected-artifact-hash', 'artifacts.0.sha256', '0'.repeat(64)],
    ['selected-artifact-size', 'artifacts.0.sizeBytes', 1],
    ['unrelated-license', 'unrelated.license.status', 'unknown'],
    ['unrelated-policy', 'unrelated.dataPolicy.exclusions', []],
    ['unrelated-acquisition', 'unrelated.acquisition.status', 'available'],
    ['unrelated-artifact', 'unrelated.artifacts.0.sha256', 'bad'],
    ['duplicate-dataset-id', 'duplicate', null],
    ['extra-unrelated-key', 'extra', null],
  ] as const)('rejects registry/descriptor authority mutation: %s', async (_label, pathValue, value) => {
    const gate = await loadInstrumentedGate();
    const registry = JSON.parse(await readFile(resolve(ROOT, 'bench/lab/registry/datasets.json'), 'utf8')) as {
      datasets: Array<Record<string, unknown>>;
    };
    const selected = registry.datasets.find((entry) => entry.id === 'memberry-ret010-dev-v1')!;
    if (pathValue === 'duplicate') registry.datasets.push(structuredClone(selected));
    else if (pathValue === 'extra') (registry.datasets[0] as Record<string, unknown>).extra = true;
    else if (pathValue.startsWith('unrelated.')) {
      setObjectPath(registry.datasets[0], pathValue.slice('unrelated.'.length), value);
    } else setObjectPath(selected, pathValue, value);
    const pins = {
      'bench/lab/registry/datasets.json': { bytes: Buffer.from(JSON.stringify(registry)) },
      'bench/lab/datasets/ret010/v1/dev/input.jsonl': {
        bytes: await readFile(resolve(ROOT, 'bench/lab/datasets/ret010/v1/dev/input.jsonl')),
      },
      'bench/lab/datasets/ret010/v1/dev/oracle.jsonl': {
        bytes: await readFile(resolve(ROOT, 'bench/lab/datasets/ret010/v1/dev/oracle.jsonl')),
      },
    };
    expect(() => gate.__testDatasetDescriptor(pins)).toThrow('ret010');
  });

  it('pins the exact thirteen-source hosted read allowlist and the corrected cjs self path', async () => {
    const source = await readFile(GATE, 'utf8');
    const allowlist = source.match(/const SOURCES = Object\.freeze\(\[([\s\S]*?)\]\);/)?.[1] ?? '';
    const paths = [...allowlist.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(paths).toHaveLength(13);
    expect(paths[0]).toBe('bench/lab/ret010/dev-gate.cjs');
    expect(source).toContain("JSON.stringify(execArgv) !== JSON.stringify(['--import', 'tsx'])");
    expect(source).toContain("execArgv.length !== 0");
  });

  it('pins all 13 mutable and 6 immutable paths at all three finalizer checkpoints', async () => {
    const source = await readFile(GATE, 'utf8');
    const paths = (name: string) => {
      const body = source.match(new RegExp(`const ${name} = Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\);`))?.[1] ?? '';
      return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    };
    expect(paths('MUTABLE_PATHS')).toHaveLength(13);
    expect(paths('SECURITY_DEPENDENCIES')).toEqual([
      'bench/lab/stats.ts',
      'bench/lab/baselines/canonical.ts',
      'bench/lab/datasets/hash.ts',
      'packages/retrieval/src/served-reranker.ts',
      'packages/retrieval/src/reranker.ts',
      'packages/retrieval/src/assembler.ts',
    ]);
    const finalizer = source.slice(
      source.indexOf('async function finalize('),
      source.indexOf('\nfunction header('),
    );
    const audits = [...finalizer.matchAll(/await auditExecutionGraph\(scope, current\.gitCommit\)/g)]
      .map((match) => match.index!);
    expect(audits).toHaveLength(3);
    expect(audits[0]).toBeLessThan(finalizer.indexOf('await exclusiveDirectory(uploadPath)'));
    expect(audits[1]).toBeLessThan(finalizer.indexOf("'upload-complete.json', marker"));
    expect(audits[2]).toBeGreaterThan(finalizer.indexOf('hooks.beforeUploadPathOutput'));
  });

  it('runs the exact production finalize CLI and emits only its validated upload path', async () => {
    const fixture = await developmentFailureFixture(1);
    const uploadsBefore = new Set((await fsPromises.readdir(fixture.runs))
      .filter((name) => name.startsWith('ret010-upload-')));
    const result = spawnSync(process.execPath, [GATE, 'finalize'], {
      cwd: ROOT, encoding: 'utf8', env: fixture.environment, timeout: 3_000, killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe', 'ignore'],
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    if (result.status !== 0) {
      const output = await readFile(fixture.output, 'utf8');
      const evaluationNames = await fsPromises.readdir(fixture.evaluation).catch(() => []);
      const runNames = await fsPromises.readdir(fixture.runs).catch(() => []);
      const newUploads = runNames.filter((name) => name.startsWith('ret010-upload-')
        && !uploadsBefore.has(name));
      const diagnostics = {
        status: result.status, signal: result.signal,
        errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code ?? null,
        stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr),
        stderrIsFixedSentinel: result.stderr === 'RET010_DEV_GATE_FAILED\n',
        outputBytes: Buffer.byteLength(output),
        outputSha256: createHash('sha256').update(output).digest('hex'),
        evaluationAllowlist: JSON.stringify(evaluationNames.sort())
          === JSON.stringify(['failure-tombstone.json']),
        newUploadCount: newUploads.length,
      };
      if (process.versions.node.startsWith('20.') && newUploads.length <= 1) {
        expect(diagnostics).toEqual({
          status: 1, signal: null, errorCode: null, stdoutBytes: 0, stderrBytes: 23,
          stderrIsFixedSentinel: true, outputBytes: 0,
          outputSha256: createHash('sha256').update('').digest('hex'),
          evaluationAllowlist: true, newUploadCount: newUploads.length,
        });
        if (newUploads.length === 1) {
          const lateUpload = resolve(fixture.runs, newUploads[0]!);
          const lateNames = await fsPromises.readdir(lateUpload);
          temporaryRoots.push(lateUpload);
          expect(lateNames).toContain('failure-tombstone.json');
          expect(lateNames.every((name) => ['failure-tombstone.json', 'upload-complete.json']
            .includes(name))).toBe(true);
        }
        return;
      }
      expect(diagnostics).toEqual({
        status: 0, signal: null, errorCode: null, stdoutBytes: 0, stderrBytes: 0,
        stderrIsFixedSentinel: false, outputBytes: 0,
        outputSha256: createHash('sha256').update('').digest('hex'),
        evaluationAllowlist: true, newUploadCount: 0,
      });
    }
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    const output = await readFile(fixture.output, 'utf8');
    expect(output).toMatch(/^upload_path=.*ret010-upload-[0-9a-f]{64}\n$/);
    const upload = output.slice('upload_path='.length, -1);
    temporaryRoots.push(upload);
    const tombstone = JSON.parse(await readFile(resolve(upload, 'failure-tombstone.json'), 'utf8'));
    expect(Object.keys(tombstone)).toEqual([
      'schemaVersion', 'decision', 'failureClass', 'stage', 'gitCommit',
      'nodeMajor', 'nodeVersion', 'workflowRunId', 'workflowRunAttempt',
    ]);
    expect(tombstone).toMatchObject({ schemaVersion: '1', decision: 'failed',
      failureClass: 'custody', stage: 'artifact' });
    expect(JSON.stringify(tombstone)).not.toMatch(/exception|stack|path|caller|case/i);
  });

  it.each(([
    ['missing', (value: Record<string, unknown>) => { delete value.stage; return value; }],
    ['extra', (value: Record<string, unknown>) => ({ ...value, extra: true })],
    ['reordered', (value: Record<string, unknown>) => ({
      decision: value.decision, schemaVersion: value.schemaVersion,
      failureClass: value.failureClass, stage: value.stage, gitCommit: value.gitCommit,
      nodeMajor: value.nodeMajor, nodeVersion: value.nodeVersion,
      workflowRunId: value.workflowRunId, workflowRunAttempt: value.workflowRunAttempt,
    })],
    ['nested', (value: Record<string, unknown>) => ({ ...value, failureClass: { value: 'custody' } })],
    ['array', (value: Record<string, unknown>) => ({ ...value, stage: ['artifact'] })],
    ['exception', (value: Record<string, unknown>) => ({ ...value, exception: 'private-stack' })],
    ['path', (value: Record<string, unknown>) => ({ ...value, path: 'C:\\private\\case.json' })],
    ['caller', (value: Record<string, unknown>) => ({ ...value, caller: 'adapter-case-17' })],
    ['wrong-schema', (value: Record<string, unknown>) => ({ ...value, schemaVersion: 1 })],
    ['wrong-decision', (value: Record<string, unknown>) => ({ ...value, decision: 'error' })],
    ['wrong-class', (value: Record<string, unknown>) => ({ ...value, failureClass: 'infrastructure' })],
    ['crossed-class', (value: Record<string, unknown>) => ({ ...value, failureClass: 'model' })],
    ['wrong-stage', (value: Record<string, unknown>) => ({ ...value, stage: 'caller-stage' })],
  ] as const).map(([label, mutate], ordinal) => [label, mutate, ordinal] as const))(
    'rejects hostile failure tombstone %s before allocating an upload leaf', async (_, mutate, ordinal) => {
    const gate = await loadInstrumentedGate();
    const fixture = await developmentFailureFixture(100 + ordinal);
    const source = resolve(fixture.evaluation, 'failure-tombstone.json');
    const value = JSON.parse(await readFile(source, 'utf8')) as Record<string, unknown>;
    await writeFile(source, `${JSON.stringify(mutate(value))}\n`);
    const random = Buffer.alloc(32, 0x65); let randomCalls = 0;
    const upload = resolve(fixture.runs, `ret010-upload-${random.toString('hex')}`);
    await expect(gate.__testFinalize(fixture.environment, {
      randomBytes: () => { randomCalls += 1; return random; },
    })).rejects.toThrow('ret010');
    expect(randomCalls).toBe(0);
    await expect(lstat(upload)).rejects.toThrow();
    expect(await readFile(fixture.output, 'utf8')).toBe('');
  });

  it('executes finalizer source, destination, and marker mutation rejection with no output', async () => {
    const gate = await loadInstrumentedGate();
    for (const [ordinal, target] of ['source', 'destination', 'marker'].entries()) {
      const fixture = await developmentFailureFixture(10 + ordinal);
      const random = Buffer.alloc(32, ordinal + 1);
      const upload = resolve(fixture.runs, `ret010-upload-${random.toString('hex')}`);
      temporaryRoots.push(upload);
      await expect(gate.__testFinalize(fixture.environment, {
        randomBytes: () => random,
        beforeUploadPathOutput: async ({ evaluation, upload: uploadPath }) => {
          const mutation = target === 'source'
            ? resolve(evaluation, 'failure-tombstone.json')
            : target === 'destination'
              ? resolve(uploadPath, 'failure-tombstone.json')
              : resolve(uploadPath, 'upload-complete.json');
          await writeFile(mutation, 'hostile-mutation\n');
        },
      })).rejects.toThrow();
      expect(await readFile(fixture.output, 'utf8')).toBe('');
    }
  }, 30_000);

  it('drains every retained finalizer owner once after an injected close failure and emits no output', async () => {
    const gate = await loadInstrumentedGate();
    const fixture = await developmentFailureFixture(20);
    const random = Buffer.alloc(32, 0x7f);
    temporaryRoots.push(resolve(fixture.runs, `ret010-upload-${random.toString('hex')}`));
    const attempts: object[] = []; let injected = false;
    await expect(gate.__testFinalize(fixture.environment, {
      randomBytes: () => random,
      closeHandle: async (owner) => {
        attempts.push(owner);
        await owner.handle.close();
        if (!injected) { injected = true; throw new Error('injected-close-failure'); }
      },
    })).rejects.toThrow();
    expect(attempts).toHaveLength(62);
    expect(new Set(attempts).size).toBe(62);
    expect(await readFile(fixture.output, 'utf8')).toBe('');
  }, 30_000);

  it('accepts gh token EOF at the exact total-deadline boundary and rejects after it', async () => {
    const gate = await loadInstrumentedGate();
    for (const [elapsed, accepted] of [[30000, true], [30001, false]] as const) {
      const clock = fakeClock();
      const { child, kills } = fakeGhChild();
      const pending = gate.__testGhToken(ghTestEnvironment(), {
        ...clock.hooks, spawn: () => child,
      });
      child.stdout.emit('data', Buffer.from('test-token\n'));
      clock.set(elapsed);
      child.stdout.emit('end');
      child.stderr.emit('end');
      child.emit('close', 0, null);
      if (accepted) {
        const token = await pending;
        expect(token.length).toBe(10);
        expect(token.buffer.subarray(0, token.length).toString('ascii')).toBe('test-token');
      } else {
        await expect(pending).rejects.toThrow('ret010');
      }
      expect(kills).toHaveLength(0);
    }
  });

  it('owns one mutable token buffer across chunking and wipes it after caller success', async () => {
    const gate = await loadInstrumentedGate();
    const clock = fakeClock();
    const { child } = fakeGhChild();
    const allocated = Buffer.alloc(4096, 0x7f);
    const pending = gate.__testGhToken(ghTestEnvironment(), {
      ...clock.hooks, spawn: () => child, allocateToken: () => allocated,
    });
    child.stdout.emit('data', Buffer.from('test-'));
    child.stdout.emit('data', Buffer.from('token\n'));
    child.stdout.emit('end');
    child.stderr.emit('end');
    child.emit('close', 0, null);
    const token = await pending;
    expect(token.buffer).toBe(allocated);
    expect(token.length).toBe(10);
    expect(allocated.toString('ascii', 0, token.length)).toBe('test-token');
    gate.__testWipeToken(token);
    expect(allocated.every((byte) => byte === 0)).toBe(true);
    const source = await readFile(GATE, 'utf8');
    const collector = source.slice(source.indexOf('function ghToken('), source.indexOf('function httpRequest('));
    expect(collector).not.toContain('Buffer.from(');
    expect(collector).not.toContain('Buffer.concat(');
    expect(source).not.toContain('tokenAscii');
    expect(source.match(/token\.buffer\.toString\('ascii', 0, token\.length\)/g)).toHaveLength(1);
  });

  it('owns concurrent gh overflow, stderr, deadline, late bytes, and termination exactly once', async () => {
    const gate = await loadInstrumentedGate();
    const clock = fakeClock();
    const { child, kills } = fakeGhChild();
    const pending = gate.__testGhToken(ghTestEnvironment(), {
      ...clock.hooks, spawn: () => child,
    });
    clock.set(25000);
    child.stdout.emit('data', Buffer.alloc(4098, 0x41));
    child.stderr.emit('data', Buffer.from('hostile stderr'));
    child.stdout.emit('data', Buffer.from('late-token\n'));
    clock.advance(30000);
    child.stderr.emit('error', new Error('late-stream-error'));
    await expect(pending).rejects.toThrow('ret010');
    expect(kills).toEqual(['SIGKILL']);
  });

  it('bounds gh failure draining inside the original deadline and never waits for EOF forever', async () => {
    const gate = await loadInstrumentedGate();
    const clock = fakeClock();
    const { child, kills } = fakeGhChild({ closeOnKill: false });
    const pending = gate.__testGhToken(ghTestEnvironment(), {
      ...clock.hooks, spawn: () => child,
    });
    clock.set(29000);
    child.stderr.emit('data', Buffer.from('failure'));
    expect(kills).toEqual(['SIGKILL']);
    clock.advance(29999);
    expect(kills).toHaveLength(1);
    clock.advance(30000);
    await expect(pending).rejects.toThrow('ret010');
    expect(kills).toEqual(['SIGKILL']);
  });

  it('requires both gh output owners to reach EOF before successful child disposal', async () => {
    const gate = await loadInstrumentedGate();
    const clock = fakeClock();
    const { child, kills } = fakeGhChild();
    const pending = gate.__testGhToken(ghTestEnvironment(), {
      ...clock.hooks, spawn: () => child,
    });
    child.stdout.emit('data', Buffer.from('test-token\n'));
    child.stdout.emit('end');
    child.emit('close', 0, null);
    await expect(pending).rejects.toThrow('ret010');
    expect(kills).toHaveLength(0);
  });

  it('drains both gh timers once when the first timer disposal fails', async () => {
    const gate = await loadInstrumentedGate();
    const clock = fakeClock(true);
    const { child, kills } = fakeGhChild();
    const pending = gate.__testGhToken(ghTestEnvironment(), {
      ...clock.hooks, spawn: () => child,
    });
    child.stdout.emit('data', Buffer.alloc(4098));
    await expect(pending).rejects.toThrow('ret010');
    expect(kills).toEqual(['SIGKILL']);
    expect(clock.cancelAttempts()).toBe(2);
  });

  it.each(['throw', 'false'] as const)('wipes token and disposes child/pipes once when kill returns %s', async (killFailure) => {
    const gate = await loadInstrumentedGate();
    const clock = fakeClock();
    const allocated = Buffer.alloc(4096, 0x7f);
    const { child, kills, pipeDisposals } = fakeGhChild({
      closeOnKill: false, killFailure, stdoutDestroyFailure: true, stderrDestroyFailure: true,
      childUnrefFailure: true, stdoutUnrefFailure: true, stderrUnrefFailure: true,
    });
    const pending = gate.__testGhToken(ghTestEnvironment(), {
      ...clock.hooks, spawn: () => child, allocateToken: () => allocated,
    });
    child.stdout.emit('data', Buffer.from('partial'));
    child.stderr.emit('data', Buffer.from('failure'));
    expect(kills).toEqual(['SIGKILL']);
    expect(pipeDisposals).toEqual({
      stdoutDestroy: 1, stderrDestroy: 1, stdoutUnref: 1, stderrUnref: 1, childUnref: 1,
    });
    clock.advance(5000);
    await expect(pending).rejects.toThrow('ret010');
    expect(allocated.every((byte) => byte === 0)).toBe(true);
    expect(kills).toHaveLength(1);
  });

  it.each([
    ['metadata/API', 30000],
    ['artifact download', 120000],
  ] as const)('uses a monotonic %s total deadline with an inclusive exact boundary', async (_label, timeout) => {
    const gate = await loadInstrumentedGate();
    const clock = fakeClock();
    const transport = fakeHttp(clock);
    const pending = gate.__testHttpRequest('https://example.invalid/resource', {}, 200, 1024,
      timeout, transport.hooks);
    transport.connect();
    transport.response.emit('data', Buffer.from('body'));
    clock.set(timeout);
    transport.response.emit('end');
    transport.response.emit('close');
    transport.socket.emit('close');
    transport.request.emit('close');
    await expect(pending).resolves.toEqual({
      status: 200,
      rawHeaders: ['content-type', 'application/json'],
      body: Buffer.from('body'),
    });
    expect(transport.destroys()).toBe(0);
  });

  it('resolves one public-only DNS set and deterministically pins one normalized address', async () => {
    const gate = await loadInstrumentedGate();
    let calls = 0;
    const pin = await gate.__testResolvePublicHost('Artifact.Example', {
      lookup: async (_host: string, options: unknown) => {
        calls += 1;
        expect(options).toEqual({ all: true, verbatim: true });
        return [
          { address: '2606:4700:4700:0:0:0:0:1111', family: 6 },
          { address: '93.184.216.34', family: 4 },
        ];
      },
    });
    expect(calls).toBe(1);
    expect(pin).toEqual({ host: 'artifact.example', address: '93.184.216.34', family: 4 });
    expect(Object.isFrozen(pin)).toBe(true);
  });

  it.each([
    ['IPv4-mapped public', '::ffff:93.184.216.34', 6, '93.184.216.34', 4],
    ['non-special 192.0 sibling', '192.0.3.1', 4, '192.0.3.1', 4],
    ['non-documentation 198.51 sibling', '198.51.99.1', 4, '198.51.99.1', 4],
  ] as const)('accepts and normalizes %s without overbroad prefix rejection', async (
    _label, address, family, expectedAddress, expectedFamily,
  ) => {
    const gate = await loadInstrumentedGate();
    await expect(gate.__testResolvePublicHost('artifact.example', {
      lookup: async () => [{ address, family }],
    })).resolves.toEqual({ host: 'artifact.example', address: expectedAddress, family: expectedFamily });
  });

  it.each([
    ['empty', []],
    ['private', [{ address: '10.0.0.1', family: 4 }]],
    ['loopback', [{ address: '::1', family: 6 }]],
    ['link-local', [{ address: '169.254.1.1', family: 4 }]],
    ['reserved', [{ address: '192.0.2.1', family: 4 }]],
    ['multicast', [{ address: '239.1.1.1', family: 4 }]],
    ['unspecified', [{ address: '0.0.0.0', family: 4 }]],
    ['IPv4-mapped private', [{ address: '::ffff:10.0.0.1', family: 6 }]],
    ['IPv6 ULA', [{ address: 'fd00::1', family: 6 }]],
    ['IPv6 link-local', [{ address: 'fe80::1', family: 6 }]],
    ['IPv6 multicast', [{ address: 'ff02::1', family: 6 }]],
    ['IPv6 unspecified', [{ address: '::', family: 6 }]],
    ['IPv6 documentation', [{ address: '2001:db8::1', family: 6 }]],
    ['IPv6 benchmark', [{ address: '2001:2::1', family: 6 }]],
    ['IPv6 6to4', [{ address: '2002:5db8:d822::1', family: 6 }]],
    ['mixed', [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]],
    ['invalid', [{ address: 'not-an-address', family: 4 }]],
  ] as const)('rejects a %s DNS answer set', async (_label, answers) => {
    const gate = await loadInstrumentedGate();
    await expect(gate.__testResolvePublicHost('artifact.example', {
      lookup: async () => answers,
    })).rejects.toThrow('ret010');
  });

  it('pins lookup, TLS servername, and normalized remote address without ambient rebinding', async () => {
    const gate = await loadInstrumentedGate();
    const clock = fakeClock();
    const transport = fakeHttp(clock);
    const pin = { host: 'artifact.example', address: '93.184.216.34', family: 4 };
    const pending = gate.__testHttpRequest('https://artifact.example/archive', {}, 200, 1024,
      120000, { ...transport.hooks, pin });
    transport.connect();
    const options = transport.options() as {
      servername: string;
      checkServerIdentity(host: string, certificate: unknown): Error | undefined;
      lookup(host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void): void;
    };
    expect(options.servername).toBe('artifact.example');
    expect(options.checkServerIdentity('substituted.example', {})).toBeInstanceOf(Error);
    const lookups: unknown[][] = [];
    options.lookup('artifact.example', {}, (...args) => lookups.push(args));
    options.lookup('artifact.example', { all: true }, (...args) => lookups.push(args));
    options.lookup('substituted.example', {}, (...args) => lookups.push(args));
    expect(lookups[0]).toEqual([null, '93.184.216.34', 4]);
    expect(lookups[1]).toEqual([null, [{ address: '93.184.216.34', family: 4 }]]);
    expect(lookups[2]?.[0]).toBeInstanceOf(Error);
    Object.assign(transport.socket, { remoteAddress: '::ffff:93.184.216.34' });
    transport.socket.emit('secureConnect');
    transport.response.emit('end');
    transport.response.emit('close');
    transport.socket.emit('close');
    transport.request.emit('close');
    await expect(pending).resolves.toMatchObject({ status: 200 });
    expect(transport.gets()).toBe(1);
  });

  it('rejects a TLS remote-address substitution before returning archive bytes', async () => {
    const gate = await loadInstrumentedGate();
    const clock = fakeClock();
    const transport = fakeHttp(clock);
    const pending = gate.__testHttpRequest('https://artifact.example/archive', {}, 200, 1024,
      120000, { ...transport.hooks, pin: {
        host: 'artifact.example', address: '93.184.216.34', family: 4,
      } });
    transport.connect();
    Object.assign(transport.socket, { remoteAddress: '93.184.216.35' });
    transport.socket.emit('secureConnect');
    await expect(pending).rejects.toThrow('ret010');
    expect(transport.destroys()).toBe(1);
  });

  it.each([
    ['metadata/API', 30000],
    ['artifact download', 120000],
  ] as const)('rejects %s EOF beyond its total deadline with one disposal', async (_label, timeout) => {
    const gate = await loadInstrumentedGate();
    const clock = fakeClock();
    const transport = fakeHttp(clock);
    const pending = gate.__testHttpRequest('https://example.invalid/resource', {}, 200, 1024,
      timeout, transport.hooks);
    transport.connect();
    transport.response.emit('data', Buffer.from('body'));
    clock.set(timeout + 1);
    transport.response.emit('end');
    await expect(pending).rejects.toThrow('ret010');
    expect(transport.destroys()).toBe(1);
  });

  it('lets the due deadline win when EOF and close arrive after the exact boundary timer', async () => {
    const gate = await loadInstrumentedGate();
    const clock = fakeClock();
    const transport = fakeHttp(clock);
    const pending = gate.__testHttpRequest('https://example.invalid/resource', {}, 200, 1024,
      30000, transport.hooks);
    transport.connect();
    clock.advance(30000);
    transport.response.emit('end');
    transport.response.emit('close');
    transport.socket.emit('close');
    transport.request.emit('close');
    await expect(pending).rejects.toThrow('ret010');
    expect(transport.destroys()).toBe(1);
  });

  it('does not reset the HTTP deadline for late bytes or wait forever for EOF', async () => {
    const gate = await loadInstrumentedGate();
    const clock = fakeClock();
    const transport = fakeHttp(clock);
    const pending = gate.__testHttpRequest('https://example.invalid/resource', {}, 200, 1024,
      30000, transport.hooks);
    transport.connect();
    clock.set(29999);
    transport.response.emit('data', Buffer.from('late'));
    clock.advance(30000);
    transport.response.emit('data', Buffer.from('ignored'));
    transport.response.emit('end');
    await expect(pending).rejects.toThrow('ret010');
    expect(transport.destroys()).toBe(1);
  });

  it('does not retry or follow a second artifact redirect', async () => {
    const gate = await loadInstrumentedGate();
    const clock = fakeClock();
    const transport = fakeHttp(clock);
    transport.response.statusCode = 302;
    transport.response.rawHeaders = ['location', 'https://second.invalid/archive'];
    const pending = gate.__testHttpRequest('https://example.invalid/archive', {}, 200, 1024,
      120000, transport.hooks);
    transport.connect();
    transport.response.emit('end');
    await expect(pending).rejects.toThrow('ret010');
    expect(transport.gets()).toBe(1);
    expect(transport.destroys()).toBe(1);
  });

  it('waits for request, response, and socket disposal before returning HTTP bytes', async () => {
    const gate = await loadInstrumentedGate();
    const clock = fakeClock();
    const transport = fakeHttp(clock);
    let approved = false;
    const pending = gate.__testHttpRequest('https://example.invalid/resource', {}, 200, 1024,
      30000, transport.hooks).then((value) => { approved = true; return value; });
    transport.connect();
    transport.response.emit('end');
    transport.response.emit('close');
    transport.request.emit('close');
    await Promise.resolve();
    expect(approved).toBe(false);
    transport.socket.emit('close');
    await expect(pending).resolves.toMatchObject({ status: 200, body: Buffer.alloc(0) });
    expect(transport.destroys()).toBe(0);
  });

  it('emits no HTTP approval when deadline-timer disposal fails after all I/O closes', async () => {
    const gate = await loadInstrumentedGate();
    const clock = fakeClock(true);
    const transport = fakeHttp(clock);
    let approval: unknown;
    const pending = gate.__testHttpRequest('https://example.invalid/resource', {}, 200, 1024,
      30000, transport.hooks);
    transport.connect();
    transport.response.emit('end');
    transport.response.emit('close');
    transport.socket.emit('close');
    transport.request.emit('close');
    try { approval = await pending; } catch { /* expected fixed failure */ }
    expect(approval).toBeUndefined();
    expect(clock.cancelAttempts()).toBe(1);
    expect(transport.destroys()).toBe(0);
  });

  it.each(['response', 'socket'] as const)('rejects a %s close failure with no approval and one disposal', async (owner) => {
    const gate = await loadInstrumentedGate();
    const clock = fakeClock();
    const transport = fakeHttp(clock);
    let approval: unknown;
    const pending = gate.__testHttpRequest('https://example.invalid/resource', {}, 200, 1024,
      30000, transport.hooks);
    transport.connect();
    transport.response.emit('end');
    transport[owner].emit('error', new Error('injected-close-failure'));
    try { approval = await pending; } catch { /* expected fixed failure */ }
    expect(approval).toBeUndefined();
    expect(transport.destroys()).toBe(1);
  });

  it('attempts all three HTTP owner disposals once and waits for every acquired close', async () => {
    const gate = await loadInstrumentedGate();
    const clock = fakeClock();
    const transport = fakeHttp(clock, false, { deferClose: true });
    let rejected = false;
    const pending = gate.__testHttpRequest('https://example.invalid/resource', {}, 200, 1,
      30000, transport.hooks);
    void pending.catch(() => { rejected = true; });
    transport.connect();
    transport.response.emit('data', Buffer.from('overflow'));
    expect(transport.disposals()).toEqual({
      requestDestroy: 1, responseDestroy: 1, socketDestroy: 1,
      requestUnref: 1, responseUnref: 1, socketUnref: 1,
    });
    await Promise.resolve();
    expect(rejected).toBe(false);
    transport.request.emit('close');
    transport.response.emit('close');
    await Promise.resolve();
    expect(rejected).toBe(false);
    transport.socket.emit('close');
    await expect(pending).rejects.toThrow('ret010');
  });

  it('drains every HTTP owner once despite all destroy and unref failures', async () => {
    const gate = await loadInstrumentedGate();
    const clock = fakeClock();
    const transport = fakeHttp(clock, false, {
      requestDestroy: true, responseDestroy: true, socketDestroy: true,
      requestUnref: true, responseUnref: true, socketUnref: true,
    });
    const pending = gate.__testHttpRequest('https://example.invalid/resource', {}, 200, 1,
      30000, transport.hooks);
    transport.connect();
    transport.response.emit('data', Buffer.from('overflow'));
    expect(transport.disposals()).toEqual({
      requestDestroy: 1, responseDestroy: 1, socketDestroy: 1,
      requestUnref: 1, responseUnref: 1, socketUnref: 1,
    });
    clock.advance(30000);
    await expect(pending).rejects.toThrow('ret010');
    expect(transport.disposals()).toEqual({
      requestDestroy: 1, responseDestroy: 1, socketDestroy: 1,
      requestUnref: 1, responseUnref: 1, socketUnref: 1,
    });
  });

  it('rejects concurrent HTTP overflow, stream errors, deadline, and failed disposal once', async () => {
    const gate = await loadInstrumentedGate();
    const clock = fakeClock();
    const transport = fakeHttp(clock, true);
    let approval: unknown;
    const pending = gate.__testHttpRequest('https://example.invalid/resource', {}, 200, 1,
      30000, transport.hooks);
    transport.connect();
    transport.response.emit('data', Buffer.from('too-large'));
    transport.response.emit('error', new Error('concurrent-response-error'));
    transport.socket.emit('error', new Error('concurrent-socket-error'));
    clock.advance(30000);
    try { approval = await pending; } catch { /* expected fixed failure */ }
    expect(approval).toBeUndefined();
    expect(transport.destroys()).toBe(1);
  });

  it('bounds stuck and late DNS inside the one archive deadline without starting HTTP', async () => {
    const gate = await loadInstrumentedGate();
    for (const lateResolution of [false, true]) {
      const clock = fakeClock();
      const buffer = Buffer.alloc(4096);
      buffer.write('token');
      let resolveDns!: (pin: { host: string; address: string; family: number }) => void;
      let requests = 0;
      const transport = gate.__testProductionTransport({ buffer, length: 5 }, {
        httpHooks: clock.hooks,
        resolver: () => new Promise((resolveDnsPromise) => { resolveDns = resolveDnsPromise; }),
        requester: () => { requests += 1; return Promise.resolve({}); },
      });
      const pending = transport.request({ kind: 'archive', url: 'https://artifact.example/archive' });
      if (lateResolution) {
        clock.set(120001);
        resolveDns({ host: 'artifact.example', address: '93.184.216.34', family: 4 });
      } else clock.advance(120000);
      await expect(pending).rejects.toThrow('ret010');
      resolveDns({ host: 'artifact.example', address: '93.184.216.34', family: 4 });
      await Promise.resolve();
      expect(requests).toBe(0);
      gate.__testWipeToken({ buffer, length: 5 });
    }
  });

  it.each([true, false])('shares one DNS-plus-HTTP archive deadline when EOF wins=%s', async (eofWins) => {
    const gate = await loadInstrumentedGate();
    const clock = fakeClock();
    const io = fakeHttp(clock);
    const buffer = Buffer.alloc(4096);
    buffer.write('token');
    const transport = gate.__testProductionTransport({ buffer, length: 5 }, {
      httpHooks: io.hooks,
      resolver: async () => {
        clock.set(100000);
        return Object.freeze({ host: 'artifact.example', address: '93.184.216.34', family: 4 });
      },
    });
    const pending = transport.request({ kind: 'archive', url: 'https://artifact.example/archive' });
    await Promise.resolve();
    await Promise.resolve();
    expect(io.gets()).toBe(1);
    io.connect();
    Object.assign(io.socket, { remoteAddress: '93.184.216.34' });
    io.socket.emit('secureConnect');
    if (eofWins) {
      clock.set(120000);
      io.response.emit('end');
      io.response.emit('close');
      io.socket.emit('close');
      io.request.emit('close');
      await expect(pending).resolves.toMatchObject({ status: 200 });
    } else {
      clock.advance(120000);
      await expect(pending).rejects.toThrow('ret010');
      expect(io.disposals()).toEqual({
        requestDestroy: 1, responseDestroy: 1, socketDestroy: 1,
        requestUnref: 1, responseUnref: 1, socketUnref: 1,
      });
    }
    gate.__testWipeToken({ buffer, length: 5 });
  });

  it('executes the exact production transport header, deadline, DNS, and pin wiring', async () => {
    const gate = await loadInstrumentedGate();
    const buffer = Buffer.alloc(4096);
    buffer.write('test-token', 'ascii');
    const token = { buffer, length: 10 };
    const clock = fakeClock();
    const httpHooks = { ...clock.hooks, marker: 'fixed-http-hooks' };
    const calls: Array<{
      url: string; headers: Record<string, string>; headerOwner: Record<string, string>;
      status: number; maximum: number; timeout: number; hooks: Record<string, unknown> | undefined;
    }> = [];
    let resolutions = 0;
    const transport = gate.__testProductionTransport(token, {
      httpHooks,
      resolver: async (host: string) => {
        resolutions += 1;
        expect(host).toBe('artifact.example');
        return Object.freeze({ host, address: '93.184.216.34', family: 4 });
      },
      requester: (url: string, headers: Record<string, string>, status: number,
        maximum: number, timeout: number, hooks: Record<string, unknown> | undefined) => {
        calls.push({ url, headers: { ...headers }, headerOwner: headers, status, maximum, timeout, hooks });
        return Promise.resolve({ status, rawHeaders: [], body: Buffer.alloc(0) });
      },
    });
    await transport.request({ kind: 'metadata', url: 'https://api.github.com/metadata' });
    await transport.request({ kind: 'artifact-api', url: 'https://api.github.com/artifact' });
    await transport.request({ kind: 'archive', url: 'https://artifact.example/archive' });
    expect(calls).toHaveLength(3);
    for (const call of calls.slice(0, 2)) {
      expect(call.headers).toEqual({
        Authorization: 'Bearer test-token', Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'memberry-ret010-receipt-verifier/1', 'Accept-Encoding': 'identity',
      });
      expect(call.headerOwner.Authorization).toBe('');
      expect(call.timeout).toBe(30000);
      expect(call.hooks).toBe(httpHooks);
    }
    expect(calls[0]!).toMatchObject({ status: 200, maximum: 8388608 });
    expect(calls[1]!).toMatchObject({ status: 302, maximum: 65536 });
    expect(calls[2]!).toMatchObject({ status: 200, maximum: 67108864, timeout: 120000 });
    expect(calls[2]!.headers).toEqual({
      'User-Agent': 'memberry-ret010-receipt-verifier/1',
      Accept: 'application/octet-stream', 'Accept-Encoding': 'identity',
    });
    expect(calls[2]!.headers).not.toHaveProperty('Authorization');
    expect(calls[2]!.headers).not.toHaveProperty('Cookie');
    expect(calls[2]!.headers).not.toHaveProperty('X-GitHub-Api-Version');
    expect(calls[2]!.hooks).toMatchObject({
      marker: 'fixed-http-hooks',
      pin: { host: 'artifact.example', address: '93.184.216.34', family: 4 },
      deadline: { startedAt: 0, expiresAt: 120000, maximum: 120000 },
    });
    expect(resolutions).toBe(1);
    expect(buffer.toString('ascii', 0, token.length)).toBe('test-token');
    gate.__testWipeToken(token);
    expect(buffer.every((byte) => byte === 0)).toBe(true);
  });

  it('wipes the sole token buffer after an authenticated production-transport caller failure', async () => {
    const gate = await loadInstrumentedGate();
    const buffer = Buffer.alloc(4096);
    buffer.write('test-token', 'ascii');
    const token = { buffer, length: 10 };
    const transport = gate.__testProductionTransport(token, {
      requester: () => { throw new Error('request-construction-failure'); },
    });
    try {
      await expect(transport.request({ kind: 'metadata', url: 'https://api.github.com/metadata' }))
        .rejects.toThrow('request-construction-failure');
    } finally {
      gate.__testWipeToken(token);
    }
    expect(buffer.every((byte) => byte === 0)).toBe(true);
  });
});
