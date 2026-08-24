import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { encodeAdmissionFeatureCandidateArtifactV1 } from '../extractor.js';
import * as sandboxModule from '../sandbox.js';
import {
  ADMISSION_SANDBOX_LIMITS_V1,
  buildAdmissionFeatureSandboxInvocationV1,
  buildAdmissionFeatureSandboxStartInvocationV1,
  prepareDockerSpawnV1,
  runAdmissionFeatureSandboxV1,
  snapshotAdmissionOutputEvidenceV1,
  snapshotDockerCommandResultV1,
  validateAdmissionArtifactBytesV1,
} from '../sandbox.js';
import {
  admissionWorkerFailureBytesV1,
  evaluateAdmissionSandboxRuntimeEvidenceV1,
  runAdmissionFeatureWorkerBytesV1,
} from '../worker.js';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../..');
const pinnedImage = `sha256:${'a'.repeat(64)}`;
const forgedReceipt = Object.freeze({
  receiptVersion: 'memberry.admission-build-receipt.v1',
  candidateSha256: `sha256:${'1'.repeat(64)}`,
  sourceSha256: `sha256:${'2'.repeat(64)}`,
  imageSha256: pinnedImage,
  baseImage: `node@sha256:${'3'.repeat(64)}`,
  rootFsLayers: Object.freeze([`sha256:${'4'.repeat(64)}`]),
  imageConfigSha256: `sha256:${'5'.repeat(64)}`,
  nodeSha256: `sha256:${'6'.repeat(64)}`,
});

async function fixedInputs(): Promise<unknown[]> {
  const load = async (path: string) => (await readFile(resolve(root, path), 'utf8'))
    .replace(/\r\n?/g, '\n').split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown);
  return [
    ...await load('bench/lab/admission-features/fixtures/v2/dev/input.jsonl'),
    ...await load('bench/lab/admission-features/fixtures/v2/holdout/input.jsonl'),
  ];
}

