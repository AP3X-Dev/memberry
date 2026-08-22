import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  clearHoldoutOutputForTest,
  evaluateHoldoutForTest,
  publishHoldoutReceiptForTest,
  runHoldoutQualificationForTest,
  validateApprovalRecordForTest,
  validateApprovalLineageForTest,
  validateHoldoutComparisonForTest,
  validateHoldoutIntervalForTest,
  validateHoldoutPublicRecordForTest,
  validateHoldoutScenariosForTest,
  validateRuntimeIdentityForTest,
  validateSourceAndLineageForTest,
} from '../holdout-gate.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');

function git(root: string, ...args: string[]): string {
  const child = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (child.status !== 0) throw new Error(child.stderr);
  return child.stdout.trim();
}

async function lineageRepository(preexistingApproval = false): Promise<{ root: string; base: string; head: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ret010-holdout-git-'));
  for (const path of [
    'bench/lab/ret010/holdout-gate.mts', 'bench/lab/datasets/load-suite.ts',
    'bench/lab/registered-adapters.ts', 'bench/lab/stats.ts',
  ]) {
    await mkdir(resolve(root, path, '..'), { recursive: true });
    const source = path.endsWith('holdout-gate.mts')
      ? "void import('../datasets/load-suite.js'); void import('../registered-adapters.js'); void import('../stats.js');\n"
      : 'export {};\n';
    await writeFile(resolve(root, path), source);
  }
  if (preexistingApproval) {
    await mkdir(resolve(root, 'bench/lab/ret010'), { recursive: true });
    await writeFile(resolve(root, 'bench/lab/ret010/approved-dev.json'), '{}\n');
  }
  git(root, 'init', '-q'); git(root, 'config', 'user.email', 'ret010@example.invalid'); git(root, 'config', 'user.name', 'RET010 Fixture');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'base'); const base = git(root, 'rev-parse', 'HEAD');
  await mkdir(resolve(root, 'bench/lab/ret010'), { recursive: true });
  await writeFile(resolve(root, 'bench/lab/ret010/approved-dev.json'), preexistingApproval ? '{"changed":true}\n' : '{}\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'approval');
  return { root, base, head: git(root, 'rev-parse', 'HEAD') };
}

