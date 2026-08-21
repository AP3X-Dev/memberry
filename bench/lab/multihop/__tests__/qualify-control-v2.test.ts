import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { AdapterRunReport } from '../../contracts/report.js';
import type { LabScenario } from '../../contracts/scenario.js';
import { averageMetrics, scoreProbe } from '../../metrics.js';
import {
  MULTIHOP_V2_CONTROL_ADAPTER_ID,
  MULTIHOP_V2_FREEZE,
} from '../policy-v2.js';
import {
  LAB013_ALLOWED_SOURCE_PATHS,
  assertNoV2CandidateArtifactRegistration,
  assertNoV2CandidateRegistration,
  assertSourceChangedPaths,
  buildControlNodeEvidenceArtifact,
  closedFailureReceipt,
  computeStrictControlSplitReceipt,
  joinControlQualificationEvidence,
} from '../qualify-control-v2.js';
import {
  qualifyMultiHopV2ControlReceipt,
  type MultiHopV2ControlQualificationReceipt,
  type MultiHopV2ControlNodeEvidenceReceipt,
} from '../scorer-only-v2.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const ZERO_STATS = { memories: 0, queries: 0, feedbackEvents: 0 };
const CONTROL_SUCCESS = new Set([0, 1, 2, 3, 4, 5, 6, 7]);

function scenarios(): LabScenario[] {
  return Array.from({ length: 20 }, (_, index) => {
    const prefix = `qualification-unit-${String(index + 1).padStart(2, '0')}`;
    const density = ['low', 'medium', 'high'][index % 3]!;
    const memories = Array.from({ length: 24 }, (__, memoryIndex) => ({
      id: `${prefix}-m-${memoryIndex}`, content: `Statement ${memoryIndex} for ${prefix}.`,
      recordedAt: '2026-08-20T00:00:00.000Z',
    }));
    return {
      input: {
        version: '1.0.0', id: prefix, split: 'dev', title: 'Qualification unit', description: 'Synthetic.',
        dimensions: ['multi-hop'], tenant: 'synthetic', project: prefix, memories,
        queries: [{ id: `${prefix}-probe`, query: 'combine both facts', limit: 10 }],
        tags: ['synthetic', `density:${density}`],
      },
      oracle: {
        version: '1.0.0', scenarioId: prefix,
        probes: [{ probeId: `${prefix}-probe`, relevant: [memories[0]!.id, memories[1]!.id], required: [memories[0]!.id, memories[1]!.id] }],
      },
    };
  });
}

function controlReport(fixtures: readonly LabScenario[]): AdapterRunReport {
  const scenarioReports = fixtures.map((scenario, index) => {
    const ids = scenario.input.memories.map(({ id }) => id);
    const resultIds = CONTROL_SUCCESS.has(index)
      ? [ids[0]!, ids[1]!, ...ids.slice(2, 10)]
      : [ids[0]!, ...ids.slice(2, 11)];
    const query = scenario.input.queries[0]!;
    const metrics = scoreProbe(
      scenario.input, scenario.oracle.probes[0]!, query.limit, resultIds.map((id) => ({ id, score: 0 })),
    );
    return {
      scenarioId: scenario.input.id, split: scenario.input.split, dimensions: scenario.input.dimensions,
      capabilityGaps: [], outcome: 'scored' as const,
      probes: [{ probeId: query.id, query: query.query, resultIds, metrics }], metrics,
    };
  });
  return {
    contractVersion: '1.0.0', runId: 'qualification-dev-run', adapterId: MULTIHOP_V2_CONTROL_ADAPTER_ID,
    adapterName: 'production control', executionMode: 'fixture', health: 'ready', outcome: 'scored',
    excludedScenarios: [], scenarioReports,
    metrics: averageMetrics(scenarioReports.map(({ metrics }) => metrics)), stats: ZERO_STATS,
    gateFailures: [], passed: true,
  };
}

