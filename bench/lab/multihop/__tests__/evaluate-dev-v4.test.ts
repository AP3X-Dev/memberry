// RET-007 v4 D5 — dev-evaluation apparatus: closed aggregates, pins, and the three deliberate differences.

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { AdapterRunReport } from '../../contracts/report.js';
import type { LabScenario } from '../../contracts/scenario.js';
import { averageMetrics, scoreProbe } from '../../metrics.js';
import { MULTIHOP_V4_FREEZE } from '../policy-v4.js';
import { RET007V4_ALLOWED_SOURCE_PATHS } from '../qualify-control-v4.js';
import {
  RET007V4_CANDIDATE_ADAPTER_IDS,
  RET007V4_DEV_ALLOWED_SOURCE_PATHS,
  RET007V4_DEV_APPROVED_GIT_BLOBS,
  RET007V4_DEV_EXACT_BASE_COMMIT,
  RET007V4_TWIN_WORDING,
  assertDevSourceChangedPaths,
  closedEvaluationFailureReceipt,
  computeArmSplitAggregate,
  computeCalibGatePrecision,
  joinDevEvaluationEvidence,
  twinInterpretation,
} from '../evaluate-dev-v4.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const ZERO_STATS = { memories: 0, queries: 0, feedbackEvents: 0 };
const SIZES = { calib: 45, dev: 60, twin: 30 } as const;
const DENSITY_COUNTS = {
  calib: { low: 15, medium: 15, high: 15 },
  dev: { low: 20, medium: 20, high: 20 },
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
    const prefix = `dev-eval-unit-${split}-${String(index + 1).padStart(3, '0')}`;
    const memories = Array.from({ length: 22 }, (__, memoryIndex) => ({
      id: `${prefix}-m-${memoryIndex}`, content: `Statement ${memoryIndex} for ${prefix}.`,
      recordedAt: '2026-08-20T00:00:00.000Z',
    }));
    return {
      input: {
        version: '1.0.0', id: prefix, split: split as never, title: 'Unit', description: 'Synthetic.',
        dimensions: ['multi-hop'], tenant: 'synthetic', project: prefix, memories,
        queries: [{ id: `${prefix}-probe`, query: `combine both facts ${index}`, limit: 10 }],
        tags: ['synthetic', `density:${densityFor(split, index)}`],
      },
      oracle: {
        version: '1.0.0', scenarioId: prefix,
        probes: [{ probeId: `${prefix}-probe`, relevant: [memories[0]!.id, memories[1]!.id], required: [memories[0]!.id, memories[1]!.id] }],
      },
    };
  });
}

/** Success on indices where `succeed(index)`. */
function report(adapterId: string, fixtures: readonly LabScenario[], succeed: (index: number) => boolean): AdapterRunReport {
  const scenarioReports = fixtures.map((scenario, index) => {
    const ids = scenario.input.memories.map(({ id }) => id);
    const resultIds = succeed(index) ? [ids[0]!, ids[1]!, ...ids.slice(2, 10)] : [ids[0]!, ...ids.slice(2, 11)];
    const query = scenario.input.queries[0]!;
    const metrics = scoreProbe(scenario.input, scenario.oracle.probes[0]!, query.limit, resultIds.map((id) => ({ id, score: 0 })));
    return {
      scenarioId: scenario.input.id, split: scenario.input.split, dimensions: scenario.input.dimensions,
      capabilityGaps: [], outcome: 'scored' as const,
      probes: [{ probeId: query.id, query: query.query, resultIds, metrics }], metrics,
    };
  });
  return {
    contractVersion: '1.0.0', runId: 'dev-eval-unit', adapterId, adapterName: adapterId, executionMode: 'fixture',
    health: 'ready', outcome: 'scored', excludedScenarios: [], scenarioReports,
    metrics: averageMetrics(scenarioReports.map(({ metrics }) => metrics)), stats: ZERO_STATS, gateFailures: [], passed: true,
  };
}

const CLOSED_LEAK = /scenarioId|probeId|"query"|resultIds|required|relevant|oracle|bridge:|perCase|seed/;

