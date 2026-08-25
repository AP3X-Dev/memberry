// RET-007 v4 hosted DEV-evaluation runner (D5) — clone of qualify-control-v4
// with the three deliberate differences of the D4 spec §9 (P1-5):
//   (a) NO candidate-absence assert: the registered candidate is the point;
//   (b) registered-adapters.ts / systems.json / experiments.json pinned at the
//       D5 candidate PR; funnel / core / runner pins unchanged from D3;
//   (c) freeze base + exact path list = the D5 PR merge base + envelope.
// DEV ONLY: this module never loads the holdout split. Twin is run on both arms
// as recorded evidence (twinDelta vs itemDelta, interpretive wording only);
// calib is run on the candidate alone for gate precision (diagnostic).
// Every artifact is a closed aggregate: no scenario, probe, query, result,
// oracle, bridge, or per-probe outcome escapes.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import type { LabAdapter } from '../contracts/adapter.js';
import type { AdapterRunReport, ComparisonReport } from '../contracts/report.js';
import type { LabScenario } from '../contracts/scenario.js';
import {
  MULTIHOP_V4_BRIDGE_DERIVATION,
  MULTIHOP_V4_CONTROL_ADAPTER_ID,
  MULTIHOP_V4_DENSITIES,
  MULTIHOP_V4_DENSITY_COUNTS,
  MULTIHOP_V4_FREEZE,
  MULTIHOP_V4_K,
  MULTIHOP_V4_POLICY,
  MULTIHOP_V4_PROBES,
  MULTIHOP_V4_QUALITY_METRICS,
  MULTIHOP_V4_SAFETY_METRICS,
  MULTIHOP_V4_SPLITS,
  evaluateMultiHopV4Policy,
  type MultiHopV4BridgeDerivation,
  type MultiHopV4Density,
  type MultiHopV4PolicyFailure,
  type MultiHopV4Split,
} from './policy-v4.js';
import {
  qualifyMultiHopV4ControlReceipt,
  scoreMultiHopV4Comparison,
  type MultiHopV4AggregateReport,
  type MultiHopV4ControlQualificationReceipt,
  type MultiHopV4StratumReceipt,
} from './scorer-only-v4.js';

const execFileAsync = promisify(execFile);
const TWIN_EVIDENCE_ROLE = 'recorded-evidence-only';

/** D5 freeze: the candidate PR's merge base and exhaustive envelope (C-sorted). */
export const RET007V4_DEV_EXACT_BASE_COMMIT = '36e4c0050c8651b81bf9119fd68083adc12c7b31';
export const RET007V4_DEV_ALLOWED_SOURCE_PATHS = Object.freeze([
  '.env.example',
  '.github/workflows/ret007-v4-dev-evaluation.yml',
  'bench/lab/__tests__/memberry-retrieval-core-funnel-multihop.test.ts',
  'bench/lab/adapters/memberry-retrieval-core-funnel-multihop.ts',
  'bench/lab/multihop/__tests__/evaluate-dev-v4.test.ts',
  'bench/lab/multihop/evaluate-dev-v4.ts',
  'bench/lab/registered-adapters.ts',
  'bench/lab/registry/systems.json',
  'package.json',
  'packages/mcp/src/bootstrap.ts',
  'packages/retrieval/src/__tests__/assembler.multihop.test.ts',
  'packages/retrieval/src/__tests__/multihop-expansion.test.ts',
  'packages/retrieval/src/__tests__/tools.multihop.test.ts',
  'packages/retrieval/src/assembler.ts',
  'packages/retrieval/src/multihop-expansion.ts',
  'packages/retrieval/src/tools.ts',
] as const);

/** Six pinned blobs: funnel / core / runner unchanged from D3; the three moved blobs re-pinned at the D5 PR. */
export const RET007V4_DEV_APPROVED_GIT_BLOBS = Object.freeze({
  [MULTIHOP_V4_FREEZE.controlSourceIdentity.controlAdapterPath]: MULTIHOP_V4_FREEZE.controlSourceIdentity.controlAdapterGitBlob,
  [MULTIHOP_V4_FREEZE.controlSourceIdentity.productionCoreAdapterPath]: MULTIHOP_V4_FREEZE.controlSourceIdentity.productionCoreAdapterGitBlob,
  'bench/lab/runner.ts': MULTIHOP_V4_FREEZE.controlSourceIdentity.runnerGitBlob,
  'bench/lab/registry/experiments.json': MULTIHOP_V4_FREEZE.controlSourceIdentity.experimentsRegistryGitBlob,
  'bench/lab/registered-adapters.ts': '223a20e3c6d31e648d3bbb381bae2e7b70194eb7',
  'bench/lab/registry/systems.json': '1c8d2811c02c46063850a884c961d4e81e24f08b',
});

/** The qualified control receipt (joined Node 20+22, D3) — sha256 of its bytes. */
export const RET007V4_CONTROL_RECEIPT_SHA256 = 'e02f0fb264ebb3110f2984e8d00ff2d58d26457a536fdea79d454f5e126d93fb';

