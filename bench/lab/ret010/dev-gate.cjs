#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const cp = require('node:child_process');
const dns = require('node:dns');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const zlib = require('node:zlib');

const REPO = path.resolve(__dirname, '..', '..', '..');
const RUNS = path.join(REPO, 'node_modules', '.cache', 'memberry-lab', 'runs');
const CONTROL = 'memberry-retrieval-core-disabled-v1';
const CANDIDATE = 'memberry-retrieval-core-served-v1';
const DATASET = 'memberry-ret010-dev-v1';
const POSITIVE = /^[1-9][0-9]*$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const LEAF = /^ret010-upload-[0-9a-f]{64}$/;
const DEV_SENTINEL = 'RET010_DEV_GATE_FAILED\n';
const VERIFY_SENTINEL = 'RET010_DEV_RECEIPT_VERIFY_FAILED\n';
const SUCCESS = Object.freeze([
  'recall-lane.json', 'precision-lane.json', 'efficiency-interval.json',
  'aggregate-result.json', 'custody-manifest.json',
]);
const SUCCESS_UPLOAD = Object.freeze([...SUCCESS, 'upload-complete.json']);
const FAILURE_UPLOAD = Object.freeze(['failure-tombstone.json', 'upload-complete.json']);
const FAILURE_CLASS_BY_STAGE = Object.freeze({
  'source-integrity': 'custody', registry: 'harness', 'load-dev': 'harness',
  'recall-comparison': 'model', 'precision-comparison': 'model', efficiency: 'metric',
  'quality-policy': 'metric', 'safety-policy': 'safety', 'response-effect': 'metric',
  artifact: 'custody',
});
const MUTABLE_PATHS = Object.freeze([
  '.github/workflows/ci.yml', '.github/workflows/ret010-holdout-qualification.yml',
  'bench/lab/adapters/memberry-retrieval-core.ts', 'bench/lab/registered-adapters.ts',
  'bench/lab/registry/systems.json', 'bench/lab/baselines/ci-gate.ts',
  'bench/lab/ret010/dev-gate.cjs', 'bench/lab/ret010/holdout-gate.mts',
  'bench/lab/__tests__/memberry-retrieval-core.test.ts',
  'bench/lab/__tests__/registered-adapters.test.ts',
  'bench/lab/baselines/__tests__/ci-gate-binding.test.ts',
  'bench/lab/ret010/__tests__/dev-gate.test.ts',
  'bench/lab/ret010/__tests__/holdout-gate.test.ts',
]);
const SECURITY_DEPENDENCIES = Object.freeze([
  'bench/lab/stats.ts', 'bench/lab/baselines/canonical.ts', 'bench/lab/datasets/hash.ts',
  'packages/retrieval/src/served-reranker.ts', 'packages/retrieval/src/reranker.ts',
  'packages/retrieval/src/assembler.ts',
]);
const EXECUTION_GRAPH = Object.freeze([...MUTABLE_PATHS, ...SECURITY_DEPENDENCIES]);
const SOURCES = Object.freeze([
  'bench/lab/ret010/dev-gate.cjs',
  'packages/retrieval/src/served-reranker.ts',
  'packages/retrieval/src/reranker.ts',
  'packages/retrieval/src/assembler.ts',
  'bench/lab/adapters/memberry-retrieval-core.ts',
  'bench/lab/stats.ts',
  'bench/lab/baselines/canonical.ts',
  'bench/lab/datasets/hash.ts',
  'bench/lab/registry/datasets.json',
  'bench/lab/ret010/load-dev.ts',
  'bench/lab/datasets/ret010/v1/dev/input.jsonl',
  'bench/lab/datasets/ret010/v1/dev/oracle.jsonl',
  'bench/lab/ret010/dev-policy.json',
]);
const PROVIDER = Object.freeze({
  providerId: 'memberry.local.lexical',
  modelId: 'bm25f-query-v1',
  calibrationId: 'fixed-blend-v1',
  locality: 'local',
});
const STATS_BLOB = '8840c2dd159837e9f26cdd9644162095bbae0bea';
const STATS_SHA256 = '2ff0eaa1a6608c7e640a8833257fa23f86aed686cb37c4fefa5325a842391644';
const POLICY_BLOB = 'eed832c23638cdc05f0318b475a6b159ca357996';
const POLICY_SHA256 = '1d5ca94ab459f538088de784c39ccdc862a605fc13f65d2639b73db7f42dc7df';

function reject() { throw new Error('ret010'); }
function hex40(value) { return typeof value === 'string' && HEX40.test(value); }
function hex64(value) { return typeof value === 'string' && HEX64.test(value); }
function positiveString(value) { return typeof value === 'string' && POSITIVE.test(value); }
function leafString(value) { return typeof value === 'string' && LEAF.test(value); }
function record(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) reject();
  return value;
}
function keys(value, expected) {
  record(value);
  if (JSON.stringify(Object.keys(value)) !== JSON.stringify(expected)) reject();
}
function finite(value, minimum, maximum) {
  return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)
    && value >= minimum && value <= maximum;
}
function canonical(value) { return Buffer.from(JSON.stringify(value) + '\n', 'utf8'); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function gitSha1(value) {
  return crypto.createHash('sha1').update(Buffer.from('blob ' + value.length + '\0')).update(value).digest('hex');
}
function decimal(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) reject();
  const result = value.toString(10);
  if (!POSITIVE.test(result) || Number(result) !== value || Number(result).toString(10) !== result) reject();
  return result;
}
function decimalString(value) {
  if (typeof value !== 'string' || !POSITIVE.test(value)) reject();
  return value;
}
function normalized(value) {
  if (!Number.isFinite(value)) reject();
  return Object.is(value, -0) ? 0 : value;
}
function failureTombstone(current, stage) {
  if (!Object.hasOwn(FAILURE_CLASS_BY_STAGE, stage)) reject();
  return {
    schemaVersion: '1', decision: 'failed', failureClass: FAILURE_CLASS_BY_STAGE[stage], stage,
    gitCommit: current.gitCommit, nodeMajor: current.nodeMajor, nodeVersion: current.nodeVersion,
    workflowRunId: current.workflowRunId, workflowRunAttempt: current.workflowRunAttempt,
  };
}
function validateFailureTombstone(value, current) {
  keys(value, ['schemaVersion', 'decision', 'failureClass', 'stage', 'gitCommit',
    'nodeMajor', 'nodeVersion', 'workflowRunId', 'workflowRunAttempt']);
  if (typeof value.stage !== 'string' || !Object.hasOwn(FAILURE_CLASS_BY_STAGE, value.stage)
    || value.schemaVersion !== '1' || value.decision !== 'failed'
    || value.failureClass !== FAILURE_CLASS_BY_STAGE[value.stage]
    || value.gitCommit !== current.gitCommit || value.nodeMajor !== current.nodeMajor
    || value.nodeVersion !== current.nodeVersion || value.workflowRunId !== current.workflowRunId
    || value.workflowRunAttempt !== current.workflowRunAttempt) reject();
  return value;
}
function appendOwn(target, value) {
  Object.defineProperty(target, target.length, {
    value, enumerable: true, writable: true, configurable: true,
  });
}

function parseJson(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) reject();
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let cursor = 0;
  const white = () => { while (cursor < text.length && /[\x20\t\r\n]/.test(text[cursor])) cursor += 1; };
  const string = () => {
    if (text[cursor++] !== '"') reject();
    let raw = '"';
    for (;;) {
      if (cursor >= text.length) reject();
      const char = text[cursor++];
      raw += char;
      if (char === '"') break;
      if (char === '\\') {
        if (cursor >= text.length) reject();
        const escaped = text[cursor++];
        raw += escaped;
        if (escaped === 'u') {
          const hex = text.slice(cursor, cursor + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) reject();
          raw += hex; cursor += 4;
        }
      } else if (char.charCodeAt(0) < 0x20) reject();
    }
    try { return JSON.parse(raw); } catch { reject(); }
  };
  const number = () => {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(cursor));
    if (!match) reject();
    cursor += match[0].length;
    const result = Number(match[0]);
    if (!Number.isFinite(result)) reject();
    return result;
  };
  const value = () => {
    white();
    if (text[cursor] === '"') return string();
    if (text[cursor] === '{') {
      cursor += 1; white();
      const result = Object.create(null);
      const seen = new Set();
      if (text[cursor] === '}') { cursor += 1; return result; }
      for (;;) {
        white(); const name = string(); white();
        if (seen.has(name) || text[cursor++] !== ':') reject();
        seen.add(name);
        Object.defineProperty(result, name, {
          value: value(), enumerable: true, writable: true, configurable: true,
        });
        white();
        const separator = text[cursor++];
        if (separator === '}') return result;
        if (separator !== ',') reject();
      }
    }
    if (text[cursor] === '[') {
      cursor += 1; white();
      const result = [];
      if (text[cursor] === ']') { cursor += 1; return result; }
      let index = 0;
      for (;;) {
        Object.defineProperty(result, index++, {
          value: value(), enumerable: true, writable: true, configurable: true,
        });
        white();
        const separator = text[cursor++];
        if (separator === ']') return result;
        if (separator !== ',') reject();
      }
    }
    if (text.startsWith('true', cursor)) { cursor += 4; return true; }
    if (text.startsWith('false', cursor)) { cursor += 5; return false; }
    if (text.startsWith('null', cursor)) { cursor += 4; return null; }
    return number();
  };
  const result = value(); white();
  if (cursor !== text.length) reject();
  return result;
}

function validateEntry(argv, execArgv, environment) {
  if (Object.hasOwn(environment, 'NODE_OPTIONS') || Object.hasOwn(environment, 'NODE_PATH')) reject();
  const script = path.resolve(argv[1] || '');
  if (script !== __filename) reject();
  const mode = argv[2];
  if (mode === 'run') {
    if (argv.length !== 3 || JSON.stringify(execArgv) !== JSON.stringify(['--import', 'tsx'])) reject();
  } else if (mode === 'verify-hosted') {
    if (argv.length !== 5 || execArgv.length !== 0 || !HEX40.test(argv[3]) || !POSITIVE.test(argv[4])) reject();
  } else if (mode === 'finalize') {
    if (argv.length !== 3 || execArgv.length !== 0) reject();
  } else reject();
  return mode;
}

function hardenedGit(args, encoding = 'utf8') {
  const environment = Object.create(null);
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.toUpperCase().startsWith('GIT_')) Object.defineProperty(environment, name, {
      value, enumerable: true, writable: true, configurable: true,
    });
  }
  for (const [name, value] of Object.entries({
    GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
  })) Object.defineProperty(environment, name, { value, enumerable: true, writable: true });
  return cp.execFileSync('git', [
    '--no-replace-objects', '--no-optional-locks',
    '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args,
  ], {
    cwd: REPO, env: environment, encoding, windowsHide: true, timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 40 * 1024 * 1024,
  });
}

