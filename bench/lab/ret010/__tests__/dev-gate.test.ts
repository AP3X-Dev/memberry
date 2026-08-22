import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  classifyCustodyComponent,
  createCustodyLeafForTest,
  ensureFailureBoundaryForTest,
  finalizeFailureBoundaryForTest,
  qualifyingConjunctionCount,
  removeCustodyLeafForTest,
  renameCustodyLeafForTest,
  runDevelopment,
  validateBundlePairForTest,
  validateCustodyChainForTest,
  validateFailureTombstoneForTest,
  validateHostedMetadataForTest,
  validateSuccessBundleForTest,
} from '../dev-gate.js';

const roots: string[] = [];
const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const bytes = (value: object) => Buffer.from(`${JSON.stringify(value)}\n`);

async function successBundle(nodeMajor: '20' | '22', overrides: { runId?: string; aggregateMarker?: string } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `ret010e-bundle-${nodeMajor}-`));
  roots.push(root);
  const arm = { recallAtK: 0.5, precisionAtK: 0.5, staleLeakRate: 0, isolationLeakRate: 0, duplicateRate: 0, unknownResultRate: 0 };
  const lane = (name: 'recall-at-10' | 'precision-at-5', count: number) => ({
    schemaVersion: '1', lane: name, datasetId: 'memberry-ret010-dev-v1', split: 'dev',
    controlAdapterId: 'memberry-retrieval-core-disabled-v1', candidateAdapterId: 'memberry-retrieval-core-served-v1',
    scenarioCount: 10, probeCount: 10, k: name === 'recall-at-10' ? 10 : 5,
    control: arm,
    candidate: name === 'precision-at-5' ? { ...arm, precisionAtK: 0.55 } : arm,
    delta: { recallAtK: 0, precisionAtK: name === 'precision-at-5' ? 0.050000000000000044 : 0 },
    qualifyingCaseCount: count, passed: true,
  });
  const recall = lane('recall-at-10', 1);
  const precision = lane('precision-at-5', 0);
  const interval = {
    schemaVersion: '1', metric: 'task-success-per-1k-tokens', outcome: 'measured', pairedProbes: 20,
    resamples: 2000, level: 0.95, seed: 1, point: 0.1, lower: 0, upper: 0.2, oneSidedLower: 0,
  };
  const recallBytes = bytes(recall); const precisionBytes = bytes(precision); const intervalBytes = bytes(interval);
  const aggregate = {
    schemaVersion: '1', decision: 'passed', datasetId: 'memberry-ret010-dev-v1', split: 'dev',
    controlAdapterId: 'memberry-retrieval-core-disabled-v1', candidateAdapterId: 'memberry-retrieval-core-served-v1',
    providerIdentity: { providerId: 'memberry.local.lexical', modelId: 'bm25f-query-v1', calibrationId: 'fixed-blend-v1', locality: 'local' },
    sourceCommit: 'a'.repeat(40), modelBlob: 'b'.repeat(40), providerContractBlob: 'c'.repeat(40), adapterBlob: 'd'.repeat(40),
    datasetDescriptorSha256: '1'.repeat(64), inputSha256: '2'.repeat(64), oracleSha256: '3'.repeat(64), devPolicySha256: '4'.repeat(64),
    recallLaneSha256: digest(recallBytes), precisionLaneSha256: digest(precisionBytes), efficiencyIntervalSha256: digest(intervalBytes),
    seed: 1, quality: { recallDelta: 0, precisionDelta: 0.050000000000000044, efficiencyPoint: 0.1, efficiencyOneSidedLower: 0 },
    safety: { staleLeakRate: 0, isolationLeakRate: 0, duplicateRate: 0, unknownResultRate: 0 },
    responseEffect: { sameCaseOrderAndSelectionChanged: true, qualifyingCaseCount: 1 }, passed: true,
    ...(overrides.aggregateMarker ? { forbiddenMarker: overrides.aggregateMarker } : {}),
  };
  const aggregateBytes = bytes(aggregate);
  const manifest = {
    schemaVersion: '1', decision: 'passed', gitCommit: 'a'.repeat(40), nodeMajor, nodeVersion: `v${nodeMajor}.19.0`,
    workflowRunId: overrides.runId ?? '77', workflowRunAttempt: 1,
    recallLaneSha256: digest(recallBytes), precisionLaneSha256: digest(precisionBytes),
    efficiencyIntervalSha256: digest(intervalBytes), aggregateResultSha256: digest(aggregateBytes),
  };
  await Promise.all([
    writeFile(join(root, 'recall-lane.json'), recallBytes),
    writeFile(join(root, 'precision-lane.json'), precisionBytes),
    writeFile(join(root, 'efficiency-interval.json'), intervalBytes),
    writeFile(join(root, 'aggregate-result.json'), aggregateBytes),
    writeFile(join(root, 'custody-manifest.json'), bytes(manifest)),
  ]);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('RET-010E development custody gate', () => {
  it('requires order and selected-evidence changes on the same probe', () => {
    expect(qualifyingConjunctionCount(
      [['a', 'b', 'c'], ['d', 'e', 'f']],
      [['b', 'a', 'c'], ['d', 'e', 'x']],
    )).toBe(0);
    expect(qualifyingConjunctionCount(
      [['a', 'b', 'c'], ['d', 'e', 'f']],
      [['b', 'a', 'x'], ['d', 'e', 'f']],
    )).toBe(1);
    expect(() => qualifyingConjunctionCount([['a', 'a', 'b']], [['a', 'b', 'x']])).toThrow('metric');
  });

  it('classifies only an unchanged ordinary directory as admissible', () => {
    expect(classifyCustodyComponent({ kind: 'directory', realPathMatches: true })).toBe('directory');
    for (const kind of ['file', 'symlink', 'junction', 'reparse', 'mount'] as const) {
      expect(classifyCustodyComponent({ kind, realPathMatches: true })).toBe('reject');
    }
    expect(classifyCustodyComponent({ kind: 'directory', realPathMatches: false })).toBe('reject');
  });

  it('uses the injected classifier on the runtime chain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ret010e-classifier-'));
    roots.push(root);
    const child = join(root, 'child');
    await mkdir(child);
    let calls = 0;
    await expect(validateCustodyChainForTest(root, child, (fixture) => {
      calls += 1;
      return calls === 2 && fixture.kind === 'directory' ? 'reject' : classifyCustodyComponent(fixture);
    })).rejects.toThrow('custody');
    expect(calls).toBe(2);
    for (const windowsReparseKind of ['junction', 'reparse'] as const) {
      const observed: string[] = [];
      await expect(validateCustodyChainForTest(root, child, (fixture) => {
        observed.push(fixture.kind);
        return classifyCustodyComponent(fixture);
      }, async (path) => ({
        isDirectory: true, isSymbolicLink: false, dev: 1, realPath: resolve(path),
        ...(path === child ? { windowsReparseKind } : {}),
      }))).rejects.toThrow('custody');
      expect(observed).toEqual(['directory', windowsReparseKind]);
    }
  });

  it('rejects real symbolic links at every ancestor and at the leaf', async () => {
    for (const linkIndex of [0, 1, 2]) {
      const root = await mkdtemp(join(tmpdir(), 'ret010e-chain-'));
      roots.push(root);
      const foreign = await mkdtemp(join(tmpdir(), 'ret010e-foreign-'));
      roots.push(foreign);
      const names = ['cache', 'runs', 'ret010-development'];
      let parent = root;
      for (let index = 0; index < names.length; index += 1) {
        const next = join(parent, names[index]!);
        if (index === linkIndex) {
          await symlink(foreign, next, 'dir');
          parent = next;
          for (const remainder of names.slice(index + 1)) parent = join(parent, remainder);
          break;
        }
        await mkdir(next);
        parent = next;
      }
      await expect(validateCustodyChainForTest(root, resolve(root, ...names))).rejects.toThrow('custody');
      expect(await readFile(resolve(import.meta.dirname, '..', 'dev-gate.ts'), 'utf8')).toContain('isSymbolicLink()');
    }
  });

  it('fails closed on real create, publish-rename, quarantine-rename, and delete substitutions', async () => {
    for (const stage of ['after-create', 'before-publish', 'before-rename', 'before-delete'] as const) {
      const root = await mkdtemp(join(tmpdir(), `ret010e-race-${stage}-`));
      roots.push(root);
      const parent = join(root, 'parent');
      const foreign = await mkdtemp(join(tmpdir(), `ret010e-foreign-${stage}-`));
      roots.push(foreign);
      await mkdir(parent);
      await writeFile(join(foreign, 'marker.txt'), 'foreign-unchanged', 'utf8');
      const leaf = join(parent, 'leaf');
      const output = join(parent, 'output');
      const substitute = async (path: string) => {
        await rm(path, { recursive: true, force: true });
        await symlink(foreign, path, 'dir');
      };
      if (stage === 'after-create') {
        await expect(createCustodyLeafForTest(root, parent, leaf, async (observed, path) => {
          if (observed === stage) await substitute(path);
        })).rejects.toThrow('custody');
      } else {
        await mkdir(leaf);
        if (stage === 'before-publish') {
          await expect(renameCustodyLeafForTest(root, parent, leaf, output, async (observed, path) => {
            if (observed === stage) await substitute(path);
          })).rejects.toThrow('custody');
        } else {
          await expect(removeCustodyLeafForTest(root, parent, leaf, async (observed, path) => {
            if (observed === stage) await substitute(path);
          })).rejects.toThrow('custody');
        }
      }
      expect(await readFile(join(foreign, 'marker.txt'), 'utf8')).toBe('foreign-unchanged');
      const publicPath = stage === 'before-publish' ? output : leaf;
      await expect(lstat(publicPath)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    const root = await mkdtemp(join(tmpdir(), 'ret010e-directory-race-'));
    roots.push(root);
    const parent = join(root, 'parent'); const source = join(parent, 'source'); const output = join(parent, 'output');
    await mkdir(parent); await mkdir(source);
    await expect(renameCustodyLeafForTest(root, parent, source, output, async (stage, path) => {
      if (stage === 'before-publish') {
        await rm(path, { recursive: true, force: true });
        await mkdir(path); await writeFile(join(path, 'FOREIGN-SENTINEL'), 'unchanged');
      }
    })).rejects.toThrow('custody');
    await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(source)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses collision-resistant quarantine custody instead of predictable sibling names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ret010e-quarantine-collision-')); roots.push(root);
    const parent = join(root, 'parent'); const leaf = join(parent, 'leaf');
    await mkdir(parent); await mkdir(leaf);
    await mkdir(`${leaf}.quarantine`); await mkdir(`${leaf}.rejected`);
    await expect(removeCustodyLeafForTest(root, parent, leaf)).resolves.toBeUndefined();
    await expect(lstat(leaf)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(`${leaf}.quarantine`)).isDirectory()).toBe(true);
    expect((await lstat(`${leaf}.rejected`)).isDirectory()).toBe(true);
  });

  it('proves current tombstone or absence after combined stale, publication, and primary cleanup failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ret010e-failure-boundary-')); roots.push(root);
    const publicLeaf = join(root, 'ret010-development'); const foreign = join(root, 'foreign.txt');
    await mkdir(publicLeaf); await writeFile(join(publicLeaf, 'aggregate-result.json'), 'STALE-SUCCESS-SECRET');
    await writeFile(foreign, 'FOREIGN-UNCHANGED');
    const outcome = await ensureFailureBoundaryForTest({
      publish: async () => { throw new Error('publication'); },
      validateCurrent: async () => { throw new Error('not-current'); },
      primaryCleanup: async () => { throw new Error('primary-cleanup'); },
      fallbackCleanup: async () => { await rm(publicLeaf, { recursive: true, force: false }); },
      proveAbsent: async () => { await expect(lstat(publicLeaf)).rejects.toMatchObject({ code: 'ENOENT' }); },
    });
    expect(outcome).toBe('absent'); await expect(lstat(publicLeaf)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(foreign, 'utf8')).toBe('FOREIGN-UNCHANGED');

    await mkdir(publicLeaf); await writeFile(join(publicLeaf, 'aggregate-result.json'), 'STALE-SUCCESS-SECRET');
    const primary = await ensureFailureBoundaryForTest({
      publish: async () => { throw new Error('publication'); }, validateCurrent: async () => {},
      primaryCleanup: async () => { await rm(publicLeaf, { recursive: true, force: false }); },
      fallbackCleanup: async () => { throw new Error('fallback-must-not-run'); },
      proveAbsent: async () => { await expect(lstat(publicLeaf)).rejects.toMatchObject({ code: 'ENOENT' }); },
    });
    expect(primary).toBe('absent');

    let publishedCurrent = false;
    const tombstone = await ensureFailureBoundaryForTest({
      publish: async () => { publishedCurrent = true; },
      validateCurrent: async () => { if (!publishedCurrent) throw new Error('not-current'); },
      primaryCleanup: async () => { throw new Error('cleanup-must-not-run'); },
      fallbackCleanup: async () => { throw new Error('cleanup-must-not-run'); }, proveAbsent: async () => {},
    });
    expect(tombstone).toBe('tombstone');

    await mkdir(publicLeaf); await writeFile(join(publicLeaf, 'aggregate-result.json'), 'STALE-SUCCESS-SECRET');
    await expect(ensureFailureBoundaryForTest({
      publish: async () => { throw new Error('publication'); }, validateCurrent: async () => {},
      primaryCleanup: async () => { throw new Error('primary-cleanup'); },
      fallbackCleanup: async () => { throw new Error('fallback-cleanup'); }, proveAbsent: async () => {},
    })).rejects.toThrow('custody');
    expect(await readFile(join(publicLeaf, 'aggregate-result.json'), 'utf8')).toBe('STALE-SUCCESS-SECRET');
    expect(await readFile(foreign, 'utf8')).toBe('FOREIGN-UNCHANGED');
  });

  it('executes the three-leaf finalizer failure matrix with canonical tombstone-only success', async () => {
    const fixture = async () => {
      const root = await mkdtemp(join(tmpdir(), 'ret010e-finalizer-boundary-')); roots.push(root);
      const publicLeaf = join(root, 'public'); const gateStage = join(root, 'gate-stage'); const finalizerStage = join(root, 'finalizer-stage');
      for (const path of [publicLeaf, gateStage, finalizerStage]) { await mkdir(path); await writeFile(join(path, 'STALE'), 'STALE-SUCCESS-SECRET'); }
      return { root, publicLeaf, gateStage, finalizerStage };
    };
    const remove = async (path: string) => { await rm(path, { recursive: true, force: true }); };
    const absent = async (...paths: string[]) => {
      for (const path of paths) await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    };

    const current = await fixture();
    await expect(finalizeFailureBoundaryForTest({
      cleanupPublic: async () => remove(current.publicLeaf), cleanupGateStage: async () => remove(current.gateStage),
      cleanupFinalizerStage: async () => remove(current.finalizerStage),
      publishCurrentTombstone: async () => { await mkdir(current.publicLeaf); await writeFile(join(current.publicLeaf, 'failure-tombstone.json'), 'CURRENT-TOMBSTONE\n'); },
      verifyCurrentTombstone: async () => { expect(await readFile(join(current.publicLeaf, 'failure-tombstone.json'), 'utf8')).toBe('CURRENT-TOMBSTONE\n'); },
      proveAllStagingAbsent: async () => absent(current.gateStage, current.finalizerStage),
      proveAllAbsent: async () => absent(current.publicLeaf, current.gateStage, current.finalizerStage),
    })).resolves.toBeUndefined();
    expect(await readFile(join(current.publicLeaf, 'failure-tombstone.json'), 'utf8')).toBe('CURRENT-TOMBSTONE\n');
    await absent(current.gateStage, current.finalizerStage);

    for (const failingTarget of ['public', 'gate', 'finalizer'] as const) {
      const item = await fixture(); const calls = { public: 0, gate: 0, finalizer: 0 };
      const cleanup = async (target: keyof typeof calls, path: string) => {
        calls[target] += 1; if (target === failingTarget && calls[target] === 1) throw new Error(`${target}-cleanup`); await remove(path);
      };
      await expect(finalizeFailureBoundaryForTest({
        cleanupPublic: async () => cleanup('public', item.publicLeaf), cleanupGateStage: async () => cleanup('gate', item.gateStage),
        cleanupFinalizerStage: async () => cleanup('finalizer', item.finalizerStage),
        publishCurrentTombstone: async () => { throw new Error('must-not-publish'); }, verifyCurrentTombstone: async () => {},
        proveAllStagingAbsent: async () => {}, proveAllAbsent: async () => absent(item.publicLeaf, item.gateStage, item.finalizerStage),
      })).rejects.toThrow();
      expect(calls).toEqual({ public: 1, gate: 1, finalizer: 1 });
      const failedPath = failingTarget === 'public' ? item.publicLeaf : failingTarget === 'gate' ? item.gateStage : item.finalizerStage;
      expect((await lstat(failedPath)).isDirectory()).toBe(true);
      await absent(...[item.publicLeaf, item.gateStage, item.finalizerStage].filter((path) => path !== failedPath));
    }

    for (const failingOperation of ['publication', 'verification', 'absence-proof'] as const) {
      const item = await fixture();
      await expect(finalizeFailureBoundaryForTest({
        cleanupPublic: async () => remove(item.publicLeaf), cleanupGateStage: async () => remove(item.gateStage),
        cleanupFinalizerStage: async () => remove(item.finalizerStage),
        publishCurrentTombstone: async () => {
          if (failingOperation === 'publication') throw new Error('publication');
          await mkdir(item.publicLeaf); await writeFile(join(item.publicLeaf, 'failure-tombstone.json'), 'CURRENT-TOMBSTONE\n');
        },
        verifyCurrentTombstone: async () => { if (failingOperation === 'verification') throw new Error('canonical-verification'); },
        proveAllStagingAbsent: async () => { if (failingOperation === 'absence-proof') throw new Error('staging-absence-proof'); },
        proveAllAbsent: async () => { await absent(item.publicLeaf, item.gateStage, item.finalizerStage); if (failingOperation === 'absence-proof') throw new Error('absence-proof'); },
      })).rejects.toThrow();
      await absent(item.publicLeaf, item.gateStage, item.finalizerStage);
    }

    const triple = await fixture(); const tripleCalls = { public: 0, gate: 0, finalizer: 0 };
    await expect(finalizeFailureBoundaryForTest({
      cleanupPublic: async () => { tripleCalls.public += 1; throw new Error('public-cleanup'); },
      cleanupGateStage: async () => { tripleCalls.gate += 1; throw new Error('gate-cleanup'); },
      cleanupFinalizerStage: async () => { tripleCalls.finalizer += 1; throw new Error('finalizer-cleanup'); }, publishCurrentTombstone: async () => {},
      verifyCurrentTombstone: async () => {}, proveAllStagingAbsent: async () => {}, proveAllAbsent: async () => {},
    })).rejects.toThrow('custody');
    expect(tripleCalls).toEqual({ public: 1, gate: 1, finalizer: 1 });
    expect(await readFile(join(triple.publicLeaf, 'STALE'), 'utf8')).toBe('STALE-SUCCESS-SECRET');
  });

  it('returns CLI success only after exact current tombstone finalization', async () => {
    const gate = resolve(import.meta.dirname, '..', 'dev-gate.ts');
    const child = spawnSync(process.execPath, ['--import', 'tsx', gate, 'finalize', 'failure'], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '1' },
    });
    expect(child.status).toBe(0); expect(child.stdout).toBe(''); expect(child.stderr).toBe('');
    const output = resolve(ROOT, 'node_modules/.cache/memberry-lab/runs/ret010-development');
    const tombstone = JSON.parse(await readFile(join(output, 'failure-tombstone.json'), 'utf8'));
    expect(tombstone).toMatchObject({ decision: 'failed', workflowRunId: '77', workflowRunAttempt: 1 });
    await expect(lstat(resolve(ROOT, 'node_modules/.cache/memberry-lab/runs/ret010-development.staging'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(resolve(ROOT, 'node_modules/.cache/memberry-lab/runs/ret010-development.finalizer-staging'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns only fixed CLI failure when success-bundle verification requires cleanup and tombstoning', async () => {
    const runs = resolve(ROOT, 'node_modules/.cache/memberry-lab/runs');
    const output = resolve(runs, 'ret010-development');
    await rm(output, { recursive: true, force: true }); await mkdir(output, { recursive: true });
    await writeFile(join(output, 'aggregate-result.json'), 'HOSTILE-SUCCESS-SECRET');
    for (const stage of ['ret010-development.staging', 'ret010-development.finalizer-staging']) {
      const path = resolve(runs, stage); await rm(path, { recursive: true, force: true }); await mkdir(path); await writeFile(join(path, 'STALE'), 'HOSTILE-STAGE-SECRET');
    }
    const gate = resolve(import.meta.dirname, '..', 'dev-gate.ts');
    const child = spawnSync(process.execPath, ['--import', 'tsx', gate, 'finalize', 'success'], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '1' },
    });
    expect(child.status).not.toBe(0); expect(child.stdout).toBe(''); expect(child.stderr).toBe('RET010_DEV_GATE_FAILED\n');
    expect(`${child.stdout}${child.stderr}`).not.toMatch(/HOSTILE|SECRET/);
    const tombstone = JSON.parse(await readFile(join(output, 'failure-tombstone.json'), 'utf8'));
    expect(tombstone).toMatchObject({ decision: 'failed', workflowRunId: '77', workflowRunAttempt: 1 });
    await expect(lstat(resolve(runs, 'ret010-development.staging'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(resolve(runs, 'ret010-development.finalizer-staging'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the executable boundary value-free and the public success surface closed', async () => {
    const source = await readFile(resolve(import.meta.dirname, '..', 'dev-gate.ts'), 'utf8');
    expect(source).toContain("const SAFE_FAILURE = 'RET010_DEV_GATE_FAILED\\n'");
    expect(source).not.toMatch(/console\.(?:log|error|warn)/);
    expect(source).toContain("'failure-tombstone.json'");
    expect(source).toContain("'recall-lane.json', 'precision-lane.json', 'efficiency-interval.json'");
    expect(source).toContain("import('./load-dev.js')");
    expect(source).not.toMatch(/^import .*load-dev/m);
    expect(source).toContain('assertDevelopmentBindingSource(head)');
    expect(source).toContain('assertExperimentRegistry(head)');
    expect(source).toContain('workflowConclusion');
    expect(source).toContain("args.length === 3");
  });

  it('pins all twelve mutable paths and six immutable dependencies before publication', async () => {
    const source = await readFile(resolve(import.meta.dirname, '..', 'dev-gate.ts'), 'utf8');
    for (const path of [
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
      'bench/lab/stats.ts',
      'bench/lab/baselines/canonical.ts',
      'bench/lab/datasets/hash.ts',
      'packages/retrieval/src/served-reranker.ts',
      'packages/retrieval/src/reranker.ts',
      'packages/retrieval/src/assembler.ts',
    ]) expect(source).toContain(`'${path}'`);
    expect(source.match(/assertSourceIntegrity\(/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('accepts only the closed five-file success bundle and joined digests', async () => {
    const valid = await successBundle('20');
    await expect(validateSuccessBundleForTest(valid)).resolves.toBeUndefined();
    await writeFile(join(valid, 'extra.json'), '{}\n');
    await expect(validateSuccessBundleForTest(valid)).rejects.toThrow('artifact');
    const missing = await successBundle('20');
    await rm(join(missing, 'precision-lane.json'));
    await expect(validateSuccessBundleForTest(missing)).rejects.toThrow('artifact');
    const contradiction = await successBundle('20');
    const manifestPath = join(contradiction, 'custody-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.recallLaneSha256 = '0'.repeat(64);
    await writeFile(manifestPath, bytes(manifest));
    await expect(validateSuccessBundleForTest(contradiction)).rejects.toThrow('artifact');
  });

  it('rejects duplicate Node majors, mixed aggregates, and cross-run bundle pairs', async () => {
    await expect(validateBundlePairForTest(await successBundle('20'), await successBundle('20'))).rejects.toThrow('artifact');
    await expect(validateBundlePairForTest(await successBundle('20'), await successBundle('22', { runId: '88' }))).rejects.toThrow('artifact');
    await expect(validateBundlePairForTest(await successBundle('20'), await successBundle('22', { aggregateMarker: 'different' }))).rejects.toThrow('artifact');
    await expect(validateBundlePairForTest(await successBundle('20'), await successBundle('22'))).resolves.toBeUndefined();
  });

  it('rejects malformed workflow, job, and artifact metadata', () => {
    const valid = {
      schemaVersion: '1', repository: 'AP3X-Dev/memberry', headSha: 'a'.repeat(40), runId: '77', runAttempt: 1,
      workflowConclusion: 'success', jobs: [
        { nodeMajor: '20', conclusion: 'success', artifactName: 'memberry-ret010-development-node-20-77-1' },
        { nodeMajor: '22', conclusion: 'success', artifactName: 'memberry-ret010-development-node-22-77-1' },
      ],
    };
    expect(() => validateHostedMetadataForTest(valid)).not.toThrow();
    for (const mutate of [
      (value: any) => { value.workflowConclusion = 'failure'; },
      (value: any) => { value.jobs[1].nodeMajor = '20'; },
      (value: any) => { value.jobs[0].conclusion = 'cancelled'; },
      (value: any) => { value.jobs[0].artifactName = 7; },
      (value: any) => { value.extra = true; },
    ]) {
      const hostile = structuredClone(valid); mutate(hostile);
      expect(() => validateHostedMetadataForTest(hostile)).toThrow('artifact');
    }
  });

  it('accepts only the closed tombstone and keeps CLI failures value-free', () => {
    const tombstone = {
      schemaVersion: '1', decision: 'failed', failureClass: 'custody', stage: 'artifact',
      gitCommit: 'a'.repeat(40), nodeMajor: '20', nodeVersion: 'v20.19.0', workflowRunId: '77', workflowRunAttempt: 1,
    };
    expect(() => validateFailureTombstoneForTest(tombstone)).not.toThrow();
    expect(() => validateFailureTombstoneForTest({ ...tombstone, callerSentinel: 'SECRET-SENTINEL' })).toThrow('artifact');
    const gate = resolve(import.meta.dirname, '..', 'dev-gate.ts');
    const child = spawnSync(process.execPath, ['--import', 'tsx', gate, 'SECRET-SENTINEL'], { encoding: 'utf8' });
    expect(child.status).not.toBe(0);
    expect(child.stdout).toBe('');
    expect(child.stderr).toBe('RET010_DEV_GATE_FAILED\n');
    expect(child.stderr).not.toContain('SECRET-SENTINEL');
    expect(bytes(tombstone).toString('utf8')).not.toContain('SECRET-SENTINEL');
  });

  it('runs the real three-argument verifier CLI on canonical Node 20/22 custody and hostile bytes', async () => {
    const previousRunId = process.env.GITHUB_RUN_ID; const previousAttempt = process.env.GITHUB_RUN_ATTEMPT;
    process.env.GITHUB_RUN_ID = '77'; process.env.GITHUB_RUN_ATTEMPT = '1';
    const output = resolve(ROOT, 'node_modules/.cache/memberry-lab/runs/ret010-development');
    try {
      await expect(runDevelopment({ suppressProcessFailure: true })).resolves.toBe('passed');
      const node20 = await mkdtemp(join(tmpdir(), 'ret010e-cli-node20-'));
      const node22 = await mkdtemp(join(tmpdir(), 'ret010e-cli-node22-'));
      roots.push(node20, node22);
      await cp(output, node20, { recursive: true }); await cp(output, node22, { recursive: true });
      for (const [root, nodeMajor, nodeVersion] of [[node20, '20', 'v20.19.0'], [node22, '22', 'v22.12.0']] as const) {
        const path = join(root, 'custody-manifest.json'); const manifest = JSON.parse(await readFile(path, 'utf8'));
        manifest.nodeMajor = nodeMajor; manifest.nodeVersion = nodeVersion; await writeFile(path, bytes(manifest));
      }
      const metadataPath = join(await mkdtemp(join(tmpdir(), 'ret010e-cli-metadata-')), 'metadata.json');
      roots.push(resolve(metadataPath, '..'));
      const head = JSON.parse(await readFile(join(node20, 'aggregate-result.json'), 'utf8')).sourceCommit;
      const metadata = {
        schemaVersion: '1', repository: 'AP3X-Dev/memberry', headSha: head, runId: '77', runAttempt: 1,
        workflowConclusion: 'success', jobs: [
          { nodeMajor: '20', conclusion: 'success', artifactName: 'memberry-ret010-development-node-20-77-1' },
          { nodeMajor: '22', conclusion: 'success', artifactName: 'memberry-ret010-development-node-22-77-1' },
        ],
      };
      await writeFile(metadataPath, bytes(metadata));
      const gate = resolve(import.meta.dirname, '..', 'dev-gate.ts');
      const valid = spawnSync(process.execPath, ['--import', 'tsx', gate, 'verify', node20, node22, metadataPath], { cwd: ROOT, encoding: 'utf8' });
      expect(valid.status).toBe(0); expect(valid.stderr).toBe('');
      expect(`${JSON.stringify(JSON.parse(valid.stdout))}\n`).toBe(valid.stdout);
      const aggregate20Path = join(node20, 'aggregate-result.json'); const aggregate22Path = join(node22, 'aggregate-result.json');
      const manifest20Path = join(node20, 'custody-manifest.json'); const manifest22Path = join(node22, 'custody-manifest.json');
      const baseline = await Promise.all([aggregate20Path, aggregate22Path, manifest20Path, manifest22Path].map((path) => readFile(path)));
      const hostiles = [
        async () => { await writeFile(metadataPath, bytes({ ...metadata, hostileSecret: 'VERIFY-SECRET' })); },
        async () => { await writeFile(metadataPath, bytes({ ...metadata, runId: '88' })); },
        async () => {
          for (const [aggregatePath, manifestPath] of [[aggregate20Path, manifest20Path], [aggregate22Path, manifest22Path]]) {
            const aggregate = JSON.parse(await readFile(aggregatePath, 'utf8')); aggregate.devPolicySha256 = '0'.repeat(64);
            const aggregateBytes = bytes(aggregate); await writeFile(aggregatePath, aggregateBytes);
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); manifest.aggregateResultSha256 = digest(aggregateBytes);
            await writeFile(manifestPath, bytes(manifest));
          }
        },
      ];
      for (const mutate of hostiles) {
        await writeFile(metadataPath, bytes(metadata));
        await Promise.all([aggregate20Path, aggregate22Path, manifest20Path, manifest22Path].map((path, index) => writeFile(path, baseline[index]!)));
        await mutate();
        const hostile = spawnSync(process.execPath, ['--import', 'tsx', gate, 'verify', node20, node22, metadataPath], { cwd: ROOT, encoding: 'utf8' });
        expect(hostile.status).not.toBe(0); expect(hostile.stdout).toBe('');
        expect(hostile.stderr).toBe('RET010_DEV_GATE_FAILED\n');
        expect(`${hostile.stdout}${hostile.stderr}`).not.toContain('VERIFY-SECRET');
      }
    } finally {
      if (previousRunId === undefined) delete process.env.GITHUB_RUN_ID; else process.env.GITHUB_RUN_ID = previousRunId;
      if (previousAttempt === undefined) delete process.env.GITHUB_RUN_ATTEMPT; else process.env.GITHUB_RUN_ATTEMPT = previousAttempt;
    }
  });

  it('keeps every executable failure stage value-free across console and artifact bytes', async () => {
    const stages = [
      ['custody', 'source-integrity'], ['custody', 'registry'], ['harness', 'load-dev'],
      ['model', 'recall-comparison'], ['model', 'precision-comparison'], ['metric', 'efficiency'],
      ['metric', 'quality-policy'], ['safety', 'safety-policy'], ['metric', 'response-effect'], ['custody', 'artifact'],
    ] as const;
    const previousRunId = process.env.GITHUB_RUN_ID;
    const previousAttempt = process.env.GITHUB_RUN_ATTEMPT;
    process.env.GITHUB_RUN_ID = '77';
    process.env.GITHUB_RUN_ATTEMPT = '1';
    const output = resolve(ROOT, 'node_modules/.cache/memberry-lab/runs/ret010-development');
    for (const [failureClass, stage] of stages) {
      const sentinel = `UNIQUE-${failureClass}-${stage}-SECRET`;
      let captured: { failureClass: string; stage: string } | undefined;
      let suppressed = '';
      const outcome = await runDevelopment({
        beforeStage: async (current) => {
          if (current.stage === stage) {
            process.stdout.write(sentinel); process.stderr.write(sentinel);
            throw new Error(sentinel);
          }
        },
        onFailure: async (current) => { captured = current; }, suppressProcessFailure: true,
        onSuppressedOutput: async (stdout, stderr) => { suppressed = `${stdout}${stderr}`; },
      });
      expect(outcome).toBe('failed');
      expect(captured).toEqual({ failureClass, stage });
      const artifact = await readFile(join(output, 'failure-tombstone.json'));
      expect(artifact.toString('utf8')).toMatch(/^\{"schemaVersion":"1","decision":"failed"/);
      expect(artifact.toString('utf8')).not.toContain(sentinel);
      expect(suppressed).toBe(`${sentinel}${sentinel}`);
    }
    for (const operation of ['dataset', 'provider', 'blobs', 'aggregate', 'publication'] as const) {
      const sentinel = `UNIQUE-artifact-${operation}-SECRET`; let captured: any;
      const outcome = await runDevelopment({
        beforeOperation: async (observed, context) => {
          if (observed === operation) { process.stdout.write(sentinel); process.stderr.write(sentinel); throw new Error('custody'); }
          captured = context;
        },
        onFailure: async (context) => { captured = context; }, suppressProcessFailure: true,
      });
      expect(outcome).toBe('failed'); expect(captured).toEqual({ failureClass: 'custody', stage: 'artifact' });
      const artifact = await readFile(join(output, 'failure-tombstone.json'), 'utf8');
      expect(artifact).not.toContain(sentinel);
    }
    if (previousRunId === undefined) delete process.env.GITHUB_RUN_ID; else process.env.GITHUB_RUN_ID = previousRunId;
    if (previousAttempt === undefined) delete process.env.GITHUB_RUN_ATTEMPT; else process.env.GITHUB_RUN_ATTEMPT = previousAttempt;
    const gate = resolve(import.meta.dirname, '..', 'dev-gate.ts');
    for (const args of [
      ['verify', 'SECRET-A'],
      ['verify', 'SECRET-A', 'SECRET-B'],
      ['verify', 'SECRET-A', 'SECRET-B', 'SECRET-C', 'SECRET-D'],
    ]) {
      const child = spawnSync(process.execPath, ['--import', 'tsx', gate, ...args], { encoding: 'utf8' });
      expect(child.status).not.toBe(0);
      expect(child.stdout).toBe('');
      expect(child.stderr).toBe('RET010_DEV_GATE_FAILED\n');
      expect(`${child.stdout}${child.stderr}`).not.toContain('SECRET-');
    }
  });
});
