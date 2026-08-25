// RET-007 v4 hosted control-only qualification runner — clone of
// qualify-control-v3 with the v4 identity: the FUNNEL control adapter, SIX
// pinned blobs (five v3 control-identity paths + the funnel adapter), the
// exact 4-ID dataset registry set, the v4 candidate-absence marker, and the
// broken-bridge TWIN split executed and RECORDED as evidence only (never a
// verdict term: verdict = dev in band AND holdout in band AND strata mixed).

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import type { LabAdapter } from '../contracts/adapter.js';
import type { AdapterRunReport } from '../contracts/report.js';
import type { LabScenario } from '../contracts/scenario.js';
import {
  MULTIHOP_V4_CONTROL_ADAPTER_CLASS,
  MULTIHOP_V4_CONTROL_ADAPTER_ID,
  MULTIHOP_V4_CONTROL_EXECUTION_MODE,
  MULTIHOP_V4_DENSITIES,
  MULTIHOP_V4_DENSITY_COUNTS,
  MULTIHOP_V4_FREEZE,
  MULTIHOP_V4_FUNNEL_TOP_N,
  MULTIHOP_V4_K,
  MULTIHOP_V4_PROBES,
  type MultiHopV4Density,
} from './policy-v4.js';
import {
  MULTIHOP_V4_RECEIPT_SPLITS,
  qualifyMultiHopV4ControlReceipt,
  qualifyMultiHopV4ControlNodeEvidenceReceipt,
  type MultiHopV4ArtifactBindings,
  type MultiHopV4ControlNodeEvidenceReceipt,
  type MultiHopV4ControlQualificationReceipt,
  type MultiHopV4ControlQualificationReport,
  type MultiHopV4ReceiptSplit,
  type MultiHopV4SplitReceipt,
} from './scorer-only-v4.js';

const execFileAsync = promisify(execFile);
const CONTROL_CAPABILITIES = Object.freeze([
  'cleanup', 'feedback', 'namespaces', 'project-scope', 'stats', 'temporal-filtering', 'tenant-scope',
] as const);
const CONTROL_FIDELITY_DETAIL = 'production-retrieval / fixture-persistence / bm25-funnel-top12';
const V4_REGISTRATION_MARKER = /ret-?007-?v4|multi-?hop-v4|multihop-v4/i;
const TWIN_EVIDENCE_ROLE = 'recorded-evidence-only';
const V4_DATASET_IDS = Object.freeze([
  'memberry-multihop-v4-calib', 'memberry-multihop-v4-dev', 'memberry-multihop-v4-holdout', 'memberry-multihop-v4-twin',
] as const);

/** Exhaustive envelope: every path the RET-007 v4 D2 PR adds or modifies (C-sorted). */
export const RET007V4_ALLOWED_SOURCE_PATHS = Object.freeze([
  '.github/workflows/ret007-v4-control-qualification.yml',
  'bench/lab/__tests__/memberry-retrieval-core-funnel.test.ts',
  'bench/lab/adapters/memberry-retrieval-core-funnel.ts',
  'bench/lab/datasets/__tests__/load-multihop-v4.test.ts',
  'bench/lab/datasets/load-multihop-v4.ts',
  'bench/lab/datasets/multihop/v4/calib/input.jsonl',
  'bench/lab/datasets/multihop/v4/calib/oracle.jsonl',
  'bench/lab/datasets/multihop/v4/dev/input.jsonl',
  'bench/lab/datasets/multihop/v4/dev/oracle.jsonl',
  'bench/lab/datasets/multihop/v4/holdout/input.jsonl',
  'bench/lab/datasets/multihop/v4/holdout/oracle.jsonl',
  'bench/lab/datasets/multihop/v4/twin/input.jsonl',
  'bench/lab/datasets/multihop/v4/twin/oracle.jsonl',
  'bench/lab/multihop/CALIBRATION-V4.md',
  'bench/lab/multihop/EXCHANGEABILITY-V4.md',
  'bench/lab/multihop/__tests__/exchangeability-v4.test.ts',
  'bench/lab/multihop/__tests__/generate-v4.test.ts',
  'bench/lab/multihop/__tests__/qualify-control-v4.test.ts',
  'bench/lab/multihop/__tests__/scorer-only-v4.test.ts',
  'bench/lab/multihop/calibrate-v4.ts',
  'bench/lab/multihop/exchangeability-v4.ts',
  'bench/lab/multihop/generate-v4.ts',
  'bench/lab/multihop/policy-v4.ts',
  'bench/lab/multihop/qualify-control-v4.ts',
  'bench/lab/multihop/scorer-only-v4.ts',
  'bench/lab/registered-adapters.ts',
  'bench/lab/registry/datasets.json',
  'bench/lab/registry/systems.json',
  'package.json',
] as const);