function nodeReceipt(nodeMajor: 20 | 22): MultiHopV2ControlNodeEvidenceReceipt {
  const split = {
    n: 20, successes: 8, successRate: 0.4,
    strata: {
      low: { n: 7, successes: 3, failures: 4 },
      medium: { n: 7, successes: 3, failures: 4 },
      high: { n: 6, successes: 2, failures: 4 },
    },
  } as const;
  return {
    schemaVersion: '1.0.0', kind: 'lab013-control-qualification-node-evidence',
    instrument: 'memberry-multihop-v2', instrumentVersion: '2.0.0',
    exactBaseCommit: 'a90d8a91aa0ec5f10796938798537aafc2ed0b9c',
    seedCommitmentSha256: '8a405c6921dc3e5790f0df6054620099ed98bf54767637229c5544f2e54e241a',
    receiptId: `lab013-987654321-attempt1-node${nodeMajor}`, createdAt: '2026-08-21T00:00:00.000Z',
    executedSourceSha: '1234567890abcdef1234567890abcdef12345678',
    workflowRefSha: '1234567890abcdef1234567890abcdef12345678',
    workflowRun: { id: '987654321', url: 'https://github.com/AP3X-Dev/memberry/actions/runs/987654321', attempt: 1 },
    producer: 'independent-scorer-custodian', runtime: { execution: 'hosted', platform: 'linux', nodeMajor },
    controlAdapterId: MULTIHOP_V2_CONTROL_ADAPTER_ID,
    controlAdapterClass: 'production-core-fixture-adapter', controlExecutionMode: 'fixture',
    qualificationRuns: {
      dev: { id: `lab013-987654321-attempt1-node${nodeMajor}-dev-control` },
      holdout: { id: `lab013-987654321-attempt1-node${nodeMajor}-holdout-control` },
    },
    controlSourceIdentity: MULTIHOP_V2_FREEZE.controlSourceIdentity,
    candidateAbsentAtQualification: true, candidateArtifactsObserved: false, candidateExecutionObserved: false,
    disclosure: 'closed-aggregate-only', artifactBindings: MULTIHOP_V2_FREEZE.artifacts,
    splits: { dev: split, holdout: split },
  };
}

function hostedEnvironment(): NodeJS.ProcessEnv {
  return {
    LAB013_SOURCE_SHA: '1234567890abcdef1234567890abcdef12345678',
    GITHUB_SHA: '1234567890abcdef1234567890abcdef12345678',
    GITHUB_RUN_ID: '987654321', GITHUB_REPOSITORY: 'AP3X-Dev/memberry',
    GITHUB_SERVER_URL: 'https://github.com', GITHUB_RUN_ATTEMPT: '1',
  };
}

