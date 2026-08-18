import type { LabAdapter, LabNamespace } from './contracts/adapter.js';
import { LAB_CONTRACT_VERSION, missingCapabilities } from './contracts/adapter.js';
import type {
  AdapterRunReport,
  ComparisonReport,
  GateFailure,
  LabGatePolicy,
  MetricDelta,
  ProbeMetrics,
  ProbeReport,
  ScenarioReport,
} from './contracts/report.js';
import type { LabScenario, LabScenarioSplit } from './contracts/scenario.js';
import { validateScenario } from './contracts/scenario.js';
import { aggregateContextAccounting, averageMetrics, DEFAULT_GATE_POLICY, probeContextTokens, scoreProbe } from './metrics.js';
import { pairedEfficiencyInterval, unsupportedEfficiencyInterval, type LabPairedProbe } from './stats.js';

const QUALITY_METRICS: readonly (keyof ProbeMetrics)[] = [
  'recallAtK', 'precisionAtK', 'reciprocalRank', 'ndcgAtK', 'answerCoverage', 'staleSafety', 'isolationSafety',
];
const ALL_METRICS: readonly (keyof ProbeMetrics)[] = [
  ...QUALITY_METRICS, 'staleLeakRate', 'isolationLeakRate', 'duplicateRate', 'unknownResultRate',
];

function gateFailures(
  health: string,
  scenarioReports: readonly ScenarioReport[],
  metrics: ProbeMetrics,
  policy: LabGatePolicy,
): GateFailure[] {
  const failures: GateFailure[] = [];
  if (health !== 'ready') failures.push({ metric: 'adapter-health', actual: health, expected: 'ready' });
  const nonScored = scenarioReports.filter((scenario) => scenario.outcome !== 'scored');
  if (nonScored.length) {
    failures.push({
      metric: 'scenario-coverage',
      actual: scenarioReports.length - nonScored.length,
      expected: `${scenarioReports.length} selected scenarios scored; excluded: ${nonScored.map((scenario) => scenario.scenarioId).join(', ')}`,
    });
  }
  const addMinimum = (metric: keyof ProbeMetrics, actual: number, minimum: number) => {
    if (actual < minimum) failures.push({ metric, actual, expected: `>= ${minimum}` });
  };
  // Coverage and recall are joint anti-abstention gates. Empty responses fail both.
  addMinimum('recallAtK', metrics.recallAtK, policy.minRecallAtK);
  addMinimum('answerCoverage', metrics.answerCoverage, policy.minAnswerCoverage);
  addMinimum('precisionAtK', metrics.precisionAtK, policy.minPrecisionAtK);

  const maximums: Array<[keyof ProbeMetrics, number]> = [
    ['staleLeakRate', policy.maxStaleLeakRate],
    ['isolationLeakRate', policy.maxIsolationLeakRate],
    ['duplicateRate', policy.maxDuplicateRate],
    ['unknownResultRate', policy.maxUnknownResultRate],
  ];
  // Safety is non-compensatory: one leaking scenario fails even if an average looks healthy.
  for (const scenario of scenarioReports.filter((value) => value.outcome === 'scored')) {
    for (const [metric, maximum] of maximums) {
      if (scenario.metrics[metric] > maximum) {
        failures.push({ metric, actual: scenario.metrics[metric], expected: `<= ${maximum}`, scenarioId: scenario.scenarioId });
      }
    }
  }
  return failures;
}

export interface RunAdapterOptions {
  runId: string;
  adapter: LabAdapter;
  scenarios: readonly LabScenario[];
  policy?: LabGatePolicy;
  splits?: readonly LabScenarioSplit[];
}