export const RET007V4_CANDIDATE_ADAPTER_IDS = Object.freeze({
  'evidence-bridge': 'memberry-retrieval-core-funnel-multihop-evidence-bridge-v1',
  'fact-lexical': 'memberry-retrieval-core-funnel-multihop-fact-lexical-v1',
} as const satisfies Record<MultiHopV4BridgeDerivation, string>);

/** Interpretive wording rule (Decision 1c): twinDelta >= 0.5 x itemDelta => evidence-conditioned re-query gain. */
export const RET007V4_TWIN_WORDING = Object.freeze({
  evidenceConditioned: 'evidence-conditioned re-query gain (twinDelta >= 0.5 x itemDelta): the gain persists when the bridge is broken, so it is not attributable to the bridge hop',
  bridgeSpecific: 'bridge-specific gain (twinDelta < 0.5 x itemDelta): the gain depends on the intact bridge',
  noGain: 'no positive dev delta to interpret',
});

export type ClosedEvaluationFailureCode =
  | 'invalid-hosted-provenance'
  | 'source-preflight-failed'
  | 'artifact-binding-failed'
  | 'control-receipt-invalid'
  | 'registry-preflight-failed'
  | 'evaluation-execution-failed'
  | 'evaluation-aggregate-invalid'
  | 'closed-artifact-write-failed';

class ClosedEvaluationError extends Error {
  constructor(readonly code: ClosedEvaluationFailureCode) { super(code); }
}

export interface MultiHopV4ArmSplitAggregate {
  readonly n: number;
  readonly successes: number;
  readonly successRate: number;
  readonly strata: Readonly<Record<MultiHopV4Density, MultiHopV4StratumReceipt>>;
}

export interface MultiHopV4DevEvaluation {
  readonly policy: MultiHopV4BridgeDerivation;
  readonly candidateAdapterId: string;
  readonly controlAdapterId: typeof MULTIHOP_V4_CONTROL_ADAPTER_ID;
  readonly controlReceiptSha256: string;
  readonly controlReceiptId: string;
  readonly dev: Readonly<{
    aggregate: Readonly<MultiHopV4AggregateReport>;
    control: MultiHopV4ArmSplitAggregate;
    candidate: MultiHopV4ArmSplitAggregate;
    pointDeltaPoints: number;
    oneSidedLower95: number | null;
    policyFailures: readonly MultiHopV4PolicyFailure[];
    qualityDeltas: Readonly<Record<(typeof MULTIHOP_V4_QUALITY_METRICS)[number], number>>;
    safetyDeltas: Readonly<Record<(typeof MULTIHOP_V4_SAFETY_METRICS)[number], number>>;
    passed: boolean;
  }>;
  readonly twin: Readonly<{
    role: typeof TWIN_EVIDENCE_ROLE;
    verdictTerm: false;
    control: MultiHopV4ArmSplitAggregate;
    candidate: MultiHopV4ArmSplitAggregate;
    twinDelta: number;
    itemDelta: number;
    interpretation: string;
  }>;
  readonly calibGate: Readonly<{
    n: number;
    fired: number;
    firedRate: number;
    firedAndSucceeded: number;
    /** firedAndSucceeded / fired (null when nothing fired). */
    precision: number | null;
    definition: string;
  }>;
}

export interface MultiHopV4DevNodeEvidenceArtifact {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'ret007v4-dev-evaluation-node-evidence';
  readonly receipt: Readonly<{
    receiptId: string;
    createdAt: string;
    executedSourceSha: string;
    workflowRefSha: string;
    workflowRun: Readonly<{ id: string; url: string; attempt: number }>;
    runtime: Readonly<{ execution: 'hosted'; platform: 'linux'; nodeMajor: 20 | 22 }>;
    exactBaseCommit: typeof RET007V4_DEV_EXACT_BASE_COMMIT;
    instrument: typeof MULTIHOP_V4_FREEZE.instrument;
    instrumentVersion: typeof MULTIHOP_V4_FREEZE.version;
    artifactBindings: Readonly<Record<MultiHopV4Split, Readonly<Record<'input' | 'oracle', { sha256: string; sizeBytes: number }>>>>;
    approvedGitBlobs: typeof RET007V4_DEV_APPROVED_GIT_BLOBS;
    disclosure: 'closed-aggregate-only';
    splitsExecuted: readonly ['dev', 'twin', 'calib'];
    holdoutTouched: false;
  }>;
  readonly evaluation: Readonly<MultiHopV4DevEvaluation>;
  readonly evaluationSha256: string;
}

export interface MultiHopV4DevEvaluationArtifact {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'ret007v4-dev-evaluation';
  readonly receipt: Readonly<Omit<MultiHopV4DevNodeEvidenceArtifact['receipt'], 'runtime'> & {
    runtime: Readonly<{ execution: 'hosted'; platform: 'linux'; nodeMajors: readonly [20, 22] }>;
    evidenceReceiptIds: Readonly<Record<'node20' | 'node22', string>>;
  }>;
  readonly evaluation: Readonly<MultiHopV4DevEvaluation>;
  readonly evaluationSha256: string;
}

