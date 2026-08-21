import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LabScenario, LabScenarioInput, LabScenarioOracle } from '../contracts/scenario.js';
import { LAB_SCENARIO_VERSION, validateScenario } from '../contracts/scenario.js';
import { loadRegisteredDatasetDescriptor } from '../datasets/load-golden.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(HERE, '..', '..', '..');
const DATASET_ID = 'memberry-ret010-dev-v1';
const DATASET_VERSION = 'ret010-dev-v1';
const DATASET_SUITE = 'ret010-development';
const DATASET_RELATIVE_ROOT = 'bench/lab/datasets/ret010/v1/dev';
const SCORER_KEYS = new Set(['oracle', 'relevant', 'required', 'stale', 'forbidden']);

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be a nonblank string`);
  return value;
}

async function readSingleRegistryEntry(repoRoot: string): Promise<JsonObject> {
  const registryPath = resolve(repoRoot, 'bench', 'lab', 'registry', 'datasets.json');
  const registry = object(JSON.parse(await readFile(registryPath, 'utf8')));
  const datasets = registry?.datasets;
  if (!Array.isArray(datasets)) throw new Error('RET-010 dataset registry is malformed');
  const owned = datasets.filter((raw) => {
    const entry = object(raw);
    return entry?.id === DATASET_ID || entry?.suite === DATASET_SUITE;
  });
  if (owned.length !== 1) throw new Error('RET-010 requires exactly one registered development descriptor');
  const entry = object(owned[0]);
  if (!entry || entry.id !== DATASET_ID || entry.version !== DATASET_VERSION || entry.suite !== DATASET_SUITE) {
    throw new Error('RET-010 registered descriptor identity mismatch');
  }
  if (entry.kind !== 'repository' || entry.oracleAccess !== 'scorer-only') {
    throw new Error('RET-010 registered descriptor custody mismatch');
  }
  if (entry.split !== 'dev') throw new Error('RET-010 registered descriptor split must be dev');
  if (entry.requiredInCi !== false) throw new Error('RET-010 development descriptor must remain explicit and non-required');
  const source = object(entry.source);
  if (source?.revision !== DATASET_VERSION || source.path !== DATASET_RELATIVE_ROOT) {
    throw new Error('RET-010 registered source root mismatch');
  }
  const acquisition = object(entry.acquisition);
  if (acquisition?.status !== 'bundled') throw new Error('RET-010 registered acquisition must remain bundled');
  if (!Array.isArray(entry.artifacts) || entry.artifacts.length !== 2) {
    throw new Error('RET-010 requires exactly two frozen artifacts');
  }
  const expectedArtifacts = [
    {
      role: 'input', access: 'adapter', fileName: 'input.jsonl', hashMode: 'text-lf',
      repositoryPath: `${DATASET_RELATIVE_ROOT}/input.jsonl`,
    },
    {
      role: 'oracle', access: 'scorer', fileName: 'oracle.jsonl', hashMode: 'text-lf',
      repositoryPath: `${DATASET_RELATIVE_ROOT}/oracle.jsonl`,
    },
  ];
  for (const expected of expectedArtifacts) {
    const matches = entry.artifacts.filter((raw) => {
      const artifact = object(raw);
      return artifact?.role === expected.role
        && artifact?.access === expected.access
        && artifact?.fileName === expected.fileName
        && artifact?.hashMode === expected.hashMode
        && artifact?.repositoryPath === expected.repositoryPath;
    });
    if (matches.length !== 1) throw new Error(`RET-010 ${expected.role} artifact custody mismatch`);
  }
  return entry;
}

function rejectScorerKeys(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => rejectScorerKeys(child, `${path}[${index}]`));
    return;
  }
  const record = object(value);
  if (!record) return;
  for (const [key, child] of Object.entries(record)) {
    if (SCORER_KEYS.has(key.toLowerCase())) throw new Error(`${path}.${key} contains scorer-only data`);
    rejectScorerKeys(child, `${path}.${key}`);
  }
}

async function parseJsonLines(path: string): Promise<unknown[]> {
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/);
  const records: unknown[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as unknown);
    } catch (error) {
      throw new Error(`${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return records;
}

function exactArtifactPath(repoRoot: string, path: string, fileName: 'input.jsonl' | 'oracle.jsonl'): void {
  const expected = resolve(repoRoot, DATASET_RELATIVE_ROOT, fileName);
  if (resolve(path) !== expected) throw new Error(`RET-010 ${fileName} is outside the frozen development root`);
}

async function assertRealArtifactContainment(repoRoot: string): Promise<void> {
  const repositoryReal = await realpath(repoRoot);
  const root = resolve(repoRoot, DATASET_RELATIVE_ROOT);
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink()) throw new Error('RET-010 development root must not be a symbolic link');
  const rootReal = await realpath(root);
  if (rootReal !== resolve(repositoryReal, DATASET_RELATIVE_ROOT)) {
    throw new Error('RET-010 development root resolves outside repository custody');
  }
  for (const fileName of ['input.jsonl', 'oracle.jsonl'] as const) {
    const path = resolve(root, fileName);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`RET-010 ${fileName} must not be a symbolic link`);
    if (await realpath(path) !== resolve(rootReal, fileName)) {
      throw new Error(`RET-010 ${fileName} resolves outside the frozen development root`);
    }
  }
}

