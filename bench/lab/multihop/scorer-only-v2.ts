import type { AdapterRunReport, ComparisonReport, ProbeMetrics, ScenarioReport } from '../contracts/report.js';
import type { MultiHopV2ScoringScenario } from '../datasets/load-multihop-v2.js';
import { averageMetrics, scoreProbe } from '../metrics.js';
import { pairedBinaryMeanDeltaInterval, type LabPairedBinaryOutcome } from '../stats.js';
import {
  MULTIHOP_V2_CONTROL_ADAPTER_ID,
  MULTIHOP_V2_CONTROL_ADAPTER_CLASS,
  MULTIHOP_V2_CONTROL_EXECUTION_MODE,
  MULTIHOP_V2_CONTROL_HEADROOM,
  MULTIHOP_V2_CANDIDATE_EXECUTION_MODE,
  MULTIHOP_V2_DENSITY_COUNTS,
  MULTIHOP_V2_FREEZE,
  MULTIHOP_V2_K,
  MULTIHOP_V2_POLICY,
  MULTIHOP_V2_PROBES_PER_SPLIT,
  type MultiHopV2Density,
} from './policy-v2.js';

const METRIC_KEYS = Object.freeze([
  'recallAtK', 'precisionAtK', 'reciprocalRank', 'ndcgAtK', 'answerCoverage',
  'staleLeakRate', 'isolationLeakRate', 'duplicateRate', 'unknownResultRate',
  'staleSafety', 'isolationSafety',
] as const satisfies readonly (keyof ProbeMetrics)[]);
const DENSITIES = Object.freeze(['low', 'medium', 'high'] as const satisfies readonly MultiHopV2Density[]);