describe('LAB-013 control-only hosted qualification runner', () => {
  it('computes strict all-two aggregate and density counts without returning per-case values', () => {
    const fixtures = scenarios();
    const report = controlReport(fixtures);
    const aggregate = computeStrictControlSplitReceipt(fixtures, report);
    expect(aggregate).toEqual({
      n: 20, successes: 8, successRate: 0.4,
      strata: {
        low: { n: 7, successes: 3, failures: 4 },
        medium: { n: 7, successes: 3, failures: 4 },
        high: { n: 6, successes: 2, failures: 4 },
      },
    });
    expect(JSON.stringify(aggregate)).not.toMatch(/scenarioId|probeId|query|resultIds|required|relevant|oracle/);

    const missingSecondHop = structuredClone(report);
    missingSecondHop.scenarioReports[0]!.probes[0]!.resultIds = [
      fixtures[0]!.input.memories[0]!.id, ...fixtures[0]!.input.memories.slice(2, 11).map(({ id }) => id),
    ];
    expect(computeStrictControlSplitReceipt(fixtures, missingSecondHop).successes).toBe(7);
  });

  it('joins Node 20 and Node 22 into the sole exact authoritative closed aggregate', () => {
    const artifact = joinControlQualificationEvidence(
      buildControlNodeEvidenceArtifact(nodeReceipt(20)),
      buildControlNodeEvidenceArtifact(nodeReceipt(22)),
      'success',
      hostedEnvironment(),
    );
    expect(artifact.qualification.outcome).toBe('qualified');
    expect(artifact.kind).toBe('lab013-control-qualification');
    expect(artifact.receipt).toMatchObject({
      executedSourceSha: '1234567890abcdef1234567890abcdef12345678',
      workflowRefSha: '1234567890abcdef1234567890abcdef12345678',
      workflowRun: { id: '987654321', url: 'https://github.com/AP3X-Dev/memberry/actions/runs/987654321' },
      controlAdapterClass: 'production-core-fixture-adapter', controlExecutionMode: 'fixture',
      runtime: { nodeMajors: [20, 22] },
    });
    expect(JSON.stringify(artifact)).not.toMatch(/scenarioId|probeId|query|resultIds|requiredIds|relevantIds|oracleId|bootstrap|perCase/);
    expect(() => qualifyMultiHopV2ControlReceipt(
      nodeReceipt(20) as unknown as MultiHopV2ControlQualificationReceipt,
    )).toThrow(/closed schema mismatch/);
  });

  it('fails the authority join on missing, red, divergent, or source-unbound sibling evidence', () => {
    const node20 = buildControlNodeEvidenceArtifact(nodeReceipt(20));
    const node22 = buildControlNodeEvidenceArtifact(nodeReceipt(22));
    expect(() => joinControlQualificationEvidence(node20, undefined, 'success', hostedEnvironment()))
      .toThrow(/control-aggregate-invalid/);
    expect(() => joinControlQualificationEvidence(node20, node22, 'failure', hostedEnvironment()))
      .toThrow(/control-headroom-rejected/);

    const rejectedReceipt = structuredClone(nodeReceipt(22)) as unknown as MultiHopV2ControlNodeEvidenceReceipt;
    const rejected = rejectedReceipt.splits.dev as {
      n: number; successes: number; successRate: number;
      strata: Record<string, { n: number; successes: number; failures: number }>;
    };
    rejected.successes = 15;
    rejected.successRate = 0.75;
    Object.assign(rejected.strata.low, { successes: 6, failures: 1 });
    Object.assign(rejected.strata.medium, { successes: 5, failures: 2 });
    Object.assign(rejected.strata.high, { successes: 4, failures: 2 });
    const red = buildControlNodeEvidenceArtifact(rejectedReceipt);
    expect(() => joinControlQualificationEvidence(node20, red, 'success', hostedEnvironment()))
      .toThrow(/control-headroom-rejected/);

    const divergentReceipt = structuredClone(nodeReceipt(22)) as unknown as MultiHopV2ControlNodeEvidenceReceipt;
    const divergent = divergentReceipt.splits.holdout.strata as Record<
      string, { n: number; successes: number; failures: number }
    >;
    Object.assign(divergent.low, { successes: 2, failures: 5 });
    Object.assign(divergent.medium, { successes: 4, failures: 3 });
    const divergentNode = buildControlNodeEvidenceArtifact(divergentReceipt);
    expect(() => joinControlQualificationEvidence(node20, divergentNode, 'success', hostedEnvironment()))
      .toThrow(/control-aggregate-invalid/);

    const sourceReceipt = structuredClone(nodeReceipt(22)) as unknown as MultiHopV2ControlNodeEvidenceReceipt;
    (sourceReceipt as { executedSourceSha: string }).executedSourceSha = '0'.repeat(40);
    (sourceReceipt as { workflowRefSha: string }).workflowRefSha = '0'.repeat(40);
    const sourceDivergence = buildControlNodeEvidenceArtifact(sourceReceipt);
    expect(() => joinControlQualificationEvidence(node20, sourceDivergence, 'success', hostedEnvironment()))
      .toThrow(/control-aggregate-invalid/);

    const workflowMismatch = { ...hostedEnvironment(), GITHUB_SHA: 'f'.repeat(40) };
    expect(() => joinControlQualificationEvidence(node20, node22, 'success', workflowMismatch))
      .toThrow(/invalid-hosted-provenance/);
  });

  it('pins the exact 15-path source envelope and rejects v2 candidate system or experiment registration', () => {
    expect(LAB013_ALLOWED_SOURCE_PATHS).toHaveLength(15);
    expect(() => assertSourceChangedPaths(LAB013_ALLOWED_SOURCE_PATHS)).not.toThrow();
    expect(() => assertSourceChangedPaths(LAB013_ALLOWED_SOURCE_PATHS.slice(1))).toThrow(/source-preflight-failed/);
    expect(() => assertSourceChangedPaths([...LAB013_ALLOWED_SOURCE_PATHS, 'packages/retrieval/src/forbidden.ts']))
      .toThrow(/source-preflight-failed/);
    expect(() => assertNoV2CandidateRegistration([{ id: 'memberry-retrieval-core-v1' }], [{ id: 'existing-v1' }]))
      .not.toThrow();
    expect(() => assertNoV2CandidateRegistration([{ id: 'lab013-candidate-adapter' }], []))
      .toThrow(/registry-preflight-failed/);
    expect(() => assertNoV2CandidateRegistration([], [{ id: 'multihop-v2-experiment' }]))
      .toThrow(/registry-preflight-failed/);
    const datasets = ['dev', 'holdout'].map((split) => ({
      id: `memberry-multihop-v2-${split}`, split,
      artifacts: [
        { role: 'input', access: 'adapter', repositoryPath: `bench/lab/datasets/multihop/v2/${split}/input.jsonl` },
        { role: 'oracle', access: 'scorer', repositoryPath: `bench/lab/datasets/multihop/v2/${split}/oracle.jsonl` },
      ],
    }));
    expect(() => assertNoV2CandidateArtifactRegistration(datasets)).not.toThrow();
    expect(() => assertNoV2CandidateArtifactRegistration([
      ...datasets, { id: 'memberry-multihop-v2-candidate', split: 'dev', artifacts: [] },
    ])).toThrow(/registry-preflight-failed/);
  });

  it('emits only a bounded failure code when preflight cannot produce aggregates', () => {
    const failure = closedFailureReceipt('source-preflight-failed', {
      LAB013_SOURCE_SHA: 'not-a-sha', GITHUB_RUN_ID: 'not-a-run', GITHUB_REPOSITORY: 'bad',
      GITHUB_SERVER_URL: 'https://host.invalid', GITHUB_RUN_ATTEMPT: 'bad',
    });
    expect(failure).toMatchObject({
      outcome: 'rejected', failureCode: 'source-preflight-failed', executedSourceSha: null,
      workflowRefSha: null,
      workflowRun: { id: null, url: null, attempt: null }, disclosure: 'closed-aggregate-only',
    });
    expect(Object.keys(failure)).toEqual([
      'schemaVersion', 'kind', 'outcome', 'failureCode', 'executedSourceSha', 'workflowRefSha',
      'workflowRun', 'runtime', 'disclosure',
    ]);
  });

  it('preflights before dynamic control loading and joins pinned Node 20 and 22 evidence', async () => {
    const runner = await readFile(resolve(REPO_ROOT, 'bench/lab/multihop/qualify-control-v2.ts'), 'utf8');
    expect(runner).not.toMatch(/compareRegisteredAdapters|compareAdapters|ComparisonReport|candidateId/);
    expect(runner).not.toMatch(/^import .*from ['"]\.\.\/(?:adapters|datasets|registered-adapters|runner)\//m);
    expect(runner.match(/await runtime\.run\(/g)).toHaveLength(1);
    expect(runner).toContain("for (const split of ['dev', 'holdout'] as const)");
    expect(runner).toContain('loadRegisteredControl(repoRoot, runtime)');
    const execution = runner.slice(runner.indexOf('async function executeControlNodeEvidence'));
    expect(execution.indexOf('assertSourcePreflight(repoRoot, hosted.sourceSha)'))
      .toBeLessThan(execution.indexOf('const runtime = await loadControlRuntime()'));
    expect(execution.indexOf('assertRegistryCandidateAbsence(repoRoot)'))
      .toBeLessThan(execution.indexOf('const runtime = await loadControlRuntime()'));

    const workflow = await readFile(resolve(REPO_ROOT, '.github/workflows/lab013-control-qualification.yml'), 'utf8');
    expect(workflow).toContain('node-version: [20, 22]');
    expect(workflow).toContain('ref: ${{ inputs.source_sha }}');
    expect(workflow).toContain('[[ "$GITHUB_SHA" == "$LAB013_SOURCE_SHA" ]]');
    expect(workflow.indexOf('No-dependency source, control, and candidate-absence preflight'))
      .toBeLessThan(workflow.indexOf('Install frozen dependencies without lifecycle scripts'));
    expect(workflow).toContain('npm ci --ignore-scripts');
    expect(workflow).toContain('git status --porcelain --untracked-files=all');
    expect(workflow).toContain('if: always()');
    expect(workflow).toContain('lab013-control-qualification-failure');
    expect(workflow).toContain('npm run bench:lab:multihop-v2:qualify-control');
    expect(workflow).toContain('npm run bench:lab:multihop-v2:join-control');
    expect(workflow).toContain('needs: [qualify-control]');
    expect(workflow).toContain('LAB013_MATRIX_RESULT: ${{ needs.qualify-control.result }}');
    expect(workflow).toContain('lab013-control-authority-${{ github.run_id }}-${{ github.run_attempt }}');
    const workflowAllowlists = [...workflow.matchAll(
      /expected="\$\(cat <<'PATHS' \| LC_ALL=C sort\n([\s\S]*?)\n\s+PATHS/g,
    )].map((match) => match[1]!.split('\n').map((line) => line.trim()).filter(Boolean));
    expect(workflowAllowlists).toHaveLength(2);
    for (const allowlist of workflowAllowlists) expect(allowlist).toEqual([...LAB013_ALLOWED_SOURCE_PATHS]);
    for (const blob of Object.values(MULTIHOP_V2_FREEZE.controlSourceIdentity).filter((value) => /^[0-9a-f]{40}$/.test(value))) {
      expect(workflow.split(blob)).toHaveLength(3);
    }
    for (const pinned of [
      'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
      'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
      'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
      'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
    ]) expect(workflow).toContain(pinned);
    expect(workflow).not.toMatch(/uses:\s+actions\/(?:checkout|setup-node|upload-artifact|download-artifact)@v\d/);
    expect(workflow).not.toMatch(/deploy|compare|candidate adapter|candidate run/i);
  });
});
