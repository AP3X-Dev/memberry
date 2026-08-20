import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LabScenario, LabScenarioInput, LabScenarioOracle } from '../contracts/scenario.js';
import { LAB_SCENARIO_VERSION, validateScenario } from '../contracts/scenario.js';
import { MULTIHOP_K, MULTIHOP_PROBES_PER_SPLIT } from '../multihop/policy.js';
import { loadRegisteredDatasetDescriptor, type RegisteredDatasetDescriptor } from './load-golden.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(HERE, '..', '..', '..');
const ORACLE_SHAPED_KEYS = new Set([
  'oracle', 'oracles', 'relevant', 'required', 'stale', 'forbidden', 'label', 'labels', 'expected',
]);
const MULTIHOP_SHAPES = new Set([
  'shape:location-routing-destination',
  'shape:assignment-schedule',
  'shape:component-dependency-property',
  'shape:artifact-custodian-policy',
  'shape:device-maintenance-report-endpoint',
]);

export const MULTIHOP_DATASET_IDS = Object.freeze({
  dev: 'memberry-multihop-dev',
  holdout: 'memberry-multihop-holdout',
} as const);

async function descriptor(
  split: 'dev' | 'holdout',
  repoRoot: string,
  verifyAccess: 'adapter' | 'all',
): Promise<RegisteredDatasetDescriptor> {
  const value = await loadRegisteredDatasetDescriptor(MULTIHOP_DATASET_IDS[split], repoRoot, verifyAccess);
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
    if (ORACLE_SHAPED_KEYS.has(key)) throw new Error(`${path} contains oracle-shaped key ${key}`);
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
    .replace(/\b\d+\b/g, '<slot>').toLowerCase().replace(/\s+/g, ' ').trim();
}

