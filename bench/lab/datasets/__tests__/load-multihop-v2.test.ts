import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { LabScenario, LabScenarioInput, LabScenarioOracle } from '../../contracts/scenario.js';
import {
  MULTIHOP_V2_DATASET_IDS,
  loadMultiHopV2ScenarioInputs,
  loadMultiHopV2ScenariosForScoring,
  pairMultiHopV2Scenarios,
  validateMultiHopV2ScenarioInputs,
} from '../load-multihop-v2.js';
import {
  MULTIHOP_V2_DENSITY_COUNTS,
  MULTIHOP_V2_FREEZE,
  MULTIHOP_V2_K,
  MULTIHOP_V2_PROBES_PER_SPLIT,
} from '../../multihop/policy-v2.js';
import { auditAdapterDependencies } from '../../registered-adapters.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const FROZEN_V2_CHANGE_POLICY = 'Any byte, order, label, policy, or scorer change requires additive multihop/v3 artifacts and independent review.';
const FROZEN_V2_ARTIFACTS = Object.freeze([
  { repositoryPath: 'bench/lab/datasets/multihop/v2/dev/input.jsonl', sha256: '7ea7b54899bf5e99905487d71da503667425ecff85aaa2d2c954640aa708d7d0', sizeBytes: 84500 },
  { repositoryPath: 'bench/lab/datasets/multihop/v2/dev/oracle.jsonl', sha256: '25f9969a48ea4f30561e5bbd857aab10c3cb87422295842006e427dcbac70d64', sizeBytes: 4860 },
  { repositoryPath: 'bench/lab/datasets/multihop/v2/holdout/input.jsonl', sha256: 'c4484005b4e0349da4018ec2ab6a4e3278fdbde3a964eb9fedad4f5ca1a68bc1', sizeBytes: 84238 },
  { repositoryPath: 'bench/lab/datasets/multihop/v2/holdout/oracle.jsonl', sha256: '58a68db01cf237e0153c5055bab172483c4cb5e66363bfa3c721b2d45214cfb1', sizeBytes: 4860 },
] as const);
const ORDER_SEED = 'memberry-lab013-v2-order-2026-08-20';
const ROLE_LEAK = /(?:^|[-_])(a|b|required|relevant|hop-?1|hop-?2)(?:$|[-_])/i;

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function tag(input: LabScenarioInput, prefix: string): string {
  return input.tags!.find((value) => value.startsWith(prefix))!;
}

