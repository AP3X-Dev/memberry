// RET-007 v4 scorer-only module — clone of scorer-only-v3 with the v4 identity,
// the FUNNEL control, per-split n (dev 60 / holdout 100), and the twin split
// carried in the receipt as RECORDED EVIDENCE only: the verdict is
// dev in band AND holdout in band AND per-stratum mixed on both. The twin
// aggregate is validated for shape/consistency but never produces a failure code.

import type { AdapterRunReport, ComparisonReport, ProbeMetrics, ScenarioReport } from '../contracts/report.js';
import type { MultiHopV4ScoringScenario } from '../datasets/load-multihop-v4.js';
import { averageMetrics, scoreProbe } from '../metrics.js';
import { pairedBinaryMeanDeltaInterval, type LabPairedBinaryOutcome } from '../stats.js';
import {
  MULTIHOP_V4_CANDIDATE_EXECUTION_MODE,
  MULTIHOP_V4_CONTROL_ADAPTER_CLASS,
  MULTIHOP_V4_CONTROL_ADAPTER_ID,
  MULTIHOP_V4_CONTROL_EXECUTION_MODE,
  MULTIHOP_V4_CONTROL_HEADROOM,
  MULTIHOP_V4_CORPUS_SIZE,
  MULTIHOP_V4_DENSITIES,
  MULTIHOP_V4_DENSITY_COUNTS,
  MULTIHOP_V4_FREEZE,
  MULTIHOP_V4_FUNNEL_TOP_N,
  MULTIHOP_V4_K,
  MULTIHOP_V4_POLICY,
  MULTIHOP_V4_PROBES,
  type MultiHopV4Density,
  type MultiHopV4ScoredSplit,
} from './policy-v4.js';

const METRIC_KEYS = Object.freeze([
  'recallAtK', 'precisionAtK', 'reciprocalRank', 'ndcgAtK', 'answerCoverage',
  'staleLeakRate', 'isolationLeakRate', 'duplicateRate', 'unknownResultRate',
  'staleSafety', 'isolationSafety',
] as const satisfies readonly (keyof ProbeMetrics)[]);

/** Splits the hosted control runs and records: verdict splits plus the twin evidence split. */
export const MULTIHOP_V4_RECEIPT_SPLITS = Object.freeze(['dev', 'holdout', 'twin'] as const);
export type MultiHopV4ReceiptSplit = (typeof MULTIHOP_V4_RECEIPT_SPLITS)[number];
const VERDICT_SPLITS = Object.freeze(['dev', 'holdout'] as const satisfies readonly MultiHopV4ScoredSplit[]);