function identity(environment) {
  const head = hardenedGit(['rev-parse', 'HEAD']);
  const dirty = hardenedGit(['status', '--porcelain=v1', '--untracked-files=all']);
  const major = process.versions.node.split('.')[0];
  if (!/^[0-9a-f]{40}\n$/.test(head) || dirty !== '' || !['20', '22'].includes(major)
    || !(new RegExp('^v' + major + '\\.[0-9]+\\.[0-9]+$')).test(process.version)) reject();
  return Object.freeze({
    gitCommit: head.trim(), nodeMajor: major, nodeVersion: process.version,
    workflowRunId: decimalString(environment.GITHUB_RUN_ID),
    workflowRunAttempt: decimalString(environment.GITHUB_RUN_ATTEMPT),
  });
}
function evaluationName(value) {
  return 'ret010-development-run-' + value.workflowRunId + '-attempt-'
    + value.workflowRunAttempt + '-node-' + value.nodeMajor;
}
async function directory(absolute) {
  const stat = await fsp.lstat(absolute, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fsp.realpath(absolute) !== absolute) reject();
  return stat;
}
async function runsRoot() {
  let current = await fsp.realpath(REPO);
  if (current !== REPO) reject();
  for (const component of ['node_modules', '.cache', 'memberry-lab', 'runs']) {
    current = path.join(current, component);
    await directory(current);
  }
  if (current !== RUNS) reject();
}
async function exclusiveDirectory(absolute) {
  await directory(path.dirname(absolute));
  await fsp.mkdir(absolute, { recursive: false, mode: 0o700 });
  await directory(absolute);
}
function retainedSnapshot(stat) {
  return Object.freeze({ dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size });
}
function retainedIdentityMatches(stat, snapshot, kind) {
  return stat.dev === snapshot.dev && stat.ino === snapshot.ino && stat.mode === snapshot.mode
    && (kind === 'directory' || stat.size === snapshot.size);
}
async function retainedCustody(operation, lifecycleHooks = {}) {
  const owners = [];
  const scope = Object.freeze({ owners });
  let result; let failure;
  try { result = await operation(scope); } catch (error) { failure = error; }
  const closeFailures = [];
  for (let index = owners.length - 1; index >= 0; index -= 1) {
    const owner = owners[index];
    if (owner.closeAttempted) {
      appendOwn(closeFailures, new Error('ret010'));
      continue;
    }
    owner.closeAttempted = true;
    try {
      if (lifecycleHooks.closeHandle) await lifecycleHooks.closeHandle(owner);
      else await owner.handle.close();
    } catch (error) { appendOwn(closeFailures, error); }
  }
  if (closeFailures.length) {
    failure = failure
      ? new AggregateError([failure, ...closeFailures], 'ret010')
      : new AggregateError(closeFailures, 'ret010');
  }
  if (failure) throw failure;
  return result;
}
async function retainHandle(scope, absolute, flags, kind, maximum = 2000000, mode) {
  if (typeof fs.constants.O_NOFOLLOW !== 'number') reject();
  await directory(path.dirname(absolute));
  const handle = mode === undefined
    ? await fsp.open(absolute, flags | fs.constants.O_NOFOLLOW)
    : await fsp.open(absolute, flags | fs.constants.O_NOFOLLOW, mode);
  const owner = {
    absolute, handle, kind, maximum, snapshot: undefined, bytes: undefined, closeAttempted: false,
  };
  appendOwn(scope.owners, owner);
  const opened = await handle.stat({ bigint: true });
  const current = await fsp.lstat(absolute, { bigint: true });
  if (kind === 'directory') {
    if (!opened.isDirectory() || !current.isDirectory() || current.isSymbolicLink()
      || await fsp.realpath(absolute) !== absolute) reject();
  } else if (!opened.isFile() || !current.isFile() || current.isSymbolicLink()
    || opened.size > BigInt(maximum)) reject();
  owner.snapshot = retainedSnapshot(opened);
  if (!retainedIdentityMatches(current, owner.snapshot, kind)) reject();
  return owner;
}
async function auditRetained(owner, expected, ioHooks) {
  const opened = await owner.handle.stat({ bigint: true });
  const current = await fsp.lstat(owner.absolute, { bigint: true });
  if (!retainedIdentityMatches(opened, owner.snapshot, owner.kind)
    || !retainedIdentityMatches(current, owner.snapshot, owner.kind)
    || current.isSymbolicLink()) reject();
  if (owner.kind === 'directory') {
    if (!opened.isDirectory() || !current.isDirectory()
      || await fsp.realpath(owner.absolute) !== owner.absolute) reject();
    return undefined;
  }
  if (!opened.isFile() || !current.isFile() || opened.size > BigInt(owner.maximum)) reject();
  const bytes = Buffer.alloc(Number(owner.snapshot.size));
  const read = ioHooks && ioHooks.readDestination
    ? await ioHooks.readDestination(owner, bytes)
    : await owner.handle.read(bytes, 0, bytes.length, 0);
  if (read.bytesRead !== bytes.length) reject();
  const after = await owner.handle.stat({ bigint: true });
  if (!retainedIdentityMatches(after, owner.snapshot, owner.kind)
    || (expected && !bytes.equals(expected))) reject();
  return bytes;
}
async function retainRead(scope, absolute, maximum = 2000000) {
  const owner = await retainHandle(scope, absolute, fs.constants.O_RDONLY, 'file', maximum);
  owner.bytes = await auditRetained(owner);
  return owner;
}
async function retainDirectory(scope, absolute) {
  return retainHandle(scope, absolute, fs.constants.O_RDONLY, 'directory');
}
async function retainExclusiveWrite(scope, root, name, value) {
  await directory(root);
  const bytes = canonical(value);
  const owner = await retainHandle(scope, path.join(root, name),
    fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL, 'file', 2000000, 0o600);
  const written = await owner.handle.write(bytes, 0, bytes.length, 0);
  if (written.bytesWritten !== bytes.length) reject();
  await owner.handle.sync();
  owner.snapshot = retainedSnapshot(await owner.handle.stat({ bigint: true }));
  if (!(await auditRetained(owner, bytes)).equals(bytes)) reject();
  owner.bytes = bytes;
  return owner;
}
async function readPinned(scope, absolute, maximum = 2000000) {
  return retainRead(scope, absolute, maximum);
}
async function writeExclusive(root, name, value) {
  return retainedCustody(async (scope) => (await retainExclusiveWrite(scope, root, name, value)).bytes);
}
async function appendStructuredOutput(absolute, value) {
  const bytes = Buffer.from(value, 'utf8');
  await retainedCustody(async (scope) => {
    const owner = await retainHandle(scope, absolute,
      fs.constants.O_WRONLY | fs.constants.O_APPEND, 'file', 2000000);
    const written = await owner.handle.write(bytes, 0, bytes.length, null);
    if (written.bytesWritten !== bytes.length) reject();
    await owner.handle.sync();
  });
}

function reportPairs(report) {
  const side = (arm) => {
    const map = new Map();
    for (const scenario of arm.scenarioReports) {
      if (scenario.outcome !== 'scored' || scenario.probes.length !== 1) reject();
      const probe = scenario.probes[0];
      const key = scenario.scenarioId + '\0' + probe.probeId;
      if (map.has(key) || !Number.isSafeInteger(probe.contextTokens)) reject();
      map.set(key, {
        scenarioId: scenario.scenarioId, probeId: probe.probeId,
        ids: [...probe.resultIds], coverage: probe.metrics.answerCoverage, tokens: probe.contextTokens,
      });
    }
    return map;
  };
  const control = side(report.control); const candidate = side(report.candidate);
  if (control.size !== 10 || candidate.size !== 10) reject();
  const pairs = []; let qualifying = 0;
  for (const key of [...control.keys()].sort()) {
    const left = control.get(key); const right = candidate.get(key);
    if (!right) reject();
    const order = JSON.stringify(left.ids) !== JSON.stringify(right.ids);
    const selection = JSON.stringify([...new Set(left.ids)].sort()) !== JSON.stringify([...new Set(right.ids)].sort());
    if (order && selection) qualifying += 1;
    appendOwn(pairs, {
      scenarioId: left.scenarioId, probeId: left.probeId,
      controlCoverage: left.coverage, controlTokens: left.tokens,
      candidateCoverage: right.coverage, candidateTokens: right.tokens,
    });
  }
  return { pairs, qualifying };
}
function metrics(arm) {
  return {
    recallAtK: normalized(arm.metrics.recallAtK), precisionAtK: normalized(arm.metrics.precisionAtK),
    staleLeakRate: normalized(arm.metrics.staleLeakRate), isolationLeakRate: normalized(arm.metrics.isolationLeakRate),
    duplicateRate: normalized(arm.metrics.duplicateRate), unknownResultRate: normalized(arm.metrics.unknownResultRate),
  };
}
function lane(report, name, qualifying) {
  const control = metrics(report.control); const candidate = metrics(report.candidate);
  return {
    schemaVersion: '1', lane: name, datasetId: DATASET, split: 'dev',
    controlAdapterId: CONTROL, candidateAdapterId: CANDIDATE,
    scenarioCount: 10, probeCount: 10, k: name === 'recall-at-10' ? 10 : 5,
    control, candidate,
    delta: {
      recallAtK: normalized(candidate.recallAtK - control.recallAtK),
      precisionAtK: normalized(candidate.precisionAtK - control.precisionAtK),
    },
    qualifyingCaseCount: qualifying, passed: true,
  };
}