export interface MultiHopV4ClosedEvaluationFailureReceipt {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'ret007v4-dev-evaluation-failure' | 'ret007v4-dev-evaluation-node-evidence-failure';
  readonly outcome: 'rejected';
  readonly failureCode: ClosedEvaluationFailureCode;
  readonly executedSourceSha: string | null;
  readonly workflowRefSha: string | null;
  readonly workflowRun: Readonly<{ id: string | null; url: string | null; attempt: number | null }>;
  readonly runtime: Readonly<{ execution: 'hosted'; platform: string; nodeMajor: number | null }>;
  readonly disclosure: 'closed-aggregate-only';
}

interface HostedProvenance {
  sourceSha: string;
  workflowRefSha: string;
  runId: string;
  runUrl: string;
  attempt: number;
  nodeMajor: 20 | 22;
}

interface EvaluationRuntime {
  loadDev(repoRoot: string): Promise<readonly LabScenario[]>;
  loadTwin(repoRoot: string): Promise<readonly LabScenario[]>;
  loadCalib(repoRoot: string): Promise<readonly LabScenario[]>;
  compare(options: { runId: string; controlId: string; candidateId: string; scenarios: readonly LabScenario[]; split: string; repoRoot: string }): Promise<ComparisonReport>;
  createCandidate(policy: MultiHopV4BridgeDerivation): LabAdapter & { firings: ReadonlyMap<string, boolean> };
  run(options: { runId: string; adapter: LabAdapter; scenarios: readonly LabScenario[]; split: string }): Promise<AdapterRunReport>;
}

/** Loader graph is evaluated only after source preflight succeeds. Never imports a holdout loader. */
async function loadEvaluationRuntime(): Promise<EvaluationRuntime> {
  const [loaderModule, registeredModule, runnerModule, adapterModule] = await Promise.all([
    import('../datasets/load-multihop-v4.js'),
    import('../registered-adapters.js'),
    import('../runner.js'),
    import('../adapters/memberry-retrieval-core-funnel-multihop.js'),
  ]);
  return {
    loadDev: (repoRoot) => loaderModule.loadMultiHopV4ScenariosForScoring('dev', repoRoot),
    loadTwin: (repoRoot) => loaderModule.loadMultiHopV4TwinScenariosForEvidence(repoRoot),
    loadCalib: (repoRoot) => loaderModule.loadMultiHopV4CalibScenariosForCalibration(repoRoot),
    compare: (options) => registeredModule.compareRegisteredAdapters({
      runId: options.runId, controlId: options.controlId, candidateId: options.candidateId,
      scenarios: options.scenarios, splits: [options.split] as never, repoRoot: options.repoRoot,
    }),
    createCandidate: (policy) => (policy === 'evidence-bridge'
      ? new adapterModule.MemBerryRetrievalCoreFunnelMultihopEvidenceBridgeAdapter()
      : new adapterModule.MemBerryRetrievalCoreFunnelMultihopFactLexicalAdapter()),
    run: (options) => runnerModule.runAdapter({
      runId: options.runId, adapter: options.adapter, scenarios: options.scenarios, splits: [options.split] as never,
    }),
  };
}