function lexicalSkeleton(value: string): string {
  return value.normalize('NFKC').replace(/\b[A-Z][A-Za-z0-9'-]*\b/g, '<slot>')
    .replace(/\b\d+(?::\d+)?\b/g, '<slot>').toLowerCase().replace(/\s+/g, ' ').trim();
}

function independentOrderKey(scenarioId: string, neutralSlotId: string): string {
  return sha256(`${ORDER_SEED}\n${scenarioId}\n${neutralSlotId}`);
}

function independentOrdinalCompare(left: string, right: string): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}

function firstHop(value: string): { subject: string; bridge: string } | undefined {
  const match = value.match(/^(.*?) (?:is stored at|is assigned to|contains|is entrusted to|is maintained by) (.*?)\.$/);
  return match ? { subject: match[1]!.toLowerCase(), bridge: match[2]!.toLowerCase() } : undefined;
}

function secondHopAnswer(value: string, bridge: string, family: string): string | undefined {
  const escapedBridge = bridge.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns: Record<string, RegExp> = {
    routing: new RegExp(`^${escapedBridge} sends .+ to (.+)\\.$`, 'i'),
    assignment: new RegExp(`^${escapedBridge} starts .+ at (.+)\\.$`, 'i'),
    component: new RegExp(`^${escapedBridge} requires (.+) for .+\\.$`, 'i'),
    custody: new RegExp(`^${escapedBridge} requires (.+) for .+\\.$`, 'i'),
    maintenance: new RegExp(`^${escapedBridge} files .+ at (.+)\\.$`, 'i'),
  };
  return value.match(patterns[family]!)?.[1]?.toLowerCase();
}

function parseChain(scenario: LabScenario): { subject: string; bridge: string; answer: string } {
  const required = scenario.oracle.probes[0]!.required!.map((id) => (
    scenario.input.memories.find((memory) => memory.id === id)!.content
  ));
  const first = required.find((content) => (
    / (?:is stored at|is assigned to|contains|is entrusted to|is maintained by) /.test(content)
  ));
  assert.ok(first, `${scenario.input.id}: first hop`);
  const firstMatch = firstHop(first);
  assert.ok(firstMatch, `${scenario.input.id}: first-hop grammar`);
  const { subject, bridge } = firstMatch;
  const second = required.find((content) => content !== first);
  assert.ok(second, `${scenario.input.id}: second hop`);
  const family = tag(scenario.input, 'family:').slice('family:'.length);
  const answer = secondHopAnswer(second, bridge, family);
  assert.ok(answer, `${scenario.input.id}: second-hop bridge continuity`);
  return { subject, bridge, answer };
}

describe('LAB-013 frozen candidate-blind multi-hop v2 datasets', () => {
  it('anchors canonical raw-LF/no-BOM v2 bytes independently of registry edits', async () => {
    expect(sha256(ORDER_SEED)).toBe(MULTIHOP_V2_FREEZE.seedCommitmentSha256);
    expect(MULTIHOP_V2_FREEZE.orderKeyDerivation).toBe('sha256-utf8(seed+LF+scenario_id+LF+neutral_slot_id)');
    const registry = JSON.parse(await readFile(resolve(REPO_ROOT, 'bench/lab/registry/datasets.json'), 'utf8')) as {
      datasets: Array<{ artifacts: Array<{ repositoryPath: string; sha256: string; sizeBytes: number }> }>;
    };
    const registered = registry.datasets.flatMap(({ artifacts }) => artifacts);
    for (const frozen of FROZEN_V2_ARTIFACTS) {
      const bytes = await readFile(resolve(REPO_ROOT, frozen.repositoryPath));
      expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
      expect(bytes.includes(Buffer.from('\r\n'))).toBe(false);
      expect({ sha256: sha256(bytes), sizeBytes: bytes.byteLength }).toEqual({
        sha256: frozen.sha256, sizeBytes: frozen.sizeBytes,
      });
      expect(registered.find(({ repositoryPath }) => repositoryPath === frozen.repositoryPath))
        .toMatchObject({ sha256: frozen.sha256, sizeBytes: frozen.sizeBytes });
    }
    expect(FROZEN_V2_CHANGE_POLICY).toMatch(/additive multihop\/v3/);
  });

  it('loads exactly 20+20 probes with k=10, 24 opaque memories, and two scorer-only hops', async () => {
    expect(MULTIHOP_V2_DATASET_IDS).toEqual({
      dev: 'memberry-multihop-v2-dev', holdout: 'memberry-multihop-v2-holdout',
    });
    const inputs = await loadMultiHopV2ScenarioInputs(REPO_ROOT);
    expect(inputs).toHaveLength(40);
    const allMemoryIds = new Set<string>();
    for (const split of ['dev', 'holdout'] as const) {
      const selected = inputs.filter((input) => input.split === split);
      expect(selected).toHaveLength(MULTIHOP_V2_PROBES_PER_SPLIT);
      expect(selected).toHaveLength(20);
      for (const input of selected) {
        expect(input.dimensions).toEqual(['multi-hop']);
        expect(input.queries).toHaveLength(1);
        expect(input.queries[0]!.limit).toBe(MULTIHOP_V2_K);
        expect(input.memories).toHaveLength(24);
        expect(input.tags).toHaveLength(6);
        expect(input.tags).toEqual(expect.arrayContaining(['synthetic', 'lab-013-candidate-blind-v2']));
        expect(input.queries[0]!.id).toMatch(/^p2-[0-9a-f]{24}$/);
        expect(input.queries[0]!.id).not.toMatch(ROLE_LEAK);
        for (const memory of input.memories) {
          expect(memory.id).toMatch(/^m2-[0-9a-f]{24}$/);
          expect(memory.id).not.toMatch(ROLE_LEAK);
          expect(allMemoryIds.has(memory.id)).toBe(false);
          allMemoryIds.add(memory.id);
        }
      }
      const scenarios = await loadMultiHopV2ScenariosForScoring(split, REPO_ROOT);
      expect(scenarios).toHaveLength(20);
      for (const { input, oracle } of scenarios) {
        expect(oracle.probes).toHaveLength(1);
        const required = oracle.probes[0]!.required!;
        expect(required).toHaveLength(2);
        expect(new Set(required).size).toBe(2);
        expect(new Set(oracle.probes[0]!.relevant)).toEqual(new Set(required));
        expect(required.every((id) => input.memories.some((memory) => memory.id === id))).toBe(true);
      }
    }
    expect(allMemoryIds.size).toBe(40 * 24);
  });

  it('independently recomputes seed-only corpus order and rejects any order mutation', async () => {
    const inputs = await loadMultiHopV2ScenarioInputs(REPO_ROOT);
    for (const input of inputs) {
      const expected = [...input.memories].sort((left, right) => (
        independentOrdinalCompare(independentOrderKey(input.id, left.id), independentOrderKey(input.id, right.id))
          || independentOrdinalCompare(left.id, right.id)
      ));
      expect(input.memories.map(({ id }) => id)).toEqual(expected.map(({ id }) => id));
    }
    const reordered = structuredClone(inputs) as LabScenarioInput[];
    reordered[0]!.memories = [...reordered[0]!.memories].reverse();
    expect(() => validateMultiHopV2ScenarioInputs(reordered)).toThrow(/frozen public seed derivation/);

    const contentMutation = structuredClone(inputs) as LabScenarioInput[];
    contentMutation[0]!.memories[0]!.content += ' Content does not participate in ordering.';
    expect(() => validateMultiHopV2ScenarioInputs(contentMutation)).not.toThrow();

    const loaderSource = await readFile(resolve(REPO_ROOT, 'bench/lab/datasets/load-multihop-v2.ts'), 'utf8');
    expect(loaderSource).toContain('function ordinalCompare(left: string, right: string)');
    expect(loaderSource).not.toContain('localeCompare');
  });

  it('enforces five relation families, 10+ domains/forms/skeletons, disjoint splits, and frozen density strata', async () => {
    const inputs = await loadMultiHopV2ScenarioInputs(REPO_ROOT);
    const sets = Object.fromEntries(['dev', 'holdout'].map((split) => {
      const selected = inputs.filter((input) => input.split === split);
      const values = (prefix: string) => selected.map((input) => tag(input, prefix));
      const familyCounts = new Map<string, number>();
      const densityCounts = new Map<string, number>();
      for (const family of values('family:')) familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
      for (const density of values('density:')) densityCounts.set(density, (densityCounts.get(density) ?? 0) + 1);
      expect(new Set(values('domain:')).size).toBeGreaterThanOrEqual(10);
      expect(new Set(values('query-form:')).size).toBeGreaterThanOrEqual(10);
      expect(new Set(selected.map((input) => lexicalSkeleton(input.queries[0]!.query))).size).toBeGreaterThanOrEqual(10);
      expect([...familyCounts.values()]).toEqual([4, 4, 4, 4, 4]);
      expect(Object.fromEntries([...densityCounts].map(([key, value]) => [key.slice('density:'.length), value])))
        .toEqual(MULTIHOP_V2_DENSITY_COUNTS);
      return [split, {
        domains: new Set(values('domain:')), forms: new Set(values('query-form:')),
        skeletons: new Set(selected.map((input) => lexicalSkeleton(input.queries[0]!.query))),
      }] as const;
    })) as Record<'dev' | 'holdout', { domains: Set<string>; forms: Set<string>; skeletons: Set<string> }>;
    expect([...sets.dev.domains].some((value) => sets.holdout.domains.has(value))).toBe(false);
    expect([...sets.dev.forms].some((value) => sets.holdout.forms.has(value))).toBe(false);
    expect([...sets.dev.skeletons].some((value) => sets.holdout.skeletons.has(value))).toBe(false);
  });

  it('audits genuine two-hop chains plus natural single-hop competitors and alternative bridges', async () => {
    const scenarios = [
      ...await loadMultiHopV2ScenariosForScoring('dev', REPO_ROOT),
      ...await loadMultiHopV2ScenariosForScoring('holdout', REPO_ROOT),
    ];
    const expectedCompetitors = { low: 4, medium: 8, high: 12 } as const;
    for (const scenario of scenarios) {
      const { subject, bridge, answer } = parseChain(scenario);
      const family = tag(scenario.input, 'family:').slice('family:'.length);
      const query = scenario.input.queries[0]!.query.toLowerCase();
      expect(query).toContain(subject);
      expect(query).not.toContain(answer);
      const required = new Set(scenario.oracle.probes[0]!.required!);
      const distractors = scenario.input.memories.filter(({ id }) => !required.has(id));
      for (const { content } of distractors) {
        const text = content.toLowerCase();
        expect(text.includes(subject) && text.includes(bridge)).toBe(false);
        expect(text.includes(bridge) && text.includes(answer)).toBe(false);
      }
      const anchorCompetitors = distractors.filter(({ content }) => {
        const text = content.toLowerCase();
        return text.includes(subject) || text.includes(bridge) || text.includes(answer);
      });
      const alternativeChainMembers = new Set<string>();
      for (const first of distractors) {
        const alternative = firstHop(first.content);
        if (!alternative) continue;
        const second = distractors.find((candidate) => (
          candidate !== first && secondHopAnswer(candidate.content, alternative.bridge, family) !== undefined
        ));
        if (second) {
          alternativeChainMembers.add(first.content);
          alternativeChainMembers.add(second.content);
        }
      }
      const competitorCount = new Set([
        ...anchorCompetitors.map(({ content }) => content), ...alternativeChainMembers,
      ]).size;
      const density = tag(scenario.input, 'density:').slice('density:'.length) as keyof typeof expectedCompetitors;
      expect(competitorCount).toBe(expectedCompetitors[density]);
      expect(alternativeChainMembers.size).toBeGreaterThanOrEqual(2);
      expect(alternativeChainMembers.size % 2).toBe(0);
    }
  });

  it('rejects adapter-visible labels, diversity mutations, and mismatched scorer custody pairs', async () => {
    const inputs = structuredClone(await loadMultiHopV2ScenarioInputs(REPO_ROOT)) as LabScenarioInput[];
    inputs[0]!.memories[0]!.metadata = { nested: { required: ['hidden'] } };
    expect(() => validateMultiHopV2ScenarioInputs(inputs)).toThrow(/oracle-shaped key.*required/);

    const uppercase = structuredClone(await loadMultiHopV2ScenarioInputs(REPO_ROOT)) as LabScenarioInput[];
    uppercase[0]!.memories[0]!.metadata = { nested: { REQUIRED: ['hidden'] } };
    expect(() => validateMultiHopV2ScenarioInputs(uppercase)).toThrow(/oracle-shaped key.*REQUIRED/);

    const diversity = structuredClone(await loadMultiHopV2ScenarioInputs(REPO_ROOT)) as LabScenarioInput[];
    const domain = tag(diversity[0]!, 'domain:');
    for (const input of diversity.filter(({ split }) => split === 'dev').slice(0, 3)) {
      input.tags = input.tags!.map((value) => value.startsWith('domain:') ? domain : value);
    }
    expect(() => validateMultiHopV2ScenarioInputs(diversity)).toThrow(/domain diversity\/cap/);

    const scenarios = await loadMultiHopV2ScenariosForScoring('dev', REPO_ROOT);
    const oracles = scenarios.map(({ oracle }) => structuredClone(oracle)) as LabScenarioOracle[];
    oracles[0]!.scenarioId = 'wrong-oracle-id';
    expect(() => pairMultiHopV2Scenarios(scenarios.map(({ input }) => input), oracles, 'dev'))
      .toThrow(/oracle ID\/order mismatch/);
  });

  it('keeps v2 scorer custody out of public barrels, adapters, and production/package dependency paths', async () => {
    const barrel = await readFile(resolve(REPO_ROOT, 'bench/lab/index.ts'), 'utf8');
    expect(barrel).not.toMatch(/load-multihop-v2|scorer-only-v2/);
    const registry = JSON.parse(await readFile(resolve(REPO_ROOT, 'bench/lab/registry/systems.json'), 'utf8')) as {
      systems: Array<{ adapter: string }>;
    };
    const adapters = [...new Set(registry.systems.map(({ adapter }) => adapter)
      .filter((entry) => entry.startsWith('bench/lab/adapters/')))];
    for (const entry of adapters) {
      const audit = await auditAdapterDependencies(resolve(REPO_ROOT, entry), REPO_ROOT);
      expect(audit.visited.map((path) => path.replace(/\\/g, '/')).join('\n'))
        .not.toMatch(/\/datasets\/load-multihop-v2\.ts|\/multihop\/scorer-only-v2\.ts/);
    }
    for (const sourcePath of [
      'bench/lab/datasets/load-multihop-v2.ts', 'bench/lab/multihop/policy-v2.ts', 'bench/lab/multihop/scorer-only-v2.ts',
    ]) {
      const source = await readFile(resolve(REPO_ROOT, sourcePath), 'utf8');
      expect(source).not.toMatch(/from ['"][^'"]*(?:\/adapters\/|\/packages\/)/);
    }
  });

  it('makes a synthetic adapter import of scorer-only-v2 fail the existing transitive dependency audit', async () => {
    const scorerSource = await readFile(resolve(REPO_ROOT, 'bench/lab/multihop/scorer-only-v2.ts'), 'utf8');
    expect(scorerSource).toContain("import type { MultiHopV2ScoringScenario } from '../datasets/load-multihop-v2.js'");
    const temporary = await mkdtemp(resolve(REPO_ROOT, '.lab013-scorer-audit-'));
    const entry = resolve(temporary, 'synthetic-adapter.ts');
    try {
      await writeFile(entry, [
        "import { scoreMultiHopV2Comparison } from '../bench/lab/multihop/scorer-only-v2.js';",
        'export const prohibitedScorerImport = scoreMultiHopV2Comparison;',
        '',
      ].join('\n'), 'utf8');
      const audit = await auditAdapterDependencies(entry, REPO_ROOT);
      expect(audit.violations).toEqual(expect.arrayContaining([
        expect.stringMatching(/datasets\/load-multihop-v2\.ts: scorer-only path is forbidden to adapters/),
      ]));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it('keeps oracle access solely in the scorer-custodian route and ratchets exactly four v2 modules', async () => {
    const source = await readFile(resolve(REPO_ROOT, 'bench/lab/datasets/load-multihop-v2.ts'), 'utf8');
    const inputStart = source.indexOf('export async function loadMultiHopV2ScenarioInputs');
    const scoringStart = source.indexOf('export async function loadMultiHopV2ScenariosForScoring');
    assert.notEqual(inputStart, -1);
    assert.notEqual(scoringStart, -1);
    expect(source.slice(inputStart, scoringStart)).toContain('.inputArtifacts');
    expect(source.slice(inputStart, scoringStart)).not.toContain('.oracleArtifacts');
    expect(source.slice(scoringStart)).toContain('.oracleArtifacts');

    const pkg = JSON.parse(await readFile(resolve(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const command = pkg.scripts['bench:lab:typecheck'];
    assert.ok(command);
    for (const entry of [
      'bench/lab/datasets/load-multihop-v2.ts',
      'bench/lab/multihop/scorer-only-v2.ts',
      'bench/lab/multihop/policy-v2.ts',
      'bench/lab/multihop/qualify-control-v2.ts',
    ]) expect(command.split(/\s+/).filter((value) => value === entry)).toHaveLength(1);
  });
});
