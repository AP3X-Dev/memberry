#!/usr/bin/env tsx

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runQualityGate, type QualityGateReport } from '../../quality/eval.js';
import { runAdmissionStructuralCiGate } from '../admission/ci-gate.js';
import { createRunManifest } from '../artifacts.js';
import { RETRIEVAL_SCENARIOS } from '../fixtures/retrieval.js';
import { TEMPORAL_ISOLATION_SCENARIOS } from '../fixtures/temporal-isolation.js';
import type { LabGatePolicy } from '../contracts/report.js';
import { validateRegistries } from '../registry/validate.js';
import { compareRegisteredAdapters, writeRequiredCiComparisonArtifacts } from '../registered-adapters.js';
import { runRet007MultiHopDevGateClosed } from '../multihop/gate.js';
import { loadRegisteredDatasetDescriptor, loadRegisteredScenariosForScoring } from '../datasets/load-golden.js';
import { loadG2HoldoutScenariosForScoring } from '../datasets/load-suite.js';
import { canonicalSha256 } from './canonical.js';
import { compareQualityReports, loadComparisonPolicy } from './compare-quality.js';
import { loadAndVerifyBaseline } from './verify.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const ARTIFACT_DIR = resolve(REPO_ROOT, 'node_modules', '.cache', 'memberry-lab', 'runs');

