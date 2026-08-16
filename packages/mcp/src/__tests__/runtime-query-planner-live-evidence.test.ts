import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hasExactPlannerEvidenceParentPermissionsV1,
  plannerEvidenceAuthorityV1,
  writePlannerLiveEvidenceTestCoreV1,
  writePlannerLiveEvidenceV1,
} from './runtime-query-planner-live-evidence.js';

const originalRunnerTemp = process.env['RUNNER_TEMP'];
const originalEvidencePath = process.env['MEMBERRY_RET002C2_EVIDENCE_PATH'];
const temporaryRoots: string[] = [];
const linuxOnly = process.platform === 'linux' ? it : it.skip;

async function authority(): Promise<Readonly<{
  runnerTemp: string;
  parent: string;
  evidencePath: string;
}>> {
  const runnerTemp = await mkdtemp(join(tmpdir(), 'memberry-ret002c2-evidence-'));
  temporaryRoots.push(runnerTemp);
  const parent = join(runnerTemp, 'memberry-retrieval-planner-live');
  await mkdir(parent, { mode: 0o700 });
  await chmod(parent, 0o700);
  const evidencePath = join(parent, 'evidence.json');
  process.env['RUNNER_TEMP'] = runnerTemp;
  process.env['MEMBERRY_RET002C2_EVIDENCE_PATH'] = evidencePath;
  return Object.freeze({ runnerTemp, parent, evidencePath });
}

async function failureCode(work: Promise<unknown>): Promise<string> {
  const error = await work.then(
    () => new Error('unexpected success'),
    (failure: unknown) => failure,
  );
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : 'FAILED';
}