describe('RET-007 v4 dev-evaluation apparatus', () => {
  it('pins the D5 base, an envelope that is NOT the qualification envelope, and the six blobs against the working tree', () => {
    expect(RET007V4_DEV_EXACT_BASE_COMMIT).toBe('36e4c0050c8651b81bf9119fd68083adc12c7b31');
    expect([...RET007V4_DEV_ALLOWED_SOURCE_PATHS]).toEqual([...RET007V4_DEV_ALLOWED_SOURCE_PATHS].sort());
    expect(RET007V4_DEV_ALLOWED_SOURCE_PATHS).not.toEqual(RET007V4_ALLOWED_SOURCE_PATHS);
    expect(RET007V4_DEV_ALLOWED_SOURCE_PATHS).toContain('packages/retrieval/src/multihop-expansion.ts');
    expect(() => assertDevSourceChangedPaths([...RET007V4_DEV_ALLOWED_SOURCE_PATHS])).not.toThrow();
    expect(() => assertDevSourceChangedPaths([...RET007V4_ALLOWED_SOURCE_PATHS])).toThrow(/source-preflight-failed/);
    // Difference (b): funnel / core / runner / experiments pins unchanged from D3; the two moved blobs re-pinned here.
    expect(RET007V4_DEV_APPROVED_GIT_BLOBS['bench/lab/adapters/memberry-retrieval-core-funnel.ts']).toBe(MULTIHOP_V4_FREEZE.controlSourceIdentity.controlAdapterGitBlob);
    expect(RET007V4_DEV_APPROVED_GIT_BLOBS['bench/lab/adapters/memberry-retrieval-core.ts']).toBe(MULTIHOP_V4_FREEZE.controlSourceIdentity.productionCoreAdapterGitBlob);
    expect(RET007V4_DEV_APPROVED_GIT_BLOBS['bench/lab/runner.ts']).toBe(MULTIHOP_V4_FREEZE.controlSourceIdentity.runnerGitBlob);
    expect(RET007V4_DEV_APPROVED_GIT_BLOBS['bench/lab/registry/experiments.json']).toBe(MULTIHOP_V4_FREEZE.controlSourceIdentity.experimentsRegistryGitBlob);
    expect(RET007V4_DEV_APPROVED_GIT_BLOBS['bench/lab/registered-adapters.ts']).not.toBe(MULTIHOP_V4_FREEZE.controlSourceIdentity.registeredAdaptersGitBlob);
    for (const [path, blob] of Object.entries(RET007V4_DEV_APPROVED_GIT_BLOBS)) {
      const actual = execFileSync('git', ['hash-object', path], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
      expect(`${path}:${actual}`).toBe(`${path}:${blob}`);
    }
  });

  it('never references the holdout loader and mirrors the workflow pins (difference (c))', async () => {
    const source = await readFile(resolve(REPO_ROOT, 'bench/lab/multihop/evaluate-dev-v4.ts'), 'utf8');
    expect(source).not.toMatch(/loadMultiHopV4ScenariosForScoring\('holdout'|'holdout'\s*\)/);
    expect(source).not.toContain('assertNoV4CandidateRegistration');
    const workflow = await readFile(resolve(REPO_ROOT, '.github/workflows/ret007-v4-dev-evaluation.yml'), 'utf8');
    expect(workflow).toContain(RET007V4_DEV_EXACT_BASE_COMMIT);
    for (const [path, blob] of Object.entries(RET007V4_DEV_APPROVED_GIT_BLOBS)) expect(workflow).toContain(`${path}")" == ${blob}`);
    for (const path of RET007V4_DEV_ALLOWED_SOURCE_PATHS) expect(workflow).toContain(`\n          ${path}\n`);
    expect(workflow).not.toMatch(/marker = re\.compile/);
    expect(workflow).toContain('bench:lab:multihop-v4:evaluate-dev');
    expect(workflow).toContain('bench:lab:multihop-v4:join-dev');
    expect(workflow).not.toContain('holdout/');
    const pkg = JSON.parse(await readFile(resolve(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['bench:lab:multihop-v4:evaluate-dev']).toBe('tsx bench/lab/multihop/evaluate-dev-v4.ts node');
    expect(pkg.scripts['bench:lab:multihop-v4:join-dev']).toBe('tsx bench/lab/multihop/evaluate-dev-v4.ts join');
  });

  it('computes closed per-arm split aggregates and calib gate precision without per-case values', () => {
    const dev = scenarios('dev');
    const control = computeArmSplitAggregate('dev', dev, report('memberry-retrieval-core-funnel-v1', dev, (index) => index % 2 === 0));
    expect(control).toEqual({
      n: 60, successes: 30, successRate: 0.5,
      strata: { low: { n: 20, successes: 10, failures: 10 }, medium: { n: 20, successes: 10, failures: 10 }, high: { n: 20, successes: 10, failures: 10 } },
    });
    expect(computeArmSplitAggregate('twin', scenarios('twin'), report('x', scenarios('twin'), () => true)).successes).toBe(30);
    expect(() => computeArmSplitAggregate('dev', scenarios('twin'), report('x', scenarios('twin'), () => true))).toThrow(/evaluation-aggregate-invalid/);

    const calib = scenarios('calib');
    const candidateId = RET007V4_CANDIDATE_ADAPTER_IDS['evidence-bridge'];
    const firings = new Map(calib.map((scenario, index) => [`${scenario.input.project} ${scenario.input.queries[0]!.query}`, index % 3 === 0]));
    const gate = computeCalibGatePrecision(calib, report(candidateId, calib, (index) => index % 2 === 0), firings);
    expect(gate).toMatchObject({ n: 45, fired: 15, firedRate: 15 / 45, firedAndSucceeded: 8, precision: 8 / 15 });
    expect(JSON.stringify({ control, gate })).not.toMatch(CLOSED_LEAK);
    expect(() => computeCalibGatePrecision(calib, report(candidateId, calib, () => true), new Map())).toThrow(/evaluation-aggregate-invalid/);
  });

  it('applies the interpretive twin wording rule', () => {
    expect(twinInterpretation(0.1, 0.2)).toBe(RET007V4_TWIN_WORDING.evidenceConditioned);
    expect(twinInterpretation(0.05, 0.2)).toBe(RET007V4_TWIN_WORDING.bridgeSpecific);
    expect(twinInterpretation(0.3, 0)).toBe(RET007V4_TWIN_WORDING.noGain);
  });

  it('join requires byte-identical evaluations from Node 20 and 22 bound to the same hosted run', () => {
    const environment: NodeJS.ProcessEnv = {
      RET007V4_SOURCE_SHA: '1234567890abcdef1234567890abcdef12345678', GITHUB_SHA: '1234567890abcdef1234567890abcdef12345678',
      GITHUB_RUN_ID: '987654321', GITHUB_REPOSITORY: 'AP3X-Dev/memberry', GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_RUN_ATTEMPT: '1', RET007V4_TWIN_EVIDENCE_ROLE: 'recorded-evidence-only', RET007V4_POLICY: 'evidence-bridge',
    };
    const evaluation = { policy: 'evidence-bridge', dev: { passed: false } };
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    const evaluationSha256 = createHash('sha256').update(JSON.stringify(evaluation)).digest('hex');
    const node = (nodeMajor: 20 | 22) => ({
      schemaVersion: '1.0.0', kind: 'ret007v4-dev-evaluation-node-evidence',
      receipt: {
        receiptId: `ret007v4-dev-987654321-attempt1-node${nodeMajor}`, createdAt: '2026-08-25T00:00:00.000Z',
        executedSourceSha: environment.RET007V4_SOURCE_SHA, workflowRefSha: environment.GITHUB_SHA,
        workflowRun: { id: '987654321', url: 'https://github.com/AP3X-Dev/memberry/actions/runs/987654321', attempt: 1 },
        runtime: { execution: 'hosted', platform: 'linux', nodeMajor },
        exactBaseCommit: RET007V4_DEV_EXACT_BASE_COMMIT, instrument: 'memberry-multihop-v4', instrumentVersion: '4.0.0',
        artifactBindings: MULTIHOP_V4_FREEZE.artifacts, approvedGitBlobs: RET007V4_DEV_APPROVED_GIT_BLOBS,
        disclosure: 'closed-aggregate-only', splitsExecuted: ['dev', 'twin', 'calib'], holdoutTouched: false,
      },
      evaluation, evaluationSha256,
    });
    const linux = process.platform === 'linux';
    if (!linux) {
      expect(() => joinDevEvaluationEvidence(node(20), node(22), 'success', environment)).toThrow(/invalid-hosted-provenance/);
      return;
    }
    const joined = joinDevEvaluationEvidence(node(20), node(22), 'success', environment);
    expect(joined.kind).toBe('ret007v4-dev-evaluation');
    expect(joined.receipt.runtime).toEqual({ execution: 'hosted', platform: 'linux', nodeMajors: [20, 22] });
    expect(joined.evaluationSha256).toBe(evaluationSha256);
    const divergent = node(22);
    divergent.evaluationSha256 = 'f'.repeat(64);
    expect(() => joinDevEvaluationEvidence(node(20), divergent, 'success', environment)).toThrow(/evaluation-aggregate-invalid/);
    expect(() => joinDevEvaluationEvidence(node(20), node(22), 'failure', environment)).toThrow(/evaluation-execution-failed/);
  });

  it('emits a closed failure receipt with no aggregates', () => {
    const receipt = closedEvaluationFailureReceipt('control-receipt-invalid', { RET007V4_SOURCE_SHA: 'nope' });
    expect(receipt).toMatchObject({ outcome: 'rejected', failureCode: 'control-receipt-invalid', executedSourceSha: null, disclosure: 'closed-aggregate-only' });
    expect(JSON.stringify(receipt)).not.toMatch(CLOSED_LEAK);
  });
});
