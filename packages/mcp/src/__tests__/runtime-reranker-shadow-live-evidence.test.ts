import { chmod, link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  rerankerShadowEvidenceAuthorityV1,
  writeRerankerShadowLiveEvidenceTestCoreV1,
  writeRerankerShadowLiveEvidenceV1,
} from './runtime-reranker-shadow-live-evidence.js';

const roots: string[] = [];
const originalRoot = process.env['RUNNER_TEMP'];
const originalAuthorityPath = process.env['MEMBERRY_RET003B_EVIDENCE_PATH'];
const originalRet004bPath = process.env['MEMBERRY_RET004B_EVIDENCE_PATH'];
const linux = process.platform === 'linux' ? it : it.skip;

async function authority(): Promise<{ root: string; parent: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'memberry-ret004b-evidence-'));
  roots.push(root);
  const parent = join(root, 'memberry-candidate-channel-live');
  await mkdir(parent, { mode: 0o700 });
  await chmod(parent, 0o700);
  const path = join(parent, 'ret004b-evidence.json');
  process.env['RUNNER_TEMP'] = root;
  process.env['MEMBERRY_RET003B_EVIDENCE_PATH'] = join(parent, 'evidence.json');
  delete process.env['MEMBERRY_RET004B_EVIDENCE_PATH'];
  return { root, parent, path };
}

async function code(work: Promise<unknown>): Promise<string> {
  const error = await work.then(() => new Error('unexpected success'), (value: unknown) => value);
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code) : 'FAILED';
}

afterEach(async () => {
  if (originalRoot === undefined) delete process.env['RUNNER_TEMP']; else process.env['RUNNER_TEMP'] = originalRoot;
  if (originalAuthorityPath === undefined) delete process.env['MEMBERRY_RET003B_EVIDENCE_PATH'];
  else process.env['MEMBERRY_RET003B_EVIDENCE_PATH'] = originalAuthorityPath;
  if (originalRet004bPath === undefined) delete process.env['MEMBERRY_RET004B_EVIDENCE_PATH'];
  else process.env['MEMBERRY_RET004B_EVIDENCE_PATH'] = originalRet004bPath;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('RET-004B secure fixed live-evidence writer', () => {
  it('requires the exact resolved authority path', () => {
    const root = resolve(tmpdir());
    process.env['RUNNER_TEMP'] = root;
    process.env['MEMBERRY_RET003B_EVIDENCE_PATH'] = join(root, 'wrong', 'evidence.json');
    delete process.env['MEMBERRY_RET004B_EVIDENCE_PATH'];
    expect(() => rerankerShadowEvidenceAuthorityV1()).toThrow('ret004b_live:path_invalid');
  });

  it('rejects caller-controlled payloads before filesystem access', async () => {
    const target = await authority();
    expect(await code(writeRerankerShadowLiveEvidenceV1({ secret: 'never serialize me' }))).toBe('INPUT_INVALID');
    await expect(readFile(target.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  linux('writes the fixed content once with 0600 permissions', async () => {
    const target = await authority();
    await writeRerankerShadowLiveEvidenceV1();
    const bytes = await readFile(target.path, 'utf8');
    expect(bytes).toBe('{"contract":"RET-004B","mode":"required","disposable":true,"realBootstrap":true,"centralHttpAuthentication":true,"authorityBound":true,"baselineByteParity":true,"contentFreeObservation":true,"localReferenceProvider":true,"shutdownDrained":true,"cleanupCount":0}\n');
    expect((await lstat(target.path)).mode & 0o7777).toBe(0o600);
    expect(await code(writeRerankerShadowLiveEvidenceV1())).toBe('EXISTS');
  });

  linux('rejects loose or linked parents and linked leaves', async () => {
    let target = await authority();
    await chmod(target.parent, 0o755);
    expect(await code(writeRerankerShadowLiveEvidenceV1())).toBe('PARENT_INVALID');

    target = await authority();
    const realParent = join(target.root, 'real-parent');
    await rm(target.parent, { recursive: true });
    await mkdir(realParent, { mode: 0o700 });
    await symlink(realParent, target.parent, 'dir');
    expect(await code(writeRerankerShadowLiveEvidenceV1())).toBe('PARENT_INVALID');

    target = await authority();
    const leafTarget = join(target.root, 'leaf-target');
    await writeFile(leafTarget, 'x');
    await symlink(leafTarget, target.path, 'file');
    expect(await code(writeRerankerShadowLiveEvidenceV1())).toBe('LEAF_LINK');

    target = await authority();
    const hardTarget = join(target.root, 'hard-target');
    await writeFile(hardTarget, 'x');
    await link(hardTarget, target.path);
    expect(await code(writeRerankerShadowLiveEvidenceV1())).toBe('LEAF_HARDLINK');
  });

  linux('rejects a parent identity swap after exclusive open', async () => {
    const target = await authority();
    const moved = join(target.root, 'moved-parent');
    expect(await code(writeRerankerShadowLiveEvidenceTestCoreV1(async () => {
      await rename(target.parent, moved);
      await mkdir(target.parent, { mode: 0o700 });
      await chmod(target.parent, 0o700);
    }))).toBe('PARENT_CHANGED');
  });
});