function ordinalCompare(left: string, right: string): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactStringSet(actual: readonly string[], expected: readonly string[]): boolean {
  const left = [...actual].sort(ordinalCompare);
  const right = [...expected].sort(ordinalCompare);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function git(repoRoot: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', [...args], { cwd: repoRoot, encoding: 'utf8' });
  return result.stdout.trim();
}

export function assertDevSourceChangedPaths(paths: readonly string[]): void {
  const normalized = paths.filter(Boolean).map((path) => path.replace(/\\/g, '/'));
  if (!exactStringSet(normalized, RET007V4_DEV_ALLOWED_SOURCE_PATHS)) throw new ClosedEvaluationError('source-preflight-failed');
}

async function assertSourcePreflight(repoRoot: string, sourceSha: string): Promise<void> {
  try {
    if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error('invalid source SHA');
    if (await git(repoRoot, ['rev-parse', 'HEAD']) !== sourceSha) throw new Error('HEAD mismatch');
    await execFileAsync('git', ['merge-base', '--is-ancestor', RET007V4_DEV_EXACT_BASE_COMMIT, sourceSha], { cwd: repoRoot });
    assertDevSourceChangedPaths((await git(repoRoot, ['diff', '--name-only', RET007V4_DEV_EXACT_BASE_COMMIT, sourceSha])).split(/\r?\n/));
    for (const [path, expectedBlob] of Object.entries(RET007V4_DEV_APPROVED_GIT_BLOBS)) {
      if (await git(repoRoot, ['rev-parse', `${sourceSha}:${path}`]) !== expectedBlob) throw new Error('source drift');
    }
  } catch {
    throw new ClosedEvaluationError('source-preflight-failed');
  }
}

async function bindArtifacts(repoRoot: string): Promise<MultiHopV4DevNodeEvidenceArtifact['receipt']['artifactBindings']> {
  try {
    const result = {} as Record<MultiHopV4Split, Record<'input' | 'oracle', { sha256: string; sizeBytes: number }>>;
    for (const split of MULTIHOP_V4_SPLITS) {
      result[split] = {} as Record<'input' | 'oracle', { sha256: string; sizeBytes: number }>;
      for (const role of ['input', 'oracle'] as const) {
        const bytes = await readFile(resolve(repoRoot, `bench/lab/datasets/multihop/v4/${split}/${role}.jsonl`));
        const actual = { sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.byteLength };
        const expected = MULTIHOP_V4_FREEZE.artifacts[split][role];
        if (actual.sha256 !== expected.sha256 || actual.sizeBytes !== expected.sizeBytes) throw new Error('artifact mismatch');
        result[split][role] = actual;
      }
    }
    return result;
  } catch {
    throw new ClosedEvaluationError('artifact-binding-failed');
  }
}

/** The qualified control receipt is bound by hash, then re-qualified. */
export async function loadQualifiedControlReceipt(path: string): Promise<{ receipt: MultiHopV4ControlQualificationReceipt; sha256: string }> {
  try {
    const bytes = await readFile(path);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== RET007V4_CONTROL_RECEIPT_SHA256) throw new Error('control receipt hash mismatch');
    const artifact = JSON.parse(bytes.toString('utf8')) as { kind?: string; receipt?: MultiHopV4ControlQualificationReceipt };
    if (artifact.kind !== 'ret007v4-control-qualification' || !artifact.receipt) throw new Error('control receipt kind mismatch');
    if (qualifyMultiHopV4ControlReceipt(artifact.receipt).outcome !== 'qualified') throw new Error('control not qualified');
    return { receipt: artifact.receipt, sha256 };
  } catch {
    throw new ClosedEvaluationError('control-receipt-invalid');
  }
}

function policyOf(environment: NodeJS.ProcessEnv): MultiHopV4BridgeDerivation {
  const policy = environment.RET007V4_POLICY ?? '';
  if (!MULTIHOP_V4_BRIDGE_DERIVATION.includes(policy as MultiHopV4BridgeDerivation)) {
    throw new ClosedEvaluationError('invalid-hosted-provenance');
  }
  return policy as MultiHopV4BridgeDerivation;
}

function densityOf(scenario: LabScenario): MultiHopV4Density {
  const values = scenario.input.tags?.filter((tag) => tag.startsWith('density:')) ?? [];
  const density = values.length === 1 ? values[0]!.slice('density:'.length) : '';
  if (!MULTIHOP_V4_DENSITIES.includes(density as MultiHopV4Density)) throw new ClosedEvaluationError('evaluation-aggregate-invalid');
  return density as MultiHopV4Density;
}

function strictSuccess(scenario: LabScenario, report: AdapterRunReport, index: number): boolean {
  const scenarioReport = report.scenarioReports[index];
  if (!scenarioReport || scenarioReport.scenarioId !== scenario.input.id || scenarioReport.outcome !== 'scored'
    || scenarioReport.probes.length !== 1 || scenarioReport.probes[0]!.probeId !== scenario.input.queries[0]!.id) {
    throw new ClosedEvaluationError('evaluation-aggregate-invalid');
  }
  const required = scenario.oracle.probes[0]!.required;
  if (!required || required.length !== 2) throw new ClosedEvaluationError('evaluation-aggregate-invalid');
  const top = new Set(scenarioReport.probes[0]!.resultIds.slice(0, MULTIHOP_V4_K));
  return required.every((id) => top.has(id));
}

/** Closed per-split aggregate for one arm (dev / twin / calib): counts and strata only. */
export function computeArmSplitAggregate(
  split: MultiHopV4Split,
  scenarios: readonly LabScenario[],
  report: AdapterRunReport,
): MultiHopV4ArmSplitAggregate {
  if (scenarios.length !== MULTIHOP_V4_PROBES[split] || report.outcome !== 'scored' || report.health !== 'ready'
    || report.excludedScenarios.length !== 0 || report.scenarioReports.length !== scenarios.length) {
    throw new ClosedEvaluationError('evaluation-aggregate-invalid');
  }
  const strata = {
    low: { n: 0, successes: 0, failures: 0 },
    medium: { n: 0, successes: 0, failures: 0 },
    high: { n: 0, successes: 0, failures: 0 },
  } satisfies Record<MultiHopV4Density, { n: number; successes: number; failures: number }>;
  let successes = 0;
  for (const [index, scenario] of scenarios.entries()) {
    if ((scenario.input.split as string) !== split) throw new ClosedEvaluationError('evaluation-aggregate-invalid');
    const success = strictSuccess(scenario, report, index);
    const density = densityOf(scenario);
    strata[density].n += 1;
    strata[density][success ? 'successes' : 'failures'] += 1;
    if (success) successes += 1;
  }
  for (const density of MULTIHOP_V4_DENSITIES) {
    if (strata[density].n !== MULTIHOP_V4_DENSITY_COUNTS[split][density]) throw new ClosedEvaluationError('evaluation-aggregate-invalid');
  }
  return Object.freeze({
    n: scenarios.length,
    successes,
    successRate: successes / scenarios.length,
    strata: Object.freeze({
      low: Object.freeze({ ...strata.low }),
      medium: Object.freeze({ ...strata.medium }),
      high: Object.freeze({ ...strata.high }),
    }),
  });
}

