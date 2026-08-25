// RET-007 v4 loader — the v3 validation battery re-keyed with the v4 constants.
// Declared divergences from v3 (per spec): FOUR physical splits (calib, dev,
// holdout, twin); the per-domain / per-form / per-lexical-skeleton caps are the
// pre-registered MULTIHOP_V4_BATTERY constants (cap = ceil(n/28) + 1) instead of
// v3's hardcoded `> 2` literals; the shared pool means splits are NOT
// domain-disjoint — disjointness is enforced at the (domain, family, query-form)
// triple level across ALL FOUR splits; calib AND twin are REFUSED by the
// qualification/comparison entry point (twin is readable only through its
// clearly named evidence entry point; calib only through the calibration one).

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LabScenario, LabScenarioInput, LabScenarioOracle } from '../contracts/scenario.js';
import { LAB_SCENARIO_VERSION, validateScenario } from '../contracts/scenario.js';
import {
  MULTIHOP_V4_BATTERY,
  MULTIHOP_V4_CORPUS_SIZE,
  MULTIHOP_V4_DENSITIES,
  MULTIHOP_V4_DENSITY_COUNTS,
  MULTIHOP_V4_FAMILIES,
  MULTIHOP_V4_FREEZE,
  MULTIHOP_V4_K,
  MULTIHOP_V4_PROBES,
  MULTIHOP_V4_SPLITS,
  type MultiHopV4Density,
  type MultiHopV4ScoredSplit,
  type MultiHopV4Split,
} from '../multihop/policy-v4.js';
import { loadRegisteredDatasetDescriptor, type RegisteredDatasetDescriptor } from './load-golden.js';

/** Scorer-custody type anchor: importing scorer-only-v4 transitively crosses the forbidden dataset boundary. */
export type MultiHopV4ScoringScenario = LabScenario;

export type { MultiHopV4Split };

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(HERE, '..', '..', '..');
const ORACLE_SHAPED_KEYS = new Set([
  'oracle', 'oracles', 'relevant', 'required', 'stale', 'forbidden', 'label', 'labels', 'expected', 'outcome', 'outcomes',
]);
const FAMILY_SET = new Set<string>(MULTIHOP_V4_FAMILIES);
const SPLIT_LETTERS = Object.freeze({ calib: 'c', dev: 'd', holdout: 'h', twin: 't' } as const);
const OPAQUE_MEMORY_ID = /^m4-[0-9a-f]{24}$/;
const OPAQUE_PROBE_ID = /^p4-[0-9a-f]{24}$/;
const ROLE_LEAK = /(?:^|[-_])(a|b|required|relevant|hop-?1|hop-?2|twin|broken)(?:$|[-_])/i;
const MIN_DISTINCT_OVERALL = 28;

export const MULTIHOP_V4_DATASET_IDS = Object.freeze({
  calib: 'memberry-multihop-v4-calib',
  dev: 'memberry-multihop-v4-dev',
  holdout: 'memberry-multihop-v4-holdout',
  twin: 'memberry-multihop-v4-twin',
} as const satisfies Record<MultiHopV4Split, string>);