export async function runAdapter(options: RunAdapterOptions): Promise<AdapterRunReport> {
  const policy = options.policy ?? DEFAULT_GATE_POLICY;
  const selectedSplits = new Set(options.splits ?? ['dev', 'holdout']);
  const health = await options.adapter.health();
  const scenarioReports: ScenarioReport[] = [];
  const excludedScenarios: { scenarioId: string; split: LabScenarioSplit; reason: string }[] = [];
  let lastNamespace: LabNamespace = { runId: options.runId, tenant: 'none', project: 'none' };

  for (const scenario of options.scenarios) {
    const { input, oracle } = scenario;
    const validationErrors = validateScenario(scenario);
    if (validationErrors.length) throw new Error(`${input.id}: ${validationErrors.join('; ')}`);
    if (!selectedSplits.has(input.split)) {
      excludedScenarios.push({ scenarioId: input.id, split: input.split, reason: 'split-not-selected' });
      continue;
    }

    const capabilityGaps = missingCapabilities(options.adapter, input.requiredCapabilities ?? []);
    if (capabilityGaps.length) {
      scenarioReports.push({
        scenarioId: input.id,
        split: input.split,
        dimensions: input.dimensions,
        capabilityGaps,
        outcome: 'unsupported',
        exclusionReason: `missing capabilities: ${capabilityGaps.join(', ')}`,
        probes: [],
        metrics: averageMetrics([]),
      });
      continue;
    }

    const namespace = { runId: options.runId, tenant: input.tenant, project: input.project };
    lastNamespace = namespace;
    try {
      await options.adapter.cleanup(namespace);
      const ingest = await options.adapter.ingest({ namespace, memories: input.memories });
      if (ingest.rejected.length || ingest.accepted !== input.memories.length) {
        throw new Error(`adapter rejected fixture memories: ${JSON.stringify(ingest.rejected)}`);
      }
      const oracleByProbe = new Map(oracle.probes.map((probe) => [probe.probeId, probe]));
      const probes: ProbeReport[] = [];
      // Only adapter-visible input is sent across the contract boundary. Oracle labels stay local.
      for (const query of input.queries) {
        const response = await options.adapter.query({
          namespace,
          query: query.query,
          limit: query.limit,
          asOf: query.asOf,
          tokenBudget: query.tokenBudget,
        });
        const probeOracle = oracleByProbe.get(query.id);
        if (!probeOracle) throw new Error(`missing oracle for ${query.id}`);
        probes.push({
          probeId: query.id,
          query: query.query,
          resultIds: response.results.map((result) => result.id),
          metrics: scoreProbe(input, probeOracle, query.limit, response.results),
          contextTokens: probeContextTokens(input, query.limit, response.results),
          durationMs: response.durationMs,
        });
      }
      scenarioReports.push({
        scenarioId: input.id,
        split: input.split,
        dimensions: input.dimensions,
        capabilityGaps: [],
        outcome: 'scored',
        probes,
        metrics: averageMetrics(probes.map((probe) => probe.metrics)),
        contextAccounting: aggregateContextAccounting(probes),
      });
    } catch (error) {
      scenarioReports.push({
        scenarioId: input.id,
        split: input.split,
        dimensions: input.dimensions,
        capabilityGaps: [],
        outcome: 'failed',
        exclusionReason: error instanceof Error ? error.message : String(error),
        probes: [],
        metrics: averageMetrics([]),
      });
    } finally {
      try { await options.adapter.cleanup(namespace); } catch { /* failure is already explicit in adapter health/run evidence */ }
    }
  }

  const scoredProbes = scenarioReports
    .filter((scenario) => scenario.outcome === 'scored')
    .flatMap((scenario) => scenario.probes);
  const metrics = averageMetrics(scoredProbes.map((probe) => probe.metrics));
  const stats = await options.adapter.stats(lastNamespace);
  const failures = gateFailures(health.status, scenarioReports, metrics, policy);
  const outcome = scenarioReports.some((scenario) => scenario.outcome === 'failed') || health.status === 'unavailable'
    ? 'failed'
    : scenarioReports.some((scenario) => scenario.outcome === 'unsupported')
      ? 'unsupported'
      : 'scored';
  return {
    contractVersion: LAB_CONTRACT_VERSION,
    runId: options.runId,
    adapterId: options.adapter.id,
    adapterName: options.adapter.displayName,
    executionMode: options.adapter.executionMode,
    health: health.status,
    outcome,
    excludedScenarios,
    scenarioReports,
    metrics,
    contextAccounting: aggregateContextAccounting(scoredProbes),
    stats,
    gateFailures: failures,
    passed: outcome === 'scored' && failures.length === 0,
  };
}

export interface CompareAdaptersOptions {
  runId: string;
  control: LabAdapter;
  candidate: LabAdapter;
  scenarios: readonly LabScenario[];
  policy?: LabGatePolicy;
  splits?: readonly LabScenarioSplit[];
}