describe('RET-010 one-shot holdout boundary', () => {
  it('keeps holdout imports behind exact qualification and approval validation', async () => {
    const source = await readFile(resolve(ROOT, 'bench/lab/ret010/holdout-gate.mts'), 'utf8');
    const identity = source.indexOf('identity = await dependencies.acquireIdentity()');
    const lineage = source.indexOf('await dependencies.validateSourceAndLineage(identity)');
    const approval = source.indexOf('await dependencies.validateApproval(lineage, identity)');
    const evaluation = source.indexOf('await dependencies.evaluate(approval, identity)');
    expect(identity).toBeGreaterThan(0);
    expect(identity).toBeLessThan(lineage);
    expect(lineage).toBeLessThan(approval);
    expect(approval).toBeLessThan(evaluation);
    expect(source).not.toMatch(/^import .*load-suite/m);
    expect(source).not.toMatch(/^import .*registered-adapters/m);
    expect(source).toContain("changed.length !== 1 || changed[0] !== `A\\t${APPROVAL_PATH}`");
    expect(source).toContain("requestedSha !== head");
    expect(source).toContain("sha256(approvalBytes) !== requestedDigest");
    expect(source).toContain("status', '--porcelain=v1', '--untracked-files=all'");
    expect(source).toContain('parents.length !== 2');
    expect(source).toContain('lineage.directParent !== approval.devSourceCommit');
    expect(source).toContain('assertResolvedImportGraph(commit)');
    expect(source).toContain("for (const shadow of [jsPath");
  });

  it('executes real Git source and add-only lineage custody against hostile repositories', async () => {
    const valid = await lineageRepository();
    await expect(validateSourceAndLineageForTest(valid.root, valid.head)).resolves.toEqual({ head: valid.head, directParent: valid.base });
    await expect(validateSourceAndLineageForTest(valid.root, valid.head, valid.base)).rejects.toThrow('custody');
    await writeFile(resolve(valid.root, 'bench/lab/stats.ts'), 'export const dirty = true;\n');
    await expect(validateSourceAndLineageForTest(valid.root, valid.head)).rejects.toThrow('custody');
    git(valid.root, 'checkout', '--', 'bench/lab/stats.ts');
    await writeFile(resolve(valid.root, 'bench/lab/datasets/load-suite.js'), 'process.stdout.write("SHADOW-SECRET");\n');
    await expect(validateSourceAndLineageForTest(valid.root, valid.head)).rejects.toThrow('custody');
    await rm(valid.root, { recursive: true, force: true });

    const trackedShadow = await lineageRepository();
    await writeFile(resolve(trackedShadow.root, 'bench/lab/datasets/load-suite.js'), 'export {};\n'); git(trackedShadow.root, 'add', '.'); git(trackedShadow.root, 'commit', '--amend', '-qm', 'approval with shadow');
    trackedShadow.head = git(trackedShadow.root, 'rev-parse', 'HEAD');
    await expect(validateSourceAndLineageForTest(trackedShadow.root, trackedShadow.head)).rejects.toThrow('custody');
    await rm(trackedShadow.root, { recursive: true, force: true });

    const extra = await lineageRepository();
    await writeFile(resolve(extra.root, 'extra.txt'), 'extra\n'); git(extra.root, 'add', '.'); git(extra.root, 'commit', '--amend', '-qm', 'approval plus extra');
    extra.head = git(extra.root, 'rev-parse', 'HEAD');
    await expect(validateSourceAndLineageForTest(extra.root, extra.head)).rejects.toThrow('custody');
    await rm(extra.root, { recursive: true, force: true });

    const preexisting = await lineageRepository(true);
    await expect(validateSourceAndLineageForTest(preexisting.root, preexisting.head)).rejects.toThrow('custody');
    await rm(preexisting.root, { recursive: true, force: true });

    const renamed = await lineageRepository(); git(renamed.root, 'reset', '--hard', renamed.base);
    await writeFile(resolve(renamed.root, 'bench/lab/ret010/old-approval.json'), '{}\n'); git(renamed.root, 'add', '.'); git(renamed.root, 'commit', '-qm', 'old approval');
    git(renamed.root, 'mv', 'bench/lab/ret010/old-approval.json', 'bench/lab/ret010/approved-dev.json'); git(renamed.root, 'commit', '-qm', 'rename approval');
    renamed.head = git(renamed.root, 'rev-parse', 'HEAD');
    await expect(validateSourceAndLineageForTest(renamed.root, renamed.head)).rejects.toThrow('custody');
    await rm(renamed.root, { recursive: true, force: true });

    const merge = await lineageRepository();
    const mainBranch = git(merge.root, 'branch', '--show-current');
    git(merge.root, 'checkout', '-qb', 'side', merge.base); await writeFile(resolve(merge.root, 'side.txt'), 'side\n');
    git(merge.root, 'add', '.'); git(merge.root, 'commit', '-qm', 'side'); git(merge.root, 'checkout', '-q', mainBranch);
    git(merge.root, 'merge', '--no-ff', '-qm', 'merge', 'side'); merge.head = git(merge.root, 'rev-parse', 'HEAD');
    await expect(validateSourceAndLineageForTest(merge.root, merge.head)).rejects.toThrow('custody');
    await rm(merge.root, { recursive: true, force: true });
  });

  it('rejects malformed closed approval evidence and cross-run artifact names', () => {
    const approval = {
      schemaVersion: '1', decision: 'approved', devSourceCommit: 'a'.repeat(40),
      modelBlob: 'b'.repeat(40), providerContractBlob: 'c'.repeat(40), adapterBlob: 'd'.repeat(40),
      aggregateResultSha256: '1'.repeat(64), node20ManifestSha256: '2'.repeat(64), node22ManifestSha256: '3'.repeat(64),
      node20Version: 'v20.19.0', node22Version: 'v22.12.0', workflowRunId: '77', workflowRunAttempt: 1,
      datasetDescriptorSha256: '4'.repeat(64), inputSha256: '5'.repeat(64), oracleSha256: '6'.repeat(64),
      devPolicySha256: '7'.repeat(64), seed: 42, repository: 'AP3X-Dev/memberry', workflowConclusion: 'success',
      node20JobConclusion: 'success', node22JobConclusion: 'success',
      node20ArtifactName: 'memberry-ret010-development-node-20-77-1',
      node22ArtifactName: 'memberry-ret010-development-node-22-77-1',
    };
    const canonical = Buffer.from(`${JSON.stringify(approval)}\n`);
    expect(() => validateApprovalRecordForTest(canonical)).not.toThrow();
    const approvalDigest = createHash('sha256').update(canonical).digest('hex');
    expect(() => validateApprovalLineageForTest({ head: 'f'.repeat(40), directParent: approval.devSourceCommit }, canonical, approvalDigest)).not.toThrow();
    expect(() => validateApprovalLineageForTest({ head: 'f'.repeat(40), directParent: 'f'.repeat(40) }, canonical, approvalDigest)).toThrow('custody');
    expect(() => validateApprovalLineageForTest({ head: 'f'.repeat(40), directParent: approval.devSourceCommit }, canonical, '0'.repeat(64))).toThrow('custody');
    for (const hostile of [
      { ...approval, extra: true },
      { ...approval, node20ArtifactName: 'memberry-ret010-development-node-20-88-1' },
      { ...approval, workflowConclusion: 'failure' },
      { ...approval, seed: -1 },
    ]) expect(() => validateApprovalRecordForTest(Buffer.from(`${JSON.stringify(hostile)}\n`))).toThrow('custody');
    for (const workflowRunId of [77, '0', '00', '01', '+1', '1.0']) {
      expect(() => validateApprovalRecordForTest(Buffer.from(`${JSON.stringify({ ...approval, workflowRunId })}\n`))).toThrow('custody');
    }
    expect(() => validateApprovalRecordForTest(Buffer.from(` ${JSON.stringify(approval)}\n`))).toThrow('custody');
  });

  it('enforces exact lane counts, finite zero-safety reports, and frozen interval identity', () => {
    const scenarios = (dimension: 'recall' | 'precision', k: 10 | 5) => Array.from({ length: 10 }, (_, index) => ({
      input: { id: `${dimension}-${index}`, split: 'holdout', dimensions: [dimension], queries: [{ id: `${dimension}-probe-${index}`, limit: k }] },
      oracle: { probes: [{ probeId: `${dimension}-probe-${index}` }] },
    }));
    expect(() => validateHoldoutScenariosForTest(scenarios('recall', 10), 'recall', 10)).not.toThrow();
    expect(() => validateHoldoutScenariosForTest(scenarios('recall', 10).slice(1), 'recall', 10)).toThrow('metric');
    expect(() => validateHoldoutScenariosForTest(scenarios('precision', 5), 'precision', 10)).toThrow('metric');

    const metrics = {
      recallAtK: 1, precisionAtK: 1, reciprocalRank: 1, ndcgAtK: 1, answerCoverage: 1,
      staleLeakRate: 0, isolationLeakRate: 0, duplicateRate: 0, unknownResultRate: 0,
      staleSafety: 1, isolationSafety: 1,
    };
    const arm = (adapterId: string) => ({
      adapterId, outcome: 'scored', metrics,
      scenarioReports: Array.from({ length: 10 }, (_, index) => ({
        outcome: 'scored', metrics, probes: [{ resultIds: [`id-${index}`], contextTokens: 1, metrics }],
      })),
    });
    const report = { runId: 'lane', evidenceMode: 'registered-ci', passed: true,
      control: arm('memberry-retrieval-core-disabled-v1'), candidate: arm('memberry-retrieval-core-served-v1') };
    expect(() => validateHoldoutComparisonForTest(report, 'lane')).not.toThrow();
    const nonfinite = structuredClone(report); nonfinite.candidate.scenarioReports[0].probes[0].metrics.recallAtK = Number.NaN;
    expect(() => validateHoldoutComparisonForTest(nonfinite, 'lane')).toThrow('metric');
    const leaking = structuredClone(report); leaking.candidate.scenarioReports[0].probes[0].metrics.staleLeakRate = 0.1;
    expect(() => validateHoldoutComparisonForTest(leaking, 'lane')).toThrow('metric');
    const hostileScenarioAggregate = structuredClone(report); hostileScenarioAggregate.candidate.scenarioReports[0].metrics.recallAtK = 0;
    expect(() => validateHoldoutComparisonForTest(hostileScenarioAggregate, 'lane')).toThrow('metric');
    const hostileArmAggregate = structuredClone(report); hostileArmAggregate.candidate.metrics.precisionAtK = 0;
    expect(() => validateHoldoutComparisonForTest(hostileArmAggregate, 'lane')).toThrow('metric');
    const pairs = Array.from({ length: 20 }, (_, index) => ({ scenarioId: `s${index}`, probeId: `p${index}` }));
    const interval = { outcome: 'measured', pairedProbes: 20, resamples: 2000, level: 0.95, seed: 42, point: 0, lower: 0, upper: 0, oneSidedLower: 0 };
    expect(() => validateHoldoutIntervalForTest(pairs, interval, 42)).not.toThrow();
    expect(() => validateHoldoutIntervalForTest(pairs, { ...interval, seed: 43 }, 42)).toThrow('metric');
    expect(() => validateHoldoutIntervalForTest(pairs.slice(1), interval, 42)).toThrow('metric');
  });

  it('drives hostile loader, comparator, aggregate, and interval inputs through the real evaluator', async () => {
    const identity = { gitCommit: 'a'.repeat(40), nodeMajor: '20' as const, nodeVersion: 'v20.19.0', workflowRunId: '77', workflowRunAttempt: 1 };
    const approval = {
      schemaVersion: '1' as const, decision: 'approved' as const, devSourceCommit: 'b'.repeat(40), modelBlob: 'c'.repeat(40),
      providerContractBlob: 'd'.repeat(40), adapterBlob: 'e'.repeat(40), aggregateResultSha256: '1'.repeat(64),
      node20ManifestSha256: '2'.repeat(64), node22ManifestSha256: '3'.repeat(64), node20Version: 'v20.19.0', node22Version: 'v22.12.0',
      workflowRunId: '76', workflowRunAttempt: 1, repository: 'AP3X-Dev/memberry' as const, workflowConclusion: 'success' as const,
      node20JobConclusion: 'success' as const, node22JobConclusion: 'success' as const,
      node20ArtifactName: 'memberry-ret010-development-node-20-76-1', node22ArtifactName: 'memberry-ret010-development-node-22-76-1',
      datasetDescriptorSha256: '4'.repeat(64), inputSha256: '5'.repeat(64), oracleSha256: '6'.repeat(64), devPolicySha256: '7'.repeat(64), seed: 42,
    };
    const policy = {
      schemaVersion: 1, controlAdapterId: 'memberry-retrieval-core-disabled-v1', candidateAdapterId: 'memberry-retrieval-core-served-v1',
      dataset: { id: 'memberry-g2-holdout-holdout', split: 'holdout' },
      lanes: { recall: { dimension: 'recall', probes: 10, k: 10, minimumDelta: 0 }, precision: { dimension: 'precision', probes: 10, k: 5, minimumDelta: 0 } },
      safety: { maxStaleLeakRate: 0, maxIsolationLeakRate: 0, maxDuplicateRate: 0, maxUnknownResultRate: 0 },
      pairedVectorOrder: ['recall', 'precision'], withinLaneSortKeys: ['scenarioId', 'probeId'],
      efficiency: { outcome: 'measured', method: 'paired-bootstrap', confidenceLevel: 0.95, minimumPointDeltaInclusive: 0, minimumOneSided95LowerBound: 0, resamples: 2000, minimumPairedProbes: 10, seedRule: 'vector-derived' },
    };
    const scenarios = (dimension: 'recall' | 'precision') => Array.from({ length: 10 }, (_, index) => ({
      input: { id: `${dimension}-${index}`, split: 'holdout', dimensions: [dimension], queries: [{ id: `${dimension}-p${index}`, limit: dimension === 'recall' ? 10 : 5 }] },
      oracle: { probes: [{ probeId: `${dimension}-p${index}` }] },
    }));
    const metrics = { recallAtK: 1, precisionAtK: 1, reciprocalRank: 1, ndcgAtK: 1, answerCoverage: 1, staleLeakRate: 0, isolationLeakRate: 0, duplicateRate: 0, unknownResultRate: 0, staleSafety: 1, isolationSafety: 1 };
    const report = (runId: string) => ({
      runId, evidenceMode: 'registered-ci', passed: true,
      control: { adapterId: 'memberry-retrieval-core-disabled-v1', outcome: 'scored', metrics, scenarioReports: Array.from({ length: 10 }, (_, i) => ({ scenarioId: `${runId}-${i}`, outcome: 'scored', metrics, probes: [{ probeId: `p${i}`, resultIds: [`a${i}`], contextTokens: 1, metrics }] })) },
      candidate: { adapterId: 'memberry-retrieval-core-served-v1', outcome: 'scored', metrics, scenarioReports: Array.from({ length: 10 }, (_, i) => ({ scenarioId: `${runId}-${i}`, outcome: 'scored', metrics, probes: [{ probeId: `p${i}`, resultIds: [`b${i}`], contextTokens: 1, metrics }] })) },
    });
    const dependencies = {
      verifySource: async () => {}, loadScenarios: async (dimension: 'recall' | 'precision') => scenarios(dimension),
      compare: async (options: any) => report(options.runId), readPolicy: async () => policy,
      pairedVectorSeed: () => 42,
      pairedEfficiencyInterval: () => ({ outcome: 'measured', pairedProbes: 20, resamples: 2000, level: 0.95, seed: 42, point: 0, lower: 0, upper: 0, oneSidedLower: 0 }),
    };
    await expect(evaluateHoldoutForTest(approval, identity, dependencies)).resolves.toMatchObject({ decision: 'passed', qualificationSha: identity.gitCommit });
    await expect(evaluateHoldoutForTest(approval, identity, { ...dependencies, loadScenarios: async (dimension) => scenarios(dimension).slice(1) })).rejects.toThrow('metric');
    await expect(evaluateHoldoutForTest(approval, identity, { ...dependencies, compare: async (options) => {
      const hostile = report(options.runId); hostile.candidate.metrics.recallAtK = 0; return hostile;
    } })).rejects.toThrow('metric');
    await expect(evaluateHoldoutForTest(approval, identity, { ...dependencies, pairedVectorSeed: () => 43 })).rejects.toThrow('metric');
  });

  it('publishes exclusively without following symlinks or race substitutions', async () => {
    const failure = (stage: 'source-integrity' | 'approval' | 'evaluation' | 'publication') => ({
      schemaVersion: '1', decision: 'failed', failureClass: 'qualification', stage,
      gitCommit: 'a'.repeat(40), nodeMajor: '20', nodeVersion: 'v20.19.0', workflowRunId: '77', workflowRunAttempt: 1,
    });
    expect(() => validateHoldoutPublicRecordForTest(failure('publication'))).not.toThrow();
    expect(() => validateHoldoutPublicRecordForTest({ ...failure('publication'), leaked: 'SECRET' })).toThrow('artifact');
    const root = await mkdtemp(join(tmpdir(), 'ret010-holdout-publish-'));
    const parent = join(root, 'artifact'); await mkdir(parent);
    const output = join(parent, 'receipt.json');
    await expect(publishHoldoutReceiptForTest(root, output, failure('publication'))).resolves.toBeUndefined();
    expect(await readFile(output, 'utf8')).toContain('"failureClass":"qualification"');
    await expect(publishHoldoutReceiptForTest(root, output, failure('evaluation'))).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(failure('evaluation'));
    await rm(root, { recursive: true, force: true });

    for (const stage of ['after-open', 'before-rename'] as const) {
      const raceRoot = await mkdtemp(join(tmpdir(), `ret010-holdout-${stage}-`));
      const raceParent = join(raceRoot, 'artifact'); await mkdir(raceParent);
      const foreign = join(raceRoot, 'foreign.txt'); await writeFile(foreign, 'FOREIGN-SENTINEL');
      const raceOutput = join(raceParent, 'receipt.json');
      await expect(publishHoldoutReceiptForTest(raceRoot, raceOutput, failure('publication'), async (observed, staging) => {
        if (observed !== stage) return;
        await unlink(staging);
        if (stage === 'after-open') await symlink(foreign, staging, 'file');
        else await mkdir(staging);
      })).rejects.toThrow('custody');
      await expect(readFile(raceOutput)).rejects.toThrow();
      await expect(readFile(`${raceOutput}.staging`)).rejects.toThrow();
      expect(await readFile(foreign, 'utf8')).toBe('FOREIGN-SENTINEL');
      await rm(raceRoot, { recursive: true, force: true });
    }
  });

  it('rejects noncanonical runtime identities without coercion', () => {
    const identity = {
      gitCommit: 'a'.repeat(40), nodeMajor: '20', nodeVersion: 'v20.19.0',
      workflowRunId: '77', workflowRunAttempt: 1,
    };
    expect(() => validateRuntimeIdentityForTest(identity)).not.toThrow();
    for (const hostile of [
      { ...identity, workflowRunId: 77 }, { ...identity, workflowRunId: '077' },
      { ...identity, workflowRunId: '0' }, { ...identity, workflowRunAttempt: '1' },
      { ...identity, workflowRunAttempt: 0 }, { ...identity, nodeMajor: 20 },
      { ...identity, gitCommit: '0'.repeat(40) }, { ...identity, extra: true },
    ]) expect(() => validateRuntimeIdentityForTest(hostile)).toThrow('custody');
  });

  it('executes identity-first failure stages and replaces planted leaves with current tombstones', async () => {
    const identity = {
      gitCommit: 'a'.repeat(40), nodeMajor: '20' as const, nodeVersion: 'v20.19.0',
      workflowRunId: '77', workflowRunAttempt: 1,
    };
    const cases = [
      ['shadow-module', 'source-integrity'], ['lineage', 'source-integrity'], ['approval', 'approval'],
      ['receipt-workflow', 'approval'], ['metrics', 'evaluation'], ['interval-seed', 'evaluation'],
      ['symlink-race', 'evaluation'],
      ['publication', 'publication'],
    ] as const;
    for (const [failurePoint, expectedStage] of cases) {
      const root = await mkdtemp(join(tmpdir(), `ret010-holdout-stage-${failurePoint}-`));
      const parent = join(root, 'artifact'); await mkdir(parent);
      const output = join(parent, 'receipt.json');
      const foreign = join(root, 'foreign.txt'); await writeFile(foreign, 'FOREIGN-SENTINEL');
      await writeFile(output, 'STALE-SUCCESS-SECRET');
      let emitted = '';
      const sentinel = `HOLDOUT-${failurePoint}-SECRET`;
      let suppressed = '';
      const leakThenThrow = (): never => {
        process.stdout.write(sentinel); process.stderr.write(sentinel); throw new Error(failurePoint);
      };
      const outcome = await runHoldoutQualificationForTest({
        acquireIdentity: async () => identity,
        prepareOutput: async () => { await clearHoldoutOutputForTest(root, output); },
        validateSourceAndLineage: async () => {
          if (failurePoint === 'shadow-module' || failurePoint === 'lineage') leakThenThrow();
          return { head: identity.gitCommit, directParent: 'b'.repeat(40) };
        },
        validateApproval: async () => {
          if (failurePoint === 'approval' || failurePoint === 'receipt-workflow') leakThenThrow();
          return { approved: true };
        },
        evaluate: async () => {
          if (failurePoint === 'symlink-race') {
            await symlink(foreign, output, 'file');
            leakThenThrow();
          }
          if (failurePoint === 'metrics' || failurePoint === 'interval-seed') {
            await writeFile(output, 'DURING-EVALUATION-SECRET');
            leakThenThrow();
          }
          return { passed: true };
        },
        publishSuccess: async () => { leakThenThrow(); },
        publishFailure: async (value) => { await publishHoldoutReceiptForTest(root, output, value); },
        clearOutput: async () => { await clearHoldoutOutputForTest(root, output); },
        emitFailure: () => { emitted += 'RET010_HOLDOUT_GATE_FAILED\n'; },
        onSuppressedOutput: async (stdout, stderr) => { suppressed = `${stdout}${stderr}`; },
      });
      expect(outcome).toBe('failed');
      expect(emitted).toBe('RET010_HOLDOUT_GATE_FAILED\n');
      expect(suppressed).toBe(`${sentinel}${sentinel}`);
      const published = JSON.parse(await readFile(output, 'utf8'));
      expect(published).toEqual({
        schemaVersion: '1', decision: 'failed', failureClass: 'qualification', stage: expectedStage,
        gitCommit: identity.gitCommit, nodeMajor: identity.nodeMajor, nodeVersion: identity.nodeVersion,
        workflowRunId: identity.workflowRunId, workflowRunAttempt: identity.workflowRunAttempt,
      });
      expect(JSON.stringify(published)).not.toMatch(/STALE|DURING|SECRET/);
      expect(await readFile(foreign, 'utf8')).toBe('FOREIGN-SENTINEL');
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs the injected success path in order and atomically supersedes a stale leaf', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ret010-holdout-success-'));
    const parent = join(root, 'artifact'); await mkdir(parent);
    const output = join(parent, 'receipt.json'); await writeFile(output, 'STALE-SUCCESS-SECRET');
    const identity = {
      gitCommit: 'a'.repeat(40), nodeMajor: '20' as const, nodeVersion: 'v20.19.0',
      workflowRunId: '77', workflowRunAttempt: 1,
    };
    const order: string[] = [];
    const lane = (name: 'recall-at-10' | 'precision-at-5') => ({
      lane: name, control: { recallAtK: 1, precisionAtK: 1 }, candidate: { recallAtK: 1, precisionAtK: 1 },
      delta: { recallAtK: 0, precisionAtK: 0 },
      safety: { staleLeakRate: 0, isolationLeakRate: 0, duplicateRate: 0, unknownResultRate: 0 },
    });
    const success = {
      schemaVersion: '1', decision: 'passed', qualificationSha: identity.gitCommit, approvalDigest: '1'.repeat(64),
      approvedDevelopment: {
        sourceCommit: 'b'.repeat(40), modelBlob: 'c'.repeat(40), providerContractBlob: 'd'.repeat(40), adapterBlob: 'e'.repeat(40),
        aggregateResultSha256: '2'.repeat(64), node20ManifestSha256: '3'.repeat(64), node22ManifestSha256: '4'.repeat(64),
        node20Version: 'v20.19.0', node22Version: 'v22.12.0', developmentWorkflowRunId: '76', developmentWorkflowRunAttempt: 1,
        repository: 'AP3X-Dev/memberry', workflowConclusion: 'success', node20JobConclusion: 'success', node22JobConclusion: 'success',
        node20ArtifactName: 'memberry-ret010-development-node-20-76-1', node22ArtifactName: 'memberry-ret010-development-node-22-76-1',
        datasetDescriptorSha256: '5'.repeat(64), inputSha256: '6'.repeat(64), oracleSha256: '7'.repeat(64),
        devPolicySha256: '8'.repeat(64), developmentSeed: 42,
      },
      recall: lane('recall-at-10'), precision: lane('precision-at-5'),
      efficiency: { pairedProbes: 20, resamples: 2000, level: 0.95, seed: 42, point: 0, lower: 0, upper: 0, oneSidedLower: 0 },
      custody: identity,
    };
    const outcome = await runHoldoutQualificationForTest({
      acquireIdentity: async () => { order.push('identity'); return identity; },
      prepareOutput: async () => { order.push('prepare'); await clearHoldoutOutputForTest(root, output); },
      validateSourceAndLineage: async () => { order.push('source-lineage'); return { head: identity.gitCommit, directParent: 'b'.repeat(40) }; },
      validateApproval: async () => { order.push('approval'); return {}; },
      evaluate: async () => { order.push('evaluation'); return success; },
      publishSuccess: async (value) => { order.push('publication'); await publishHoldoutReceiptForTest(root, output, value); },
      publishFailure: async () => { throw new Error('unexpected'); },
      clearOutput: async () => { await clearHoldoutOutputForTest(root, output); },
      emitFailure: () => { throw new Error('unexpected'); },
    });
    expect(outcome).toBe('passed');
    expect(order).toEqual(['identity', 'prepare', 'source-lineage', 'approval', 'evaluation', 'publication']);
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(success);
    expect(await readFile(output, 'utf8')).not.toContain('STALE-SUCCESS-SECRET');
    await rm(root, { recursive: true, force: true });
  });

  it('leaves no uploadable leaf when identity or publication custody is unprovable', async () => {
    const identity = {
      gitCommit: 'a'.repeat(40), nodeMajor: '20' as const, nodeVersion: 'v20.19.0',
      workflowRunId: '77', workflowRunAttempt: 1,
    };
    for (const failurePoint of ['identity', 'prepare', 'failure-race'] as const) {
      const root = await mkdtemp(join(tmpdir(), `ret010-holdout-absent-${failurePoint}-`));
      const parent = join(root, 'artifact'); await mkdir(parent);
      const output = join(parent, 'receipt.json');
      const foreign = join(root, 'foreign.txt'); await writeFile(foreign, 'FOREIGN-SENTINEL');
      await symlink(foreign, output, 'file');
      const outcome = await runHoldoutQualificationForTest({
        acquireIdentity: async () => {
          if (failurePoint === 'identity') throw new Error('identity');
          return identity;
        },
        prepareOutput: async () => {
          await clearHoldoutOutputForTest(root, output);
          if (failurePoint === 'prepare') throw new Error('prepare');
        },
        validateSourceAndLineage: async () => { throw new Error('shadow-module'); },
        validateApproval: async () => ({}), evaluate: async () => ({}), publishSuccess: async () => {},
        publishFailure: async (value) => {
          if (failurePoint !== 'failure-race') return publishHoldoutReceiptForTest(root, output, value);
          return publishHoldoutReceiptForTest(root, output, value, async (stage, staging) => {
            if (stage === 'before-rename') { await unlink(staging); await mkdir(staging); }
          });
        },
        clearOutput: async () => { await clearHoldoutOutputForTest(root, output); },
        emitFailure: () => {},
      });
      expect(outcome).toBe('failed');
      await expect(readFile(output)).rejects.toThrow();
      await expect(readFile(`${output}.staging`)).rejects.toThrow();
      expect(await readFile(foreign, 'utf8')).toBe('FOREIGN-SENTINEL');
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires the closed approval record and exact frozen model blobs', async () => {
    const source = await readFile(resolve(ROOT, 'bench/lab/ret010/holdout-gate.mts'), 'utf8');
    for (const key of [
      'devSourceCommit', 'modelBlob', 'providerContractBlob', 'adapterBlob',
      'aggregateResultSha256', 'node20ManifestSha256', 'node22ManifestSha256',
      'node20Version', 'node22Version', 'workflowRunId', 'workflowRunAttempt',
      'datasetDescriptorSha256', 'inputSha256', 'oracleSha256', 'devPolicySha256', 'seed',
    ]) expect(source).toContain(`'${key}'`);
    expect(source).toContain("gitBlob('packages/retrieval/src/served-reranker.ts') !== approval.modelBlob");
    expect(source).toContain("gitBlob('packages/retrieval/src/reranker.ts') !== approval.providerContractBlob");
    expect(source).toContain("gitBlob('bench/lab/adapters/memberry-retrieval-core.ts') !== approval.adapterBlob");
  });

  it('keeps the workflow manual, read-only, exact-SHA, and two-Node', async () => {
    const workflow = await readFile(resolve(ROOT, '.github/workflows/ret010-holdout-qualification.yml'), 'utf8');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(/^\s*(?:push|pull_request|schedule):/m);
    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('node-version: [20, 22]');
    expect(workflow).toContain('RET010_QUALIFICATION_SHA: ${{ inputs.qualification_sha }}');
    expect(workflow).toContain('RET010_APPROVAL_DIGEST: ${{ inputs.approval_digest }}');
  });

  it('publishes only an aggregate receipt or fixed value-free failure', async () => {
    const source = await readFile(resolve(ROOT, 'bench/lab/ret010/holdout-gate.mts'), 'utf8');
    expect(source).toContain("const SAFE_FAILURE = 'RET010_HOLDOUT_GATE_FAILED\\n'");
    expect(source).not.toMatch(/console\.(?:log|error|warn)/);
    const publicationStart = source.indexOf("schemaVersion: '1', decision: 'passed', qualificationSha: identity.gitCommit");
    const publication = source.slice(publicationStart, source.indexOf('custody: identity', publicationStart));
    expect(publicationStart).toBeGreaterThan(0);
    expect(publication).not.toContain('scenarioId');
    expect(publication).not.toContain('probeId');
    expect(source).toContain("decision: 'failed'");
    expect(source).toContain("decision: 'passed'");
    const runnerTemp = await mkdtemp(join(tmpdir(), 'ret010-holdout-cli-'));
    const artifact = join(runnerTemp, 'artifact'); await mkdir(artifact);
    const receipt = join(artifact, 'receipt.json');
    const gatePath = resolve(ROOT, 'bench/lab/ret010/holdout-gate.mts');
    const child = spawnSync(process.execPath, ['--import', 'tsx', gatePath], {
      cwd: ROOT, encoding: 'utf8', env: {
        ...process.env, GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '1', RUNNER_TEMP: runnerTemp,
        RET010_HOLDOUT_RECEIPT_PATH: receipt, RET010_QUALIFICATION_SHA: '0'.repeat(40),
        RET010_APPROVAL_DIGEST: 'CLI-SECRET',
      },
    });
    expect(child.status).not.toBe(0); expect(child.stdout).toBe('');
    expect(child.stderr).toBe('RET010_HOLDOUT_GATE_FAILED\n');
    expect(`${child.stdout}${child.stderr}${await readFile(receipt, 'utf8')}`).not.toContain('CLI-SECRET');
    await rm(runnerTemp, { recursive: true, force: true });
  });
});