/** Six pinned blobs, all taken at the v4 base. */
const APPROVED_GIT_BLOBS = Object.freeze({
  [MULTIHOP_V4_FREEZE.controlSourceIdentity.controlAdapterPath]: MULTIHOP_V4_FREEZE.controlSourceIdentity.controlAdapterGitBlob,
  [MULTIHOP_V4_FREEZE.controlSourceIdentity.productionCoreAdapterPath]: MULTIHOP_V4_FREEZE.controlSourceIdentity.productionCoreAdapterGitBlob,
  'bench/lab/registered-adapters.ts': MULTIHOP_V4_FREEZE.controlSourceIdentity.registeredAdaptersGitBlob,
  'bench/lab/runner.ts': MULTIHOP_V4_FREEZE.controlSourceIdentity.runnerGitBlob,
  'bench/lab/registry/systems.json': MULTIHOP_V4_FREEZE.controlSourceIdentity.systemsRegistryGitBlob,
  'bench/lab/registry/experiments.json': MULTIHOP_V4_FREEZE.controlSourceIdentity.experimentsRegistryGitBlob,
});

export type ClosedQualificationFailureCode =
  | 'invalid-hosted-provenance'
  | 'source-preflight-failed'
  | 'artifact-binding-failed'
  | 'registry-preflight-failed'
  | 'control-execution-failed'
  | 'control-aggregate-invalid'
  | 'control-headroom-rejected'
  | 'closed-artifact-write-failed';

export interface MultiHopV4ControlQualificationArtifact {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'ret007v4-control-qualification';
  readonly receipt: MultiHopV4ControlQualificationReceipt;
  readonly qualification: Readonly<MultiHopV4ControlQualificationReport>;
}

export interface MultiHopV4ControlNodeEvidenceArtifact {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'ret007v4-control-qualification-node-evidence';
  readonly receipt: MultiHopV4ControlNodeEvidenceReceipt;
  readonly qualification: Readonly<MultiHopV4ControlQualificationReport>;
}

export interface MultiHopV4ClosedFailureReceipt {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'ret007v4-control-qualification-failure' | 'ret007v4-control-qualification-node-evidence-failure';
  readonly outcome: 'rejected';
  readonly failureCode: ClosedQualificationFailureCode;
  readonly executedSourceSha: string | null;
  readonly workflowRefSha: string | null;
  readonly workflowRun: Readonly<{ id: string | null; url: string | null; attempt: number | null }>;
  readonly runtime: Readonly<{ execution: 'hosted'; platform: string; nodeMajor: number | null }>;
  readonly disclosure: 'closed-aggregate-only';
}

class ClosedQualificationError extends Error {
  constructor(readonly code: ClosedQualificationFailureCode) { super(code); }
}

interface HostedProvenance {
  sourceSha: string;
  workflowRefSha: string;
  runId: string;
  runUrl: string;
  attempt: number;
  nodeMajor: 20 | 22;
}

interface SystemRegistration {
  id: string;
  mode?: string;
  fidelity?: string;
  fidelityDetail?: string;
  requiredInCi?: boolean;
  adapter?: string;
  capabilities?: string[];
}

interface ControlRuntime {
  createAdapter(): LabAdapter;
  loadScenarios(split: MultiHopV4ReceiptSplit, repoRoot: string): Promise<readonly LabScenario[]>;
  audit(entry: string, repoRoot: string): Promise<Readonly<{ violations: readonly string[] }>>;
  run(options: Readonly<{ runId: string; adapter: LabAdapter; scenarios: readonly LabScenario[]; split: MultiHopV4ReceiptSplit }>): Promise<AdapterRunReport>;
}