describe('MEM-002C2 fixed worker protocol', () => {
  it('requires decisive runtime evidence and never invokes hostile evidence accessors', () => {
    expect(evaluateAdmissionSandboxRuntimeEvidenceV1({
      environmentSanitized: true, rootReadOnly: true, childProcessDenied: true,
      workerThreadDenied: true, networkDenied: true,
    })).toBe(true);
    const getter = vi.fn(() => true);
    const hostile = Object.defineProperty({
      environmentSanitized: true, rootReadOnly: true, childProcessDenied: true,
      workerThreadDenied: true,
    }, 'networkDenied', { enumerable: true, get: getter });
    expect(evaluateAdmissionSandboxRuntimeEvidenceV1(hostile)).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });

  it('emits only the exact canonical candidate artifact for canonical input bytes', async () => {
    const inputs = await fixedInputs();
    const inputBytes = new TextEncoder().encode(JSON.stringify(inputs));
    const result = runAdmissionFeatureWorkerBytesV1(inputBytes);
    expect(result).toEqual({ exitCode: 0, stdout: encodeAdmissionFeatureCandidateArtifactV1(inputs) });
    expect(validateAdmissionArtifactBytesV1(result.stdout, inputBytes)).toBe(true);
  });

  it('validates the container artifact independently with exact hash, identity, order, and shape bindings', async () => {
    const inputs = await fixedInputs();
    const inputBytes = new TextEncoder().encode(JSON.stringify(inputs));
    const valid = encodeAdmissionFeatureCandidateArtifactV1(inputs);
    const mutate = (change: (artifact: any) => void) => {
      const artifact = JSON.parse(new TextDecoder().decode(valid));
      change(artifact);
      return new TextEncoder().encode(JSON.stringify(artifact));
    };
    expect(validateAdmissionArtifactBytesV1(valid, inputBytes)).toBe(true);
    expect(validateAdmissionArtifactBytesV1(mutate((artifact) => {
      artifact.inputHash = `sha256:${'0'.repeat(64)}`;
    }), inputBytes)).toBe(false);
    expect(validateAdmissionArtifactBytesV1(mutate((artifact) => {
      artifact.predictions[0].scenarioId = 'af-dev-002';
    }), inputBytes)).toBe(false);
    expect(validateAdmissionArtifactBytesV1(mutate((artifact) => {
      artifact.predictions.reverse();
    }), inputBytes)).toBe(false);
    expect(validateAdmissionArtifactBytesV1(mutate((artifact) => {
      artifact.predictions[0].features.extra = true;
    }), inputBytes)).toBe(false);
    expect(validateAdmissionArtifactBytesV1(mutate((artifact) => {
      artifact.predictions[0].features.dimensions.salience.valuePermille = 1_001;
    }), inputBytes)).toBe(false);
  });

  it.each([
    ['empty', new Uint8Array()],
    ['malformed UTF-8', Uint8Array.of(0xc3, 0x28)],
    ['partial JSON', new TextEncoder().encode('[{"datasetId":')],
    ['ANSI prefix', new TextEncoder().encode('\u001b[31m[]')],
    ['oversized', new Uint8Array(ADMISSION_SANDBOX_LIMITS_V1.inputBytes + 1)],
  ])('returns one fixed value-free failure for %s input', (_name, bytes) => {
    expect(runAdmissionFeatureWorkerBytesV1(bytes)).toEqual({
      exitCode: 20, stdout: admissionWorkerFailureBytesV1('inputInvalid'),
    });
  });

  it('returns fresh failure bytes and rejects proxy typed arrays without hooks', () => {
    const first = admissionWorkerFailureBytesV1('inputInvalid');
    first.fill(0);
    expect(new TextDecoder().decode(admissionWorkerFailureBytesV1('inputInvalid')))
      .toBe('{"protocolVersion":"1.0.0","ok":false,"failureCode":"INPUT_INVALID"}');
    const hooks = { get: vi.fn(), getPrototypeOf: vi.fn() };
    const proxy = new Proxy(new Uint8Array([1]), hooks);
    expect(runAdmissionFeatureWorkerBytesV1(proxy).exitCode).toBe(20);
    expect(() => buildAdmissionFeatureSandboxStartInvocationV1('c'.repeat(64), proxy)).toThrow();
    expect(hooks.get).not.toHaveBeenCalled();
    expect(hooks.getPrototypeOf).not.toHaveBeenCalled();
  });

  it('rejects extra-own-key, revoked, and forged typed-array inputs without invoking accessors', () => {
    const getter = vi.fn(() => 1);
    const extra = Object.defineProperty(Uint8Array.of(1), 'extra', {
      enumerable: true, configurable: true, get: getter,
    });
    expect(runAdmissionFeatureWorkerBytesV1(extra).exitCode).toBe(20);
    expect(getter).not.toHaveBeenCalled();
    const revocable = Proxy.revocable(Uint8Array.of(1), {});
    revocable.revoke();
    expect(runAdmissionFeatureWorkerBytesV1(revocable.proxy).exitCode).toBe(20);
    expect(runAdmissionFeatureWorkerBytesV1(Object.create(Uint8Array.prototype)).exitCode).toBe(20);
  });
});

