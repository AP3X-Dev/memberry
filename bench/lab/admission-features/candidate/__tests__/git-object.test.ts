import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertTrustedGitRepositoryAuthorityV1,
  captureAdmissionCandidateSnapshotV1,
  captureTrustedGitRepositoryAuthorityV1,
  dockerCliEnvironmentV1,
  readStoredGitBlobObjectV1,
  validateGitObjectCommandResultV1,
} from '../sandbox.js';

const temporaryRoots: string[] = [];
const sha256 = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function git(root: string, args: readonly string[]): Buffer {
  const result = spawnSync('git', [...args], {
    cwd: root,
    shell: false,
    windowsHide: true,
    encoding: 'buffer',
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  if (result.status !== 0) throw new Error(`temporary Git command failed: ${args[0]}`);
  return result.stdout;
}

async function temporaryRepository(): Promise<string> {
  const root = await mkdtemp(join(resolve(tmpdir()), 'memberry-git-object-test-'));
  temporaryRoots.push(root);
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.name', 'MemBerry Test']);
  git(root, ['config', 'user.email', 'memberry-test.invalid']);
  return root;
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    const fromTemporary = relative(resolve(tmpdir()), resolve(root));
    if (fromTemporary.length > 0 && !fromTemporary.startsWith('..') && !isAbsolute(fromTemporary)
      && basename(root).startsWith('memberry-git-object-test-')) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

describe('MEM-002C2 authoritative Git blob snapshot', () => {
  it('loads the complete current candidate snapshot from stored authoritative object bytes', async () => {
    const snapshot = await captureAdmissionCandidateSnapshotV1();
    expect([...snapshot.files.keys()]).toEqual([
      '.gitattributes', '.dockerignore', 'extractor.ts', 'protocol.ts', 'worker.ts',
      'container/Dockerfile', 'container/manifest.json', 'container/worker.mjs',
    ]);
    expect(new TextDecoder().decode(snapshot.files.get('.gitattributes'))).toBe([
      '.gitattributes text eol=lf',
      '.dockerignore text eol=lf',
      '*.ts text eol=lf',
      'container/Dockerfile text eol=lf',
      'container/manifest.json text eol=lf',
      'container/worker.mjs text eol=lf',
      '',
    ].join('\n'));
  });

  it('rejects unstored, foreign, non-blob, mismatched, and oversized object evidence', async () => {
    const root = await temporaryRepository();
    const path = join(root, 'candidate.txt');
    const bytes = new TextEncoder().encode('candidate-bytes\n');
    await writeFile(path, bytes);
    const calculated = git(root, ['hash-object', 'candidate.txt']).toString('ascii').trim();
    await expect(readStoredGitBlobObjectV1(root, calculated, calculated, bytes, 1_048_576, sha256(bytes)))
      .rejects.toThrow('Git blob unavailable');

    const stored = git(root, ['hash-object', '-w', 'candidate.txt']).toString('ascii').trim();
    await expect(readStoredGitBlobObjectV1(root, stored, stored, bytes, 1_048_576, sha256(bytes)))
      .resolves.toEqual(bytes);
    await expect(readStoredGitBlobObjectV1(
      root, stored, stored, bytes, 1_048_576, `sha256:${'0'.repeat(64)}`,
    )).rejects.toThrow('Git blob SHA256 mismatch');

    await writeFile(join(root, 'foreign.txt'), 'foreign\n');
    const foreign = git(root, ['hash-object', '-w', 'foreign.txt']).toString('ascii').trim();
    await expect(readStoredGitBlobObjectV1(
      root, foreign, stored, new TextEncoder().encode('foreign\n'), 1_048_576, sha256(bytes),
    )).rejects.toThrow('Git object identity mismatch');
    await expect(readStoredGitBlobObjectV1(
      root, stored, stored, new TextEncoder().encode('different\n'), 1_048_576, sha256(bytes),
    )).rejects.toThrow('Git blob SHA256 mismatch');

    git(root, ['add', 'candidate.txt']);
    git(root, ['commit', '--quiet', '-m', 'fixture']);
    const commit = git(root, ['rev-parse', 'HEAD']).toString('ascii').trim();
    const tree = git(root, ['rev-parse', 'HEAD^{tree}']).toString('ascii').trim();
    await expect(readStoredGitBlobObjectV1(root, commit, commit, bytes, 1_048_576, sha256(bytes)))
      .rejects.toThrow('Git blob unavailable');
    await expect(readStoredGitBlobObjectV1(root, tree, tree, bytes, 1_048_576, sha256(bytes)))
      .rejects.toThrow('Git blob unavailable');
    await expect(readStoredGitBlobObjectV1(root, stored, stored, bytes, 1_048_576, sha256(bytes)))
      .resolves.toEqual(bytes);

    const large = new Uint8Array(256).fill(0x61);
    await writeFile(join(root, 'large.bin'), large);
    const largeId = git(root, ['hash-object', '-w', 'large.bin']).toString('ascii').trim();
    await expect(readStoredGitBlobObjectV1(root, largeId, largeId, large, 32, sha256(large)))
      .rejects.toThrow('Git blob unavailable');
  }, 20_000);

  it('pins Git metadata authority and detects pointer, config, alternate, symlink, and ABA changes', async () => {
    const root = await temporaryRepository();
    const configPath = join(root, '.git', 'config');
    const originalConfig = await readFile(configPath);
    const authority = await captureTrustedGitRepositoryAuthorityV1(root);
    await writeFile(configPath, Buffer.concat([originalConfig, Buffer.from('\n[alias]\ncat-file = status\n')]));
    await writeFile(configPath, originalConfig);
    await expect(assertTrustedGitRepositoryAuthorityV1(authority)).rejects.toThrow('Git authority changed');

    const alternateRoot = await temporaryRepository();
    const alternateAuthority = await captureTrustedGitRepositoryAuthorityV1(alternateRoot);
    await writeFile(join(alternateRoot, '.git', 'objects', 'info', 'alternates'), `${root}/.git/objects\n`);
    await expect(assertTrustedGitRepositoryAuthorityV1(alternateAuthority))
      .rejects.toThrow('Git authority changed');

    const linkedParent = await mkdtemp(join(resolve(tmpdir()), 'memberry-git-object-test-'));
    temporaryRoots.push(linkedParent);
    const linkedRoot = join(linkedParent, 'linked');
    await writeFile(join(root, 'tracked.txt'), 'tracked\n');
    git(root, ['add', 'tracked.txt']);
    git(root, ['commit', '--quiet', '-m', 'linked fixture']);
    git(root, ['worktree', 'add', '--quiet', '--detach', linkedRoot, 'HEAD']);
    const pointerAuthority = await captureTrustedGitRepositoryAuthorityV1(linkedRoot);
    const pointerPath = join(linkedRoot, '.git');
    const pointer = await readFile(pointerPath);
    const pointerHandle = await open(pointerPath, 'r+');
    try {
      await pointerHandle.write(Buffer.from(' '), 0, 1, pointer.byteLength - 1);
      await pointerHandle.sync();
      await pointerHandle.write(pointer.subarray(pointer.byteLength - 1), 0, 1, pointer.byteLength - 1);
      await pointerHandle.sync();
    } finally {
      await pointerHandle.close();
    }
    await expect(assertTrustedGitRepositoryAuthorityV1(pointerAuthority))
      .rejects.toThrow('Git authority changed');

    const symlinkRoot = await mkdtemp(join(resolve(tmpdir()), 'memberry-git-object-test-'));
    temporaryRoots.push(symlinkRoot);
    await writeFile(join(symlinkRoot, 'candidate.txt'), 'candidate\n');
    const { symlink } = await import('node:fs/promises');
    await symlink(join(root, '.git'), join(symlinkRoot, '.git'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(captureTrustedGitRepositoryAuthorityV1(symlinkRoot))
      .rejects.toThrow('Git authority unavailable');
  }, 20_000);

  it('fails closed on hostile, timed-out, flooded, or stderr-bearing Git process evidence', () => {
    const valid = {
      exitCode: 0, signal: null, timedOut: false,
      stdout: Uint8Array.of(1), stderr: new Uint8Array(),
      outputExceeded: false, stderrExceeded: false, launchFailed: false,
    };
    expect(validateGitObjectCommandResultV1(valid, 1)).toEqual(Uint8Array.of(1));
    expect(() => validateGitObjectCommandResultV1({ ...valid, timedOut: true }, 1)).toThrow();
    expect(() => validateGitObjectCommandResultV1({ ...valid, outputExceeded: true }, 1)).toThrow();
    expect(() => validateGitObjectCommandResultV1({ ...valid, stderr: Uint8Array.of(1) }, 1)).toThrow();
    const getter = vi.fn(() => 1);
    const hostile = Object.defineProperty(Uint8Array.of(1), 'extra', {
      enumerable: true, configurable: true, get: getter,
    });
    expect(() => validateGitObjectCommandResultV1({ ...valid, stdout: hostile }, 1)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it('uses a closed Git environment that replaces every external Git control', () => {
    const environment = dockerCliEnvironmentV1({
      GIT_DIR: 'foreign',
      GIT_COMMON_DIR: 'foreign',
      GIT_OBJECT_DIRECTORY: 'foreign',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: 'foreign',
      GIT_REPLACE_REF_BASE: 'foreign',
      GIT_CONFIG_SYSTEM: 'foreign',
      GIT_CONFIG_GLOBAL: 'foreign',
      GIT_TERMINAL_PROMPT: '1',
    });
    expect(environment).not.toHaveProperty('GIT_DIR');
    expect(environment).not.toHaveProperty('GIT_COMMON_DIR');
    expect(environment).not.toHaveProperty('GIT_OBJECT_DIRECTORY');
    expect(environment).not.toHaveProperty('GIT_ALTERNATE_OBJECT_DIRECTORIES');
    expect(environment).not.toHaveProperty('GIT_REPLACE_REF_BASE');
    expect(environment.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(environment.GIT_CONFIG_GLOBAL).toBe(process.platform === 'win32' ? 'NUL' : '/dev/null');
    expect(environment.GIT_TERMINAL_PROMPT).toBe('0');
    expect(environment.GIT_NO_REPLACE_OBJECTS).toBe('1');
    expect(environment.GIT_OPTIONAL_LOCKS).toBe('0');
  });

  it('pins LF bytes through a fresh checkout even when core.autocrlf is true', async () => {
    const root = await temporaryRepository();
    git(root, ['config', 'core.autocrlf', 'true']);
    await writeFile(join(root, '.gitattributes'), '*.txt text eol=lf\n');
    await writeFile(join(root, 'candidate.txt'), 'line-one\nline-two\n');
    git(root, ['add', '.gitattributes', 'candidate.txt']);
    git(root, ['commit', '--quiet', '-m', 'lf policy']);
    await unlink(join(root, 'candidate.txt'));
    git(root, ['checkout', '--quiet', '--', 'candidate.txt']);
    expect(await readFile(join(root, 'candidate.txt')))
      .toEqual(Buffer.from('line-one\nline-two\n'));
  });
});
