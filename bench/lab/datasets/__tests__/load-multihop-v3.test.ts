import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { LabScenario, LabScenarioInput, LabScenarioOracle } from '../../contracts/scenario.js';
import {
  MULTIHOP_V3_DATASET_IDS,
  loadMultiHopV3CalibScenariosForCalibration,
  loadMultiHopV3ScenarioInputs,
  loadMultiHopV3ScenariosForScoring,
  pairMultiHopV3Scenarios,
  validateMultiHopV3ScenarioInputs,
} from '../load-multihop-v3.js';
import {
  MULTIHOP_V3_CALIB_DENSITY_COUNTS,
  MULTIHOP_V3_CALIB_PROBES,
  MULTIHOP_V3_CORPUS_SIZE,
  MULTIHOP_V3_DENSITY_COUNTS,
  MULTIHOP_V3_FREEZE,
  MULTIHOP_V3_K,
  MULTIHOP_V3_KNOBS,
  MULTIHOP_V3_PROBES_PER_SPLIT,
} from '../../multihop/policy-v3.js';
import { auditAdapterDependencies } from '../../registered-adapters.js';
import { validateDatasetRegistry } from '../../registry/validate.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const ORDER_SEED = 'memberry-ret007-v3-order-2026-08-25';
const ROLE_LEAK = /(?:^|[-_])(a|b|required|relevant|hop-?1|hop-?2)(?:$|[-_])/i;
const HOP1 = /^(.+?) (is warehoused at|is rostered to|is fitted inside|is safeguarded by|is serviced by) (.+?)\.$/;
const SPLITS = ['calib', 'dev', 'holdout'] as const;

/** Committed calib artifact bytes (audit anchor; dev/holdout anchor to MULTIHOP_V3_FREEZE). */
const FROZEN_CALIB_ARTIFACTS = Object.freeze([
  { repositoryPath: 'bench/lab/datasets/multihop/v3/calib/input.jsonl', sha256: '9f062b8ec854df8f1623b3270c65d3e3fba4d3150f7ea92e9214ae284d2a869e', sizeBytes: 45777 },
  { repositoryPath: 'bench/lab/datasets/multihop/v3/calib/oracle.jsonl', sha256: '1ea85351857769cf99bb4aed65cacc590949ddb4c49de785fa3f2bc4c9849e1c', sizeBytes: 3645 },
] as const);

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

