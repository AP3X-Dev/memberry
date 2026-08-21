import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LabScenario, LabScenarioInput, LabScenarioOracle } from '../contracts/scenario.js';
import { LAB_SCENARIO_VERSION, validateScenario } from '../contracts/scenario.js';
import {
  MULTIHOP_V2_DENSITY_COUNTS,
  MULTIHOP_V2_FREEZE,
  MULTIHOP_V2_K,
  MULTIHOP_V2_PROBES_PER_SPLIT,
  type MultiHopV2Density,
} from '../multihop/policy-v2.js';
import { loadRegisteredDatasetDescriptor, type RegisteredDatasetDescriptor } from './load-golden.js';

/** Scorer-custody type anchor: importing scorer-only-v2 transitively crosses the forbidden dataset boundary. */
export type MultiHopV2ScoringScenario = LabScenario;

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(HERE, '..', '..', '..');
const ORACLE_SHAPED_KEYS = new Set([
  'oracle', 'oracles', 'relevant', 'required', 'stale', 'forbidden', 'label', 'labels', 'expected', 'outcome', 'outcomes',
]);
const MULTIHOP_V2_FAMILIES = new Set(['routing', 'assignment', 'component', 'custody', 'maintenance']);
const DENSITIES = Object.freeze(['low', 'medium', 'high'] as const satisfies readonly MultiHopV2Density[]);
const OPAQUE_MEMORY_ID = /^m2-[0-9a-f]{24}$/;
const OPAQUE_PROBE_ID = /^p2-[0-9a-f]{24}$/;
const ROLE_LEAK = /(?:^|[-_])(a|b|required|relevant|hop-?1|hop-?2)(?:$|[-_])/i;

export const MULTIHOP_V2_DATASET_IDS = Object.freeze({
  dev: 'memberry-multihop-v2-dev',
  holdout: 'memberry-multihop-v2-holdout',
} as const);

async function descriptor(
  split: 'dev' | 'holdout',
  repoRoot: string,
  verifyAccess: 'adapter' | 'all',
): Promise<RegisteredDatasetDescriptor> {
  const value = await loadRegisteredDatasetDescriptor(MULTIHOP_V2_DATASET_IDS[split], repoRoot, verifyAccess);
  if (value.version !== MULTIHOP_V2_FREEZE.version) throw new Error(`${value.id} registry version mismatch: ${value.version}`);
  if (value.split !== split) throw new Error(`${value.id} registry split mismatch: ${value.split}`);
  if (value.inputArtifacts.length !== 1 || value.oracleArtifacts.length !== 1) {
    throw new Error(`${value.id} requires one adapter input and one scorer oracle artifact`);
  }
  if (value.inputArtifacts[0]!.path === value.oracleArtifacts[0]!.path) {
    throw new Error(`${value.id} input and oracle must be physically separate`);
  }
  return value;
}