export interface MultiHopV2PublicInterval {
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

export interface MultiHopV2AggregateReport {
  readonly metric: typeof MULTIHOP_V2_POLICY.metric;
  readonly split: 'dev' | 'holdout';
  readonly k: typeof MULTIHOP_V2_K;
  readonly n: typeof MULTIHOP_V2_PROBES_PER_SPLIT;
  readonly controlAdapterId: typeof MULTIHOP_V2_CONTROL_ADAPTER_ID;
  readonly candidateAdapterId: string;
  readonly controlSuccessRate: number;
  readonly candidateSuccessRate: number;
  readonly delta: number;
  readonly interval: Readonly<MultiHopV2PublicInterval>;
}

export interface MultiHopV2StratumReceipt {
  readonly n: number;
  readonly successes: number;
  readonly failures: number;
}

export interface MultiHopV2SplitReceipt {
  readonly n: number;
  readonly successes: number;
  readonly successRate: number;
  readonly strata: Readonly<Record<MultiHopV2Density, MultiHopV2StratumReceipt>>;
}

interface MultiHopV2ControlReceiptCore {
  readonly schemaVersion: '1.0.0';
  readonly instrument: typeof MULTIHOP_V2_FREEZE.instrument;
  readonly instrumentVersion: typeof MULTIHOP_V2_FREEZE.version;
  readonly exactBaseCommit: typeof MULTIHOP_V2_FREEZE.exactBaseCommit;
  readonly seedCommitmentSha256: typeof MULTIHOP_V2_FREEZE.seedCommitmentSha256;
  readonly receiptId: string;
  readonly createdAt: string;
  readonly executedSourceSha: string;
  readonly workflowRefSha: string;
  readonly workflowRun: Readonly<{ id: string; url: string; attempt: number }>;
  readonly producer: 'independent-scorer-custodian';
  readonly controlAdapterId: typeof MULTIHOP_V2_CONTROL_ADAPTER_ID;
  readonly controlAdapterClass: typeof MULTIHOP_V2_CONTROL_ADAPTER_CLASS;
  readonly controlExecutionMode: typeof MULTIHOP_V2_CONTROL_EXECUTION_MODE;
  readonly controlSourceIdentity: typeof MULTIHOP_V2_FREEZE.controlSourceIdentity;
  readonly candidateAbsentAtQualification: true;
  readonly candidateArtifactsObserved: false;
  readonly candidateExecutionObserved: false;
  readonly disclosure: 'closed-aggregate-only';
  readonly artifactBindings: typeof MULTIHOP_V2_FREEZE.artifacts;
  readonly splits: Readonly<Record<'dev' | 'holdout', MultiHopV2SplitReceipt>>;
}

export interface MultiHopV2ControlNodeEvidenceReceipt extends MultiHopV2ControlReceiptCore {
  readonly kind: 'lab013-control-qualification-node-evidence';
  readonly runtime: Readonly<{ execution: 'hosted'; platform: 'linux'; nodeMajor: 20 | 22 }>;
  readonly qualificationRuns: Readonly<Record<'dev' | 'holdout', Readonly<{ id: string }>>>;
}

export interface MultiHopV2ControlQualificationReceipt extends MultiHopV2ControlReceiptCore {
  readonly kind: 'lab013-control-qualification';
  readonly runtime: Readonly<{ execution: 'hosted'; platform: 'linux'; nodeMajors: readonly [20, 22] }>;
  readonly evidenceReceiptIds: Readonly<Record<'node20' | 'node22', string>>;
  readonly qualificationRuns: Readonly<Record<
    'node20' | 'node22',
    Readonly<Record<'dev' | 'holdout', Readonly<{ id: string }>>>
  >>;
}

export type MultiHopV2QualificationFailure =
  | 'dev:success-rate-outside-headroom'
  | 'holdout:success-rate-outside-headroom'
  | `dev:${MultiHopV2Density}:missing-success-or-failure`
  | `holdout:${MultiHopV2Density}:missing-success-or-failure`;

export interface MultiHopV2ControlQualificationReport {
  readonly outcome: 'qualified' | 'rejected';
  readonly instrument: typeof MULTIHOP_V2_FREEZE.instrument;
  readonly instrumentVersion: typeof MULTIHOP_V2_FREEZE.version;
  readonly receiptId: string;
  readonly controlAdapterId: typeof MULTIHOP_V2_CONTROL_ADAPTER_ID;
  readonly dev: Readonly<{ n: number; successRate: number; strataQualified: boolean }>;
  readonly holdout: Readonly<{ n: number; successRate: number; strataQualified: boolean }>;
  readonly failures: readonly MultiHopV2QualificationFailure[];
}

function sameNumber(left: number, right: number): boolean {
  return Object.is(left, right) || Math.abs(left - right) <= Number.EPSILON;
}

function assertExactKeys(value: object, expected: readonly string[], at: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${at}: exact closed schema mismatch`);
  }
}

function assertArtifactBinding(
  actual: Readonly<{ sha256: string; sizeBytes: number }>,
  expected: Readonly<{ sha256: string; sizeBytes: number }>,
  at: string,
): void {
  assertExactKeys(actual, ['sha256', 'sizeBytes'], at);
  if (actual.sha256 !== expected.sha256 || actual.sizeBytes !== expected.sizeBytes) {
    throw new Error(`${at}: frozen artifact binding mismatch`);
  }
}

function validateReceiptSplit(split: 'dev' | 'holdout', value: MultiHopV2SplitReceipt): MultiHopV2QualificationFailure[] {
  assertExactKeys(value, ['n', 'successes', 'successRate', 'strata'], `receipt.${split}`);
  assertExactKeys(value.strata, DENSITIES, `receipt.${split}.strata`);
  if (value.n !== MULTIHOP_V2_PROBES_PER_SPLIT
    || !Number.isInteger(value.successes) || value.successes < 0 || value.successes > value.n
    || !sameNumber(value.successRate, value.successes / value.n)) {
    throw new Error(`receipt.${split}: invalid closed aggregate counts`);
  }
  const failures: MultiHopV2QualificationFailure[] = [];
  let stratumN = 0;
  let stratumSuccesses = 0;
  for (const density of DENSITIES) {
    const stratum = value.strata[density];
    assertExactKeys(stratum, ['n', 'successes', 'failures'], `receipt.${split}.${density}`);
    if (stratum.n !== MULTIHOP_V2_DENSITY_COUNTS[density]
      || !Number.isInteger(stratum.successes) || !Number.isInteger(stratum.failures)
      || stratum.successes < 0 || stratum.failures < 0 || stratum.successes + stratum.failures !== stratum.n) {
      throw new Error(`receipt.${split}.${density}: invalid stratum counts`);
    }
    stratumN += stratum.n;
    stratumSuccesses += stratum.successes;
    if (stratum.successes < MULTIHOP_V2_CONTROL_HEADROOM.minimumSuccessesPerStratumInclusive
      || stratum.failures < MULTIHOP_V2_CONTROL_HEADROOM.minimumFailuresPerStratumInclusive) {
      failures.push(`${split}:${density}:missing-success-or-failure`);
    }
  }
  if (stratumN !== value.n || stratumSuccesses !== value.successes) {
    throw new Error(`receipt.${split}: stratum totals do not bind the split aggregate`);
  }
  if (value.successRate < MULTIHOP_V2_CONTROL_HEADROOM.minimumSuccessRateInclusive
    || value.successRate > MULTIHOP_V2_CONTROL_HEADROOM.maximumSuccessRateInclusive) {
    failures.push(`${split}:success-rate-outside-headroom`);
  }
  return failures;
}

function validateReceiptCommon(receipt: MultiHopV2ControlReceiptCore): readonly MultiHopV2QualificationFailure[] {
  if (receipt.schemaVersion !== '1.0.0' || receipt.instrument !== MULTIHOP_V2_FREEZE.instrument
    || receipt.instrumentVersion !== MULTIHOP_V2_FREEZE.version
    || receipt.exactBaseCommit !== MULTIHOP_V2_FREEZE.exactBaseCommit
    || receipt.seedCommitmentSha256 !== MULTIHOP_V2_FREEZE.seedCommitmentSha256) {
    throw new Error('receipt: instrument freeze identity mismatch');
  }
  if (!receipt.receiptId.trim() || Number.isNaN(Date.parse(receipt.createdAt))
    || !/^[0-9a-f]{40}$/.test(receipt.executedSourceSha)
    || receipt.workflowRefSha !== receipt.executedSourceSha) {
    throw new Error('receipt: receipt identity and timestamp are required');
  }
  assertExactKeys(receipt.workflowRun, ['id', 'url', 'attempt'], 'receipt.workflowRun');
  if (!/^[1-9][0-9]*$/.test(receipt.workflowRun.id)
    || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/[1-9][0-9]*$/.test(receipt.workflowRun.url)
    || !receipt.workflowRun.url.endsWith(`/actions/runs/${receipt.workflowRun.id}`)
    || !Number.isInteger(receipt.workflowRun.attempt) || receipt.workflowRun.attempt < 1) {
    throw new Error('receipt: hosted workflow provenance mismatch');
  }
  if (receipt.producer !== 'independent-scorer-custodian'
    || receipt.controlAdapterId !== MULTIHOP_V2_CONTROL_ADAPTER_ID
    || receipt.controlAdapterClass !== MULTIHOP_V2_CONTROL_ADAPTER_CLASS
    || receipt.controlExecutionMode !== MULTIHOP_V2_CONTROL_EXECUTION_MODE
    || receipt.candidateAbsentAtQualification !== true
    || receipt.candidateArtifactsObserved !== false
    || receipt.candidateExecutionObserved !== false
    || receipt.disclosure !== 'closed-aggregate-only') {
    throw new Error('receipt: hosted independent pre-candidate production-control attestation mismatch');
  }
  assertExactKeys(receipt.controlSourceIdentity, [
    'controlAdapterPath', 'controlAdapterGitBlob', 'registeredAdaptersGitBlob', 'runnerGitBlob',
    'systemsRegistryGitBlob', 'experimentsRegistryGitBlob',
  ], 'receipt.controlSourceIdentity');
  if (Object.entries(MULTIHOP_V2_FREEZE.controlSourceIdentity)
    .some(([key, value]) => receipt.controlSourceIdentity[key as keyof typeof receipt.controlSourceIdentity] !== value)) {
    throw new Error('receipt: approved control source identity mismatch');
  }
  assertExactKeys(receipt.artifactBindings, ['dev', 'holdout'], 'receipt.artifactBindings');
  for (const split of ['dev', 'holdout'] as const) {
    assertExactKeys(receipt.artifactBindings[split], ['input', 'oracle'], `receipt.artifactBindings.${split}`);
    assertArtifactBinding(receipt.artifactBindings[split].input, MULTIHOP_V2_FREEZE.artifacts[split].input, `receipt.${split}.input`);
    assertArtifactBinding(receipt.artifactBindings[split].oracle, MULTIHOP_V2_FREEZE.artifacts[split].oracle, `receipt.${split}.oracle`);
  }
  assertExactKeys(receipt.splits, ['dev', 'holdout'], 'receipt.splits');
  return Object.freeze([
    ...validateReceiptSplit('dev', receipt.splits.dev),
    ...validateReceiptSplit('holdout', receipt.splits.holdout),
  ]);
}

function publicQualificationReport(
  receipt: MultiHopV2ControlReceiptCore,
  failures: readonly MultiHopV2QualificationFailure[],
): Readonly<MultiHopV2ControlQualificationReport> {
  const splitPublic = (split: 'dev' | 'holdout') => Object.freeze({
    n: receipt.splits[split].n,
    successRate: receipt.splits[split].successRate,
    strataQualified: DENSITIES.every((density) => {
      const value = receipt.splits[split].strata[density];
      return value.successes >= MULTIHOP_V2_CONTROL_HEADROOM.minimumSuccessesPerStratumInclusive
        && value.failures >= MULTIHOP_V2_CONTROL_HEADROOM.minimumFailuresPerStratumInclusive;
    }),
  });
  return Object.freeze({
    outcome: failures.length === 0 ? 'qualified' : 'rejected',
    instrument: MULTIHOP_V2_FREEZE.instrument,
    instrumentVersion: MULTIHOP_V2_FREEZE.version,
    receiptId: receipt.receiptId,
    controlAdapterId: receipt.controlAdapterId,
    dev: splitPublic('dev'),
    holdout: splitPublic('holdout'),
    failures: Object.freeze(failures),
  });
}

/** Validates evidence from one hosted matrix node. This evidence is never accepted by the comparison scorer. */
export function qualifyMultiHopV2ControlNodeEvidenceReceipt(
  receipt: MultiHopV2ControlNodeEvidenceReceipt,
): Readonly<MultiHopV2ControlQualificationReport> {
  assertExactKeys(receipt, [
    'schemaVersion', 'kind', 'instrument', 'instrumentVersion', 'exactBaseCommit', 'seedCommitmentSha256',
    'receiptId', 'createdAt', 'executedSourceSha', 'workflowRefSha', 'workflowRun', 'producer', 'runtime',
    'controlAdapterId', 'controlAdapterClass', 'controlExecutionMode', 'qualificationRuns',
    'controlSourceIdentity', 'candidateAbsentAtQualification', 'candidateArtifactsObserved',
    'candidateExecutionObserved', 'disclosure', 'artifactBindings', 'splits',
  ], 'node evidence receipt');
  if (receipt.kind !== 'lab013-control-qualification-node-evidence') {
    throw new Error('node evidence receipt: evidence-only kind mismatch');
  }
  assertExactKeys(receipt.runtime, ['execution', 'platform', 'nodeMajor'], 'node evidence receipt.runtime');
  if (receipt.runtime.execution !== 'hosted' || receipt.runtime.platform !== 'linux'
    || (receipt.runtime.nodeMajor !== 20 && receipt.runtime.nodeMajor !== 22)) {
    throw new Error('node evidence receipt: hosted runtime mismatch');
  }
  assertExactKeys(receipt.qualificationRuns, ['dev', 'holdout'], 'node evidence receipt.qualificationRuns');
  if (receipt.receiptId !== `lab013-${receipt.workflowRun.id}-attempt${receipt.workflowRun.attempt}-node${receipt.runtime.nodeMajor}`) {
    throw new Error('node evidence receipt: receipt ID provenance mismatch');
  }
  for (const split of ['dev', 'holdout'] as const) {
    assertExactKeys(receipt.qualificationRuns[split], ['id'], `node evidence receipt.qualificationRuns.${split}`);
    const expectedRunId = `lab013-${receipt.workflowRun.id}-attempt${receipt.workflowRun.attempt}`
      + `-node${receipt.runtime.nodeMajor}-${split}-control`;
    if (receipt.qualificationRuns[split].id !== expectedRunId) {
      throw new Error(`node evidence receipt.qualificationRuns.${split}: run ID provenance mismatch`);
    }
  }
  if (receipt.qualificationRuns.dev.id === receipt.qualificationRuns.holdout.id) {
    throw new Error('node evidence receipt: split qualification run IDs must be distinct');
  }
  const failures = validateReceiptCommon(receipt);
  return publicQualificationReport(receipt, failures);
}

/**
 * Accepts only the joined Node 20+22 authority receipt and emits closed aggregates.
 * A per-node evidence receipt cannot satisfy this exact schema.
 */
export function qualifyMultiHopV2ControlReceipt(
  receipt: MultiHopV2ControlQualificationReceipt,
): Readonly<MultiHopV2ControlQualificationReport> {
  assertExactKeys(receipt, [
    'schemaVersion', 'kind', 'instrument', 'instrumentVersion', 'exactBaseCommit', 'seedCommitmentSha256',
    'receiptId', 'createdAt', 'executedSourceSha', 'workflowRefSha', 'workflowRun', 'producer', 'runtime',
    'controlAdapterId', 'controlAdapterClass', 'controlExecutionMode', 'evidenceReceiptIds', 'qualificationRuns',
    'controlSourceIdentity', 'candidateAbsentAtQualification', 'candidateArtifactsObserved',
    'candidateExecutionObserved', 'disclosure', 'artifactBindings', 'splits',
  ], 'receipt');
  if (receipt.kind !== 'lab013-control-qualification') throw new Error('receipt: joined authority kind mismatch');
  assertExactKeys(receipt.runtime, ['execution', 'platform', 'nodeMajors'], 'receipt.runtime');
  if (receipt.runtime.execution !== 'hosted' || receipt.runtime.platform !== 'linux'
    || receipt.runtime.nodeMajors.length !== 2
    || receipt.runtime.nodeMajors[0] !== 20 || receipt.runtime.nodeMajors[1] !== 22) {
    throw new Error('receipt: joined Node 20+22 runtime mismatch');
  }
  if (receipt.receiptId !== `lab013-${receipt.workflowRun.id}-attempt${receipt.workflowRun.attempt}-joined-node20-node22`) {
    throw new Error('receipt: receipt ID provenance mismatch');
  }
  assertExactKeys(receipt.evidenceReceiptIds, ['node20', 'node22'], 'receipt.evidenceReceiptIds');
  assertExactKeys(receipt.qualificationRuns, ['node20', 'node22'], 'receipt.qualificationRuns');
  for (const nodeMajor of [20, 22] as const) {
    const node = `node${nodeMajor}` as const;
    const expectedEvidenceId = `lab013-${receipt.workflowRun.id}-attempt${receipt.workflowRun.attempt}-node${nodeMajor}`;
    if (receipt.evidenceReceiptIds[node] !== expectedEvidenceId) {
      throw new Error(`receipt.evidenceReceiptIds.${node}: provenance mismatch`);
    }
    assertExactKeys(receipt.qualificationRuns[node], ['dev', 'holdout'], `receipt.qualificationRuns.${node}`);
    for (const split of ['dev', 'holdout'] as const) {
      assertExactKeys(receipt.qualificationRuns[node][split], ['id'], `receipt.qualificationRuns.${node}.${split}`);
      const expectedRunId = `${expectedEvidenceId}-${split}-control`;
      if (receipt.qualificationRuns[node][split].id !== expectedRunId) {
        throw new Error(`receipt.qualificationRuns.${node}.${split}: run ID provenance mismatch`);
      }
    }
    if (receipt.qualificationRuns[node].dev.id === receipt.qualificationRuns[node].holdout.id) {
      throw new Error(`receipt.qualificationRuns.${node}: split run IDs must be distinct`);
    }
  }
  const failures = validateReceiptCommon(receipt);
  return publicQualificationReport(receipt, failures);
}

function assertMetrics(actual: ProbeMetrics, expected: ProbeMetrics, at: string): void {
  for (const metric of METRIC_KEYS) {
    if (!sameNumber(actual[metric], expected[metric])) throw new Error(`${at}: ${metric} does not match result IDs`);
  }
}

function densityOf(scenario: MultiHopV2ScoringScenario): MultiHopV2Density {
  const tags = scenario.input.tags?.filter((tag) => tag.startsWith('density:')) ?? [];
  const density = tags.length === 1 ? tags[0]!.slice('density:'.length) : '';
  if (!DENSITIES.includes(density as MultiHopV2Density)) throw new Error(`${scenario.input.id}: invalid density stratum`);
  return density as MultiHopV2Density;
}

function validateFixtures(scenarios: readonly MultiHopV2ScoringScenario[]): 'dev' | 'holdout' {
  if (scenarios.length !== MULTIHOP_V2_PROBES_PER_SPLIT) {
    throw new Error(`multi-hop v2 scorer requires exactly ${MULTIHOP_V2_PROBES_PER_SPLIT} scenarios`);
  }
  const split: unknown = scenarios[0]!.input.split;
  if (split !== 'dev' && split !== 'holdout') throw new Error('multi-hop v2 scorer requires a valid split');
  const ids = new Set<string>();
  const densities = new Map<MultiHopV2Density, number>();
  for (const scenario of scenarios) {
    const { input, oracle } = scenario;
    if (ids.has(input.id)) throw new Error(`duplicate scenario ID: ${input.id}`);
    ids.add(input.id);
    if (input.split !== split) throw new Error(`${input.id}: split mismatch`);
    if (oracle.scenarioId !== input.id) throw new Error(`${input.id}: oracle scenario ID mismatch`);
    if (input.dimensions.length !== 1 || input.dimensions[0] !== 'multi-hop') throw new Error(`${input.id}: dimension mismatch`);
    if (input.queries.length !== 1 || input.queries[0]!.limit !== MULTIHOP_V2_K) {
      throw new Error(`${input.id}: requires one k=${MULTIHOP_V2_K} query`);
    }
    if (input.memories.length !== 24) throw new Error(`${input.id}: requires exactly 24 memories`);
    if (oracle.probes.length !== 1 || oracle.probes[0]!.probeId !== input.queries[0]!.id) throw new Error(`${input.id}: probe ID mismatch`);
    const required = oracle.probes[0]!.required;
    if (!required || required.length !== 2 || new Set(required).size !== 2) throw new Error(`${input.id}: invalid required hop IDs`);
    const corpus = new Set(input.memories.map(({ id }) => id));
    if (!required.every((id) => corpus.has(id))) throw new Error(`${input.id}: required hop ID absent from corpus`);
    const density = densityOf(scenario);
    densities.set(density, (densities.get(density) ?? 0) + 1);
  }
  for (const density of DENSITIES) {
    if (densities.get(density) !== MULTIHOP_V2_DENSITY_COUNTS[density]) throw new Error(`multi-hop v2 ${density} density count mismatch`);
  }
  return split;
}

function validateArm(
  label: 'control' | 'candidate',
  arm: AdapterRunReport,
  scenarios: readonly MultiHopV2ScoringScenario[],
): readonly ScenarioReport[] {
  const expectedMode = label === 'control' ? MULTIHOP_V2_CONTROL_EXECUTION_MODE : MULTIHOP_V2_CANDIDATE_EXECUTION_MODE;
  if (arm.executionMode !== expectedMode || arm.outcome !== 'scored' || arm.health !== 'ready') {
    throw new Error(`${label} arm must be ${expectedMode}, scored, and ready`);
  }
  if (arm.excludedScenarios.length !== 0) throw new Error(`${label} arm must not exclude scenarios`);
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
    if (probe.query !== scenario.input.queries[0]!.query) throw new Error(`${label}/${scenario.input.id}: query mismatch`);
    const expected = scoreProbe(
      scenario.input,
      scenario.oracle.probes[0]!,
      MULTIHOP_V2_K,
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

function strictOutcome(scenario: MultiHopV2ScoringScenario, report: ScenarioReport): 0 | 1 {
  const required = scenario.oracle.probes[0]!.required!;
  const top = new Set(report.probes[0]!.resultIds.slice(0, MULTIHOP_V2_K));
  return required.every((id) => top.has(id)) ? 1 : 0;
}

function assertQualifiedControlAggregate(
  split: 'dev' | 'holdout',
  scenarios: readonly MultiHopV2ScoringScenario[],
  pairs: readonly LabPairedBinaryOutcome[],
  expected: MultiHopV2SplitReceipt,
): void {
  const strata = {
    low: { n: 0, successes: 0, failures: 0 },
    medium: { n: 0, successes: 0, failures: 0 },
    high: { n: 0, successes: 0, failures: 0 },
  } satisfies Record<MultiHopV2Density, { n: number; successes: number; failures: number }>;
  let successes = 0;
  for (const [index, scenario] of scenarios.entries()) {
    const outcome = pairs[index]!.controlOutcome;
    const density = densityOf(scenario);
    strata[density].n += 1;
    strata[density][outcome === 1 ? 'successes' : 'failures'] += 1;
    successes += outcome;
  }
  if (expected.n !== pairs.length || expected.successes !== successes
    || !sameNumber(expected.successRate, successes / pairs.length)
    || DENSITIES.some((density) => (
      expected.strata[density].n !== strata[density].n
      || expected.strata[density].successes !== strata[density].successes
      || expected.strata[density].failures !== strata[density].failures
    ))) {
    throw new Error(`multi-hop v2 ${split} control aggregate does not match qualified receipt`);
  }
}

/** Strict all-two paired scoring. The returned object is closed aggregate-only and never carries the bootstrap seed. */
export function scoreMultiHopV2Comparison(
  scenarios: readonly MultiHopV2ScoringScenario[],
  comparison: ComparisonReport,
  receipt: MultiHopV2ControlQualificationReceipt,
): Readonly<MultiHopV2AggregateReport> {
  const qualification = qualifyMultiHopV2ControlReceipt(receipt);
  if (qualification.outcome !== 'qualified') throw new Error('multi-hop v2 control receipt is not qualified');
  const split = validateFixtures(scenarios);
  if (comparison.evidenceMode !== 'registered-ci') throw new Error('multi-hop v2 comparison requires registered-ci evidence');
  if (comparison.control.adapterId !== MULTIHOP_V2_CONTROL_ADAPTER_ID
    || comparison.control.adapterId !== receipt.controlAdapterId
    || comparison.control.executionMode !== receipt.controlExecutionMode) {
    throw new Error('multi-hop v2 control adapter/mode does not match qualified production receipt');
  }
  if (!comparison.candidate.adapterId.trim() || comparison.candidate.adapterId === comparison.control.adapterId) {
    throw new Error('candidate adapter ID must be non-empty and distinct from the production control');
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
  assertQualifiedControlAggregate(split, scenarios, pairs, receipt.splits[split]);
  const internalInterval = pairedBinaryMeanDeltaInterval(pairs);
  const interval: Readonly<MultiHopV2PublicInterval> = internalInterval.unsupportedReason === undefined
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
    metric: MULTIHOP_V2_POLICY.metric,
    split,
    k: MULTIHOP_V2_K,
    n: MULTIHOP_V2_PROBES_PER_SPLIT,
    controlAdapterId: MULTIHOP_V2_CONTROL_ADAPTER_ID,
    candidateAdapterId: comparison.candidate.adapterId,
    controlSuccessRate,
    candidateSuccessRate,
    delta: candidateSuccessRate - controlSuccessRate,
    interval,
  });
}