async function pinPaths(scope, head, relatives) {
  if (hardenedGit(['rev-parse', 'HEAD']) !== head + '\n'
    || hardenedGit(['status', '--porcelain=v1', '--untracked-files=all']) !== '') reject();
  const result = Object.create(null); let aggregate = 0;
  for (const relative of relatives) {
    const tree = hardenedGit(['ls-tree', '-z', head, '--', relative], null);
    const match = /^100644 blob ([0-9a-f]{40})\t([^\0]+)\0$/.exec(tree.toString('utf8'));
    if (!match || match[2] !== relative) reject();
    const owner = await readPinned(scope, path.join(REPO, ...relative.split('/')), 4194304);
    const bytes = owner.bytes;
    aggregate += bytes.length;
    if (aggregate > 33554432) reject();
    const git = hardenedGit(['cat-file', 'blob', head + ':' + relative], null);
    if (!bytes.equals(git) || gitSha1(bytes) !== match[1]) reject();
    const pin = Object.create(null);
    Object.defineProperties(pin, {
      bytes: { value: bytes, enumerable: true },
      blob: { value: match[1], enumerable: true },
      sha256: { value: sha256(bytes), enumerable: true },
      owner: { value: owner, enumerable: false },
    });
    Object.defineProperty(result, relative, { value: Object.freeze(pin), enumerable: true });
  }
  return Object.freeze(result);
}
async function auditPinnedPaths(pins, head, relatives) {
  if (hardenedGit(['rev-parse', 'HEAD']) !== head + '\n'
    || hardenedGit(['status', '--porcelain=v1', '--untracked-files=all']) !== '') reject();
  for (const relative of relatives) {
    const pin = pins[relative];
    if (!pin) reject();
    const tree = hardenedGit(['ls-tree', '-z', head, '--', relative], null);
    const match = /^100644 blob ([0-9a-f]{40})\t([^\0]+)\0$/.exec(tree.toString('utf8'));
    if (!match || match[2] !== relative || match[1] !== pin.blob) reject();
    const bytes = await auditRetained(pin.owner, pin.bytes);
    const git = hardenedGit(['cat-file', 'blob', head + ':' + relative], null);
    if (!bytes.equals(git) || gitSha1(bytes) !== match[1] || sha256(bytes) !== pin.sha256) reject();
  }
}
async function sourcePins(scope, head) {
  const result = await pinPaths(scope, head, SOURCES);
  validatePinnedLiterals(result);
  return result;
}
function validatePinnedLiterals(result) {
  if (result['bench/lab/stats.ts'].blob !== STATS_BLOB
    || result['bench/lab/stats.ts'].sha256 !== STATS_SHA256
    || result['bench/lab/ret010/dev-policy.json'].blob !== POLICY_BLOB
    || result['bench/lab/ret010/dev-policy.json'].sha256 !== POLICY_SHA256) reject();
}
async function auditExecutionGraph(scope, head) {
  return pinPaths(scope, head, EXECUTION_GRAPH);
}
function textLf(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return Buffer.from(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8');
}
function nonempty(value) { return typeof value === 'string' && value.length > 0; }
function stringList(value) {
  if (!Array.isArray(value) || value.length === 0) reject();
  const seen = new Set();
  for (const item of value) {
    if (!nonempty(item) || seen.has(item)) reject();
    seen.add(item);
  }
}
function validateRegistryDescriptor(descriptor) {
  record(descriptor);
  const rootKeys = Object.hasOwn(descriptor, 'suite')
    ? ['id', 'version', 'suite', 'kind', 'split', 'oracleAccess', 'requiredInCi',
      'source', 'license', 'dataPolicy', 'acquisition', 'artifacts']
    : ['id', 'version', 'kind', 'split', 'oracleAccess', 'requiredInCi',
      'source', 'license', 'dataPolicy', 'acquisition', 'artifacts'];
  keys(descriptor, rootKeys);
  if (!nonempty(descriptor.id) || !nonempty(descriptor.version)
    || (Object.hasOwn(descriptor, 'suite') && !nonempty(descriptor.suite))
    || !['repository', 'external'].includes(descriptor.kind) || !nonempty(descriptor.split)
    || !['scorer-only', 'source-defined'].includes(descriptor.oracleAccess)
    || typeof descriptor.requiredInCi !== 'boolean') reject();
  const repository = descriptor.kind === 'repository';
  keys(descriptor.source, repository ? ['url', 'revision', 'path'] : ['url', 'revision', 'upstream']);
  if (repository) {
    if (descriptor.source.url !== null || !nonempty(descriptor.source.revision)
      || !nonempty(descriptor.source.path)) reject();
  } else if (!nonempty(descriptor.source.url) || descriptor.source.revision !== null
    || !nonempty(descriptor.source.upstream)) reject();
  keys(descriptor.license, ['status', 'spdx', 'url', 'usage']);
  if (!['internal', 'verified'].includes(descriptor.license.status)
    || !(descriptor.license.spdx === null || nonempty(descriptor.license.spdx))
    || !(descriptor.license.url === null || nonempty(descriptor.license.url))
    || !nonempty(descriptor.license.usage)) reject();
  keys(descriptor.dataPolicy, ['reviewStatus', 'containsPersonalData', 'containsSecrets',
    'containsCustomerData', 'exclusions']);
  if (!['verified', 'unverified'].includes(descriptor.dataPolicy.reviewStatus)) reject();
  for (const name of ['containsPersonalData', 'containsSecrets', 'containsCustomerData']) {
    const value = descriptor.dataPolicy[name];
    if (descriptor.dataPolicy.reviewStatus === 'verified') {
      if (typeof value !== 'boolean') reject();
    } else if (value !== null && typeof value !== 'boolean') reject();
  }
  stringList(descriptor.dataPolicy.exclusions);
  const blocked = descriptor.acquisition && descriptor.acquisition.status === 'blocked';
  keys(descriptor.acquisition, blocked ? ['status', 'reason'] : ['status']);
  if (!['available', 'blocked', 'bundled'].includes(descriptor.acquisition.status)
    || (blocked && !nonempty(descriptor.acquisition.reason))
    || (repository && descriptor.acquisition.status !== 'bundled')
    || (!repository && descriptor.acquisition.status === 'bundled')) reject();
  if (!Array.isArray(descriptor.artifacts) || descriptor.artifacts.length === 0) reject();
  const artifactNames = new Set();
  for (const artifact of descriptor.artifacts) {
    keys(artifact, ['role', 'access', 'fileName', 'repositoryPath', 'hashMode', 'sha256', 'sizeBytes']);
    if (!nonempty(artifact.role) || !nonempty(artifact.access) || !nonempty(artifact.fileName)
      || artifactNames.has(artifact.fileName) || !['text-lf', 'bytes'].includes(artifact.hashMode)
      || !(artifact.repositoryPath === null || nonempty(artifact.repositoryPath))
      || !(artifact.sha256 === null || hex64(artifact.sha256))
      || !(artifact.sizeBytes === null || (Number.isSafeInteger(artifact.sizeBytes)
        && artifact.sizeBytes >= 0))) reject();
    artifactNames.add(artifact.fileName);
    if (repository && (!nonempty(artifact.repositoryPath) || !hex64(artifact.sha256)
      || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0)) reject();
  }
}
function datasetDescriptor(pins) {
  const registry = parseJson(pins['bench/lab/registry/datasets.json'].bytes);
  keys(registry, ['schemaVersion', 'datasets']);
  if (registry.schemaVersion !== 1) reject();
  if (!Array.isArray(registry.datasets)) reject();
  const ids = new Set();
  for (const item of registry.datasets) {
    validateRegistryDescriptor(item);
    if (ids.has(item.id)) reject();
    ids.add(item.id);
  }
  const matches = registry.datasets.filter((item) => item.id === DATASET);
  if (matches.length !== 1) reject();
  const descriptor = matches[0];
  keys(descriptor, ['id', 'version', 'suite', 'kind', 'split', 'oracleAccess',
    'requiredInCi', 'source', 'license', 'dataPolicy', 'acquisition', 'artifacts']);
  keys(descriptor.source, ['url', 'revision', 'path']);
  keys(descriptor.license, ['status', 'spdx', 'url', 'usage']);
  keys(descriptor.dataPolicy, ['reviewStatus', 'containsPersonalData', 'containsSecrets',
    'containsCustomerData', 'exclusions']);
  keys(descriptor.acquisition, ['status']);
  if (descriptor.id !== DATASET || descriptor.version !== 'ret010-dev-v1'
    || descriptor.suite !== 'ret010-development' || descriptor.kind !== 'repository'
    || descriptor.split !== 'dev' || descriptor.oracleAccess !== 'scorer-only'
    || descriptor.requiredInCi !== false || descriptor.source.url !== null
    || descriptor.source.revision !== 'ret010-dev-v1'
    || descriptor.source.path !== 'bench/lab/datasets/ret010/v1/dev'
    || JSON.stringify(descriptor.license) !== JSON.stringify({ status: 'internal', spdx: null,
      url: null, usage: 'repository-tests-only' })
    || JSON.stringify(descriptor.dataPolicy) !== JSON.stringify({ reviewStatus: 'verified',
      containsPersonalData: false, containsSecrets: false, containsCustomerData: false,
      exclusions: ['real user memory', 'credentials', 'private customer data',
        'production tenant identifiers'] })
    || JSON.stringify(descriptor.acquisition) !== JSON.stringify({ status: 'bundled' })
    || !Array.isArray(descriptor.artifacts) || descriptor.artifacts.length !== 2) reject();
  const expected = [
    ['input', 'adapter', 'input.jsonl', 'bench/lab/datasets/ret010/v1/dev/input.jsonl'],
    ['oracle', 'scorer', 'oracle.jsonl', 'bench/lab/datasets/ret010/v1/dev/oracle.jsonl'],
  ];
  for (let index = 0; index < 2; index += 1) {
    const artifact = descriptor.artifacts[index];
    keys(artifact, ['role', 'access', 'fileName', 'repositoryPath', 'hashMode', 'sha256', 'sizeBytes']);
    const [role, access, fileName, repositoryPath] = expected[index];
    const normalized = textLf(pins[repositoryPath].bytes);
    if (artifact.role !== role || artifact.access !== access || artifact.fileName !== fileName
      || artifact.repositoryPath !== repositoryPath || artifact.hashMode !== 'text-lf'
      || artifact.sha256 !== sha256(normalized) || artifact.sizeBytes !== normalized.length) reject();
  }
  return sha256(Buffer.from(JSON.stringify(descriptor), 'utf8'));
}

function validatePolicy(pins) {
  const policy = parseJson(pins['bench/lab/ret010/dev-policy.json'].bytes);
  keys(policy, ['schemaVersion', 'controlAdapterId', 'candidateAdapterId', 'dataset',
    'lanes', 'safety', 'pairedVectorOrder', 'withinLaneSortKeys', 'efficiency']);
  keys(policy.dataset, ['id', 'split']); keys(policy.lanes, ['recall', 'precision']);
  keys(policy.lanes.recall, ['dimension', 'probes', 'k', 'minimumDelta']);
  keys(policy.lanes.precision, ['dimension', 'probes', 'k', 'minimumDelta']);
  keys(policy.safety, ['maxStaleLeakRate', 'maxIsolationLeakRate', 'maxDuplicateRate', 'maxUnknownResultRate']);
  keys(policy.efficiency, ['outcome', 'method', 'confidenceLevel', 'minimumPointDeltaExclusive',
    'minimumOneSided95LowerBound', 'resamples', 'minimumPairedProbes', 'seedRule']);
  if (policy.schemaVersion !== 1 || policy.controlAdapterId !== CONTROL || policy.candidateAdapterId !== CANDIDATE
    || policy.dataset.id !== DATASET || policy.dataset.split !== 'dev'
    || JSON.stringify(policy.lanes) !== JSON.stringify({
      recall: { dimension: 'recall', probes: 10, k: 10, minimumDelta: 0 },
      precision: { dimension: 'precision', probes: 10, k: 5, minimumDelta: 0.05 },
    }) || Object.values(policy.safety).some((value) => value !== 0)
    || JSON.stringify(policy.pairedVectorOrder) !== JSON.stringify(['recall', 'precision'])
    || JSON.stringify(policy.withinLaneSortKeys) !== JSON.stringify(['scenarioId', 'probeId'])
    || JSON.stringify(policy.efficiency) !== JSON.stringify({ outcome: 'measured', method: 'paired-bootstrap',
      confidenceLevel: 0.95, minimumPointDeltaExclusive: 0, minimumOneSided95LowerBound: 0,
      resamples: 2000, minimumPairedProbes: 10, seedRule: 'vector-derived' })) reject();
  return policy;
}

async function runEvaluation(environment) {
  const current = identity(environment);
  await runsRoot();
  const root = path.join(RUNS, evaluationName(current));
  await exclusiveDirectory(root);
  let stage = 'source-integrity';
  try {
    await retainedCustody(async (scope) => { await auditExecutionGraph(scope, current.gitCommit); });
    stage = 'registry';
    // These are the first repository TypeScript loads. Entry validation and
    // exclusive root creation have already completed.
    const { loadRet010DevScenarios } = require('./load-dev.ts');
    const { compareRegisteredAdapters } = require('../registered-adapters.ts');
    const { pairedEfficiencyInterval } = require('../stats.ts');
    stage = 'load-dev';
    const scenarios = await loadRet010DevScenarios(REPO);
    if (!Array.isArray(scenarios) || scenarios.length !== 20) reject();
    const policy = {
      minRecallAtK: 0, minPrecisionAtK: 0, minAnswerCoverage: 0,
      maxStaleLeakRate: 0, maxIsolationLeakRate: 0, maxDuplicateRate: 0,
      maxUnknownResultRate: 0, maxQualityRegression: 1,
    };
    stage = 'recall-comparison';
    const recallReport = await compareRegisteredAdapters({
      runId: 'ret010-development-recall', controlId: CONTROL, candidateId: CANDIDATE,
      scenarios: scenarios.slice(0, 10), splits: ['dev'], policy, repoRoot: REPO,
    });
    stage = 'precision-comparison';
    const precisionReport = await compareRegisteredAdapters({
      runId: 'ret010-development-precision', controlId: CONTROL, candidateId: CANDIDATE,
      scenarios: scenarios.slice(10), splits: ['dev'], policy, repoRoot: REPO,
    });
    const recallPairs = reportPairs(recallReport); const precisionPairs = reportPairs(precisionReport);
    const recall = lane(recallReport, 'recall-at-10', recallPairs.qualifying);
    const precision = lane(precisionReport, 'precision-at-5', precisionPairs.qualifying);
    stage = 'efficiency';
    const measured = pairedEfficiencyInterval([...recallPairs.pairs, ...precisionPairs.pairs]);
    if (measured.outcome !== 'measured' || measured.pairedProbes !== 20 || measured.resamples !== 2000
      || measured.level !== 0.95 || measured.point === null || measured.lower === null
      || measured.upper === null || measured.oneSidedLower === null) reject();
    const interval = {
      schemaVersion: '1', metric: 'task-success-per-1k-tokens', outcome: 'measured',
      pairedProbes: 20, resamples: 2000, level: 0.95, seed: measured.seed,
      point: normalized(measured.point), lower: normalized(measured.lower),
      upper: normalized(measured.upper), oneSidedLower: normalized(measured.oneSidedLower),
    };
    await retainedCustody(async (scope) => {
    const pins = await sourcePins(scope, current.gitCommit);
    validatePolicy(pins);
    const count = recall.qualifyingCaseCount + precision.qualifyingCaseCount;
    stage = 'quality-policy';
    if (recall.delta.recallAtK < 0 || precision.delta.precisionAtK < 0.05
      || interval.point <= 0 || interval.oneSidedLower < 0) reject();
    stage = 'safety-policy';
    const safety = {
      staleLeakRate: Math.max(recall.candidate.staleLeakRate, precision.candidate.staleLeakRate),
      isolationLeakRate: Math.max(recall.candidate.isolationLeakRate, precision.candidate.isolationLeakRate),
      duplicateRate: Math.max(recall.candidate.duplicateRate, precision.candidate.duplicateRate),
      unknownResultRate: Math.max(recall.candidate.unknownResultRate, precision.candidate.unknownResultRate),
    };
    if (Object.values(safety).some((value) => value !== 0)) reject();
    stage = 'response-effect';
    if (count < 1 || count > 20) reject();
    const recallBytes = canonical(recall); const precisionBytes = canonical(precision);
    const intervalBytes = canonical(interval);
    const aggregate = {
      schemaVersion: '1', decision: 'passed', datasetId: DATASET, split: 'dev',
      controlAdapterId: CONTROL, candidateAdapterId: CANDIDATE, providerIdentity: { ...PROVIDER },
      sourceCommit: current.gitCommit,
      modelBlob: pins['packages/retrieval/src/served-reranker.ts'].blob,
      providerContractBlob: pins['packages/retrieval/src/reranker.ts'].blob,
      adapterBlob: pins['bench/lab/adapters/memberry-retrieval-core.ts'].blob,
      statisticsBlob: pins['bench/lab/stats.ts'].blob,
      datasetDescriptorSha256: datasetDescriptor(pins),
      inputSha256: sha256(textLf(pins['bench/lab/datasets/ret010/v1/dev/input.jsonl'].bytes)),
      oracleSha256: sha256(textLf(pins['bench/lab/datasets/ret010/v1/dev/oracle.jsonl'].bytes)),
      devPolicySha256: pins['bench/lab/ret010/dev-policy.json'].sha256,
      recallLaneSha256: sha256(recallBytes), precisionLaneSha256: sha256(precisionBytes),
      efficiencyIntervalSha256: sha256(intervalBytes), seed: interval.seed,
      quality: {
        recallDelta: recall.delta.recallAtK, precisionDelta: precision.delta.precisionAtK,
        efficiencyPoint: interval.point, efficiencyOneSidedLower: interval.oneSidedLower,
      },
      safety, responseEffect: { sameCaseOrderAndSelectionChanged: true, qualifyingCaseCount: count },
      passed: true,
    };
    const aggregateBytes = canonical(aggregate);
    const manifest = {
      schemaVersion: '1', decision: 'passed', gitCommit: current.gitCommit,
      nodeMajor: current.nodeMajor, nodeVersion: current.nodeVersion,
      workflowRunId: current.workflowRunId, workflowRunAttempt: current.workflowRunAttempt,
      recallLaneSha256: sha256(recallBytes), precisionLaneSha256: sha256(precisionBytes),
      efficiencyIntervalSha256: sha256(intervalBytes), aggregateResultSha256: sha256(aggregateBytes),
    };
    stage = 'artifact';
    const executionPins = await auditExecutionGraph(scope, current.gitCommit);
    await auditPinnedPaths(pins, current.gitCommit, SOURCES);
    await auditPinnedPaths(executionPins, current.gitCommit, EXECUTION_GRAPH);
    for (const [name, value] of [
      ['recall-lane.json', recall], ['precision-lane.json', precision],
      ['efficiency-interval.json', interval], ['aggregate-result.json', aggregate],
      ['custody-manifest.json', manifest],
    ]) await writeExclusive(root, name, value);
    });
  } catch (error) {
    try {
      if ((await fsp.readdir(root)).length === 0) {
        await writeExclusive(root, 'failure-tombstone.json', failureTombstone(current, stage));
      }
    } catch { /* fixed failure surface */ }
    throw error;
  }
}

function canonicalRecord(bytes) {
  const value = parseJson(bytes);
  if (!canonical(value).equals(bytes)) reject();
  return value;
}
function unsigned32(value) {
  return typeof value === 'number' && Number.isInteger(value) && !Object.is(value, -0)
    && value >= 0 && value <= 0xffffffff;
}
function validateLaneRecord(value, laneName) {
  keys(value, ['schemaVersion', 'lane', 'datasetId', 'split', 'controlAdapterId',
    'candidateAdapterId', 'scenarioCount', 'probeCount', 'k', 'control', 'candidate',
    'delta', 'qualifyingCaseCount', 'passed']);
  for (const arm of [value.control, value.candidate]) {
    keys(arm, ['recallAtK', 'precisionAtK', 'staleLeakRate', 'isolationLeakRate',
      'duplicateRate', 'unknownResultRate']);
    for (const metric of Object.values(arm)) if (!finite(metric, 0, 1)) reject();
  }
  keys(value.delta, ['recallAtK', 'precisionAtK']);
  if (value.schemaVersion !== '1' || value.lane !== laneName || value.datasetId !== DATASET
    || value.split !== 'dev' || value.controlAdapterId !== CONTROL || value.candidateAdapterId !== CANDIDATE
    || value.scenarioCount !== 10 || value.probeCount !== 10
    || value.k !== (laneName === 'recall-at-10' ? 10 : 5)
    || !finite(value.delta.recallAtK, -1, 1) || !finite(value.delta.precisionAtK, -1, 1)
    || value.delta.recallAtK !== normalized(value.candidate.recallAtK - value.control.recallAtK)
    || value.delta.precisionAtK !== normalized(value.candidate.precisionAtK - value.control.precisionAtK)
    || !Number.isInteger(value.qualifyingCaseCount) || value.qualifyingCaseCount < 0
    || value.qualifyingCaseCount > 10 || value.passed !== true) reject();
}
function validateIntervalRecord(value) {
  keys(value, ['schemaVersion', 'metric', 'outcome', 'pairedProbes', 'resamples',
    'level', 'seed', 'point', 'lower', 'upper', 'oneSidedLower']);
  if (value.schemaVersion !== '1' || value.metric !== 'task-success-per-1k-tokens'
    || value.outcome !== 'measured' || value.pairedProbes !== 20 || value.resamples !== 2000
    || value.level !== 0.95 || !unsigned32(value.seed)
    || !finite(value.point, -Number.MAX_VALUE, Number.MAX_VALUE)
    || !finite(value.lower, -Number.MAX_VALUE, Number.MAX_VALUE)
    || !finite(value.upper, -Number.MAX_VALUE, Number.MAX_VALUE)
    || !finite(value.oneSidedLower, -Number.MAX_VALUE, Number.MAX_VALUE)
    || value.lower > value.point || value.point > value.upper || value.oneSidedLower > value.point) reject();
}
function validateManifestRecord(value, expected, records) {
  keys(value, ['schemaVersion', 'decision', 'gitCommit', 'nodeMajor', 'nodeVersion',
    'workflowRunId', 'workflowRunAttempt', 'recallLaneSha256', 'precisionLaneSha256',
    'efficiencyIntervalSha256', 'aggregateResultSha256']);
  if (value.schemaVersion !== '1' || value.decision !== 'passed' || value.gitCommit !== expected.gitCommit
    || value.nodeMajor !== expected.nodeMajor || value.nodeVersion !== expected.nodeVersion
    || value.workflowRunId !== expected.workflowRunId || value.workflowRunAttempt !== expected.workflowRunAttempt
    || !['20', '22'].includes(value.nodeMajor)
    || typeof value.nodeVersion !== 'string'
    || !(new RegExp('^v' + value.nodeMajor + '\\.[0-9]+\\.[0-9]+$')).test(value.nodeVersion)
    || !positiveString(value.workflowRunId) || !positiveString(value.workflowRunAttempt)
    || value.recallLaneSha256 !== sha256(records['recall-lane.json'])
    || value.precisionLaneSha256 !== sha256(records['precision-lane.json'])
    || value.efficiencyIntervalSha256 !== sha256(records['efficiency-interval.json'])
    || value.aggregateResultSha256 !== sha256(records['aggregate-result.json'])) reject();
}
function validateSuccess(records, expected) {
  const recall = canonicalRecord(records['recall-lane.json']);
  const precision = canonicalRecord(records['precision-lane.json']);
  const interval = canonicalRecord(records['efficiency-interval.json']);
  const aggregate = canonicalRecord(records['aggregate-result.json']);
  const manifest = canonicalRecord(records['custody-manifest.json']);
  validateLaneRecord(recall, 'recall-at-10'); validateLaneRecord(precision, 'precision-at-5');
  validateIntervalRecord(interval);
  keys(aggregate, ['schemaVersion', 'decision', 'datasetId', 'split', 'controlAdapterId',
    'candidateAdapterId', 'providerIdentity', 'sourceCommit', 'modelBlob',
    'providerContractBlob', 'adapterBlob', 'statisticsBlob', 'datasetDescriptorSha256',
    'inputSha256', 'oracleSha256', 'devPolicySha256', 'recallLaneSha256',
    'precisionLaneSha256', 'efficiencyIntervalSha256', 'seed', 'quality', 'safety',
    'responseEffect', 'passed']);
  keys(aggregate.providerIdentity, ['providerId', 'modelId', 'calibrationId', 'locality']);
  keys(aggregate.quality, ['recallDelta', 'precisionDelta', 'efficiencyPoint', 'efficiencyOneSidedLower']);
  keys(aggregate.safety, ['staleLeakRate', 'isolationLeakRate', 'duplicateRate', 'unknownResultRate']);
  keys(aggregate.responseEffect, ['sameCaseOrderAndSelectionChanged', 'qualifyingCaseCount']);
  validateManifestRecord(manifest, expected, records);
  const derivedSafety = {
    staleLeakRate: Math.max(recall.candidate.staleLeakRate, precision.candidate.staleLeakRate),
    isolationLeakRate: Math.max(recall.candidate.isolationLeakRate, precision.candidate.isolationLeakRate),
    duplicateRate: Math.max(recall.candidate.duplicateRate, precision.candidate.duplicateRate),
    unknownResultRate: Math.max(recall.candidate.unknownResultRate, precision.candidate.unknownResultRate),
  };
  if (aggregate.schemaVersion !== '1' || aggregate.decision !== 'passed'
    || aggregate.datasetId !== DATASET || aggregate.split !== 'dev'
    || aggregate.controlAdapterId !== CONTROL || aggregate.candidateAdapterId !== CANDIDATE
    || JSON.stringify(aggregate.providerIdentity) !== JSON.stringify(PROVIDER)
    || !hex40(aggregate.sourceCommit) || !hex40(aggregate.modelBlob)
    || !hex40(aggregate.providerContractBlob) || !hex40(aggregate.adapterBlob)
    || !hex40(aggregate.statisticsBlob)
    || !hex64(aggregate.datasetDescriptorSha256) || !hex64(aggregate.inputSha256)
    || !hex64(aggregate.oracleSha256) || !hex64(aggregate.devPolicySha256)
    || !hex64(aggregate.recallLaneSha256) || !hex64(aggregate.precisionLaneSha256)
    || !hex64(aggregate.efficiencyIntervalSha256) || !unsigned32(aggregate.seed)
    || aggregate.seed !== interval.seed || aggregate.passed !== true
    || aggregate.quality.recallDelta !== recall.delta.recallAtK
    || aggregate.quality.precisionDelta !== precision.delta.precisionAtK
    || aggregate.quality.efficiencyPoint !== interval.point
    || aggregate.quality.efficiencyOneSidedLower !== interval.oneSidedLower
    || !finite(aggregate.quality.recallDelta, -1, 1)
    || !finite(aggregate.quality.precisionDelta, -1, 1)
    || !finite(aggregate.quality.efficiencyPoint, -Number.MAX_VALUE, Number.MAX_VALUE)
    || !finite(aggregate.quality.efficiencyOneSidedLower, -Number.MAX_VALUE, Number.MAX_VALUE)
    || recall.delta.recallAtK < 0 || precision.delta.precisionAtK < 0.05
    || interval.point <= 0 || interval.oneSidedLower < 0
    || aggregate.sourceCommit !== expected.gitCommit
    || recall.qualifyingCaseCount + precision.qualifyingCaseCount
      !== aggregate.responseEffect.qualifyingCaseCount
    || !Number.isInteger(aggregate.responseEffect.qualifyingCaseCount)
    || aggregate.responseEffect.qualifyingCaseCount < 1 || aggregate.responseEffect.qualifyingCaseCount > 20
    || aggregate.responseEffect.sameCaseOrderAndSelectionChanged !== true
    || JSON.stringify(aggregate.safety) !== JSON.stringify(derivedSafety)
    || Object.values(derivedSafety).some((value) => value !== 0)
    || aggregate.recallLaneSha256 !== sha256(records['recall-lane.json'])
    || aggregate.precisionLaneSha256 !== sha256(records['precision-lane.json'])
    || aggregate.efficiencyIntervalSha256 !== sha256(records['efficiency-interval.json'])) reject();
}

async function finalize(environment, hooks = {}) {
  const outcome = environment.RET010_DEVELOPMENT_GATE_OUTCOME;
  if (outcome !== 'success' && outcome !== 'failure') reject();
  const current = identity(environment);
  await runsRoot();
  const evaluation = path.join(RUNS, evaluationName(current));
  const expected = outcome === 'success' ? SUCCESS : ['failure-tombstone.json'];
  const upload = await retainedCustody(async (scope) => {
    const executionPinSets = [];
    const evaluationOwner = await retainDirectory(scope, evaluation);
    const names = await fsp.readdir(evaluation);
    if (JSON.stringify(names.sort()) !== JSON.stringify([...expected].sort())) reject();
    const records = Object.create(null); const sourceOwners = Object.create(null);
    for (const name of expected) {
      const owner = await retainRead(scope, path.join(evaluation, name));
      sourceOwners[name] = owner; records[name] = owner.bytes;
    }
    if (outcome === 'success') validateSuccess(records, current);
    else {
      validateFailureTombstone(canonicalRecord(records['failure-tombstone.json']), current);
    }

    // The exact 13 mutable + 6 immutable graph is reacquired while the source
    // bundle remains pinned and before any upload leaf exists.
    appendOwn(executionPinSets, await auditExecutionGraph(scope, current.gitCommit));
    const leafName = 'ret010-upload-' + (hooks.randomBytes || crypto.randomBytes)(32).toString('hex');
    if (!leafString(leafName)) reject();
    const uploadPath = path.join(RUNS, leafName);
    await exclusiveDirectory(uploadPath);
    const uploadOwner = await retainDirectory(scope, uploadPath);
    const destinationOwners = Object.create(null);
    for (const name of expected) {
      destinationOwners[name] = await retainExclusiveWrite(scope, uploadPath, name,
        canonicalRecord(records[name]));
    }
    const payloadSha256 = outcome === 'success' ? {
      recallLaneSha256: sha256(records['recall-lane.json']),
      precisionLaneSha256: sha256(records['precision-lane.json']),
      efficiencyIntervalSha256: sha256(records['efficiency-interval.json']),
      aggregateResultSha256: sha256(records['aggregate-result.json']),
      custodyManifestSha256: sha256(records['custody-manifest.json']),
    } : { failureTombstoneSha256: sha256(records['failure-tombstone.json']) };
    const marker = {
      schemaVersion: '1', decision: 'complete', bundleKind: outcome,
      gitCommit: current.gitCommit, nodeMajor: current.nodeMajor, nodeVersion: current.nodeVersion,
      workflowRunId: current.workflowRunId, workflowRunAttempt: current.workflowRunAttempt,
      uploadLeafName: leafName, allowlist: outcome === 'success' ? SUCCESS_UPLOAD : FAILURE_UPLOAD,
      payloadSha256,
    };

    // Source, upload directory, and every destination remain simultaneously
    // retained while the graph is reacquired immediately before marker creation.
    await auditRetained(evaluationOwner);
    await auditRetained(uploadOwner);
    for (const name of expected) {
      await auditRetained(sourceOwners[name], records[name]);
      await auditRetained(destinationOwners[name], records[name]);
    }
    if (JSON.stringify((await fsp.readdir(evaluation)).sort()) !== JSON.stringify([...expected].sort())
      || JSON.stringify((await fsp.readdir(uploadPath)).sort()) !== JSON.stringify([...expected].sort())) reject();
    appendOwn(executionPinSets, await auditExecutionGraph(scope, current.gitCommit));
    const markerOwner = await retainExclusiveWrite(scope, uploadPath, 'upload-complete.json', marker);
    const markerBytes = markerOwner.bytes;
    const completionMarkerSha256 = sha256(markerBytes);
    if (hooks.beforeUploadPathOutput) {
      await hooks.beforeUploadPathOutput({ evaluation, upload: uploadPath });
    }

    // This is the final post-injection whole-bundle sweep. No reopen is allowed:
    // every comparison is through the original retained owner.
    appendOwn(executionPinSets, await auditExecutionGraph(scope, current.gitCommit));
    for (const pins of executionPinSets) {
      await auditPinnedPaths(pins, current.gitCommit, EXECUTION_GRAPH);
    }
    if (JSON.stringify(identity(environment)) !== JSON.stringify(current)) reject();
    await auditRetained(evaluationOwner);
    await auditRetained(uploadOwner);
    if (JSON.stringify((await fsp.readdir(evaluation)).sort()) !== JSON.stringify([...expected].sort())) reject();
    const finalNames = await fsp.readdir(uploadPath);
    if (JSON.stringify(finalNames.sort()) !== JSON.stringify([...marker.allowlist].sort())) reject();
    for (const name of expected) {
      await auditRetained(sourceOwners[name], records[name]);
      await auditRetained(destinationOwners[name], records[name]);
    }
    const finalMarker = await auditRetained(markerOwner, markerBytes);
    if (!finalMarker.equals(canonical(marker)) || sha256(finalMarker) !== completionMarkerSha256) reject();
    return uploadPath;
  }, hooks);
  const output = environment.GITHUB_OUTPUT;
  if (typeof output !== 'string' || output.length === 0) reject();
  await appendStructuredOutput(output, 'upload_path=' + upload + '\n');
}

function header(response, name) {
  if (!response || !Array.isArray(response.rawHeaders) || response.rawHeaders.length % 2 !== 0
    || response.rawHeaders.length > 256
    || response.rawHeaders.some((value) => typeof value !== 'string')) reject();
  let headerBytes = 0;
  for (const value of response.rawHeaders) {
    headerBytes += Buffer.byteLength(value, 'utf8');
    if (headerBytes > 65536) reject();
  }
  const found = [];
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    if (response.rawHeaders[index].toLowerCase() === name) appendOwn(found, response.rawHeaders[index + 1]);
  }
  return found;
}
function contentLength(response, required) {
  const values = header(response, 'content-length');
  if (values.length > 1 || (required && values.length !== 1)) reject();
  if (values.length) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(values[0])) reject();
    const length = Number(values[0]);
    if (!Number.isSafeInteger(length) || length !== response.body.length) reject();
  }
}
function metadata(response, allowLink = false) {
  const transfer = header(response, 'transfer-encoding');
  const lengths = header(response, 'content-length');
  const links = header(response, 'link');
  if (response.status !== 200 || header(response, 'location').length
    || header(response, 'content-encoding').length || transfer.length > 1 || lengths.length > 1
    || (transfer.length && lengths.length) || links.length > 1 || (!allowLink && links.length)
    || !Buffer.isBuffer(response.body)) reject();
  const type = header(response, 'content-type');
  if (type.length !== 1 || !/^application\/json(?:; charset=utf-8)?$/.test(type[0])
    || response.body.length > 8388608) reject();
  if (transfer.length) {
    if (transfer[0] !== 'chunked') reject();
  } else contentLength(response, false);
  return parseJson(response.body);
}

