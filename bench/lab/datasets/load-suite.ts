import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  LabScenario,
  LabScenarioInput,
  LabScenarioOracle,
  ScenarioDimension,
} from '../contracts/scenario.js';
import { validateScenario } from '../contracts/scenario.js';
import { loadRegisteredDatasetDescriptor, type RegisteredDatasetDescriptor } from './load-golden.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(HERE, '..', '..', '..');
const DATASET_IDS = ['memberry-g2-holdout-dev', 'memberry-g2-holdout-holdout'] as const;
const ORACLE_KEYS = new Set(['oracle', 'relevant', 'required', 'stale', 'forbidden']);

/**
 * One lane is one compareRegisteredAdapters call, and that call is the
 * aggregation unit: runner.ts:143,165 flatten every scored probe into an
 * unweighted mean that metrics.ts:87-93 computes with no k awareness. A lane
 * whose queries carry different limits therefore reports a mixture, not
 * recall@10 or precision@5, so each lane pins exactly one k here and the
 * loader refuses a selected set that violates it.
 */
export const G2_HOLDOUT_LANES = [
  { dimension: 'recall', limit: 10 },
  { dimension: 'precision', limit: 5 },
] as const satisfies readonly { dimension: ScenarioDimension; limit: number }[];

async function descriptors(
  repoRoot: string,
  verifyAccess: 'adapter' | 'all' = 'all',
): Promise<RegisteredDatasetDescriptor[]> {
  return Promise.all(DATASET_IDS.map((id) => loadRegisteredDatasetDescriptor(id, repoRoot, verifyAccess)));
}

async function parseJsonLines<T>(path: string): Promise<T[]> {
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.map((line, index) => {
    try { return JSON.parse(line) as T; }
    catch (error) { throw new Error(`${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
  });
}

/** Byte-equivalent copy of load-golden.ts:96-106; that guard is module-private there. */
function assertAdapterVisibleOnly(value: unknown, path = 'input'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertAdapterVisibleOnly(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (ORACLE_KEYS.has(key)) throw new Error(`${path}.${key} contains scorer-only oracle data`);
    assertAdapterVisibleOnly(child, `${path}.${key}`);
  }
}

/** Loads only adapter-visible inputs. This function never opens an oracle artifact. */
export async function loadG2HoldoutScenarioInputs(
  repoRoot = DEFAULT_REPO_ROOT,
): Promise<readonly LabScenarioInput[]> {
  const registered = await descriptors(repoRoot, 'adapter');
  const inputs: LabScenarioInput[] = [];
  for (const descriptor of registered) {
    if (descriptor.inputArtifacts.length !== 1) throw new Error(`${descriptor.id} must have exactly one adapter input artifact`);
    for (const input of await parseJsonLines<LabScenarioInput>(descriptor.inputArtifacts[0]!.path)) {
      assertAdapterVisibleOnly(input);
      if (input.split !== descriptor.split) throw new Error(`${input.id} split ${input.split} does not match registry split ${descriptor.split}`);
      inputs.push(input);
    }
  }
  const ids = inputs.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error('G2 holdout suite scenario IDs must be unique');
  return inputs;
}

/**
 * Evaluator-only loader for one lane. Adapters receive only each returned
 * scenario.input through the runner contract. Both splits are returned; the
 * caller binds splits: ['holdout'] so runner.ts:86-89 excludes the dev half
 * before it can reach a scored mean.
 */
export async function loadG2HoldoutScenariosForScoring(
  dimension: ScenarioDimension,
  repoRoot = DEFAULT_REPO_ROOT,
): Promise<readonly LabScenario[]> {
  const lane = G2_HOLDOUT_LANES.find((entry) => entry.dimension === dimension);
  if (!lane) throw new Error(`${dimension} is not a registered G2 holdout lane`);
  const [inputs, registered] = await Promise.all([
    loadG2HoldoutScenarioInputs(repoRoot),
    descriptors(repoRoot),
  ]);
  const oracles: LabScenarioOracle[] = [];
  for (const descriptor of registered) {
    if (descriptor.oracleArtifacts.length !== 1) throw new Error(`${descriptor.id} must have exactly one scorer oracle artifact`);
    oracles.push(...await parseJsonLines<LabScenarioOracle>(descriptor.oracleArtifacts[0]!.path));
  }
  const byId = new Map(oracles.map((oracle) => [oracle.scenarioId, oracle]));
  if (byId.size !== oracles.length) throw new Error('G2 holdout oracle scenario IDs must be unique');
  const scenarios = inputs
    .filter((input) => input.dimensions.length === 1 && input.dimensions[0] === dimension)
    .map((input) => {
      const oracle = byId.get(input.id);
      if (!oracle) throw new Error(`${input.id} has no registered oracle`);
      const scenario = { input, oracle } satisfies LabScenario;
      const errors = validateScenario(scenario);
      if (errors.length > 0) throw new Error(`${input.id}: ${errors.join('; ')}`);
      for (const query of input.queries) {
        if (query.limit !== lane.limit) throw new Error(`${query.id}: ${dimension} lane is uniform-k at ${lane.limit}, not ${query.limit}`);
      }
      return scenario;
    });
  if (!scenarios.length) throw new Error(`${dimension} lane selected no scenarios`);
  return scenarios;
}
