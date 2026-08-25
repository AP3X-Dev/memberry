import { describe, expect, it } from 'vitest';

import type { AdapterRunReport, ComparisonReport, ProbeMetrics } from '../../contracts/report.js';
import type { LabScenario } from '../../contracts/scenario.js';
import { averageMetrics, scoreProbe } from '../../metrics.js';
import {
  MULTIHOP_V4_CONTROL_ADAPTER_ID,
  MULTIHOP_V4_FREEZE,
  evaluateMultiHopV4Policy,
} from '../policy-v4.js';
import {
  MULTIHOP_V4_RECEIPT_SPLITS,
  MULTIHOP_V4_VERDICT_SPLITS,
  qualifyMultiHopV4ControlReceipt,
  scoreMultiHopV4Comparison,
  type MultiHopV4ControlQualificationReceipt,
  type MultiHopV4SplitReceipt,
} from '../scorer-only-v4.js';

const ZERO_STATS = { memories: 0, queries: 0, feedbackEvents: 0 };
const LATER_CONTROL_RUN_ID = 'later-comparison-control-v4';
type ResultMode = 'qualified-control' | 'complete' | 'identity' | 'second-lane-only' | 'complete-with-unknown';
const SIZES = { dev: 60, holdout: 100 } as const;
const DENSITY_COUNTS = {
  dev: { low: 20, medium: 20, high: 20 },
  holdout: { low: 34, medium: 33, high: 33 },
} as const;

function densityFor(split: 'dev' | 'holdout', index: number): 'low' | 'medium' | 'high' {
  const counts = DENSITY_COUNTS[split];
  if (index < counts.low) return 'low';
  if (index < counts.low + counts.medium) return 'medium';
  return 'high';
}

/** Control succeeds on the first half of each stratum (dev 30/60 = 0.5; holdout 17+16+16 = 49/100). */
function controlSucceeds(split: 'dev' | 'holdout', index: number): boolean {
  const counts = DENSITY_COUNTS[split];
  const offsets = { low: 0, medium: counts.low, high: counts.low + counts.medium };
  const density = densityFor(split, index);
  return index - offsets[density] < Math.floor(counts[density] / 2);
}