function artifactRedirect(response) {
  if (!Buffer.isBuffer(response.body) || response.status !== 302 || response.body.length !== 0
    || header(response, 'set-cookie').length || header(response, 'content-encoding').length
    || header(response, 'transfer-encoding').length) reject();
  const locations = header(response, 'location');
  if (locations.length !== 1) reject();
  const lengths = header(response, 'content-length');
  if (lengths.length > 1 || (lengths.length === 1 && lengths[0] !== '0')) reject();
  return locations[0];
}
function archiveResponse(response) {
  if (!Buffer.isBuffer(response.body) || response.status !== 200
    || response.body.length > 67108864 || header(response, 'location').length
    || header(response, 'set-cookie').length || header(response, 'content-encoding').length) reject();
  const transfer = header(response, 'transfer-encoding');
  const lengths = header(response, 'content-length');
  if (transfer.length > 1 || lengths.length > 1 || (transfer.length && lengths.length)
    || (transfer.length === 1 && transfer[0] !== 'chunked')) reject();
  contentLength(response, false);
  return response.body;
}
function descriptor(kind, url) { return Object.freeze({ kind, url }); }
function link(value, pathname, page, last) {
  if (value === undefined) { if (page < last) reject(); return; }
  const relations = new Map();
  const members = value.split(', ');
  if (members.join(', ') !== value) reject();
  for (const member of members) {
    const match = /^<([^<>]+)>; rel="(next|first|prev|last)"$/.exec(member);
    if (!match || relations.has(match[2])) reject();
    if (match[2] === 'prev' && page === 1) reject();
    const expectedPage = { next: page + 1, first: 1, prev: page - 1, last }[match[2]];
    const target = 'https://api.github.com' + pathname + '?per_page=100&page=' + expectedPage;
    if (match[1] !== target) reject();
    relations.set(match[2], expectedPage);
  }
  if ((page < last) !== relations.has('next')) reject();
  const expected = { next: page + 1, first: 1, prev: page - 1, last };
  for (const [name, target] of relations) if (target !== expected[name]) reject();
}
async function pages(transport, base, collection) {
  const output = []; let total; let last;
  for (let page = 1; page <= (last || 1); page += 1) {
    const response = await transport.request(descriptor('metadata',
      base + '/' + collection + '?per_page=100&page=' + page));
    const body = metadata(response, true);
    if (!Array.isArray(body[collection]) || typeof body.total_count !== 'number'
      || !Number.isSafeInteger(body.total_count) || body.total_count < 0) reject();
    if (total === undefined) {
      total = body.total_count; last = Math.max(1, Math.ceil(total / 100));
      if (total > 1000 || last > 10) reject();
    }
    if (body.total_count !== total) reject();
    const expected = page < last ? 100 : total - 100 * (last - 1);
    if (body[collection].length !== expected) reject();
    const links = header(response, 'link');
    if (links.length > 1) reject();
    link(links[0], new URL(base).pathname + '/' + collection, page, last);
    for (const item of body[collection]) appendOwn(output, item);
  }
  return normalizedEntries(output, total);
}
function normalizedEntries(values, total) {
  if (!Array.isArray(values) || values.length !== total) reject();
  const result = []; const ids = new Set();
  for (const value of values) {
    record(value);
    const id = decimal(value.id);
    if (ids.has(id)) reject();
    ids.add(id);
    appendOwn(result, Object.freeze({ value, id }));
  }
  return Object.freeze(result);
}
function one(values, predicate) {
  const found = values.filter(predicate);
  if (found.length !== 1) reject();
  return found[0];
}