export function requireGateResult<T>(name: string, result: T | null | undefined): T {
  if (result === null || result === undefined) throw new Error(`Required gate ${name} did not return a result; refusing to skip`);
  return result;
}
export async function runDeterministicCiGate(
  qualityRunner: () => Promise<QualityGateReport> = runQualityGate,
): Promise<{ passed: true; artifacts: string[] }> {
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim().length > 0;
  const startedAt = new Date().toISOString();
  const runId = `ci-${sourceCommit.slice(0, 12)}-${process.pid}-${startedAt.replace(/[:.]/g, '-')}`;
  // Run the sibling production-core structural boundary before loading the
  // retrieval adapter graph. This keeps each independently audited dynamic
  // system graph isolated under tsx as well as Node's native ESM loader.
  const admission = requireGateResult('admission-structural', await runAdmissionStructuralCiGate({
    runId: `${runId}-admission`,
    createdAt: startedAt,
    gitCommit: sourceCommit,
    // Both structural arms execute this exact production-core commit; the
    // historical quality baseline above is a separate retrieval artifact.
    baselineCommit: sourceCommit,
    gitDirty: dirty,
    repoRoot: REPO_ROOT,
    artifactRoot: ARTIFACT_DIR,
  }));
  console.log('Evaluation-lab gate: admission structural evidence published.');
  const registryErrors = await validateRegistries(resolve(REPO_ROOT, 'bench', 'lab', 'registry'));
  if (registryErrors.length > 0) throw new Error(`Registry gate failed:\n${registryErrors.join('\n')}`);
  console.log('Evaluation-lab gate: registries verified.');
  const labPolicy = JSON.parse(await readFile(resolve(HERE, 'lab-policy.json'), 'utf8')) as {
    schemaVersion: number;
    registeredGolden: LabGatePolicy;
    protectedTemporalIsolation: LabGatePolicy;
    migratedRetrievalControl: LabGatePolicy;
    holdoutRecallAt10: LabGatePolicy;
    holdoutPrecisionAt5: LabGatePolicy;
    queryDecompositionDev: LabGatePolicy;
    queryDecompositionRecallAt10: LabGatePolicy;
    queryDecompositionPrecisionAt5: LabGatePolicy;
  };
  if (labPolicy.schemaVersion !== 1) throw new Error('Unsupported lab policy version');
  const baseline = await loadAndVerifyBaseline(undefined, undefined, REPO_ROOT);
  console.log('Evaluation-lab gate: immutable baseline verified.');
  const candidate = requireGateResult('quality', await qualityRunner());
  const policy = await loadComparisonPolicy();
  const comparison = requireGateResult('comparison', compareQualityReports(baseline, candidate, policy));
  if (!comparison.passed) throw new Error(`Baseline comparison failed:\n${comparison.failures.join('\n')}`);
  console.log('Evaluation-lab gate: quality comparison complete.');
  const [
    goldenScenarios, goldenDev, goldenHoldout, temporalDataset, retrievalDataset,
    holdoutRecallScenarios, holdoutPrecisionScenarios, g2Dev, g2Holdout,
  ] = await Promise.all([
    loadRegisteredScenariosForScoring(REPO_ROOT),
    loadRegisteredDatasetDescriptor('memberry-lab-golden-dev', REPO_ROOT),
    loadRegisteredDatasetDescriptor('memberry-lab-golden-holdout', REPO_ROOT),
    loadRegisteredDatasetDescriptor('memberry-lab-temporal-isolation', REPO_ROOT),
    loadRegisteredDatasetDescriptor('memberry-lab-migrated-retrieval', REPO_ROOT),
    loadG2HoldoutScenariosForScoring('recall', REPO_ROOT),
    loadG2HoldoutScenariosForScoring('precision', REPO_ROOT),
    loadRegisteredDatasetDescriptor('memberry-g2-holdout-dev', REPO_ROOT),
    loadRegisteredDatasetDescriptor('memberry-g2-holdout-holdout', REPO_ROOT),
  ]);
  console.log('Evaluation-lab gate: registered datasets verified.');
  const goldenComparison = requireGateResult('registered-golden', await compareRegisteredAdapters({
    runId: `${runId}-golden`,
    controlId: 'scope-aware-bm25-control-v1',
    candidateId: 'memberry-proxy-v1',
    scenarios: goldenScenarios,
    policy: labPolicy.registeredGolden,
    repoRoot: REPO_ROOT,
  }));
  if (!goldenComparison.passed) {
    throw new Error(`Registered golden dataset gate failed:\n${goldenComparison.failures.map((failure) => `${failure.metric}: ${failure.actual}; ${failure.expected}`).join('\n')}`);
  }
  console.log('Evaluation-lab gate: registered golden comparison complete.');
  const protectedComparison = requireGateResult('protected-temporal-isolation', await compareRegisteredAdapters({
    runId: `${runId}-protected`,
    controlId: 'scope-aware-bm25-control-v1',
    candidateId: 'memberry-proxy-v1',
    scenarios: TEMPORAL_ISOLATION_SCENARIOS,
    policy: labPolicy.protectedTemporalIsolation,
    repoRoot: REPO_ROOT,
  }));
  if (!protectedComparison.passed) {
    throw new Error(`Protected temporal/isolation gate failed:\n${protectedComparison.failures.map((failure) => `${failure.metric}: ${failure.actual}; ${failure.expected}`).join('\n')}`);
  }
  console.log('Evaluation-lab gate: protected comparison complete.');
  const retrievalComparison = requireGateResult('migrated-retrieval', await compareRegisteredAdapters({
    runId: `${runId}-retrieval`,
    controlId: 'scope-aware-bm25-control-v1',
    candidateId: 'memberry-proxy-v1',
    scenarios: RETRIEVAL_SCENARIOS,
    policy: labPolicy.migratedRetrievalControl,
    repoRoot: REPO_ROOT,
  }));
  if (!retrievalComparison.passed) {
    throw new Error(`Migrated retrieval no-regression gate failed:\n${retrievalComparison.failures.map((failure) => `${failure.metric}: ${failure.actual}; ${failure.expected}`).join('\n')}`);
  }
  console.log('Evaluation-lab gate: retrieval comparison complete.');
  // Two uniform-k lanes over the same holdout split: one k per call, because a
  // comparison call is the aggregation unit (runner.ts:143,165). Each lane
  // gates only its own metric; the other floor is 0 in lab-policy.json.
  const holdoutRecallComparison = requireGateResult('g2-holdout-recall', await compareRegisteredAdapters({
    runId: `${runId}-holdout-recall`,
    controlId: 'scope-aware-bm25-control-v1',
    candidateId: 'memberry-retrieval-core-v1',
    scenarios: holdoutRecallScenarios,
    splits: ['holdout'],
    policy: labPolicy.holdoutRecallAt10,
    repoRoot: REPO_ROOT,
  }));
  if (!holdoutRecallComparison.passed) {
    throw new Error(`Holdout recall@10 gate failed:\n${holdoutRecallComparison.failures.map((failure) => `${failure.metric}: ${failure.actual}; ${failure.expected}`).join('\n')}`);
  }
  console.log(`G2 holdout aggregate lane=g2-holdout-recall controlAdapterId=${holdoutRecallComparison.control.adapterId} controlRecallAtK=${holdoutRecallComparison.control.metrics.recallAtK} candidateAdapterId=${holdoutRecallComparison.candidate.adapterId} candidateRecallAtK=${holdoutRecallComparison.candidate.metrics.recallAtK}`);
  const holdoutPrecisionComparison = requireGateResult('g2-holdout-precision', await compareRegisteredAdapters({
    runId: `${runId}-holdout-precision`,
    controlId: 'scope-aware-bm25-control-v1',
    candidateId: 'memberry-retrieval-core-v1',
    scenarios: holdoutPrecisionScenarios,
    splits: ['holdout'],
    policy: labPolicy.holdoutPrecisionAt5,
    repoRoot: REPO_ROOT,
  }));
  if (!holdoutPrecisionComparison.passed) {
    throw new Error(`Holdout precision@5 gate failed:\n${holdoutPrecisionComparison.failures.map((failure) => `${failure.metric}: ${failure.actual}; ${failure.expected}`).join('\n')}`);
  }
  console.log(`G2 holdout aggregate lane=g2-holdout-precision controlAdapterId=${holdoutPrecisionComparison.control.adapterId} controlPrecisionAtK=${holdoutPrecisionComparison.control.metrics.precisionAtK} candidateAdapterId=${holdoutPrecisionComparison.candidate.adapterId} candidatePrecisionAtK=${holdoutPrecisionComparison.candidate.metrics.precisionAtK}`);
  console.log('Evaluation-lab gate: holdout recall@10 and precision@5 comparisons complete.');
  const ret007Dev = requireGateResult('ret007-multihop-dev', await runRet007MultiHopDevGateClosed({
    runId: `${runId}-ret007-multihop-dev`,
    repoRoot: REPO_ROOT,
    policy: labPolicy.queryDecompositionDev,
  }));
  const ret007DevAggregate = {
    outcome: ret007Dev.outcome,
    failureCodes: ret007Dev.failureCodes,
    split: ret007Dev.split,
    metric: ret007Dev.metric,
    n: ret007Dev.n,
    controlAdapterId: ret007Dev.controlAdapterId,
    candidateAdapterId: ret007Dev.candidateAdapterId,
    controlSuccessRate: ret007Dev.controlSuccessRate,
    candidateSuccessRate: ret007Dev.candidateSuccessRate,
    delta: ret007Dev.delta,
    interval: {
      outcome: ret007Dev.interval.outcome,
      pairedProbes: ret007Dev.interval.pairedProbes,
      resamples: ret007Dev.interval.resamples,
      level: ret007Dev.interval.level,
      point: ret007Dev.interval.point,
      lower: ret007Dev.interval.lower,
      upper: ret007Dev.interval.upper,
      oneSidedLower: ret007Dev.interval.oneSidedLower,
    },
  };
  console.log(JSON.stringify(ret007DevAggregate));
  if (ret007Dev.outcome !== 'passed') {
    throw new Error(`ret007-dev:${ret007Dev.failureCodes.join(',')}`);
  }
  const decompositionRecallComparison = requireGateResult('ret007-g2-holdout-recall', await compareRegisteredAdapters({
    runId: `${runId}-ret007-holdout-recall`,
    controlId: 'memberry-retrieval-core-v1',
    candidateId: 'memberry-retrieval-core-query-decomposition-v1',
    scenarios: holdoutRecallScenarios,
    splits: ['holdout'],
    policy: labPolicy.queryDecompositionRecallAt10,
    repoRoot: REPO_ROOT,
  }));
  if (!decompositionRecallComparison.passed) {
    throw new Error(`RET-007 recall@10 regression gate failed:\n${decompositionRecallComparison.failures.map((failure) => `${failure.metric}: ${failure.actual}; ${failure.expected}`).join('\n')}`);
  }
  console.log(`RET-007 G2 regression aggregate lane=ret007-holdout-recall controlAdapterId=${decompositionRecallComparison.control.adapterId} controlRecallAtK=${decompositionRecallComparison.control.metrics.recallAtK} candidateAdapterId=${decompositionRecallComparison.candidate.adapterId} candidateRecallAtK=${decompositionRecallComparison.candidate.metrics.recallAtK}`);
  const decompositionPrecisionComparison = requireGateResult('ret007-g2-holdout-precision', await compareRegisteredAdapters({
    runId: `${runId}-ret007-holdout-precision`,
    controlId: 'memberry-retrieval-core-v1',
    candidateId: 'memberry-retrieval-core-query-decomposition-v1',
    scenarios: holdoutPrecisionScenarios,
    splits: ['holdout'],
    policy: labPolicy.queryDecompositionPrecisionAt5,
    repoRoot: REPO_ROOT,
  }));
  if (!decompositionPrecisionComparison.passed) {
    throw new Error(`RET-007 precision@5 regression gate failed:\n${decompositionPrecisionComparison.failures.map((failure) => `${failure.metric}: ${failure.actual}; ${failure.expected}`).join('\n')}`);
  }
  console.log(`RET-007 G2 regression aggregate lane=ret007-holdout-precision controlAdapterId=${decompositionPrecisionComparison.control.adapterId} controlPrecisionAtK=${decompositionPrecisionComparison.control.metrics.precisionAtK} candidateAdapterId=${decompositionPrecisionComparison.candidate.adapterId} candidatePrecisionAtK=${decompositionPrecisionComparison.candidate.metrics.precisionAtK}`);
  const goldenDatasetHash = canonicalSha256([
    { id: goldenDev.id, version: goldenDev.version, split: goldenDev.split, hash: goldenDev.hash },
    { id: goldenHoldout.id, version: goldenHoldout.version, split: goldenHoldout.split, hash: goldenHoldout.hash },
  ]);
  const goldenManifest = createRunManifest({
    runId: goldenComparison.runId,
    createdAt: startedAt,
    gitCommit: sourceCommit,
    baselineCommit: baseline.source.commit,
    gitDirty: dirty,
    datasetId: 'memberry-lab-required-golden-v1',
    datasetHash: goldenDatasetHash,
    configHash: canonicalSha256(labPolicy.registeredGolden),
    config: { gatePolicy: labPolicy.registeredGolden, datasets: [{ id: goldenDev.id, hash: goldenDev.hash }, { id: goldenHoldout.id, hash: goldenHoldout.hash }], network: false, credentials: false },
    seed: baseline.seed,
    controlAdapter: goldenComparison.control.adapterId,
    candidateAdapter: goldenComparison.candidate.adapterId,
  });
  const protectedManifest = createRunManifest({
    runId: protectedComparison.runId,
    createdAt: startedAt,
    gitCommit: sourceCommit,
    baselineCommit: baseline.source.commit,
    gitDirty: dirty,
    datasetId: temporalDataset.id,
    datasetHash: temporalDataset.hash,
    configHash: canonicalSha256(labPolicy.protectedTemporalIsolation),
    config: { gatePolicy: labPolicy.protectedTemporalIsolation, dataset: { id: temporalDataset.id, hash: temporalDataset.hash }, network: false, credentials: false },
    seed: baseline.seed,
    controlAdapter: protectedComparison.control.adapterId,
    candidateAdapter: protectedComparison.candidate.adapterId,
  });
  const retrievalManifest = createRunManifest({
    ...protectedManifest,
    runId: retrievalComparison.runId,
    datasetId: retrievalDataset.id,
    datasetHash: retrievalDataset.hash,
    configHash: canonicalSha256(labPolicy.migratedRetrievalControl),
    config: { gatePolicy: labPolicy.migratedRetrievalControl, dataset: { id: retrievalDataset.id, hash: retrievalDataset.hash }, network: false, credentials: false },
    controlAdapter: retrievalComparison.control.adapterId,
    candidateAdapter: retrievalComparison.candidate.adapterId,
  });
  const g2DatasetHash = canonicalSha256([
    { id: g2Dev.id, version: g2Dev.version, split: g2Dev.split, hash: g2Dev.hash },
    { id: g2Holdout.id, version: g2Holdout.version, split: g2Holdout.split, hash: g2Holdout.hash },
  ]);
  const holdoutRecallManifest = createRunManifest({
    ...retrievalManifest,
    runId: holdoutRecallComparison.runId,
    datasetId: 'memberry-g2-holdout-v1',
    datasetHash: g2DatasetHash,
    configHash: canonicalSha256(labPolicy.holdoutRecallAt10),
    config: { gatePolicy: labPolicy.holdoutRecallAt10, datasets: [{ id: g2Dev.id, hash: g2Dev.hash }, { id: g2Holdout.id, hash: g2Holdout.hash }], network: false, credentials: false },
    controlAdapter: holdoutRecallComparison.control.adapterId,
    candidateAdapter: holdoutRecallComparison.candidate.adapterId,
  });
  const holdoutPrecisionManifest = createRunManifest({
    ...holdoutRecallManifest,
    runId: holdoutPrecisionComparison.runId,
    configHash: canonicalSha256(labPolicy.holdoutPrecisionAt5),
    config: { gatePolicy: labPolicy.holdoutPrecisionAt5, datasets: [{ id: g2Dev.id, hash: g2Dev.hash }, { id: g2Holdout.id, hash: g2Holdout.hash }], network: false, credentials: false },
    controlAdapter: holdoutPrecisionComparison.control.adapterId,
    candidateAdapter: holdoutPrecisionComparison.candidate.adapterId,
  });
  const decompositionRecallManifest = createRunManifest({
    ...holdoutRecallManifest,
    runId: decompositionRecallComparison.runId,
    configHash: canonicalSha256(labPolicy.queryDecompositionRecallAt10),
    config: { gatePolicy: labPolicy.queryDecompositionRecallAt10, datasets: [{ id: g2Dev.id, hash: g2Dev.hash }, { id: g2Holdout.id, hash: g2Holdout.hash }], network: false, credentials: false },
    controlAdapter: decompositionRecallComparison.control.adapterId,
    candidateAdapter: decompositionRecallComparison.candidate.adapterId,
  });
  const decompositionPrecisionManifest = createRunManifest({
    ...holdoutPrecisionManifest,
    runId: decompositionPrecisionComparison.runId,
    configHash: canonicalSha256(labPolicy.queryDecompositionPrecisionAt5),
    config: { gatePolicy: labPolicy.queryDecompositionPrecisionAt5, datasets: [{ id: g2Dev.id, hash: g2Dev.hash }, { id: g2Holdout.id, hash: g2Holdout.hash }], network: false, credentials: false },
    controlAdapter: decompositionPrecisionComparison.control.adapterId,
    candidateAdapter: decompositionPrecisionComparison.candidate.adapterId,
  });
  const goldenPaths = await writeRequiredCiComparisonArtifacts(resolve(ARTIFACT_DIR, goldenComparison.runId), goldenComparison, goldenManifest);
  const protectedPaths = await writeRequiredCiComparisonArtifacts(resolve(ARTIFACT_DIR, protectedComparison.runId), protectedComparison, protectedManifest);
  const retrievalPaths = await writeRequiredCiComparisonArtifacts(resolve(ARTIFACT_DIR, retrievalComparison.runId), retrievalComparison, retrievalManifest);
  const holdoutRecallPaths = await writeRequiredCiComparisonArtifacts(resolve(ARTIFACT_DIR, holdoutRecallComparison.runId), holdoutRecallComparison, holdoutRecallManifest);
  const holdoutPrecisionPaths = await writeRequiredCiComparisonArtifacts(resolve(ARTIFACT_DIR, holdoutPrecisionComparison.runId), holdoutPrecisionComparison, holdoutPrecisionManifest);
  const decompositionRecallPaths = await writeRequiredCiComparisonArtifacts(resolve(ARTIFACT_DIR, decompositionRecallComparison.runId), decompositionRecallComparison, decompositionRecallManifest);
  const decompositionPrecisionPaths = await writeRequiredCiComparisonArtifacts(resolve(ARTIFACT_DIR, decompositionPrecisionComparison.runId), decompositionPrecisionComparison, decompositionPrecisionManifest);
  console.log('Evaluation-lab gate: retrieval artifacts published.');
  console.log(`Evaluation-lab deterministic gate passed against ${baseline.id}.`);
  for (const metric of comparison.metrics) console.log(`- ${metric.metric}: ${metric.candidate} (baseline ${metric.baseline}, delta ${metric.delta})`);
  console.log(`Registered golden artifact: ${goldenPaths.manifest}`);
  console.log(`Protected artifact: ${protectedPaths.manifest}`);
  console.log(`Retrieval evidence artifact: ${retrievalPaths.manifest}`);
  console.log(`Holdout recall@10 artifact: ${holdoutRecallPaths.manifest}`);
  console.log(`Holdout precision@5 artifact: ${holdoutPrecisionPaths.manifest}`);
  console.log(`RET-007 recall@10 regression artifact: ${decompositionRecallPaths.manifest}`);
  console.log(`RET-007 precision@5 regression artifact: ${decompositionPrecisionPaths.manifest}`);
  console.log(`Admission structural artifact: ${admission.artifacts.manifest}`);
  console.log(`Known retrieval answer coverage remains visible at ${retrievalComparison.candidate.metrics.answerCoverage}; promotion work must improve it without regressing safety.`);
  return { passed: true, artifacts: [goldenPaths.manifest, protectedPaths.manifest, retrievalPaths.manifest, holdoutRecallPaths.manifest, holdoutPrecisionPaths.manifest, decompositionRecallPaths.manifest, decompositionPrecisionPaths.manifest, admission.artifacts.manifest] };
}

// The executable wrapper is bench/lab/ci.mts.