/** Probes matched on (scenarioId, probeId) and scored in both arms, in run order. */
function pairScoredProbes(control: AdapterRunReport, candidate: AdapterRunReport): LabPairedProbe[] {
  const candidateProbes = new Map(candidate.scenarioReports
    .filter((scenario) => scenario.outcome === 'scored')
    .flatMap((scenario) => scenario.probes.map((probe) => [`${scenario.scenarioId}\u0000${probe.probeId}`, probe] as const)));
  return control.scenarioReports
    .filter((scenario) => scenario.outcome === 'scored')
    .flatMap((scenario) => scenario.probes.flatMap((probe) => {
      const paired = candidateProbes.get(`${scenario.scenarioId}\u0000${probe.probeId}`);
      // Unpaired probes are excluded from the interval; they stay visible in each arm's report.
      return paired ? [{
        scenarioId: scenario.scenarioId,
        probeId: probe.probeId,
        controlCoverage: probe.metrics.answerCoverage,
        controlTokens: probe.contextTokens ?? 0,
        candidateCoverage: paired.metrics.answerCoverage,
        candidateTokens: paired.contextTokens ?? 0,
      }] : [];
    }));
}

export async function compareAdapters(options: CompareAdaptersOptions): Promise<ComparisonReport> {
  if (options.control === options.candidate || options.control.id === options.candidate.id) {
    throw new Error('control and candidate must be independent adapters with distinct identities');
  }
  const policy = options.policy ?? DEFAULT_GATE_POLICY;
  const [control, candidate] = await Promise.all([
    runAdapter({ runId: `${options.runId}-control`, adapter: options.control, scenarios: options.scenarios, policy, splits: options.splits }),
    runAdapter({ runId: `${options.runId}-candidate`, adapter: options.candidate, scenarios: options.scenarios, policy, splits: options.splits }),
  ]);
  const deltas: MetricDelta[] = ALL_METRICS.map((metric) => ({
    metric,
    control: control.metrics[metric],
    candidate: candidate.metrics[metric],
    delta: candidate.metrics[metric] - control.metrics[metric],
  }));
  const failures = [
    ...control.gateFailures.map((failure) => ({ ...failure, arm: 'control' as const })),
    ...candidate.gateFailures.map((failure) => ({ ...failure, arm: 'candidate' as const })),
  ];
  if (control.outcome !== 'scored') {
    failures.push({ metric: 'scenario-coverage', actual: control.outcome, expected: 'control outcome scored', arm: 'control' });
  }
  if (candidate.outcome !== 'scored') {
    failures.push({ metric: 'scenario-coverage', actual: candidate.outcome, expected: 'candidate outcome scored', arm: 'candidate' });
  }
  for (const delta of deltas.filter(({ metric }) => QUALITY_METRICS.includes(metric))) {
    if (delta.delta < -policy.maxQualityRegression) {
      failures.push({ metric: delta.metric, actual: delta.candidate, expected: `no more than ${policy.maxQualityRegression} below control ${delta.control}`, arm: 'candidate' });
    }
  }
  const pairs = pairScoredProbes(control, candidate);
  const controlAccounting = control.contextAccounting ?? aggregateContextAccounting([]);
  const candidateAccounting = candidate.contextAccounting ?? aggregateContextAccounting([]);
  // Reported, never gating: the efficiency proxy adds no GateFailure and no delta entry.
  const efficiency = {
    metric: 'taskSuccessPer1kTokens' as const,
    control: controlAccounting,
    candidate: candidateAccounting,
    delta: controlAccounting.taskSuccessPer1kTokens !== null && candidateAccounting.taskSuccessPer1kTokens !== null
      ? candidateAccounting.taskSuccessPer1kTokens - controlAccounting.taskSuccessPer1kTokens
      : null,
    interval: control.outcome !== 'scored' || candidate.outcome !== 'scored'
      ? unsupportedEfficiencyInterval('arm-not-scored', pairs)
      : pairedEfficiencyInterval(pairs),
  };
  return { runId: options.runId, evidenceMode: 'ad-hoc', control, candidate, deltas, efficiency, failures, passed: failures.length === 0 };
}
