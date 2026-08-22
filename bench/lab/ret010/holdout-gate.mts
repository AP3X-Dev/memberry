#!/usr/bin/env tsx

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdtemp, open, readFile, realpath, rename } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const APPROVAL_PATH = 'bench/lab/ret010/approved-dev.json';
const CONTROL_ID = 'memberry-retrieval-core-disabled-v1';
const CANDIDATE_ID = 'memberry-retrieval-core-served-v1';
const SAFE_FAILURE = 'RET010_HOLDOUT_GATE_FAILED\n';
type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('custody');
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, keys: readonly string[]): void {
  if (JSON.stringify(Object.keys(value)) !== JSON.stringify(keys)) throw new Error('custody');
}

function canonicalBytes(value: JsonRecord): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function gitText(args: readonly string[], repoRoot = REPO_ROOT): string {
  return execFileSync('git', [...args], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function gitBytes(args: readonly string[], repoRoot = REPO_ROOT): Buffer {
  return execFileSync('git', [...args], { cwd: repoRoot, encoding: null, maxBuffer: 16 * 1024 * 1024 });
}

async function assertTrackedFile(path: string, commit: string, repoRoot = REPO_ROOT): Promise<void> {
  const entry = gitText(['ls-tree', commit, '--', path], repoRoot);
  const match = /^([0-9]{6}) blob ([0-9a-f]{40})\t(.+)$/.exec(entry);
  if (!match || match[3] !== path || (match[1] !== '100644' && match[1] !== '100755')) throw new Error('custody');
  const absolute = resolve(repoRoot, path);
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(absolute) !== absolute
    || (process.platform !== 'win32' && ((info.mode & 0o111) !== 0) !== (match[1] === '100755'))
    || !(await readFile(absolute)).equals(gitBytes(['cat-file', 'blob', `${commit}:${path}`], repoRoot))) throw new Error('custody');
}

async function assertResolvedImportGraph(commit: string, repoRoot = REPO_ROOT): Promise<void> {
  const queue = [
    'bench/lab/ret010/holdout-gate.mts', 'bench/lab/datasets/load-suite.ts',
    'bench/lab/registered-adapters.ts', 'bench/lab/stats.ts',
  ];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const path = queue.shift()!;
    if (visited.has(path)) continue;
    visited.add(path);
    await assertTrackedFile(path, commit, repoRoot);
    const source = gitBytes(['cat-file', 'blob', `${commit}:${path}`], repoRoot).toString('utf8');
    const specifiers = [...source.matchAll(/(?:from\s+|import\s*\()(['"])(\.[^'"]+)\1/g)].map((match) => match[2]!);
    for (const specifier of specifiers) {
      const jsPath = resolve(dirname(resolve(repoRoot, path)), specifier);
      if (!jsPath.startsWith(`${repoRoot}${sep}`)) throw new Error('custody');
      for (const shadow of [jsPath, jsPath.replace(/\.js$/i, '.mjs'), jsPath.replace(/\.js$/i, '.cjs')]) {
        try { await lstat(shadow); throw new Error('custody'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      const sourcePath = jsPath.replace(/\.js$/i, '.ts').replace(/\.mjs$/i, '.mts');
      const relativePath = relative(repoRoot, sourcePath).replace(/\\/g, '/');
      if (!relativePath.startsWith('../')) queue.push(relativePath);
    }
  }
}

async function assertCleanSource(commit: string, repoRoot = REPO_ROOT): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(commit) || gitText(['rev-parse', 'HEAD'], repoRoot) !== commit
    || gitText(['status', '--porcelain=v1', '--untracked-files=all'], repoRoot) !== '') throw new Error('custody');
  await assertResolvedImportGraph(commit, repoRoot);
}

function gitBlob(path: string): string {
  const blob = gitText(['rev-parse', `HEAD:${path}`]);
  if (!/^[0-9a-f]{40}$/.test(blob)) throw new Error('custody');
  return blob;
}

export interface Approval {
  schemaVersion: '1';
  decision: 'approved';
  devSourceCommit: string;
  modelBlob: string;
  providerContractBlob: string;
  adapterBlob: string;
  aggregateResultSha256: string;
  node20ManifestSha256: string;
  node22ManifestSha256: string;
  node20Version: string;
  node22Version: string;
  workflowRunId: string;
  workflowRunAttempt: number;
  repository: 'AP3X-Dev/memberry';
  workflowConclusion: 'success';
  node20JobConclusion: 'success';
  node22JobConclusion: 'success';
  node20ArtifactName: string;
  node22ArtifactName: string;
  datasetDescriptorSha256: string;
  inputSha256: string;
  oracleSha256: string;
  devPolicySha256: string;
  seed: number;
}

const APPROVAL_KEYS = [
  'schemaVersion', 'decision', 'devSourceCommit', 'modelBlob', 'providerContractBlob', 'adapterBlob',
  'aggregateResultSha256', 'node20ManifestSha256', 'node22ManifestSha256', 'node20Version', 'node22Version',
  'workflowRunId', 'workflowRunAttempt', 'datasetDescriptorSha256', 'inputSha256', 'oracleSha256',
  'devPolicySha256', 'seed', 'repository', 'workflowConclusion', 'node20JobConclusion', 'node22JobConclusion',
  'node20ArtifactName', 'node22ArtifactName',
] as const;

function parseApproval(bytes: Buffer): Approval {
  const value = record(JSON.parse(bytes.toString('utf8')));
  exactKeys(value, APPROVAL_KEYS);
  if (!bytes.equals(canonicalBytes(value)) || value.schemaVersion !== '1' || value.decision !== 'approved'
    || typeof value.devSourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(value.devSourceCommit)
    || ['modelBlob', 'providerContractBlob', 'adapterBlob'].some((key) => typeof value[key] !== 'string' || !/^[0-9a-f]{40}$/.test(value[key] as string))
    || ['aggregateResultSha256', 'node20ManifestSha256', 'node22ManifestSha256', 'datasetDescriptorSha256', 'inputSha256', 'oracleSha256', 'devPolicySha256']
      .some((key) => typeof value[key] !== 'string' || !/^[0-9a-f]{64}$/.test(value[key] as string))
    || typeof value.node20Version !== 'string' || !/^v20\.[0-9]+\.[0-9]+$/.test(value.node20Version)
    || typeof value.node22Version !== 'string' || !/^v22\.[0-9]+\.[0-9]+$/.test(value.node22Version)
    || typeof value.workflowRunId !== 'string' || !/^[1-9][0-9]*$/.test(value.workflowRunId)
    || !Number.isSafeInteger(value.workflowRunAttempt) || (value.workflowRunAttempt as number) < 1
    || !Number.isInteger(value.seed) || (value.seed as number) < 0 || (value.seed as number) > 0xffffffff
    || value.repository !== 'AP3X-Dev/memberry' || value.workflowConclusion !== 'success'
    || value.node20JobConclusion !== 'success' || value.node22JobConclusion !== 'success'
    || value.node20ArtifactName !== `memberry-ret010-development-node-20-${value.workflowRunId}-${value.workflowRunAttempt}`
    || value.node22ArtifactName !== `memberry-ret010-development-node-22-${value.workflowRunId}-${value.workflowRunAttempt}`) throw new Error('custody');
  return value as unknown as Approval;
}

export function validateApprovalRecordForTest(bytes: Buffer): void {
  parseApproval(bytes);
}

function gitTextLf(commit: string, path: string): Buffer {
  return Buffer.from(gitBytes(['cat-file', 'blob', `${commit}:${path}`]).toString('utf8').replace(/\r\n?/g, '\n'));
}

function verifyApprovalDigests(approval: Approval): void {
  if (gitText(['rev-parse', `${approval.devSourceCommit}:packages/retrieval/src/served-reranker.ts`]) !== approval.modelBlob
    || gitText(['rev-parse', `${approval.devSourceCommit}:packages/retrieval/src/reranker.ts`]) !== approval.providerContractBlob
    || gitText(['rev-parse', `${approval.devSourceCommit}:bench/lab/adapters/memberry-retrieval-core.ts`]) !== approval.adapterBlob
    || sha256(gitBytes(['cat-file', 'blob', `${approval.devSourceCommit}:bench/lab/ret010/dev-policy.json`])) !== approval.devPolicySha256) throw new Error('custody');
  const registry = record(JSON.parse(gitBytes(['cat-file', 'blob', `${approval.devSourceCommit}:bench/lab/registry/datasets.json`]).toString('utf8')));
  if (!Array.isArray(registry.datasets)) throw new Error('custody');
  const matches = registry.datasets.filter((raw) => {
    const item = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as JsonRecord : undefined;
    return item?.id === 'memberry-ret010-dev-v1' || item?.suite === 'ret010-development';
  });
  if (matches.length !== 1 || sha256(Buffer.from(`${JSON.stringify(matches[0])}\n`)) !== approval.datasetDescriptorSha256) throw new Error('custody');
  const descriptor = record(matches[0]);
  if (!Array.isArray(descriptor.artifacts) || descriptor.artifacts.length !== 2) throw new Error('custody');
  const expected = [
    ['input', 'adapter', 'input.jsonl', 'bench/lab/datasets/ret010/v1/dev/input.jsonl', approval.inputSha256],
    ['oracle', 'scorer', 'oracle.jsonl', 'bench/lab/datasets/ret010/v1/dev/oracle.jsonl', approval.oracleSha256],
  ] as const;
  descriptor.artifacts.forEach((raw, index) => {
    const artifact = record(raw);
    const [role, access, fileName, path, approvedDigest] = expected[index]!;
    const content = gitTextLf(approval.devSourceCommit, path);
    if (artifact.role !== role || artifact.access !== access || artifact.fileName !== fileName
      || artifact.repositoryPath !== path || artifact.hashMode !== 'text-lf'
      || artifact.sha256 !== approvedDigest || sha256(content) !== approvedDigest
      || artifact.sizeBytes !== content.byteLength) throw new Error('custody');
  });
}

export interface SourceLineage { head: string; directParent: string }

async function validateSourceAndLineage(head: string): Promise<SourceLineage> {
  const requestedSha = process.env.RET010_QUALIFICATION_SHA ?? '';
  return validateSourceAndLineageAt(REPO_ROOT, head, requestedSha);
}

async function validateSourceAndLineageAt(repoRoot: string, head: string, requestedSha: string): Promise<SourceLineage> {
  if (!/^[0-9a-f]{40}$/.test(requestedSha) || requestedSha !== head) throw new Error('custody');
  await assertCleanSource(head, repoRoot);
  await assertTrackedFile(APPROVAL_PATH, head, repoRoot);
  const parents = gitText(['rev-list', '--parents', '-n', '1', head], repoRoot).split(' ');
  if (parents.length !== 2) throw new Error('custody');
  const changed = gitText(['diff-tree', '--no-commit-id', '--name-status', '-r', head], repoRoot).split(/\r?\n/).filter(Boolean);
  if (changed.length !== 1 || changed[0] !== `A\t${APPROVAL_PATH}`) throw new Error('custody');
  try { gitBytes(['cat-file', 'blob', `${parents[1]}:${APPROVAL_PATH}`], repoRoot); throw new Error('custody'); }
  catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'custody') throw error;
    if ((error as { status?: number }).status !== 128) throw new Error('custody');
  }
  return { head, directParent: parents[1]! };
}

export async function validateSourceAndLineageForTest(repoRoot: string, head: string, requestedSha = head): Promise<SourceLineage> {
  return validateSourceAndLineageAt(resolve(repoRoot), head, requestedSha);
}

async function validateApproval(lineage: SourceLineage): Promise<Approval> {
  const requestedDigest = process.env.RET010_APPROVAL_DIGEST ?? '';
  if (!/^[0-9a-f]{64}$/.test(requestedDigest)) throw new Error('custody');
  const approvalBytes = await readFile(resolve(REPO_ROOT, APPROVAL_PATH));
  const approval = validateApprovalRecord(lineage, approvalBytes, requestedDigest);
  if (gitBlob('packages/retrieval/src/served-reranker.ts') !== approval.modelBlob
    || gitBlob('packages/retrieval/src/reranker.ts') !== approval.providerContractBlob
    || gitBlob('bench/lab/adapters/memberry-retrieval-core.ts') !== approval.adapterBlob) throw new Error('custody');
  verifyApprovalDigests(approval);
  return approval;
}

function validateApprovalRecord(lineage: SourceLineage, approvalBytes: Buffer, requestedDigest: string): Approval {
  if (!/^[0-9a-f]{64}$/.test(requestedDigest) || sha256(approvalBytes) !== requestedDigest) throw new Error('custody');
  const approval = parseApproval(approvalBytes);
  if (lineage.directParent !== approval.devSourceCommit) throw new Error('custody');
  return approval;
}

export function validateApprovalLineageForTest(lineage: SourceLineage, approvalBytes: Buffer, requestedDigest: string): Approval {
  return validateApprovalRecord(lineage, approvalBytes, requestedDigest);
}

function paired(report: any): Array<{ scenarioId: string; probeId: string; controlCoverage: number; controlTokens: number; candidateCoverage: number; candidateTokens: number }> {
  const candidate = new Map<string, any>();
  for (const scenario of report.candidate.scenarioReports) for (const probe of scenario.probes) {
    candidate.set(`${scenario.scenarioId}\0${probe.probeId}`, probe);
  }
  return report.control.scenarioReports.flatMap((scenario: any) => scenario.probes.map((probe: any) => {
    const other = candidate.get(`${scenario.scenarioId}\0${probe.probeId}`);
    if (!other) throw new Error('metric');
    return {
      scenarioId: scenario.scenarioId, probeId: probe.probeId,
      controlCoverage: probe.metrics.answerCoverage, controlTokens: probe.contextTokens ?? 0,
      candidateCoverage: other.metrics.answerCoverage, candidateTokens: other.contextTokens ?? 0,
    };
  }));
}

function finiteMetric(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0);
}

function validateLaneScenarios(scenarios: readonly any[], dimension: 'recall' | 'precision', k: 10 | 5): void {
  if (scenarios.length !== 10) throw new Error('metric');
  const identities = new Set<string>();
  for (const scenario of scenarios) {
    const input = scenario?.input; const oracle = scenario?.oracle;
    if (!input || input.split !== 'holdout' || !Array.isArray(input.dimensions)
      || input.dimensions.length !== 1 || input.dimensions[0] !== dimension
      || !Array.isArray(input.queries) || input.queries.length !== 1 || input.queries[0]?.limit !== k
      || !oracle || !Array.isArray(oracle.probes) || oracle.probes.length !== 1
      || oracle.probes[0]?.probeId !== input.queries[0]?.id) throw new Error('metric');
    const identity = `${input.id}\0${input.queries[0].id}`;
    if (identities.has(identity)) throw new Error('metric');
    identities.add(identity);
  }
}

export function validateHoldoutScenariosForTest(scenarios: readonly any[], dimension: 'recall' | 'precision', k: 10 | 5): void {
  validateLaneScenarios(scenarios, dimension, k);
}

function validateComparison(report: any, expectedRunId: string): void {
  if (report.runId !== expectedRunId || report.evidenceMode !== 'registered-ci' || report.passed !== true
    || report.control?.adapterId !== CONTROL_ID || report.candidate?.adapterId !== CANDIDATE_ID) throw new Error('metric');
  for (const arm of [report.control, report.candidate]) {
    if (arm.outcome !== 'scored' || !Array.isArray(arm.scenarioReports) || arm.scenarioReports.length !== 10) throw new Error('metric');
    const metricKeys = [
      'recallAtK', 'precisionAtK', 'reciprocalRank', 'ndcgAtK', 'answerCoverage',
      'staleLeakRate', 'isolationLeakRate', 'duplicateRate', 'unknownResultRate', 'staleSafety', 'isolationSafety',
    ];
    const probeMetrics: JsonRecord[] = [];
    for (const scenario of arm.scenarioReports) {
      if (scenario.outcome !== 'scored' || !Array.isArray(scenario.probes) || scenario.probes.length !== 1) throw new Error('metric');
      const probe = scenario.probes[0];
      if (!Array.isArray(probe.resultIds) || new Set(probe.resultIds).size !== probe.resultIds.length
        || !Number.isSafeInteger(probe.contextTokens) || probe.contextTokens < 0) throw new Error('metric');
      if (!isRecordMetrics(probe.metrics, metricKeys) || !isRecordMetrics(scenario.metrics, metricKeys)) throw new Error('metric');
      for (const key of metricKeys) if (scenario.metrics[key] !== probe.metrics[key]) throw new Error('metric');
      probeMetrics.push(probe.metrics);
      for (const key of ['staleLeakRate', 'isolationLeakRate', 'duplicateRate', 'unknownResultRate']) {
        if (probe.metrics[key] !== 0 || scenario.metrics[key] !== 0) throw new Error('metric');
      }
    }
    if (!isRecordMetrics(arm.metrics, metricKeys)) throw new Error('metric');
    for (const key of metricKeys) {
      const expected = probeMetrics.reduce((sum, metrics) => sum + (metrics[key] as number), 0) / 10;
      if (arm.metrics[key] !== expected) throw new Error('metric');
    }
  }
}

function isRecordMetrics(value: unknown, keys: readonly string[]): value is JsonRecord {
  if (!isRecord(value) || JSON.stringify(Object.keys(value)) !== JSON.stringify(keys)) return false;
  return keys.every((key) => finiteMetric(value[key]) && (value[key] as number) >= 0 && (value[key] as number) <= 1);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateHoldoutComparisonForTest(report: unknown, expectedRunId: string): void {
  validateComparison(report, expectedRunId);
}

export function validateHoldoutIntervalForTest(
  pairs: readonly { scenarioId: string; probeId: string }[],
  interval: any,
  derivedSeed: number,
): void {
  if (pairs.length !== 20 || new Set(pairs.map((pair) => `${pair.scenarioId}\0${pair.probeId}`)).size !== 20
    || interval?.seed !== derivedSeed || interval?.outcome !== 'measured' || interval?.pairedProbes !== 20
    || interval?.resamples !== 2000 || interval?.level !== 0.95
    || !finiteMetric(interval?.point) || !finiteMetric(interval?.lower) || !finiteMetric(interval?.upper)
    || !finiteMetric(interval?.oneSidedLower) || interval.point < 0 || interval.oneSidedLower < 0) throw new Error('metric');
}

function normalized(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('metric');
  return Object.is(value, -0) ? 0 : value;
}

function laneSummary(report: any, lane: 'recall-at-10' | 'precision-at-5'): JsonRecord {
  return {
    lane,
    control: { recallAtK: normalized(report.control.metrics.recallAtK), precisionAtK: normalized(report.control.metrics.precisionAtK) },
    candidate: { recallAtK: normalized(report.candidate.metrics.recallAtK), precisionAtK: normalized(report.candidate.metrics.precisionAtK) },
    delta: {
      recallAtK: normalized(report.candidate.metrics.recallAtK - report.control.metrics.recallAtK),
      precisionAtK: normalized(report.candidate.metrics.precisionAtK - report.control.metrics.precisionAtK),
    },
    safety: {
      staleLeakRate: report.candidate.metrics.staleLeakRate,
      isolationLeakRate: report.candidate.metrics.isolationLeakRate,
      duplicateRate: report.candidate.metrics.duplicateRate,
      unknownResultRate: report.candidate.metrics.unknownResultRate,
    },
  };
}

type PublicationHook = (stage: 'after-open' | 'before-rename', path: string) => Promise<void>;

async function validateOutputParent(runnerTemp: string, output: string): Promise<void> {
  const root = resolve(runnerTemp);
  const rootInfo = await lstat(root, { bigint: true });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root) !== root) throw new Error('custody');
  const parent = dirname(resolve(output));
  const suffix = relative(root, parent);
  if (suffix.startsWith('..') || resolve(root, suffix) !== parent) throw new Error('custody');
  let current = root;
  for (const part of suffix.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    const info = await lstat(current, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== rootInfo.dev || await realpath(current) !== current) throw new Error('custody');
  }
}

async function absent(path: string): Promise<void> {
  try { await lstat(path); throw new Error('custody'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function exactRecord(value: unknown, keys: readonly string[]): JsonRecord {
  const item = record(value);
  if (JSON.stringify(Object.keys(item)) !== JSON.stringify(keys)) throw new Error('artifact');
  return item;
}

export function validateHoldoutPublicRecordForTest(value: unknown): void {
  const item = record(value);
  if (item.decision === 'failed') {
    exactRecord(item, ['schemaVersion', 'decision', 'failureClass', 'stage', 'gitCommit', 'nodeMajor', 'nodeVersion', 'workflowRunId', 'workflowRunAttempt']);
    if (item.schemaVersion !== '1' || item.failureClass !== 'qualification'
      || typeof item.stage !== 'string' || !['source-integrity', 'approval', 'evaluation', 'publication'].includes(item.stage)
    ) throw new Error('artifact');
    validateRuntimeIdentityRecord({
      gitCommit: item.gitCommit, nodeMajor: item.nodeMajor, nodeVersion: item.nodeVersion,
      workflowRunId: item.workflowRunId, workflowRunAttempt: item.workflowRunAttempt,
    });
    return;
  }
  exactRecord(item, ['schemaVersion', 'decision', 'qualificationSha', 'approvalDigest', 'approvedDevelopment', 'recall', 'precision', 'efficiency', 'custody']);
  if (item.schemaVersion !== '1' || item.decision !== 'passed'
    || typeof item.qualificationSha !== 'string' || !/^[0-9a-f]{40}$/.test(item.qualificationSha)
    || typeof item.approvalDigest !== 'string' || !/^[0-9a-f]{64}$/.test(item.approvalDigest)) throw new Error('artifact');
  const approved = exactRecord(item.approvedDevelopment, [
    'sourceCommit', 'modelBlob', 'providerContractBlob', 'adapterBlob', 'aggregateResultSha256',
    'node20ManifestSha256', 'node22ManifestSha256', 'node20Version', 'node22Version',
    'developmentWorkflowRunId', 'developmentWorkflowRunAttempt', 'repository', 'workflowConclusion',
    'node20JobConclusion', 'node22JobConclusion', 'node20ArtifactName', 'node22ArtifactName',
    'datasetDescriptorSha256', 'inputSha256', 'oracleSha256', 'devPolicySha256', 'developmentSeed',
  ]);
  if (typeof approved.sourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(approved.sourceCommit)
    || ['modelBlob', 'providerContractBlob', 'adapterBlob'].some((key) => typeof approved[key] !== 'string' || !/^[0-9a-f]{40}$/.test(approved[key] as string))
    || ['aggregateResultSha256', 'node20ManifestSha256', 'node22ManifestSha256', 'datasetDescriptorSha256', 'inputSha256', 'oracleSha256', 'devPolicySha256']
      .some((key) => typeof approved[key] !== 'string' || !/^[0-9a-f]{64}$/.test(approved[key] as string))
    || typeof approved.node20Version !== 'string' || !/^v20\.[0-9]+\.[0-9]+$/.test(approved.node20Version)
    || typeof approved.node22Version !== 'string' || !/^v22\.[0-9]+\.[0-9]+$/.test(approved.node22Version)
    || typeof approved.developmentWorkflowRunId !== 'string' || !/^[1-9][0-9]*$/.test(approved.developmentWorkflowRunId)
    || !Number.isSafeInteger(approved.developmentWorkflowRunAttempt) || (approved.developmentWorkflowRunAttempt as number) < 1
    || approved.repository !== 'AP3X-Dev/memberry' || approved.workflowConclusion !== 'success'
    || approved.node20JobConclusion !== 'success' || approved.node22JobConclusion !== 'success'
    || approved.node20ArtifactName !== `memberry-ret010-development-node-20-${approved.developmentWorkflowRunId}-${approved.developmentWorkflowRunAttempt}`
    || approved.node22ArtifactName !== `memberry-ret010-development-node-22-${approved.developmentWorkflowRunId}-${approved.developmentWorkflowRunAttempt}`
    || !Number.isInteger(approved.developmentSeed) || (approved.developmentSeed as number) < 0
    || (approved.developmentSeed as number) > 0xffffffff) throw new Error('artifact');
  for (const laneName of ['recall', 'precision']) {
    const lane = exactRecord(item[laneName], ['lane', 'control', 'candidate', 'delta', 'safety']);
    if (lane.lane !== (laneName === 'recall' ? 'recall-at-10' : 'precision-at-5')) throw new Error('artifact');
    for (const group of ['control', 'candidate', 'delta']) {
      const values = exactRecord(lane[group], ['recallAtK', 'precisionAtK']);
      if (Object.values(values).some((entry) => !finiteMetric(entry))) throw new Error('artifact');
    }
    const safety = exactRecord(lane.safety, ['staleLeakRate', 'isolationLeakRate', 'duplicateRate', 'unknownResultRate']);
    if (Object.values(safety).some((entry) => !finiteMetric(entry) || entry !== 0)) throw new Error('artifact');
  }
  const efficiency = exactRecord(item.efficiency, ['pairedProbes', 'resamples', 'level', 'seed', 'point', 'lower', 'upper', 'oneSidedLower']);
  if (efficiency.pairedProbes !== 20 || efficiency.resamples !== 2000 || efficiency.level !== 0.95
    || !Number.isInteger(efficiency.seed) || (efficiency.seed as number) < 0 || (efficiency.seed as number) > 0xffffffff
    || Object.values(efficiency).slice(4).some((entry) => !finiteMetric(entry))
    || (efficiency.point as number) < 0 || (efficiency.oneSidedLower as number) < 0) throw new Error('artifact');
  const custody = exactRecord(item.custody, ['gitCommit', 'nodeMajor', 'nodeVersion', 'workflowRunId', 'workflowRunAttempt']);
  validateRuntimeIdentityRecord(custody);
  if (custody.gitCommit !== item.qualificationSha) throw new Error('artifact');
}

export interface RuntimeIdentity {
  gitCommit: string;
  nodeMajor: '20' | '22';
  nodeVersion: string;
  workflowRunId: string;
  workflowRunAttempt: number;
}

function validateRuntimeIdentityRecord(value: JsonRecord): RuntimeIdentity {
  if (JSON.stringify(Object.keys(value)) !== JSON.stringify(['gitCommit', 'nodeMajor', 'nodeVersion', 'workflowRunId', 'workflowRunAttempt'])
    || typeof value.gitCommit !== 'string' || !/^(?!0{40}$)[0-9a-f]{40}$/.test(value.gitCommit)
    || (value.nodeMajor !== '20' && value.nodeMajor !== '22')
    || typeof value.nodeVersion !== 'string' || !new RegExp(`^v${value.nodeMajor}\\.[0-9]+\\.[0-9]+$`).test(value.nodeVersion)
    || typeof value.workflowRunId !== 'string' || !/^[1-9][0-9]*$/.test(value.workflowRunId)
    || !Number.isSafeInteger(value.workflowRunAttempt) || (value.workflowRunAttempt as number) < 1) throw new Error('custody');
  return value as unknown as RuntimeIdentity;
}

export function validateRuntimeIdentityForTest(value: unknown): void {
  validateRuntimeIdentityRecord(record(value));
}

interface OutputBoundary {
  runnerTemp: string;
  output: string;
  rootIdentity: { dev: bigint; ino: bigint };
  parentIdentity: { dev: bigint; ino: bigint };
}

async function verifiedOutputBoundary(runnerTemp: string, output: string): Promise<OutputBoundary> {
  if (!runnerTemp || !output) throw new Error('custody');
  const root = resolve(runnerTemp);
  const leaf = resolve(output);
  const outputRelative = relative(root, leaf);
  if (!outputRelative || outputRelative.startsWith('..') || resolve(root, outputRelative) !== leaf) throw new Error('custody');
  await validateOutputParent(root, leaf);
  const rootInfo = await lstat(root, { bigint: true });
  const parentInfo = await lstat(dirname(leaf), { bigint: true });
  if (!rootInfo.isDirectory() || !parentInfo.isDirectory() || rootInfo.dev !== parentInfo.dev) throw new Error('custody');
  return {
    runnerTemp: root, output: leaf,
    rootIdentity: { dev: rootInfo.dev, ino: rootInfo.ino },
    parentIdentity: { dev: parentInfo.dev, ino: parentInfo.ino },
  };
}

async function recheckOutputBoundary(boundary: OutputBoundary): Promise<void> {
  await validateOutputParent(boundary.runnerTemp, boundary.output);
  const rootInfo = await lstat(boundary.runnerTemp, { bigint: true });
  const parentInfo = await lstat(dirname(boundary.output), { bigint: true });
  if (rootInfo.dev !== boundary.rootIdentity.dev || rootInfo.ino !== boundary.rootIdentity.ino
    || parentInfo.dev !== boundary.parentIdentity.dev || parentInfo.ino !== boundary.parentIdentity.ino) throw new Error('custody');
}

async function quarantineLeaf(boundary: OutputBoundary, path: string): Promise<void> {
  await recheckOutputBoundary(boundary);
  try { await lstat(path, { bigint: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const quarantineParent = await mkdtemp(resolve(boundary.runnerTemp, '.ret010-holdout-quarantine-'));
  const quarantineParentInfo = await lstat(quarantineParent, { bigint: true });
  if (!quarantineParentInfo.isDirectory() || quarantineParentInfo.isSymbolicLink()
    || quarantineParentInfo.dev !== boundary.rootIdentity.dev || await realpath(quarantineParent) !== quarantineParent) throw new Error('custody');
  const quarantine = resolve(quarantineParent, 'leaf');
  await recheckOutputBoundary(boundary);
  const current = await lstat(path, { bigint: true });
  await absent(quarantine);
  await rename(path, quarantine);
  const moved = await lstat(quarantine, { bigint: true });
  if (moved.dev !== current.dev || moved.ino !== current.ino) throw new Error('custody');
  await absent(path);
}

async function clearDisposableLeaves(boundary: OutputBoundary): Promise<void> {
  await quarantineLeaf(boundary, boundary.output);
  await quarantineLeaf(boundary, `${boundary.output}.staging`);
  await recheckOutputBoundary(boundary);
  await absent(boundary.output);
  await absent(`${boundary.output}.staging`);
}

async function safeWriteReceipt(
  value: JsonRecord,
  output = process.env.RET010_HOLDOUT_RECEIPT_PATH ?? '',
  runnerTemp = process.env.RUNNER_TEMP ?? '',
  hook?: PublicationHook,
): Promise<void> {
  const boundary = await verifiedOutputBoundary(runnerTemp, output);
  const staging = `${boundary.output}.staging`;
  await clearDisposableLeaves(boundary);
  validateHoldoutPublicRecordForTest(value);
  const expected = canonicalBytes(value);
  const handle = await open(staging, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  let identity: { dev: bigint; ino: bigint } | undefined;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) throw new Error('custody');
    identity = { dev: opened.dev, ino: opened.ino };
    await hook?.('after-open', staging);
    await handle.writeFile(expected);
    await handle.sync();
    const written = await handle.stat({ bigint: true });
    if (written.dev !== identity.dev || written.ino !== identity.ino || written.size !== BigInt(expected.byteLength)) throw new Error('custody');
    await hook?.('before-rename', staging);
    await recheckOutputBoundary(boundary);
    const pathInfo = await lstat(staging, { bigint: true });
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.dev !== identity.dev || pathInfo.ino !== identity.ino) throw new Error('custody');
    await quarantineLeaf(boundary, boundary.output);
    await recheckOutputBoundary(boundary);
    const finalStage = await lstat(staging, { bigint: true });
    if (!finalStage.isFile() || finalStage.isSymbolicLink()
      || finalStage.dev !== identity.dev || finalStage.ino !== identity.ino) throw new Error('custody');
    await absent(boundary.output);
    await rename(staging, boundary.output);
    const published = await lstat(boundary.output, { bigint: true });
    if (!published.isFile() || published.isSymbolicLink() || published.dev !== identity.dev || published.ino !== identity.ino) throw new Error('custody');
    const verifyHandle = await open(boundary.output, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const verified = await verifyHandle.stat({ bigint: true });
      const verifiedBytes = await verifyHandle.readFile();
      if (verified.dev !== identity.dev || verified.ino !== identity.ino || !verifiedBytes.equals(expected)) throw new Error('custody');
    } finally { await verifyHandle.close(); }
  } catch (error) {
    try { await quarantineLeaf(boundary, staging); } catch { /* a later clear/publisher must prove absence */ }
    try { await quarantineLeaf(boundary, boundary.output); } catch { /* a later clear/publisher must prove absence */ }
    throw error;
  } finally { await handle.close(); }
}

export async function publishHoldoutReceiptForTest(
  runnerTemp: string,
  output: string,
  value: JsonRecord,
  hook?: PublicationHook,
): Promise<void> {
  await safeWriteReceipt(value, output, runnerTemp, hook);
}

export async function clearHoldoutOutputForTest(runnerTemp: string, output: string): Promise<void> {
  const boundary = await verifiedOutputBoundary(runnerTemp, output);
  await clearDisposableLeaves(boundary);
}

async function clearConfiguredOutput(): Promise<void> {
  const boundary = await verifiedOutputBoundary(process.env.RUNNER_TEMP ?? '', process.env.RET010_HOLDOUT_RECEIPT_PATH ?? '');
  await clearDisposableLeaves(boundary);
}

function runtimeCustody(head: string): RuntimeIdentity {
  const nodeMajor = process.versions.node.split('.')[0];
  const workflowRunId = process.env.GITHUB_RUN_ID ?? '';
  const attemptText = process.env.GITHUB_RUN_ATTEMPT ?? '';
  const workflowRunAttempt = /^[1-9][0-9]*$/.test(attemptText) ? Number(attemptText) : Number.NaN;
  if ((nodeMajor !== '20' && nodeMajor !== '22') || !new RegExp(`^v${nodeMajor}\\.[0-9]+\\.[0-9]+$`).test(process.version)
    || !/^[1-9][0-9]*$/.test(workflowRunId)
    || !Number.isSafeInteger(workflowRunAttempt) || workflowRunAttempt < 1 || !/^[0-9a-f]{40}$/.test(head)) throw new Error('custody');
  return { gitCommit: head, nodeMajor, nodeVersion: process.version, workflowRunId, workflowRunAttempt };
}

function assertCurrentRuntimeIdentity(identity: RuntimeIdentity): void {
  const current = runtimeCustody(gitText(['rev-parse', 'HEAD']));
  if (JSON.stringify(current) !== JSON.stringify(identity)) throw new Error('custody');
}

type GateStage = 'source-integrity' | 'approval' | 'evaluation' | 'publication';

function tombstone(identity: RuntimeIdentity, stage: GateStage): JsonRecord {
  return {
    schemaVersion: '1', decision: 'failed', failureClass: 'qualification', stage,
    gitCommit: identity.gitCommit, nodeMajor: identity.nodeMajor, nodeVersion: identity.nodeVersion,
    workflowRunId: identity.workflowRunId, workflowRunAttempt: identity.workflowRunAttempt,
  };
}

export interface GateRunDependencies<TApproval, TResult> {
  acquireIdentity(): Promise<RuntimeIdentity>;
  prepareOutput(identity: RuntimeIdentity): Promise<void>;
  validateSourceAndLineage(identity: RuntimeIdentity): Promise<SourceLineage>;
  validateApproval(lineage: SourceLineage, identity: RuntimeIdentity): Promise<TApproval>;
  evaluate(approval: TApproval, identity: RuntimeIdentity): Promise<TResult>;
  publishSuccess(result: TResult, identity: RuntimeIdentity): Promise<void>;
  publishFailure(value: JsonRecord, identity: RuntimeIdentity): Promise<void>;
  clearOutput(): Promise<void>;
  emitFailure(): void;
  onSuppressedOutput?(stdout: string, stderr: string): Promise<void>;
}

export async function runHoldoutQualificationForTest<TApproval, TResult>(
  dependencies: GateRunDependencies<TApproval, TResult>,
): Promise<'passed' | 'failed'> {
  let identity: RuntimeIdentity | undefined;
  let outputControlled = false;
  let stage: GateStage = 'source-integrity';
  const stdoutWrite = process.stdout.write; const stderrWrite = process.stderr.write;
  let suppressedStdout = ''; let suppressedStderr = ''; let outputRestored = false;
  const restoreOutput = (): void => {
    if (outputRestored) return;
    process.stdout.write = stdoutWrite; process.stderr.write = stderrWrite; outputRestored = true;
  };
  process.stdout.write = ((chunk: unknown) => { suppressedStdout += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { suppressedStderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk); return true; }) as typeof process.stderr.write;
  try {
    identity = await dependencies.acquireIdentity();
    validateRuntimeIdentityRecord(identity as unknown as JsonRecord);
    await dependencies.prepareOutput(identity);
    outputControlled = true;
    const lineage = await dependencies.validateSourceAndLineage(identity);
    stage = 'approval';
    const approval = await dependencies.validateApproval(lineage, identity);
    stage = 'evaluation';
    const result = await dependencies.evaluate(approval, identity);
    stage = 'publication';
    await dependencies.publishSuccess(result, identity);
    restoreOutput();
    await dependencies.onSuppressedOutput?.(suppressedStdout, suppressedStderr);
    return 'passed';
  } catch {
    if (identity !== undefined && outputControlled) {
      try { await dependencies.publishFailure(tombstone(identity, stage), identity); }
      catch { try { await dependencies.clearOutput(); } catch { /* upload must fail if leaf control is unprovable */ } }
    } else {
      try { await dependencies.clearOutput(); } catch { /* upload must fail if boundary is unprovable */ }
    }
    restoreOutput();
    await dependencies.onSuppressedOutput?.(suppressedStdout, suppressedStderr);
    dependencies.emitFailure();
    return 'failed';
  }
}

export interface HoldoutEvaluationDependencies {
  verifySource(): Promise<void>;
  loadScenarios(dimension: 'recall' | 'precision'): Promise<readonly any[]>;
  compare(options: JsonRecord): Promise<any>;
  pairedEfficiencyInterval(pairs: readonly any[]): any;
  pairedVectorSeed(pairs: readonly any[]): number;
  readPolicy(): Promise<unknown>;
}

async function evaluateHoldout(
  approval: Approval,
  identity: RuntimeIdentity,
  injected?: HoldoutEvaluationDependencies,
): Promise<JsonRecord> {
  let dependencies = injected;
  if (dependencies === undefined) {
    await assertCleanSource(identity.gitCommit);
    await assertTrackedFile(APPROVAL_PATH, identity.gitCommit);
    const [{ loadG2HoldoutScenariosForScoring }, { compareRegisteredAdapters }, statsModule] = await Promise.all([
      import('../datasets/load-suite.js'), import('../registered-adapters.js'), import('../stats.js'),
    ]);
    dependencies = {
      verifySource: async () => { await assertCleanSource(identity.gitCommit); await assertTrackedFile(APPROVAL_PATH, identity.gitCommit); },
      loadScenarios: async (dimension) => loadG2HoldoutScenariosForScoring(dimension, REPO_ROOT),
      compare: async (options) => compareRegisteredAdapters(options as any),
      pairedEfficiencyInterval: (pairs) => statsModule.pairedEfficiencyInterval(pairs as any),
      pairedVectorSeed: (pairs) => statsModule.pairedVectorSeed(pairs as any),
      readPolicy: async () => JSON.parse(await readFile(resolve(HERE, 'holdout-policy.json'), 'utf8')),
    };
  }
  await dependencies.verifySource();
  const policy = record(await dependencies.readPolicy());
  const expectedPolicy = {
    schemaVersion: 1, controlAdapterId: CONTROL_ID, candidateAdapterId: CANDIDATE_ID,
    dataset: { id: 'memberry-g2-holdout-holdout', split: 'holdout' },
    lanes: {
      recall: { dimension: 'recall', probes: 10, k: 10, minimumDelta: 0 },
      precision: { dimension: 'precision', probes: 10, k: 5, minimumDelta: 0 },
    },
    safety: { maxStaleLeakRate: 0, maxIsolationLeakRate: 0, maxDuplicateRate: 0, maxUnknownResultRate: 0 },
    pairedVectorOrder: ['recall', 'precision'], withinLaneSortKeys: ['scenarioId', 'probeId'],
    efficiency: {
      outcome: 'measured', method: 'paired-bootstrap', confidenceLevel: 0.95,
      minimumPointDeltaInclusive: 0, minimumOneSided95LowerBound: 0,
      resamples: 2000, minimumPairedProbes: 10, seedRule: 'vector-derived',
    },
  };
  if (JSON.stringify(policy) !== JSON.stringify(expectedPolicy)) throw new Error('custody');
  const recallScenarios = await dependencies.loadScenarios('recall');
  const precisionScenarios = await dependencies.loadScenarios('precision');
  validateLaneScenarios(recallScenarios, 'recall', 10);
  validateLaneScenarios(precisionScenarios, 'precision', 5);
  const basePolicy = {
    minRecallAtK: 0, minPrecisionAtK: 0, minAnswerCoverage: 0,
    maxStaleLeakRate: 0, maxIsolationLeakRate: 0, maxDuplicateRate: 0, maxUnknownResultRate: 0,
    maxQualityRegression: 1,
  };
  const recallReport = await dependencies.compare({
    runId: 'ret010-holdout-recall', controlId: CONTROL_ID, candidateId: CANDIDATE_ID,
    scenarios: recallScenarios, splits: ['holdout'], policy: basePolicy, repoRoot: REPO_ROOT,
  });
  const precisionReport = await dependencies.compare({
    runId: 'ret010-holdout-precision', controlId: CONTROL_ID, candidateId: CANDIDATE_ID,
    scenarios: precisionScenarios, splits: ['holdout'], policy: basePolicy, repoRoot: REPO_ROOT,
  });
  validateComparison(recallReport, 'ret010-holdout-recall');
  validateComparison(precisionReport, 'ret010-holdout-precision');
  const recall = laneSummary(recallReport, 'recall-at-10');
  const precision = laneSummary(precisionReport, 'precision-at-5');
  const pairs = [
    ...paired(recallReport).sort((a, b) => a.scenarioId.localeCompare(b.scenarioId) || a.probeId.localeCompare(b.probeId)),
    ...paired(precisionReport).sort((a, b) => a.scenarioId.localeCompare(b.scenarioId) || a.probeId.localeCompare(b.probeId)),
  ];
  const interval = dependencies.pairedEfficiencyInterval(pairs);
  const recallDelta = (recall.delta as JsonRecord).recallAtK as number;
  const precisionDelta = (precision.delta as JsonRecord).precisionAtK as number;
  const safety = [recall.safety, precision.safety].flatMap((value) => Object.values(value as JsonRecord));
  validateHoldoutIntervalForTest(pairs, interval, dependencies.pairedVectorSeed(pairs));
  if (recallDelta < 0 || precisionDelta < 0 || safety.some((value) => value !== 0)) throw new Error('metric');
  await dependencies.verifySource();
  if (injected === undefined) assertCurrentRuntimeIdentity(identity);
  return {
    schemaVersion: '1', decision: 'passed', qualificationSha: identity.gitCommit,
    approvalDigest: process.env.RET010_APPROVAL_DIGEST,
    approvedDevelopment: {
      sourceCommit: approval.devSourceCommit, modelBlob: approval.modelBlob,
      providerContractBlob: approval.providerContractBlob, adapterBlob: approval.adapterBlob,
      aggregateResultSha256: approval.aggregateResultSha256,
      node20ManifestSha256: approval.node20ManifestSha256, node22ManifestSha256: approval.node22ManifestSha256,
      node20Version: approval.node20Version, node22Version: approval.node22Version,
      developmentWorkflowRunId: approval.workflowRunId, developmentWorkflowRunAttempt: approval.workflowRunAttempt,
      repository: approval.repository, workflowConclusion: approval.workflowConclusion,
      node20JobConclusion: approval.node20JobConclusion, node22JobConclusion: approval.node22JobConclusion,
      node20ArtifactName: approval.node20ArtifactName, node22ArtifactName: approval.node22ArtifactName,
      datasetDescriptorSha256: approval.datasetDescriptorSha256, inputSha256: approval.inputSha256,
      oracleSha256: approval.oracleSha256, devPolicySha256: approval.devPolicySha256, developmentSeed: approval.seed,
    },
    recall, precision,
    efficiency: {
      pairedProbes: 20, resamples: 2000, level: 0.95, seed: interval.seed,
      point: normalized(interval.point), lower: normalized(interval.lower), upper: normalized(interval.upper),
      oneSidedLower: normalized(interval.oneSidedLower),
    },
    custody: identity,
  };
}

export async function evaluateHoldoutForTest(
  approval: Approval,
  identity: RuntimeIdentity,
  dependencies: HoldoutEvaluationDependencies,
): Promise<JsonRecord> {
  return evaluateHoldout(approval, identity, dependencies);
}

export async function runRet010HoldoutQualification(): Promise<void> {
  const result = await runHoldoutQualificationForTest({
    acquireIdentity: async () => {
      const head = gitText(['rev-parse', 'HEAD']);
      return runtimeCustody(head);
    },
    prepareOutput: async () => { await clearConfiguredOutput(); },
    validateSourceAndLineage: async (identity) => validateSourceAndLineage(identity.gitCommit),
    validateApproval: async (lineage) => validateApproval(lineage),
    evaluate: evaluateHoldout,
    publishSuccess: async (receipt, identity) => {
      await safeWriteReceipt(receipt, undefined, undefined, async (publicationStage) => {
        if (publicationStage !== 'before-rename') return;
        assertCurrentRuntimeIdentity(identity);
        await assertCleanSource(identity.gitCommit);
        await assertTrackedFile(APPROVAL_PATH, identity.gitCommit);
      });
    },
    publishFailure: async (receipt, identity) => {
      await safeWriteReceipt(receipt, undefined, undefined, async (publicationStage) => {
        if (publicationStage === 'before-rename') assertCurrentRuntimeIdentity(identity);
      });
    },
    clearOutput: clearConfiguredOutput,
    emitFailure: () => { process.stderr.write(SAFE_FAILURE); },
  });
  if (result === 'failed') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runRet010HoldoutQualification();