/** The control and scorer-custody loader graph is evaluated only after source preflight succeeds. */
async function loadControlRuntime(): Promise<ControlRuntime> {
  const [adapterModule, loaderModule, auditModule, runnerModule] = await Promise.all([
    import('../adapters/memberry-retrieval-core-funnel.js'),
    import('../datasets/load-multihop-v4.js'),
    import('../registered-adapters.js'),
    import('../runner.js'),
  ]);
  return {
    createAdapter: () => new adapterModule.MemBerryRetrievalCoreFunnelAdapter(),
    loadScenarios: (split, repoRoot) => (split === 'twin'
      ? loaderModule.loadMultiHopV4TwinScenariosForEvidence(repoRoot)
      : loaderModule.loadMultiHopV4ScenariosForScoring(split, repoRoot)),
    audit: auditModule.auditAdapterDependencies,
    run: (options) => runnerModule.runAdapter({
      runId: options.runId, adapter: options.adapter, scenarios: options.scenarios,
      splits: [options.split] as never,
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

export function assertSourceChangedPaths(paths: readonly string[]): void {
  const normalized = paths.filter(Boolean).map((path) => path.replace(/\\/g, '/'));
  if (!exactStringSet(normalized, RET007V4_ALLOWED_SOURCE_PATHS)) throw new ClosedQualificationError('source-preflight-failed');
}

async function assertSourcePreflight(repoRoot: string, sourceSha: string): Promise<void> {
  try {
    if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error('invalid source SHA');
    if (await git(repoRoot, ['rev-parse', 'HEAD']) !== sourceSha) throw new Error('HEAD mismatch');
    await execFileAsync('git', ['merge-base', '--is-ancestor', MULTIHOP_V4_FREEZE.exactBaseCommit, sourceSha], { cwd: repoRoot });
    assertSourceChangedPaths((await git(repoRoot, [
      'diff', '--name-only', MULTIHOP_V4_FREEZE.exactBaseCommit, sourceSha,
    ])).split(/\r?\n/));
    for (const [path, expectedBlob] of Object.entries(APPROVED_GIT_BLOBS)) {
      if (await git(repoRoot, ['rev-parse', `${sourceSha}:${path}`]) !== expectedBlob) throw new Error('control source drift');
    }
  } catch {
    throw new ClosedQualificationError('source-preflight-failed');
  }
}

export function assertNoV4CandidateRegistration(
  systems: readonly unknown[],
  experiments: readonly unknown[],
): void {
  if ([...systems, ...experiments].some((entry) => V4_REGISTRATION_MARKER.test(JSON.stringify(entry)))) {
    throw new ClosedQualificationError('registry-preflight-failed');
  }
}

/** Registry preflight expects the exact 4-ID set {calib, dev, holdout, twin}. */
export function assertNoV4CandidateArtifactRegistration(datasets: readonly unknown[]): void {
  const v4 = datasets.filter((entry): entry is Record<string, unknown> => (
    Boolean(entry) && typeof entry === 'object'
      && String((entry as Record<string, unknown>).id).startsWith('memberry-multihop-v4-')
  ));
  const ids = v4.map(({ id }) => String(id));
  if (!exactStringSet(ids, V4_DATASET_IDS)) throw new ClosedQualificationError('registry-preflight-failed');
  for (const dataset of v4) {
    const split = dataset.split;
    const artifacts = dataset.artifacts;
    if ((split !== 'calib' && split !== 'dev' && split !== 'holdout' && split !== 'twin')
      || dataset.requiredInCi !== false || !Array.isArray(artifacts) || artifacts.length !== 2) {
      throw new ClosedQualificationError('registry-preflight-failed');
    }
    if (String(dataset.id) !== `memberry-multihop-v4-${split}`) {
      throw new ClosedQualificationError('registry-preflight-failed');
    }
    const expected = new Set([
      `input|adapter|bench/lab/datasets/multihop/v4/${split}/input.jsonl`,
      `oracle|scorer|bench/lab/datasets/multihop/v4/${split}/oracle.jsonl`,
    ]);
    const actual = artifacts.map((artifact) => {
      if (!artifact || typeof artifact !== 'object') return 'invalid';
      const value = artifact as Record<string, unknown>;
      const identity = `${String(value.role)}|${String(value.access)}|${String(value.repositoryPath)}`;
      if (/candidate|prediction|experiment|report|result/i.test(identity)) return 'candidate-artifact';
      return identity;
    });
    if (!exactStringSet(actual, [...expected])) throw new ClosedQualificationError('registry-preflight-failed');
  }
}

async function assertRegistryCandidateAbsence(repoRoot: string): Promise<void> {
  try {
    const systems = JSON.parse(await readFile(resolve(repoRoot, 'bench/lab/registry/systems.json'), 'utf8')) as {
      systems?: unknown[];
    };
    const experiments = JSON.parse(await readFile(resolve(repoRoot, 'bench/lab/registry/experiments.json'), 'utf8')) as {
      experiments?: unknown[];
    };
    const datasets = JSON.parse(await readFile(resolve(repoRoot, 'bench/lab/registry/datasets.json'), 'utf8')) as {
      datasets?: unknown[];
    };
    if (!Array.isArray(systems.systems) || !Array.isArray(experiments.experiments) || !Array.isArray(datasets.datasets)) {
      throw new Error('invalid registries');
    }
    assertNoV4CandidateRegistration(systems.systems, experiments.experiments);
    assertNoV4CandidateArtifactRegistration(datasets.datasets);
  } catch (error) {
    if (error instanceof ClosedQualificationError) throw error;
    throw new ClosedQualificationError('registry-preflight-failed');
  }
}

/** Narrow single-arm equivalent of the registered loader; the existing exported API constructs two-arm comparisons only. */
async function loadRegisteredControl(repoRoot: string, runtime: ControlRuntime): Promise<LabAdapter> {
  try {
    const systemsPath = resolve(repoRoot, 'bench/lab/registry/systems.json');
    const experimentsPath = resolve(repoRoot, 'bench/lab/registry/experiments.json');
    const datasetsPath = resolve(repoRoot, 'bench/lab/registry/datasets.json');
    const systemsRegistry = JSON.parse(await readFile(systemsPath, 'utf8')) as { systems?: SystemRegistration[] };
    const experimentsRegistry = JSON.parse(await readFile(experimentsPath, 'utf8')) as { experiments?: unknown[] };
    const datasetsRegistry = JSON.parse(await readFile(datasetsPath, 'utf8')) as { datasets?: unknown[] };
    if (!Array.isArray(systemsRegistry.systems) || !Array.isArray(experimentsRegistry.experiments)
      || !Array.isArray(datasetsRegistry.datasets)) throw new Error('invalid registries');
    assertNoV4CandidateRegistration(systemsRegistry.systems, experimentsRegistry.experiments);
    assertNoV4CandidateArtifactRegistration(datasetsRegistry.datasets);
    const registration = systemsRegistry.systems.find(({ id }) => id === MULTIHOP_V4_CONTROL_ADAPTER_ID);
    if (!registration || registration.mode !== MULTIHOP_V4_CONTROL_EXECUTION_MODE
      || registration.fidelity !== MULTIHOP_V4_CONTROL_EXECUTION_MODE
      || registration.fidelityDetail !== CONTROL_FIDELITY_DETAIL
      || registration.requiredInCi !== true
      || registration.adapter !== MULTIHOP_V4_FREEZE.controlSourceIdentity.controlAdapterPath
      || !Array.isArray(registration.capabilities)
      || !exactStringSet(registration.capabilities, CONTROL_CAPABILITIES)) {
      throw new Error('control registration mismatch');
    }
    const registeredAdapterPath = registration.adapter;
    const registeredCapabilities = registration.capabilities;
    const entry = resolve(repoRoot, registeredAdapterPath);
    const audit = await runtime.audit(entry, repoRoot);
    if (audit.violations.length > 0) throw new Error('control dependency audit failed');
    const adapter = runtime.createAdapter();
    if (adapter.id !== registration.id || adapter.executionMode !== registration.fidelity
      || !exactStringSet([...adapter.capabilities], registeredCapabilities)
      || (adapter as { funnelTopN?: unknown }).funnelTopN !== MULTIHOP_V4_FUNNEL_TOP_N) {
      throw new Error('control factory identity mismatch');
    }
    return adapter;
  } catch (error) {
    if (error instanceof ClosedQualificationError) throw error;
    throw new ClosedQualificationError('registry-preflight-failed');
  }
}

async function bindArtifacts(repoRoot: string): Promise<MultiHopV4ArtifactBindings> {
  try {
    const result = {} as Record<MultiHopV4ReceiptSplit, Record<'input' | 'oracle', { sha256: string; sizeBytes: number }>>;
    for (const split of MULTIHOP_V4_RECEIPT_SPLITS) {
      result[split] = {} as Record<'input' | 'oracle', { sha256: string; sizeBytes: number }>;
      for (const role of ['input', 'oracle'] as const) {
        const path = resolve(repoRoot, `bench/lab/datasets/multihop/v4/${split}/${role}.jsonl`);
        const bytes = await readFile(path);
        const actual = { sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.byteLength };
        const expected = MULTIHOP_V4_FREEZE.artifacts[split][role];
        if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
          || bytes.includes(Buffer.from('\r\n'))
          || actual.sha256 !== expected.sha256 || actual.sizeBytes !== expected.sizeBytes) {
          throw new Error('artifact mismatch');
        }
        result[split][role] = actual;
      }
    }
    return result as unknown as MultiHopV4ArtifactBindings;
  } catch {
    throw new ClosedQualificationError('artifact-binding-failed');
  }
}

function densityOf(scenario: LabScenario): MultiHopV4Density {
  const values = scenario.input.tags?.filter((tag) => tag.startsWith('density:')) ?? [];
  const density = values.length === 1 ? values[0]!.slice('density:'.length) : '';
  if (!MULTIHOP_V4_DENSITIES.includes(density as MultiHopV4Density)) throw new ClosedQualificationError('control-aggregate-invalid');
  return density as MultiHopV4Density;
}

export function computeStrictControlSplitReceipt(
  split: MultiHopV4ReceiptSplit,
  scenarios: readonly LabScenario[],
  report: AdapterRunReport,
): MultiHopV4SplitReceipt {
  if (scenarios.length !== MULTIHOP_V4_PROBES[split]
    || report.adapterId !== MULTIHOP_V4_CONTROL_ADAPTER_ID
    || report.executionMode !== MULTIHOP_V4_CONTROL_EXECUTION_MODE
    || report.outcome !== 'scored' || report.health !== 'ready'
    || report.excludedScenarios.length !== 0 || report.scenarioReports.length !== scenarios.length) {
    throw new ClosedQualificationError('control-aggregate-invalid');
  }
  const strata = {
    low: { n: 0, successes: 0, failures: 0 },
    medium: { n: 0, successes: 0, failures: 0 },
    high: { n: 0, successes: 0, failures: 0 },
  } satisfies Record<MultiHopV4Density, { n: number; successes: number; failures: number }>;
  let successes = 0;
  for (const [index, scenario] of scenarios.entries()) {
    const scenarioReport = report.scenarioReports[index];
    if (!scenarioReport || scenarioReport.scenarioId !== scenario.input.id || scenarioReport.split !== scenario.input.split
      || (scenario.input.split as string) !== split
      || scenarioReport.outcome !== 'scored' || scenarioReport.probes.length !== 1
      || scenarioReport.probes[0]!.probeId !== scenario.input.queries[0]!.id) {
      throw new ClosedQualificationError('control-aggregate-invalid');
    }
    const required = scenario.oracle.probes[0]!.required;
    if (!required || required.length !== 2) throw new ClosedQualificationError('control-aggregate-invalid');
    const top = new Set(scenarioReport.probes[0]!.resultIds.slice(0, MULTIHOP_V4_K));
    const success = required.every((id) => top.has(id));
    const density = densityOf(scenario);
    strata[density].n += 1;
    strata[density][success ? 'successes' : 'failures'] += 1;
    if (success) successes += 1;
  }
  for (const density of MULTIHOP_V4_DENSITIES) {
    if (strata[density].n !== MULTIHOP_V4_DENSITY_COUNTS[split][density]) {
      throw new ClosedQualificationError('control-aggregate-invalid');
    }
  }
  return Object.freeze({
    n: MULTIHOP_V4_PROBES[split],
    successes,
    successRate: successes / MULTIHOP_V4_PROBES[split],
    strata: Object.freeze({
      low: Object.freeze({ ...strata.low }),
      medium: Object.freeze({ ...strata.medium }),
      high: Object.freeze({ ...strata.high }),
    }),
  });
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
    || (nodeMajor !== 20 && nodeMajor !== 22)) {
    throw new ClosedQualificationError('invalid-hosted-provenance');
  }
  return { sourceSha, workflowRefSha, runId, runUrl, attempt, nodeMajor } as HostedProvenance;
}

function assertCandidateEnvironmentAbsent(environment: NodeJS.ProcessEnv): void {
  if (environment.MEMBERRY_LAB_CANDIDATE && environment.MEMBERRY_LAB_CANDIDATE !== '0'
    && environment.MEMBERRY_LAB_CANDIDATE.toLowerCase() !== 'false') {
    throw new ClosedQualificationError('registry-preflight-failed');
  }
}

/** The workflow declares the twin's role explicitly; anything else fails closed. */
function assertTwinEvidenceRole(environment: NodeJS.ProcessEnv): void {
  if (environment.RET007V4_TWIN_EVIDENCE_ROLE !== TWIN_EVIDENCE_ROLE) {
    throw new ClosedQualificationError('invalid-hosted-provenance');
  }
}

export function buildControlQualificationArtifact(
  receipt: MultiHopV4ControlQualificationReceipt,
): Readonly<MultiHopV4ControlQualificationArtifact> {
  return Object.freeze({
    schemaVersion: '1.0.0',
    kind: 'ret007v4-control-qualification',
    receipt,
    qualification: qualifyMultiHopV4ControlReceipt(receipt),
  });
}

export function buildControlNodeEvidenceArtifact(
  receipt: MultiHopV4ControlNodeEvidenceReceipt,
): Readonly<MultiHopV4ControlNodeEvidenceArtifact> {
  return Object.freeze({
    schemaVersion: '1.0.0',
    kind: 'ret007v4-control-qualification-node-evidence',
    receipt,
    qualification: qualifyMultiHopV4ControlNodeEvidenceReceipt(receipt),
  });
}

async function executeControlNodeEvidence(
  repoRoot: string,
  environment: NodeJS.ProcessEnv,
): Promise<Readonly<MultiHopV4ControlNodeEvidenceArtifact>> {
  const hosted = hostedProvenance(environment);
  assertTwinEvidenceRole(environment);
  await assertSourcePreflight(repoRoot, hosted.sourceSha);
  const artifactBindings = await bindArtifacts(repoRoot);
  assertCandidateEnvironmentAbsent(environment);
  await assertRegistryCandidateAbsence(repoRoot);
  const runtime = await loadControlRuntime();
  const splits = {} as Record<MultiHopV4ReceiptSplit, MultiHopV4SplitReceipt>;
  const qualificationRuns = {} as Record<MultiHopV4ReceiptSplit, { id: string }>;
  for (const split of MULTIHOP_V4_RECEIPT_SPLITS) {
    const runId = `ret007v4-${hosted.runId}-attempt${hosted.attempt}-node${hosted.nodeMajor}-${split}-control`;
    qualificationRuns[split] = { id: runId };
    try {
      const scenarios = await runtime.loadScenarios(split, repoRoot);
      const adapter = await loadRegisteredControl(repoRoot, runtime);
      const report = await runtime.run({ runId, adapter, scenarios, split });
      splits[split] = computeStrictControlSplitReceipt(split, scenarios, report);
    } catch (error) {
      if (error instanceof ClosedQualificationError) throw error;
      throw new ClosedQualificationError('control-execution-failed');
    }
  }
  const receipt: MultiHopV4ControlNodeEvidenceReceipt = Object.freeze({
    schemaVersion: '1.0.0',
    kind: 'ret007v4-control-qualification-node-evidence',
    instrument: MULTIHOP_V4_FREEZE.instrument,
    instrumentVersion: MULTIHOP_V4_FREEZE.version,
    exactBaseCommit: MULTIHOP_V4_FREEZE.exactBaseCommit,
    seedCommitmentSha256: MULTIHOP_V4_FREEZE.seedCommitmentSha256,
    funnelTopN: MULTIHOP_V4_FUNNEL_TOP_N,
    receiptId: `ret007v4-${hosted.runId}-attempt${hosted.attempt}-node${hosted.nodeMajor}`,
    createdAt: new Date().toISOString(),
    executedSourceSha: hosted.sourceSha,
    workflowRefSha: hosted.workflowRefSha,
    workflowRun: Object.freeze({ id: hosted.runId, url: hosted.runUrl, attempt: hosted.attempt }),
    producer: 'independent-scorer-custodian',
    runtime: Object.freeze({ execution: 'hosted', platform: 'linux', nodeMajor: hosted.nodeMajor }),
    controlAdapterId: MULTIHOP_V4_CONTROL_ADAPTER_ID,
    controlAdapterClass: MULTIHOP_V4_CONTROL_ADAPTER_CLASS,
    controlExecutionMode: MULTIHOP_V4_CONTROL_EXECUTION_MODE,
    qualificationRuns: Object.freeze({
      dev: Object.freeze(qualificationRuns.dev),
      holdout: Object.freeze(qualificationRuns.holdout),
      twin: Object.freeze(qualificationRuns.twin),
    }),
    controlSourceIdentity: MULTIHOP_V4_FREEZE.controlSourceIdentity,
    candidateAbsentAtQualification: true,
    candidateArtifactsObserved: false,
    candidateExecutionObserved: false,
    disclosure: 'closed-aggregate-only',
    artifactBindings,
    splits: Object.freeze({ dev: splits.dev, holdout: splits.holdout, twin: splits.twin }),
    twinEvidence: Object.freeze({ role: TWIN_EVIDENCE_ROLE, verdictTerm: false }),
  });
  return buildControlNodeEvidenceArtifact(receipt);
}

function exactJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function nodeEvidenceArtifact(value: unknown, nodeMajor: 20 | 22): MultiHopV4ControlNodeEvidenceArtifact {
  if (!value || typeof value !== 'object') throw new ClosedQualificationError('control-aggregate-invalid');
  const artifact = value as MultiHopV4ControlNodeEvidenceArtifact;
  if (!exactStringSet(Object.keys(artifact), ['schemaVersion', 'kind', 'receipt', 'qualification'])
    || artifact.schemaVersion !== '1.0.0' || artifact.kind !== 'ret007v4-control-qualification-node-evidence'
    || !artifact.receipt || artifact.receipt.runtime?.nodeMajor !== nodeMajor) {
    throw new ClosedQualificationError('control-aggregate-invalid');
  }
  let recomputed: Readonly<MultiHopV4ControlQualificationReport>;
  try { recomputed = qualifyMultiHopV4ControlNodeEvidenceReceipt(artifact.receipt); }
  catch { throw new ClosedQualificationError('control-aggregate-invalid'); }
  if (!exactJson(artifact.qualification, recomputed)) throw new ClosedQualificationError('control-aggregate-invalid');
  if (recomputed.outcome !== 'qualified') throw new ClosedQualificationError('control-headroom-rejected');
  return artifact;
}

/** Joins exactly Node 20 and Node 22 evidence; only this returned kind is scorer-acceptable authority. */
export function joinControlQualificationEvidence(
  node20Value: unknown,
  node22Value: unknown,
  matrixResult: string,
  environment: NodeJS.ProcessEnv,
): Readonly<MultiHopV4ControlQualificationArtifact> {
  assertCandidateEnvironmentAbsent(environment);
  const hosted = hostedProvenance(environment);
  const node20 = nodeEvidenceArtifact(node20Value, 20);
  const node22 = nodeEvidenceArtifact(node22Value, 22);
  if (matrixResult !== 'success') throw new ClosedQualificationError('control-headroom-rejected');
  const left = node20.receipt;
  const right = node22.receipt;
  const sameFields = [
    'schemaVersion', 'instrument', 'instrumentVersion', 'exactBaseCommit', 'seedCommitmentSha256', 'funnelTopN',
    'executedSourceSha', 'workflowRefSha', 'workflowRun', 'producer', 'controlAdapterId',
    'controlAdapterClass', 'controlExecutionMode', 'controlSourceIdentity', 'candidateAbsentAtQualification',
    'candidateArtifactsObserved', 'candidateExecutionObserved', 'disclosure', 'artifactBindings', 'splits', 'twinEvidence',
  ] as const;
  if (sameFields.some((key) => !exactJson(left[key], right[key]))
    || left.executedSourceSha !== hosted.sourceSha || left.workflowRefSha !== hosted.workflowRefSha
    || left.workflowRun.id !== hosted.runId || left.workflowRun.url !== hosted.runUrl
    || left.workflowRun.attempt !== hosted.attempt) {
    throw new ClosedQualificationError('control-aggregate-invalid');
  }
  const receipt: MultiHopV4ControlQualificationReceipt = Object.freeze({
    schemaVersion: '1.0.0',
    kind: 'ret007v4-control-qualification',
    instrument: left.instrument,
    instrumentVersion: left.instrumentVersion,
    exactBaseCommit: left.exactBaseCommit,
    seedCommitmentSha256: left.seedCommitmentSha256,
    funnelTopN: left.funnelTopN,
    receiptId: `ret007v4-${hosted.runId}-attempt${hosted.attempt}-joined-node20-node22`,
    createdAt: new Date().toISOString(),
    executedSourceSha: hosted.sourceSha,
    workflowRefSha: hosted.workflowRefSha,
    workflowRun: left.workflowRun,
    producer: 'independent-scorer-custodian',
    runtime: Object.freeze({ execution: 'hosted', platform: 'linux', nodeMajors: Object.freeze([20, 22] as const) }),
    controlAdapterId: left.controlAdapterId,
    controlAdapterClass: left.controlAdapterClass,
    controlExecutionMode: left.controlExecutionMode,
    evidenceReceiptIds: Object.freeze({ node20: left.receiptId, node22: right.receiptId }),
    qualificationRuns: Object.freeze({
      node20: left.qualificationRuns,
      node22: right.qualificationRuns,
    }),
    controlSourceIdentity: left.controlSourceIdentity,
    candidateAbsentAtQualification: true,
    candidateArtifactsObserved: false,
    candidateExecutionObserved: false,
    disclosure: 'closed-aggregate-only',
    artifactBindings: left.artifactBindings,
    splits: left.splits,
    twinEvidence: left.twinEvidence,
  });
  return buildControlQualificationArtifact(receipt);
}

export function closedFailureReceipt(
  code: ClosedQualificationFailureCode,
  environment: NodeJS.ProcessEnv,
  kind: MultiHopV4ClosedFailureReceipt['kind'] = 'ret007v4-control-qualification-failure',
): Readonly<MultiHopV4ClosedFailureReceipt> {
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

async function writeClosedJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function nodeEvidenceMain(): Promise<void> {
  const repoRoot = resolve(process.cwd());
  const nodeMajor = process.versions.node.split('.')[0] ?? 'unknown';
  const receiptPath = resolve(
    environmentValue(process.env.RET007V4_RECEIPT_PATH) ?? `artifacts/ret007v4-control/receipt-node${nodeMajor}.json`,
  );
  try {
    const artifact = await executeControlNodeEvidence(repoRoot, process.env);
    await writeClosedJson(receiptPath, artifact);
    if (artifact.qualification.outcome !== 'qualified') {
      process.exitCode = 1;
      process.stderr.write('{"outcome":"rejected","failureCode":"control-headroom-rejected"}\n');
    }
  } catch (error) {
    const code = error instanceof ClosedQualificationError ? error.code : 'control-execution-failed';
    try {
      await writeClosedJson(receiptPath, closedFailureReceipt(
        code, process.env, 'ret007v4-control-qualification-node-evidence-failure',
      ));
    }
    catch { process.exitCode = 1; return; }
    process.exitCode = 1;
    process.stderr.write(`${JSON.stringify({ outcome: 'rejected', failureCode: code })}\n`);
  }
}

async function authorityJoinMain(): Promise<void> {
  const receiptPath = resolve(
    environmentValue(process.env.RET007V4_RECEIPT_PATH) ?? 'artifacts/ret007v4-control/receipt-authoritative.json',
  );
  try {
    const node20Path = environmentValue(process.env.RET007V4_NODE20_EVIDENCE_PATH);
    const node22Path = environmentValue(process.env.RET007V4_NODE22_EVIDENCE_PATH);
    if (!node20Path || !node22Path) throw new ClosedQualificationError('control-aggregate-invalid');
    const [node20, node22] = await Promise.all([
      readFile(resolve(node20Path), 'utf8').then((value) => JSON.parse(value) as unknown),
      readFile(resolve(node22Path), 'utf8').then((value) => JSON.parse(value) as unknown),
    ]);
    const artifact = joinControlQualificationEvidence(
      node20, node22, process.env.RET007V4_MATRIX_RESULT ?? '', process.env,
    );
    await writeClosedJson(receiptPath, artifact);
  } catch (error) {
    const code = error instanceof ClosedQualificationError ? error.code : 'control-aggregate-invalid';
    try { await writeClosedJson(receiptPath, closedFailureReceipt(code, process.env)); }
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
