import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { LabGatePolicy } from '../../contracts/report.js';
import { loadRegisteredDatasetDescriptor } from '../../datasets/load-golden.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');

async function loadPolicy(): Promise<LabGatePolicy> {
  const policyFile = JSON.parse(await readFile(
    resolve(REPO_ROOT, 'bench/lab/baselines/lab-policy.json'), 'utf8',
  )) as { queryDecompositionDev: LabGatePolicy };
  return policyFile.queryDecompositionDev;
}

function isClosedDevReceipt(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  const rootKeys = [
    'outcome', 'split', 'metric', 'n', 'controlAdapterId', 'candidateAdapterId',
    'controlSuccessRate', 'candidateSuccessRate', 'delta', 'interval',
  ];
  if (JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify([...rootKeys].sort())) return false;
  if (receipt.outcome !== 'passed' || receipt.split !== 'dev'
    || receipt.metric !== 'strict-multi-hop-task-success-v1'
    || receipt.controlAdapterId !== 'memberry-retrieval-core-v1'
    || receipt.candidateAdapterId !== 'memberry-retrieval-core-query-decomposition-v1'
    || receipt.n !== 10) return false;
  const finite = (candidate: unknown, minimum: number, maximum: number) =>
    typeof candidate === 'number' && Number.isFinite(candidate)
      && candidate >= minimum && candidate <= maximum;
  if (!finite(receipt.controlSuccessRate, 0, 1) || !finite(receipt.candidateSuccessRate, 0, 1)
    || !finite(receipt.delta, -1, 1)) return false;
  if (!receipt.interval || typeof receipt.interval !== 'object' || Array.isArray(receipt.interval)) return false;
  const interval = receipt.interval as Record<string, unknown>;
  const intervalKeys = [
    'outcome', 'pairedProbes', 'resamples', 'level', 'point', 'lower', 'upper', 'oneSidedLower',
  ];
  if (JSON.stringify(Object.keys(interval).sort()) !== JSON.stringify([...intervalKeys].sort())) return false;
  return interval.outcome === 'measured'
    && interval.pairedProbes === 10
    && typeof interval.resamples === 'number' && Number.isInteger(interval.resamples) && interval.resamples > 0
    && finite(interval.level, 0, 1)
    && finite(interval.point, -1, 1)
    && finite(interval.lower, -1, 1)
    && finite(interval.upper, -1, 1)
    && finite(interval.oneSidedLower, -1, 1);
}

