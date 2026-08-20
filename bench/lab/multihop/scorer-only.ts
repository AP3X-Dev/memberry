import type { AdapterRunReport, ComparisonReport, ProbeMetrics, ScenarioReport } from '../contracts/report.js';
import type { LabScenario } from '../contracts/scenario.js';
import { averageMetrics, scoreProbe } from '../metrics.js';
import { pairedBinaryMeanDeltaInterval, type LabPairedBinaryOutcome } from '../stats.js';
import { MULTIHOP_K, MULTIHOP_POLICY } from './policy.js';

const METRIC_KEYS = Object.freeze([
  'recallAtK', 'precisionAtK', 'reciprocalRank', 'ndcgAtK', 'answerCoverage',
  'staleLeakRate', 'isolationLeakRate', 'duplicateRate', 'unknownResultRate',
  'staleSafety', 'isolationSafety',
] as const satisfies readonly (keyof ProbeMetrics)[]);

export interface MultiHopAggregateReport {
  readonly metric: typeof MULTIHOP_POLICY.metric;
  readonly split: 'dev' | 'holdout';
  readonly k: typeof MULTIHOP_K;
  readonly n: number;
  readonly controlAdapterId: string;
  readonly candidateAdapterId: string;
  readonly controlSuccessRate: number;
  readonly candidateSuccessRate: number;
  readonly delta: number;
  readonly interval: Readonly<MultiHopPublicInterval>;
}

export interface MultiHopPublicInterval {
  readonly outcome: 'measured' | 'unsupported';
  readonly unsupportedReason?: 'insufficient-paired-probes' | 'zero-context-tokens' | 'arm-not-scored';
  readonly pairedProbes: number;
  readonly resamples: number;
  readonly level: number;
  readonly point: number | null;
  readonly lower: number | null;
  readonly upper: number | null;
  readonly oneSidedLower: number | null;
}

function sameNumber(left: number, right: number): boolean {
  return Object.is(left, right) || Math.abs(left - right) <= Number.EPSILON;
}

function assertMetrics(actual: ProbeMetrics, expected: ProbeMetrics, at: string): void {
  for (const metric of METRIC_KEYS) {
    if (!sameNumber(actual[metric], expected[metric])) throw new Error(`${at}: ${metric} does not match result IDs`);
  }
}

function validateFixtures(scenarios: readonly LabScenario[]): 'dev' | 'holdout' {
  if (scenarios.length === 0) throw new Error('multi-hop scorer requires at least one scenario');
  const split: unknown = scenarios[0]!.input.split;
  if (split !== 'dev' && split !== 'holdout') throw new Error('multi-hop scorer requires a valid split');
  const ids = new Set<string>();
  for (const scenario of scenarios) {
    const { input, oracle } = scenario;
    if (ids.has(input.id)) throw new Error(`duplicate scenario ID: ${input.id}`);
    ids.add(input.id);
    if (input.split !== split) throw new Error(`${input.id}: split mismatch`);
    if (oracle.scenarioId !== input.id) throw new Error(`${input.id}: oracle scenario ID mismatch`);
    if (input.dimensions.length !== 1 || input.dimensions[0] !== 'multi-hop') throw new Error(`${input.id}: dimension mismatch`);
    if (input.queries.length !== 1 || input.queries[0]!.limit !== MULTIHOP_K) throw new Error(`${input.id}: requires one k=${MULTIHOP_K} query`);
    if (oracle.probes.length !== 1 || oracle.probes[0]!.probeId !== input.queries[0]!.id) throw new Error(`${input.id}: probe ID mismatch`);
    const required = oracle.probes[0]!.required;
    if (!required || required.length !== 2 || new Set(required).size !== required.length) throw new Error(`${input.id}: invalid required hop IDs`);
    const corpus = new Set(input.memories.map(({ id }) => id));
    if (!required.every((id) => corpus.has(id))) throw new Error(`${input.id}: required hop ID absent from corpus`);
  }
  return split;
}

