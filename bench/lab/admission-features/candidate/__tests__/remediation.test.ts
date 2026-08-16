import { EventEmitter } from 'node:events';
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  APPROVED_NODE_BASE_IMAGE_V1,
  buildAdmissionFeatureCandidateImageV1,
  createCanonicalBuildContextV1,
  validateAdmissionCandidateBuildAssetsV1,
} from '../build.js';
import {
  assertSafeDirectoryNoRedirectV1,
  assertStableDirectoryChainV1,
  buildAdmissionFeatureSandboxInvocationV1,
  cleanupOwnedTemporaryDirectoryV1,
  createOwnedTemporaryDirectoryV1,
  createAdmissionInputArchiveV1,
  dockerCliEnvironmentV1,
  prepareDockerSpawnV1,
  readOwnedContainerIdFileV1,
  readStableRegularFileV1,
  runDockerCommandWithSpawnV1,
  snapshotAdmissionOutputEvidenceV1,
  snapshotDockerCommandResultV1,
  snapshotStableDirectoryChainV1,
  verifyImmutableCandidateFileBytesV1,
} from '../sandbox.js';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../..');
const candidateRoot = resolve(root, 'bench/lab/admission-features/candidate');
const image = `sha256:${'a'.repeat(64)}`;
const token = 'b'.repeat(32);
const trustedDockerTestExecutable = process.platform === 'win32'
  ? 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'
  : '/usr/bin/docker';

function canonicalEntries(): Array<{ path: string; bytes: Uint8Array }> {
  return [
    { path: '.dockerignore', bytes: Uint8Array.of(1) },
    { path: 'container/Dockerfile', bytes: Uint8Array.of(2) },
    { path: 'container/attestation.json', bytes: Uint8Array.of(3) },
    { path: 'container/manifest.json', bytes: Uint8Array.of(4) },
    { path: 'container/worker.mjs', bytes: Uint8Array.of(5) },
  ];
}

