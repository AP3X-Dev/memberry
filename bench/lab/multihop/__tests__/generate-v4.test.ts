// RET-007 v4 — knob-to-bytes custody for ALL FOUR splits plus the C1/C2/C3
// generator invariants, each with a bite test (spec "Tests (RED first, D2)" #1).

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { LabScenarioInput, LabScenarioOracle } from '../../contracts/scenario.js';
import { validateMultiHopV4ScenarioInputs } from '../../datasets/load-multihop-v4.js';
import {
  MULTIHOP_V4_DOMAINS,
  MULTIHOP_V4_NAME_POOL,
  MULTIHOP_V4_QUERY_FORMS,
  assertMultiHopV4ScenarioInvariants,
  generateMultiHopV4Split,
  multiHopV4OrderKey,
  multiHopV4Tokenize,
  planMultiHopV4Splits,
  type MultiHopV4InvariantInput,
} from '../generate-v4.js';
import {
  MULTIHOP_V4_BATTERY,
  MULTIHOP_V4_CELL_COUNTS,
  MULTIHOP_V4_DENSITIES,
  MULTIHOP_V4_FAMILIES,
  MULTIHOP_V4_FREEZE,
  MULTIHOP_V4_FUNNEL_TOP_N,
  MULTIHOP_V4_KNOBS,
  MULTIHOP_V4_KNOB_BOUNDS,
  MULTIHOP_V4_PROBES,
  MULTIHOP_V4_SPLITS,
  validateMultiHopV4Knobs,
  type MultiHopV4Knobs,
} from '../policy-v4.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const DATASET_ROOT = resolve(REPO_ROOT, 'bench', 'lab', 'datasets', 'multihop', 'v4');
const HOP1 = /^(.+?) (is warehoused at|is rostered to|is fitted inside|is safeguarded by|is serviced by) (.+?)\.$/;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function knobs(overrides: Partial<{
  corpusSizePerScenario: number;
  bridgeTokenCollisions: Record<'low' | 'medium' | 'high', number>;
  domainLexicalOverlapShare: Record<'low' | 'medium' | 'high', number>;
  factTokenEcho: Record<'low' | 'medium' | 'high', number>;
}>): MultiHopV4Knobs {
  return { ...structuredClone(MULTIHOP_V4_KNOBS), ...overrides } as MultiHopV4Knobs;
}

function parseLines<T>(text: string): T[] {
  return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as T);
}

