import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { AdapterRunReport } from '../../contracts/report.js';
import type { LabScenario } from '../../contracts/scenario.js';
import { averageMetrics, scoreProbe } from '../../metrics.js';
import {
  MULTIHOP_V4_CONTROL_ADAPTER_ID,
  MULTIHOP_V4_FREEZE,
} from '../policy-v4.js';
import {
  RET007V4_ALLOWED_SOURCE_PATHS,
  assertNoV4CandidateArtifactRegistration,
  assertNoV4CandidateRegistration,
  assertSourceChangedPaths,
  buildControlNodeEvidenceArtifact,
  closedFailureReceipt,
  computeStrictControlSplitReceipt,
  joinControlQualificationEvidence,
} from '../qualify-control-v4.js';
import {
  qualifyMultiHopV4ControlReceipt,
  type MultiHopV4ControlQualificationReceipt,
  type MultiHopV4ControlNodeEvidenceReceipt,
} from '../scorer-only-v4.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const ZERO_STATS = { memories: 0, queries: 0, feedbackEvents: 0 };
const SIZES = { dev: 60, holdout: 100, twin: 30 } as const;
const DENSITY_COUNTS = {
  dev: { low: 20, medium: 20, high: 20 },
  holdout: { low: 34, medium: 33, high: 33 },
  twin: { low: 10, medium: 10, high: 10 },
} as const;

function densityFor(split: keyof typeof SIZES, index: number): 'low' | 'medium' | 'high' {
  const counts = DENSITY_COUNTS[split];
  if (index < counts.low) return 'low';
  if (index < counts.low + counts.medium) return 'medium';
  return 'high';
}

function scenarios(split: keyof typeof SIZES): LabScenario[] {
  return Array.from({ length: SIZES[split] }, (_, index) => {
    const prefix = `qualification-unit-${split}-${String(index + 1).padStart(3, '0')}`;
    const memories = Array.from({ length: 22 }, (__, memoryIndex) => ({
      id: `${prefix}-m-${memoryIndex}`, content: `Statement ${memoryIndex} for ${prefix}.`,
      recordedAt: '2026-08-20T00:00:00.000Z',
    }));
    return {
      input: {
        version: '1.0.0', id: prefix, split: split as never, title: 'Qualification unit', description: 'Synthetic.',
        dimensions: ['multi-hop'], tenant: 'synthetic', project: prefix, memories,
        queries: [{ id: `${prefix}-probe`, query: 'combine both facts', limit: 10 }],
        tags: ['synthetic', `density:${densityFor(split, index)}`],
      },
      oracle: {
        version: '1.0.0', scenarioId: prefix,
        probes: [{ probeId: `${prefix}-probe`, relevant: [memories[0]!.id, memories[1]!.id], required: [memories[0]!.id, memories[1]!.id] }],
      },
    };
  });
}