function hostedSelection(run, jobs, artifacts, head, requestedRunId) {
  record(run); record(run.repository);
  const runId = decimal(run.id);
  const attempt = decimal(run.run_attempt);
  const repositoryId = decimal(run.repository.id);
  if (runId !== requestedRunId || run.head_sha !== head || run.status !== 'completed'
    || run.conclusion !== 'success' || run.repository.full_name !== 'AP3X-Dev/memberry'
    || run.path !== '.github/workflows/ci.yml' || run.name !== 'CI') reject();
  const selected = Object.create(null);
  for (const major of ['20', '22']) {
    const jobEntry = one(jobs, (entry) => entry.value.name === 'unit (' + major + ')');
    const job = jobEntry.value;
    const jobRunId = decimal(job.run_id);
    const jobAttempt = decimal(job.run_attempt);
    if (job.conclusion !== 'success' || job.status !== 'completed' || jobRunId !== runId
      || jobAttempt !== attempt || job.head_sha !== head || job.workflow_name !== run.name) reject();
    const name = 'memberry-ret010-development-node-' + major + '-' + runId + '-' + attempt;
    const artifactEntry = one(artifacts, (entry) => entry.value.name === name);
    const artifact = artifactEntry.value;
    record(artifact.workflow_run);
    const artifactRunId = decimal(artifact.workflow_run.id);
    const artifactRepositoryId = decimal(artifact.workflow_run.repository_id);
    const artifactHeadRepositoryId = decimal(artifact.workflow_run.head_repository_id);
    const archiveUrl = 'https://api.github.com/repos/AP3X-Dev/memberry/actions/artifacts/'
      + artifactEntry.id + '/zip';
    if (artifact.expired !== false || artifact.workflow_run.head_sha !== head
      || artifactRunId !== runId || artifactRepositoryId !== repositoryId
      || artifactHeadRepositoryId !== repositoryId
      || typeof artifact.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(artifact.digest)
      || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes <= 0
      || artifact.archive_download_url !== archiveUrl) reject();
    selected[major] = Object.freeze({
      name, id: artifactEntry.id, digest: artifact.digest.slice(7),
      size: artifact.size_in_bytes, archiveUrl,
    });
  }
  return Object.freeze({ runId, attempt, selected: Object.freeze(selected) });
}

function authenticatedArchive(bytes, digest, inspect) {
  if (!Buffer.isBuffer(bytes) || !hex64(digest) || typeof inspect !== 'function'
    || sha256(bytes) !== digest) reject();
  return inspect(bytes);
}
function u16(bytes, offset) {
  if (offset < 0 || offset + 2 > bytes.length) reject();
  return bytes.readUInt16LE(offset);
}
function u32(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) reject();
  return bytes.readUInt32LE(offset);
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zipAggregateSize(sizes) {
  if (!Array.isArray(sizes) || sizes.length !== SUCCESS_UPLOAD.length) reject();
  let aggregate = 0;
  for (const size of sizes) {
    if (!Number.isSafeInteger(size) || size < 0 || size > 0xffffffff) reject();
    aggregate += size;
    if (!Number.isSafeInteger(aggregate) || aggregate > 12000000) reject();
  }
  return aggregate;
}
function zipSizeProfile(sizes) {
  const aggregate = zipAggregateSize(sizes);
  if (sizes.some((size) => size > 2000000)) reject();
  return aggregate;
}
function zip(bytes, hooks = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 67108864 || bytes.length < 22) reject();
  record(hooks);
  const hookNames = ['beforeReconstruct', 'inflateRaw', 'crc32'];
  if (Object.keys(hooks).some((name) => !hookNames.includes(name) || typeof hooks[name] !== 'function')) reject();
  const eocd = bytes.length - 22;
  if (u32(bytes, eocd) !== 0x06054b50 || u16(bytes, eocd + 20) !== 0
    || u16(bytes, eocd + 4) !== 0 || u16(bytes, eocd + 6) !== 0) reject();
  const entries = u16(bytes, eocd + 10);
  const centralStart = u32(bytes, eocd + 16);
  const centralSize = u32(bytes, eocd + 12);
  if (entries !== 6 || u16(bytes, eocd + 8) !== entries
    || centralStart === 0xffffffff || centralSize === 0xffffffff
    || centralStart > eocd || centralSize > eocd || centralStart + centralSize !== eocd) reject();
  const expected = new Map(SUCCESS_UPLOAD.map((name) => [name, Buffer.from(name, 'ascii')]));
  const central = []; const starts = new Set();
  let cursor = centralStart;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > eocd || u32(bytes, cursor) !== 0x02014b50) reject();
    const made = u16(bytes, cursor + 4); const needed = u16(bytes, cursor + 6);
    const flags = u16(bytes, cursor + 8); const method = u16(bytes, cursor + 10);
    const crc = u32(bytes, cursor + 16); const compressed = u32(bytes, cursor + 20);
    const uncompressed = u32(bytes, cursor + 24); const nameLength = u16(bytes, cursor + 28);
    const extra = u16(bytes, cursor + 30); const comment = u16(bytes, cursor + 32);
    const diskStart = u16(bytes, cursor + 34); const internal = u16(bytes, cursor + 36);
    const external = u32(bytes, cursor + 38);
    const offset = u32(bytes, cursor + 42);
    if (![0x0014, 0x0314].includes(made) || needed !== 20 || (flags & ~0x0808)
      || ![0, 8].includes(method) || extra || comment || diskStart || internal
      || compressed === 0xffffffff || uncompressed === 0xffffffff || offset === 0xffffffff
      || starts.has(offset)) reject();
    if (made === 0x0014 ? ![0, 0x20].includes(external)
      : ((external >>> 16) & 0xfe00) !== 0x8000
        || ![0, 0x20].includes(external & 0xffff)) reject();
    const recordEnd = cursor + 46 + nameLength + extra + comment;
    if (nameLength === 0 || recordEnd > eocd) reject();
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    let name;
    for (const [candidate, candidateBytes] of expected) {
      if (nameBytes.equals(candidateBytes)) { name = candidate; break; }
    }
    if (!name || !expected.delete(name)) reject();
    starts.add(offset);
    appendOwn(central, {
      name, nameBytes: Buffer.from(nameBytes), flags, method, crc, compressed, uncompressed, offset,
    });
    cursor = recordEnd;
  }
  if (cursor !== eocd || expected.size) reject();
  const declaredAggregate = zipSizeProfile(central.map((entry) => entry.uncompressed));
  const physical = [...central].sort((left, right) => left.offset - right.offset);
  let expectedStart = 0;
  for (let index = 0; index < physical.length; index += 1) {
    const entry = physical[index];
    const start = entry.offset;
    if (start !== expectedStart || start + 30 > centralStart
      || u32(bytes, start) !== 0x04034b50 || u16(bytes, start + 4) !== 20
      || u16(bytes, start + 6) !== entry.flags || u16(bytes, start + 8) !== entry.method) reject();
    const localCrc = u32(bytes, start + 14); const localCompressed = u32(bytes, start + 18);
    const localUncompressed = u32(bytes, start + 22); const nameLength = u16(bytes, start + 26);
    const localNameStart = start + 30; const dataStart = localNameStart + nameLength;
    if (u16(bytes, start + 28) || nameLength !== entry.nameBytes.length || dataStart > centralStart
      || !bytes.subarray(localNameStart, dataStart).equals(entry.nameBytes)) reject();
    const dataEnd = dataStart + entry.compressed;
    if (!Number.isSafeInteger(dataEnd) || dataEnd < dataStart || dataEnd > centralStart) reject();
    let end = dataEnd;
    if (entry.flags & 8) {
      if (localCrc || localCompressed || localUncompressed) reject();
      const signed = u32(bytes, dataEnd) === 0x08074b50;
      const at = dataEnd + (signed ? 4 : 0);
      if (!signed && entry.crc === 0x08074b50) reject();
      if (u32(bytes, at) !== entry.crc || u32(bytes, at + 4) !== entry.compressed
        || u32(bytes, at + 8) !== entry.uncompressed) reject();
      end += signed ? 16 : 12;
    } else if (localCrc !== entry.crc || localCompressed !== entry.compressed
      || localUncompressed !== entry.uncompressed) reject();
    const nextStart = index + 1 < physical.length ? physical[index + 1].offset : centralStart;
    if (!Number.isSafeInteger(end) || end > centralStart || end !== nextStart) reject();
    entry.dataStart = dataStart; entry.dataEnd = dataEnd;
    expectedStart = end;
  }
  if (expectedStart !== centralStart) reject();
  const result = Object.create(null); let aggregate = 0;
  for (const entry of physical) {
    if (hooks.beforeReconstruct) hooks.beforeReconstruct(entry);
    let inflated;
    try {
      const input = bytes.subarray(entry.dataStart, entry.dataEnd);
      if (entry.method === 0) inflated = Buffer.from(input);
      else {
        const options = { maxOutputLength: Math.max(1, entry.uncompressed), info: true };
        const completed = hooks.inflateRaw
          ? hooks.inflateRaw(input, options) : zlib.inflateRawSync(input, options);
        if (!completed || !Buffer.isBuffer(completed.buffer) || !completed.engine
          || !Number.isSafeInteger(completed.engine.bytesWritten)
          || completed.engine.bytesWritten !== input.length) reject();
        inflated = completed.buffer;
      }
    } catch { reject(); }
    const checksum = hooks.crc32 ? hooks.crc32(inflated) : crc32(inflated);
    if (!Number.isSafeInteger(checksum) || checksum < 0 || checksum > 0xffffffff
      || inflated.length !== entry.uncompressed || checksum !== entry.crc) reject();
    aggregate += inflated.length; if (aggregate > 12000000) reject();
    Object.defineProperty(result, entry.name, {
      value: inflated, enumerable: true, writable: false, configurable: false,
    });
  }
  if (aggregate !== declaredAggregate) reject();
  return result;
}