/** Gate precision on calib: among fired probes, the share whose top-K carried both hops. */
export function computeCalibGatePrecision(
  scenarios: readonly LabScenario[],
  report: AdapterRunReport,
  firings: ReadonlyMap<string, boolean>,
): MultiHopV4DevEvaluation['calibGate'] {
  if (scenarios.length !== MULTIHOP_V4_PROBES.calib) throw new ClosedEvaluationError('evaluation-aggregate-invalid');
  let fired = 0;
  let firedAndSucceeded = 0;
  for (const [index, scenario] of scenarios.entries()) {
    const success = strictSuccess(scenario, report, index);
    const key = `${scenario.input.project} ${scenario.input.queries[0]!.query}`;
    const didFire = firings.get(key);
    if (didFire === undefined) throw new ClosedEvaluationError('evaluation-aggregate-invalid');
    if (!didFire) continue;
    fired += 1;
    if (success) firedAndSucceeded += 1;
  }
  return Object.freeze({
    n: scenarios.length,
    fired,
    firedRate: fired / scenarios.length,
    firedAndSucceeded,
    precision: fired === 0 ? null : firedAndSucceeded / fired,
    definition: 'fired = the candidate issued at least one pass-2 probe; precision = P(both hops in top-10 | fired) on calib',
  });
}

export function twinInterpretation(twinDelta: number, itemDelta: number): string {
  if (itemDelta <= 0) return RET007V4_TWIN_WORDING.noGain;
  return twinDelta >= 0.5 * itemDelta ? RET007V4_TWIN_WORDING.evidenceConditioned : RET007V4_TWIN_WORDING.bridgeSpecific;
}

function metricDeltas<T extends readonly string[]>(comparison: ComparisonReport, metrics: T): Readonly<Record<T[number], number>> {
  const byMetric = new Map(comparison.deltas.map((delta) => [delta.metric as string, delta.delta]));
  const result = {} as Record<T[number], number>;
  for (const metric of metrics) {
    const value = byMetric.get(metric);
    if (value === undefined) throw new ClosedEvaluationError('evaluation-aggregate-invalid');
    result[metric as T[number]] = value;
  }
  return Object.freeze(result);
}

