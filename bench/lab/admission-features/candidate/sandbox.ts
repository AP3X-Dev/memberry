import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod, lstat, mkdtemp, open, readdir, realpath, rmdir, unlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { types as nodeUtilTypes } from 'node:util';

import {
  ADMISSION_SANDBOX_LIMITS_V1,
  APPROVED_NODE_BASE_IMAGE_V1,
  type AdmissionSandboxFailureCodeV1,
} from './protocol.js';

export { ADMISSION_SANDBOX_LIMITS_V1 } from './protocol.js';

const CANDIDATE_ENV_V1 = Object.freeze({ LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' });
export const ADMISSION_SANDBOX_UID_V1 = 65_532 as const;
export const ADMISSION_SANDBOX_GID_V1 = 65_532 as const;
const REQUEST_KEYS = Object.freeze(['receipt', 'inputs'] as const);
const INVOCATION_KEYS = Object.freeze([
  'image', 'cidFile', 'runToken', 'hostEnvironment',
] as const);
const INPUT_KEYS = Object.freeze([
  'datasetId', 'datasetVersion', 'scenarioId', 'split', 'fixtureCode', 'signals',
] as const);
const SIGNAL_KEYS = Object.freeze([
  'priority', 'noveltyEvidence', 'retentionHorizon', 'evidenceSupport',
  'scopeBinding', 'sensitivitySignal',
] as const);
const ARTIFACT_KEYS_V1 = Object.freeze([
  'artifactVersion', 'datasetId', 'datasetVersion', 'evaluationContractVersion',
  'featureContractVersion', 'inputHash', 'predictions',
] as const);
const PREDICTION_KEYS_V1 = Object.freeze(['scenarioId', 'split', 'features'] as const);
const FEATURE_KEYS_V1 = Object.freeze(['contractId', 'contractVersion', 'extractor', 'dimensions'] as const);
const EXTRACTOR_KEYS_V1 = Object.freeze(['id', 'version'] as const);
const DIMENSION_KEYS_V1 = Object.freeze([
  'salience', 'novelty', 'durability', 'evidenceQuality', 'scopeConfidence', 'sensitivity',
] as const);
const EXACT_INPUT_IDENTITIES_V1 = Object.freeze([
  Object.freeze({ scenarioId: 'af-dev-001', split: 'dev' }),
  Object.freeze({ scenarioId: 'af-dev-002', split: 'dev' }),
  Object.freeze({ scenarioId: 'af-dev-003', split: 'dev' }),
  Object.freeze({ scenarioId: 'af-holdout-001', split: 'holdout' }),
  Object.freeze({ scenarioId: 'af-holdout-002', split: 'holdout' }),
  Object.freeze({ scenarioId: 'af-holdout-003', split: 'holdout' }),
] as const);
const EXACT_INPUT_HASH_V1 = 'sha256:41ef02bbe9df03e4f7b4f95b248265a71635aefa7cbe69c585a1eb8647936b24';
const IMAGE_PATTERN = /^sha256:([0-9a-f]{64})$/;
const SOURCE_FILES_V1 = Object.freeze([
  '.gitattributes', '.dockerignore', 'extractor.ts', 'protocol.ts', 'worker.ts',
  'container/Dockerfile', 'container/manifest.json',
]);
const CANDIDATE_BUNDLE_PATH_V1 = 'container/worker.mjs';
const IMMUTABLE_CANDIDATE_GIT_BLOBS_V1 = Object.freeze({
  '.gitattributes': Object.freeze({
    oid: 'ec64c96076aa42cec059a81674964ebed30a08b1',
    sha256: 'sha256:4f0dc4104daa287c9e59741c459e9447b5db113ea0333319cb9c38cd06d240df',
  }),
  '.dockerignore': Object.freeze({
    oid: 'e539af827ac1d4a2fca7b8d7d02a8ac34842b0e6',
    sha256: 'sha256:c9afff73aa8272fc505880c5c820eda36b3ba23805e06f10b473cbaa7dd78670',
  }),
  'extractor.ts': Object.freeze({
    oid: '6a84fdf09c1652b121168196323d388151aa88ad',
    sha256: 'sha256:da0b6d633dc7920f71b376da9fc3450259bd7cee2a3a12aedd2d397ab48bede7',
  }),
  'protocol.ts': Object.freeze({
    oid: '17ee9adde52bbc52e351153b465ce38db1714b5b',
    sha256: 'sha256:954667045d8aae708c115df28c31b4d698908e87c00cc8b70d4916b87d3f49ba',
  }),
  'worker.ts': Object.freeze({
    oid: '3d520cdebb485ba2af4b52be07e2b56c77a44a13',
    sha256: 'sha256:8a3c2e85e9225a28c22c1902a4b5284f54537abcb1dd6c112bb2691e91705471',
  }),
  'container/Dockerfile': Object.freeze({
    oid: '60911c76ab5dd27016a2ba939ed3637b798c4de1',
    sha256: 'sha256:999d3e38f341c0c2f1c440375d00e5cc3cd9a7ccc6ee68d7253884cd62470c44',
  }),
  'container/manifest.json': Object.freeze({
    oid: '1f0a04ad741ca085f25cc4b12c66ff3c869fb2fb',
    sha256: 'sha256:4d8c152cecffa1c546899eac2a014c032694c06f6800e2d5379585428f9512ed',
  }),
  'container/worker.mjs': Object.freeze({
    oid: 'cb706c3a27e6f5afe1026890d9dfda9ac4140cb2',
    sha256: 'sha256:b1f3b0f9d23b7bf212c5e20844e05a44aef9694dbcc8888ab908137eb95d4211',
  }),
} as const);
const TYPED_ARRAY_PROTOTYPE_V1 = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_BYTE_LENGTH_V1 = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE_V1, 'byteLength',
)?.get;
const TRUSTED_EXACT_BYTES_V1 = new WeakSet<object>();

function sealTrustedExactBytesV1(bytes: Uint8Array): Uint8Array {
  Object.preventExtensions(bytes);
  TRUSTED_EXACT_BYTES_V1.add(bytes);
  return bytes;
}

export function snapshotExactUint8ArrayV1(
  value: unknown,
  minimum: number,
  maximum: number,
): Uint8Array {
  if (typeof value !== 'object' || value === null || nodeUtilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Uint8Array.prototype
    || typeof TYPED_ARRAY_BYTE_LENGTH_V1 !== 'function'
    || !Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum)
    || minimum < 0 || maximum < minimum) throw new Error('invalid byte sequence');
  let length: number;
  try {
    length = TYPED_ARRAY_BYTE_LENGTH_V1.call(value) as number;
  } catch {
    throw new Error('invalid byte sequence');
  }
  if (!Number.isSafeInteger(length) || length < minimum || length > maximum) {
    throw new Error('invalid byte sequence');
  }
  const source = value as Uint8Array;
  const result = new Uint8Array(length);
  if (TRUSTED_EXACT_BYTES_V1.has(source) && !Object.isExtensible(source)) {
    Uint8Array.prototype.set.call(result, source);
    return sealTrustedExactBytesV1(result);
  }
  const keys = Reflect.ownKeys(source);
  if (keys.length !== length) throw new Error('invalid byte sequence');
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(source, String(index));
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || descriptor.writable !== true || descriptor.enumerable !== true
      || descriptor.configurable !== true || typeof descriptor.value !== 'number'
      || !Number.isInteger(descriptor.value) || descriptor.value < 0 || descriptor.value > 255) {
      throw new Error('invalid byte sequence');
    }
    result[index] = descriptor.value;
  }
  return sealTrustedExactBytesV1(result);
}

export interface AdmissionSandboxInvocationV1 {
  readonly executable: 'docker';
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly shell: false;
  readonly stdin?: Uint8Array;
  readonly timeoutMs?: number;
  readonly stdoutLimit?: number;
  readonly stderrLimit?: number;
}

function octalField(value: number, width: number): Uint8Array {
  const encoded = value.toString(8).padStart(width - 1, '0');
  if (encoded.length !== width - 1) throw new Error('tar value out of bounds');
  return new TextEncoder().encode(`${encoded}\0`);
}

function writeField(target: Uint8Array, offset: number, width: number, value: Uint8Array): void {
  if (value.byteLength > width) throw new Error('tar field out of bounds');
  target.set(value, offset);
}

export function createAdmissionInputArchiveV1(content: Uint8Array): Uint8Array {
  content = snapshotExactUint8ArrayV1(content, 1, ADMISSION_SANDBOX_LIMITS_V1.inputBytes);
  const header = new Uint8Array(512);
  writeField(header, 0, 100, new TextEncoder().encode('run/input.json'));
  writeField(header, 100, 8, octalField(0o400, 8));
  writeField(header, 108, 8, octalField(ADMISSION_SANDBOX_UID_V1, 8));
  writeField(header, 116, 8, octalField(ADMISSION_SANDBOX_GID_V1, 8));
  writeField(header, 124, 12, octalField(content.byteLength, 12));
  writeField(header, 136, 12, octalField(0, 12));
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  writeField(header, 257, 6, new TextEncoder().encode('ustar\0'));
  writeField(header, 263, 2, new TextEncoder().encode('00'));
  const checksum = header.reduce((total, byte) => total + byte, 0);
  writeField(header, 148, 8, new TextEncoder().encode(
    `${checksum.toString(8).padStart(6, '0')}\0 `,
  ));
  const paddedContentLength = Math.ceil(content.byteLength / 512) * 512;
  const archive = new Uint8Array(512 + paddedContentLength + 1_024);
  archive.set(header, 0);
  archive.set(content, 512);
  return sealTrustedExactBytesV1(archive);
}

function parseTarOctal(bytes: Uint8Array): number {
  const value = new TextDecoder('ascii').decode(bytes).replace(/[\0 ]+$/g, '');
  if (!/^[0-7]+$/.test(value)) throw new Error('invalid tar integer');
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) throw new Error('invalid tar integer');
  return parsed;
}

function exactTarOctalFieldV1(bytes: Uint8Array, value: number): boolean {
  const expected = octalField(value, bytes.byteLength);
  return bytes.byteLength === expected.byteLength
    && bytes.every((byte, index) => byte === expected[index]);
}

function exactNullTerminatedTarNameV1(bytes: Uint8Array): string {
  const nul = bytes.indexOf(0);
  if (nul < 1 || bytes.subarray(nul).some((byte) => byte !== 0)) {
    throw new Error('invalid Docker copy archive');
  }
  const name = new TextDecoder('ascii', { fatal: true }).decode(bytes.subarray(0, nul));
  if (!/^[.A-Za-z0-9/_-]+$/.test(name)) throw new Error('invalid Docker copy archive');
  return name;
}