describe('MEM-002C2 closed public sandbox boundary', () => {
  it('has arity one, rejects extra executor arguments, and exposes no executor override export', async () => {
    expect(runAdmissionFeatureSandboxV1.length).toBe(1);
    expect('executeAdmissionSandboxDockerWithRunnerV1' in sandboxModule).toBe(false);
    expect('executeAdmissionSandboxDockerV1' in sandboxModule).toBe(false);
    const getter = vi.fn(() => vi.fn());
    const override = Object.defineProperty({}, 'execute', { enumerable: true, get: getter });
    await expect((runAdmissionFeatureSandboxV1 as any)(
      { receipt: forgedReceipt, inputs: await fixedInputs() }, override,
    )).resolves.toEqual({ ok: false, failureCode: 'REQUEST_INVALID' });
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects structurally perfect but unissued receipts and hostile request descriptors', async () => {
    await expect(runAdmissionFeatureSandboxV1({ receipt: forgedReceipt, inputs: await fixedInputs() }))
      .resolves.toEqual({ ok: false, failureCode: 'REQUEST_INVALID' });
    const getter = vi.fn(() => []);
    const accessor = Object.defineProperty({ receipt: forgedReceipt }, 'inputs', {
      enumerable: true, get: getter,
    });
    await expect(runAdmissionFeatureSandboxV1(accessor))
      .resolves.toEqual({ ok: false, failureCode: 'REQUEST_INVALID' });
    expect(getter).not.toHaveBeenCalled();
    await expect(runAdmissionFeatureSandboxV1(new Proxy({}, {})))
      .resolves.toEqual({ ok: false, failureCode: 'REQUEST_INVALID' });
  });

  it('returns defensive output copies whose immutable hash cannot diverge', () => {
    const original = new TextEncoder().encode('immutable-output');
    const expected = new Uint8Array(original);
    const evidence = snapshotAdmissionOutputEvidenceV1(original);
    original.fill(0);
    const first = evidence.output;
    first.fill(0xff);
    expect(evidence.output).toEqual(expected);
    expect(evidence.outputSha256).toBe(
      `sha256:${createHash('sha256').update(expected).digest('hex')}`,
    );
  });

  it('rejects proxy/accessor command results without invoking hooks', () => {
    const result = {
      exitCode: 0, signal: null, timedOut: false,
      stdout: new Uint8Array(), stderr: new Uint8Array(), cleanupVerified: true,
    };
    const hooks = { get: vi.fn(), getPrototypeOf: vi.fn(), ownKeys: vi.fn() };
    expect(() => snapshotDockerCommandResultV1(new Proxy(result, hooks))).toThrow();
    expect(hooks.get).not.toHaveBeenCalled();
    expect(hooks.getPrototypeOf).not.toHaveBeenCalled();
    expect(hooks.ownKeys).not.toHaveBeenCalled();
  });
});

describe('MEM-002C2 hardened sandbox invocation', () => {
  it('is offline, non-root, read-only, interactive, capability-free, bounded, and mount-free', () => {
    const runToken = 'b'.repeat(32);
    const cidFile = resolve(tmpdir(), `memberry-admission-run-${runToken}-abcdef`, 'container.cid');
    const invocation = buildAdmissionFeatureSandboxInvocationV1({
      image: pinnedImage, cidFile, runToken, hostEnvironment: process.env,
    });
    expect(invocation.args).toContain('--network=none');
    expect(invocation.args).toContain('--read-only');
    expect(invocation.args).toContain('--interactive');
    expect(invocation.args).toContain('--user=65532:65532');
    expect(invocation.args).toContain('--pids-limit=32');
    expect(invocation.args.join(' ')).not.toMatch(/--allow-child-process|--allow-worker|--allow-net/);
    expect(invocation.args.join(' ')).not.toMatch(/--mount|--volume|docker\.sock|\.git|scorer-only|oracle/i);
    expect(invocation.args.join(' ')).not.toContain('/run/input.json');
    expect(invocation.args.join(' ')).not.toContain('--allow-fs-read');
  });

  it('snapshots one exact bounded stdin payload for attached start and rejects substitution', () => {
    const content = new TextEncoder().encode('{"bounded":true}');
    const invocation = buildAdmissionFeatureSandboxStartInvocationV1('c'.repeat(64), content);
    content.fill(0xff);
    expect(invocation.args).toEqual(['container', 'start', '--attach', '--interactive', 'c'.repeat(64)]);
    expect(invocation.stdin).toEqual(new TextEncoder().encode('{"bounded":true}'));
    expect(Object.isExtensible(invocation.stdin!)).toBe(false);
    expect(() => buildAdmissionFeatureSandboxStartInvocationV1(
      'c'.repeat(64), new Uint8Array(ADMISSION_SANDBOX_LIMITS_V1.inputBytes + 1),
    )).toThrow();
    expect(() => buildAdmissionFeatureSandboxStartInvocationV1(
      'c'.repeat(64), new Uint8Array(),
    )).toThrow();
    expect(() => buildAdmissionFeatureSandboxStartInvocationV1(
      'c'.repeat(63), Uint8Array.of(1),
    )).toThrow();
  });

  it('bounds Docker argv count and argument width before spawn', () => {
    const base = { executable: 'docker', env: process.env, shell: false } as const;
    expect(() => prepareDockerSpawnV1({ ...base, args: Array.from({ length: 129 }, () => 'x') })).toThrow();
    expect(() => prepareDockerSpawnV1({ ...base, args: ['x'.repeat(8_193)] })).toThrow();
  });
});