async function descriptor(
  split: MultiHopV4Split,
  repoRoot: string,
  verifyAccess: 'adapter' | 'all',
): Promise<RegisteredDatasetDescriptor> {
  const value = await loadRegisteredDatasetDescriptor(MULTIHOP_V4_DATASET_IDS[split], repoRoot, verifyAccess);
  if (value.version !== MULTIHOP_V4_FREEZE.version) throw new Error(`${value.id} registry version mismatch: ${value.version}`);
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
export function multiHopV4OrderKey(scenarioId: string, neutralSlotId: string): string {
  return createHash('sha256')
    .update(`${MULTIHOP_V4_FREEZE.publicOrderSeed}\n${scenarioId}\n${neutralSlotId}`, 'utf8')
    .digest('hex');
}

function ordinalCompare(left: string, right: string): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertSeededCorpusOrder(input: LabScenarioInput): void {
  const expected = [...input.memories].sort((left, right) => (
    ordinalCompare(multiHopV4OrderKey(input.id, left.id), multiHopV4OrderKey(input.id, right.id))
      || ordinalCompare(left.id, right.id)
  ));
  if (expected.some((memory, index) => memory.id !== input.memories[index]!.id)) {
    throw new Error(`${input.id}: corpus order does not match frozen public seed derivation`);
  }
}

function splitOf(input: LabScenarioInput): MultiHopV4Split {
  const split: unknown = input.split;
  if (!MULTIHOP_V4_SPLITS.includes(split as MultiHopV4Split)) throw new Error(`${input.id}: invalid split`);
  return split as MultiHopV4Split;
}

/** Validates adapter-visible v4 bytes only; this route never accepts or opens an oracle. */
export function validateMultiHopV4ScenarioInputs(values: readonly unknown[]): readonly LabScenarioInput[] {
  const inputs = values.map(inputShape);
  const scenarioIds = new Set<string>();
  const memoryIds = new Set<string>();
  const probeIds = new Set<string>();
  for (const input of inputs) {
    if (input.version !== LAB_SCENARIO_VERSION) throw new Error(`${input.id}: unsupported scenario version`);
    if (scenarioIds.has(input.id)) throw new Error(`duplicate scenario id: ${input.id}`);
    scenarioIds.add(input.id);
    const split = splitOf(input);
    const width = String(MULTIHOP_V4_PROBES[split]).length;
    if (!new RegExp(`^mh4-${SPLIT_LETTERS[split]}-[0-9]{${width}}$`).test(input.id)) {
      throw new Error(`${input.id}: scenario ID/split mismatch`);
    }
    if (input.dimensions.length !== 1 || input.dimensions[0] !== 'multi-hop') throw new Error(`${input.id}: dimension must be multi-hop only`);
    if (input.queries.length !== 1) throw new Error(`${input.id}: requires exactly one query`);
    if (input.queries[0]!.limit !== MULTIHOP_V4_K) throw new Error(`${input.id}: k must be ${MULTIHOP_V4_K}`);
    if (!OPAQUE_PROBE_ID.test(input.queries[0]!.id) || ROLE_LEAK.test(input.queries[0]!.id)) throw new Error(`${input.id}: probe ID must be opaque and role-neutral`);
    if (probeIds.has(input.queries[0]!.id)) throw new Error(`${input.id}: duplicate probe ID`);
    probeIds.add(input.queries[0]!.id);
    if (input.memories.length !== MULTIHOP_V4_CORPUS_SIZE) {
      throw new Error(`${input.id}: requires exactly ${MULTIHOP_V4_CORPUS_SIZE} eligible memories`);
    }
    for (const memory of input.memories) {
      if (!OPAQUE_MEMORY_ID.test(memory.id) || ROLE_LEAK.test(memory.id)) throw new Error(`${input.id}: memory ID must be opaque and role-neutral`);
      if (memoryIds.has(memory.id)) throw new Error(`${input.id}: memory ID must be globally unique`);
      memoryIds.add(memory.id);
    }
    assertSeededCorpusOrder(input);
    if (input.tags?.length !== 6 || input.tags.filter((tag) => tag === 'synthetic').length !== 1
      || input.tags.filter((tag) => tag === 'lab-ret007-candidate-blind-v4').length !== 1) {
      throw new Error(`${input.id}: exactly six synthetic provenance and diversity tags are required`);
    }
    oneTag(input, 'domain:');
    const family = oneTag(input, 'family:').slice('family:'.length);
    if (!FAMILY_SET.has(family)) throw new Error(`${input.id}: unknown multi-hop relation family`);
    oneTag(input, 'query-form:');
    const density = oneTag(input, 'density:').slice('density:'.length);
    if (!MULTIHOP_V4_DENSITIES.includes(density as MultiHopV4Density)) throw new Error(`${input.id}: unknown distractor-density stratum`);
  }
  for (const split of MULTIHOP_V4_SPLITS) {
    const battery = MULTIHOP_V4_BATTERY[split];
    const selected = inputs.filter((input) => splitOf(input) === split);
    if (selected.length !== battery.probes) {
      throw new Error(`${split} requires exactly ${battery.probes} scenarios`);
    }
    const domains = counts(selected.map((input) => oneTag(input, 'domain:')));
    const forms = counts(selected.map((input) => oneTag(input, 'query-form:')));
    const families = counts(selected.map((input) => oneTag(input, 'family:').slice('family:'.length)));
    const densities = counts(selected.map((input) => oneTag(input, 'density:').slice('density:'.length)));
    if (domains.size < battery.minDistinct || [...domains.values()].some((count) => count > battery.cap)) throw new Error(`${split}: domain diversity/cap violated`);
    if (forms.size < battery.minDistinct || [...forms.values()].some((count) => count > battery.cap)) throw new Error(`${split}: query-form diversity/cap violated`);
    if (families.size !== FAMILY_SET.size
      || [...FAMILY_SET].some((family) => families.get(family) !== battery.familyCount)) {
      throw new Error(`${split}: relation-family matrix must contain each family ${battery.familyCount} times`);
    }
    for (const density of MULTIHOP_V4_DENSITIES) {
      if (densities.get(density) !== MULTIHOP_V4_DENSITY_COUNTS[split][density]) {
        throw new Error(`${split}: distractor-density matrix mismatch for ${density}`);
      }
    }
    const skeletons = counts(selected.map((input) => lexicalSkeleton(input.queries[0]!.query)));
    if (skeletons.size < battery.minDistinct || [...skeletons.values()].some((count) => count > battery.cap)) {
      throw new Error(`${split}: query lexical skeleton diversity/cap violated`);
    }
  }
  // Shared pool: (domain, family, query-form) triples are unique across ALL
  // FOUR splits, and the pool itself exposes >= 28 distinct domains, forms and
  // skeletons overall.
  const triples = new Set<string>();
  for (const input of inputs) {
    const triple = `${oneTag(input, 'domain:')}|${oneTag(input, 'family:')}|${oneTag(input, 'query-form:')}`;
    if (triples.has(triple)) throw new Error(`${input.id}: (domain, family, query-form) triple is not unique across splits`);
    triples.add(triple);
  }
  const overall = {
    domains: new Set(inputs.map((input) => oneTag(input, 'domain:'))),
    forms: new Set(inputs.map((input) => oneTag(input, 'query-form:'))),
    skeletons: new Set(inputs.map((input) => lexicalSkeleton(input.queries[0]!.query))),
  };
  for (const facet of ['domains', 'forms', 'skeletons'] as const) {
    if (overall[facet].size < MIN_DISTINCT_OVERALL) throw new Error(`v4 requires >= ${MIN_DISTINCT_OVERALL} distinct ${facet} overall`);
  }
  return inputs;
}

export function pairMultiHopV4Scenarios(
  inputs: readonly LabScenarioInput[],
  oracles: readonly LabScenarioOracle[],
  split: MultiHopV4Split,
): readonly LabScenario[] {
  const expected = MULTIHOP_V4_BATTERY[split].probes;
  if (inputs.length !== expected || oracles.length !== inputs.length) {
    throw new Error(`${split} requires exactly ${expected} input/oracle pairs`);
  }
  return inputs.map((input, index) => {
    const oracle = oracles[index];
    if (!oracle || oracle.scenarioId !== input.id) throw new Error(`${input.id}: oracle ID/order mismatch`);
    if (splitOf(input) !== split) throw new Error(`${input.id}: split mismatch`);
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

/** Loads all four physical splits through adapter access; scorer artifacts are neither read nor hashed. */
export async function loadMultiHopV4ScenarioInputs(repoRoot = DEFAULT_REPO_ROOT): Promise<readonly LabScenarioInput[]> {
  const records: unknown[] = [];
  for (const split of MULTIHOP_V4_SPLITS) {
    const registered = await descriptor(split, repoRoot, 'adapter');
    records.push(...await parseJsonLines(registered.inputArtifacts[0]!.path));
  }
  return validateMultiHopV4ScenarioInputs(records);
}

/**
 * Scorer-custodian route for QUALIFICATION and COMPARISON. It opens exactly one
 * requested dev/holdout oracle after input-only validation and REFUSES calib
 * (difficulty-tuning material) and twin (diagnostic material, never a verdict
 * term); neither may enter a receipt's verdict, gate, or capability claim.
 */
export async function loadMultiHopV4ScenariosForScoring(
  split: MultiHopV4ScoredSplit,
  repoRoot = DEFAULT_REPO_ROOT,
): Promise<readonly LabScenario[]> {
  if ((split as string) === 'calib') {
    throw new Error('multi-hop v4 calib split is refused by qualification/comparison entry points');
  }
  if ((split as string) === 'twin') {
    throw new Error('multi-hop v4 twin split is refused by qualification/comparison entry points');
  }
  if (split !== 'dev' && split !== 'holdout') throw new Error(`invalid scoring split: ${String(split)}`);
  const inputs = (await loadMultiHopV4ScenarioInputs(repoRoot)).filter((input) => input.split === split);
  const registered = await descriptor(split, repoRoot, 'all');
  const oracles = await parseJsonLines(registered.oracleArtifacts[0]!.path) as LabScenarioOracle[];
  return pairMultiHopV4Scenarios(inputs, oracles, split);
}

/**
 * CALIBRATION-ONLY loader for the public, disposable calib split. Never usable
 * as qualification or comparison evidence.
 */
export async function loadMultiHopV4CalibScenariosForCalibration(
  repoRoot = DEFAULT_REPO_ROOT,
): Promise<readonly LabScenario[]> {
  const inputs = (await loadMultiHopV4ScenarioInputs(repoRoot)).filter((input) => splitOf(input) === 'calib');
  const registered = await descriptor('calib', repoRoot, 'all');
  const oracles = await parseJsonLines(registered.oracleArtifacts[0]!.path) as LabScenarioOracle[];
  return pairMultiHopV4Scenarios(inputs, oracles, 'calib');
}

/**
 * EVIDENCE-ONLY loader for the broken-bridge twin split (C3). The twin is run
 * and its closed aggregate RECORDED in the D3 receipt, but it is never a verdict
 * term and never scored for a delta.
 */
export async function loadMultiHopV4TwinScenariosForEvidence(
  repoRoot = DEFAULT_REPO_ROOT,
): Promise<readonly LabScenario[]> {
  const inputs = (await loadMultiHopV4ScenarioInputs(repoRoot)).filter((input) => splitOf(input) === 'twin');
  const registered = await descriptor('twin', repoRoot, 'all');
  const oracles = await parseJsonLines(registered.oracleArtifacts[0]!.path) as LabScenarioOracle[];
  return pairMultiHopV4Scenarios(inputs, oracles, 'twin');
}