describe.sequential('RET-007 scorer-owned dev gate', () => {
  it('returns only the closed aggregate receipt and rejects neutral control parity', async () => {
    const { runRet007MultiHopDevGate } = await import('../gate.js');
    const receipt = await runRet007MultiHopDevGate({
      runId: 'ret007-dev-gate-test',
      repoRoot: REPO_ROOT,
      policy: await loadPolicy(),
    });
    expect(Reflect.ownKeys(receipt)).toEqual([
      'outcome', 'split', 'metric', 'n', 'controlAdapterId', 'candidateAdapterId',
      'controlSuccessRate', 'candidateSuccessRate', 'delta', 'interval',
    ]);
    expect(receipt.outcome).toBe('passed');
    expect(receipt.delta).toBeGreaterThan(0);
    expect(receipt.interval.oneSidedLower).toBeGreaterThanOrEqual(0);
    expect(isClosedDevReceipt(receipt)).toBe(true);
    const replay = JSON.parse(JSON.stringify(receipt)) as unknown;
    expect(isClosedDevReceipt(replay)).toBe(true);
    expect(JSON.stringify(replay)).toBe(JSON.stringify(receipt));
    expect(isClosedDevReceipt({ ...receipt, query: 'forbidden-extra-key' })).toBe(false);
    expect(isClosedDevReceipt({
      ...receipt,
      interval: { ...receipt.interval, probe: 'forbidden-extra-key' },
    })).toBe(false);
    expect(isClosedDevReceipt({ ...receipt, candidateAdapterId: 'substituted-adapter' })).toBe(false);
  });

  it('records exactly the literal dev descriptor and its two artifact opens through the sole file-open seam', async () => {
    const { runRet007MultiHopDevGate } = await import('../gate.js');
    const descriptorRequests: unknown[] = [];
    const artifactOpens: string[] = [];
    let loadedDescriptor: Awaited<ReturnType<typeof loadRegisteredDatasetDescriptor>> | undefined;
    await runRet007MultiHopDevGate({
      runId: 'ret007-dev-isolation-test',
      repoRoot: REPO_ROOT,
      policy: await loadPolicy(),
      custodian: {
        loadDescriptor: async (datasetId, repoRoot, access) => {
          descriptorRequests.push({ datasetId, repoRoot, access });
          loadedDescriptor = await loadRegisteredDatasetDescriptor(datasetId, repoRoot, access);
          return loadedDescriptor;
        },
        readArtifact: async (path) => {
          artifactOpens.push(path);
          return readFile(path, 'utf8');
        },
      },
    });
    expect(descriptorRequests).toEqual([{
      datasetId: 'memberry-multihop-dev', repoRoot: REPO_ROOT, access: 'all',
    }]);
    expect(loadedDescriptor?.split).toBe('dev');
    expect(artifactOpens.sort()).toEqual([
      loadedDescriptor!.inputArtifacts[0]!.path,
      loadedDescriptor!.oracleArtifacts[0]!.path,
    ].sort());

    const source = await readFile(resolve(REPO_ROOT, 'bench/lab/multihop/gate.ts'), 'utf8');
    const devWrapper = source.match(/export function runRet007MultiHopDevGate[\s\S]*?\n}\n/)?.[0] ?? '';
    expect(devWrapper).toContain("split: 'dev'");
    expect(devWrapper).toContain("custodian.loadDescriptor('memberry-multihop-dev', repoRoot, 'all')");
    expect(devWrapper).not.toContain('holdout');
    expect(source.match(/nodeReadFile\(/g)).toHaveLength(1);
    expect(source.match(/from 'node:fs\/promises'/g)).toEqual(["from 'node:fs/promises'"]);
    expect(source).toContain("import { readFile as nodeReadFile } from 'node:fs/promises';");
    expect(source.match(/custodian\.readArtifact\(/g)).toHaveLength(2);
    expect(source).not.toMatch(/loadMultiHopScenarioInputs\s*\(/);
    expect(source).not.toMatch(/loadMultiHopScenariosForScoring\s*\(/);
  });

  it.each([
    'split-disabled',
    'bridge-disabled',
    'multiplier-neutral',
  ] as const)('rejects the %s mechanism mutant through the registered dev scorer path', async (mutant) => {
    const moduleId = '../../../../packages/retrieval/src/query-decomposition.js';
    vi.resetModules();
    vi.doMock(moduleId, async () => {
      const actual = await vi.importActual<typeof import(
        '../../../../packages/retrieval/src/query-decomposition.js'
      )>(moduleId);
      const identity = (candidates: readonly unknown[]) => Object.freeze(
        Array.from({ length: candidates.length }, () => 1),
      );
      if (mutant === 'multiplier-neutral') return {
        ...actual,
        queryDecompositionMultipliersV1: (query: string, candidates: readonly never[]) => {
          actual.queryDecompositionMultipliersV1(query, candidates);
          return identity(candidates);
        },
      };
      if (mutant === 'bridge-disabled') return {
        ...actual,
        queryDecompositionMultipliersV1: (query: string, candidates: readonly { content: string; ordinal: number }[]) => {
          const queryTokens = new Set(query.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) ?? []);
          const frequency = new Map<string, number>();
          for (const candidate of candidates) {
            const tokens = new Set(candidate.content.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) ?? []);
            for (const token of tokens) if (!queryTokens.has(token)) {
              frequency.set(token, (frequency.get(token) ?? 0) + 1);
            }
          }
          const scrubbed = candidates.map((candidate) => ({
            ordinal: candidate.ordinal,
            content: candidate.content.replace(/[\p{L}\p{N}]+/gu, (token) => (
              !queryTokens.has(token.toLocaleLowerCase('en-US'))
                && (frequency.get(token.toLocaleLowerCase('en-US')) ?? 0) > 1
                ? `mutantbridge${candidate.ordinal}` : token
            )),
          }));
          return actual.queryDecompositionMultipliersV1(query, scrubbed);
        },
      };
      return {
        ...actual,
        queryDecompositionMultipliersV1: (_query: string, candidates: readonly never[]) =>
          actual.queryDecompositionMultipliersV1('neutral unsplit request', candidates),
      };
    });
    try {
      const { runRet007MultiHopDevGate } = await import('../gate.js');
      await expect(runRet007MultiHopDevGate({
        runId: `ret007-${mutant}-gate-test`,
        repoRoot: REPO_ROOT,
        policy: await loadPolicy(),
      })).rejects.toThrow(/point-delta-not-positive|comparison-failed|quality-regression/);
    } finally {
      vi.doUnmock(moduleId);
      vi.resetModules();
    }
  });

  it('burns the one-shot remote ref by creation-only API before any holdout scorer call', async () => {
    const workflow = await readFile(
      resolve(REPO_ROOT, '.github/workflows/ret007-multihop-holdout.yml'), 'utf8',
    );
    const burn = workflow.indexOf('gh api --method POST');
    const exactCi = workflow.indexOf('gh run list --workflow ci.yml --branch master --commit "$SOURCE_SHA"');
    const scorer = workflow.indexOf('runRet007MultiHopHoldoutGate');
    expect(exactCi).toBeGreaterThan(0);
    expect(exactCi).toBeLessThan(burn);
    for (const job of ['unit (20)', 'unit (22)', 'integration']) expect(workflow).toContain(job);
    expect(burn).toBeGreaterThan(0);
    expect(scorer).toBeGreaterThan(burn);
    expect(workflow).toContain('-f ref="refs/tags/${tag}"');
    const burnStep = workflow.slice(workflow.indexOf('- name: Burn v1'), scorer);
    expect(burnStep).toContain('git ls-remote origin refs/heads/master');
    expect(burnStep.indexOf('git ls-remote origin refs/heads/master')).toBeLessThan(
      burnStep.indexOf('gh api --method POST'),
    );
    expect(burnStep.indexOf("printf 'BURN_REF=%s\\nBURN_VERIFIED=0\\n'")).toBeLessThan(
      burnStep.indexOf('gh api --method POST'),
    );
    expect(burnStep.lastIndexOf('git ls-remote origin refs/heads/master')).toBeGreaterThan(
      burnStep.indexOf('gh api --method POST'),
    );
    expect(burnStep).toContain('[ "$post_master" != "$SOURCE_SHA" ]');
    expect(burnStep).toContain('if [ -z "$burn_failure" ]; then burn_verified=1; fi');
    expect(workflow).toContain("if [ \"${BURN_VERIFIED:-0}\" != '1' ] && [ -z \"$failure_code\" ]; then");
    expect(burnStep).toContain('git ls-remote origin "$burn_ref"');
    expect(burnStep).toContain('[ "$burn_target" != "$SOURCE_SHA" ]');
    expect(burnStep).toContain("burn_failure='ret007-holdout-burn-target-failure'");
    expect(workflow).toContain("failure_code=\"${BURN_FAILURE:-}\"");
    expect(workflow).toContain("if: ${{ always() && env.BURN_REF != '' }}");
    expect(workflow).toContain('ret007-holdout-receipt-write-failure');
    for (const code of [
      'ret007-holdout-burn-consumed', 'ret007-holdout-burn-target-failure',
      'ret007-holdout-execution-failure', 'ret007-holdout-output-policy-failure',
      'ret007-holdout-policy-rejection', 'ret007-holdout-receipt-write-failure',
    ]) expect(workflow).toContain(code);
    expect(workflow).not.toMatch(/git push/);
    expect(workflow).toContain('uses: actions/upload-artifact@v4');
    expect(workflow.indexOf('- name: Validate closed receipt before upload')).toBeLessThan(
      workflow.indexOf('uses: actions/upload-artifact@v4'),
    );
    expect(workflow.indexOf('uses: actions/upload-artifact@v4')).toBeLessThan(
      workflow.indexOf('- name: Adjudicate validated closed receipt'),
    );
    expect(workflow).toContain("env.RECEIPT_VALIDATED == '1'");
    expect(workflow).not.toMatch(/ComparisonReport/);
    expect(workflow).not.toMatch(/grep\s+-Eqi/);
    expect(workflow).toContain("['schemaVersion', 'outcome', 'failureCode', 'sourceSha', 'ciRunId', 'burnKey',");
    expect(workflow).toContain('const expectedIdentities = {');
    expect(workflow).toContain("value.burnKey !== expectedBurnKey");
    expect(workflow).toContain("['control', 'candidate']");
    expect(workflow).toContain("['outcome', 'failureCodes', 'split', 'metric', 'n', 'controlAdapterId',");
    expect(workflow).toContain('interval.pairedProbes !== 10');
    expect(workflow).toContain('interval.resamples !== 2000');
    expect(workflow).toContain('interval.level !== 0.95');
    expect(workflow).toContain('Math.abs(interval.point - value.aggregate.delta) > Number.EPSILON');
    expect(workflow).toContain('Math.abs((value.aggregate.controlSuccessRate * 10)');
    expect(workflow).toContain('Math.abs((value.aggregate.candidateSuccessRate * 10)');
    expect(workflow).toContain("2>/dev/null");
    const fixedIdentity = workflow.match(/fixed_identity='([^']+)'/)?.[1] ?? '';
    expect(fixedIdentity).not.toContain('SOURCE_SHA');
    for (const identity of [
      'd0cf00d1be40ae64f9eb7a174206a0701de14e4df4be91f721eff416e77a402d:15953',
      '33b7e4b6ce3ce0ef2fdab52a75c678055a70915247a8e20eb5c99fe1c092f962:17860',
      'b1e56a88d6496b2a9e4c297d6295b0901bbcfa9bb2e7900dd4bb80ae1bb1853e:1920',
      '0b5d5f4c621b4ed460ee5bd04daa7ac4a9adcf6a821fa4b6a497e277d783617c:8958',
      '4de7d29f19523f36d868efba13cfe7686c2af6f0b9206ed838064df609f1fa9e:2677',
      'ab19e5cf4050e38098be9459477cbedf4a4f33650e5e03ee683c05ca80cdb06a:2464',
      'a671e60f0bfebf1ec18ccabfefe0d29504cf1169ffedbb7c91d1047612394282:4961',
      '66e3e0e45d7b6ddb41dadfdd674475957691ed164a9d273bf4125592cdaedf53:8051',
    ]) expect(fixedIdentity).toContain(identity);
    expect(workflow).toContain("expectedBurnKey !== '416e7a550e0b64aa46e6d01292d5ed78'");
  });
});