async function parseJsonLines(path: string): Promise<unknown[]> {
  return (await readFile(path, 'utf8')).split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    try { return JSON.parse(line) as unknown; }
    catch (error) { throw new Error(`${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
  });
}

function rejectOracleShape(value: unknown, path = 'input'): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => rejectOracleShape(child, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (ORACLE_SHAPED_KEYS.has(key.toLowerCase())) throw new Error(`${path} contains oracle-shaped key ${key}`);
    rejectOracleShape(child, `${path}.${key}`);
  }
}

function inputShape(value: unknown, index: number): LabScenarioInput {
  rejectOracleShape(value, `inputs[${index}]`);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`inputs[${index}] must be an object`);
  return value as LabScenarioInput;
}

function oneTag(input: LabScenarioInput, prefix: string): string {
  const matches = input.tags?.filter((tag) => tag.startsWith(prefix)) ?? [];
  if (matches.length !== 1) throw new Error(`${input.id}: requires exactly one ${prefix} tag`);
  return matches[0]!;
}

function lexicalSkeleton(text: string): string {
  return text.normalize('NFKC').replace(/\b[A-Z][A-Za-z0-9'-]*\b/g, '<slot>')
    .replace(/\b\d+(?::\d+)?\b/g, '<slot>').toLowerCase().replace(/\s+/g, ' ').trim();
}

function counts(values: readonly string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

/** Public frozen order key. Its inputs are only the seed, scenario ID, and neutral slot ID (the opaque memory ID). */
export function multiHopV2OrderKey(scenarioId: string, neutralSlotId: string): string {
  return createHash('sha256')
    .update(`${MULTIHOP_V2_FREEZE.publicOrderSeed}\n${scenarioId}\n${neutralSlotId}`, 'utf8')
    .digest('hex');
}

function ordinalCompare(left: string, right: string): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertSeededCorpusOrder(input: LabScenarioInput): void {
  const expected = [...input.memories].sort((left, right) => (
    ordinalCompare(multiHopV2OrderKey(input.id, left.id), multiHopV2OrderKey(input.id, right.id))
      || ordinalCompare(left.id, right.id)
  ));
  if (expected.some((memory, index) => memory.id !== input.memories[index]!.id)) {
    throw new Error(`${input.id}: corpus order does not match frozen public seed derivation`);
  }
}

/** Validates adapter-visible v2 bytes only; this route never accepts or opens an oracle. */
export function validateMultiHopV2ScenarioInputs(values: readonly unknown[]): readonly LabScenarioInput[] {
  const inputs = values.map(inputShape);
  const scenarioIds = new Set<string>();
  const memoryIds = new Set<string>();
  const probeIds = new Set<string>();
  for (const input of inputs) {
    if (input.version !== LAB_SCENARIO_VERSION) throw new Error(`${input.id}: unsupported scenario version`);
    if (scenarioIds.has(input.id)) throw new Error(`duplicate scenario id: ${input.id}`);
    scenarioIds.add(input.id);
    if (input.split !== 'dev' && input.split !== 'holdout') throw new Error(`${input.id}: invalid split`);
    if (!new RegExp(`^mh2-${input.split === 'dev' ? 'd' : 'h'}-[0-9]{2}$`).test(input.id)) {
      throw new Error(`${input.id}: scenario ID/split mismatch`);
    }
    if (input.dimensions.length !== 1 || input.dimensions[0] !== 'multi-hop') throw new Error(`${input.id}: dimension must be multi-hop only`);
    if (input.queries.length !== 1) throw new Error(`${input.id}: requires exactly one query`);
    if (input.queries[0]!.limit !== MULTIHOP_V2_K) throw new Error(`${input.id}: k must be ${MULTIHOP_V2_K}`);
    if (!OPAQUE_PROBE_ID.test(input.queries[0]!.id) || ROLE_LEAK.test(input.queries[0]!.id)) throw new Error(`${input.id}: probe ID must be opaque and role-neutral`);
    if (probeIds.has(input.queries[0]!.id)) throw new Error(`${input.id}: duplicate probe ID`);
    probeIds.add(input.queries[0]!.id);
    if (input.memories.length !== 24) throw new Error(`${input.id}: requires exactly 24 eligible memories`);
    for (const memory of input.memories) {
      if (!OPAQUE_MEMORY_ID.test(memory.id) || ROLE_LEAK.test(memory.id)) throw new Error(`${input.id}: memory ID must be opaque and role-neutral`);
      if (memoryIds.has(memory.id)) throw new Error(`${input.id}: memory ID must be globally unique`);
      memoryIds.add(memory.id);
    }
    assertSeededCorpusOrder(input);
    if (input.tags?.length !== 6 || input.tags.filter((tag) => tag === 'synthetic').length !== 1
      || input.tags.filter((tag) => tag === 'lab-013-candidate-blind-v2').length !== 1) {
      throw new Error(`${input.id}: exactly six synthetic provenance and diversity tags are required`);
    }
    oneTag(input, 'domain:');
    const family = oneTag(input, 'family:').slice('family:'.length);
    if (!MULTIHOP_V2_FAMILIES.has(family)) throw new Error(`${input.id}: unknown multi-hop relation family`);
    oneTag(input, 'query-form:');
    const density = oneTag(input, 'density:').slice('density:'.length);
    if (!DENSITIES.includes(density as MultiHopV2Density)) throw new Error(`${input.id}: unknown distractor-density stratum`);
  }
  for (const split of ['dev', 'holdout'] as const) {
    const selected = inputs.filter((input) => input.split === split);
    if (selected.length !== MULTIHOP_V2_PROBES_PER_SPLIT) {
      throw new Error(`${split} requires exactly ${MULTIHOP_V2_PROBES_PER_SPLIT} scenarios`);
    }
    const domains = counts(selected.map((input) => oneTag(input, 'domain:')));
    const forms = counts(selected.map((input) => oneTag(input, 'query-form:')));
    const families = counts(selected.map((input) => oneTag(input, 'family:').slice('family:'.length)));
    const densities = counts(selected.map((input) => oneTag(input, 'density:').slice('density:'.length)));
    if (domains.size < 10 || [...domains.values()].some((count) => count > 2)) throw new Error(`${split}: domain diversity/cap violated`);
    if (forms.size < 10 || [...forms.values()].some((count) => count > 2)) throw new Error(`${split}: query-form diversity/cap violated`);
    if (families.size !== MULTIHOP_V2_FAMILIES.size
      || [...MULTIHOP_V2_FAMILIES].some((family) => families.get(family) !== 4)) {
      throw new Error(`${split}: relation-family matrix must contain each family four times`);
    }
    for (const density of DENSITIES) {
      if (densities.get(density) !== MULTIHOP_V2_DENSITY_COUNTS[density]) {
        throw new Error(`${split}: distractor-density matrix mismatch for ${density}`);
      }
    }
    const skeletons = counts(selected.map((input) => lexicalSkeleton(input.queries[0]!.query)));
    if (skeletons.size < 10 || [...skeletons.values()].some((count) => count > 2)) {
      throw new Error(`${split}: query lexical skeleton diversity/cap violated`);
    }
  }
  const dev = inputs.filter((input) => input.split === 'dev');
  const holdout = inputs.filter((input) => input.split === 'holdout');
  const devDomains = new Set(dev.map((input) => oneTag(input, 'domain:')));
  const devForms = new Set(dev.map((input) => oneTag(input, 'query-form:')));
  const devSkeletons = new Set(dev.map((input) => lexicalSkeleton(input.queries[0]!.query)));
  if (holdout.some((input) => devDomains.has(oneTag(input, 'domain:')))) throw new Error('dev/holdout domain tags must be disjoint');
  if (holdout.some((input) => devForms.has(oneTag(input, 'query-form:')))) throw new Error('dev/holdout query-form tags must be disjoint');
  if (holdout.some((input) => devSkeletons.has(lexicalSkeleton(input.queries[0]!.query)))) {
    throw new Error('dev/holdout query skeletons must be disjoint');
  }
  return inputs;
}

export function pairMultiHopV2Scenarios(
  inputs: readonly LabScenarioInput[],
  oracles: readonly LabScenarioOracle[],
  split: 'dev' | 'holdout',
): readonly LabScenario[] {
  if (inputs.length !== MULTIHOP_V2_PROBES_PER_SPLIT || oracles.length !== inputs.length) {
    throw new Error(`${split} requires exactly ${MULTIHOP_V2_PROBES_PER_SPLIT} input/oracle pairs`);
  }
  return inputs.map((input, index) => {
    const oracle = oracles[index];
    if (!oracle || oracle.scenarioId !== input.id) throw new Error(`${input.id}: oracle ID/order mismatch`);
    if (input.split !== split) throw new Error(`${input.id}: split mismatch`);
    const scenario = { input, oracle } satisfies LabScenario;
    const errors = validateScenario(scenario);
    if (errors.length > 0) throw new Error(`${input.id}: ${errors.join('; ')}`);
    if (oracle.probes.length !== 1 || oracle.probes[0]!.probeId !== input.queries[0]!.id) {
      throw new Error(`${input.id}: requires one query-aligned oracle probe`);
    }
    const required = oracle.probes[0]!.required;
    if (!required || required.length !== 2 || new Set(required).size !== 2) {
      throw new Error(`${input.id}: requires exactly two distinct required hop IDs`);
    }
    if (oracle.probes[0]!.relevant.length !== 2
      || new Set(oracle.probes[0]!.relevant).size !== 2
      || required.some((id) => !oracle.probes[0]!.relevant.includes(id))) {
      throw new Error(`${input.id}: relevant set must equal the two required hop IDs`);
    }
    const corpusIds = new Set(input.memories.map(({ id }) => id));
    if (!required.every((id) => corpusIds.has(id))) throw new Error(`${input.id}: required hop is absent from corpus`);
    return scenario;
  });
}

/** Loads both physical splits through adapter access; scorer artifacts are neither read nor hashed. */
export async function loadMultiHopV2ScenarioInputs(repoRoot = DEFAULT_REPO_ROOT): Promise<readonly LabScenarioInput[]> {
  const records: unknown[] = [];
  for (const split of ['dev', 'holdout'] as const) {
    const registered = await descriptor(split, repoRoot, 'adapter');
    records.push(...await parseJsonLines(registered.inputArtifacts[0]!.path));
  }
  return validateMultiHopV2ScenarioInputs(records);
}

/** Scorer-custodian route. It opens exactly one requested split oracle after input-only validation. */
export async function loadMultiHopV2ScenariosForScoring(
  split: 'dev' | 'holdout',
  repoRoot = DEFAULT_REPO_ROOT,
): Promise<readonly LabScenario[]> {
  const inputs = (await loadMultiHopV2ScenarioInputs(repoRoot)).filter((input) => input.split === split);
  const registered = await descriptor(split, repoRoot, 'all');
  const oracles = await parseJsonLines(registered.oracleArtifacts[0]!.path) as LabScenarioOracle[];
  return pairMultiHopV2Scenarios(inputs, oracles, split);
}