function lastName(phrase: string): string {
  const names = phrase.match(/\b[A-Z][A-Za-z']*\b/g)!;
  return names[names.length - 1]!;
}

/** Rebuilds the invariant input for a generated scenario from its bytes (A/B via the oracle). */
function invariantInput(input: LabScenarioInput, oracle: LabScenarioOracle): MultiHopV4InvariantInput {
  const [aId, bId] = oracle.probes[0]!.required as [string, string];
  const a = input.memories.find(({ id }) => id === aId)!.content;
  const b = input.memories.find(({ id }) => id === bId)!.content;
  const hop1 = a.match(HOP1)!;
  const subjectName = lastName(hop1[1]!);
  const aBridge = lastName(hop1[3]!);
  const domainTag = input.tags!.find((tag) => tag.startsWith('domain:'))!.slice('domain:'.length);
  const domain = MULTIHOP_V4_DOMAINS.find(({ tag }) => tag === domainTag)!;
  // B starts with "<Btype> <bridge>"; the answer is the last name of B.
  const bTokens = b.replace(/\.$/, '').split(' ');
  const bridgeName = bTokens[2]!;
  const answerName = lastName(b.replace(/\.$/, ''));
  const twin = (input.split as string) === 'twin';
  return {
    query: input.queries[0]!.query,
    memories: input.memories.map(({ id, content }) => ({ id, content })),
    required: [aId, bId],
    subjectName,
    bridgeName,
    answerName,
    answerType: domain.answerType,
    ...(twin ? { twinBridgeName: aBridge } : {}),
  };
}

describe('RET-007 v4 deterministic committed generator', () => {
  it('re-emits ALL FOUR committed splits byte-identically from the frozen knobs', async () => {
    for (const split of MULTIHOP_V4_SPLITS) {
      const generated = generateMultiHopV4Split(split, MULTIHOP_V4_KNOBS);
      const committedInput = await readFile(resolve(DATASET_ROOT, split, 'input.jsonl'), 'utf8');
      const committedOracle = await readFile(resolve(DATASET_ROOT, split, 'oracle.jsonl'), 'utf8');
      expect(generated.input, `${split} input bytes`).toBe(committedInput);
      expect(generated.oracle, `${split} oracle bytes`).toBe(committedOracle);
    }
  });

  it('binds the frozen artifact hashes and sizes of all four splits to the committed bytes', async () => {
    for (const split of MULTIHOP_V4_SPLITS) {
      for (const role of ['input', 'oracle'] as const) {
        const bytes = await readFile(resolve(DATASET_ROOT, split, `${role}.jsonl`), 'utf8');
        expect(sha256(bytes)).toBe(MULTIHOP_V4_FREEZE.artifacts[split][role].sha256);
        expect(Buffer.byteLength(bytes, 'utf8')).toBe(MULTIHOP_V4_FREEZE.artifacts[split][role].sizeBytes);
      }
    }
    expect(sha256(MULTIHOP_V4_FREEZE.publicOrderSeed)).toBe(MULTIHOP_V4_FREEZE.seedCommitmentSha256);
    expect(MULTIHOP_V4_FREEZE.funnelTopN).toBe(MULTIHOP_V4_FUNNEL_TOP_N);
    expect(MULTIHOP_V4_FUNNEL_TOP_N).toBe(12);
  });

  it('is deterministic across repeated in-process emissions', () => {
    for (const split of MULTIHOP_V4_SPLITS) {
      const first = generateMultiHopV4Split(split, MULTIHOP_V4_KNOBS);
      const second = generateMultiHopV4Split(split, MULTIHOP_V4_KNOBS);
      expect(second.input).toBe(first.input);
      expect(second.oracle).toBe(first.oracle);
    }
  });

  it('rejects knob values outside the pre-registered bounds (corpus < 14 rejected; clone max 1)', () => {
    expect(() => validateMultiHopV4Knobs(MULTIHOP_V4_KNOBS)).not.toThrow();
    expect(() => generateMultiHopV4Split('calib', knobs({ corpusSizePerScenario: 13 })))
      .toThrow(/corpusSizePerScenario is outside/);
    expect(() => generateMultiHopV4Split('calib', knobs({ corpusSizePerScenario: 25 })))
      .toThrow(/corpusSizePerScenario is outside/);
    expect(() => generateMultiHopV4Split('calib', knobs({ bridgeTokenCollisions: { low: 0, medium: 1, high: 2 } })))
      .toThrow(/bridgeTokenCollisions\.high is outside/);
    expect(() => generateMultiHopV4Split('calib', knobs({ factTokenEcho: { low: 0, medium: 0, high: 5 } })))
      .toThrow(/factTokenEcho\.high is outside/);
    expect(() => generateMultiHopV4Split('calib', knobs({ domainLexicalOverlapShare: { low: 0.8, medium: 0.85, high: 1.1 } })))
      .toThrow(/domainLexicalOverlapShare\.high is outside/);
    expect(MULTIHOP_V4_KNOB_BOUNDS.corpusSizePerScenario).toEqual({ min: 14, max: 24 });
    expect(MULTIHOP_V4_KNOB_BOUNDS.bridgeTokenCollisions).toEqual({
      low: { min: 0, max: 1 }, medium: { min: 0, max: 1 }, high: { min: 0, max: 1 },
    });
    expect(MULTIHOP_V4_KNOB_BOUNDS.factTokenEcho).toEqual({
      low: { min: 0, max: 2 }, medium: { min: 0, max: 2 }, high: { min: 0, max: 4 },
    });
    expect(MULTIHOP_V4_KNOBS.corpusSizePerScenario).toBeGreaterThan(MULTIHOP_V4_FUNNEL_TOP_N);
  });

  it('fills every (family x density) cell to its pre-registered count in every split', () => {
    const plans = planMultiHopV4Splits(MULTIHOP_V4_KNOBS);
    for (const split of MULTIHOP_V4_SPLITS) {
      expect(plans[split]).toHaveLength(MULTIHOP_V4_PROBES[split]);
      for (const density of MULTIHOP_V4_DENSITIES) {
        MULTIHOP_V4_FAMILIES.forEach((family, position) => {
          const count = plans[split].filter((plan) => plan.density === density && plan.family === family).length;
          expect(count, `${split}/${density}/${family}`).toBe(MULTIHOP_V4_CELL_COUNTS[split][density][position]);
        });
      }
    }
  });

  it('draws the query form independently of the domain from ONE shared pool', () => {
    const plans = Object.values(planMultiHopV4Splits(MULTIHOP_V4_KNOBS)).flat();
    expect(plans).toHaveLength(235);
    expect(MULTIHOP_V4_DOMAINS).toHaveLength(28);
    expect(MULTIHOP_V4_QUERY_FORMS).toHaveLength(28);
    const formsPerDomain = new Map<number, Set<number>>();
    const domainsPerForm = new Map<number, Set<number>>();
    for (const plan of plans) {
      formsPerDomain.set(plan.domainIndex, (formsPerDomain.get(plan.domainIndex) ?? new Set()).add(plan.formIndex));
      domainsPerForm.set(plan.formIndex, (domainsPerForm.get(plan.formIndex) ?? new Set()).add(plan.domainIndex));
    }
    // v3 bound form = QUERY_FORMS[group] 1:1 with the domain; v4 must not.
    expect(formsPerDomain.size).toBe(28);
    expect(domainsPerForm.size).toBe(28);
    expect([...formsPerDomain.values()].every((forms) => forms.size >= 3)).toBe(true);
    expect([...domainsPerForm.values()].every((domains) => domains.size >= 3)).toBe(true);
    // Every split reaches the whole pool (no per-split domain blocks).
    for (const split of MULTIHOP_V4_SPLITS) {
      const domains = new Set(planMultiHopV4Splits(MULTIHOP_V4_KNOBS)[split].map((plan) => plan.domainIndex));
      expect(domains.size).toBeGreaterThanOrEqual(MULTIHOP_V4_BATTERY[split].minDistinct);
    }
  });

  it('keeps (domain, family, query-form) triples globally unique and proper-name draws disjoint across all 235 scenarios', () => {
    const inputs = MULTIHOP_V4_SPLITS.flatMap((split) => parseLines<LabScenarioInput>(generateMultiHopV4Split(split).input));
    expect(inputs).toHaveLength(235);
    const triples = new Set<string>();
    const nameOwner = new Map<string, string>();
    const pool = new Set(MULTIHOP_V4_NAME_POOL.map((name) => name.toLowerCase()));
    for (const input of inputs) {
      const tag = (prefix: string) => input.tags!.find((value) => value.startsWith(prefix))!;
      const triple = `${tag('domain:')}|${tag('family:')}|${tag('query-form:')}`;
      expect(triples.has(triple), triple).toBe(false);
      triples.add(triple);
      const text = `${input.queries[0]!.query} ${input.memories.map(({ content }) => content).join(' ')}`;
      for (const token of new Set(multiHopV4Tokenize(text))) {
        if (!pool.has(token)) continue;
        const owner = nameOwner.get(token);
        expect(owner === undefined || owner === input.id, `${token} appears in ${owner} and ${input.id}`).toBe(true);
        nameOwner.set(token, input.id);
      }
    }
    expect(nameOwner.size).toBeGreaterThan(235 * 6);
  });

  it('satisfies C1/C2/C3 on every committed scenario and the invariants BITE when violated', () => {
    const scenarios = MULTIHOP_V4_SPLITS.flatMap((split) => {
      const generated = generateMultiHopV4Split(split);
      const inputs = parseLines<LabScenarioInput>(generated.input);
      const oracles = parseLines<LabScenarioOracle>(generated.oracle);
      return inputs.map((input, index) => ({ input, oracle: oracles[index]! }));
    });
    for (const { input, oracle } of scenarios) {
      expect(() => assertMultiHopV4ScenarioInvariants(invariantInput(input, oracle), input.id)).not.toThrow();
    }
    const base = invariantInput(scenarios[0]!.input, scenarios[0]!.oracle);
    const domainTag = scenarios[0]!.input.tags!.find((tag) => tag.startsWith('domain:'))!.slice('domain:'.length);
    const domain = MULTIHOP_V4_DOMAINS.find(({ tag }) => tag === domainTag)!;
    const withMemory = (content: string): MultiHopV4InvariantInput => ({
      ...base, memories: [...base.memories, { id: 'm4-bite000000000000000000', content }],
    });
    // C2 (i): one memory naming both X and Z.
    expect(() => assertMultiHopV4ScenarioInvariants(withMemory(`Note: ${base.subjectName} met ${base.answerName}.`)))
      .toThrow(/C2\(i\)/);
    // C2 (ii): an exact extra bridge mention.
    expect(() => assertMultiHopV4ScenarioInvariants(withMemory(`Bulletin mentions ${base.bridgeName} again.`)))
      .toThrow(/C2\(ii\)/);
    // C1: one prefix/suffix clone is allowed, two are not.
    const oneClone = withMemory(`Alert for post ${base.bridgeName}-07 today.`);
    const cloneCount = oneClone.memories.filter(({ content }) => new RegExp(`\\b${base.bridgeName}-\\d{2}\\b`).test(content)).length;
    if (cloneCount <= 1) expect(() => assertMultiHopV4ScenarioInvariants(oneClone)).not.toThrow();
    expect(() => assertMultiHopV4ScenarioInvariants({
      ...oneClone, memories: [...oneClone.memories, { id: 'm4-bite000000000000000001', content: `Alert for post ${base.bridgeName}-08 today.` }],
    })).toThrow(/C1 more than one bridge clone/);
    // C2 (iii): the probe must be X-only.
    expect(() => assertMultiHopV4ScenarioInvariants({ ...base, query: `${base.query} ${base.bridgeName}` })).toThrow(/C2\(iii\) probe names the bridge/);
    expect(() => assertMultiHopV4ScenarioInvariants({ ...base, query: `${base.query} ${base.answerName}` })).toThrow(/C2\(iii\) probe names the answer/);
    expect(() => assertMultiHopV4ScenarioInvariants({ ...base, query: `${base.query} ${domain.answerType}` })).toThrow(/C2\(iii\) probe names the answer type/);
    expect(() => assertMultiHopV4ScenarioInvariants({ ...base, query: base.query.replace(base.subjectName, 'Nobody') })).toThrow(/C2\(iii\) probe must name the subject/);
    // C2 (iv): a distractor that lexically mirrors the probe leaves the band.
    expect(() => assertMultiHopV4ScenarioInvariants(withMemory(base.query))).toThrow(/C2\(iv\)/);
    // C3: twin — A must carry the fresh name and B the original bridge.
    const twin = scenarios.find(({ input }) => (input.split as string) === 'twin')!;
    const twinBase = invariantInput(twin.input, twin.oracle);
    expect(twinBase.twinBridgeName).toBeDefined();
    expect(() => assertMultiHopV4ScenarioInvariants(twinBase)).not.toThrow();
    expect(() => assertMultiHopV4ScenarioInvariants({
      ...twinBase, memories: [...twinBase.memories, { id: 'm4-bite000000000000000002', content: `Another line about ${twinBase.twinBridgeName}.` }],
    })).toThrow(/C3 twin bridge name must appear in A only/);
    const repaired = twinBase.memories.map((memory) => (memory.id === twinBase.required[0]
      ? { ...memory, content: memory.content.replace(twinBase.twinBridgeName!, twinBase.bridgeName) } : memory));
    expect(() => assertMultiHopV4ScenarioInvariants({ ...twinBase, memories: repaired })).toThrow(/C2\(ii\)|C3/);
  });

  it('C3: every twin keeps B intact, severs the bridge in A, and leaves the required ids unchanged', () => {
    const generated = generateMultiHopV4Split('twin');
    const inputs = parseLines<LabScenarioInput>(generated.input);
    const oracles = parseLines<LabScenarioOracle>(generated.oracle);
    expect(inputs).toHaveLength(30);
    inputs.forEach((input, index) => {
      const oracle = oracles[index]!;
      const [aId, bId] = oracle.probes[0]!.required!;
      expect(oracle.probes[0]!.required).toHaveLength(2);
      expect(oracle.probes[0]!.relevant).toEqual(oracle.probes[0]!.required);
      const a = input.memories.find(({ id }) => id === aId)!.content;
      const b = input.memories.find(({ id }) => id === bId)!.content;
      const bridgeInB = b.replace(/\.$/, '').split(' ')[2]!;
      const bridgeInA = lastName(a.match(HOP1)![3]!);
      expect(bridgeInA).not.toBe(bridgeInB);
      expect(a).not.toContain(bridgeInB);
      expect(input.memories.filter(({ content }) => new RegExp(`(?:^|[^A-Za-z0-9-])${bridgeInA}(?![A-Za-z0-9-])`).test(content))).toHaveLength(1);
      expect(input.split).toBe('twin');
      expect(input.id).toMatch(/^mh4-t-\d{2}$/);
    });
  });

  it('emits scenarios that pass the full v4 loader lint battery and the frozen order derivation', () => {
    const inputs = MULTIHOP_V4_SPLITS.flatMap((split) => parseLines<LabScenarioInput>(generateMultiHopV4Split(split, MULTIHOP_V4_KNOBS).input));
    const validated = validateMultiHopV4ScenarioInputs(inputs);
    expect(validated).toHaveLength(235);
    for (const input of validated.slice(0, 3)) {
      const keys = [...input.memories]
        .sort((left, right) => (multiHopV4OrderKey(input.id, left.id) < multiHopV4OrderKey(input.id, right.id) ? -1 : 1))
        .map(({ id }) => id);
      expect(input.memories.map(({ id }) => id)).toEqual(keys);
    }
  });

  it('never consults ambient nondeterminism in the generator or adapter source', async () => {
    for (const path of ['bench/lab/multihop/generate-v4.ts', 'bench/lab/adapters/memberry-retrieval-core-funnel.ts']) {
      const source = await readFile(resolve(REPO_ROOT, path), 'utf8');
      expect(source).not.toMatch(/Math\.random\(|Date\.now\(|new Date\(/);
      expect(source).not.toMatch(/process\.env/);
    }
  });
});
