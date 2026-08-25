import { describe, expect, it } from 'vitest';

import type { AdapterRunReport, ComparisonReport, ProbeMetrics } from '../../contracts/report.js';
import type { LabScenario } from '../../contracts/scenario.js';
import { averageMetrics, scoreProbe } from '../../metrics.js';
import {
  MULTIHOP_V3_CONTROL_ADAPTER_ID,
  MULTIHOP_V3_FREEZE,
  evaluateMultiHopV3Policy,
} from '../policy-v3.js';
import {
  qualifyMultiHopV3ControlReceipt,
  scoreMultiHopV3Comparison,
  type MultiHopV3ControlQualificationReceipt,
} from '../scorer-only-v3.js';

const ZERO_STATS = { memories: 0, queries: 0, feedbackEvents: 0 };
const LATER_CONTROL_RUN_ID = 'later-comparison-control-v3';
const CONTROL_SUCCESS = new Set([0, 1, 2, 3, 4, 5, 6, 7]);
type ResultMode = 'qualified-control' | 'complete' | 'identity' | 'second-lane-only' | 'complete-with-unknown';

function scenarios(split: 'dev' | 'holdout' = 'holdout'): LabScenario[] {
  return Array.from({ length: 20 }, (_, index) => {
    const prefix = `unit-v3-${split}-${String(index + 1).padStart(2, '0')}`;
    const density = ['low', 'medium', 'high'][index % 3]!;
    const memories = Array.from({ length: 17 }, (__, memoryIndex) => ({
      id: `${prefix}-m-${String(memoryIndex + 1).padStart(2, '0')}`,
      content: `Synthetic domain-neutral statement ${memoryIndex + 1} for ${prefix}.`,
      recordedAt: `2026-05-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    }));
    return {
      input: {
        version: '1.0.0', id: prefix, split,
        title: 'Synthetic multi-hop v3 scorer unit scenario',
        description: 'Synthetic scorer-only contract fixture.',
        dimensions: ['multi-hop'], tenant: 'synthetic-tenant', project: prefix,
        memories, queries: [{ id: `${prefix}-probe`, query: 'combine both synthetic statements', limit: 10 }],
        tags: ['synthetic', `density:${density}`],
      },
      oracle: {
        version: '1.0.0', scenarioId: prefix,
        probes: [{
          probeId: `${prefix}-probe`, relevant: [memories[0]!.id, memories[1]!.id],
          required: [memories[0]!.id, memories[1]!.id],
        }],
      },
    };
  });
}

function resultIds(scenario: LabScenario, index: number, mode: ResultMode): string[] {
  const ids = scenario.input.memories.map(({ id }) => id);
  const control = CONTROL_SUCCESS.has(index)
    ? [ids[0]!, ids[1]!, ...ids.slice(2, 10)]
    : [ids[0]!, ...ids.slice(2, 11)];
  if (mode === 'qualified-control' || mode === 'identity') return control;
  if (mode === 'complete') return [ids[0]!, ids[1]!, ...ids.slice(2, 10)];
  if (mode === 'second-lane-only') return [ids[1]!, ...ids.slice(2, 11)];
  return [ids[0]!, ids[1]!, ...ids.slice(2, 9), 'unknown-result-id'];
}

function arm(
  adapterId: string,
  fixtures: readonly LabScenario[],
  mode: ResultMode,
  runId = `run-${adapterId}`,
): AdapterRunReport {
  const scenarioReports = fixtures.map((scenario, index) => {
    const query = scenario.input.queries[0]!;
    const oracle = scenario.oracle.probes[0]!;
    const ids = resultIds(scenario, index, mode);
    const metrics = scoreProbe(scenario.input, oracle, query.limit, ids.map((id) => ({ id, score: 0 })));
    return {
      scenarioId: scenario.input.id, split: scenario.input.split, dimensions: scenario.input.dimensions,
      capabilityGaps: [], outcome: 'scored' as const,
      probes: [{ probeId: query.id, query: query.query, resultIds: ids, metrics }], metrics,
    };
  });
  return {
    contractVersion: '1.0.0', runId, adapterId, adapterName: adapterId,
    executionMode: 'fixture', health: 'ready', outcome: 'scored', excludedScenarios: [],
    scenarioReports, metrics: averageMetrics(scenarioReports.map(({ metrics }) => metrics)),
    stats: ZERO_STATS, gateFailures: [], passed: true,
  };
}

function comparison(fixtures: readonly LabScenario[], candidateMode: ResultMode): ComparisonReport {
  const control = arm(MULTIHOP_V3_CONTROL_ADAPTER_ID, fixtures, 'qualified-control', LATER_CONTROL_RUN_ID);
  const candidate = arm('synthetic-rescue-arm-v3', fixtures, candidateMode);
  const metrics = Object.keys(control.metrics) as Array<keyof ProbeMetrics>;
  return {
    runId: 'ret007-v3-synthetic-comparison', evidenceMode: 'registered-ci', control, candidate,
    deltas: metrics.map((metric) => ({
      metric, control: control.metrics[metric], candidate: candidate.metrics[metric],
      delta: candidate.metrics[metric] - control.metrics[metric],
    })),
    failures: [], passed: true,
  };
}

function splitReceipt() {
  return {
    n: 20, successes: 8, successRate: 0.4,
    strata: {
      low: { n: 7, successes: 3, failures: 4 },
      medium: { n: 7, successes: 3, failures: 4 },
      high: { n: 6, successes: 2, failures: 4 },
    },
  } as const;
}

function receipt(): MultiHopV3ControlQualificationReceipt {
  return {
    schemaVersion: '1.0.0', kind: 'ret007v3-control-qualification',
    instrument: 'memberry-multihop-v3', instrumentVersion: '3.0.0',
    exactBaseCommit: '52aa9d6c880b7a29a99fe5c2537d9e76589af3c6',
    seedCommitmentSha256: '79f4828348540695f7d7f23220c901d1135a19df51416993186db0f40c530f30',
    receiptId: 'ret007v3-987654321-attempt1-joined-node20-node22', createdAt: '2026-08-21T00:00:00.000Z',
    executedSourceSha: '1234567890abcdef1234567890abcdef12345678',
    workflowRefSha: '1234567890abcdef1234567890abcdef12345678',
    workflowRun: { id: '987654321', url: 'https://github.com/AP3X-Dev/memberry/actions/runs/987654321', attempt: 1 },
    producer: 'independent-scorer-custodian',
    runtime: { execution: 'hosted', platform: 'linux', nodeMajors: [20, 22] },
    controlAdapterId: MULTIHOP_V3_CONTROL_ADAPTER_ID,
    controlAdapterClass: 'production-core-fixture-adapter', controlExecutionMode: 'fixture',
    evidenceReceiptIds: {
      node20: 'ret007v3-987654321-attempt1-node20', node22: 'ret007v3-987654321-attempt1-node22',
    },
    qualificationRuns: {
      node20: {
        dev: { id: 'ret007v3-987654321-attempt1-node20-dev-control' },
        holdout: { id: 'ret007v3-987654321-attempt1-node20-holdout-control' },
      },
      node22: {
        dev: { id: 'ret007v3-987654321-attempt1-node22-dev-control' },
        holdout: { id: 'ret007v3-987654321-attempt1-node22-holdout-control' },
      },
    },
    controlSourceIdentity: MULTIHOP_V3_FREEZE.controlSourceIdentity,
    candidateAbsentAtQualification: true, candidateArtifactsObserved: false, candidateExecutionObserved: false,
    disclosure: 'closed-aggregate-only', artifactBindings: MULTIHOP_V3_FREEZE.artifacts,
    splits: { dev: splitReceipt(), holdout: splitReceipt() },
  };
}

describe('RET-007 v3 scorer-only qualification and strict paired metric', () => {
  it('qualifies only hosted production-control headroom with successes and failures in every stratum', () => {
    const qualified = qualifyMultiHopV3ControlReceipt(receipt());
    expect(qualified).toEqual({
      outcome: 'qualified', instrument: 'memberry-multihop-v3', instrumentVersion: '3.0.0',
      receiptId: 'ret007v3-987654321-attempt1-joined-node20-node22', controlAdapterId: MULTIHOP_V3_CONTROL_ADAPTER_ID,
      dev: { n: 20, successRate: 0.4, strataQualified: true },
      holdout: { n: 20, successRate: 0.4, strataQualified: true }, failures: [],
    });
    expect(Object.isFrozen(qualified)).toBe(true);
    expect(JSON.stringify(qualified)).not.toMatch(/scenarioId|probeId|query|resultIds|required|relevant|oracle|memory-|seed/i);
    expect('controlRunId' in receipt()).toBe(false);
  });

  it('rejects out-of-headroom aggregates and strata without both outcomes, without per-case disclosure', () => {
    const high = structuredClone(receipt()) as unknown as MultiHopV3ControlQualificationReceipt;
    (high.splits.dev as { n: number; successes: number; successRate: number; strata: Record<string, { n: number; successes: number; failures: number }> }).successes = 15;
    (high.splits.dev as { successRate: number }).successRate = 0.75;
    const highStrata = high.splits.dev.strata as Record<string, { n: number; successes: number; failures: number }>;
    Object.assign(highStrata.low, { successes: 6, failures: 1 });
    Object.assign(highStrata.medium, { successes: 5, failures: 2 });
    Object.assign(highStrata.high, { successes: 4, failures: 2 });
    expect(qualifyMultiHopV3ControlReceipt(high).failures).toContain('dev:success-rate-outside-headroom');

    const emptyLane = structuredClone(receipt()) as unknown as MultiHopV3ControlQualificationReceipt;
    (emptyLane.splits.dev as { successes: number; successRate: number }).successes = 11;
    (emptyLane.splits.dev as { successRate: number }).successRate = 0.55;
    const strata = emptyLane.splits.dev.strata as Record<string, { n: number; successes: number; failures: number }>;
    Object.assign(strata.low, { successes: 0, failures: 7 });
    Object.assign(strata.medium, { successes: 6, failures: 1 });
    Object.assign(strata.high, { successes: 5, failures: 1 });
    expect(qualifyMultiHopV3ControlReceipt(emptyLane).failures).toEqual(['dev:low:missing-success-or-failure']);
  });

  it('fails closed on an invalid joined runtime, candidate-observed, artifact-drifted, and per-case-bearing receipts', () => {
    const invalidJoinedRuntime = structuredClone(receipt()) as unknown as MultiHopV3ControlQualificationReceipt;
    (invalidJoinedRuntime.runtime as { platform: string }).platform = 'win32';
    expect(() => qualifyMultiHopV3ControlReceipt(invalidJoinedRuntime))
      .toThrow(/joined Node 20\+22 runtime mismatch/);

    const observed = structuredClone(receipt()) as unknown as MultiHopV3ControlQualificationReceipt;
    (observed as { candidateArtifactsObserved: boolean }).candidateArtifactsObserved = true;
    expect(() => qualifyMultiHopV3ControlReceipt(observed)).toThrow(/pre-candidate/);

    const drifted = structuredClone(receipt()) as unknown as MultiHopV3ControlQualificationReceipt;
    (drifted.artifactBindings.dev.input as { sha256: string }).sha256 = '0'.repeat(64);
    expect(() => qualifyMultiHopV3ControlReceipt(drifted)).toThrow(/artifact binding mismatch/);

    const leaking = { ...receipt(), perCaseOutcomes: [{ scenarioId: 'sealed', success: true }] };
    expect(() => qualifyMultiHopV3ControlReceipt(leaking as unknown as MultiHopV3ControlQualificationReceipt))
      .toThrow(/closed schema mismatch/);

    const perNodeKind = { ...receipt(), kind: 'ret007v3-control-qualification-node-evidence' };
    expect(() => qualifyMultiHopV3ControlReceipt(perNodeKind as unknown as MultiHopV3ControlQualificationReceipt))
      .toThrow(/joined authority kind/);
  });

  it('binds source, workflow, receipt, and both nodes run provenance by direct mutation', () => {
    const badReceiptId = structuredClone(receipt()) as unknown as MultiHopV3ControlQualificationReceipt;
    (badReceiptId as { receiptId: string }).receiptId = 'unbound-authority';
    expect(() => qualifyMultiHopV3ControlReceipt(badReceiptId)).toThrow(/receipt ID provenance/);

    const badWorkflow = structuredClone(receipt()) as unknown as MultiHopV3ControlQualificationReceipt;
    (badWorkflow.workflowRun as { id: string }).id = '987654322';
    expect(() => qualifyMultiHopV3ControlReceipt(badWorkflow)).toThrow(/workflow provenance|receipt ID provenance/);

    const badRun = structuredClone(receipt()) as unknown as MultiHopV3ControlQualificationReceipt;
    (badRun.qualificationRuns.node22.holdout as { id: string }).id = 'unbound-run';
    expect(() => qualifyMultiHopV3ControlReceipt(badRun)).toThrow(/run ID provenance/);

    const badSource = structuredClone(receipt()) as unknown as MultiHopV3ControlQualificationReceipt;
    (badSource as { executedSourceSha: string }).executedSourceSha = '0'.repeat(40);
    expect(() => qualifyMultiHopV3ControlReceipt(badSource)).toThrow(/receipt identity/);

    const badWorkflowRef = structuredClone(receipt()) as unknown as MultiHopV3ControlQualificationReceipt;
    (badWorkflowRef as { workflowRefSha: string }).workflowRefSha = 'f'.repeat(40);
    expect(() => qualifyMultiHopV3ControlReceipt(badWorkflowRef)).toThrow(/receipt identity/);
  });

  it('passes only a synthetic report that rescues both required hops without regression', () => {
    const fixtures = scenarios();
    const compared = comparison(fixtures, 'complete');
    const report = scoreMultiHopV3Comparison(fixtures, compared, receipt());
    expect(report).toMatchObject({
      metric: 'strict-multi-hop-task-success-v3', split: 'holdout', k: 10, n: 20,
      controlAdapterId: MULTIHOP_V3_CONTROL_ADAPTER_ID, candidateAdapterId: 'synthetic-rescue-arm-v3',
      controlSuccessRate: 0.4, candidateSuccessRate: 1, delta: 0.6,
    });
    expect(report.interval).toMatchObject({ outcome: 'measured', point: 0.6 });
    expect(evaluateMultiHopV3Policy(report, compared)).toEqual([]);
    expect(scoreMultiHopV3Comparison(fixtures, compared, receipt())).toEqual(report);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.interval)).toBe(true);
    expect(Object.keys(report)).toEqual([
      'metric', 'split', 'k', 'n', 'controlAdapterId', 'candidateAdapterId',
      'controlSuccessRate', 'candidateSuccessRate', 'delta', 'interval',
    ]);
    expect(Object.keys(report.interval)).toEqual([
      'outcome', 'pairedProbes', 'resamples', 'level', 'point', 'lower', 'upper', 'oneSidedLower',
    ]);
    expect(JSON.stringify(report)).not.toMatch(/scenarioId|probeId|query|resultIds|required|relevant|oracle|unit-v3|memory-|seed/i);
  });

  it('red-lights identity/no-op and one-lane substitution mutations', () => {
    const fixtures = scenarios();
    const identityComparison = comparison(fixtures, 'identity');
    const identity = scoreMultiHopV3Comparison(fixtures, identityComparison, receipt());
    expect(identity.delta).toBe(0);
    expect(evaluateMultiHopV3Policy(identity, identityComparison)).toContain('point-delta-not-positive');

    const oneLaneComparison = comparison(fixtures, 'second-lane-only');
    const oneLane = scoreMultiHopV3Comparison(fixtures, oneLaneComparison, receipt());
    expect(oneLane.candidateSuccessRate).toBe(0);
    expect(evaluateMultiHopV3Policy(oneLane, oneLaneComparison)).toEqual(expect.arrayContaining([
      'point-delta-not-positive', 'one-sided-lower-below-zero', 'quality-regression:answerCoverage',
    ]));
  });

  it('red-lights wrong adapter identities while allowing a later comparison run with matching aggregate', () => {
    const fixtures = scenarios();
    const wrongControl = comparison(fixtures, 'complete');
    wrongControl.control.adapterId = 'fixture-control';
    expect(() => scoreMultiHopV3Comparison(fixtures, wrongControl, receipt())).toThrow(/control adapter\/mode/);

    const sameId = comparison(fixtures, 'complete');
    sameId.candidate.adapterId = MULTIHOP_V3_CONTROL_ADAPTER_ID;
    expect(() => scoreMultiHopV3Comparison(fixtures, sameId, receipt())).toThrow(/distinct from the production control/);

    const wrongMode = comparison(fixtures, 'complete');
    wrongMode.candidate.executionMode = 'live';
    expect(() => scoreMultiHopV3Comparison(fixtures, wrongMode, receipt())).toThrow(/candidate arm must be fixture/);

    const laterRun = comparison(fixtures, 'complete');
    laterRun.control.runId = 'independent-later-control-rerun';
    expect(scoreMultiHopV3Comparison(fixtures, laterRun, receipt()).controlSuccessRate).toBe(0.4);

    const wrongStrata = structuredClone(receipt()) as unknown as MultiHopV3ControlQualificationReceipt;
    const strata = wrongStrata.splits.holdout.strata as Record<string, { n: number; successes: number; failures: number }>;
    Object.assign(strata.low, { successes: 2, failures: 5 });
    Object.assign(strata.medium, { successes: 4, failures: 3 });
    expect(() => scoreMultiHopV3Comparison(fixtures, comparison(fixtures, 'complete'), wrongStrata))
      .toThrow(/control aggregate does not match qualified receipt/);
  });

  it('red-lights result/metric inconsistency and any standard-metric regression', () => {
    const fixtures = scenarios();
    const tampered = comparison(fixtures, 'complete');
    tampered.candidate.scenarioReports[0]!.probes[0]!.resultIds = ['unknown-result-id'];
    expect(() => scoreMultiHopV3Comparison(fixtures, tampered, receipt())).toThrow(/does not match result IDs/);

    const regressingComparison = comparison(fixtures, 'complete-with-unknown');
    const regressing = scoreMultiHopV3Comparison(fixtures, regressingComparison, receipt());
    expect(regressing.candidateSuccessRate).toBe(1);
    expect(evaluateMultiHopV3Policy(regressing, regressingComparison)).toContain('safety-regression:unknownResultRate');
  });
});