/** Success on even indices. */
function controlReport(fixtures: readonly LabScenario[]): AdapterRunReport {
  const scenarioReports = fixtures.map((scenario, index) => {
    const ids = scenario.input.memories.map(({ id }) => id);
    const resultIds = index % 2 === 0
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
    contractVersion: '1.0.0', runId: 'qualification-run', adapterId: MULTIHOP_V4_CONTROL_ADAPTER_ID,
    adapterName: 'funnel control', executionMode: 'fixture', health: 'ready', outcome: 'scored',
    excludedScenarios: [], scenarioReports,
    metrics: averageMetrics(scenarioReports.map(({ metrics }) => metrics)), stats: ZERO_STATS,
    gateFailures: [], passed: true,
  };
}

function nodeReceipt(nodeMajor: 20 | 22): MultiHopV4ControlNodeEvidenceReceipt {
  return {
    schemaVersion: '1.0.0', kind: 'ret007v4-control-qualification-node-evidence',
    instrument: 'memberry-multihop-v4', instrumentVersion: '4.0.0',
    exactBaseCommit: MULTIHOP_V4_FREEZE.exactBaseCommit,
    seedCommitmentSha256: MULTIHOP_V4_FREEZE.seedCommitmentSha256,
    funnelTopN: 12,
    receiptId: `ret007v4-987654321-attempt1-node${nodeMajor}`, createdAt: '2026-08-25T00:00:00.000Z',
    executedSourceSha: '1234567890abcdef1234567890abcdef12345678',
    workflowRefSha: '1234567890abcdef1234567890abcdef12345678',
    workflowRun: { id: '987654321', url: 'https://github.com/AP3X-Dev/memberry/actions/runs/987654321', attempt: 1 },
    producer: 'independent-scorer-custodian', runtime: { execution: 'hosted', platform: 'linux', nodeMajor },
    controlAdapterId: MULTIHOP_V4_CONTROL_ADAPTER_ID,
    controlAdapterClass: 'production-core-fixture-adapter', controlExecutionMode: 'fixture',
    qualificationRuns: {
      dev: { id: `ret007v4-987654321-attempt1-node${nodeMajor}-dev-control` },
      holdout: { id: `ret007v4-987654321-attempt1-node${nodeMajor}-holdout-control` },
      twin: { id: `ret007v4-987654321-attempt1-node${nodeMajor}-twin-control` },
    },
    controlSourceIdentity: MULTIHOP_V4_FREEZE.controlSourceIdentity,
    candidateAbsentAtQualification: true, candidateArtifactsObserved: false, candidateExecutionObserved: false,
    disclosure: 'closed-aggregate-only',
    artifactBindings: { dev: MULTIHOP_V4_FREEZE.artifacts.dev, holdout: MULTIHOP_V4_FREEZE.artifacts.holdout, twin: MULTIHOP_V4_FREEZE.artifacts.twin },
    splits: {
      dev: computeStrictControlSplitReceipt('dev', scenarios('dev'), controlReport(scenarios('dev'))),
      holdout: computeStrictControlSplitReceipt('holdout', scenarios('holdout'), controlReport(scenarios('holdout'))),
      twin: computeStrictControlSplitReceipt('twin', scenarios('twin'), controlReport(scenarios('twin'))),
    },
    twinEvidence: { role: 'recorded-evidence-only', verdictTerm: false },
  };
}

function hostedEnvironment(): NodeJS.ProcessEnv {
  return {
    RET007V4_SOURCE_SHA: '1234567890abcdef1234567890abcdef12345678',
    GITHUB_SHA: '1234567890abcdef1234567890abcdef12345678',
    GITHUB_RUN_ID: '987654321', GITHUB_REPOSITORY: 'AP3X-Dev/memberry',
    GITHUB_SERVER_URL: 'https://github.com', GITHUB_RUN_ATTEMPT: '1',
    RET007V4_TWIN_EVIDENCE_ROLE: 'recorded-evidence-only',
  };
}

type Mutable = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('RET-007 v4 control-only hosted qualification runner', () => {
  it('computes strict all-two aggregates per split (dev 60, holdout 100, twin 30) without per-case values', () => {
    const dev = computeStrictControlSplitReceipt('dev', scenarios('dev'), controlReport(scenarios('dev')));
    expect(dev).toEqual({
      n: 60, successes: 30, successRate: 0.5,
      strata: { low: { n: 20, successes: 10, failures: 10 }, medium: { n: 20, successes: 10, failures: 10 }, high: { n: 20, successes: 10, failures: 10 } },
    });
    const holdout = computeStrictControlSplitReceipt('holdout', scenarios('holdout'), controlReport(scenarios('holdout')));
    expect(holdout.n).toBe(100);
    expect(holdout.strata.low.n + holdout.strata.medium.n + holdout.strata.high.n).toBe(100);
    const twin = computeStrictControlSplitReceipt('twin', scenarios('twin'), controlReport(scenarios('twin')));
    expect(twin).toEqual({
      n: 30, successes: 15, successRate: 0.5,
      strata: { low: { n: 10, successes: 5, failures: 5 }, medium: { n: 10, successes: 5, failures: 5 }, high: { n: 10, successes: 5, failures: 5 } },
    });
    expect(JSON.stringify(dev)).not.toMatch(/scenarioId|probeId|query|resultIds|required|relevant|oracle/);
    expect(() => computeStrictControlSplitReceipt('dev', scenarios('twin'), controlReport(scenarios('twin')))).toThrow(/control-aggregate-invalid/);
  });

  it('joins Node 20 and Node 22 into the sole exact authoritative closed aggregate with the twin recorded as evidence', () => {
    const artifact = joinControlQualificationEvidence(
      buildControlNodeEvidenceArtifact(nodeReceipt(20)),
      buildControlNodeEvidenceArtifact(nodeReceipt(22)),
      'success',
      hostedEnvironment(),
    );
    expect(artifact.qualification.outcome).toBe('qualified');
    expect(artifact.kind).toBe('ret007v4-control-qualification');
    expect(artifact.receipt).toMatchObject({
      funnelTopN: 12,
      controlAdapterId: 'memberry-retrieval-core-funnel-v1',
      controlAdapterClass: 'production-core-fixture-adapter', controlExecutionMode: 'fixture',
      runtime: { nodeMajors: [20, 22] },
      twinEvidence: { role: 'recorded-evidence-only', verdictTerm: false },
    });
    expect(artifact.qualification.twinEvidence).toEqual({ n: 30, successRate: 0.5, verdictTerm: false });
    expect(JSON.stringify(artifact)).not.toMatch(/scenarioId|probeId|query|resultIds|requiredIds|relevantIds|oracleId|bootstrap|perCase/);
    expect(() => qualifyMultiHopV4ControlReceipt(
      nodeReceipt(20) as unknown as MultiHopV4ControlQualificationReceipt,
    )).toThrow(/closed schema mismatch/);
  });

  it('fails the authority join on missing, red, divergent (incl. twin), or source-unbound sibling evidence', () => {
    const node20 = buildControlNodeEvidenceArtifact(nodeReceipt(20));
    const node22 = buildControlNodeEvidenceArtifact(nodeReceipt(22));
    expect(() => joinControlQualificationEvidence(node20, undefined, 'success', hostedEnvironment()))
      .toThrow(/control-aggregate-invalid/);
    expect(() => joinControlQualificationEvidence(node20, node22, 'failure', hostedEnvironment()))
      .toThrow(/control-headroom-rejected/);

    const rejectedReceipt = structuredClone(nodeReceipt(22)) as Mutable;
    rejectedReceipt.splits.dev = {
      n: 60, successes: 45, successRate: 0.75,
      strata: { low: { n: 20, successes: 15, failures: 5 }, medium: { n: 20, successes: 15, failures: 5 }, high: { n: 20, successes: 15, failures: 5 } },
    };
    expect(() => joinControlQualificationEvidence(node20, buildControlNodeEvidenceArtifact(rejectedReceipt as MultiHopV4ControlNodeEvidenceReceipt), 'success', hostedEnvironment()))
      .toThrow(/control-headroom-rejected/);

    const twinDivergent = structuredClone(nodeReceipt(22)) as Mutable;
    Object.assign(twinDivergent.splits.twin.strata.low, { successes: 4, failures: 6 });
    Object.assign(twinDivergent.splits.twin.strata.medium, { successes: 6, failures: 4 });
    expect(() => joinControlQualificationEvidence(node20, buildControlNodeEvidenceArtifact(twinDivergent as MultiHopV4ControlNodeEvidenceReceipt), 'success', hostedEnvironment()))
      .toThrow(/control-aggregate-invalid/);

    const sourceReceipt = structuredClone(nodeReceipt(22)) as Mutable;
    sourceReceipt.executedSourceSha = '0'.repeat(40);
    sourceReceipt.workflowRefSha = '0'.repeat(40);
    expect(() => joinControlQualificationEvidence(node20, buildControlNodeEvidenceArtifact(sourceReceipt as MultiHopV4ControlNodeEvidenceReceipt), 'success', hostedEnvironment()))
      .toThrow(/control-aggregate-invalid/);

    const workflowMismatch = { ...hostedEnvironment(), GITHUB_SHA: 'f'.repeat(40) };
    expect(() => joinControlQualificationEvidence(node20, node22, 'success', workflowMismatch))
      .toThrow(/invalid-hosted-provenance/);
  });

  it('pins the exact 29-path source envelope and rejects v4 candidate system/experiment registration', () => {
    expect(RET007V4_ALLOWED_SOURCE_PATHS).toHaveLength(29);
    expect([...RET007V4_ALLOWED_SOURCE_PATHS]).toEqual([...RET007V4_ALLOWED_SOURCE_PATHS].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(RET007V4_ALLOWED_SOURCE_PATHS).toEqual(expect.arrayContaining([
      'package.json', 'bench/lab/registered-adapters.ts', 'bench/lab/registry/systems.json', 'bench/lab/registry/datasets.json',
      'bench/lab/adapters/memberry-retrieval-core-funnel.ts', 'bench/lab/multihop/EXCHANGEABILITY-V4.md',
      'bench/lab/datasets/multihop/v4/twin/oracle.jsonl',
    ]));
    expect(RET007V4_ALLOWED_SOURCE_PATHS).not.toContain('bench/lab/adapters/memberry-retrieval-core.ts');
    expect(() => assertSourceChangedPaths(RET007V4_ALLOWED_SOURCE_PATHS)).not.toThrow();
    expect(() => assertSourceChangedPaths(RET007V4_ALLOWED_SOURCE_PATHS.slice(1))).toThrow(/source-preflight-failed/);
    expect(() => assertSourceChangedPaths([...RET007V4_ALLOWED_SOURCE_PATHS, 'packages/retrieval/src/forbidden.ts']))
      .toThrow(/source-preflight-failed/);
    expect(() => assertNoV4CandidateRegistration([{ id: 'memberry-retrieval-core-funnel-v1' }], [{ id: 'existing-v1' }]))
      .not.toThrow();
    expect(() => assertNoV4CandidateRegistration([{ id: 'ret007-v4-candidate-adapter' }], []))
      .toThrow(/registry-preflight-failed/);
    expect(() => assertNoV4CandidateRegistration([], [{ id: 'multihop-v4-experiment' }]))
      .toThrow(/registry-preflight-failed/);
    const datasets = ['calib', 'dev', 'holdout', 'twin'].map((split) => ({
      id: `memberry-multihop-v4-${split}`, split, requiredInCi: false,
      artifacts: [
        { role: 'input', access: 'adapter', repositoryPath: `bench/lab/datasets/multihop/v4/${split}/input.jsonl` },
        { role: 'oracle', access: 'scorer', repositoryPath: `bench/lab/datasets/multihop/v4/${split}/oracle.jsonl` },
      ],
    }));
    expect(() => assertNoV4CandidateArtifactRegistration(datasets)).not.toThrow();
    expect(() => assertNoV4CandidateArtifactRegistration(datasets.slice(0, 3))).toThrow(/registry-preflight-failed/);
    expect(() => assertNoV4CandidateArtifactRegistration([
      ...datasets, { id: 'memberry-multihop-v4-candidate', split: 'dev', requiredInCi: false, artifacts: [] },
    ])).toThrow(/registry-preflight-failed/);
    expect(() => assertNoV4CandidateArtifactRegistration(datasets.map((dataset) => ({ ...dataset, requiredInCi: dataset.split === 'twin' }))))
      .toThrow(/registry-preflight-failed/);
  });

  it('emits only a bounded failure code when preflight cannot produce aggregates', () => {
    const failure = closedFailureReceipt('source-preflight-failed', {
      RET007V4_SOURCE_SHA: 'not-a-sha', GITHUB_RUN_ID: 'not-a-run', GITHUB_REPOSITORY: 'bad',
      GITHUB_SERVER_URL: 'https://host.invalid', GITHUB_RUN_ATTEMPT: 'bad',
    });
    expect(failure).toMatchObject({
      outcome: 'rejected', failureCode: 'source-preflight-failed', executedSourceSha: null,
      workflowRefSha: null,
      workflowRun: { id: null, url: null, attempt: null }, disclosure: 'closed-aggregate-only',
    });
    expect(failure.kind).toBe('ret007v4-control-qualification-failure');
  });

  it('preflights before dynamic control loading and pins six blobs, the 4-ID set, and the twin role in the workflow', async () => {
    const runner = await readFile(resolve(REPO_ROOT, 'bench/lab/multihop/qualify-control-v4.ts'), 'utf8');
    expect(runner).not.toMatch(/compareRegisteredAdapters|compareAdapters|ComparisonReport|candidateId/);
    expect(runner).not.toMatch(/^import .*from ['"]\.\.\/(?:adapters|datasets|registered-adapters|runner)\//m);
    expect(runner.match(/await runtime\.run\(/g)).toHaveLength(1);
    expect(runner).toContain('for (const split of MULTIHOP_V4_RECEIPT_SPLITS)');
    expect(runner).toContain('loadRegisteredControl(repoRoot, runtime)');
    expect(runner).toContain('funnelTopN !== MULTIHOP_V4_FUNNEL_TOP_N');
    const execution = runner.slice(runner.indexOf('async function executeControlNodeEvidence'));
    expect(execution.indexOf('assertSourcePreflight(repoRoot, hosted.sourceSha)'))
      .toBeLessThan(execution.indexOf('const runtime = await loadControlRuntime()'));
    expect(execution.indexOf('assertRegistryCandidateAbsence(repoRoot)'))
      .toBeLessThan(execution.indexOf('const runtime = await loadControlRuntime()'));

    const identity = MULTIHOP_V4_FREEZE.controlSourceIdentity;
    expect(Object.keys(identity)).toEqual([
      'controlAdapterPath', 'controlAdapterGitBlob', 'productionCoreAdapterPath', 'productionCoreAdapterGitBlob',
      'registeredAdaptersGitBlob', 'runnerGitBlob', 'systemsRegistryGitBlob', 'experimentsRegistryGitBlob',
    ]);
    expect(identity.controlAdapterPath).toBe('bench/lab/adapters/memberry-retrieval-core-funnel.ts');
    expect(identity.productionCoreAdapterPath).toBe('bench/lab/adapters/memberry-retrieval-core.ts');
    const blobs = Object.values(identity).filter((value) => /^[0-9a-f]{40}$/.test(value));
    expect(blobs).toHaveLength(6);
    expect(new Set(blobs).size).toBe(6);
    expect(blobs).not.toContain('0'.repeat(40));

    const workflow = await readFile(resolve(REPO_ROOT, '.github/workflows/ret007-v4-control-qualification.yml'), 'utf8');
    expect(workflow).toContain('node-version: [20, 22]');
    expect(workflow).toContain('ref: ${{ inputs.source_sha }}');
    expect(workflow).toContain('[[ "$GITHUB_SHA" == "$RET007V4_SOURCE_SHA" ]]');
    expect(workflow).toContain(`git merge-base --is-ancestor ${MULTIHOP_V4_FREEZE.exactBaseCommit}`);
    expect(workflow.indexOf('No-dependency source, control, and candidate-absence preflight'))
      .toBeLessThan(workflow.indexOf('Install frozen dependencies without lifecycle scripts'));
    expect(workflow).toContain('npm ci --ignore-scripts');
    expect(workflow).toContain('git status --porcelain --untracked-files=all');
    expect(workflow).toContain('if: always()');
    expect(workflow).toContain('ret007v4-control-qualification-failure');
    expect(workflow).toContain('npm run bench:lab:multihop-v4:qualify-control');
    expect(workflow).toContain('npm run bench:lab:multihop-v4:join-control');
    expect(workflow).toContain('needs: [qualify-control]');
    expect(workflow).toContain('RET007V4_MATRIX_RESULT: ${{ needs.qualify-control.result }}');
    expect(workflow).toContain('RET007V4_TWIN_EVIDENCE_ROLE: recorded-evidence-only');
    expect(workflow).toContain('ret007v4-control-authority-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(workflow).toContain('"memberry-multihop-v4-calib", "memberry-multihop-v4-dev", "memberry-multihop-v4-holdout", "memberry-multihop-v4-twin"');
    expect(workflow).toContain('ret-?007-?v4|multi-?hop-v4|multihop-v4');
    const workflowAllowlists = [...workflow.matchAll(
      /expected="\$\(cat <<'PATHS' \| LC_ALL=C sort\n([\s\S]*?)\n\s+PATHS/g,
    )].map((match) => match[1]!.split('\n').map((line) => line.trim()).filter(Boolean));
    expect(workflowAllowlists).toHaveLength(2);
    for (const allowlist of workflowAllowlists) expect(allowlist).toEqual([...RET007V4_ALLOWED_SOURCE_PATHS]);
    for (const blob of blobs) expect(workflow.split(blob)).toHaveLength(3);
    expect(workflow).not.toMatch(/_BLOB\b/);
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