function hostedProvenance(environment: NodeJS.ProcessEnv): HostedProvenance {
  const sourceSha = environment.RET007V4_SOURCE_SHA ?? '';
  const workflowRefSha = environment.GITHUB_SHA ?? '';
  const runId = environment.GITHUB_RUN_ID ?? '';
  const repository = environment.GITHUB_REPOSITORY ?? '';
  const server = environment.GITHUB_SERVER_URL ?? '';
  const attempt = Number(environment.GITHUB_RUN_ATTEMPT);
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const runUrl = `${server}/${repository}/actions/runs/${runId}`;
  if (!/^[0-9a-f]{40}$/.test(sourceSha) || workflowRefSha !== sourceSha || !/^[1-9][0-9]*$/.test(runId)
    || !/^[^/]+\/[^/]+$/.test(repository) || server !== 'https://github.com'
    || !Number.isInteger(attempt) || attempt < 1 || process.platform !== 'linux'
    || (nodeMajor !== 20 && nodeMajor !== 22)
    || environment.RET007V4_TWIN_EVIDENCE_ROLE !== TWIN_EVIDENCE_ROLE) {
    throw new ClosedEvaluationError('invalid-hosted-provenance');
  }
  return { sourceSha, workflowRefSha, runId, runUrl, attempt, nodeMajor } as HostedProvenance;
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Builds the closed evaluation record from the three runs; exported for the shape tests. */
export function buildDevEvaluation(input: {
  policy: MultiHopV4BridgeDerivation;
  controlReceipt: MultiHopV4ControlQualificationReceipt;
  controlReceiptSha256: string;
  dev: { scenarios: readonly LabScenario[]; comparison: ComparisonReport };
  twin: { scenarios: readonly LabScenario[]; comparison: ComparisonReport };
  calib: { scenarios: readonly LabScenario[]; report: AdapterRunReport; firings: ReadonlyMap<string, boolean> };
}): Readonly<MultiHopV4DevEvaluation> {
  const candidateAdapterId = RET007V4_CANDIDATE_ADAPTER_IDS[input.policy];
  if (input.dev.comparison.candidate.adapterId !== candidateAdapterId
    || input.twin.comparison.candidate.adapterId !== candidateAdapterId
    || input.calib.report.adapterId !== candidateAdapterId) {
    throw new ClosedEvaluationError('evaluation-aggregate-invalid');
  }
  let aggregate: Readonly<MultiHopV4AggregateReport>;
  try { aggregate = scoreMultiHopV4Comparison(input.dev.scenarios, input.dev.comparison, input.controlReceipt); }
  catch { throw new ClosedEvaluationError('evaluation-aggregate-invalid'); }
  const policyFailures = evaluateMultiHopV4Policy(aggregate, input.dev.comparison);
  const devControl = computeArmSplitAggregate('dev', input.dev.scenarios, input.dev.comparison.control);
  const devCandidate = computeArmSplitAggregate('dev', input.dev.scenarios, input.dev.comparison.candidate);
  const twinControl = computeArmSplitAggregate('twin', input.twin.scenarios, input.twin.comparison.control);
  const twinCandidate = computeArmSplitAggregate('twin', input.twin.scenarios, input.twin.comparison.candidate);
  const itemDelta = devCandidate.successRate - devControl.successRate;
  const twinDelta = twinCandidate.successRate - twinControl.successRate;
  return Object.freeze({
    policy: input.policy,
    candidateAdapterId,
    controlAdapterId: MULTIHOP_V4_CONTROL_ADAPTER_ID,
    controlReceiptSha256: input.controlReceiptSha256,
    controlReceiptId: input.controlReceipt.receiptId,
    dev: Object.freeze({
      aggregate,
      control: devControl,
      candidate: devCandidate,
      pointDeltaPoints: Math.round(aggregate.delta * 1000) / 10,
      oneSidedLower95: aggregate.interval.oneSidedLower,
      policyFailures,
      qualityDeltas: metricDeltas(input.dev.comparison, MULTIHOP_V4_QUALITY_METRICS),
      safetyDeltas: metricDeltas(input.dev.comparison, MULTIHOP_V4_SAFETY_METRICS),
      passed: policyFailures.length === 0 && aggregate.delta * 100 >= MULTIHOP_V4_POLICY.reportedMinimumMeaningfulDeltaPoints,
    }),
    twin: Object.freeze({
      role: TWIN_EVIDENCE_ROLE,
      verdictTerm: false,
      control: twinControl,
      candidate: twinCandidate,
      twinDelta,
      itemDelta,
      interpretation: twinInterpretation(twinDelta, itemDelta),
    }),
    calibGate: computeCalibGatePrecision(input.calib.scenarios, input.calib.report, input.calib.firings),
  });
}

async function executeDevNodeEvidence(repoRoot: string, environment: NodeJS.ProcessEnv): Promise<Readonly<MultiHopV4DevNodeEvidenceArtifact>> {
  const hosted = hostedProvenance(environment);
  const policy = policyOf(environment);
  await assertSourcePreflight(repoRoot, hosted.sourceSha);
  const artifactBindings = await bindArtifacts(repoRoot);
  const controlReceiptPath = environmentValue(environment.RET007V4_CONTROL_RECEIPT_PATH);
  if (!controlReceiptPath) throw new ClosedEvaluationError('control-receipt-invalid');
  const control = await loadQualifiedControlReceipt(resolve(controlReceiptPath));
  const runtime = await loadEvaluationRuntime();
  const candidateId = RET007V4_CANDIDATE_ADAPTER_IDS[policy];
  const runPrefix = `ret007v4-dev-${hosted.runId}-attempt${hosted.attempt}-node${hosted.nodeMajor}-${policy}`;
  let evaluation: Readonly<MultiHopV4DevEvaluation>;
  try {
    const [devScenarios, twinScenarios, calibScenarios] = await Promise.all([
      runtime.loadDev(repoRoot), runtime.loadTwin(repoRoot), runtime.loadCalib(repoRoot),
    ]);
    const dev = await runtime.compare({
      runId: `${runPrefix}-dev`, controlId: MULTIHOP_V4_CONTROL_ADAPTER_ID, candidateId, scenarios: devScenarios, split: 'dev', repoRoot,
    });
    const twin = await runtime.compare({
      runId: `${runPrefix}-twin`, controlId: MULTIHOP_V4_CONTROL_ADAPTER_ID, candidateId, scenarios: twinScenarios, split: 'twin', repoRoot,
    });
    const calibAdapter = runtime.createCandidate(policy);
    const calibReport = await runtime.run({ runId: `${runPrefix}-calib`, adapter: calibAdapter, scenarios: calibScenarios, split: 'calib' });
    evaluation = buildDevEvaluation({
      policy, controlReceipt: control.receipt, controlReceiptSha256: control.sha256,
      dev: { scenarios: devScenarios, comparison: dev },
      twin: { scenarios: twinScenarios, comparison: twin },
      calib: { scenarios: calibScenarios, report: calibReport, firings: calibAdapter.firings },
    });
  } catch (error) {
    if (error instanceof ClosedEvaluationError) throw error;
    throw new ClosedEvaluationError('evaluation-execution-failed');
  }
  return Object.freeze({
    schemaVersion: '1.0.0',
    kind: 'ret007v4-dev-evaluation-node-evidence',
    receipt: Object.freeze({
      receiptId: `ret007v4-dev-${hosted.runId}-attempt${hosted.attempt}-node${hosted.nodeMajor}`,
      createdAt: new Date().toISOString(),
      executedSourceSha: hosted.sourceSha,
      workflowRefSha: hosted.workflowRefSha,
      workflowRun: Object.freeze({ id: hosted.runId, url: hosted.runUrl, attempt: hosted.attempt }),
      runtime: Object.freeze({ execution: 'hosted', platform: 'linux', nodeMajor: hosted.nodeMajor }),
      exactBaseCommit: RET007V4_DEV_EXACT_BASE_COMMIT,
      instrument: MULTIHOP_V4_FREEZE.instrument,
      instrumentVersion: MULTIHOP_V4_FREEZE.version,
      artifactBindings,
      approvedGitBlobs: RET007V4_DEV_APPROVED_GIT_BLOBS,
      disclosure: 'closed-aggregate-only',
      splitsExecuted: ['dev', 'twin', 'calib'] as const,
      holdoutTouched: false,
    }),
    evaluation,
    evaluationSha256: sha256Json(evaluation),
  });
}

function nodeEvidenceArtifact(value: unknown, nodeMajor: 20 | 22): MultiHopV4DevNodeEvidenceArtifact {
  if (!value || typeof value !== 'object') throw new ClosedEvaluationError('evaluation-aggregate-invalid');
  const artifact = value as MultiHopV4DevNodeEvidenceArtifact;
  if (artifact.schemaVersion !== '1.0.0' || artifact.kind !== 'ret007v4-dev-evaluation-node-evidence'
    || artifact.receipt?.runtime?.nodeMajor !== nodeMajor || artifact.receipt.holdoutTouched !== false
    || sha256Json(artifact.evaluation) !== artifact.evaluationSha256) {
    throw new ClosedEvaluationError('evaluation-aggregate-invalid');
  }
  return artifact;
}

/** Joins exactly Node 20 and Node 22 evidence; the evaluation must be byte-identical across nodes. */
export function joinDevEvaluationEvidence(
  node20Value: unknown,
  node22Value: unknown,
  matrixResult: string,
  environment: NodeJS.ProcessEnv,
): Readonly<MultiHopV4DevEvaluationArtifact> {
  const hosted = hostedProvenance(environment);
  const policy = policyOf(environment);
  const node20 = nodeEvidenceArtifact(node20Value, 20);
  const node22 = nodeEvidenceArtifact(node22Value, 22);
  if (matrixResult !== 'success') throw new ClosedEvaluationError('evaluation-execution-failed');
  const left = node20.receipt;
  const right = node22.receipt;
  if (node20.evaluationSha256 !== node22.evaluationSha256
    || node20.evaluation.policy !== policy
    || left.executedSourceSha !== hosted.sourceSha || right.executedSourceSha !== hosted.sourceSha
    || left.workflowRefSha !== hosted.workflowRefSha || right.workflowRefSha !== hosted.workflowRefSha
    || JSON.stringify(left.workflowRun) !== JSON.stringify(right.workflowRun)
    || left.workflowRun.id !== hosted.runId || left.workflowRun.attempt !== hosted.attempt
    || JSON.stringify(left.artifactBindings) !== JSON.stringify(right.artifactBindings)
    || JSON.stringify(left.approvedGitBlobs) !== JSON.stringify(right.approvedGitBlobs)) {
    throw new ClosedEvaluationError('evaluation-aggregate-invalid');
  }
  const { runtime: _runtime, ...core } = left;
  return Object.freeze({
    schemaVersion: '1.0.0',
    kind: 'ret007v4-dev-evaluation',
    receipt: Object.freeze({
      ...core,
      receiptId: `ret007v4-dev-${hosted.runId}-attempt${hosted.attempt}-joined-node20-node22`,
      createdAt: new Date().toISOString(),
      runtime: Object.freeze({ execution: 'hosted', platform: 'linux', nodeMajors: Object.freeze([20, 22] as const) }),
      evidenceReceiptIds: Object.freeze({ node20: left.receiptId, node22: right.receiptId }),
    }),
    evaluation: node20.evaluation,
    evaluationSha256: node20.evaluationSha256,
  });
}

export function closedEvaluationFailureReceipt(
  code: ClosedEvaluationFailureCode,
  environment: NodeJS.ProcessEnv,
  kind: MultiHopV4ClosedEvaluationFailureReceipt['kind'] = 'ret007v4-dev-evaluation-failure',
): Readonly<MultiHopV4ClosedEvaluationFailureReceipt> {
  const sourceSha = /^[0-9a-f]{40}$/.test(environment.RET007V4_SOURCE_SHA ?? '') ? environment.RET007V4_SOURCE_SHA! : null;
  const workflowRefSha = /^[0-9a-f]{40}$/.test(environment.GITHUB_SHA ?? '') ? environment.GITHUB_SHA! : null;
  const runId = /^[1-9][0-9]*$/.test(environment.GITHUB_RUN_ID ?? '') ? environment.GITHUB_RUN_ID! : null;
  const repository = /^[^/]+\/[^/]+$/.test(environment.GITHUB_REPOSITORY ?? '') ? environment.GITHUB_REPOSITORY! : null;
  const server = environment.GITHUB_SERVER_URL === 'https://github.com' ? environment.GITHUB_SERVER_URL : null;
  const attemptValue = Number(environment.GITHUB_RUN_ATTEMPT);
  const attempt = Number.isInteger(attemptValue) && attemptValue > 0 ? attemptValue : null;
  const nodeValue = Number(process.versions.node.split('.')[0]);
  return Object.freeze({
    schemaVersion: '1.0.0', kind, outcome: 'rejected', failureCode: code,
    executedSourceSha: sourceSha,
    workflowRefSha,
    workflowRun: Object.freeze({
      id: runId,
      url: runId && repository && server ? `${server}/${repository}/actions/runs/${runId}` : null,
      attempt,
    }),
    runtime: Object.freeze({ execution: 'hosted', platform: process.platform, nodeMajor: Number.isInteger(nodeValue) ? nodeValue : null }),
    disclosure: 'closed-aggregate-only',
  });
}

async function writeClosedJson(path: string, value: unknown): Promise<string> {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
  return createHash('sha256').update(text).digest('hex');
}

async function nodeEvidenceMain(): Promise<void> {
  const repoRoot = resolve(process.cwd());
  const nodeMajor = process.versions.node.split('.')[0] ?? 'unknown';
  const receiptPath = resolve(environmentValue(process.env.RET007V4_RECEIPT_PATH) ?? `artifacts/ret007v4-dev/receipt-node${nodeMajor}.json`);
  try {
    const artifact = await executeDevNodeEvidence(repoRoot, process.env);
    await writeClosedJson(receiptPath, artifact);
    process.stderr.write(`${JSON.stringify({ outcome: 'recorded', policy: artifact.evaluation.policy, passed: artifact.evaluation.dev.passed })}\n`);
  } catch (error) {
    const code = error instanceof ClosedEvaluationError ? error.code : 'evaluation-execution-failed';
    try { await writeClosedJson(receiptPath, closedEvaluationFailureReceipt(code, process.env, 'ret007v4-dev-evaluation-node-evidence-failure')); }
    catch { process.exitCode = 1; return; }
    process.exitCode = 1;
    process.stderr.write(`${JSON.stringify({ outcome: 'rejected', failureCode: code })}\n`);
  }
}

async function authorityJoinMain(): Promise<void> {
  const receiptPath = resolve(environmentValue(process.env.RET007V4_RECEIPT_PATH) ?? 'artifacts/ret007v4-dev/receipt-authoritative.json');
  try {
    const node20Path = environmentValue(process.env.RET007V4_NODE20_EVIDENCE_PATH);
    const node22Path = environmentValue(process.env.RET007V4_NODE22_EVIDENCE_PATH);
    if (!node20Path || !node22Path) throw new ClosedEvaluationError('evaluation-aggregate-invalid');
    const [node20, node22] = await Promise.all([
      readFile(resolve(node20Path), 'utf8').then((value) => JSON.parse(value) as unknown),
      readFile(resolve(node22Path), 'utf8').then((value) => JSON.parse(value) as unknown),
    ]);
    const artifact = joinDevEvaluationEvidence(node20, node22, process.env.RET007V4_MATRIX_RESULT ?? '', process.env);
    const sha256 = await writeClosedJson(receiptPath, artifact);
    await writeFile(receiptPath.replace(/\.json$/, '.sha256'), `${sha256}  ${receiptPath.split(/[\\/]/).pop()}\n`, 'utf8');
    process.stderr.write(`${JSON.stringify({ outcome: 'recorded', sha256, evaluationSha256: artifact.evaluationSha256 })}\n`);
  } catch (error) {
    const code = error instanceof ClosedEvaluationError ? error.code : 'evaluation-aggregate-invalid';
    try { await writeClosedJson(receiptPath, closedEvaluationFailureReceipt(code, process.env)); }
    catch { process.exitCode = 1; return; }
    process.exitCode = 1;
    process.stderr.write(`${JSON.stringify({ outcome: 'rejected', failureCode: code })}\n`);
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === 'node') return nodeEvidenceMain();
  if (mode === 'join') return authorityJoinMain();
  process.exitCode = 1;
  process.stderr.write('{"outcome":"rejected","failureCode":"invalid-hosted-provenance"}\n');
}

function environmentValue(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main();
}
