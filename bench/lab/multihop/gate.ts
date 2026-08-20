import { readFile as nodeReadFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { LabGatePolicy } from '../contracts/report.js';
import type { LabScenarioInput, LabScenarioOracle } from '../contracts/scenario.js';
import { pairMultiHopScenarios } from '../datasets/load-multihop.js';
import {
  loadRegisteredDatasetDescriptor,
  type RegisteredDatasetDescriptor,
} from '../datasets/load-golden.js';
import { compareRegisteredAdapters } from '../registered-adapters.js';
import { evaluateMultiHopPolicy } from './policy.js';
import type { MultiHopPolicyFailure } from './policy.js';
import { scoreMultiHopComparison, type MultiHopPublicInterval } from './scorer-only.js';

export const RET007_CONTROL_ADAPTER_ID = 'memberry-retrieval-core-v1';
export const RET007_CANDIDATE_ADAPTER_ID = 'memberry-retrieval-core-query-decomposition-v1';

export interface Ret007MultiHopGateReceipt {
  readonly outcome: 'passed';
  readonly split: 'dev' | 'holdout';
  readonly metric: 'strict-multi-hop-task-success-v1';
  readonly n: number;
  readonly controlAdapterId: typeof RET007_CONTROL_ADAPTER_ID;
  readonly candidateAdapterId: typeof RET007_CANDIDATE_ADAPTER_ID;
  readonly controlSuccessRate: number;
  readonly candidateSuccessRate: number;
  readonly delta: number;
  readonly interval: Readonly<MultiHopPublicInterval>;
}

export interface Ret007MultiHopGateEvaluationReceipt {
  readonly outcome: 'passed' | 'rejected';
  readonly failureCodes: readonly MultiHopPolicyFailure[];
  readonly split: 'dev' | 'holdout';
  readonly metric: 'strict-multi-hop-task-success-v1';
  readonly n: number;
  readonly controlAdapterId: typeof RET007_CONTROL_ADAPTER_ID;
  readonly candidateAdapterId: typeof RET007_CANDIDATE_ADAPTER_ID;
  readonly controlSuccessRate: number;
  readonly candidateSuccessRate: number;
  readonly delta: number;
  readonly interval: Readonly<MultiHopPublicInterval>;
}

export interface Ret007GateCustodianV1 {
  loadDescriptor(
    datasetId: 'memberry-multihop-dev' | 'memberry-multihop-holdout',
    repoRoot: string,
    access: 'all',
  ): Promise<RegisteredDatasetDescriptor>;
  readArtifact(path: string): Promise<string>;
}

const DEFAULT_CUSTODIAN: Ret007GateCustodianV1 = Object.freeze({
  loadDescriptor: (datasetId, repoRoot, access) =>
    loadRegisteredDatasetDescriptor(datasetId, repoRoot, access),
  readArtifact: (path) => nodeReadFile(path, 'utf8'),
});

function parseJsonLines<T>(text: string): readonly T[] {
  return text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as T);
}

async function runRet007MultiHopGate(options: {
  readonly runId: string;
  readonly repoRoot: string;
  readonly policy: LabGatePolicy;
  readonly split: 'dev' | 'holdout';
  readonly descriptor: RegisteredDatasetDescriptor;
  readonly custodian: Ret007GateCustodianV1;
}): Promise<Readonly<Ret007MultiHopGateEvaluationReceipt>> {
  const { repoRoot, descriptor, custodian } = options;
  if (descriptor.split !== options.split || descriptor.inputArtifacts.length !== 1
    || descriptor.oracleArtifacts.length !== 1) throw new Error(`ret007-${options.split}:registered-artifact-mismatch`);
  const [inputText, oracleText] = await Promise.all([
    custodian.readArtifact(descriptor.inputArtifacts[0]!.path),
    custodian.readArtifact(descriptor.oracleArtifacts[0]!.path),
  ]);
  const scenarios = pairMultiHopScenarios(
    parseJsonLines<LabScenarioInput>(inputText),
    parseJsonLines<LabScenarioOracle>(oracleText),
    options.split,
  );
  const comparison = await compareRegisteredAdapters({
    runId: options.runId,
    controlId: RET007_CONTROL_ADAPTER_ID,
    candidateId: RET007_CANDIDATE_ADAPTER_ID,
    scenarios,
    splits: [options.split],
    policy: options.policy,
    repoRoot,
  });
  const aggregate = scoreMultiHopComparison(scenarios, comparison);
  const failures = evaluateMultiHopPolicy(aggregate, comparison);
  if (aggregate.controlAdapterId !== RET007_CONTROL_ADAPTER_ID
    || aggregate.candidateAdapterId !== RET007_CANDIDATE_ADAPTER_ID) {
    throw new Error(`ret007-${options.split}:adapter-identity-mismatch`);
  }
  return Object.freeze({
    outcome: failures.length === 0 ? 'passed' : 'rejected',
    failureCodes: Object.freeze([...failures]),
    split: options.split,
    metric: aggregate.metric,
    n: aggregate.n,
    controlAdapterId: RET007_CONTROL_ADAPTER_ID,
    candidateAdapterId: RET007_CANDIDATE_ADAPTER_ID,
    controlSuccessRate: aggregate.controlSuccessRate,
    candidateSuccessRate: aggregate.candidateSuccessRate,
    delta: aggregate.delta,
    interval: aggregate.interval,
  });
}