function bundleMarker(files, head, major, runId, attempt) {
  const marker = canonicalRecord(files['upload-complete.json']);
  keys(marker, ['schemaVersion', 'decision', 'bundleKind', 'gitCommit', 'nodeMajor',
    'nodeVersion', 'workflowRunId', 'workflowRunAttempt', 'uploadLeafName', 'allowlist', 'payloadSha256']);
  if (marker.schemaVersion !== '1' || marker.decision !== 'complete' || marker.bundleKind !== 'success'
    || marker.gitCommit !== head || marker.nodeMajor !== major
    || marker.workflowRunId !== runId || marker.workflowRunAttempt !== attempt
    || !leafString(marker.uploadLeafName)
    || JSON.stringify(marker.allowlist) !== JSON.stringify(SUCCESS_UPLOAD)) reject();
  keys(marker.payloadSha256, ['recallLaneSha256', 'precisionLaneSha256',
    'efficiencyIntervalSha256', 'aggregateResultSha256', 'custodyManifestSha256']);
  for (const value of Object.values(marker.payloadSha256)) if (!hex64(value)) reject();
  return marker;
}

function verifyBundle(files, marker, head, major, runId, attempt) {
  const payloadNames = {
    recallLaneSha256: 'recall-lane.json', precisionLaneSha256: 'precision-lane.json',
    efficiencyIntervalSha256: 'efficiency-interval.json', aggregateResultSha256: 'aggregate-result.json',
    custodyManifestSha256: 'custody-manifest.json',
  };
  for (const [digestName, fileName] of Object.entries(payloadNames)) {
    if (marker.payloadSha256[digestName] !== sha256(files[fileName])) reject();
  }
  const manifest = canonicalRecord(files['custody-manifest.json']);
  const aggregate = canonicalRecord(files['aggregate-result.json']);
  validateSuccess(files, {
    gitCommit: head, nodeMajor: major, nodeVersion: marker.nodeVersion,
    workflowRunId: runId, workflowRunAttempt: attempt,
  });
  if (manifest.nodeVersion !== marker.nodeVersion) reject();
  return { marker, manifest, aggregate };
}

async function postCloseBundleAudit(leaf, identities, io = fsp) {
  const expectedNames = [...SUCCESS_UPLOAD].sort();
  const parent = path.dirname(leaf);
  const byPath = new Map(identities.map((identity) => [identity.absolute, identity]));
  const parentIdentity = byPath.get(parent); const leafIdentity = byPath.get(leaf);
  if (!parentIdentity || parentIdentity.kind !== 'directory'
    || !leafIdentity || leafIdentity.kind !== 'directory') reject();
  const auditDirectoryPath = async (identity) => {
    const current = await io.lstat(identity.absolute, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink()
      || !retainedIdentityMatches(current, identity.snapshot, 'directory')
      || await io.realpath(identity.absolute) !== identity.absolute) reject();
  };
  const membership = async () => {
    const entries = await io.readdir(leaf, { withFileTypes: true });
    const names = entries.map((entry) => entry.name).sort();
    if (JSON.stringify(names) !== JSON.stringify(expectedNames)
      || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) reject();
  };
  await auditDirectoryPath(parentIdentity); await auditDirectoryPath(leafIdentity); await membership();
  for (const name of SUCCESS_UPLOAD) {
    const absolute = path.join(leaf, name); const identity = byPath.get(absolute);
    if (!identity || identity.kind !== 'file' || !Buffer.isBuffer(identity.source)) reject();
    const before = await io.lstat(absolute, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()
      || !retainedIdentityMatches(before, identity.snapshot, 'file')
      || before.size !== BigInt(identity.source.length)) reject();
    const bytes = await io.readFile(absolute, {
      flag: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    });
    const after = await io.lstat(absolute, { bigint: true });
    if (!bytes.equals(identity.source) || sha256(bytes) !== sha256(identity.source)
      || !retainedIdentityMatches(after, identity.snapshot, 'file') || after.isSymbolicLink()) reject();
  }
  await membership(); await auditDirectoryPath(leafIdentity); await auditDirectoryPath(parentIdentity);
}

async function extractVerifiedBundle(files, marker, hooks = {}) {
  record(files); record(marker); record(hooks);
  const hookNames = ['beforeCreateFile', 'afterWrite', 'closeHandle', 'writeDestination', 'readDestination'];
  if (!leafString(marker.uploadLeafName) || !Array.isArray(marker.allowlist)
    || JSON.stringify(marker.allowlist) !== JSON.stringify(SUCCESS_UPLOAD)
    || Object.keys(hooks).some((name) => !hookNames.includes(name) || typeof hooks[name] !== 'function')) reject();
  const fileNames = Object.keys(files);
  if (fileNames.length !== SUCCESS_UPLOAD.length
    || SUCCESS_UPLOAD.some((name) => !Object.hasOwn(files, name))) reject();
  const pinnedFiles = Object.create(null); let aggregate = 0;
  for (const name of SUCCESS_UPLOAD) {
    const source = files[name];
    if (!Buffer.isBuffer(source) || source.length > 2000000) reject();
    aggregate += source.length;
    if (!Number.isSafeInteger(aggregate) || aggregate > 12000000) reject();
    Object.defineProperty(pinnedFiles, name, {
      value: Buffer.from(source), enumerable: true, writable: false, configurable: false,
    });
  }
  const firstCustody = await retainedCustody(async (scope) => {
    const parent = await fsp.mkdtemp(path.join(os.tmpdir(), 'memberry-ret010-verify-'));
    const parentOwner = await retainDirectory(scope, parent);
    await auditRetained(parentOwner);
    const leaf = path.join(parent, marker.uploadLeafName);
    if (path.dirname(leaf) !== parent || path.basename(leaf) !== marker.uploadLeafName) reject();
    await exclusiveDirectory(leaf);
    const leafOwner = await retainDirectory(scope, leaf);
    await auditRetained(parentOwner); await auditRetained(leafOwner);
    const fileOwners = [];
    for (const name of marker.allowlist) {
      if (!SUCCESS_UPLOAD.includes(name) || path.basename(name) !== name) reject();
      await auditRetained(leafOwner);
      const pinnedSource = pinnedFiles[name];
      const absolute = path.join(leaf, name);
      if (path.dirname(absolute) !== leaf || path.basename(absolute) !== name) reject();
      if (hooks.beforeCreateFile) await hooks.beforeCreateFile({ leaf, name, absolute });
      const owner = await retainHandle(scope, absolute,
        fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL, 'file', 2000000, 0o600);
      owner.name = name; owner.source = pinnedSource;
      const written = hooks.writeDestination
        ? await hooks.writeDestination(owner, pinnedSource)
        : await owner.handle.write(pinnedSource, 0, pinnedSource.length, 0);
      if (written.bytesWritten !== pinnedSource.length) reject();
      await owner.handle.sync();
      owner.snapshot = retainedSnapshot(await owner.handle.stat({ bigint: true }));
      if (hooks.afterWrite) await hooks.afterWrite({ leaf, name, absolute });
      await auditRetained(leafOwner);
      owner.bytes = await auditRetained(owner, pinnedSource, hooks);
      appendOwn(fileOwners, owner);
    }
    await auditRetained(parentOwner); await auditRetained(leafOwner);
    for (const owner of fileOwners) {
      if (!Buffer.isBuffer(files[owner.name]) || !owner.source.equals(files[owner.name])
        || !(await auditRetained(owner, owner.source, hooks)).equals(owner.source)
        || sha256(owner.bytes) !== sha256(owner.source)) reject();
    }
    return {
      leaf,
      identities: [parentOwner, leafOwner, ...fileOwners].map((owner) => Object.freeze({
        absolute: owner.absolute, kind: owner.kind, maximum: owner.maximum,
        snapshot: owner.snapshot, name: owner.name, source: owner.source,
      })),
    };
  }, hooks);
  const finalIdentities = await retainedCustody(async (scope) => {
    const identities = [];
    for (const expected of firstCustody.identities) {
      const owner = await retainHandle(scope, expected.absolute, fs.constants.O_RDONLY,
        expected.kind, expected.maximum);
      owner.name = expected.name; owner.source = expected.source;
      if (!retainedIdentityMatches(owner.snapshot, expected.snapshot, expected.kind)) reject();
      if (expected.kind === 'file') {
        owner.bytes = await auditRetained(owner, expected.source, hooks);
        if (!owner.bytes.equals(expected.source) || sha256(owner.bytes) !== sha256(expected.source)) reject();
      } else await auditRetained(owner);
      appendOwn(identities, Object.freeze({
        absolute: owner.absolute, kind: owner.kind, maximum: owner.maximum,
        snapshot: owner.snapshot, name: owner.name, source: owner.source,
      }));
    }
    return identities;
  }, hooks);
  const sealedIdentities = await retainedCustody(async (scope) => {
    const identities = [];
    for (const expected of finalIdentities) {
      const owner = await retainHandle(scope, expected.absolute, fs.constants.O_RDONLY,
        expected.kind, expected.maximum);
      owner.name = expected.name; owner.source = expected.source;
      if (!retainedIdentityMatches(owner.snapshot, expected.snapshot, expected.kind)) reject();
      if (expected.kind === 'file') {
        owner.bytes = await auditRetained(owner, expected.source);
        if (!owner.bytes.equals(expected.source) || sha256(owner.bytes) !== sha256(expected.source)) reject();
      } else await auditRetained(owner);
      appendOwn(identities, Object.freeze({
        absolute: owner.absolute, kind: owner.kind, maximum: owner.maximum,
        snapshot: owner.snapshot, name: owner.name, source: owner.source,
      }));
    }
    return identities;
  }, hooks);
  await postCloseBundleAudit(firstCustody.leaf, sealedIdentities);
  return firstCustody.leaf;
}

async function verifyAuthenticatedBundle(bytes, serviceDigest, expected, hooks = {}) {
  keys(expected, ['head', 'major', 'runId', 'attempt']); record(hooks);
  if (Object.keys(hooks).some((name) => !['zip', 'extraction'].includes(name))) reject();
  const files = authenticatedArchive(bytes, serviceDigest, (archive) => zip(archive, hooks.zip));
  const marker = bundleMarker(files, expected.head, expected.major, expected.runId, expected.attempt);
  await extractVerifiedBundle(files, marker, hooks.extraction);
  return verifyBundle(files, marker, expected.head, expected.major, expected.runId, expected.attempt);
}