describe('MEM-002C2 hostile remediation contract', () => {
  it('closes the public build API to every runner override without reading it', async () => {
    expect(buildAdmissionFeatureCandidateImageV1.length).toBe(0);
    const getter = vi.fn(() => vi.fn());
    const override = Object.defineProperty({}, 'runner', { enumerable: true, get: getter });
    await expect((buildAdmissionFeatureCandidateImageV1 as any)(override))
      .rejects.toThrow('build overrides are forbidden');
    expect(getter).not.toHaveBeenCalled();
  });

  it('descriptor-snapshots dense canonical tar entries before sorting or emitting', () => {
    const entries = canonicalEntries();
    const archive = createCanonicalBuildContextV1(entries);
    const frozen = new Uint8Array(archive);
    entries.forEach((entry) => entry.bytes.fill(0xff));
    expect(archive).toEqual(frozen);

    const hooks = { get: vi.fn(), getPrototypeOf: vi.fn(), ownKeys: vi.fn() };
    const hostile = canonicalEntries();
    hostile[2] = new Proxy(hostile[2]!, hooks);
    expect(() => createCanonicalBuildContextV1(hostile)).toThrow('invalid build context entry');
    expect(hooks.get).not.toHaveBeenCalled();
    expect(hooks.getPrototypeOf).not.toHaveBeenCalled();
    expect(hooks.ownKeys).not.toHaveBeenCalled();

    const getter = vi.fn(() => 'container/attestation.json');
    const accessor = Object.defineProperty({ bytes: Uint8Array.of(3) }, 'path', {
      enumerable: true, get: getter,
    });
    const accessorEntries = canonicalEntries();
    accessorEntries[2] = accessor as any;
    expect(() => createCanonicalBuildContextV1(accessorEntries)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects accessor or extra-own-key typed arrays at every public byte boundary without hooks', () => {
    const getter = vi.fn(() => 'executed');
    const hostile = Object.defineProperty(Uint8Array.of(1), 'sideEffect', {
      enumerable: true, get: getter,
    });
    const entries = canonicalEntries();
    entries[0] = { path: '.dockerignore', bytes: hostile };
    expect(() => createCanonicalBuildContextV1(entries)).toThrow();
    expect(() => createAdmissionInputArchiveV1(hostile)).toThrow();
    expect(() => snapshotAdmissionOutputEvidenceV1(hostile)).toThrow();
    expect(() => prepareDockerSpawnV1({
      executable: 'docker', args: ['version'], env: {}, shell: false, stdin: hostile,
    })).toThrow();
    expect(() => snapshotDockerCommandResultV1({
      exitCode: 0, signal: null, timedOut: false,
      stdout: hostile, stderr: new Uint8Array(),
    })).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects sparse arrays and proxied nested bytes without invoking proxy hooks', () => {
    const sparse = canonicalEntries();
    delete (sparse as any)[2];
    expect(() => createCanonicalBuildContextV1(sparse)).toThrow();
    const hooks = { get: vi.fn(), getPrototypeOf: vi.fn() };
    const entries = canonicalEntries();
    entries[0] = { path: '.dockerignore', bytes: new Proxy(Uint8Array.of(1), hooks) };
    expect(() => createCanonicalBuildContextV1(entries)).toThrow();
    expect(hooks.get).not.toHaveBeenCalled();
    expect(hooks.getPrototypeOf).not.toHaveBeenCalled();
  });

  it('pins the full root and ancestor chain and detects a mixed-root replacement', async () => {
    const base = await mkdtemp(resolve(process.env.TEMP ?? '/tmp', 'memberry-root-chain-'));
    const candidate = resolve(base, 'candidate');
    const original = resolve(base, 'candidate-original');
    try {
      await mkdir(candidate);
      await writeFile(resolve(candidate, 'a.txt'), 'first');
      const chain = await snapshotStableDirectoryChainV1(candidate);
      await rename(candidate, original);
      await mkdir(candidate);
      await writeFile(resolve(candidate, 'a.txt'), 'foreign');
      await expect(assertStableDirectoryChainV1(chain)).rejects.toThrow('candidate directory chain changed');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('requires a content-addressed immutable file manifest so ABA swap-restore bytes cannot be trusted', async () => {
    const sandboxSource = await readFile(resolve(candidateRoot, 'sandbox.ts'), 'utf8');
    expect(sandboxSource).toContain('IMMUTABLE_CANDIDATE_GIT_BLOBS_V1');
    expect(sandboxSource).toContain('gitBlobObjectIdV1');
    const base = await mkdtemp(resolve(process.env.TEMP ?? '/tmp', 'memberry-aba-'));
    const live = resolve(base, 'live');
    const original = resolve(base, 'original');
    const replacement = resolve(base, 'replacement');
    try {
      await mkdir(live); await mkdir(replacement);
      await writeFile(resolve(live, '.dockerignore'), await readFile(resolve(candidateRoot, '.dockerignore')));
      await writeFile(resolve(replacement, '.dockerignore'), 'foreign replacement');
      await rename(live, original);
      await rename(replacement, live);
      const capturedDuringSwap = new Uint8Array(await readFile(resolve(live, '.dockerignore')));
      await rename(live, replacement);
      await rename(original, live);
      expect(() => verifyImmutableCandidateFileBytesV1('.dockerignore', capturedDuringSwap))
        .toThrow('candidate Git blob mismatch');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('rejects hardlinked files and in-root reparse redirects without reading targets', async () => {
    const base = await mkdtemp(resolve(process.env.TEMP ?? '/tmp', 'memberry-source-identity-'));
    const rootPath = resolve(base, 'root');
    const outside = resolve(base, 'outside');
    try {
      await mkdir(rootPath); await mkdir(outside);
      await writeFile(resolve(rootPath, 'regular.txt'), 'safe');
      await link(resolve(rootPath, 'regular.txt'), resolve(rootPath, 'hard.txt'));
      await expect(readStableRegularFileV1(rootPath, 'regular.txt')).rejects.toThrow('unsafe candidate file');
      await writeFile(resolve(outside, 'secret.txt'), 'secret');
      await symlink(outside, resolve(rootPath, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
      await expect(readStableRegularFileV1(rootPath, 'redirect/secret.txt'))
        .rejects.toThrow('candidate path escaped root');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('reads cleanup authority only from one bounded nofollow owned CID file', async () => {
    const temporary = await createOwnedTemporaryDirectoryV1('admission-run');
    const id = 'd'.repeat(64);
    await writeFile(temporary.cidFile, `${id}\n`, { flag: 'wx', mode: 0o400 });
    expect(await readOwnedContainerIdFileV1(temporary)).toBe(id);
    expect(await cleanupOwnedTemporaryDirectoryV1(temporary)).toBe(true);
  });

  it.each([
    ['oversized', `${'d'.repeat(65)}\n`],
    ['uppercase', `${'D'.repeat(64)}\n`],
    ['extra line', `${'d'.repeat(64)}\nforeign\n`],
  ])('rejects %s CID-file content', async (_name, content) => {
    const temporary = await createOwnedTemporaryDirectoryV1('admission-run');
    try {
      await writeFile(temporary.cidFile, content, { flag: 'wx', mode: 0o400 });
      await expect(readOwnedContainerIdFileV1(temporary)).rejects.toThrow();
    } finally {
      await rm(temporary.directory, { recursive: true, force: true });
    }
  });

  it('rejects symlinked and hardlinked CID files and never follows them', async () => {
    for (const mode of ['symlink', 'hardlink'] as const) {
      const temporary = await createOwnedTemporaryDirectoryV1('admission-run');
      const foreign = resolve(temporary.directory, '..', `foreign-${temporary.runToken}`);
      try {
        await writeFile(foreign, `${'d'.repeat(64)}\n`, { flag: 'wx' });
        if (mode === 'symlink') await symlink(foreign, temporary.cidFile, 'file');
        else await link(foreign, temporary.cidFile);
        await expect(readOwnedContainerIdFileV1(temporary)).rejects.toThrow('unsafe container ID file');
        expect(await readFile(foreign, 'utf8')).toContain('d'.repeat(64));
      } finally {
        await rm(temporary.directory, { recursive: true, force: true });
        await rm(foreign, { force: true });
      }
    }
  });

  it('refuses cleanup after sentinel replacement and preserves the foreign file', async () => {
    const temporary = await createOwnedTemporaryDirectoryV1('admission-run');
    const foreign = resolve(temporary.directory, '..', `foreign-${temporary.runToken}`);
    try {
      await writeFile(foreign, `memberry:admission-run:${temporary.runToken}\n`, { flag: 'wx' });
      await unlink(temporary.sentinelFile);
      await link(foreign, temporary.sentinelFile);
      expect(await cleanupOwnedTemporaryDirectoryV1(temporary)).toBe(false);
      expect(await readFile(foreign, 'utf8')).toContain(temporary.runToken);
    } finally {
      await rm(temporary.directory, { recursive: true, force: true });
      await rm(foreign, { force: true });
    }
  });

  it('rejects a redirected temporary parent', async () => {
    const base = await mkdtemp(resolve(process.env.TEMP ?? '/tmp', 'memberry-redirection-'));
    try {
      await mkdir(resolve(base, 'target'));
      await symlink(resolve(base, 'target'), resolve(base, 'redirected'), process.platform === 'win32' ? 'junction' : 'dir');
      await expect(assertSafeDirectoryNoRedirectV1(resolve(base, 'redirected'))).rejects.toThrow('unsafe directory');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('uses exclusive cidfile creation, no mounts, and sanitized environment', () => {
    const cidFile = resolve(process.env.TEMP ?? '/tmp', `memberry-admission-run-${token}-abcdef`, 'container.cid');
    const invocation = buildAdmissionFeatureSandboxInvocationV1({
      image, cidFile, runToken: token,
      hostEnvironment: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DOCKER_HOST: 'tcp://attacker' },
    });
    expect(invocation.args).toContain(`--cidfile=${cidFile}`);
    expect(invocation.args).not.toContain(expect.stringMatching(/^--name=|^--mount|^--volume/));
    expect(invocation.env).not.toHaveProperty('DOCKER_HOST');
  });

  it('reads environment allowlist descriptors without accessors or proxies', () => {
    const getter = vi.fn(() => 'tcp://attacker');
    const environment = Object.defineProperty({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      'DOCKER_HOST', { enumerable: true, get: getter });
    expect(dockerCliEnvironmentV1(environment)).not.toHaveProperty('DOCKER_HOST');
    expect(getter).not.toHaveBeenCalled();
    expect(() => dockerCliEnvironmentV1(new Proxy({}, {}))).toThrow();
  });

  it('spawns only the verified absolute Docker executable', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: null, kill: vi.fn(() => true),
    });
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    });
    await expect(runDockerCommandWithSpawnV1({
      executable: 'docker', args: ['version'],
      env: { PATH: resolve(candidateRoot, 'attacker-bin'), SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' },
      shell: false,
    }, spawnProcess as any, async () => trustedDockerTestExecutable)).resolves.toMatchObject({ exitCode: 0 });
    expect(spawnProcess).toHaveBeenCalledWith(resolve(trustedDockerTestExecutable), expect.any(Array), expect.any(Object));
  });

  it.each([
    ['timeout', 1, undefined],
    ['stdout flood', 1_000, Uint8Array.of(1, 2)],
  ])('kills and boundedly resolves a non-closing child on %s', async (_name, timeoutMs, flood) => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(), stdin: null, kill: vi.fn(() => true),
      });
      const result = runDockerCommandWithSpawnV1({
        executable: 'docker', args: ['version'], env: dockerCliEnvironmentV1(process.env), shell: false,
        timeoutMs, stdoutLimit: 1,
      }, (() => child) as any, async () => trustedDockerTestExecutable);
      if (flood) child.stdout.write(flood);
      await vi.advanceTimersByTimeAsync(251);
      await expect(result).resolves.toMatchObject({ signal: 'SIGKILL' });
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('kills and awaits after stdin failure', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(() => true),
    });
    const result = runDockerCommandWithSpawnV1({
      executable: 'docker', args: ['container', 'cp'], env: dockerCliEnvironmentV1(process.env), shell: false,
      stdin: Uint8Array.of(1), timeoutMs: 1_000,
    }, (() => child) as any, async () => trustedDockerTestExecutable);
    await Promise.resolve(); await Promise.resolve();
    child.stdin.emit('error', new Error('broken pipe'));
    child.emit('close', null, 'SIGKILL');
    await expect(result).resolves.toMatchObject({ launchFailed: true, signal: 'SIGKILL' });
  });

  it('freezes the exact base and validates the full nested manifest without hooks', async () => {
    const dockerfile = await readFile(resolve(candidateRoot, 'container/Dockerfile'), 'utf8');
    const manifest = JSON.parse(await readFile(resolve(candidateRoot, 'container/manifest.json'), 'utf8'));
    expect(APPROVED_NODE_BASE_IMAGE_V1).toMatch(/^node@sha256:[0-9a-f]{64}$/);
    expect(validateAdmissionCandidateBuildAssetsV1({ dockerfile, manifest })).toEqual({
      baseImage: APPROVED_NODE_BASE_IMAGE_V1,
    });
    const hooks = { get: vi.fn(), getPrototypeOf: vi.fn(), ownKeys: vi.fn() };
    const hostile = structuredClone(manifest);
    hostile.runtime.inputDelivery = new Proxy(hostile.runtime.inputDelivery, hooks);
    expect(() => validateAdmissionCandidateBuildAssetsV1({ dockerfile, manifest: hostile })).toThrow();
    expect(hooks.get).not.toHaveBeenCalled();
    expect(hooks.getPrototypeOf).not.toHaveBeenCalled();
    expect(hooks.ownKeys).not.toHaveBeenCalled();
  });

  it('rejects hostile invocation shapes before reading their fields', () => {
    const getter = vi.fn(() => image);
    const accessor = Object.defineProperty({}, 'image', { enumerable: true, get: getter });
    expect(() => buildAdmissionFeatureSandboxInvocationV1(accessor)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(() => prepareDockerSpawnV1({
      executable: 'docker', args: Array.from({ length: 129 }, () => 'x'), env: {}, shell: false,
    })).toThrow();
  });
});