function inputRecord(value: unknown, index: number): LabScenarioInput {
  rejectScorerKeys(value, `inputs[${index}]`);
  const input = object(value);
  if (!input) throw new Error(`inputs[${index}] must be an object`);
  if (!Array.isArray(input.dimensions) || !Array.isArray(input.memories) || !Array.isArray(input.queries)) {
    throw new Error(`inputs[${index}] has malformed dimensions, memories, or queries`);
  }
  return input as unknown as LabScenarioInput;
}

function oracleRecord(value: unknown, index: number): LabScenarioOracle {
  const oracle = object(value);
  if (!oracle) throw new Error(`oracles[${index}] must be an object`);
  if (!Array.isArray(oracle.probes)) throw new Error(`oracles[${index}].probes must be an array`);
  return oracle as unknown as LabScenarioOracle;
}

/** Scorer-only fixed development loader. It exposes no dataset or split selector. */
export async function loadRet010DevScenarios(repoRoot = DEFAULT_REPO_ROOT): Promise<readonly LabScenario[]> {
  await readSingleRegistryEntry(repoRoot);
  await assertRealArtifactContainment(repoRoot);
  const descriptor = await loadRegisteredDatasetDescriptor(DATASET_ID, repoRoot, 'all');
  if (descriptor.id !== DATASET_ID || descriptor.version !== DATASET_VERSION || descriptor.suite !== DATASET_SUITE) {
    throw new Error('RET-010 verified descriptor identity mismatch');
  }
  if (descriptor.split !== 'dev') throw new Error('RET-010 verified descriptor split must be dev');
  if (descriptor.inputArtifacts.length !== 1 || descriptor.oracleArtifacts.length !== 1) {
    throw new Error('RET-010 requires exactly one adapter input and one scorer oracle artifact');
  }
  const inputPath = descriptor.inputArtifacts[0]!.path;
  const oraclePath = descriptor.oracleArtifacts[0]!.path;
  exactArtifactPath(repoRoot, inputPath, 'input.jsonl');
  exactArtifactPath(repoRoot, oraclePath, 'oracle.jsonl');
  if (resolve(inputPath) === resolve(oraclePath)) throw new Error('RET-010 input and oracle must be physically separate');

  const [rawInputs, rawOracles] = await Promise.all([parseJsonLines(inputPath), parseJsonLines(oraclePath)]);
  if (rawInputs.length !== 20 || rawOracles.length !== 20) {
    throw new Error('RET-010 requires exactly 20 input records and 20 oracle records');
  }
  const inputs = rawInputs.map(inputRecord);
  const oracles = rawOracles.map(oracleRecord);
  const scenarioIds = new Set<string>();
  const queryIds = new Set<string>();
  const probeIds = new Set<string>();

  const scenarios = inputs.map((input, index) => {
    if (input.version !== LAB_SCENARIO_VERSION || input.split !== 'dev') {
      throw new Error(`${input.id}: input version/split mismatch`);
    }
    const scenarioId = identity(input.id, `inputs[${index}].id`);
    if (scenarioIds.has(scenarioId)) throw new Error(`duplicate scenario id: ${scenarioId}`);
    scenarioIds.add(scenarioId);
    if (input.queries.length !== 1) throw new Error(`${input.id}: requires exactly one query`);
    const query = input.queries[0]!;
    const queryId = identity(query.id, `${scenarioId}.query.id`);
    if (queryIds.has(queryId)) throw new Error(`duplicate query id: ${queryId}`);
    queryIds.add(queryId);
    const recallLane = index < 10;
    const expectedDimension = recallLane ? 'recall' : 'precision';
    const expectedLimit = recallLane ? 10 : 5;
    if (input.dimensions.length !== 1 || input.dimensions[0] !== expectedDimension) {
      throw new Error(`${input.id}: expected ${expectedDimension}-only dimension at position ${index + 1}`);
    }
    if (query.limit !== expectedLimit) throw new Error(`${input.id}: expected k=${expectedLimit}`);

    const oracle = oracles[index];
    if (!oracle || oracle.version !== LAB_SCENARIO_VERSION || oracle.scenarioId !== input.id) {
      throw new Error(`${input.id}: oracle identity/order mismatch`);
    }
    if (oracle.probes.length !== 1 || oracle.probes[0]!.probeId !== queryId) {
      throw new Error(`${input.id}: requires one query-aligned oracle probe`);
    }
    const probeId = identity(oracle.probes[0]!.probeId, `${scenarioId}.probe.id`);
    if (probeIds.has(probeId)) throw new Error(`duplicate probe id: ${probeId}`);
    probeIds.add(probeId);
    const scenario = { input, oracle } satisfies LabScenario;
    const errors = validateScenario(scenario);
    if (errors.length > 0) throw new Error(`${input.id}: ${errors.join('; ')}`);
    return scenario;
  });

  if (scenarioIds.size !== 20 || queryIds.size !== 20 || probeIds.size !== 20) {
    throw new Error('RET-010 scenario/query/probe identities must be globally unique');
  }
  return scenarios;
}