function createVerifyHostedVerifier(options) {
  keys(options, ['transport']);
  if (!options.transport || typeof options.transport.request !== 'function') reject();
  return async function verifyHosted(head, runId) {
    if (!hex40(head) || !positiveString(runId)) reject();
    return retainedCustody(async (scope) => {
    const pins = await sourcePins(scope, head);
    validatePolicy(pins);
    const base = 'https://api.github.com/repos/AP3X-Dev/memberry/actions/runs/' + runId;
    const run = metadata(await options.transport.request(descriptor('metadata', base)));
    const jobs = await pages(options.transport, base, 'jobs');
    const artifacts = await pages(options.transport, base, 'artifacts');
    const hosted = hostedSelection(run, jobs, artifacts, head, runId);
    const attempt = hosted.attempt; const selected = hosted.selected;
    const bundles = Object.create(null);
    for (const major of ['20', '22']) {
      const redirect = await options.transport.request(descriptor('artifact-api',
        selected[major].archiveUrl));
      const target = new URL(artifactRedirect(redirect));
      if (target.protocol !== 'https:' || target.username || target.password || target.hash
        || (target.port && target.port !== '443')) reject();
      const downloaded = await options.transport.request(descriptor('archive', target.href));
      const archiveBytes = archiveResponse(downloaded);
      if (archiveBytes.length !== selected[major].size) reject();
      bundles[major] = await verifyAuthenticatedBundle(archiveBytes, selected[major].digest,
        { head, major, runId, attempt });
    }
    if (!canonical(bundles['20'].aggregate).equals(canonical(bundles['22'].aggregate))) reject();
    const a = bundles['20']; const b = bundles['22'];
    if (a.aggregate.modelBlob !== pins['packages/retrieval/src/served-reranker.ts'].blob
      || a.aggregate.providerContractBlob !== pins['packages/retrieval/src/reranker.ts'].blob
      || a.aggregate.adapterBlob !== pins['bench/lab/adapters/memberry-retrieval-core.ts'].blob
      || a.aggregate.statisticsBlob !== pins['bench/lab/stats.ts'].blob
      || a.aggregate.datasetDescriptorSha256 !== datasetDescriptor(pins)
      || a.aggregate.inputSha256 !== sha256(textLf(pins['bench/lab/datasets/ret010/v1/dev/input.jsonl'].bytes))
      || a.aggregate.oracleSha256 !== sha256(textLf(pins['bench/lab/datasets/ret010/v1/dev/oracle.jsonl'].bytes))
      || a.aggregate.devPolicySha256 !== pins['bench/lab/ret010/dev-policy.json'].sha256) reject();
    const approval = {
      schemaVersion: '1', decision: 'approved',
      source: {
        gitCommit: head,
        modelBlob: pins['packages/retrieval/src/served-reranker.ts'].blob,
        providerContractBlob: pins['packages/retrieval/src/reranker.ts'].blob,
        adapterBlob: pins['bench/lab/adapters/memberry-retrieval-core.ts'].blob,
        statisticsBlob: pins['bench/lab/stats.ts'].blob,
        providerIdentity: { ...PROVIDER },
      },
      development: {
        datasetDescriptorSha256: a.aggregate.datasetDescriptorSha256,
        inputSha256: a.aggregate.inputSha256, oracleSha256: a.aggregate.oracleSha256,
        devPolicySha256: a.aggregate.devPolicySha256, seed: a.aggregate.seed,
        aggregateResultSha256: sha256(canonical(a.aggregate)),
      },
      node20: {
        nodeVersion: a.marker.nodeVersion,
        custodyManifestSha256: a.marker.payloadSha256.custodyManifestSha256,
        completionMarkerSha256: sha256(canonical(a.marker)),
        artifactName: selected['20'].name, artifactId: selected['20'].id,
        artifactServiceSha256: selected['20'].digest,
      },
      node22: {
        nodeVersion: b.marker.nodeVersion,
        custodyManifestSha256: b.marker.payloadSha256.custodyManifestSha256,
        completionMarkerSha256: sha256(canonical(b.marker)),
        artifactName: selected['22'].name, artifactId: selected['22'].id,
        artifactServiceSha256: selected['22'].digest,
      },
      workflowRunId: runId, workflowRunAttempt: attempt,
    };
    await auditPinnedPaths(pins, head, SOURCES);
    return canonical(approval);
    });
  };
}

function environmentPolicy(environment) {
  const names = new Map();
  for (const raw of Object.keys(environment)) {
    if (!/^[\x00-\x7f]+$/.test(raw)) reject();
    const folded = raw.replace(/[a-z]/g, (char) => char.toUpperCase());
    if (names.has(folded)) reject();
    names.set(folded, raw);
  }
  const denied = new Set([
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS',
    'NODE_TLS_REJECT_UNAUTHORIZED', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_OPTIONS',
    'NODE_PATH', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
    'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
  ]);
  for (const name of names.keys()) {
    if (name.startsWith('GH_') || name.startsWith('GITHUB_') || denied.has(name)) reject();
  }
}
function ghConfigRoot(environment) {
  const raw = process.platform === 'win32'
    ? environment.APPDATA && path.join(environment.APPDATA, 'GitHub CLI')
    : environment.XDG_CONFIG_HOME
      ? path.join(environment.XDG_CONFIG_HOME, 'gh')
      : environment.HOME && path.join(environment.HOME, '.config', 'gh');
  if (typeof raw !== 'string' || !path.isAbsolute(raw) || path.resolve(raw) !== raw) reject();
  return raw;
}