function scenarios(split: 'dev' | 'holdout' = 'holdout'): LabScenario[] {
  return Array.from({ length: SIZES[split] }, (_, index) => {
    const prefix = `unit-v4-${split}-${String(index + 1).padStart(3, '0')}`;
    const density = densityFor(split, index);
    const memories = Array.from({ length: 22 }, (__, memoryIndex) => ({
      id: `${prefix}-m-${String(memoryIndex + 1).padStart(2, '0')}`,
      content: `Synthetic domain-neutral statement ${memoryIndex + 1} for ${prefix}.`,
      recordedAt: `2026-05-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    }));
    return {
      input: {
        version: '1.0.0', id: prefix, split,
        title: 'Synthetic multi-hop v4 scorer unit scenario',
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
  const split = scenario.input.split as 'dev' | 'holdout';
  const control = controlSucceeds(split, index)
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
  const control = arm(MULTIHOP_V4_CONTROL_ADAPTER_ID, fixtures, 'qualified-control', LATER_CONTROL_RUN_ID);
  const candidate = arm('synthetic-rescue-arm-v4', fixtures, candidateMode);
  const metrics = Object.keys(control.metrics) as Array<keyof ProbeMetrics>;
  return {
    runId: 'ret007-v4-synthetic-comparison', evidenceMode: 'registered-ci', control, candidate,
    deltas: metrics.map((metric) => ({
      metric, control: control.metrics[metric], candidate: candidate.metrics[metric],
      delta: candidate.metrics[metric] - control.metrics[metric],
    })),
    failures: [], passed: true,
  };
}

function splitReceipt(split: 'dev' | 'holdout' | 'twin'): MultiHopV4SplitReceipt {
  if (split === 'dev') {
    return {
      n: 60, successes: 30, successRate: 0.5,
      strata: { low: { n: 20, successes: 10, failures: 10 }, medium: { n: 20, successes: 10, failures: 10 }, high: { n: 20, successes: 10, failures: 10 } },
    };
  }
  if (split === 'holdout') {
    return {
      n: 100, successes: 49, successRate: 0.49,
      strata: { low: { n: 34, successes: 17, failures: 17 }, medium: { n: 33, successes: 16, failures: 17 }, high: { n: 33, successes: 16, failures: 17 } },
    };
  }
  return {
    n: 30, successes: 14, successRate: 14 / 30,
    strata: { low: { n: 10, successes: 5, failures: 5 }, medium: { n: 10, successes: 4, failures: 6 }, high: { n: 10, successes: 5, failures: 5 } },
  };
}

function artifactBindings() {
  return { dev: MULTIHOP_V4_FREEZE.artifacts.dev, holdout: MULTIHOP_V4_FREEZE.artifacts.holdout, twin: MULTIHOP_V4_FREEZE.artifacts.twin };
}

function receipt(): MultiHopV4ControlQualificationReceipt {
  const runs = (node: 20 | 22) => ({
    dev: { id: `ret007v4-987654321-attempt1-node${node}-dev-control` },
    holdout: { id: `ret007v4-987654321-attempt1-node${node}-holdout-control` },
    twin: { id: `ret007v4-987654321-attempt1-node${node}-twin-control` },
  });
  return {
    schemaVersion: '1.0.0', kind: 'ret007v4-control-qualification',
    instrument: 'memberry-multihop-v4', instrumentVersion: '4.0.0',
    exactBaseCommit: MULTIHOP_V4_FREEZE.exactBaseCommit,
    seedCommitmentSha256: MULTIHOP_V4_FREEZE.seedCommitmentSha256,
    funnelTopN: 12,
    receiptId: 'ret007v4-987654321-attempt1-joined-node20-node22', createdAt: '2026-08-25T00:00:00.000Z',
    executedSourceSha: '1234567890abcdef1234567890abcdef12345678',
    workflowRefSha: '1234567890abcdef1234567890abcdef12345678',
    workflowRun: { id: '987654321', url: 'https://github.com/AP3X-Dev/memberry/actions/runs/987654321', attempt: 1 },
    producer: 'independent-scorer-custodian',
    runtime: { execution: 'hosted', platform: 'linux', nodeMajors: [20, 22] },
    controlAdapterId: MULTIHOP_V4_CONTROL_ADAPTER_ID,
    controlAdapterClass: 'production-core-fixture-adapter', controlExecutionMode: 'fixture',
    evidenceReceiptIds: {
      node20: 'ret007v4-987654321-attempt1-node20', node22: 'ret007v4-987654321-attempt1-node22',
    },
    qualificationRuns: { node20: runs(20), node22: runs(22) },
    controlSourceIdentity: MULTIHOP_V4_FREEZE.controlSourceIdentity,
    candidateAbsentAtQualification: true, candidateArtifactsObserved: false, candidateExecutionObserved: false,
    disclosure: 'closed-aggregate-only', artifactBindings: artifactBindings(),
    splits: { dev: splitReceipt('dev'), holdout: splitReceipt('holdout'), twin: splitReceipt('twin') },
    twinEvidence: { role: 'recorded-evidence-only', verdictTerm: false },
  };
}

type Mutable = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('RET-007 v4 scorer-only qualification and strict paired metric', () => {
  it('qualifies only hosted funnel-control headroom on dev AND holdout, recording the twin as evidence only', () => {
    expect(MULTIHOP_V4_RECEIPT_SPLITS).toEqual(['dev', 'holdout', 'twin']);
    expect(MULTIHOP_V4_VERDICT_SPLITS).toEqual(['dev', 'holdout']);
    expect(MULTIHOP_V4_CONTROL_ADAPTER_ID).toBe('memberry-retrieval-core-funnel-v1');
    const qualified = qualifyMultiHopV4ControlReceipt(receipt());
    expect(qualified).toEqual({
      outcome: 'qualified', instrument: 'memberry-multihop-v4', instrumentVersion: '4.0.0',
      receiptId: 'ret007v4-987654321-attempt1-joined-node20-node22', controlAdapterId: MULTIHOP_V4_CONTROL_ADAPTER_ID,
      dev: { n: 60, successRate: 0.5, strataQualified: true },
      holdout: { n: 100, successRate: 0.49, strataQualified: true },
      twinEvidence: { n: 30, successRate: 14 / 30, verdictTerm: false },
      failures: [],
    });
    expect(Object.isFrozen(qualified)).toBe(true);
    expect(JSON.stringify(qualified)).not.toMatch(/scenarioId|probeId|query|resultIds|required|relevant|oracle|memory-|seed/i);
  });

  it('never lets the twin split become a verdict term (out-of-band or unmixed twin still qualifies)', () => {
    const extreme = structuredClone(receipt()) as Mutable;
    extreme.splits.twin = {
      n: 30, successes: 30, successRate: 1,
      strata: { low: { n: 10, successes: 10, failures: 0 }, medium: { n: 10, successes: 10, failures: 0 }, high: { n: 10, successes: 10, failures: 0 } },
    };
    const report = qualifyMultiHopV4ControlReceipt(extreme as MultiHopV4ControlQualificationReceipt);
    expect(report.outcome).toBe('qualified');
    expect(report.failures).toEqual([]);
    expect(report.twinEvidence).toEqual({ n: 30, successRate: 1, verdictTerm: false });
    // But its shape and internal consistency are still enforced.
    const inconsistent = structuredClone(receipt()) as Mutable;
    inconsistent.splits.twin.successes = 15;
    expect(() => qualifyMultiHopV4ControlReceipt(inconsistent as MultiHopV4ControlQualificationReceipt)).toThrow(/invalid closed aggregate counts/);
    const wrongN = structuredClone(receipt()) as Mutable;
    wrongN.splits.twin.n = 31;
    expect(() => qualifyMultiHopV4ControlReceipt(wrongN as MultiHopV4ControlQualificationReceipt)).toThrow(/invalid closed aggregate counts/);
    const roleMissing = structuredClone(receipt()) as Mutable;
    delete roleMissing.twinEvidence;
    expect(() => qualifyMultiHopV4ControlReceipt(roleMissing as MultiHopV4ControlQualificationReceipt)).toThrow(/closed schema mismatch/);
    const roleWrong = structuredClone(receipt()) as Mutable;
    roleWrong.twinEvidence.verdictTerm = true;
    expect(() => qualifyMultiHopV4ControlReceipt(roleWrong as MultiHopV4ControlQualificationReceipt)).toThrow(/never a verdict term/);
    const noTwin = structuredClone(receipt()) as Mutable;
    delete noTwin.splits.twin;
    expect(() => qualifyMultiHopV4ControlReceipt(noTwin as MultiHopV4ControlQualificationReceipt)).toThrow(/closed schema mismatch/);
  });

  it('rejects out-of-headroom aggregates and strata without both outcomes, on either verdict split', () => {
    const high = structuredClone(receipt()) as Mutable;
    high.splits.dev = {
      n: 60, successes: 45, successRate: 0.75,
      strata: { low: { n: 20, successes: 15, failures: 5 }, medium: { n: 20, successes: 15, failures: 5 }, high: { n: 20, successes: 15, failures: 5 } },
    };
    expect(qualifyMultiHopV4ControlReceipt(high as MultiHopV4ControlQualificationReceipt).failures).toEqual(['dev:success-rate-outside-headroom']);

    const emptyLane = structuredClone(receipt()) as Mutable;
    emptyLane.splits.holdout = {
      n: 100, successes: 50, successRate: 0.5,
      strata: { low: { n: 34, successes: 0, failures: 34 }, medium: { n: 33, successes: 25, failures: 8 }, high: { n: 33, successes: 25, failures: 8 } },
    };
    expect(qualifyMultiHopV4ControlReceipt(emptyLane as MultiHopV4ControlQualificationReceipt).failures).toEqual(['holdout:low:missing-success-or-failure']);
  });

  it('fails closed on invalid runtime, candidate-observed, artifact-drifted, wrong top-N, and per-case-bearing receipts', () => {
    const invalidJoinedRuntime = structuredClone(receipt()) as Mutable;
    invalidJoinedRuntime.runtime.platform = 'win32';
    expect(() => qualifyMultiHopV4ControlReceipt(invalidJoinedRuntime as MultiHopV4ControlQualificationReceipt))
      .toThrow(/joined Node 20\+22 runtime mismatch/);

    const observed = structuredClone(receipt()) as Mutable;
    observed.candidateArtifactsObserved = true;
    expect(() => qualifyMultiHopV4ControlReceipt(observed as MultiHopV4ControlQualificationReceipt)).toThrow(/pre-candidate/);

    const drifted = structuredClone(receipt()) as Mutable;
    drifted.artifactBindings.twin.input.sha256 = '0'.repeat(64);
    expect(() => qualifyMultiHopV4ControlReceipt(drifted as MultiHopV4ControlQualificationReceipt)).toThrow(/artifact binding mismatch/);

    const wrongTopN = structuredClone(receipt()) as Mutable;
    wrongTopN.funnelTopN = 14;
    expect(() => qualifyMultiHopV4ControlReceipt(wrongTopN as MultiHopV4ControlQualificationReceipt)).toThrow(/freeze identity mismatch/);

    const wrongIdentity = structuredClone(receipt()) as Mutable;
    wrongIdentity.controlSourceIdentity = { ...wrongIdentity.controlSourceIdentity, controlAdapterGitBlob: '0'.repeat(40) };
    expect(() => qualifyMultiHopV4ControlReceipt(wrongIdentity as MultiHopV4ControlQualificationReceipt)).toThrow(/control source identity mismatch/);

    const leaking = { ...receipt(), perCaseOutcomes: [{ scenarioId: 'sealed', success: true }] };
    expect(() => qualifyMultiHopV4ControlReceipt(leaking as unknown as MultiHopV4ControlQualificationReceipt))
      .toThrow(/closed schema mismatch/);

    const perNodeKind = { ...receipt(), kind: 'ret007v4-control-qualification-node-evidence' };
    expect(() => qualifyMultiHopV4ControlReceipt(perNodeKind as unknown as MultiHopV4ControlQualificationReceipt))
      .toThrow(/joined authority kind/);
  });

  it('binds source, workflow, receipt, and both nodes run provenance (incl. the twin run) by direct mutation', () => {
    const badReceiptId = structuredClone(receipt()) as Mutable;
    badReceiptId.receiptId = 'unbound-authority';
    expect(() => qualifyMultiHopV4ControlReceipt(badReceiptId as MultiHopV4ControlQualificationReceipt)).toThrow(/receipt ID provenance/);

    const badRun = structuredClone(receipt()) as Mutable;
    badRun.qualificationRuns.node22.twin.id = 'unbound-run';
    expect(() => qualifyMultiHopV4ControlReceipt(badRun as MultiHopV4ControlQualificationReceipt)).toThrow(/run ID provenance/);

    const badSource = structuredClone(receipt()) as Mutable;
    badSource.executedSourceSha = '0'.repeat(40);
    expect(() => qualifyMultiHopV4ControlReceipt(badSource as MultiHopV4ControlQualificationReceipt)).toThrow(/receipt identity/);
  });

  it('passes only a synthetic report that rescues both required hops without regression (dev n=60, holdout n=100)', () => {
    for (const split of ['dev', 'holdout'] as const) {
      const fixtures = scenarios(split);
      const compared = comparison(fixtures, 'complete');
      const report = scoreMultiHopV4Comparison(fixtures, compared, receipt());
      expect(report).toMatchObject({
        metric: 'strict-multi-hop-task-success-v4', split, k: 10, n: SIZES[split],
        controlAdapterId: MULTIHOP_V4_CONTROL_ADAPTER_ID, candidateAdapterId: 'synthetic-rescue-arm-v4',
        controlSuccessRate: splitReceipt(split).successRate, candidateSuccessRate: 1,
      });
      expect(report.interval).toMatchObject({ outcome: 'measured' });
      expect(evaluateMultiHopV4Policy(report, compared)).toEqual([]);
      expect(scoreMultiHopV4Comparison(fixtures, compared, receipt())).toEqual(report);
      expect(Object.isFrozen(report)).toBe(true);
      expect(Object.keys(report)).toEqual([
        'metric', 'split', 'k', 'n', 'controlAdapterId', 'candidateAdapterId',
        'controlSuccessRate', 'candidateSuccessRate', 'delta', 'interval',
      ]);
      expect(JSON.stringify(report)).not.toMatch(/scenarioId|probeId|query|resultIds|required|relevant|oracle|unit-v4|memory-|seed/i);
    }
  });

  it('red-lights identity/no-op and one-lane substitution mutations', () => {
    const fixtures = scenarios();
    const identityComparison = comparison(fixtures, 'identity');
    const identity = scoreMultiHopV4Comparison(fixtures, identityComparison, receipt());
    expect(identity.delta).toBe(0);
    expect(evaluateMultiHopV4Policy(identity, identityComparison)).toContain('point-delta-not-positive');

    const oneLaneComparison = comparison(fixtures, 'second-lane-only');
    const oneLane = scoreMultiHopV4Comparison(fixtures, oneLaneComparison, receipt());
    expect(oneLane.candidateSuccessRate).toBe(0);
    expect(evaluateMultiHopV4Policy(oneLane, oneLaneComparison)).toEqual(expect.arrayContaining([
      'point-delta-not-positive', 'one-sided-lower-below-zero', 'quality-regression:answerCoverage',
    ]));
  });

  it('refuses calib/twin fixtures, wrong adapter identities, and control aggregates that do not match the receipt', () => {
    const fixtures = scenarios();
    const devFixtures = scenarios('dev');
    for (const refused of ['twin', 'calib']) {
      const relabeled = devFixtures.map((scenario) => ({ ...scenario, input: { ...scenario.input, split: refused as never } }));
      expect(() => scoreMultiHopV4Comparison(relabeled, comparison(devFixtures, 'complete'), receipt()))
        .toThrow(/calib and twin are refused/);
    }

    const wrongControl = comparison(fixtures, 'complete');
    wrongControl.control.adapterId = 'memberry-retrieval-core-v1';
    expect(() => scoreMultiHopV4Comparison(fixtures, wrongControl, receipt())).toThrow(/control adapter\/mode/);

    const sameId = comparison(fixtures, 'complete');
    sameId.candidate.adapterId = MULTIHOP_V4_CONTROL_ADAPTER_ID;
    expect(() => scoreMultiHopV4Comparison(fixtures, sameId, receipt())).toThrow(/distinct from the production control/);

    const wrongStrata = structuredClone(receipt()) as Mutable;
    Object.assign(wrongStrata.splits.holdout.strata.low, { successes: 16, failures: 18 });
    Object.assign(wrongStrata.splits.holdout.strata.medium, { successes: 17, failures: 16 });
    expect(() => scoreMultiHopV4Comparison(fixtures, comparison(fixtures, 'complete'), wrongStrata as MultiHopV4ControlQualificationReceipt))
      .toThrow(/control aggregate does not match qualified receipt/);
  });

  it('red-lights result/metric inconsistency and any standard-metric regression', () => {
    const fixtures = scenarios();
    const tampered = comparison(fixtures, 'complete');
    tampered.candidate.scenarioReports[0]!.probes[0]!.resultIds = ['unknown-result-id'];
    expect(() => scoreMultiHopV4Comparison(fixtures, tampered, receipt())).toThrow(/does not match result IDs/);

    const regressingComparison = comparison(fixtures, 'complete-with-unknown');
    const regressing = scoreMultiHopV4Comparison(fixtures, regressingComparison, receipt());
    expect(regressing.candidateSuccessRate).toBe(1);
    expect(evaluateMultiHopV4Policy(regressing, regressingComparison)).toContain('safety-regression:unknownResultRate');
  });
});