export interface MultiHopV4PublicInterval {
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

export interface MultiHopV4AggregateReport {
  readonly metric: typeof MULTIHOP_V4_POLICY.metric;
  readonly split: MultiHopV4ScoredSplit;
  readonly k: typeof MULTIHOP_V4_K;
  readonly n: number;
  readonly controlAdapterId: typeof MULTIHOP_V4_CONTROL_ADAPTER_ID;
  readonly candidateAdapterId: string;
  readonly controlSuccessRate: number;
  readonly candidateSuccessRate: number;
  readonly delta: number;
  readonly interval: Readonly<MultiHopV4PublicInterval>;
}

export interface MultiHopV4StratumReceipt {
  readonly n: number;
  readonly successes: number;
  readonly failures: number;
}

export interface MultiHopV4SplitReceipt {
  readonly n: number;
  readonly successes: number;
  readonly successRate: number;
  readonly strata: Readonly<Record<MultiHopV4Density, MultiHopV4StratumReceipt>>;
}

export type MultiHopV4ArtifactBindings = Readonly<Record<MultiHopV4ReceiptSplit, typeof MULTIHOP_V4_FREEZE.artifacts.dev>>;

interface MultiHopV4ControlReceiptCore {
  readonly schemaVersion: '1.0.0';
  readonly instrument: typeof MULTIHOP_V4_FREEZE.instrument;
  readonly instrumentVersion: typeof MULTIHOP_V4_FREEZE.version;
  readonly exactBaseCommit: typeof MULTIHOP_V4_FREEZE.exactBaseCommit;
  readonly seedCommitmentSha256: typeof MULTIHOP_V4_FREEZE.seedCommitmentSha256;
  readonly funnelTopN: typeof MULTIHOP_V4_FUNNEL_TOP_N;
  readonly receiptId: string;
  readonly createdAt: string;
  readonly executedSourceSha: string;
  readonly workflowRefSha: string;
  readonly workflowRun: Readonly<{ id: string; url: string; attempt: number }>;
  readonly producer: 'independent-scorer-custodian';
  readonly controlAdapterId: typeof MULTIHOP_V4_CONTROL_ADAPTER_ID;
  readonly controlAdapterClass: typeof MULTIHOP_V4_CONTROL_ADAPTER_CLASS;
  readonly controlExecutionMode: typeof MULTIHOP_V4_CONTROL_EXECUTION_MODE;
  readonly controlSourceIdentity: typeof MULTIHOP_V4_FREEZE.controlSourceIdentity;
  readonly candidateAbsentAtQualification: true;
  readonly candidateArtifactsObserved: false;
  readonly candidateExecutionObserved: false;
  readonly disclosure: 'closed-aggregate-only';
  readonly artifactBindings: MultiHopV4ArtifactBindings;
  /** dev + holdout are verdict terms; twin is recorded evidence only. */
  readonly splits: Readonly<Record<MultiHopV4ReceiptSplit, MultiHopV4SplitReceipt>>;
  readonly twinEvidence: Readonly<{ role: 'recorded-evidence-only'; verdictTerm: false }>;
}

export interface MultiHopV4ControlNodeEvidenceReceipt extends MultiHopV4ControlReceiptCore {
  readonly kind: 'ret007v4-control-qualification-node-evidence';
  readonly runtime: Readonly<{ execution: 'hosted'; platform: 'linux'; nodeMajor: 20 | 22 }>;
  readonly qualificationRuns: Readonly<Record<MultiHopV4ReceiptSplit, Readonly<{ id: string }>>>;
}

export interface MultiHopV4ControlQualificationReceipt extends MultiHopV4ControlReceiptCore {
  readonly kind: 'ret007v4-control-qualification';
  readonly runtime: Readonly<{ execution: 'hosted'; platform: 'linux'; nodeMajors: readonly [20, 22] }>;
  readonly evidenceReceiptIds: Readonly<Record<'node20' | 'node22', string>>;
  readonly qualificationRuns: Readonly<Record<
    'node20' | 'node22',
    Readonly<Record<MultiHopV4ReceiptSplit, Readonly<{ id: string }>>>
  >>;
}

export type MultiHopV4QualificationFailure =
  | 'dev:success-rate-outside-headroom'
  | 'holdout:success-rate-outside-headroom'
  | `dev:${MultiHopV4Density}:missing-success-or-failure`
  | `holdout:${MultiHopV4Density}:missing-success-or-failure`;

export interface MultiHopV4ControlQualificationReport {
  readonly outcome: 'qualified' | 'rejected';
  readonly instrument: typeof MULTIHOP_V4_FREEZE.instrument;
  readonly instrumentVersion: typeof MULTIHOP_V4_FREEZE.version;
  readonly receiptId: string;
  readonly controlAdapterId: typeof MULTIHOP_V4_CONTROL_ADAPTER_ID;
  readonly dev: Readonly<{ n: number; successRate: number; strataQualified: boolean }>;
  readonly holdout: Readonly<{ n: number; successRate: number; strataQualified: boolean }>;
  /** Descriptive only (n = 30): never enters `outcome`. */
  readonly twinEvidence: Readonly<{ n: number; successRate: number; verdictTerm: false }>;
  readonly failures: readonly MultiHopV4QualificationFailure[];
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

/** Shape/consistency validation for any receipt split; headroom failures only for verdict splits. */
function validateReceiptSplit(split: MultiHopV4ReceiptSplit, value: MultiHopV4SplitReceipt): MultiHopV4QualificationFailure[] {
  assertExactKeys(value, ['n', 'successes', 'successRate', 'strata'], `receipt.${split}`);
  assertExactKeys(value.strata, MULTIHOP_V4_DENSITIES, `receipt.${split}.strata`);
  if (value.n !== MULTIHOP_V4_PROBES[split]
    || !Number.isInteger(value.successes) || value.successes < 0 || value.successes > value.n
    || !sameNumber(value.successRate, value.successes / value.n)) {
    throw new Error(`receipt.${split}: invalid closed aggregate counts`);
  }
  const failures: MultiHopV4QualificationFailure[] = [];
  const verdictSplit = split === 'dev' || split === 'holdout' ? split : null;
  let stratumN = 0;
  let stratumSuccesses = 0;
  for (const density of MULTIHOP_V4_DENSITIES) {
    const stratum = value.strata[density];
    assertExactKeys(stratum, ['n', 'successes', 'failures'], `receipt.${split}.${density}`);
    if (stratum.n !== MULTIHOP_V4_DENSITY_COUNTS[split][density]
      || !Number.isInteger(stratum.successes) || !Number.isInteger(stratum.failures)
      || stratum.successes < 0 || stratum.failures < 0 || stratum.successes + stratum.failures !== stratum.n) {
      throw new Error(`receipt.${split}.${density}: invalid stratum counts`);
    }
    stratumN += stratum.n;
    stratumSuccesses += stratum.successes;
    if (verdictSplit && (stratum.successes < MULTIHOP_V4_CONTROL_HEADROOM.minimumSuccessesPerStratumInclusive
      || stratum.failures < MULTIHOP_V4_CONTROL_HEADROOM.minimumFailuresPerStratumInclusive)) {
      failures.push(`${verdictSplit}:${density}:missing-success-or-failure`);
    }
  }
  if (stratumN !== value.n || stratumSuccesses !== value.successes) {
    throw new Error(`receipt.${split}: stratum totals do not bind the split aggregate`);
  }
  if (verdictSplit && (value.successRate < MULTIHOP_V4_CONTROL_HEADROOM.minimumSuccessRateInclusive
    || value.successRate > MULTIHOP_V4_CONTROL_HEADROOM.maximumSuccessRateInclusive)) {
    failures.push(`${verdictSplit}:success-rate-outside-headroom`);
  }
  return failures;
}

function validateReceiptCommon(receipt: MultiHopV4ControlReceiptCore): readonly MultiHopV4QualificationFailure[] {
  if (receipt.schemaVersion !== '1.0.0' || receipt.instrument !== MULTIHOP_V4_FREEZE.instrument
    || receipt.instrumentVersion !== MULTIHOP_V4_FREEZE.version
    || receipt.exactBaseCommit !== MULTIHOP_V4_FREEZE.exactBaseCommit
    || receipt.seedCommitmentSha256 !== MULTIHOP_V4_FREEZE.seedCommitmentSha256
    || receipt.funnelTopN !== MULTIHOP_V4_FUNNEL_TOP_N) {
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
    || receipt.controlAdapterId !== MULTIHOP_V4_CONTROL_ADAPTER_ID
    || receipt.controlAdapterClass !== MULTIHOP_V4_CONTROL_ADAPTER_CLASS
    || receipt.controlExecutionMode !== MULTIHOP_V4_CONTROL_EXECUTION_MODE
    || receipt.candidateAbsentAtQualification !== true
    || receipt.candidateArtifactsObserved !== false
    || receipt.candidateExecutionObserved !== false
    || receipt.disclosure !== 'closed-aggregate-only') {
    throw new Error('receipt: hosted independent pre-candidate production-control attestation mismatch');
  }
  assertExactKeys(receipt.twinEvidence, ['role', 'verdictTerm'], 'receipt.twinEvidence');
  if (receipt.twinEvidence.role !== 'recorded-evidence-only' || receipt.twinEvidence.verdictTerm !== false) {
    throw new Error('receipt: twin split must be recorded evidence only, never a verdict term');
  }
  assertExactKeys(receipt.controlSourceIdentity, Object.keys(MULTIHOP_V4_FREEZE.controlSourceIdentity), 'receipt.controlSourceIdentity');
  if (Object.entries(MULTIHOP_V4_FREEZE.controlSourceIdentity)
    .some(([key, value]) => receipt.controlSourceIdentity[key as keyof typeof receipt.controlSourceIdentity] !== value)) {
    throw new Error('receipt: approved control source identity mismatch');
  }
  assertExactKeys(receipt.artifactBindings, MULTIHOP_V4_RECEIPT_SPLITS, 'receipt.artifactBindings');
  for (const split of MULTIHOP_V4_RECEIPT_SPLITS) {
    assertExactKeys(receipt.artifactBindings[split], ['input', 'oracle'], `receipt.artifactBindings.${split}`);
    assertArtifactBinding(receipt.artifactBindings[split].input, MULTIHOP_V4_FREEZE.artifacts[split].input, `receipt.${split}.input`);
    assertArtifactBinding(receipt.artifactBindings[split].oracle, MULTIHOP_V4_FREEZE.artifacts[split].oracle, `receipt.${split}.oracle`);
  }
  assertExactKeys(receipt.splits, MULTIHOP_V4_RECEIPT_SPLITS, 'receipt.splits');
  const twinFailures = validateReceiptSplit('twin', receipt.splits.twin);
  if (twinFailures.length !== 0) throw new Error('receipt.twin: evidence split produced a verdict failure');
  return Object.freeze([
    ...validateReceiptSplit('dev', receipt.splits.dev),
    ...validateReceiptSplit('holdout', receipt.splits.holdout),
  ]);
}

function publicQualificationReport(
  receipt: MultiHopV4ControlReceiptCore,
  failures: readonly MultiHopV4QualificationFailure[],
): Readonly<MultiHopV4ControlQualificationReport> {
  const splitPublic = (split: MultiHopV4ScoredSplit) => Object.freeze({
    n: receipt.splits[split].n,
    successRate: receipt.splits[split].successRate,
    strataQualified: MULTIHOP_V4_DENSITIES.every((density) => {
      const value = receipt.splits[split].strata[density];
      return value.successes >= MULTIHOP_V4_CONTROL_HEADROOM.minimumSuccessesPerStratumInclusive
        && value.failures >= MULTIHOP_V4_CONTROL_HEADROOM.minimumFailuresPerStratumInclusive;
    }),
  });
  return Object.freeze({
    outcome: failures.length === 0 ? 'qualified' : 'rejected',
    instrument: MULTIHOP_V4_FREEZE.instrument,
    instrumentVersion: MULTIHOP_V4_FREEZE.version,
    receiptId: receipt.receiptId,
    controlAdapterId: receipt.controlAdapterId,
    dev: splitPublic('dev'),
    holdout: splitPublic('holdout'),
    twinEvidence: Object.freeze({ n: receipt.splits.twin.n, successRate: receipt.splits.twin.successRate, verdictTerm: false as const }),
    failures: Object.freeze(failures),
  });
}

const RECEIPT_CORE_KEYS = [
  'schemaVersion', 'kind', 'instrument', 'instrumentVersion', 'exactBaseCommit', 'seedCommitmentSha256', 'funnelTopN',
  'receiptId', 'createdAt', 'executedSourceSha', 'workflowRefSha', 'workflowRun', 'producer', 'runtime',
  'controlAdapterId', 'controlAdapterClass', 'controlExecutionMode', 'qualificationRuns',
  'controlSourceIdentity', 'candidateAbsentAtQualification', 'candidateArtifactsObserved',
  'candidateExecutionObserved', 'disclosure', 'artifactBindings', 'splits', 'twinEvidence',
] as const;

/** Validates evidence from one hosted matrix node. This evidence is never accepted by the comparison scorer. */
export function qualifyMultiHopV4ControlNodeEvidenceReceipt(
  receipt: MultiHopV4ControlNodeEvidenceReceipt,
): Readonly<MultiHopV4ControlQualificationReport> {
  assertExactKeys(receipt, RECEIPT_CORE_KEYS, 'node evidence receipt');
  if (receipt.kind !== 'ret007v4-control-qualification-node-evidence') {
    throw new Error('node evidence receipt: evidence-only kind mismatch');
  }
  assertExactKeys(receipt.runtime, ['execution', 'platform', 'nodeMajor'], 'node evidence receipt.runtime');
  if (receipt.runtime.execution !== 'hosted' || receipt.runtime.platform !== 'linux'
    || (receipt.runtime.nodeMajor !== 20 && receipt.runtime.nodeMajor !== 22)) {
    throw new Error('node evidence receipt: hosted runtime mismatch');
  }
  assertExactKeys(receipt.qualificationRuns, MULTIHOP_V4_RECEIPT_SPLITS, 'node evidence receipt.qualificationRuns');
  if (receipt.receiptId !== `ret007v4-${receipt.workflowRun.id}-attempt${receipt.workflowRun.attempt}-node${receipt.runtime.nodeMajor}`) {
    throw new Error('node evidence receipt: receipt ID provenance mismatch');
  }
  const runIds = new Set<string>();
  for (const split of MULTIHOP_V4_RECEIPT_SPLITS) {
    assertExactKeys(receipt.qualificationRuns[split], ['id'], `node evidence receipt.qualificationRuns.${split}`);
    const expectedRunId = `ret007v4-${receipt.workflowRun.id}-attempt${receipt.workflowRun.attempt}`
      + `-node${receipt.runtime.nodeMajor}-${split}-control`;
    if (receipt.qualificationRuns[split].id !== expectedRunId) {
      throw new Error(`node evidence receipt.qualificationRuns.${split}: run ID provenance mismatch`);
    }
    runIds.add(receipt.qualificationRuns[split].id);
  }
  if (runIds.size !== MULTIHOP_V4_RECEIPT_SPLITS.length) {
    throw new Error('node evidence receipt: split qualification run IDs must be distinct');
  }
  const failures = validateReceiptCommon(receipt);
  return publicQualificationReport(receipt, failures);
}

/**
 * Accepts only the joined Node 20+22 authority receipt and emits closed aggregates.
 * A per-node evidence receipt cannot satisfy this exact schema.
 */
export function qualifyMultiHopV4ControlReceipt(
  receipt: MultiHopV4ControlQualificationReceipt,
): Readonly<MultiHopV4ControlQualificationReport> {
  assertExactKeys(receipt, [...RECEIPT_CORE_KEYS, 'evidenceReceiptIds'], 'receipt');
  if (receipt.kind !== 'ret007v4-control-qualification') throw new Error('receipt: joined authority kind mismatch');
  assertExactKeys(receipt.runtime, ['execution', 'platform', 'nodeMajors'], 'receipt.runtime');
  if (receipt.runtime.execution !== 'hosted' || receipt.runtime.platform !== 'linux'
    || receipt.runtime.nodeMajors.length !== 2
    || receipt.runtime.nodeMajors[0] !== 20 || receipt.runtime.nodeMajors[1] !== 22) {
    throw new Error('receipt: joined Node 20+22 runtime mismatch');
  }
  if (receipt.receiptId !== `ret007v4-${receipt.workflowRun.id}-attempt${receipt.workflowRun.attempt}-joined-node20-node22`) {
    throw new Error('receipt: receipt ID provenance mismatch');
  }
  assertExactKeys(receipt.evidenceReceiptIds, ['node20', 'node22'], 'receipt.evidenceReceiptIds');
  assertExactKeys(receipt.qualificationRuns, ['node20', 'node22'], 'receipt.qualificationRuns');
  for (const nodeMajor of [20, 22] as const) {
    const node = `node${nodeMajor}` as const;
    const expectedEvidenceId = `ret007v4-${receipt.workflowRun.id}-attempt${receipt.workflowRun.attempt}-node${nodeMajor}`;
    if (receipt.evidenceReceiptIds[node] !== expectedEvidenceId) {
      throw new Error(`receipt.evidenceReceiptIds.${node}: provenance mismatch`);
    }
    assertExactKeys(receipt.qualificationRuns[node], MULTIHOP_V4_RECEIPT_SPLITS, `receipt.qualificationRuns.${node}`);
    const runIds = new Set<string>();
    for (const split of MULTIHOP_V4_RECEIPT_SPLITS) {
      assertExactKeys(receipt.qualificationRuns[node][split], ['id'], `receipt.qualificationRuns.${node}.${split}`);
      const expectedRunId = `${expectedEvidenceId}-${split}-control`;
      if (receipt.qualificationRuns[node][split].id !== expectedRunId) {
        throw new Error(`receipt.qualificationRuns.${node}.${split}: run ID provenance mismatch`);
      }
      runIds.add(receipt.qualificationRuns[node][split].id);
    }
    if (runIds.size !== MULTIHOP_V4_RECEIPT_SPLITS.length) {
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

function densityOf(scenario: MultiHopV4ScoringScenario): MultiHopV4Density {
  const tags = scenario.input.tags?.filter((tag) => tag.startsWith('density:')) ?? [];
  const density = tags.length === 1 ? tags[0]!.slice('density:'.length) : '';
  if (!MULTIHOP_V4_DENSITIES.includes(density as MultiHopV4Density)) throw new Error(`${scenario.input.id}: invalid density stratum`);
  return density as MultiHopV4Density;
}

function validateFixtures(scenarios: readonly MultiHopV4ScoringScenario[]): MultiHopV4ScoredSplit {
  const split: unknown = scenarios[0]?.input.split;
  if (split !== 'dev' && split !== 'holdout') throw new Error('multi-hop v4 scorer requires a dev or holdout split (calib and twin are refused)');
  if (scenarios.length !== MULTIHOP_V4_PROBES[split]) {
    throw new Error(`multi-hop v4 scorer requires exactly ${MULTIHOP_V4_PROBES[split]} ${split} scenarios`);
  }
  const ids = new Set<string>();
  const densities = new Map<MultiHopV4Density, number>();
  for (const scenario of scenarios) {
    const { input, oracle } = scenario;
    if (ids.has(input.id)) throw new Error(`duplicate scenario ID: ${input.id}`);
    ids.add(input.id);
    if (input.split !== split) throw new Error(`${input.id}: split mismatch`);
    if (oracle.scenarioId !== input.id) throw new Error(`${input.id}: oracle scenario ID mismatch`);
    if (input.dimensions.length !== 1 || input.dimensions[0] !== 'multi-hop') throw new Error(`${input.id}: dimension mismatch`);
    if (input.queries.length !== 1 || input.queries[0]!.limit !== MULTIHOP_V4_K) {
      throw new Error(`${input.id}: requires one k=${MULTIHOP_V4_K} query`);
    }
    if (input.memories.length !== MULTIHOP_V4_CORPUS_SIZE) {
      throw new Error(`${input.id}: requires exactly ${MULTIHOP_V4_CORPUS_SIZE} memories`);
    }
    if (oracle.probes.length !== 1 || oracle.probes[0]!.probeId !== input.queries[0]!.id) throw new Error(`${input.id}: probe ID mismatch`);
    const required = oracle.probes[0]!.required;
    if (!required || required.length !== 2 || new Set(required).size !== 2) throw new Error(`${input.id}: invalid required hop IDs`);
    const corpus = new Set(input.memories.map(({ id }) => id));
    if (!required.every((id) => corpus.has(id))) throw new Error(`${input.id}: required hop ID absent from corpus`);
    const density = densityOf(scenario);
    densities.set(density, (densities.get(density) ?? 0) + 1);
  }
  for (const density of MULTIHOP_V4_DENSITIES) {
    if (densities.get(density) !== MULTIHOP_V4_DENSITY_COUNTS[split][density]) throw new Error(`multi-hop v4 ${density} density count mismatch`);
  }
  return split;
}

function validateArm(
  label: 'control' | 'candidate',
  arm: AdapterRunReport,
  scenarios: readonly MultiHopV4ScoringScenario[],
): readonly ScenarioReport[] {
  const expectedMode = label === 'control' ? MULTIHOP_V4_CONTROL_EXECUTION_MODE : MULTIHOP_V4_CANDIDATE_EXECUTION_MODE;
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
      MULTIHOP_V4_K,
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

function strictOutcome(scenario: MultiHopV4ScoringScenario, report: ScenarioReport): 0 | 1 {
  const required = scenario.oracle.probes[0]!.required!;
  const top = new Set(report.probes[0]!.resultIds.slice(0, MULTIHOP_V4_K));
  return required.every((id) => top.has(id)) ? 1 : 0;
}

function assertQualifiedControlAggregate(
  split: MultiHopV4ScoredSplit,
  scenarios: readonly MultiHopV4ScoringScenario[],
  pairs: readonly LabPairedBinaryOutcome[],
  expected: MultiHopV4SplitReceipt,
): void {
  const strata = {
    low: { n: 0, successes: 0, failures: 0 },
    medium: { n: 0, successes: 0, failures: 0 },
    high: { n: 0, successes: 0, failures: 0 },
  } satisfies Record<MultiHopV4Density, { n: number; successes: number; failures: number }>;
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
    || MULTIHOP_V4_DENSITIES.some((density) => (
      expected.strata[density].n !== strata[density].n
      || expected.strata[density].successes !== strata[density].successes
      || expected.strata[density].failures !== strata[density].failures
    ))) {
    throw new Error(`multi-hop v4 ${split} control aggregate does not match qualified receipt`);
  }
}

/** Strict all-two paired scoring. The returned object is closed aggregate-only and never carries the bootstrap seed. */
export function scoreMultiHopV4Comparison(
  scenarios: readonly MultiHopV4ScoringScenario[],
  comparison: ComparisonReport,
  receipt: MultiHopV4ControlQualificationReceipt,
): Readonly<MultiHopV4AggregateReport> {
  const qualification = qualifyMultiHopV4ControlReceipt(receipt);
  if (qualification.outcome !== 'qualified') throw new Error('multi-hop v4 control receipt is not qualified');
  const split = validateFixtures(scenarios);
  if (comparison.evidenceMode !== 'registered-ci') throw new Error('multi-hop v4 comparison requires registered-ci evidence');
  if (comparison.control.adapterId !== MULTIHOP_V4_CONTROL_ADAPTER_ID
    || comparison.control.adapterId !== receipt.controlAdapterId
    || comparison.control.executionMode !== receipt.controlExecutionMode) {
    throw new Error('multi-hop v4 control adapter/mode does not match qualified production receipt');
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
  const interval: Readonly<MultiHopV4PublicInterval> = internalInterval.unsupportedReason === undefined
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
    metric: MULTIHOP_V4_POLICY.metric,
    split,
    k: MULTIHOP_V4_K,
    n: MULTIHOP_V4_PROBES[split],
    controlAdapterId: MULTIHOP_V4_CONTROL_ADAPTER_ID,
    candidateAdapterId: comparison.candidate.adapterId,
    controlSuccessRate,
    candidateSuccessRate,
    delta: candidateSuccessRate - controlSuccessRate,
    interval,
  });
}

/** Exported for the verdict-shape tests: the verdict reads exactly these two splits. */
export const MULTIHOP_V4_VERDICT_SPLITS = VERDICT_SPLITS;