export function inspectDockerCopyArchiveV1(
  archive: Uint8Array,
  expectedName: 'worker.mjs' | 'attestation.json' | 'node',
): Uint8Array {
  const maximumContent = expectedName === 'node' ? 134_217_728 : 262_144;
  archive = snapshotExactUint8ArrayV1(archive, 1_536, maximumContent + 2_048);
  const header = archive.subarray(0, 512);
  const path = exactNullTerminatedTarNameV1(header.subarray(0, 100));
  const mode = parseTarOctal(header.subarray(100, 108));
  const uid = parseTarOctal(header.subarray(108, 116));
  const gid = parseTarOctal(header.subarray(116, 124));
  const size = parseTarOctal(header.subarray(124, 136));
  const mtime = parseTarOctal(header.subarray(136, 148));
  const storedChecksum = parseTarOctal(header.subarray(148, 156));
  const checksumHeader = header.slice();
  checksumHeader.fill(0x20, 148, 156);
  const calculatedChecksum = checksumHeader.reduce((total, byte) => total + byte, 0);
  const expectedLength = 512 + Math.ceil(size / 512) * 512 + 1_024;
  const expectedMode = expectedName === 'node' ? 0o755 : 0o444;
  const expectedOwner = expectedName === 'node' ? 0 : ADMISSION_SANDBOX_UID_V1;
  if ((path !== expectedName && path !== `app/${expectedName}`
      && path !== `usr/local/bin/${expectedName}`)
    || header[156] !== 0x30 || size < 1 || size > maximumContent
    || mode !== expectedMode || uid !== expectedOwner || gid !== expectedOwner
    || !exactTarOctalFieldV1(header.subarray(100, 108), mode)
    || !exactTarOctalFieldV1(header.subarray(108, 116), uid)
    || !exactTarOctalFieldV1(header.subarray(116, 124), gid)
    || !exactTarOctalFieldV1(header.subarray(124, 136), size)
    || !exactTarOctalFieldV1(header.subarray(136, 148), mtime)
    || !header.subarray(157, 257).every((byte) => byte === 0)
    || !header.subarray(257, 263).every((byte, index) => byte === [0x75, 0x73, 0x74, 0x61, 0x72, 0][index])
    || !header.subarray(263, 265).every((byte, index) => byte === [0x30, 0x30][index])
    || !header.subarray(265, 329).every((byte) => byte === 0)
    || !exactTarOctalFieldV1(header.subarray(329, 337), 0)
    || !exactTarOctalFieldV1(header.subarray(337, 345), 0)
    || !header.subarray(345, 512).every((byte) => byte === 0)
    || !header.subarray(148, 156).every((byte, index) => byte
      === new TextEncoder().encode(`${calculatedChecksum.toString(8).padStart(6, '0')}\0 `)[index])
    || storedChecksum !== calculatedChecksum || archive.byteLength !== expectedLength
    || archive.subarray(512 + size).some((byte) => byte !== 0)) {
    throw new Error('invalid Docker copy archive');
  }
  return sealTrustedExactBytesV1(archive.slice(512, 512 + size));
}

export function inspectAdmissionInputArchiveV1(archive: Uint8Array): Readonly<{
  path: 'run/input.json';
  type: 'file';
  mode: 0o400;
  uid: typeof ADMISSION_SANDBOX_UID_V1;
  gid: typeof ADMISSION_SANDBOX_GID_V1;
  content: Uint8Array;
}> {
  archive = snapshotExactUint8ArrayV1(
    archive, 1_536, ADMISSION_SANDBOX_LIMITS_V1.inputBytes + 2_048,
  );
  const header = archive.subarray(0, 512);
  const path = new TextDecoder('ascii').decode(header.subarray(0, 100)).replace(/\0+$/g, '');
  const mode = parseTarOctal(header.subarray(100, 108));
  const uid = parseTarOctal(header.subarray(108, 116));
  const gid = parseTarOctal(header.subarray(116, 124));
  const size = parseTarOctal(header.subarray(124, 136));
  if (path !== 'run/input.json' || mode !== 0o400 || uid !== ADMISSION_SANDBOX_UID_V1
    || gid !== ADMISSION_SANDBOX_GID_V1 || header[156] !== 0x30
    || size < 1 || size > ADMISSION_SANDBOX_LIMITS_V1.inputBytes
    || archive.byteLength !== 512 + Math.ceil(size / 512) * 512 + 1_024
    || archive.subarray(512 + size).some((byte) => byte !== 0)) {
    throw new Error('invalid input archive');
  }
  return Object.freeze({
    path: 'run/input.json',
    type: 'file',
    mode: 0o400,
    uid: ADMISSION_SANDBOX_UID_V1,
    gid: ADMISSION_SANDBOX_GID_V1,
    content: sealTrustedExactBytesV1(archive.slice(512, 512 + size)),
  });
}

export function dockerCliEnvironmentV1(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    throw new Error('invalid host environment');
  }
  const result: Record<string, string> = {
    PATH: process.platform === 'win32'
      ? 'C:\\Windows\\System32;C:\\Windows'
      : '/usr/local/bin:/usr/bin:/bin',
    LANG: CANDIDATE_ENV_V1.LANG,
    LC_ALL: CANDIDATE_ENV_V1.LC_ALL,
    TZ: CANDIDATE_ENV_V1.TZ,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
  };
  if (process.platform === 'win32') {
    result.SystemRoot = 'C:\\Windows';
  }
  return Object.freeze(result);
}

export async function resolveTrustedDockerExecutableV1(): Promise<string> {
  const candidates = process.platform === 'win32'
    ? [
      'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
      'C:\\ProgramData\\DockerDesktop\\version-bin\\docker.exe',
    ]
    : ['/usr/bin/docker', '/usr/local/bin/docker'];
  for (const candidate of candidates) {
    try {
      const path = resolve(candidate);
      const stat = await lstat(path);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
        && resolve(await realpath(path)) === path) return path;
    } catch {
      // Try the next fixed bootstrap path.
    }
  }
  throw new Error('trusted Docker executable unavailable');
}

export async function resolveTrustedGitExecutableV1(): Promise<string> {
  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\git.exe']
    : ['/usr/bin/git', '/usr/local/bin/git'];
  for (const candidate of candidates) {
    try {
      const path = resolve(candidate);
      const stat = await lstat(path);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
        && resolve(await realpath(path)) === path) return path;
    } catch {
      // Try the next fixed bootstrap path.
    }
  }
  throw new Error('trusted Git executable unavailable');
}

export interface AdmissionSandboxExecutionV1 {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly outputExceeded?: boolean;
  readonly stderrExceeded?: boolean;
  readonly launchFailed?: boolean;
  readonly cleanupVerified: boolean;
  readonly attestation: AdmissionSandboxAttestationV1;
}

export interface AdmissionSandboxAttestationV1 {
  readonly candidateSha256: `sha256:${string}`;
  readonly sourceSha256: `sha256:${string}`;
  readonly imageSha256: `sha256:${string}`;
  readonly baseImage: string;
  readonly rootFsLayers: readonly string[];
  readonly imageConfigSha256: `sha256:${string}`;
  readonly nodeSha256: `sha256:${string}`;
}

export interface AdmissionSandboxJobV1 {
  readonly image: `sha256:${string}`;
  readonly inputArchive: Uint8Array;
  readonly temporary: OwnedTemporaryDirectoryV1;
  readonly expectedAttestation: AdmissionSandboxAttestationV1;
}

export type AdmissionSandboxExecutorV1 = (job: AdmissionSandboxJobV1) => Promise<AdmissionSandboxExecutionV1>;

