import type { AdapterStats } from './adapter.js';
import type { ScenarioDimension } from './scenario.js';
import type { LAB_TOKEN_ESTIMATOR_ID } from '../metrics.js';
import type { LabBootstrapInterval } from '../stats.js';

export interface ProbeMetrics {
  recallAtK: number;
  precisionAtK: number;
  reciprocalRank: number;
  ndcgAtK: number;
  answerCoverage: number;
  staleLeakRate: number;
  isolationLeakRate: number;
  duplicateRate: number;
  unknownResultRate: number;
  /** Safety credit is zero for an unanswered probe, preventing empty-result gaming. */
  staleSafety: number;
  isolationSafety: number;
}

/**
 * Context-token accounting for the efficiency proxy, aggregated as a
 * run-level ratio of sums over scored probes only.
 *
 * `taskSuccessPer1kTokens` is the deterministic-lab proxy for PRP §6.5's
 * "task success per 1,000 context tokens". Its numerator is fixture-oracle
 * answer coverage on retrieval probes, not agent task completion; no agent
 * executes a task in this lab. Its denominator is estimated from fixture
 * content of returned results, not from rendered context actually consumed
 * by a model. It is a comparative efficiency signal between two arms on
 * identical fixtures, and is not a claim about agent-level task completion.
 */
export interface LabContextAccounting {
  estimatorId: typeof LAB_TOKEN_ESTIMATOR_ID;
  scoredProbes: number;
  contextTokens: number;
  taskSuccessTotal: number;
  outcome: 'measured' | 'unsupported';
  unsupportedReason?: 'no-scored-probes' | 'zero-context-tokens';
  /** null iff outcome is 'unsupported'; never 0, NaN, or Infinity as a stand-in. */
  taskSuccessPer1kTokens: number | null;
}

/** Reported, never gating: this is not a ProbeMetrics key and produces no GateFailure. */
export interface ComparisonEfficiency {
  metric: 'taskSuccessPer1kTokens';
  control: LabContextAccounting;
  candidate: LabContextAccounting;
  /** Candidate minus control; null when either arm is unsupported. */
  delta: number | null;
  interval: LabBootstrapInterval;
}

export interface ProbeReport {
  probeId: string;
  query: string;
  resultIds: readonly string[];
  metrics: ProbeMetrics;
  /** Estimated fixture-content tokens of the deduplicated top-k results. */
  contextTokens?: number;
  durationMs?: number;
}

export interface ScenarioReport {
  scenarioId: string;
  split: 'dev' | 'holdout';
  dimensions: readonly ScenarioDimension[];
  capabilityGaps: readonly string[];
  outcome: 'unsupported' | 'failed' | 'scored';
  exclusionReason?: string;
  probes: readonly ProbeReport[];
  metrics: ProbeMetrics;
  contextAccounting?: LabContextAccounting;
}

export interface LabGatePolicy {
  minRecallAtK: number;
  minPrecisionAtK: number;
  minAnswerCoverage: number;
  maxStaleLeakRate: number;
  maxIsolationLeakRate: number;
  maxDuplicateRate: number;
  maxUnknownResultRate: number;
  /** Maximum candidate regression relative to control for non-safety metrics. */
  maxQualityRegression: number;
}

export interface GateFailure {
  metric: keyof ProbeMetrics | 'adapter-health' | 'scenario-coverage';
  actual: number | string;
  expected: string;
  scenarioId?: string;
  arm?: 'control' | 'candidate';
}

export interface AdapterRunReport {
  contractVersion: string;
  runId: string;
  adapterId: string;
  adapterName: string;
  executionMode: 'proxy' | 'fixture' | 'live';
  health: string;
  outcome: 'unsupported' | 'failed' | 'scored';
  excludedScenarios: readonly { scenarioId: string; split: 'dev' | 'holdout'; reason: string }[];
  scenarioReports: readonly ScenarioReport[];
  metrics: ProbeMetrics;
  contextAccounting?: LabContextAccounting;
  stats: AdapterStats;
  gateFailures: readonly GateFailure[];
  passed: boolean;
}

export interface MetricDelta {
  metric: keyof ProbeMetrics;
  control: number;
  candidate: number;
  delta: number;
}

export interface ComparisonReport {
  runId: string;
  evidenceMode: 'ad-hoc' | 'registered-ci';
  control: AdapterRunReport;
  candidate: AdapterRunReport;
  deltas: readonly MetricDelta[];
  efficiency?: ComparisonEfficiency;
  failures: readonly GateFailure[];
  passed: boolean;
}

export interface RunManifest {
  schemaVersion: '1.0.0';
  runId: string;
  createdAt: string;
  gitCommit: string;
  baselineCommit: string;
  gitDirty: boolean;
  datasetId: string;
  datasetHash: string;
  configHash: string;
  /** Redacted diagnostic configuration. Secrets must never be serialized. */
  config?: Readonly<Record<string, unknown>>;
  seed: number;
  controlAdapter: string;
  candidateAdapter: string;
  runtime: {
    node: string;
    platform: string;
    arch: string;
  };
}