function requirePassed(
  evaluation: Readonly<Ret007MultiHopGateEvaluationReceipt>,
): Readonly<Ret007MultiHopGateReceipt> {
  if (evaluation.outcome !== 'passed') {
    throw new Error(`ret007-${evaluation.split}:${evaluation.failureCodes.join(',')}`);
  }
  return Object.freeze({
    outcome: 'passed',
    split: evaluation.split,
    metric: evaluation.metric,
    n: evaluation.n,
    controlAdapterId: evaluation.controlAdapterId,
    candidateAdapterId: evaluation.candidateAdapterId,
    controlSuccessRate: evaluation.controlSuccessRate,
    candidateSuccessRate: evaluation.candidateSuccessRate,
    delta: evaluation.delta,
    interval: evaluation.interval,
  });
}

/** Scorer-owned ordinary-CI gate. The wrapper binds the dev descriptor literally. */
export function runRet007MultiHopDevGate(options: {
  readonly runId: string;
  readonly repoRoot?: string;
  readonly policy: LabGatePolicy;
  readonly custodian?: Ret007GateCustodianV1;
}): Promise<Readonly<Ret007MultiHopGateReceipt>> {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const custodian = options.custodian ?? DEFAULT_CUSTODIAN;
  return custodian.loadDescriptor('memberry-multihop-dev', repoRoot, 'all').then((descriptor) =>
    runRet007MultiHopGate({
      runId: options.runId,
      policy: options.policy,
      repoRoot,
      split: 'dev',
      descriptor,
      custodian,
    })).then(requirePassed);
}

/** Scorer-custodian manual gate. No ordinary CI entrypoint imports this symbol. */
export function runRet007MultiHopHoldoutGate(options: {
  readonly runId: string;
  readonly repoRoot?: string;
  readonly policy: LabGatePolicy;
  readonly custodian?: Ret007GateCustodianV1;
}): Promise<Readonly<Ret007MultiHopGateReceipt>> {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const custodian = options.custodian ?? DEFAULT_CUSTODIAN;
  return custodian.loadDescriptor('memberry-multihop-holdout', repoRoot, 'all').then((descriptor) =>
    runRet007MultiHopGate({
      runId: options.runId,
      policy: options.policy,
      repoRoot,
      split: 'holdout',
      descriptor,
      custodian,
    })).then(requirePassed);
}

/** Post-burn aggregate-only evaluator. Policy rejection is data, never an exception. */
export function runRet007MultiHopHoldoutGateClosed(options: {
  readonly runId: string;
  readonly repoRoot?: string;
  readonly policy: LabGatePolicy;
  readonly custodian?: Ret007GateCustodianV1;
}): Promise<Readonly<Ret007MultiHopGateEvaluationReceipt>> {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const custodian = options.custodian ?? DEFAULT_CUSTODIAN;
  return custodian.loadDescriptor('memberry-multihop-holdout', repoRoot, 'all').then((descriptor) =>
    runRet007MultiHopGate({
      runId: options.runId,
      policy: options.policy,
      repoRoot,
      split: 'holdout',
      descriptor,
      custodian,
    }));
}