function counts(values: readonly string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

/** Validates adapter-visible bytes only; it never accepts or opens an oracle. */
export function validateMultiHopScenarioInputs(values: readonly unknown[]): readonly LabScenarioInput[] {
  const inputs = values.map(inputShape);
  const ids = new Set<string>();
  for (const input of inputs) {
    if (input.version !== LAB_SCENARIO_VERSION) throw new Error(`${input.id}: unsupported scenario version`);
    if (ids.has(input.id)) throw new Error(`duplicate scenario id: ${input.id}`);
    ids.add(input.id);
    if (input.split !== 'dev' && input.split !== 'holdout') throw new Error(`${input.id}: invalid split`);
    if (input.dimensions.length !== 1 || input.dimensions[0] !== 'multi-hop') throw new Error(`${input.id}: dimension must be multi-hop only`);
    if (input.queries.length !== 1) throw new Error(`${input.id}: requires exactly one query`);
    if (input.queries[0]!.limit !== MULTIHOP_K) throw new Error(`${input.id}: k must be ${MULTIHOP_K}`);
    if (input.memories.length < 11) throw new Error(`${input.id}: requires at least 11 eligible memories`);
    if (new Set(input.memories.map(({ id }) => id)).size !== input.memories.length) throw new Error(`${input.id}: duplicate memory id`);
    if (input.tags?.length !== 5 || input.tags.filter((tag) => tag === 'synthetic').length !== 1
      || input.tags.filter((tag) => tag === 'lab-012-pre-ret007').length !== 1) {
      throw new Error(`${input.id}: exactly five synthetic provenance and diversity tags are required`);
    }
    oneTag(input, 'domain:');
    const shape = oneTag(input, 'shape:');
    if (!MULTIHOP_SHAPES.has(shape)) throw new Error(`${input.id}: unknown multi-hop shape tag`);
    oneTag(input, 'query-form:');
  }
  for (const split of ['dev', 'holdout'] as const) {
    const selected = inputs.filter((input) => input.split === split);
    if (selected.length !== MULTIHOP_PROBES_PER_SPLIT) throw new Error(`${split} requires exactly ${MULTIHOP_PROBES_PER_SPLIT} scenarios`);
    const domains = counts(selected.map((input) => oneTag(input, 'domain:')));
    const forms = counts(selected.map((input) => oneTag(input, 'query-form:')));
    const shapes = counts(selected.map((input) => oneTag(input, 'shape:')));
    if (domains.size < 5 || [...domains.values()].some((count) => count > 2)) throw new Error(`${split}: domain diversity/cap violated`);
    if (forms.size < 5 || [...forms.values()].some((count) => count > 2)) throw new Error(`${split}: query-form diversity/cap violated`);
    if (shapes.size !== MULTIHOP_SHAPES.size
      || [...MULTIHOP_SHAPES].some((shape) => shapes.get(shape) !== 2)) throw new Error(`${split}: shape matrix must contain each family twice`);
  }
  const dev = inputs.filter((input) => input.split === 'dev');
  const holdout = inputs.filter((input) => input.split === 'holdout');
  const devDomains = new Set(dev.map((input) => oneTag(input, 'domain:')));
  const devForms = new Set(dev.map((input) => oneTag(input, 'query-form:')));
  if (holdout.some((input) => devDomains.has(oneTag(input, 'domain:')))) throw new Error('dev/holdout domain tags must be disjoint');
  if (holdout.some((input) => devForms.has(oneTag(input, 'query-form:')))) throw new Error('dev/holdout query-form tags must be disjoint');
  const skeletons = counts(inputs.map((input) => lexicalSkeleton(input.queries[0]!.query)));
  if (skeletons.size < 8 || [...skeletons.values()].some((count) => count > 2)) throw new Error('query lexical skeleton diversity/cap violated');
  const devSkeletons = new Set(dev.map((input) => lexicalSkeleton(input.queries[0]!.query)));
  if (holdout.some((input) => devSkeletons.has(lexicalSkeleton(input.queries[0]!.query)))) {
    throw new Error('dev/holdout query templates must be distinct');
  }
  return inputs;
}

export function pairMultiHopScenarios(
  inputs: readonly LabScenarioInput[],
  oracles: readonly LabScenarioOracle[],
  split: 'dev' | 'holdout',
): readonly LabScenario[] {
  if (inputs.length !== MULTIHOP_PROBES_PER_SPLIT || oracles.length !== inputs.length) {
    throw new Error(`${split} requires exactly ${MULTIHOP_PROBES_PER_SPLIT} input/oracle pairs`);
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
    if (!required || required.length !== 2 || new Set(required).size !== required.length) {
      throw new Error(`${input.id}: requires exactly two distinct required hop IDs`);
    }
    const corpusIds = new Set(input.memories.map(({ id }) => id));
    if (!required.every((id) => corpusIds.has(id))) throw new Error(`${input.id}: required hop is absent from corpus`);
    return scenario;
  });
}

/** Loads both physical splits through adapter access; scorer artifacts are not read or hashed. */
export async function loadMultiHopScenarioInputs(repoRoot = DEFAULT_REPO_ROOT): Promise<readonly LabScenarioInput[]> {
  const records: unknown[] = [];
  for (const split of ['dev', 'holdout'] as const) {
    const registered = await descriptor(split, repoRoot, 'adapter');
    records.push(...await parseJsonLines(registered.inputArtifacts[0]!.path));
  }
  return validateMultiHopScenarioInputs(records);
}

/** Scorer-only route. It opens exactly one requested split's oracle after input-only validation. */
export async function loadMultiHopScenariosForScoring(
  split: 'dev' | 'holdout',
  repoRoot = DEFAULT_REPO_ROOT,
): Promise<readonly LabScenario[]> {
  const inputs = (await loadMultiHopScenarioInputs(repoRoot)).filter((input) => input.split === split);
  const registered = await descriptor(split, repoRoot, 'all');
  const oracles = await parseJsonLines(registered.oracleArtifacts[0]!.path) as LabScenarioOracle[];
  return pairMultiHopScenarios(inputs, oracles, split);
}
