import { spawn } from 'node:child_process';
import { unlink, writeFile } from 'node:fs/promises';
import { Socket } from 'node:net';
import { pathToFileURL } from 'node:url';
import { types as nodeUtilTypes } from 'node:util';
import { Worker } from 'node:worker_threads';

import { encodeAdmissionFeatureCandidateArtifactV1 } from './extractor.js';
import {
  ADMISSION_SANDBOX_LIMITS_V1,
  admissionWorkerFailureBytesV1,
} from './protocol.js';

export { admissionWorkerFailureBytesV1 } from './protocol.js';

export interface AdmissionFeatureWorkerResultV1 {
  readonly exitCode: 0 | 20 | 21 | 22;
  readonly stdout: Uint8Array;
}

const WORKER_TYPED_ARRAY_PROTOTYPE_V1 = Object.getPrototypeOf(Uint8Array.prototype);
const WORKER_BYTE_LENGTH_V1 = Object.getOwnPropertyDescriptor(
  WORKER_TYPED_ARRAY_PROTOTYPE_V1, 'byteLength',
)?.get;

function snapshotWorkerInputBytesV1(value: unknown): Uint8Array {
  if (typeof value !== 'object' || value === null || nodeUtilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Uint8Array.prototype
    || typeof WORKER_BYTE_LENGTH_V1 !== 'function') throw new Error('invalid');
  let length: number;
  try {
    length = WORKER_BYTE_LENGTH_V1.call(value) as number;
  } catch {
    throw new Error('invalid');
  }
  if (!Number.isSafeInteger(length) || length < 1 || length > ADMISSION_SANDBOX_LIMITS_V1.inputBytes) {
    throw new Error('invalid');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length) throw new Error('invalid');
  const result = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || descriptor.writable !== true || descriptor.enumerable !== true
      || descriptor.configurable !== true || typeof descriptor.value !== 'number'
      || !Number.isInteger(descriptor.value) || descriptor.value < 0 || descriptor.value > 255) {
      throw new Error('invalid');
    }
    result[index] = descriptor.value;
  }
  return result;
}

function sanitizeWorkerEnvironmentV1(): void {
  for (const key of Object.keys(process.env)) delete process.env[key];
  process.env.LANG = 'C.UTF-8';
  process.env.LC_ALL = 'C.UTF-8';
  process.env.TZ = 'UTC';
}

const RUNTIME_EVIDENCE_KEYS = Object.freeze([
  'environmentSanitized', 'rootReadOnly', 'childProcessDenied', 'workerThreadDenied',
  'networkDenied',
] as const);

function isAccessDenied(error: unknown, permission: string): boolean {
  return typeof error === 'object' && error !== null
    && (error as NodeJS.ErrnoException).code === 'ERR_ACCESS_DENIED'
    && (error as { permission?: unknown }).permission === permission;
}

export function evaluateAdmissionSandboxRuntimeEvidenceV1(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== RUNTIME_EVIDENCE_KEYS.length
      || keys.some((key) => typeof key !== 'string' || !RUNTIME_EVIDENCE_KEYS.includes(key as never))) {
      return false;
    }
    return RUNTIME_EVIDENCE_KEYS.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined
        && Object.prototype.hasOwnProperty.call(descriptor, 'value')
        && descriptor.value === true;
    });
  } catch {
    return false;
  }
}

async function rootReadOnlyProbeV1(): Promise<boolean> {
  const path = '/tmp/memberry-sandbox-write-probe';
  try {
    await writeFile(path, 'x', { flag: 'wx' });
    await unlink(path).catch(() => undefined);
    return false;
  } catch (error: any) {
    return error?.code === 'EROFS';
  }
}

async function childProcessDeniedProbeV1(): Promise<boolean> {
  try {
    return await new Promise((resolveProbe) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolveProbe(value);
    };
      const child = spawn('/usr/local/bin/node', ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false);
    }, 250);
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      finish(error.code === 'ERR_ACCESS_DENIED');
    });
    child.once('exit', () => {
      clearTimeout(timer);
      finish(false);
    });
    });
  } catch (error) {
    return isAccessDenied(error, 'ChildProcess');
  }
}