function ipv4Octets(value) {
  if (typeof value !== 'string' || net.isIP(value) !== 4) reject();
  const parts = value.split('.');
  if (parts.length !== 4) reject();
  return parts.map((part) => {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) reject();
    const octet = Number(part);
    if (octet > 255) reject();
    return octet;
  });
}
function ipv6Words(value) {
  if (typeof value !== 'string' || value.includes('%') || net.isIP(value) !== 6) reject();
  const halves = value.toLowerCase().split('::');
  if (halves.length > 2) reject();
  const parseHalf = (half) => {
    if (half === '') return [];
    const tokens = half.split(':');
    const words = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token.includes('.')) {
        if (index !== tokens.length - 1) reject();
        const octets = ipv4Octets(token);
        appendOwn(words, (octets[0] << 8) | octets[1]);
        appendOwn(words, (octets[2] << 8) | octets[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(token)) reject();
        appendOwn(words, Number.parseInt(token, 16));
      }
    }
    return words;
  };
  const left = parseHalf(halves[0]);
  const right = halves.length === 2 ? parseHalf(halves[1]) : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) reject();
  const result = [];
  for (const word of left) appendOwn(result, word);
  for (let index = 0; index < missing; index += 1) appendOwn(result, 0);
  for (const word of right) appendOwn(result, word);
  if (result.length !== 8) reject();
  return result;
}
function canonicalIpv6(words) {
  let bestStart = -1;
  let bestLength = 1;
  for (let start = 0; start < words.length;) {
    if (words[start] !== 0) { start += 1; continue; }
    let end = start;
    while (end < words.length && words[end] === 0) end += 1;
    if (end - start > bestLength) { bestStart = start; bestLength = end - start; }
    start = end;
  }
  const values = words.map((word) => word.toString(16));
  if (bestStart < 0) return values.join(':');
  const before = values.slice(0, bestStart).join(':');
  const after = values.slice(bestStart + bestLength).join(':');
  return before + '::' + after;
}
function normalizedAddress(value) {
  if (net.isIP(value) === 4) {
    const octets = ipv4Octets(value);
    return Object.freeze({ address: octets.join('.'), family: 4, values: Object.freeze(octets) });
  }
  if (net.isIP(value) !== 6) reject();
  const words = ipv6Words(value);
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    const octets = [words[6] >>> 8, words[6] & 0xff, words[7] >>> 8, words[7] & 0xff];
    return Object.freeze({ address: octets.join('.'), family: 4, values: Object.freeze(octets) });
  }
  return Object.freeze({ address: canonicalIpv6(words), family: 6, values: Object.freeze(words) });
}
function publicAddress(value) {
  const normalized = normalizedAddress(value);
  if (normalized.family === 4) {
    const [a, b] = normalized.values;
    if (a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0 && [0, 2].includes(normalized.values[2]))
      || (a === 192 && ((b === 31 && normalized.values[2] === 196)
        || (b === 52 && normalized.values[2] === 193)
        || (b === 88 && normalized.values[2] === 99)
        || (b === 175 && normalized.values[2] === 48)))
      || (a === 198 && [18, 19].includes(b))
      || (a === 198 && b === 51 && normalized.values[2] === 100)
      || (a === 203 && b === 0 && normalized.values[2] === 113)) reject();
    return normalized;
  }
  const words = normalized.values;
  if ((words[0] & 0xe000) !== 0x2000
    || (words[0] === 0x2001 && ((words[1] & 0xfe00) === 0 || words[1] === 0x0db8))
    || words[0] === 0x2002
    || (words[0] === 0x3fff && (words[1] & 0xf000) === 0)) reject();
  return normalized;
}
function normalizedHost(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 253
    || !/^[\x21-\x7e]+$/.test(value)) reject();
  let host = value.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (net.isIP(host)) return normalizedAddress(host).address;
  const labels = host.split('.');
  if (labels.some((label) => label.length < 1 || label.length > 63
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) reject();
  return host;
}
async function resolvePublicHost(hostname, hooks) {
  const host = normalizedHost(hostname);
  const lookup = hooks && hooks.lookup ? hooks.lookup : dns.promises.lookup;
  const answers = await lookup(host, { all: true, verbatim: true });
  if (!Array.isArray(answers) || answers.length < 1 || answers.length > 64) reject();
  const publicAnswers = [];
  for (const answer of answers) {
    keys(answer, ['address', 'family']);
    const normalized = publicAddress(answer.address);
    if (answer.family !== net.isIP(answer.address)) reject();
    appendOwn(publicAnswers, normalized);
  }
  publicAnswers.sort((left, right) => left.family - right.family
    || (left.address < right.address ? -1 : left.address > right.address ? 1 : 0));
  return Object.freeze({ host, address: publicAnswers[0].address, family: publicAnswers[0].family });
}
function validateToken(token) {
  keys(token, ['buffer', 'length']);
  if (!Buffer.isBuffer(token.buffer) || token.buffer.length !== 4096
    || !Number.isSafeInteger(token.length) || token.length < 1 || token.length > 4096) reject();
  for (let index = 0; index < token.length; index += 1) {
    if (token.buffer[index] < 0x21 || token.buffer[index] > 0x7e) reject();
  }
}
function wipeToken(token) {
  if (!token || !Buffer.isBuffer(token.buffer)) return;
  try { token.buffer.fill(0); } catch { /* best effort; runtime/TLS copies are outside application custody */ }
}
function ghToken(environment, hooks) {
  return new Promise((resolve, rejectPromise) => {
    environmentPolicy(environment);
    const frozenConfigRoot = ghConfigRoot(environment);
    const now = hooks && hooks.now ? hooks.now : () => performance.now();
    const schedule = hooks && hooks.schedule ? hooks.schedule : (delay, callback) => setTimeout(callback, delay);
    const cancel = hooks && hooks.cancel ? hooks.cancel : (timer) => clearTimeout(timer);
    const spawn = hooks && hooks.spawn ? hooks.spawn : cp.spawn;
    const tokenBuffer = hooks && hooks.allocateToken ? hooks.allocateToken() : Buffer.alloc(4096);
    if (!Buffer.isBuffer(tokenBuffer) || tokenBuffer.length !== 4096) reject();
    const started = now();
    let child;
    try {
      child = spawn('gh', ['auth', 'token', '--hostname', 'github.com'], {
        cwd: REPO, env: environment, shell: false, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      wipeToken({ buffer: tokenBuffer });
      rejectPromise(new Error('ret010'));
      return;
    }
    let totalSize = 0;
    let tokenLength = 0;
    let lineEnded = false;
    let failed = false;
    let settled = false;
    let disposed = false;
    let stdoutDisposed = false;
    let stderrDisposed = false;
    let stdoutEnded = false;
    let stderrEnded = false;
    let deadlineTimer;
    let drainTimer;
    const timers = [];
    const arm = (delay, callback) => {
      const owner = { handle: undefined, active: true };
      owner.handle = schedule(delay, () => {
        if (!owner.active) return;
        owner.active = false;
        callback();
      });
      appendOwn(timers, owner);
      return owner;
    };
    const drainTimers = () => {
      let succeeded = true;
      for (const owner of timers) {
        if (!owner.active) continue;
        owner.active = false;
        try { cancel(owner.handle); } catch { succeeded = false; }
      }
      return succeeded;
    };
    const rejectOnce = () => {
      if (settled) return;
      settled = true;
      drainTimers();
      wipeToken({ buffer: tokenBuffer });
      rejectPromise(new Error('ret010'));
    };
    const disposeOnce = () => {
      if (settled || disposed) return;
      disposed = true;
      try { child.kill('SIGKILL'); } catch { /* the single disposal attempt failed */ }
      try { if (typeof child.unref === 'function') child.unref(); } catch { /* failure stays closed */ }
      stdoutDisposed = true;
      try { child.stdout.destroy(); } catch { /* the single pipe disposal attempt failed */ }
      try { if (typeof child.stdout.unref === 'function') child.stdout.unref(); } catch { /* failure stays closed */ }
      stderrDisposed = true;
      try { child.stderr.destroy(); } catch { /* the single pipe disposal attempt failed */ }
      try { if (typeof child.stderr.unref === 'function') child.stderr.unref(); } catch { /* failure stays closed */ }
    };
    const fail = () => {
      if (settled) return;
      failed = true;
      if (drainTimer !== undefined || disposed) return;
      const remaining = 30000 - (now() - started);
      if (remaining > 0) {
        try { drainTimer = arm(Math.min(5000, remaining), rejectOnce); } catch { /* fail below */ }
      }
      disposeOnce();
      if (remaining <= 0 || drainTimer === undefined) rejectOnce();
    };
    try {
      deadlineTimer = arm(Math.max(0, 30000 - (now() - started)), fail);
    } catch {
      disposeOnce();
      rejectOnce();
      return;
    }
    child.stdout.on('data', (chunk) => {
      if (settled || failed) return;
      if (now() - started > 30000) { fail(); return; }
      if (!Buffer.isBuffer(chunk)) { fail(); return; }
      for (const byte of chunk) {
        totalSize += 1;
        if (totalSize > 4097 || lineEnded) { fail(); return; }
        if (byte === 10) { lineEnded = true; continue; }
        if (byte < 0x21 || byte > 0x7e || tokenLength >= 4096) { fail(); return; }
        tokenBuffer[tokenLength] = byte;
        tokenLength += 1;
      }
    });
    child.stdout.on('end', () => { stdoutEnded = true; });
    child.stdout.on('error', fail);
    child.stderr.on('data', fail);
    child.stderr.on('end', () => { stderrEnded = true; });
    child.stderr.on('error', fail);
    child.on('error', fail);
    child.on('close', (code, signal) => {
      if (settled) return;
      if (failed || !stdoutEnded || !stderrEnded || code !== 0 || signal || now() - started > 30000
        || stdoutDisposed || stderrDisposed || !lineEnded || totalSize !== tokenLength + 1
        || tokenLength < 1 || tokenLength > 4096) {
        rejectOnce(); return;
      }
      try {
        if (ghConfigRoot(environment) !== frozenConfigRoot) { rejectOnce(); return; }
      } catch {
        rejectOnce(); return;
      }
      settled = true;
      if (drainTimers()) {
        resolve(Object.freeze({ buffer: tokenBuffer, length: tokenLength }));
      } else {
        wipeToken({ buffer: tokenBuffer });
        rejectPromise(new Error('ret010'));
      }
    });
  });
}
function httpRequest(url, headers, status, maximum, timeout, hooks) {
  return new Promise((resolve, rejectPromise) => {
    const now = hooks && hooks.now ? hooks.now : () => performance.now();
    const schedule = hooks && hooks.schedule ? hooks.schedule : (delay, callback) => setTimeout(callback, delay);
    const cancel = hooks && hooks.cancel ? hooks.cancel : (timer) => clearTimeout(timer);
    const get = hooks && hooks.get ? hooks.get : https.get;
    let pin;
    if (hooks && hooks.pin) {
      keys(hooks.pin, ['host', 'address', 'family']);
      const target = new URL(url);
      const address = publicAddress(hooks.pin.address);
      if (target.protocol !== 'https:' || normalizedHost(target.hostname) !== hooks.pin.host
        || address.address !== hooks.pin.address || address.family !== hooks.pin.family) reject();
      pin = hooks.pin;
    }
    const started = now();
    let expiresAt = started + timeout;
    if (hooks && hooks.deadline) {
      keys(hooks.deadline, ['startedAt', 'expiresAt', 'maximum']);
      if (!finite(hooks.deadline.startedAt, 0, Number.MAX_SAFE_INTEGER)
        || !finite(hooks.deadline.expiresAt, 0, Number.MAX_SAFE_INTEGER)
        || hooks.deadline.maximum !== timeout
        || hooks.deadline.expiresAt - hooks.deadline.startedAt !== timeout
        || started < hooks.deadline.startedAt || started > hooks.deadline.expiresAt) reject();
      expiresAt = hooks.deadline.expiresAt;
    }
    const chunks = [];
    let size = 0;
    const requestOwner = { resource: undefined, disposed: false, unrefed: false, closed: false };
    const responseOwner = { resource: undefined, disposed: false, unrefed: false, closed: false };
    const socketOwner = { resource: undefined, disposed: false, unrefed: false, closed: false };
    let responseEnded = false;
    let socketVerified = !pin;
    let failed = false;
    let deadlineFired = false;
    let settled = false;
    let result;
    let deadlineTimer;
    const arm = (delay, callback) => {
      const owner = { handle: undefined, active: true };
      owner.handle = schedule(delay, () => {
        if (!owner.active) return;
        owner.active = false;
        callback();
      });
      return owner;
    };
    const drainTimer = () => {
      if (!deadlineTimer || !deadlineTimer.active) return true;
      deadlineTimer.active = false;
      try { cancel(deadlineTimer.handle); return true; } catch { return false; }
    };
    const rejectOnce = () => {
      if (settled) return;
      settled = true;
      drainTimer();
      rejectPromise(new Error('ret010'));
    };
    const disposeOwner = (owner) => {
      if (!owner.resource || owner.disposed) return;
      owner.disposed = true;
      try { owner.resource.destroy(); } catch { /* the single disposal attempt failed */ }
      if (!owner.unrefed && typeof owner.resource.unref === 'function') {
        owner.unrefed = true;
        try { owner.resource.unref(); } catch { /* failure remains closed */ }
      }
    };
    const disposeAll = () => {
      disposeOwner(requestOwner);
      disposeOwner(responseOwner);
      disposeOwner(socketOwner);
    };
    const allClosed = () => [requestOwner, responseOwner, socketOwner]
      .every((owner) => !owner.resource || owner.closed);
    const maybeReject = () => {
      if (failed && (deadlineFired || allClosed())) rejectOnce();
    };
    const fail = () => {
      if (settled) return;
      failed = true;
      disposeAll();
      maybeReject();
    };
    const finish = () => {
      if (settled || failed || !result || !responseEnded || !responseOwner.closed
        || !requestOwner.closed || !socketOwner.resource || !socketOwner.closed || !socketVerified) return;
      if (now() > expiresAt) { fail(); return; }
      settled = true;
      if (drainTimer()) resolve(result); else rejectPromise(new Error('ret010'));
    };
    try {
      deadlineTimer = arm(Math.max(0, expiresAt - now()), () => {
        deadlineFired = true;
        fail();
        maybeReject();
      });
    } catch {
      rejectOnce();
      return;
    }
    try {
      const requestOptions = { headers, agent: false };
      if (pin) {
        requestOptions.servername = pin.host;
        requestOptions.checkServerIdentity = (hostname, certificate) => {
          try {
            if (normalizedHost(hostname) !== pin.host) return new Error('ret010');
            return tls.checkServerIdentity(pin.host, certificate);
          } catch { return new Error('ret010'); }
        };
        requestOptions.lookup = (hostname, options, callback) => {
          if (typeof options === 'function') { callback = options; options = Object.create(null); }
          try {
            if (normalizedHost(hostname) !== pin.host || typeof callback !== 'function') reject();
            if (options && options.all === true) {
              callback(null, [{ address: pin.address, family: pin.family }]);
            } else callback(null, pin.address, pin.family);
          } catch {
            if (typeof callback === 'function') callback(new Error('ret010'));
          }
        };
      }
      requestOwner.resource = get(url, requestOptions, (incoming) => {
        if (settled || responseOwner.resource) {
          try { incoming.destroy(); } catch { /* one disposal attempt for the rejected duplicate */ }
          try { if (typeof incoming.unref === 'function') incoming.unref(); } catch { /* fixed failure */ }
          fail();
          return;
        }
        responseOwner.resource = incoming;
        incoming.on('data', (chunk) => {
          if (settled || failed || responseEnded) return;
          if (now() > expiresAt) { fail(); return; }
          size += chunk.length;
          if (size > maximum) { fail(); return; }
          appendOwn(chunks, Buffer.from(chunk));
        });
        incoming.on('end', () => {
          if (settled || failed || responseEnded || now() > expiresAt
            || incoming.complete !== true || incoming.statusCode !== status) {
            fail(); return;
          }
          try {
            responseEnded = true;
            result = {
              status: incoming.statusCode,
              rawHeaders: Array.from(incoming.rawHeaders),
              body: Buffer.concat(chunks),
            };
          } catch { fail(); return; }
          finish();
        });
        incoming.on('aborted', fail);
        incoming.on('error', fail);
        incoming.on('close', () => {
          responseOwner.closed = true;
          if (!responseEnded) fail();
          if (failed) maybeReject(); else finish();
        });
        if (failed) { disposeAll(); maybeReject(); }
      });
    } catch {
      fail();
      return;
    }
    requestOwner.resource.on('socket', (ownedSocket) => {
      if (settled || socketOwner.resource) {
        try { ownedSocket.destroy(); } catch { /* one disposal attempt for the rejected duplicate */ }
        try { if (typeof ownedSocket.unref === 'function') ownedSocket.unref(); } catch { /* fixed failure */ }
        fail();
        return;
      }
      socketOwner.resource = ownedSocket;
      ownedSocket.on('error', fail);
      if (pin) {
        ownedSocket.once('secureConnect', () => {
          if (settled || failed || socketVerified) return;
          try {
            const remote = normalizedAddress(ownedSocket.remoteAddress);
            if (remote.address !== pin.address || remote.family !== pin.family) { fail(); return; }
            socketVerified = true;
            finish();
          } catch { fail(); }
        });
      }
      ownedSocket.on('close', () => {
        socketOwner.closed = true;
        if (pin && !socketVerified) fail();
        if (failed) maybeReject(); else finish();
      });
      if (failed) { disposeAll(); maybeReject(); }
    });
    requestOwner.resource.on('error', fail);
    requestOwner.resource.on('close', () => {
      requestOwner.closed = true;
      if (failed) maybeReject(); else finish();
    });
  });
}
function withinAbsoluteDeadline(promise, deadline, hooks) {
  return new Promise((resolve, rejectPromise) => {
    const now = hooks && hooks.now ? hooks.now : () => performance.now();
    const schedule = hooks && hooks.schedule ? hooks.schedule : (delay, callback) => setTimeout(callback, delay);
    const cancel = hooks && hooks.cancel ? hooks.cancel : (timer) => clearTimeout(timer);
    let settled = false;
    let timer;
    const timeout = () => {
      if (settled) return;
      settled = true;
      rejectPromise(new Error('ret010'));
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      try { if (timer !== undefined) cancel(timer); } catch { /* failure remains closed */ }
      rejectPromise(new Error('ret010'));
    };
    try {
      timer = schedule(Math.max(0, deadline.expiresAt - now()), timeout);
    } catch { fail(); return; }
    Promise.resolve(promise).then((value) => {
      if (settled) return;
      if (now() > deadline.expiresAt) { fail(); return; }
      settled = true;
      try { cancel(timer); } catch { rejectPromise(new Error('ret010')); return; }
      resolve(value);
    }, fail);
  });
}
function productionTransport(token, hooks) {
  validateToken(token);
  const requester = hooks && hooks.requester ? hooks.requester : httpRequest;
  const resolver = hooks && hooks.resolver ? hooks.resolver : resolvePublicHost;
  const authenticated = (request, expectedStatus, maximum) => {
    const headers = {
      Authorization: 'Bearer ' + token.buffer.toString('ascii', 0, token.length),
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'memberry-ret010-receipt-verifier/1', 'Accept-Encoding': 'identity',
    };
    try {
      return requester(request.url, headers, expectedStatus, maximum, 30000,
        hooks && hooks.httpHooks);
    } finally {
      // Node/TLS can retain internal copies; the application header object does not retain this representation.
      headers.Authorization = '';
    }
  };
  return Object.freeze({
    async request(request) {
      keys(request, ['kind', 'url']);
      if (request.kind === 'metadata') return authenticated(request, 200, 8388608);
      if (request.kind === 'artifact-api') return authenticated(request, 302, 65536);
      if (request.kind === 'archive') {
        const target = new URL(request.url);
        const clock = hooks && hooks.httpHooks;
        const now = clock && clock.now ? clock.now : () => performance.now();
        const startedAt = now();
        const deadline = Object.freeze({ startedAt, expiresAt: startedAt + 120000, maximum: 120000 });
        const pin = await withinAbsoluteDeadline(
          resolver(target.hostname, hooks && hooks.dnsHooks), deadline, clock,
        );
        return requester(request.url, {
          'User-Agent': 'memberry-ret010-receipt-verifier/1',
          Accept: 'application/octet-stream', 'Accept-Encoding': 'identity',
        }, 200, 67108864, 120000, { ...(hooks && hooks.httpHooks), pin, deadline });
      }
      reject();
    },
  });
}

async function main() {
  const mode = validateEntry(process.argv, process.execArgv, process.env);
  if (mode === 'run') return runEvaluation(process.env);
  if (mode === 'finalize') return finalize(process.env);
  let token;
  try {
    token = await ghToken(process.env);
    const verify = createVerifyHostedVerifier({ transport: productionTransport(token) });
    process.stdout.write(await verify(process.argv[3], process.argv[4]));
  } finally {
    wipeToken(token);
  }
}

function fixedFailureExit(mode, hooks) {
  const write = hooks && hooks.write ? hooks.write : fs.writeSync;
  const exit = hooks && hooks.exit ? hooks.exit : process.exit;
  const message = Buffer.from(mode === 'verify-hosted' ? VERIFY_SENTINEL : DEV_SENTINEL, 'utf8');
  let offset = 0;
  try {
    for (let attempts = 0; offset < message.length && attempts < message.length; attempts += 1) {
      const remaining = message.length - offset;
      const written = write(2, message, offset, remaining, null);
      if (!Number.isSafeInteger(written) || written <= 0 || written > remaining) break;
      offset += written;
    }
  } catch { /* best available fixed-prefix failure only */ }
  exit(1);
}

module.exports = Object.freeze({ createVerifyHostedVerifier });
if (require.main === module) {
  main().catch(() => fixedFailureExit(process.argv[2]));
}