afterEach(async () => {
  if (originalRunnerTemp === undefined) delete process.env['RUNNER_TEMP'];
  else process.env['RUNNER_TEMP'] = originalRunnerTemp;
  if (originalEvidencePath === undefined) delete process.env['MEMBERRY_RET002C2_EVIDENCE_PATH'];
  else process.env['MEMBERRY_RET002C2_EVIDENCE_PATH'] = originalEvidencePath;
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('RET-002C2 evidence authority portable predicates', () => {
  it('accepts exact 0700 only', () => {
    expect(hasExactPlannerEvidenceParentPermissionsV1(0o40700n)).toBe(true);
    for (const mode of [0o40755n, 0o40711n, 0o41700n, 0o42700n, 0o44700n]) {
      expect(hasExactPlannerEvidenceParentPermissionsV1(mode)).toBe(false);
    }
  });

  it('requires the exact resolved RUNNER_TEMP evidence path', () => {
    const runnerTemp = resolve(tmpdir());
    process.env['RUNNER_TEMP'] = runnerTemp;
    process.env['MEMBERRY_RET002C2_EVIDENCE_PATH'] = join(runnerTemp, 'wrong', 'evidence.json');
    expect(() => plannerEvidenceAuthorityV1()).toThrow('ret002c2_live:evidence_path_invalid');
    process.env['RUNNER_TEMP'] = 'relative-runner-temp';
    expect(() => plannerEvidenceAuthorityV1()).toThrow('ret002c2_live:evidence_path_invalid');
  });

  it('fails closed when the no-follow Linux authority is unavailable', async () => {
    if (process.platform === 'linux') return;
    await authority();
    expect(await failureCode(writePlannerLiveEvidenceV1()))
      .toBe('EVIDENCE_PLATFORM_UNSUPPORTED');
  });

  it('rejects every extra payload without hooks, traversal, serialization, or a leaf', async () => {
    const hooks = vi.fn();
    const proxy = new Proxy({}, {
      get: () => { hooks(); return undefined; },
      ownKeys: () => { hooks(); return []; },
      getOwnPropertyDescriptor: () => { hooks(); return undefined; },
    });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, 'secret', { enumerable: true, get: () => { hooks(); return 'secret'; } });
    const withToJson = { toJSON: () => { hooks(); return { secret: true }; } };
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const hostile = [proxy, revoked.proxy, accessor, withToJson, cycle, { extra: true }, { huge: 'x'.repeat(1_000_001) }];
    for (const value of hostile) {
      const target = await authority();
      expect(await failureCode(writePlannerLiveEvidenceV1(value))).toBe('EVIDENCE_INPUT_INVALID');
      await expect(lstat(target.evidencePath)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(hooks).not.toHaveBeenCalled();
  });
});

describe('RET-002C2 evidence authority Linux filesystem controls', () => {
  linuxOnly('creates one exclusive exact-0600 evidence leaf', async () => {
    const target = await authority();
    await writePlannerLiveEvidenceV1();
    expect(JSON.parse(await readFile(target.evidencePath, 'utf8'))).toEqual({
      contract: 'RET-002C2', mode: 'required', disposable: true,
      centralHttpAuthentication: true, unauthenticatedStatus: 401,
      ordinaryResolvedCount: 1, tracedResolvedCount: 1,
      askResolvedCount: 1, rejectedControlCount: 4, cleanupCount: 0,
    });
    expect((await lstat(target.evidencePath)).mode & 0o777).toBe(0o600);
  });

  linuxOnly('rejects missing and loose evidence parents', async () => {
    const target = await authority();
    await rm(target.parent, { recursive: true });
    expect(await failureCode(writePlannerLiveEvidenceV1()))
      .toBe('EVIDENCE_PARENT_INVALID');
    await mkdir(target.parent, { mode: 0o777 });
    await chmod(target.parent, 0o777);
    expect(await failureCode(writePlannerLiveEvidenceV1()))
      .toBe('EVIDENCE_PARENT_INVALID');
  });

  linuxOnly('rejects a symlinked evidence parent', async () => {
    const target = await authority();
    const realParent = join(target.runnerTemp, 'real-parent');
    await rm(target.parent, { recursive: true });
    await mkdir(realParent, { mode: 0o700 });
    await symlink(realParent, target.parent, 'dir');
    expect(await failureCode(writePlannerLiveEvidenceV1()))
      .toBe('EVIDENCE_PARENT_INVALID');
  });

  linuxOnly('detects a parent identity swap after exclusive open', async () => {
    const target = await authority();
    const displaced = join(target.runnerTemp, 'displaced-parent');
    expect(await failureCode(writePlannerLiveEvidenceTestCoreV1(async () => {
      await rename(target.parent, displaced);
      await mkdir(target.parent, { mode: 0o700 });
      await chmod(target.parent, 0o700);
    }))).toBe('EVIDENCE_PARENT_CHANGED');
  });

  linuxOnly('rejects an existing regular evidence leaf', async () => {
    const target = await authority();
    await writeFile(target.evidencePath, 'existing', { mode: 0o600 });
    expect(await failureCode(writePlannerLiveEvidenceV1())).toBe('EVIDENCE_EXISTS');
  });

  linuxOnly('rejects a symlink evidence leaf without following it', async () => {
    const target = await authority();
    await symlink(join(target.runnerTemp, 'foreign'), target.evidencePath);
    expect(await failureCode(writePlannerLiveEvidenceV1())).toBe('EVIDENCE_LEAF_LINK');
  });

  linuxOnly('rejects a hard-linked evidence leaf', async () => {
    const target = await authority();
    const source = join(target.runnerTemp, 'foreign');
    await writeFile(source, 'foreign', { mode: 0o600 });
    await link(source, target.evidencePath);
    expect(await failureCode(writePlannerLiveEvidenceV1()))
      .toBe('EVIDENCE_LEAF_HARDLINK');
  });

  linuxOnly('detects a concurrent hard link after exclusive open', async () => {
    const target = await authority();
    expect(await failureCode(writePlannerLiveEvidenceTestCoreV1(async () => {
      await link(target.evidencePath, join(target.parent, 'foreign-link'));
    }))).toBe('EVIDENCE_LEAF_HARDLINK');
  });
});