function validateArm(
  label: 'control' | 'candidate',
  arm: AdapterRunReport,
  scenarios: readonly LabScenario[],
): readonly ScenarioReport[] {
  if (arm.outcome !== 'scored' || arm.health !== 'ready') throw new Error(`${label} arm must be scored and ready`);
  if (arm.scenarioReports.length !== scenarios.length) throw new Error(`${label} scenario ID/order mismatch`);
  const recomputed: ProbeMetrics[] = [];
  for (const [index, scenario] of scenarios.entries()) {
    const report = arm.scenarioReports[index];
    if (!report || report.scenarioId !== scenario.input.id) throw new Error(`${label} scenario ID/order mismatch`);
    if (report.split !== scenario.input.split) throw new Error(`${label}/${scenario.input.id}: split mismatch`);
    if (report.outcome !== 'scored') throw new Error(`${label}/${scenario.input.id}: scenario must be scored`);
    if (report.dimensions.length !== 1 || report.dimensions[0] !== 'multi-hop') throw new Error(`${label}/${scenario.input.id}: dimension mismatch`);
    if (report.probes.length !== 1 || report.probes[0]!.probeId !== scenario.input.queries[0]!.id) {
      throw new Error(`${label}/${scenario.input.id}: probe ID/order mismatch`);
    }
    const probe = report.probes[0]!;
    const expected = scoreProbe(
      scenario.input,
      scenario.oracle.probes[0]!,
      MULTIHOP_K,
      probe.resultIds.map((id) => ({ id, score: 0 })),
    );
    assertMetrics(probe.metrics, expected, `${label}/${scenario.input.id}/${probe.probeId}`);
    assertMetrics(report.metrics, expected, `${label}/${scenario.input.id}`);
    recomputed.push(expected);
  }
  assertMetrics(arm.metrics, averageMetrics(recomputed), `${label} aggregate`);
  return arm.scenarioReports;
}

function validateDeltas(comparison: ComparisonReport): void {
  const byMetric = new Map(comparison.deltas.map((delta) => [delta.metric, delta]));
  if (byMetric.size !== METRIC_KEYS.length || comparison.deltas.length !== METRIC_KEYS.length) {
    throw new Error('comparison metric delta bijection mismatch');
  }
  for (const metric of METRIC_KEYS) {
    const delta = byMetric.get(metric);
    if (!delta
      || !sameNumber(delta.control, comparison.control.metrics[metric])
      || !sameNumber(delta.candidate, comparison.candidate.metrics[metric])
      || !sameNumber(delta.delta, delta.candidate - delta.control)) {
      throw new Error(`comparison delta mismatch: ${metric}`);
    }
  }
}

function strictOutcome(scenario: LabScenario, report: ScenarioReport): 0 | 1 {
  const required = scenario.oracle.probes[0]!.required!;
  const top = new Set(report.probes[0]!.resultIds.slice(0, MULTIHOP_K));
  return required.every((id) => top.has(id)) ? 1 : 0;
}

/**
 * Synthetic domain-neutral instrument authored and frozen before RET-007.
 * The returned object is aggregate-only; protected labels and per-case values never cross it.
 */
export function scoreMultiHopComparison(
  scenarios: readonly LabScenario[],
  comparison: ComparisonReport,
): Readonly<MultiHopAggregateReport> {
  const split = validateFixtures(scenarios);
  if (!comparison.control.adapterId.trim() || !comparison.candidate.adapterId.trim()
    || comparison.control.adapterId === comparison.candidate.adapterId) {
    throw new Error('control and candidate adapter IDs must be non-empty and distinct');
  }
  const control = validateArm('control', comparison.control, scenarios);
  const candidate = validateArm('candidate', comparison.candidate, scenarios);
  validateDeltas(comparison);
  const pairs: LabPairedBinaryOutcome[] = scenarios.map((scenario, index) => ({
    scenarioId: scenario.input.id,
    probeId: scenario.input.queries[0]!.id,
    controlOutcome: strictOutcome(scenario, control[index]!),
    candidateOutcome: strictOutcome(scenario, candidate[index]!),
  }));
  const controlSuccessRate = pairs.reduce((sum, pair) => sum + pair.controlOutcome, 0) / pairs.length;
  const candidateSuccessRate = pairs.reduce((sum, pair) => sum + pair.candidateOutcome, 0) / pairs.length;
  const internalInterval = pairedBinaryMeanDeltaInterval(pairs);
  const interval: Readonly<MultiHopPublicInterval> = internalInterval.unsupportedReason === undefined
    ? Object.freeze({
      outcome: internalInterval.outcome,
      pairedProbes: internalInterval.pairedProbes,
      resamples: internalInterval.resamples,
      level: internalInterval.level,
      point: internalInterval.point,
      lower: internalInterval.lower,
      upper: internalInterval.upper,
      oneSidedLower: internalInterval.oneSidedLower,
    })
    : Object.freeze({
      outcome: internalInterval.outcome,
      unsupportedReason: internalInterval.unsupportedReason,
      pairedProbes: internalInterval.pairedProbes,
      resamples: internalInterval.resamples,
      level: internalInterval.level,
      point: internalInterval.point,
      lower: internalInterval.lower,
      upper: internalInterval.upper,
      oneSidedLower: internalInterval.oneSidedLower,
    });
  return Object.freeze({
    metric: MULTIHOP_POLICY.metric,
    split,
    k: MULTIHOP_K,
    n: pairs.length,
    controlAdapterId: comparison.control.adapterId,
    candidateAdapterId: comparison.candidate.adapterId,
    controlSuccessRate,
    candidateSuccessRate,
    delta: candidateSuccessRate - controlSuccessRate,
    interval,
  });
}