function lastName(phrase: string): string {
  const names = phrase.match(/\b[A-Z][A-Za-z']*\b/g);
  assert.ok(names && names.length > 0, `no proper name in: ${phrase}`);
  return names[names.length - 1]!;
}

interface ParsedChain {
  subject: string;
  subjectName: string;
  bridge: string;
  bridgeName: string;
  answerName: string;
}

function parseChain(scenario: LabScenario): ParsedChain {
  const required = scenario.oracle.probes[0]!.required!;
  const contents = required.map((id) => scenario.input.memories.find((memory) => memory.id === id)!.content);
  const first = contents.find((content) => HOP1.test(content));
  assert.ok(first, `${scenario.input.id}: first hop grammar`);
  const match = first.match(HOP1)!;
  const subject = match[1]!;
  const bridge = match[3]!;
  const second = contents.find((content) => content !== first);
  assert.ok(second, `${scenario.input.id}: second hop`);
  assert.ok(second.toLowerCase().startsWith(bridge.toLowerCase()), `${scenario.input.id}: second-hop bridge continuity`);
  return {
    subject,
    subjectName: lastName(subject),
    bridge,
    bridgeName: lastName(bridge),
    answerName: lastName(second.replace(/\.$/, '')),
  };
}

async function allScoringScenarios(): Promise<LabScenario[]> {
  return [
    ...await loadMultiHopV3CalibScenariosForCalibration(REPO_ROOT),
    ...await loadMultiHopV3ScenariosForScoring('dev', REPO_ROOT),
    ...await loadMultiHopV3ScenariosForScoring('holdout', REPO_ROOT),
  ];
}

describe('RET-007 v3 frozen candidate-blind multi-hop datasets', () => {
  it('anchors canonical raw-LF/no-BOM v3 bytes and the three-way registry arity', async () => {
    expect(sha256(ORDER_SEED)).toBe(MULTIHOP_V3_FREEZE.seedCommitmentSha256);
    expect(MULTIHOP_V3_FREEZE.orderKeyDerivation).toBe('sha256-utf8(seed+LF+scenario_id+LF+neutral_slot_id)');
    const registry = JSON.parse(await readFile(resolve(REPO_ROOT, 'bench/lab/registry/datasets.json'), 'utf8')) as {
      datasets: Array<{
        id: string; requiredInCi: boolean; oracleAccess: string; split: string;
        source: { revision: string };
        artifacts: Array<{ role: string; access: string; repositoryPath: string; sha256: string; sizeBytes: number }>;
      }>;
    };
    const v3 = registry.datasets.filter(({ id }) => id.startsWith('memberry-multihop-v3-'));
    expect(v3.map(({ id }) => id)).toEqual([
      'memberry-multihop-v3-calib', 'memberry-multihop-v3-dev', 'memberry-multihop-v3-holdout',
    ]);
    expect(v3.map(({ split, requiredInCi, oracleAccess }) => ({ split, requiredInCi, oracleAccess }))).toEqual([
      { split: 'calib', requiredInCi: false, oracleAccess: 'scorer-only' },
      { split: 'dev', requiredInCi: false, oracleAccess: 'scorer-only' },
      { split: 'holdout', requiredInCi: false, oracleAccess: 'scorer-only' },
    ]);
    for (const dataset of v3) expect(dataset.source.revision).toBe('lab-ret007-candidate-blind-v3');
    for (const [id, split] of [
      ['memberry-multihop-v3-dev', 'dev'],
      ['memberry-multihop-v3-holdout', 'holdout'],
    ] as const) {
      const mutation = structuredClone(registry);
      mutation.datasets.find((dataset) => dataset.id === id)!.requiredInCi = true;
      expect(validateDatasetRegistry(mutation)).toContain(
        `multi-hop requires exactly one immutable required CI ${split} split`,
      );
    }
    const calibMutation = structuredClone(registry);
    calibMutation.datasets.find((dataset) => dataset.id === 'memberry-multihop-v3-calib')!.requiredInCi = true;
    expect(validateDatasetRegistry(calibMutation).join('\n')).toMatch(/requiredInCi split must be exactly dev or holdout/);
    const frozen = [
      ...FROZEN_CALIB_ARTIFACTS,
      { repositoryPath: 'bench/lab/datasets/multihop/v3/dev/input.jsonl', ...MULTIHOP_V3_FREEZE.artifacts.dev.input },
      { repositoryPath: 'bench/lab/datasets/multihop/v3/dev/oracle.jsonl', ...MULTIHOP_V3_FREEZE.artifacts.dev.oracle },
      { repositoryPath: 'bench/lab/datasets/multihop/v3/holdout/input.jsonl', ...MULTIHOP_V3_FREEZE.artifacts.holdout.input },
      { repositoryPath: 'bench/lab/datasets/multihop/v3/holdout/oracle.jsonl', ...MULTIHOP_V3_FREEZE.artifacts.holdout.oracle },
    ];
    const registered = v3.flatMap(({ artifacts }) => artifacts);
    for (const artifact of frozen) {
      const bytes = await readFile(resolve(REPO_ROOT, artifact.repositoryPath));
      expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
      expect(bytes.includes(Buffer.from('\r\n'))).toBe(false);
      expect({ sha256: sha256(bytes), sizeBytes: bytes.byteLength }).toEqual({
        sha256: artifact.sha256, sizeBytes: artifact.sizeBytes,
      });
      expect(registered.find(({ repositoryPath }) => repositoryPath === artifact.repositoryPath))
        .toMatchObject({ sha256: artifact.sha256, sizeBytes: artifact.sizeBytes });
    }
  });

  it('loads exactly 15+20+20 probes with k=10, knob-sized opaque memories, and two scorer-only hops', async () => {
    expect(MULTIHOP_V3_DATASET_IDS).toEqual({
      calib: 'memberry-multihop-v3-calib', dev: 'memberry-multihop-v3-dev', holdout: 'memberry-multihop-v3-holdout',
    });
    const inputs = await loadMultiHopV3ScenarioInputs(REPO_ROOT);
    expect(inputs).toHaveLength(MULTIHOP_V3_CALIB_PROBES + 2 * MULTIHOP_V3_PROBES_PER_SPLIT);
    const allMemoryIds = new Set<string>();
    for (const split of SPLITS) {
      const selected = inputs.filter((input) => (input.split as string) === split);
      expect(selected).toHaveLength(split === 'calib' ? MULTIHOP_V3_CALIB_PROBES : MULTIHOP_V3_PROBES_PER_SPLIT);
      for (const input of selected) {
        expect(input.id).toMatch(new RegExp(`^mh3-${split[0]}-[0-9]{2}$`));
        expect(input.dimensions).toEqual(['multi-hop']);
        expect(input.tenant).toBe('synthetic-ret007v3');
        expect(input.project).toBe(`synthetic-${input.id}`);
        expect(input.queries).toHaveLength(1);
        expect(input.queries[0]!.limit).toBe(MULTIHOP_V3_K);
        expect(input.memories).toHaveLength(MULTIHOP_V3_CORPUS_SIZE);
        expect(input.tags).toHaveLength(6);
        expect(input.tags).toEqual(expect.arrayContaining(['synthetic', 'lab-ret007-candidate-blind-v3']));
        expect(input.queries[0]!.id).toMatch(/^p3-[0-9a-f]{24}$/);
        expect(input.queries[0]!.id).not.toMatch(ROLE_LEAK);
        for (const memory of input.memories) {
          expect(memory.id).toMatch(/^m3-[0-9a-f]{24}$/);
          expect(memory.id).not.toMatch(ROLE_LEAK);
          expect(allMemoryIds.has(memory.id)).toBe(false);
          allMemoryIds.add(memory.id);
        }
      }
    }
    expect(allMemoryIds.size).toBe(55 * MULTIHOP_V3_CORPUS_SIZE);
    for (const { input, oracle } of await allScoringScenarios()) {
      expect(oracle.probes).toHaveLength(1);
      const required = oracle.probes[0]!.required!;
      expect(required).toHaveLength(2);
      expect(new Set(required).size).toBe(2);
      expect(new Set(oracle.probes[0]!.relevant)).toEqual(new Set(required));
      expect(required.every((id) => input.memories.some((memory) => memory.id === id))).toBe(true);
    }
  });

  it('refuses the calib split at the qualification/comparison entry point', async () => {
    await expect(loadMultiHopV3ScenariosForScoring('calib' as never, REPO_ROOT))
      .rejects.toThrow(/calib split is refused by qualification\/comparison entry points/);
    const calib = await loadMultiHopV3CalibScenariosForCalibration(REPO_ROOT);
    expect(calib).toHaveLength(MULTIHOP_V3_CALIB_PROBES);
    expect(calib.every(({ input }) => (input.split as string) === 'calib')).toBe(true);
  });

  it('independently recomputes seed-only corpus order and rejects any order mutation', async () => {
    const inputs = await loadMultiHopV3ScenarioInputs(REPO_ROOT);
    for (const input of inputs) {
      const expected = [...input.memories].sort((left, right) => (
        independentOrdinalCompare(independentOrderKey(input.id, left.id), independentOrderKey(input.id, right.id))
          || independentOrdinalCompare(left.id, right.id)
      ));
      expect(input.memories.map(({ id }) => id)).toEqual(expected.map(({ id }) => id));
    }
    const reordered = structuredClone(inputs) as LabScenarioInput[];
    reordered[0]!.memories = [...reordered[0]!.memories].reverse();
    expect(() => validateMultiHopV3ScenarioInputs(reordered)).toThrow(/frozen public seed derivation/);

    const contentMutation = structuredClone(inputs) as LabScenarioInput[];
    contentMutation[0]!.memories[0]!.content += ' Content does not participate in ordering.';
    expect(() => validateMultiHopV3ScenarioInputs(contentMutation)).not.toThrow();

    const loaderSource = await readFile(resolve(REPO_ROOT, 'bench/lab/datasets/load-multihop-v3.ts'), 'utf8');
    expect(loaderSource).toContain('function ordinalCompare(left: string, right: string)');
    expect(loaderSource).not.toContain('localeCompare');
  });

  it('enforces family/density matrices, per-split diversity caps, and three-way disjointness', async () => {
    const inputs = await loadMultiHopV3ScenarioInputs(REPO_ROOT);
    const sets = Object.fromEntries(SPLITS.map((split) => {
      const selected = inputs.filter((input) => (input.split as string) === split);
      const minDistinct = split === 'calib' ? 8 : 10;
      const familyCount = split === 'calib' ? 3 : 4;
      const densityCounts = split === 'calib' ? MULTIHOP_V3_CALIB_DENSITY_COUNTS : MULTIHOP_V3_DENSITY_COUNTS;
      const values = (prefix: string) => selected.map((input) => tag(input, prefix));
      const familyCounts = new Map<string, number>();
      const densityTagCounts = new Map<string, number>();
      for (const family of values('family:')) familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
      for (const density of values('density:')) densityTagCounts.set(density, (densityTagCounts.get(density) ?? 0) + 1);
      const domainCounts = new Map<string, number>();
      for (const domain of values('domain:')) domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
      const formCounts = new Map<string, number>();
      for (const form of values('query-form:')) formCounts.set(form, (formCounts.get(form) ?? 0) + 1);
      const skeletonCounts = new Map<string, number>();
      for (const skeleton of selected.map((input) => lexicalSkeleton(input.queries[0]!.query))) {
        skeletonCounts.set(skeleton, (skeletonCounts.get(skeleton) ?? 0) + 1);
      }
      expect(domainCounts.size).toBeGreaterThanOrEqual(minDistinct);
      expect(formCounts.size).toBeGreaterThanOrEqual(minDistinct);
      expect(skeletonCounts.size).toBeGreaterThanOrEqual(minDistinct);
      for (const counts of [domainCounts, formCounts, skeletonCounts]) {
        expect([...counts.values()].every((count) => count <= 2)).toBe(true);
      }
      expect([...familyCounts.values()]).toEqual([familyCount, familyCount, familyCount, familyCount, familyCount]);
      expect(Object.fromEntries([...densityTagCounts].map(([key, value]) => [key.slice('density:'.length), value])))
        .toEqual(densityCounts);
      return [split, {
        domains: new Set(values('domain:')), forms: new Set(values('query-form:')),
        skeletons: new Set(selected.map((input) => lexicalSkeleton(input.queries[0]!.query))),
      }] as const;
    })) as Record<(typeof SPLITS)[number], { domains: Set<string>; forms: Set<string>; skeletons: Set<string> }>;
    for (let left = 0; left < SPLITS.length; left += 1) {
      for (let right = left + 1; right < SPLITS.length; right += 1) {
        const a = sets[SPLITS[left]!];
        const b = sets[SPLITS[right]!];
        expect([...a.domains].some((value) => b.domains.has(value))).toBe(false);
        expect([...a.forms].some((value) => b.forms.has(value))).toBe(false);
        expect([...a.skeletons].some((value) => b.skeletons.has(value))).toBe(false);
      }
    }
    for (const facet of ['domains', 'forms', 'skeletons'] as const) {
      expect(SPLITS.reduce((sum, split) => sum + sets[split][facet].size, 0)).toBeGreaterThanOrEqual(28);
    }
  });

  it('audits genuine two-hop chains and the calibrated per-density knob realization in the bytes', async () => {
    const scenarios = await allScoringScenarios();
    for (const scenario of scenarios) {
      const { subject, subjectName, bridge, bridgeName, answerName } = parseChain(scenario);
      const query = scenario.input.queries[0]!.query;
      expect(query.toLowerCase()).toContain(subject.toLowerCase());
      expect(query).not.toContain(bridgeName);
      expect(query).not.toContain(answerName);
      const required = new Set(scenario.oracle.probes[0]!.required!);
      const distractors = scenario.input.memories.filter(({ id }) => !required.has(id));
      for (const { content } of distractors) {
        const text = content.toLowerCase();
        expect(text.includes(subject.toLowerCase()) && text.includes(bridge.toLowerCase())).toBe(false);
      }
      const density = tag(scenario.input, 'density:').slice('density:'.length) as 'low' | 'medium' | 'high';
      const bridgeCollisions = distractors.filter(({ content }) => (
        new RegExp(`\\b${bridgeName}(?:-\\d+)?\\b`).test(content)
      ));
      expect(bridgeCollisions).toHaveLength(MULTIHOP_V3_KNOBS.bridgeTokenCollisions[density]);
      const collisionIds = new Set(bridgeCollisions.map(({ id }) => id));
      const echoes = distractors.filter(({ id, content }) => !collisionIds.has(id)
        && (new RegExp(`\\b${subjectName}\\b`).test(content) || new RegExp(`\\b${answerName}\\b`).test(content)));
      expect(echoes).toHaveLength(MULTIHOP_V3_KNOBS.factTokenEcho[density]);
      // domainLexicalOverlapShare is not re-counted lexically here: the
      // knob-to-bytes binding for ALL knobs is proven by the three-split
      // byte-reproduction test in bench/lab/multihop/__tests__/generate-v3.test.ts.
    }
  });

  it('rejects adapter-visible labels, diversity mutations, and mismatched scorer custody pairs', async () => {
    const inputs = structuredClone(await loadMultiHopV3ScenarioInputs(REPO_ROOT)) as LabScenarioInput[];
    inputs[0]!.memories[0]!.metadata = { nested: { required: ['hidden'] } };
    expect(() => validateMultiHopV3ScenarioInputs(inputs)).toThrow(/oracle-shaped key.*required/);

    const uppercase = structuredClone(await loadMultiHopV3ScenarioInputs(REPO_ROOT)) as LabScenarioInput[];
    uppercase[0]!.memories[0]!.metadata = { nested: { REQUIRED: ['hidden'] } };
    expect(() => validateMultiHopV3ScenarioInputs(uppercase)).toThrow(/oracle-shaped key.*REQUIRED/);

    const diversity = structuredClone(await loadMultiHopV3ScenarioInputs(REPO_ROOT)) as LabScenarioInput[];
    const domain = tag(diversity.find(({ split }) => split === 'dev')!, 'domain:');
    for (const input of diversity.filter(({ split }) => split === 'dev').slice(0, 3)) {
      input.tags = input.tags!.map((value) => value.startsWith('domain:') ? domain : value);
    }
    expect(() => validateMultiHopV3ScenarioInputs(diversity)).toThrow(/domain diversity\/cap/);

    const wrongCorpus = structuredClone(await loadMultiHopV3ScenarioInputs(REPO_ROOT)) as LabScenarioInput[];
    wrongCorpus[0]!.memories = wrongCorpus[0]!.memories.slice(0, MULTIHOP_V3_CORPUS_SIZE - 1);
    expect(() => validateMultiHopV3ScenarioInputs(wrongCorpus))
      .toThrow(new RegExp(`requires exactly ${MULTIHOP_V3_CORPUS_SIZE} eligible memories`));

    const scenarios = await loadMultiHopV3ScenariosForScoring('dev', REPO_ROOT);
    const oracles = scenarios.map(({ oracle }) => structuredClone(oracle)) as LabScenarioOracle[];
    oracles[0]!.scenarioId = 'wrong-oracle-id';
    expect(() => pairMultiHopV3Scenarios(scenarios.map(({ input }) => input), oracles, 'dev'))
      .toThrow(/oracle ID\/order mismatch/);
  });

  it('keeps v3 scorer custody out of public barrels, adapters, and production/package dependency paths', async () => {
    const barrel = await readFile(resolve(REPO_ROOT, 'bench/lab/index.ts'), 'utf8');
    expect(barrel).not.toMatch(/load-multihop-v3|scorer-only-v3|generate-v3|calibrate-v3/);
    const registry = JSON.parse(await readFile(resolve(REPO_ROOT, 'bench/lab/registry/systems.json'), 'utf8')) as {
      systems: Array<{ adapter: string }>;
    };
    const adapters = [...new Set(registry.systems.map(({ adapter }) => adapter)
      .filter((entry) => entry.startsWith('bench/lab/adapters/')))];
    for (const entry of adapters) {
      const audit = await auditAdapterDependencies(resolve(REPO_ROOT, entry), REPO_ROOT);
      expect(audit.visited.map((path) => path.replace(/\\/g, '/')).join('\n'))
        .not.toMatch(/\/datasets\/load-multihop-v3\.ts|\/multihop\/scorer-only-v3\.ts|\/multihop\/generate-v3\.ts/);
    }
    for (const sourcePath of [
      'bench/lab/datasets/load-multihop-v3.ts', 'bench/lab/multihop/policy-v3.ts',
      'bench/lab/multihop/scorer-only-v3.ts', 'bench/lab/multihop/generate-v3.ts',
    ]) {
      const source = await readFile(resolve(REPO_ROOT, sourcePath), 'utf8');
      expect(source).not.toMatch(/from ['"][^'"]*(?:\/adapters\/|\/packages\/)/);
    }
  });

  it('makes a synthetic adapter import of scorer-only-v3 fail the existing transitive dependency audit', async () => {
    const scorerSource = await readFile(resolve(REPO_ROOT, 'bench/lab/multihop/scorer-only-v3.ts'), 'utf8');
    expect(scorerSource).toContain("import type { MultiHopV3ScoringScenario } from '../datasets/load-multihop-v3.js'");
    const temporary = await mkdtemp(resolve(REPO_ROOT, '.ret007v3-scorer-audit-'));
    const entry = resolve(temporary, 'synthetic-adapter.ts');
    try {
      await writeFile(entry, [
        "import { scoreMultiHopV3Comparison } from '../bench/lab/multihop/scorer-only-v3.js';",
        'export const prohibitedScorerImport = scoreMultiHopV3Comparison;',
        '',
      ].join('\n'), 'utf8');
      const audit = await auditAdapterDependencies(entry, REPO_ROOT);
      expect(audit.violations).toEqual(expect.arrayContaining([
        expect.stringMatching(/datasets\/load-multihop-v3\.ts: scorer-only path is forbidden to adapters/),
      ]));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it('keeps oracle access solely in the scorer-custodian routes and ratchets the v3 modules', async () => {
    const source = await readFile(resolve(REPO_ROOT, 'bench/lab/datasets/load-multihop-v3.ts'), 'utf8');
    const inputStart = source.indexOf('export async function loadMultiHopV3ScenarioInputs');
    const scoringStart = source.indexOf('export async function loadMultiHopV3ScenariosForScoring');
    assert.notEqual(inputStart, -1);
    assert.notEqual(scoringStart, -1);
    expect(source.slice(inputStart, scoringStart)).toContain('.inputArtifacts');
    expect(source.slice(inputStart, scoringStart)).not.toContain('.oracleArtifacts');
    expect(source.slice(scoringStart)).toContain('.oracleArtifacts');

    const pkg = JSON.parse(await readFile(resolve(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const command = pkg.scripts['bench:lab:typecheck'];
    assert.ok(command);
    for (const entry of [
      'bench/lab/datasets/load-multihop-v3.ts',
      'bench/lab/multihop/scorer-only-v3.ts',
      'bench/lab/multihop/policy-v3.ts',
      'bench/lab/multihop/generate-v3.ts',
      'bench/lab/multihop/calibrate-v3.ts',
      'bench/lab/multihop/measure-v2-knobs.ts',
      'bench/lab/multihop/qualify-control-v3.ts',
    ]) expect(command.split(/\s+/).filter((value) => value === entry)).toHaveLength(1);
    expect(pkg.scripts['bench:lab:multihop-v3:qualify-control']).toBe('tsx bench/lab/multihop/qualify-control-v3.ts node');
    expect(pkg.scripts['bench:lab:multihop-v3:join-control']).toBe('tsx bench/lab/multihop/qualify-control-v3.ts join');
  });
});