async function workerThreadDeniedProbeV1(): Promise<boolean> {
  try {
    const worker = new Worker('process.exit(0)', { eval: true });
    await worker.terminate().catch(() => undefined);
    return false;
  } catch (error) {
    return isAccessDenied(error, 'WorkerThreads');
  }
}

async function networkDeniedProbeV1(): Promise<boolean> {
  try {
    return await new Promise((resolveProbe) => {
    let settled = false;
    const socket = new Socket();
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(value);
    };
    const timer = setTimeout(() => finish(false), 250);
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      finish(error.code === 'ENETUNREACH' || error.code === 'EHOSTUNREACH'
        || error.code === 'ERR_ACCESS_DENIED');
    });
    socket.connect(53, '1.1.1.1', () => {
      clearTimeout(timer);
      finish(false);
    });
    });
  } catch (error) {
    return isAccessDenied(error, 'Network');
  }
}

async function verifyAdmissionSandboxRuntimeV1(): Promise<boolean> {
  const environmentSanitized = JSON.stringify(Object.keys(process.env).sort())
    === JSON.stringify(['LANG', 'LC_ALL', 'TZ']);
  return evaluateAdmissionSandboxRuntimeEvidenceV1({
    environmentSanitized,
    rootReadOnly: await rootReadOnlyProbeV1(),
    childProcessDenied: await childProcessDeniedProbeV1(),
    workerThreadDenied: await workerThreadDeniedProbeV1(),
    networkDenied: await networkDeniedProbeV1(),
  });
}

export function runAdmissionFeatureWorkerBytesV1(inputBytes: Uint8Array): AdmissionFeatureWorkerResultV1 {
  try {
    inputBytes = snapshotWorkerInputBytesV1(inputBytes);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(inputBytes);
    if (text.includes('\u001b')) throw new Error('invalid');
    const value = JSON.parse(text) as unknown;
    return Object.freeze({ exitCode: 0, stdout: encodeAdmissionFeatureCandidateArtifactV1(value) });
  } catch {
    return Object.freeze({ exitCode: 20, stdout: admissionWorkerFailureBytesV1('inputInvalid') });
  }
}

async function readAdmissionWorkerStdinV1(): Promise<Uint8Array> {
  const bytes = new Uint8Array(ADMISSION_SANDBOX_LIMITS_V1.inputBytes);
  let length = 0;
  for await (const chunk of process.stdin) {
    if (!(chunk instanceof Uint8Array)
      || length + chunk.byteLength > ADMISSION_SANDBOX_LIMITS_V1.inputBytes) {
      throw new Error('invalid');
    }
    bytes.set(chunk, length);
    length += chunk.byteLength;
  }
  if (length < 1) throw new Error('invalid');
  return bytes.slice(0, length);
}

async function main(): Promise<void> {
  sanitizeWorkerEnvironmentV1();
  let result: AdmissionFeatureWorkerResultV1;
  try {
    if (!await verifyAdmissionSandboxRuntimeV1()) {
      result = Object.freeze({
        exitCode: 22,
        stdout: admissionWorkerFailureBytesV1('sandboxPolicy'),
      });
      process.stdout.write(result.stdout);
      process.exitCode = result.exitCode;
      return;
    }
    if (process.argv.length !== 3 || process.argv[2] !== '-') {
      throw new Error('invalid');
    }
    const bytes = await readAdmissionWorkerStdinV1();
    result = runAdmissionFeatureWorkerBytesV1(bytes);
  } catch {
    result = Object.freeze({
      exitCode: 21,
      stdout: admissionWorkerFailureBytesV1('inputUnreadable'),
    });
  }
  process.stdout.write(result.stdout);
  process.exitCode = result.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main();
}