export type AdmissionSandboxResultV1 = Readonly<{
  ok: false;
  failureCode: AdmissionSandboxFailureCodeV1;
}> | Readonly<{
  ok: true;
  output: Uint8Array;
  hashes: Readonly<{
    candidateSha256: `sha256:${string}`;
    sourceSha256: `sha256:${string}`;
    imageSha256: `sha256:${string}`;
    inputSha256: `sha256:${string}`;
    outputSha256: `sha256:${string}`;
  }>;
}>;

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function gitBlobObjectIdV1(bytes: Uint8Array): string {
  bytes = snapshotExactUint8ArrayV1(bytes, 1, 1_048_576);
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`, 'utf8').update(bytes).digest('hex');
}

export function verifyImmutableCandidateFileBytesV1(
  relativePath: keyof typeof IMMUTABLE_CANDIDATE_GIT_BLOBS_V1,
  bytes: Uint8Array,
): Uint8Array {
  if (!Object.prototype.hasOwnProperty.call(IMMUTABLE_CANDIDATE_GIT_BLOBS_V1, relativePath)) {
    throw new Error('candidate file is not content-addressed');
  }
  bytes = snapshotExactUint8ArrayV1(bytes, 1, 1_048_576);
  const expected = IMMUTABLE_CANDIDATE_GIT_BLOBS_V1[relativePath];
  if (gitBlobObjectIdV1(bytes) !== expected.oid || sha256(bytes) !== expected.sha256) {
    throw new Error('candidate Git blob mismatch');
  }
  return bytes;
}

function canonicalJsonValueV1(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new Error('JSON depth exceeded');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || nodeUtilTypes.isProxy(value)) throw new Error('invalid JSON value');
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype || keys.length !== value.length + 1) throw new Error('invalid JSON array');
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new Error('invalid JSON array descriptor');
      }
      result.push(canonicalJsonValueV1(descriptor.value, depth + 1));
    }
    return result;
  }
  if (prototype !== Object.prototype && prototype !== null) throw new Error('invalid JSON object');
  const stringKeys = keys.map((key) => {
    if (typeof key !== 'string') throw new Error('invalid JSON object key');
    return key;
  }).sort();
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of stringKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error('invalid JSON object descriptor');
    }
    result[key] = canonicalJsonValueV1(descriptor.value, depth + 1);
  }
  return result;
}

export function canonicalImageConfigSha256V1(value: unknown): `sha256:${string}` {
  return sha256(new TextEncoder().encode(JSON.stringify(canonicalJsonValueV1(value))));
}

function fail(failureCode: AdmissionSandboxFailureCodeV1): AdmissionSandboxResultV1 {
  return Object.freeze({ ok: false, failureCode });
}

export function snapshotAdmissionOutputEvidenceV1(output: Uint8Array): Readonly<{
  readonly output: Uint8Array;
  readonly outputSha256: `sha256:${string}`;
}> {
  const sealedOutput = snapshotExactUint8ArrayV1(output, 0, ADMISSION_SANDBOX_LIMITS_V1.outputBytes);
  const evidence = Object.create(null) as { readonly output: Uint8Array; readonly outputSha256: `sha256:${string}` };
  Object.defineProperties(evidence, {
    output: {
      enumerable: true, configurable: false,
      get: () => snapshotExactUint8ArrayV1(sealedOutput, 0, ADMISSION_SANDBOX_LIMITS_V1.outputBytes),
    },
    outputSha256: {
      value: sha256(sealedOutput), enumerable: true, writable: false, configurable: false,
    },
  });
  return Object.freeze(evidence);
}

function immutableSuccessV1(
  output: Uint8Array,
  hashes: Extract<AdmissionSandboxResultV1, { readonly ok: true }>['hashes'],
): Extract<AdmissionSandboxResultV1, { readonly ok: true }> {
  const outputEvidence = snapshotAdmissionOutputEvidenceV1(output);
  if (hashes.outputSha256 !== outputEvidence.outputSha256) throw new Error('output evidence mismatch');
  const result = Object.create(null) as Extract<AdmissionSandboxResultV1, { readonly ok: true }>;
  Object.defineProperties(result, {
    ok: { value: true, enumerable: true, writable: false, configurable: false },
    output: {
      enumerable: true,
      configurable: false,
      get: () => outputEvidence.output,
    },
    hashes: { value: Object.freeze({ ...hashes }), enumerable: true, writable: false, configurable: false },
  });
  return Object.freeze(result);
}

function plainClosedRequest(value: unknown): Readonly<{ receipt: unknown; inputs: unknown }> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
      throw new Error('invalid');
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('invalid');
    const keys = Reflect.ownKeys(value);
    if (keys.length !== REQUEST_KEYS.length || keys.some((key) => !REQUEST_KEYS.includes(key as never))) {
      throw new Error('invalid');
    }
    const values = Object.create(null) as Record<string, unknown>;
    for (const key of REQUEST_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new Error('invalid');
      }
      values[key] = descriptor.value;
    }
    return Object.freeze({ receipt: values.receipt, inputs: values.inputs });
  } catch {
    throw new Error('request');
  }
}

function descriptorCopy(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    throw new Error('invalid');
  }
  const prototype = Object.getPrototypeOf(value);
  const ownKeys = Reflect.ownKeys(value);
  if ((prototype !== Object.prototype && prototype !== null) || ownKeys.length !== keys.length
    || ownKeys.some((key, index) => key !== keys[index])) throw new Error('invalid');
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new Error('invalid');
    copy[key] = descriptor.value;
  }
  return copy;
}

function canonicalInputBytesV1(value: unknown): Uint8Array {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype || value.length !== EXACT_INPUT_IDENTITIES_V1.length) {
    throw new Error('invalid');
  }
  const arrayKeys = Reflect.ownKeys(value);
  if (arrayKeys.length !== value.length + 1) throw new Error('invalid');
  const canonicalEntries: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entryDescriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!entryDescriptor || !Object.prototype.hasOwnProperty.call(entryDescriptor, 'value')) throw new Error('invalid');
    const entry = entryDescriptor.value;
    const input = descriptorCopy(entry, INPUT_KEYS);
    const signals = descriptorCopy(input.signals, SIGNAL_KEYS);
    const expectedIdentity = EXACT_INPUT_IDENTITIES_V1[index]!;
    if (input.datasetId !== 'memberry.synthetic-admission-feature-labels'
      || input.datasetVersion !== '1.0.0' || input.scenarioId !== expectedIdentity.scenarioId
      || input.split !== expectedIdentity.split || typeof input.fixtureCode !== 'string'
      || !/^case-[0-9]{3}$/.test(input.fixtureCode as string)
      || !['none', 'normal', 'explicit', 'unknown'].includes(signals.priority as string)
      || !['none', 'partial', 'independent', 'unknown'].includes(signals.noveltyEvidence as string)
      || !['transient', 'session', 'durable', 'unknown'].includes(signals.retentionHorizon as string)
      || !['none', 'single', 'corroborated', 'unknown'].includes(signals.evidenceSupport as string)
      || !['missing', 'inferred', 'explicit', 'unknown'].includes(signals.scopeBinding as string)
      || !['none', 'possible', 'confirmed', 'unknown'].includes(signals.sensitivitySignal as string)) {
      throw new Error('invalid');
    }
    canonicalEntries.push(JSON.stringify({
      datasetId: input.datasetId,
      datasetVersion: input.datasetVersion,
      scenarioId: input.scenarioId,
      split: input.split,
      fixtureCode: input.fixtureCode,
      signals: {
        priority: signals.priority,
        noveltyEvidence: signals.noveltyEvidence,
        retentionHorizon: signals.retentionHorizon,
        evidenceSupport: signals.evidenceSupport,
        scopeBinding: signals.scopeBinding,
        sensitivitySignal: signals.sensitivitySignal,
      },
    }));
  }
  const bytes = new TextEncoder().encode(`[${canonicalEntries.join(',')}]`);
  if (bytes.byteLength < 1 || bytes.byteLength > ADMISSION_SANDBOX_LIMITS_V1.inputBytes) {
    throw new Error('invalid');
  }
  if (sha256(bytes) !== EXACT_INPUT_HASH_V1) throw new Error('invalid');
  return sealTrustedExactBytesV1(bytes);
}

function exactJsonArrayV1(value: unknown, length: number): readonly unknown[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype || value.length !== length
    || Reflect.ownKeys(value).length !== length + 1) throw new Error('invalid');
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new Error('invalid');
    result.push(descriptor.value);
  }
  return result;
}

function validateDimensionV1(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    throw new Error('invalid');
  }
  const availability = Object.getOwnPropertyDescriptor(value, 'availability')?.value;
  if (availability === 'unavailable') {
    descriptorCopy(value, ['availability']);
    return;
  }
  const dimension = descriptorCopy(value, ['availability', 'valuePermille']);
  if (dimension.availability !== 'available' || !Number.isSafeInteger(dimension.valuePermille)
    || (dimension.valuePermille as number) < 0 || (dimension.valuePermille as number) > 1_000) {
    throw new Error('invalid');
  }
}

export function validateAdmissionArtifactBytesV1(
  output: Uint8Array,
  canonicalInput: Uint8Array,
): boolean {
  try {
    output = snapshotExactUint8ArrayV1(output, 1, ADMISSION_SANDBOX_LIMITS_V1.outputBytes);
    canonicalInput = snapshotExactUint8ArrayV1(canonicalInput, 1, ADMISSION_SANDBOX_LIMITS_V1.inputBytes);
    if (sha256(canonicalInput) !== EXACT_INPUT_HASH_V1) return false;
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(output);
    if (decoded.includes('\u001b')) return false;
    const parsed = JSON.parse(decoded) as unknown;
    const artifact = descriptorCopy(parsed, ARTIFACT_KEYS_V1);
    if (artifact.artifactVersion !== '1.0.0'
      || artifact.datasetId !== 'memberry.synthetic-admission-feature-labels'
      || artifact.datasetVersion !== '1.0.0' || artifact.evaluationContractVersion !== '1.0.0'
      || artifact.featureContractVersion !== '1.0.0' || artifact.inputHash !== EXACT_INPUT_HASH_V1) return false;
    const predictions = exactJsonArrayV1(artifact.predictions, EXACT_INPUT_IDENTITIES_V1.length);
    predictions.forEach((prediction, index) => {
      const row = descriptorCopy(prediction, PREDICTION_KEYS_V1);
      const expected = EXACT_INPUT_IDENTITIES_V1[index]!;
      if (row.scenarioId !== expected.scenarioId || row.split !== expected.split) throw new Error('invalid');
      const features = descriptorCopy(row.features, FEATURE_KEYS_V1);
      const extractor = descriptorCopy(features.extractor, EXTRACTOR_KEYS_V1);
      const dimensions = descriptorCopy(features.dimensions, DIMENSION_KEYS_V1);
      if (features.contractId !== 'memberry.admission-feature-envelope'
        || features.contractVersion !== '1.0.0'
        || extractor.id !== 'memberry.precomputed-feature-signals' || extractor.version !== '1.0.0') {
        throw new Error('invalid');
      }
      DIMENSION_KEYS_V1.forEach((key) => validateDimensionV1(dimensions[key]));
    });
    return JSON.stringify(parsed) === decoded;
  } catch {
    return false;
  }
}

export function buildAdmissionFeatureSandboxInvocationV1(value: unknown): AdmissionSandboxInvocationV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    throw new Error('invalid sandbox invocation');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('invalid sandbox invocation');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== INVOCATION_KEYS.length
    || keys.some((key) => typeof key !== 'string' || !INVOCATION_KEYS.includes(key as never))) {
    throw new Error('invalid sandbox invocation');
  }
  const parsed = Object.create(null) as Record<string, unknown>;
  for (const key of INVOCATION_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error('invalid sandbox invocation');
    }
    parsed[key] = descriptor.value;
  }
  if (typeof parsed.image !== 'string' || !IMAGE_PATTERN.test(parsed.image)
    || typeof parsed.runToken !== 'string' || !/^[0-9a-f]{32}$/.test(parsed.runToken)
    || typeof parsed.cidFile !== 'string' || parsed.cidFile.includes('\0') || parsed.cidFile.includes(':', 2)) {
    throw new Error('invalid sandbox invocation');
  }
  const expectedDirectory = dirname(resolve(parsed.cidFile));
  const temporary = resolve(tmpdir());
  if (resolve(parsed.cidFile) !== resolve(expectedDirectory, 'container.cid')
    || dirname(expectedDirectory) !== temporary
    || !new RegExp(`^memberry-admission-run-${parsed.runToken}-[A-Za-z0-9_-]{6,32}$`)
      .test(basename(expectedDirectory))) {
    throw new Error('invalid sandbox invocation');
  }
  const hostEnvironment = dockerCliEnvironmentV1(parsed.hostEnvironment);
  const args = Object.freeze([
    'create', `--cidfile=${parsed.cidFile}`, '--pull=never',
    `--label=org.memberry.run-token=${parsed.runToken}`, '--network=none',
    '--read-only', '--user=65532:65532',
    '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    `--pids-limit=${ADMISSION_SANDBOX_LIMITS_V1.pids}`,
    `--cpus=${ADMISSION_SANDBOX_LIMITS_V1.cpu}`,
    `--memory=${ADMISSION_SANDBOX_LIMITS_V1.memory}`,
    `--memory-swap=${ADMISSION_SANDBOX_LIMITS_V1.memory}`,
    '--env=LANG=C.UTF-8', '--env=LC_ALL=C.UTF-8', '--env=TZ=UTC',
    '--entrypoint=/usr/local/bin/node',
    '--platform=linux/amd64', parsed.image,
    '--permission', '--allow-fs-read=/run/input.json',
    '--allow-fs-write=/tmp/memberry-sandbox-write-probe',
    '--disable-proto=throw', '/app/worker.mjs', '/run/input.json',
  ]);
  return Object.freeze({ executable: 'docker', args, env: hostEnvironment, shell: false });
}

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  current: number,
  limit: number,
): { size: number; exceeded: boolean } {
  if (current >= limit + 1) return { size: current, exceeded: true };
  const remaining = limit + 1 - current;
  chunks.push(chunk.subarray(0, remaining));
  const size = current + Math.min(chunk.byteLength, remaining);
  return { size, exceeded: current + chunk.byteLength > limit };
}

export interface DockerCommandResultV1 {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly outputExceeded: boolean;
  readonly stderrExceeded: boolean;
  readonly launchFailed: boolean;
}

export type DockerCommandRunnerV1 = (
  invocation: AdmissionSandboxInvocationV1,
) => Promise<DockerCommandResultV1>;

export function snapshotDockerCommandResultV1(value: unknown): DockerCommandResultV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    throw new Error('invalid Docker result');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('invalid Docker result');
  const required = ['exitCode', 'signal', 'timedOut', 'stdout', 'stderr'] as const;
  const optional = ['outputExceeded', 'stderrExceeded', 'launchFailed'] as const;
  const allowed = new Set<PropertyKey>([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (required.some((key) => !keys.includes(key)) || keys.some((key) => !allowed.has(key))) {
    throw new Error('invalid Docker result');
  }
  const parsed = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string') throw new Error('invalid Docker result');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error('invalid Docker result');
    }
    parsed[key] = descriptor.value;
  }
  if (!(parsed.exitCode === null || (Number.isSafeInteger(parsed.exitCode)
      && (parsed.exitCode as number) >= 0 && (parsed.exitCode as number) <= 255))
    || !(parsed.signal === null || (typeof parsed.signal === 'string' && parsed.signal.length <= 32))
    || typeof parsed.timedOut !== 'boolean'
    || optional.some((key) => parsed[key] !== undefined && typeof parsed[key] !== 'boolean')) {
    throw new Error('invalid Docker result');
  }
  const stdout = snapshotExactUint8ArrayV1(parsed.stdout, 0, 134_219_776);
  const stderr = snapshotExactUint8ArrayV1(parsed.stderr, 0, 32_768);
  return Object.freeze({
    exitCode: parsed.exitCode as number | null,
    signal: parsed.signal as string | null,
    timedOut: parsed.timedOut as boolean,
    stdout,
    stderr,
    outputExceeded: (parsed.outputExceeded ?? false) as boolean,
    stderrExceeded: (parsed.stderrExceeded ?? false) as boolean,
    launchFailed: (parsed.launchFailed ?? false) as boolean,
  });
}

const DOCKER_INVOCATION_REQUIRED_KEYS = Object.freeze(['executable', 'args', 'env', 'shell'] as const);
const DOCKER_INVOCATION_OPTIONAL_KEYS = Object.freeze([
  'stdin', 'timeoutMs', 'stdoutLimit', 'stderrLimit',
] as const);

export function prepareDockerSpawnV1(value: unknown): Readonly<{
  executable: 'docker';
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  shell: false;
  stdin?: Uint8Array;
  timeoutMs: number;
  stdoutLimit: number;
  stderrLimit: number;
}> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    throw new Error('invalid Docker invocation');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('invalid Docker invocation');
  const keys = Reflect.ownKeys(value);
  const allowed = new Set<PropertyKey>([...DOCKER_INVOCATION_REQUIRED_KEYS, ...DOCKER_INVOCATION_OPTIONAL_KEYS]);
  if (keys.some((key) => !allowed.has(key))
    || DOCKER_INVOCATION_REQUIRED_KEYS.some((key) => !keys.includes(key))) {
    throw new Error('invalid Docker invocation');
  }
  const parsed = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string') throw new Error('invalid Docker invocation');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error('invalid Docker invocation');
    }
    parsed[key] = descriptor.value;
  }
  if (parsed.executable !== 'docker' || parsed.shell !== false
    || nodeUtilTypes.isProxy(parsed.args) || !Array.isArray(parsed.args)
    || Object.getPrototypeOf(parsed.args) !== Array.prototype
    || parsed.args.length < 1 || parsed.args.length > 128) {
    throw new Error('invalid Docker invocation');
  }
  const args: string[] = [];
  for (let index = 0; index < parsed.args.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(parsed.args, String(index));
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || typeof descriptor.value !== 'string' || descriptor.value.length < 1
      || descriptor.value.length > 8_192 || descriptor.value.includes('\0')) {
      throw new Error('invalid Docker invocation');
    }
    args.push(descriptor.value);
  }
  const boundedInteger = (candidate: unknown, fallback: number, max: number) => {
    const selected = candidate === undefined ? fallback : candidate;
    if (!Number.isSafeInteger(selected) || (selected as number) < 1 || (selected as number) > max) {
      throw new Error('invalid Docker invocation');
    }
    return selected as number;
  };
  const stdin = parsed.stdin === undefined
    ? undefined : snapshotExactUint8ArrayV1(parsed.stdin, 0, 2_097_152);
  return Object.freeze({
    executable: 'docker',
    args: Object.freeze(args),
    env: dockerCliEnvironmentV1(parsed.env),
    shell: false,
    ...(stdin === undefined ? {} : { stdin }),
    timeoutMs: boundedInteger(parsed.timeoutMs, ADMISSION_SANDBOX_LIMITS_V1.timeoutMs, 60_000),
    stdoutLimit: boundedInteger(parsed.stdoutLimit, ADMISSION_SANDBOX_LIMITS_V1.outputBytes, 134_219_776),
    stderrLimit: boundedInteger(parsed.stderrLimit, ADMISSION_SANDBOX_LIMITS_V1.stderrBytes, 32_768),
  });
}

export async function runDockerCommandWithSpawnV1(
  invocation: AdmissionSandboxInvocationV1,
  spawnProcess: typeof spawn,
  resolveDockerExecutable: () => Promise<string> = resolveTrustedDockerExecutableV1,
): Promise<DockerCommandResultV1> {
  let trustedExecutable: string;
  try {
    trustedExecutable = resolve(await resolveDockerExecutable());
    if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(trustedExecutable) || trustedExecutable.includes('\0')) {
      throw new Error('invalid Docker executable');
    }
  } catch {
    return Object.freeze({
      exitCode: null, signal: null, timedOut: false, stdout: new Uint8Array(),
      stderr: new Uint8Array(), outputExceeded: false, stderrExceeded: false, launchFailed: true,
    });
  }
  return new Promise((resolveExecution) => {
    const prepared = prepareDockerSpawnV1(invocation);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let outputExceeded = false;
    let stderrExceeded = false;
    let timedOut = false;
    let settled = false;
    const stdoutLimit = prepared.stdoutLimit;
    const stderrLimit = prepared.stderrLimit;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawnProcess(trustedExecutable, [...prepared.args], {
        shell: prepared.shell,
        env: { ...prepared.env },
        windowsHide: true,
        stdio: [prepared.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolveExecution(Object.freeze({
        exitCode: null, signal: null, timedOut: false, stdout: new Uint8Array(),
        stderr: new Uint8Array(), outputExceeded: false, stderrExceeded: false,
        launchFailed: true,
      }));
      return;
    }

    let forcedTimer: ReturnType<typeof setTimeout> | undefined;
    let streamLaunchFailed = false;
    const snapshot = (
      exitCode: number | null,
      signal: string | null,
      launchFailed: boolean,
    ): DockerCommandResultV1 => ({
      exitCode,
      signal,
      timedOut,
      stdout: sealTrustedExactBytesV1(new Uint8Array(Buffer.concat(stdout))),
      stderr: sealTrustedExactBytesV1(new Uint8Array(Buffer.concat(stderr))),
      outputExceeded,
      stderrExceeded,
      launchFailed,
    });

    const finish = (execution: DockerCommandResultV1) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forcedTimer) clearTimeout(forcedTimer);
      resolveExecution(Object.freeze(execution));
    };
    const forceTermination = () => {
      if (settled || forcedTimer) return;
      try {
        child.kill('SIGKILL');
      } catch {
        streamLaunchFailed = true;
      }
      forcedTimer = setTimeout(() => finish(snapshot(null, 'SIGKILL', streamLaunchFailed)), 250);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      forceTermination();
    }, prepared.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      const appended = appendBounded(stdout, chunk, stdoutSize, stdoutLimit);
      stdoutSize = appended.size;
      outputExceeded ||= appended.exceeded;
      if (outputExceeded) forceTermination();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const appended = appendBounded(stderr, chunk, stderrSize, stderrLimit);
      stderrSize = appended.size;
      stderrExceeded ||= appended.exceeded;
      if (stderrExceeded) forceTermination();
    });
    child.once('error', () => finish(snapshot(null, null, true)));
    child.once('close', (exitCode, signal) => finish(snapshot(exitCode, signal, streamLaunchFailed)));
    if (prepared.stdin) {
      if (!child.stdin) {
        streamLaunchFailed = true;
        forceTermination();
      } else {
        child.stdin.once('error', () => {
          streamLaunchFailed = true;
          forceTermination();
        });
        child.stdin.end(prepared.stdin);
      }
    }
  });
}

export const runDockerCommandV1: DockerCommandRunnerV1 = async (invocation) => (
  runDockerCommandWithSpawnV1(invocation, spawn)
);

export function validateGitObjectCommandResultV1(value: unknown, maximumBytes: number): Uint8Array {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > 1_048_576
    || typeof value !== 'object' || value === null || Array.isArray(value) || nodeUtilTypes.isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error('Git blob unavailable');
  }
  const required = ['exitCode', 'signal', 'timedOut', 'stdout', 'stderr'] as const;
  const optional = ['outputExceeded', 'stderrExceeded', 'launchFailed'] as const;
  const allowed = new Set<PropertyKey>([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (required.some((key) => !keys.includes(key)) || keys.some((key) => !allowed.has(key))) {
    throw new Error('Git blob unavailable');
  }
  const parsed = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string') throw new Error('Git blob unavailable');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error('Git blob unavailable');
    }
    parsed[key] = descriptor.value;
  }
  if (parsed.exitCode !== 0 || parsed.signal !== null || parsed.timedOut !== false
    || parsed.outputExceeded === true || parsed.stderrExceeded === true || parsed.launchFailed === true
    || (parsed.outputExceeded !== undefined && typeof parsed.outputExceeded !== 'boolean')
    || (parsed.stderrExceeded !== undefined && typeof parsed.stderrExceeded !== 'boolean')
    || (parsed.launchFailed !== undefined && typeof parsed.launchFailed !== 'boolean')) {
    throw new Error('Git blob unavailable');
  }
  const stdout = snapshotExactUint8ArrayV1(parsed.stdout, 0, maximumBytes);
  const stderr = snapshotExactUint8ArrayV1(parsed.stderr, 0, 1_024);
  if (stderr.byteLength !== 0) throw new Error('Git blob unavailable');
  return stdout;
}

async function runTrustedGitCommandV1(
  authority: TrustedGitRepositoryAuthorityV1,
  args: readonly string[],
  maximumBytes: number,
): Promise<Uint8Array> {
  if (!Array.isArray(args) || args.length < 1 || args.length > 16
    || args.some((arg) => typeof arg !== 'string' || arg.length < 1 || arg.length > 256
      || arg.includes('\0'))) throw new Error('Git blob unavailable');
  await assertTrustedGitRepositoryAuthorityV1(authority);
  const invocation = prepareDockerSpawnV1({
    executable: 'docker',
    args: ['--no-replace-objects', `--git-dir=${authority.gitDirectory}`, ...args],
    env: Object.create(null),
    shell: false,
    timeoutMs: 2_000,
    stdoutLimit: Math.max(1, maximumBytes),
    stderrLimit: 1_024,
  });
  try {
    const result = await runDockerCommandWithSpawnV1(invocation, spawn, resolveTrustedGitExecutableV1);
    return validateGitObjectCommandResultV1(result, maximumBytes);
  } finally {
    await assertTrustedGitRepositoryAuthorityV1(authority);
  }
}

export function createDockerCommandInvocationV1(
  args: readonly string[],
  stdin?: Uint8Array,
  stdoutLimit?: number,
): AdmissionSandboxInvocationV1 {
  return prepareDockerSpawnV1({
    executable: 'docker',
    args,
    env: dockerCliEnvironmentV1(process.env),
    shell: false,
    ...(stdin ? { stdin } : {}),
    ...(stdoutLimit === undefined ? {} : { stdoutLimit }),
  });
}

function resultText(result: DockerCommandResultV1): string {
  result = snapshotDockerCommandResultV1(result);
  if (result.launchFailed || result.timedOut || result.outputExceeded || result.stderrExceeded
    || result.exitCode !== 0 || result.stderr.byteLength !== 0) {
    throw new Error('docker command failed');
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
}

function parseJsonResult(result: DockerCommandResultV1): any {
  return JSON.parse(resultText(result));
}

function exactStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function rootFsLayersV1(inspection: any): readonly string[] {
  const layers = inspection?.RootFS?.Layers;
  if (inspection?.RootFS?.Type !== 'layers' || !Array.isArray(layers)
    || layers.length < 1 || layers.length > 256
    || layers.some((layer: unknown) => typeof layer !== 'string'
      || !/^sha256:[0-9a-f]{64}$/.test(layer))) {
    throw new Error('invalid image rootfs');
  }
  return layers;
}

export function hasExactCandidateRootFsExtensionV1(
  baseLayers: unknown,
  candidateLayers: unknown,
): boolean {
  const snapshot = (value: unknown): readonly string[] | undefined => {
    if (!Array.isArray(value) || nodeUtilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Array.prototype
      || value.length < 1 || value.length > 256
      || Reflect.ownKeys(value).length !== value.length + 1) return undefined;
    const layers: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || typeof descriptor.value !== 'string' || !IMAGE_PATTERN.test(descriptor.value)) return undefined;
      layers.push(descriptor.value);
    }
    return layers;
  };
  const base = snapshot(baseLayers);
  const candidate = snapshot(candidateLayers);
  return base !== undefined && candidate !== undefined
    && candidate.length === base.length + 2
    && base.every((layer, index) => candidate[index] === layer);
}

function verifyImageInspectionV1(
  baseInspection: any,
  inspection: any,
  job: AdmissionSandboxJobV1,
): AdmissionSandboxAttestationV1 {
  const labels = inspection?.Config?.Labels;
  const baseLayers = rootFsLayersV1(baseInspection);
  const imageLayers = rootFsLayersV1(inspection);
  if (!Array.isArray(baseInspection?.RepoDigests)
    || !baseInspection.RepoDigests.includes(APPROVED_NODE_BASE_IMAGE_V1)
    || baseInspection?.Os !== 'linux' || baseInspection?.Architecture !== 'amd64'
    || inspection?.Os !== 'linux' || inspection?.Architecture !== 'amd64'
    || !hasExactCandidateRootFsExtensionV1(baseLayers, imageLayers)
    || !exactStringArray(imageLayers, job.expectedAttestation.rootFsLayers)
    || inspection?.Id !== job.image || typeof labels !== 'object' || labels === null
    || canonicalImageConfigSha256V1(inspection?.Config) !== job.expectedAttestation.imageConfigSha256
    || labels['org.memberry.candidate.sha256'] !== job.expectedAttestation.candidateSha256
    || labels['org.memberry.source.sha256'] !== job.expectedAttestation.sourceSha256
    || labels['org.memberry.base.image'] !== APPROVED_NODE_BASE_IMAGE_V1) {
    throw new Error('image attestation mismatch');
  }
  return Object.freeze({
    candidateSha256: labels['org.memberry.candidate.sha256'],
    sourceSha256: labels['org.memberry.source.sha256'],
    imageSha256: inspection.Id,
    baseImage: labels['org.memberry.base.image'],
    rootFsLayers: Object.freeze([...imageLayers]),
    imageConfigSha256: job.expectedAttestation.imageConfigSha256,
    nodeSha256: job.expectedAttestation.nodeSha256,
  });
}

function verifyImageContentAttestationV1(
  bytes: Uint8Array,
  expected: AdmissionSandboxAttestationV1,
): void {
  const canonical = new TextEncoder().encode(JSON.stringify({
    baseImage: expected.baseImage,
    candidateSha256: expected.candidateSha256,
    sourceSha256: expected.sourceSha256,
    nodeSha256: expected.nodeSha256,
  }));
  if (!Buffer.from(bytes).equals(Buffer.from(canonical))) {
    throw new Error('image content attestation mismatch');
  }
}

function verifyContainerInspectionV1(inspection: any, job: AdmissionSandboxJobV1, id: string): void {
  const host = inspection?.HostConfig;
  const config = inspection?.Config;
  if (inspection?.Id !== id || inspection?.Image !== job.image
    || config?.Labels?.['org.memberry.run-token'] !== job.temporary.runToken
    || config?.Labels?.['org.memberry.candidate.sha256'] !== job.expectedAttestation.candidateSha256
    || config?.User !== `${ADMISSION_SANDBOX_UID_V1}:${ADMISSION_SANDBOX_GID_V1}`
    || !exactStringArray(config?.Entrypoint, ['/usr/local/bin/node'])
    || !exactStringArray(config?.Cmd, [
      '--permission', '--allow-fs-read=/run/input.json',
      '--allow-fs-write=/tmp/memberry-sandbox-write-probe',
      '--disable-proto=throw', '/app/worker.mjs', '/run/input.json',
    ])
    || host?.NetworkMode !== 'none' || host?.ReadonlyRootfs !== true
    || !Array.isArray(host?.CapDrop) || host.CapDrop.length !== 1 || host.CapDrop[0] !== 'ALL'
    || !Array.isArray(host?.SecurityOpt) || host.SecurityOpt.length !== 1
    || host.SecurityOpt[0] !== 'no-new-privileges:true'
    || host?.PidsLimit !== ADMISSION_SANDBOX_LIMITS_V1.pids
    || host?.NanoCpus !== 500_000_000 || host?.Memory !== 134_217_728
    || host?.MemorySwap !== 134_217_728
    || config?.Volumes != null
    || !(host?.Binds == null || (Array.isArray(host.Binds) && host.Binds.length === 0))
    || !Array.isArray(inspection?.Mounts) || inspection.Mounts.length !== 0) {
    throw new Error('container inspection mismatch');
  }
}

function validContainerId(value: string): value is string {
  return /^[0-9a-f]{64}$/.test(value);
}

export function selectCidFileCleanupAuthorityV1(
  cidFileId: unknown,
  createStdout: unknown,
  discoveredIds: unknown,
): string | undefined {
  if (typeof cidFileId !== 'string' || !validContainerId(cidFileId)
    || (createStdout !== undefined && typeof createStdout !== 'string')
    || !Array.isArray(discoveredIds) || nodeUtilTypes.isProxy(discoveredIds)
    || Object.getPrototypeOf(discoveredIds) !== Array.prototype) return undefined;
  const keys = Reflect.ownKeys(discoveredIds);
  if (keys.length !== discoveredIds.length + 1) return undefined;
  const ids: string[] = [];
  for (let index = 0; index < discoveredIds.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(discoveredIds, String(index));
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || typeof descriptor.value !== 'string' || !validContainerId(descriptor.value)) return undefined;
    ids.push(descriptor.value);
  }
  if (new Set(ids).size !== ids.length
    || (createStdout !== undefined && createStdout.length > 0 && createStdout !== cidFileId)
    || !ids.includes(cidFileId)) return undefined;
  return cidFileId;
}

async function discoverOwnedContainersV1(
  job: AdmissionSandboxJobV1,
  runner: DockerCommandRunnerV1,
): Promise<readonly string[]> {
  const listing = await runner(createDockerCommandInvocationV1([
    'container', 'ls', '-a', '--no-trunc',
    `--filter=label=org.memberry.run-token=${job.temporary.runToken}`,
    '--format={{.ID}}',
  ]));
  const ids = resultText(listing).replace(/\r\n?/g, '\n').split('\n').filter(Boolean);
  if (ids.some((id) => !validContainerId(id)) || new Set(ids).size !== ids.length) {
    throw new Error('invalid container discovery');
  }
  return Object.freeze(ids);
}

async function cleanupOwnedContainersV1(
  job: AdmissionSandboxJobV1,
  runner: DockerCommandRunnerV1,
  authoritativeId: string | undefined,
  creationAttempted: boolean,
  createStdout: string | undefined,
): Promise<boolean> {
  try {
    const cidId = await readOwnedContainerIdFileV1(job.temporary);
    if (!authoritativeId) {
      const residue = await discoverOwnedContainersV1(job, runner);
      if (!creationAttempted) return residue.length === 0;
      authoritativeId = selectCidFileCleanupAuthorityV1(cidId, createStdout, residue);
      if (!authoritativeId) return false;
    }
    const exactId = authoritativeId;
    const before = await discoverOwnedContainersV1(job, runner);
    if (selectCidFileCleanupAuthorityV1(cidId, createStdout, before) !== exactId) return false;
    const inspectOwned = async () => {
      const inspected = parseJsonResult(await runner(createDockerCommandInvocationV1([
        'container', 'inspect', '--format={{json .}}', exactId,
      ])));
      if (inspected?.Id !== exactId || inspected?.Image !== job.image
        || inspected?.Config?.Labels?.['org.memberry.run-token'] !== job.temporary.runToken) {
        throw new Error('cleanup ownership mismatch');
      }
      return inspected;
    };
    const inspection = await inspectOwned();
    if (inspection?.State?.Running === true) {
      resultText(await runner(createDockerCommandInvocationV1([
        'container', 'kill', exactId,
      ])));
    }
    await inspectOwned();
    resultText(await runner(createDockerCommandInvocationV1([
      'container', 'rm', '-fv', exactId,
    ])));
    return (await discoverOwnedContainersV1(job, runner)).length === 0;
  } catch {
    return false;
  }
}

async function executeAdmissionSandboxDockerWithRunnerV1(
  job: AdmissionSandboxJobV1,
  runner: DockerCommandRunnerV1,
): Promise<AdmissionSandboxExecutionV1> {
  let attestation: AdmissionSandboxAttestationV1 = Object.freeze({
    candidateSha256: `sha256:${'0'.repeat(64)}`,
    sourceSha256: `sha256:${'0'.repeat(64)}`,
    imageSha256: `sha256:${'0'.repeat(64)}`,
    baseImage: '',
    rootFsLayers: Object.freeze([]),
    imageConfigSha256: `sha256:${'0'.repeat(64)}`,
    nodeSha256: `sha256:${'0'.repeat(64)}`,
  });
  let execution: Omit<AdmissionSandboxExecutionV1, 'cleanupVerified' | 'attestation'> = {
    exitCode: null,
    signal: null,
    timedOut: false,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    launchFailed: true,
  };
  let authoritativeId: string | undefined;
  let creationAttempted = false;
  let createStdout: string | undefined;
  let diagnosticStage = 'base-image-inspect';
  try {
    const baseInspection = parseJsonResult(await runner(createDockerCommandInvocationV1([
      'image', 'inspect', '--format={{json .}}', APPROVED_NODE_BASE_IMAGE_V1,
    ])));
    diagnosticStage = 'candidate-image-inspect-and-verify';
    attestation = verifyImageInspectionV1(
      baseInspection,
      parseJsonResult(await runner(createDockerCommandInvocationV1([
        'image', 'inspect', '--format={{json .}}', job.image,
      ]))),
      job,
    );
    diagnosticStage = 'container-create';
    creationAttempted = true;
    const create = await runner(buildAdmissionFeatureSandboxInvocationV1({
      image: job.image,
      cidFile: job.temporary.cidFile,
      runToken: job.temporary.runToken,
      hostEnvironment: process.env,
    }));
    const createSnapshot = snapshotDockerCommandResultV1(create);
    try {
      createStdout = new TextDecoder('utf-8', { fatal: true }).decode(createSnapshot.stdout).trim();
    } catch {
      createStdout = undefined;
    }
    resultText(createSnapshot);
    diagnosticStage = 'container-identity';
    const cidId = await readOwnedContainerIdFileV1(job.temporary);
    if (!cidId || (createStdout !== undefined && createStdout.length > 0 && createStdout !== cidId)) {
      throw new Error('container identity mismatch');
    }
    authoritativeId = cidId;
    diagnosticStage = 'container-inspect-and-verify';
    verifyContainerInspectionV1(
      parseJsonResult(await runner(createDockerCommandInvocationV1([
        'container', 'inspect', '--format={{json .}}', cidId,
      ]))),
      job,
      cidId,
    );
    diagnosticStage = 'worker-copy-and-verify';
    const workerArchive = snapshotDockerCommandResultV1(await runner(createDockerCommandInvocationV1([
      'container', 'cp', `${cidId}:/app/worker.mjs`, '-',
    ], undefined, 1_048_576)));
    if (workerArchive.launchFailed || workerArchive.timedOut
      || workerArchive.outputExceeded || workerArchive.stderrExceeded
      || workerArchive.exitCode !== 0 || workerArchive.stderr.byteLength !== 0) {
      throw new Error('candidate content copy failed');
    }
    if (sha256(inspectDockerCopyArchiveV1(
      workerArchive.stdout,
      'worker.mjs',
    )) !== job.expectedAttestation.candidateSha256) {
      throw new Error('candidate content mismatch');
    }
    diagnosticStage = 'attestation-copy-and-verify';
    const attestationArchive = snapshotDockerCommandResultV1(await runner(createDockerCommandInvocationV1([
      'container', 'cp', `${cidId}:/app/attestation.json`, '-',
    ], undefined, 1_048_576)));
    if (attestationArchive.launchFailed || attestationArchive.timedOut
      || attestationArchive.outputExceeded || attestationArchive.stderrExceeded
      || attestationArchive.exitCode !== 0 || attestationArchive.stderr.byteLength !== 0) {
      throw new Error('image attestation copy failed');
    }
    verifyImageContentAttestationV1(
      inspectDockerCopyArchiveV1(attestationArchive.stdout, 'attestation.json'),
      job.expectedAttestation,
    );
    diagnosticStage = 'input-copy';
    const inputCopy = snapshotDockerCommandResultV1(await runner(createDockerCommandInvocationV1(
      ['container', 'cp', '-a', '-', `${cidId}:/`],
      job.inputArchive,
    )));
    process.stderr.write(`input-copy-shape:${inputCopy.exitCode}:${Number(inputCopy.launchFailed)}:${Number(inputCopy.timedOut)}:${Number(Boolean(inputCopy.outputExceeded))}:${Number(Boolean(inputCopy.stderrExceeded))}:${inputCopy.stdout.byteLength}:${inputCopy.stderr.byteLength}\n`);
    const inputCopyError = new TextDecoder('utf-8', { fatal: true }).decode(inputCopy.stderr)
      .replace(/[0-9a-f]{64}/g, '<container-id>');
    process.stderr.write(`input-copy-error:${inputCopyError}`);
    resultText(inputCopy);
    diagnosticStage = 'container-start';
    const started = snapshotDockerCommandResultV1(await runner(
      createDockerCommandInvocationV1(['container', 'start', '--attach', cidId]),
    ));
    execution = {
      exitCode: started.exitCode,
      signal: started.signal,
      timedOut: started.timedOut,
      stdout: started.stdout,
      stderr: started.stderr,
      outputExceeded: started.outputExceeded,
      stderrExceeded: started.stderrExceeded,
      launchFailed: started.launchFailed,
    };
  } catch {
    process.stderr.write(`sandbox-stage:${diagnosticStage}\n`);
    execution = { ...execution, launchFailed: true };
  }
  const cleanupVerified = await cleanupOwnedContainersV1(
    job, runner, authoritativeId, creationAttempted, createStdout,
  );
  return Object.freeze({ ...execution, cleanupVerified, attestation });
}

const executeAdmissionSandboxDockerV1: AdmissionSandboxExecutorV1 = async (job) => (
  executeAdmissionSandboxDockerWithRunnerV1(job, runDockerCommandV1)
);

export interface AdmissionCandidateSnapshotV1 {
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly candidateSha256: `sha256:${string}`;
  readonly sourceSha256: `sha256:${string}`;
}

function sameStatIdentityV1(left: any, right: any): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export interface StableDirectoryIdentityV1 {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export async function snapshotStableDirectoryChainV1(root: string): Promise<readonly StableDirectoryIdentityV1[]> {
  const resolvedRoot = resolve(root);
  const paths: string[] = [];
  for (let current = resolvedRoot; ; current = dirname(current)) {
    paths.push(current);
    if (dirname(current) === current) break;
  }
  const identities: StableDirectoryIdentityV1[] = [];
  for (const path of paths) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || resolve(await realpath(path)) !== path) {
      throw new Error('unsafe candidate directory chain');
    }
    identities.push(Object.freeze({
      path, dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs,
      mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
    }));
  }
  return Object.freeze(identities);
}

export async function assertStableDirectoryChainV1(
  expected: readonly StableDirectoryIdentityV1[],
): Promise<void> {
  if (!Array.isArray(expected) || expected.length < 1 || nodeUtilTypes.isProxy(expected)) {
    throw new Error('invalid candidate directory chain');
  }
  for (let index = 0; index < expected.length; index += 1) {
    const identity = expected[index]!;
    const stat = await lstat(identity.path);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || stat.dev !== identity.dev || stat.ino !== identity.ino
      || stat.birthtimeMs !== identity.birthtimeMs
      || (index === 0 && (stat.mtimeMs !== identity.mtimeMs || stat.ctimeMs !== identity.ctimeMs))
      || resolve(await realpath(identity.path)) !== identity.path) {
      throw new Error('candidate directory chain changed');
    }
  }
}

async function readStableRegularFilePinnedV1(
  root: string,
  relativePath: string,
  directoryChain: readonly StableDirectoryIdentityV1[],
): Promise<Uint8Array> {
  await assertStableDirectoryChainV1(directoryChain);
  const resolvedRoot = resolve(root);
  if (directoryChain[0]?.path !== resolvedRoot) throw new Error('candidate root identity mismatch');
  const path = resolve(resolvedRoot, relativePath);
  if (relative(resolvedRoot, path).startsWith('..') || resolve(await realpath(path)) !== path) {
    throw new Error('candidate path escaped root');
  }
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 1_048_576) {
    throw new Error('unsafe candidate file');
  }
  const noFollow = (fsConstants as unknown as Record<string, number>).O_NOFOLLOW ?? 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameStatIdentityV1(before, opened)) {
      throw new Error('candidate file identity changed');
    }
    const bytes = new Uint8Array(await handle.readFile());
    const openedAfter = await handle.stat();
    const after = await lstat(path);
    await assertStableDirectoryChainV1(directoryChain);
    if (!sameStatIdentityV1(opened, openedAfter) || !sameStatIdentityV1(openedAfter, after)) {
      throw new Error('candidate file changed while captured');
    }
    return sealTrustedExactBytesV1(bytes);
  } finally {
    await handle.close();
  }
}

export async function readStableRegularFileV1(root: string, relativePath: string): Promise<Uint8Array> {
  const resolvedRoot = resolve(root);
  const chain = await snapshotStableDirectoryChainV1(resolvedRoot);
  return readStableRegularFilePinnedV1(resolvedRoot, relativePath, chain);
}

function decodeGitPathLineV1(bytes: Uint8Array): string {
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Git blob unavailable');
  }
  if (decoded.includes('\0') || decoded.includes('\u001b') || !/^[^\r\n]+\r?\n$/.test(decoded)) {
    throw new Error('Git blob unavailable');
  }
  return decoded.replace(/\r?\n$/, '');
}

interface PinnedGitControlFileV1 {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly bytesSha256: `sha256:${string}`;
}

interface TrustedGitRepositoryStateV1 {
  readonly root: string;
  readonly gitDirectory: string;
  readonly commonDirectory: string;
  readonly objectDirectory: string;
  readonly directoryChains: readonly (readonly StableDirectoryIdentityV1[])[];
  readonly controlFiles: readonly PinnedGitControlFileV1[];
  readonly alternatesPath: string;
}

export interface TrustedGitRepositoryAuthorityV1 {
  readonly authorityVersion: 'memberry.git-object-authority.v1';
  readonly gitDirectory: string;
}

const TRUSTED_GIT_AUTHORITIES_V1 = new WeakMap<object, TrustedGitRepositoryStateV1>();

async function snapshotGitControlFileV1(path: string, maximumBytes: number): Promise<{
  pinned: PinnedGitControlFileV1;
  bytes: Uint8Array;
}> {
  const resolvedPath = resolve(path);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 65_536
    || resolve(await realpath(resolvedPath)) !== resolvedPath) throw new Error('Git authority unavailable');
  const before = await lstat(resolvedPath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.size < 1 || before.size > maximumBytes) throw new Error('Git authority unavailable');
  const noFollow = (fsConstants as unknown as Record<string, number>).O_NOFOLLOW ?? 0;
  const handle = await open(resolvedPath, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameStatIdentityV1(before, opened)) {
      throw new Error('Git authority unavailable');
    }
    const bytes = sealTrustedExactBytesV1(new Uint8Array(await handle.readFile()));
    const openedAfter = await handle.stat();
    const after = await lstat(resolvedPath);
    if (!sameStatIdentityV1(opened, openedAfter) || !sameStatIdentityV1(openedAfter, after)) {
      throw new Error('Git authority unavailable');
    }
    return Object.freeze({
      pinned: Object.freeze({
        path: resolvedPath, dev: after.dev, ino: after.ino, size: after.size,
        mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, bytesSha256: sha256(bytes),
      }),
      bytes,
    });
  } finally {
    await handle.close();
  }
}

async function assertGitControlFileV1(expected: PinnedGitControlFileV1): Promise<void> {
  const actual = await snapshotGitControlFileV1(expected.path, Math.max(1, expected.size));
  if (actual.pinned.dev !== expected.dev || actual.pinned.ino !== expected.ino
    || actual.pinned.size !== expected.size || actual.pinned.mtimeMs !== expected.mtimeMs
    || actual.pinned.ctimeMs !== expected.ctimeMs
    || actual.pinned.bytesSha256 !== expected.bytesSha256) throw new Error('Git authority changed');
}

async function optionalGitControlFileV1(path: string, maximumBytes: number): Promise<{
  pinned: PinnedGitControlFileV1;
  bytes: Uint8Array;
} | undefined> {
  try {
    return await snapshotGitControlFileV1(path, maximumBytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function authorityStateV1(authority: TrustedGitRepositoryAuthorityV1): TrustedGitRepositoryStateV1 {
  if (typeof authority !== 'object' || authority === null || nodeUtilTypes.isProxy(authority)) {
    throw new Error('Git authority changed');
  }
  const state = TRUSTED_GIT_AUTHORITIES_V1.get(authority);
  if (!state) throw new Error('Git authority changed');
  return state;
}

export async function captureTrustedGitRepositoryAuthorityV1(
  repositoryRoot: string,
): Promise<TrustedGitRepositoryAuthorityV1> {
  try {
    const root = resolve(repositoryRoot);
    const rootChain = await snapshotStableDirectoryChainV1(root);
    const markerPath = join(root, '.git');
    const markerStat = await lstat(markerPath);
    const controlFiles: PinnedGitControlFileV1[] = [];
    let gitDirectory: string;
    if (markerStat.isFile() && !markerStat.isSymbolicLink()) {
      const marker = await snapshotGitControlFileV1(markerPath, 4_096);
      controlFiles.push(marker.pinned);
      const line = decodeGitPathLineV1(marker.bytes);
      if (!line.startsWith('gitdir: ') || line.length <= 8) throw new Error('Git authority unavailable');
      gitDirectory = resolve(root, line.slice(8));
    } else if (markerStat.isDirectory() && !markerStat.isSymbolicLink()) {
      gitDirectory = resolve(markerPath);
    } else {
      throw new Error('Git authority unavailable');
    }
    if (resolve(await realpath(gitDirectory)) !== gitDirectory) throw new Error('Git authority unavailable');
    const gitDirectoryChain = await snapshotStableDirectoryChainV1(gitDirectory);
    const commonPointer = await optionalGitControlFileV1(join(gitDirectory, 'commondir'), 4_096);
    let commonDirectory = gitDirectory;
    if (commonPointer) {
      controlFiles.push(commonPointer.pinned);
      commonDirectory = resolve(gitDirectory, decodeGitPathLineV1(commonPointer.bytes));
    }
    if (resolve(await realpath(commonDirectory)) !== commonDirectory) throw new Error('Git authority unavailable');
    const commonDirectoryChain = await snapshotStableDirectoryChainV1(commonDirectory);
    const config = await snapshotGitControlFileV1(join(commonDirectory, 'config'), 65_536);
    controlFiles.push(config.pinned);
    for (const configPath of new Set([
      join(gitDirectory, 'config.worktree'), join(commonDirectory, 'config.worktree'),
    ])) {
      const worktreeConfig = await optionalGitControlFileV1(configPath, 65_536);
      if (worktreeConfig) controlFiles.push(worktreeConfig.pinned);
    }
    const objectDirectory = resolve(commonDirectory, 'objects');
    if (resolve(await realpath(objectDirectory)) !== objectDirectory) throw new Error('Git authority unavailable');
    const objectDirectoryChain = await snapshotStableDirectoryChainV1(objectDirectory);
    const infoDirectory = join(objectDirectory, 'info');
    const directoryChains: Array<readonly StableDirectoryIdentityV1[]> = [
      rootChain, gitDirectoryChain, commonDirectoryChain, objectDirectoryChain,
    ];
    try {
      directoryChains.push(await snapshotStableDirectoryChainV1(infoDirectory));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const alternatesPath = join(infoDirectory, 'alternates');
    try {
      await lstat(alternatesPath);
      throw new Error('Git authority unavailable');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const authority = Object.freeze({
      authorityVersion: 'memberry.git-object-authority.v1' as const,
      gitDirectory,
    });
    TRUSTED_GIT_AUTHORITIES_V1.set(authority, Object.freeze({
      root, gitDirectory, commonDirectory, objectDirectory,
      directoryChains: Object.freeze(directoryChains),
      controlFiles: Object.freeze(controlFiles), alternatesPath,
    }));
    await assertTrustedGitRepositoryAuthorityV1(authority);
    return authority;
  } catch {
    throw new Error('Git authority unavailable');
  }
}

export async function assertTrustedGitRepositoryAuthorityV1(
  authority: TrustedGitRepositoryAuthorityV1,
): Promise<void> {
  try {
    const state = authorityStateV1(authority);
    for (const chain of state.directoryChains) await assertStableDirectoryChainV1(chain);
    for (const file of state.controlFiles) await assertGitControlFileV1(file);
    try {
      await lstat(state.alternatesPath);
      throw new Error('Git authority changed');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  } catch {
    throw new Error('Git authority changed');
  }
}

async function readStoredGitBlobFromRepositoryV1(
  repository: TrustedGitRepositoryAuthorityV1,
  requestedObjectId: string,
  expectedObjectId: string,
  worktreeBytes: Uint8Array,
  maximumBytes = 1_048_576,
  expectedSha256?: string,
): Promise<Uint8Array> {
  try {
    if (typeof requestedObjectId !== 'string' || typeof expectedObjectId !== 'string'
      || !/^[0-9a-f]{40}$/.test(requestedObjectId) || requestedObjectId !== expectedObjectId
      || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 1_048_576
      || typeof expectedSha256 !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(expectedSha256)) {
      throw new Error('Git object identity mismatch');
    }
    worktreeBytes = snapshotExactUint8ArrayV1(worktreeBytes, 1, maximumBytes);
    if (sha256(worktreeBytes) !== expectedSha256) throw new Error('Git blob SHA256 mismatch');
    await runTrustedGitCommandV1(
      repository, ['cat-file', '-e', `${requestedObjectId}^{blob}`], 0,
    );
    const objectBytes = await runTrustedGitCommandV1(
      repository, ['cat-file', 'blob', requestedObjectId], maximumBytes,
    );
    if (gitBlobObjectIdV1(objectBytes) !== expectedObjectId
      || !Buffer.from(objectBytes).equals(Buffer.from(worktreeBytes))) {
      throw new Error('Git blob/worktree mismatch');
    }
    if (sha256(objectBytes) !== expectedSha256) throw new Error('Git blob SHA256 mismatch');
    return objectBytes;
  } catch (error) {
    if (error instanceof Error && (error.message === 'Git object identity mismatch'
      || error.message === 'Git blob/worktree mismatch'
      || error.message === 'Git blob SHA256 mismatch')) throw error;
    throw new Error('Git blob unavailable');
  }
}

export async function readStoredGitBlobObjectV1(
  repositoryRoot: string,
  requestedObjectId: string,
  expectedObjectId: string,
  worktreeBytes: Uint8Array,
  maximumBytes = 1_048_576,
  expectedSha256?: string,
): Promise<Uint8Array> {
  let repository: TrustedGitRepositoryAuthorityV1;
  try {
    repository = await captureTrustedGitRepositoryAuthorityV1(repositoryRoot);
  } catch {
    throw new Error('Git blob unavailable');
  }
  return readStoredGitBlobFromRepositoryV1(
    repository, requestedObjectId, expectedObjectId, worktreeBytes, maximumBytes, expectedSha256,
  );
}

export async function captureAdmissionCandidateSnapshotV1(): Promise<AdmissionCandidateSnapshotV1> {
  const candidateRoot = dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = resolve(candidateRoot, '../../../..');
  const directoryChain = await snapshotStableDirectoryChainV1(candidateRoot);
  const repository = await captureTrustedGitRepositoryAuthorityV1(repositoryRoot);
  const files = new Map<string, Uint8Array>();
  const manifestPaths = Object.keys(IMMUTABLE_CANDIDATE_GIT_BLOBS_V1) as Array<
    keyof typeof IMMUTABLE_CANDIDATE_GIT_BLOBS_V1
  >;
  for (const relativePath of manifestPaths) {
    const worktreeBytes = await readStableRegularFilePinnedV1(candidateRoot, relativePath, directoryChain);
    const expected = IMMUTABLE_CANDIDATE_GIT_BLOBS_V1[relativePath];
    const objectBytes = await readStoredGitBlobFromRepositoryV1(
      repository, expected.oid, expected.oid, worktreeBytes, 1_048_576, expected.sha256,
    );
    files.set(relativePath, verifyImmutableCandidateFileBytesV1(relativePath, objectBytes));
    await assertStableDirectoryChainV1(directoryChain);
  }
  await assertStableDirectoryChainV1(directoryChain);
  await assertTrustedGitRepositoryAuthorityV1(repository);
  const hash = createHash('sha256');
  for (const relativePath of SOURCE_FILES_V1) {
    const bytes = files.get(relativePath)!;
    hash.update(String(Buffer.byteLength(relativePath, 'utf8')));
    hash.update(':');
    hash.update(relativePath, 'utf8');
    hash.update(':');
    hash.update(String(bytes.byteLength));
    hash.update(':');
    hash.update(bytes);
  }
  return Object.freeze({
    files,
    candidateSha256: sha256(files.get(CANDIDATE_BUNDLE_PATH_V1)!),
    sourceSha256: `sha256:${hash.digest('hex')}`,
  });
}

export async function admissionCandidateHashesV1(): Promise<Readonly<{
  candidateSha256: `sha256:${string}`;
  sourceSha256: `sha256:${string}`;
}>> {
  const snapshot = await captureAdmissionCandidateSnapshotV1();
  return Object.freeze({
    candidateSha256: snapshot.candidateSha256,
    sourceSha256: snapshot.sourceSha256,
  });
}

export interface OwnedTemporaryDirectoryV1 {
  readonly directory: string;
  readonly cidFile: string;
  readonly sentinelFile: string;
  readonly runToken: string;
  readonly purpose: 'admission-run' | 'admission-build';
  readonly directoryIdentity: Readonly<{ dev: number; ino: number; birthtimeMs: number }>;
  readonly sentinelIdentity: Readonly<{ dev: number; ino: number; size: number }>;
}

export async function createOwnedTemporaryDirectoryV1(
  purpose: 'admission-run' | 'admission-build',
): Promise<OwnedTemporaryDirectoryV1> {
  const runToken = randomBytes(16).toString('hex');
  const systemTemporary = resolve(tmpdir());
  await assertSafeDirectoryNoRedirectV1(systemTemporary);
  const directory = resolve(await mkdtemp(resolve(systemTemporary, `memberry-${purpose}-${runToken}-`)));
  await chmod(directory, 0o700);
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
    || dirname(directory) !== systemTemporary || resolve(await realpath(directory)) !== directory) {
    throw new Error('unsafe owned temporary directory');
  }
  const sentinelFile = resolve(directory, '.memberry-owner');
  const sentinel = new TextEncoder().encode(`memberry:${purpose}:${runToken}\n`);
  await writeFile(sentinelFile, sentinel, { flag: 'wx', mode: 0o400 });
  const sentinelStat = await lstat(sentinelFile);
  if (!sentinelStat.isFile() || sentinelStat.isSymbolicLink() || sentinelStat.nlink !== 1
    || sentinelStat.size !== sentinel.byteLength) throw new Error('unsafe ownership sentinel');
  return Object.freeze({
    directory,
    cidFile: resolve(directory, 'container.cid'),
    sentinelFile,
    runToken,
    purpose,
    directoryIdentity: Object.freeze({
      dev: directoryStat.dev, ino: directoryStat.ino, birthtimeMs: directoryStat.birthtimeMs,
    }),
    sentinelIdentity: Object.freeze({
      dev: sentinelStat.dev, ino: sentinelStat.ino, size: sentinelStat.size,
    }),
  });
}

async function assertOwnedTemporaryIdentityV1(temporary: OwnedTemporaryDirectoryV1): Promise<void> {
  const directoryStat = await lstat(temporary.directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
    || directoryStat.dev !== temporary.directoryIdentity.dev
    || directoryStat.ino !== temporary.directoryIdentity.ino
    || directoryStat.birthtimeMs !== temporary.directoryIdentity.birthtimeMs
    || resolve(await realpath(temporary.directory)) !== temporary.directory) {
    throw new Error('owned temporary directory replaced');
  }
  const sentinelStat = await lstat(temporary.sentinelFile);
  if (!sentinelStat.isFile() || sentinelStat.isSymbolicLink() || sentinelStat.nlink !== 1
    || sentinelStat.dev !== temporary.sentinelIdentity.dev
    || sentinelStat.ino !== temporary.sentinelIdentity.ino
    || sentinelStat.size !== temporary.sentinelIdentity.size) {
    throw new Error('ownership sentinel replaced');
  }
  const sentinel = await readStableRegularFileV1(temporary.directory, '.memberry-owner');
  if (new TextDecoder('utf-8', { fatal: true }).decode(sentinel)
    !== `memberry:${temporary.purpose}:${temporary.runToken}\n`) throw new Error('ownership sentinel mismatch');
}

export async function readOwnedContainerIdFileV1(
  temporary: OwnedTemporaryDirectoryV1,
): Promise<string | undefined> {
  await assertOwnedTemporaryIdentityV1(temporary);
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(temporary.cidFile);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.size < 64 || before.size > 65) throw new Error('unsafe container ID file');
  const noFollow = (fsConstants as unknown as Record<string, number>).O_NOFOLLOW ?? 0;
  const handle = await open(temporary.cidFile, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameStatIdentityV1(before, opened)) {
      throw new Error('container ID file identity changed');
    }
    const bytes = new Uint8Array(await handle.readFile());
    const openedAfter = await handle.stat();
    const after = await lstat(temporary.cidFile);
    await assertOwnedTemporaryIdentityV1(temporary);
    if (!sameStatIdentityV1(opened, openedAfter) || !sameStatIdentityV1(openedAfter, after)) {
      throw new Error('container ID file changed while read');
    }
    const text = new TextDecoder('ascii', { fatal: true }).decode(bytes);
    if (!/^[0-9a-f]{64}\n?$/.test(text)) throw new Error('invalid container ID file');
    return text.trim();
  } finally {
    await handle.close();
  }
}

export async function cleanupOwnedTemporaryDirectoryV1(
  temporary: OwnedTemporaryDirectoryV1,
): Promise<boolean> {
  try {
    await assertOwnedTemporaryIdentityV1(temporary);
    const names = (await readdir(temporary.directory)).sort();
    if (names.some((name) => name !== '.memberry-owner' && name !== 'container.cid')) return false;
    if (names.includes('container.cid')) {
      const cidStat = await lstat(temporary.cidFile);
      if (!cidStat.isFile() || cidStat.isSymbolicLink() || cidStat.nlink !== 1) return false;
      await assertOwnedTemporaryIdentityV1(temporary);
      const cidImmediatelyBeforeUnlink = await lstat(temporary.cidFile);
      if (!sameStatIdentityV1(cidStat, cidImmediatelyBeforeUnlink)) return false;
      await unlink(temporary.cidFile);
    }
    await assertOwnedTemporaryIdentityV1(temporary);
    const sentinelImmediatelyBeforeUnlink = await lstat(temporary.sentinelFile);
    if (sentinelImmediatelyBeforeUnlink.dev !== temporary.sentinelIdentity.dev
      || sentinelImmediatelyBeforeUnlink.ino !== temporary.sentinelIdentity.ino
      || sentinelImmediatelyBeforeUnlink.size !== temporary.sentinelIdentity.size
      || !sentinelImmediatelyBeforeUnlink.isFile() || sentinelImmediatelyBeforeUnlink.nlink !== 1) return false;
    await unlink(temporary.sentinelFile);
    const directoryImmediatelyBeforeRmdir = await lstat(temporary.directory);
    if (!directoryImmediatelyBeforeRmdir.isDirectory() || directoryImmediatelyBeforeRmdir.isSymbolicLink()
      || directoryImmediatelyBeforeRmdir.dev !== temporary.directoryIdentity.dev
      || directoryImmediatelyBeforeRmdir.ino !== temporary.directoryIdentity.ino
      || directoryImmediatelyBeforeRmdir.birthtimeMs !== temporary.directoryIdentity.birthtimeMs) return false;
    // Node exposes path-based unlink/rmdir rather than unlinkat. The disposable hosted
    // worker boundary contains the residual name-swap race after this final identity check.
    await rmdir(temporary.directory);
    return await pathIsAbsentV1(temporary.directory);
  } catch {
    return false;
  }
}

async function createRunDirectoryV1(): Promise<OwnedTemporaryDirectoryV1> {
  return createOwnedTemporaryDirectoryV1('admission-run');
}

export async function assertSafeDirectoryNoRedirectV1(path: string): Promise<void> {
  if (typeof path !== 'string' || path.length < 1 || path.length > 8_192 || path.includes('\0')) {
    throw new Error('unsafe directory');
  }
  const resolved = resolve(path);
  const stat = await lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || resolve(await realpath(resolved)) !== resolved) {
    throw new Error('unsafe directory');
  }
}

async function pathIsAbsentV1(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error: any) {
    return error?.code === 'ENOENT';
  }
}

function sameAttestationV1(
  actual: AdmissionSandboxAttestationV1,
  expected: AdmissionSandboxAttestationV1,
): boolean {
  return actual.candidateSha256 === expected.candidateSha256
    && actual.sourceSha256 === expected.sourceSha256
    && actual.imageSha256 === expected.imageSha256
    && actual.baseImage === expected.baseImage
    && actual.imageConfigSha256 === expected.imageConfigSha256
    && actual.nodeSha256 === expected.nodeSha256
    && exactStringArray(actual.rootFsLayers, expected.rootFsLayers);
}

function snapshotAdmissionExecutionV1(value: unknown): AdmissionSandboxExecutionV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    throw new Error('invalid sandbox execution');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('invalid sandbox execution');
  const keys = Reflect.ownKeys(value);
  const allowed = new Set<PropertyKey>([
    'exitCode', 'signal', 'timedOut', 'stdout', 'stderr', 'outputExceeded', 'stderrExceeded',
    'launchFailed', 'cleanupVerified', 'attestation',
  ]);
  if (keys.some((key) => !allowed.has(key))
    || ['exitCode', 'signal', 'timedOut', 'stdout', 'stderr', 'cleanupVerified', 'attestation']
      .some((key) => !keys.includes(key))) throw new Error('invalid sandbox execution');
  const parsed = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string') throw new Error('invalid sandbox execution');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error('invalid sandbox execution');
    }
    parsed[key] = descriptor.value;
  }
  if (typeof parsed.cleanupVerified !== 'boolean') throw new Error('invalid sandbox execution');
  const command = snapshotDockerCommandResultV1({
    exitCode: parsed.exitCode,
    signal: parsed.signal,
    timedOut: parsed.timedOut,
    stdout: parsed.stdout,
    stderr: parsed.stderr,
    ...(parsed.outputExceeded === undefined ? {} : { outputExceeded: parsed.outputExceeded }),
    ...(parsed.stderrExceeded === undefined ? {} : { stderrExceeded: parsed.stderrExceeded }),
    ...(parsed.launchFailed === undefined ? {} : { launchFailed: parsed.launchFailed }),
  });
  const attestation = parsed.attestation;
  if (typeof attestation !== 'object' || attestation === null || Array.isArray(attestation)
    || nodeUtilTypes.isProxy(attestation)) throw new Error('invalid sandbox attestation');
  const attestationPrototype = Object.getPrototypeOf(attestation);
  if (attestationPrototype !== Object.prototype && attestationPrototype !== null) {
    throw new Error('invalid sandbox attestation');
  }
  const attestationKeys = [
    'candidateSha256', 'sourceSha256', 'imageSha256', 'baseImage', 'rootFsLayers',
    'imageConfigSha256', 'nodeSha256',
  ];
  const ownAttestationKeys = Reflect.ownKeys(attestation);
  if (ownAttestationKeys.length !== attestationKeys.length
    || ownAttestationKeys.some((key) => typeof key !== 'string' || !attestationKeys.includes(key))) {
    throw new Error('invalid sandbox attestation');
  }
  const evidence = Object.create(null) as Record<string, unknown>;
  for (const key of attestationKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(attestation, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error('invalid sandbox attestation');
    }
    evidence[key] = descriptor.value;
  }
  if (![evidence.candidateSha256, evidence.sourceSha256, evidence.imageSha256,
    evidence.imageConfigSha256, evidence.nodeSha256].every((entry) =>
    typeof entry === 'string' && IMAGE_PATTERN.test(entry))
    || typeof evidence.baseImage !== 'string' || !Array.isArray(evidence.rootFsLayers)
    || nodeUtilTypes.isProxy(evidence.rootFsLayers)
    || Object.getPrototypeOf(evidence.rootFsLayers) !== Array.prototype) {
    throw new Error('invalid sandbox attestation');
  }
  const layerKeys = Reflect.ownKeys(evidence.rootFsLayers);
  const layerValues: string[] = [];
  if (layerKeys.length !== evidence.rootFsLayers.length + 1) throw new Error('invalid sandbox attestation');
  for (let index = 0; index < evidence.rootFsLayers.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(evidence.rootFsLayers, String(index));
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || typeof descriptor.value !== 'string' || !IMAGE_PATTERN.test(descriptor.value)) {
      throw new Error('invalid sandbox attestation');
    }
    layerValues.push(descriptor.value);
  }
  return Object.freeze({
    ...command,
    cleanupVerified: parsed.cleanupVerified,
    attestation: Object.freeze({
      candidateSha256: evidence.candidateSha256 as `sha256:${string}`,
      sourceSha256: evidence.sourceSha256 as `sha256:${string}`,
      imageSha256: evidence.imageSha256 as `sha256:${string}`,
      baseImage: evidence.baseImage as string,
      rootFsLayers: Object.freeze(layerValues),
      imageConfigSha256: evidence.imageConfigSha256 as `sha256:${string}`,
      nodeSha256: evidence.nodeSha256 as `sha256:${string}`,
    }),
  });
}

export async function runAdmissionFeatureSandboxV1(
  value: unknown,
  ...rejectedOverrides: readonly unknown[]
): Promise<AdmissionSandboxResultV1> {
  if (rejectedOverrides.length !== 0) return fail('REQUEST_INVALID');
  let request: Readonly<{ image: string; inputs: unknown }>;
  let receipt: Readonly<AdmissionSandboxAttestationV1>;
  let inputBytes: Uint8Array;
  try {
    const parsedRequest = plainClosedRequest(value);
    request = { image: '', inputs: parsedRequest.inputs };
    const receiptModule = await import('./build.js');
    receipt = receiptModule.readAdmissionCandidateBuildReceiptV1(parsedRequest.receipt);
    request = Object.freeze({ image: receipt.imageSha256, inputs: parsedRequest.inputs });
    inputBytes = canonicalInputBytesV1(request.inputs);
  } catch {
    return fail('REQUEST_INVALID');
  }

  let sourceHash: `sha256:${string}`;
  let candidateHash: `sha256:${string}`;
  try {
    const hashes = await admissionCandidateHashesV1();
    sourceHash = hashes.sourceSha256;
    candidateHash = hashes.candidateSha256;
    if (receipt!.sourceSha256 !== sourceHash || receipt!.candidateSha256 !== candidateHash) {
      return fail('SOURCE_UNAVAILABLE');
    }
  } catch {
    return fail('SOURCE_UNAVAILABLE');
  }

  let temporary: Awaited<ReturnType<typeof createRunDirectoryV1>> | undefined;
  let safeToRemoveTemporary = false;
  let result: AdmissionSandboxResultV1 = fail('EXECUTOR_UNAVAILABLE');
  try {
    temporary = await createRunDirectoryV1();
    const expectedAttestation: AdmissionSandboxAttestationV1 = Object.freeze({
      candidateSha256: receipt!.candidateSha256,
      sourceSha256: receipt!.sourceSha256,
      imageSha256: receipt!.imageSha256,
      baseImage: receipt!.baseImage,
      rootFsLayers: receipt!.rootFsLayers,
      imageConfigSha256: receipt!.imageConfigSha256,
      nodeSha256: receipt!.nodeSha256,
    });
    const execution = snapshotAdmissionExecutionV1(await executeAdmissionSandboxDockerV1(Object.freeze({
      image: request.image as `sha256:${string}`,
      inputArchive: createAdmissionInputArchiveV1(inputBytes),
      temporary,
      expectedAttestation,
    })));
    safeToRemoveTemporary = execution.cleanupVerified;
    if (!execution.cleanupVerified) {
      result = fail('CLEANUP_FAILED');
    } else if (!sameAttestationV1(execution.attestation, expectedAttestation)) {
      result = fail('ATTESTATION_INVALID');
    } else if (execution.launchFailed) {
      result = fail('EXECUTOR_UNAVAILABLE');
    } else if (execution.timedOut) {
      result = fail('TIME_LIMIT');
    } else if (execution.outputExceeded
      || execution.stdout.byteLength > ADMISSION_SANDBOX_LIMITS_V1.outputBytes) {
      result = fail('OUTPUT_LIMIT');
    } else if (execution.stderrExceeded || execution.stderr.byteLength > ADMISSION_SANDBOX_LIMITS_V1.stderrBytes) {
      result = fail('STDERR_LIMIT');
    } else if (execution.exitCode === 137 || execution.signal === 'SIGKILL') result = fail('MEMORY_LIMIT');
    else if (execution.stderr.byteLength !== 0) result = fail('PROTOCOL_STDERR');
    else if (execution.exitCode !== 0) result = fail('PROCESS_FAILED');
    else try {
      if (!validateAdmissionArtifactBytesV1(execution.stdout, inputBytes)) {
        result = fail('PROTOCOL_INVALID');
      } else {
        const imageDigest = IMAGE_PATTERN.exec(request.image)![1]!;
        result = immutableSuccessV1(execution.stdout, {
            candidateSha256: candidateHash,
            sourceSha256: sourceHash,
            imageSha256: `sha256:${imageDigest}`,
            inputSha256: sha256(inputBytes),
            outputSha256: sha256(execution.stdout),
          });
      }
    } catch {
      result = fail('PROTOCOL_INVALID');
    }
  } catch {
    result = fail('EXECUTOR_UNAVAILABLE');
  }

  if (temporary && safeToRemoveTemporary) {
    try {
      if (!await cleanupOwnedTemporaryDirectoryV1(temporary)) return fail('CLEANUP_FAILED');
    } catch {
      return fail('CLEANUP_FAILED');
    }
  }
  return result;
}
