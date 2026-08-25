import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { LabScenario, LabScenarioInput, LabScenarioOracle } from '../../contracts/scenario.js';
import {
  MULTIHOP_V4_DATASET_IDS,
  loadMultiHopV4CalibScenariosForCalibration,
  loadMultiHopV4ScenarioInputs,
  loadMultiHopV4ScenariosForScoring,
  loadMultiHopV4TwinScenariosForEvidence,
  pairMultiHopV4Scenarios,
  validateMultiHopV4ScenarioInputs,
} from '../load-multihop-v4.js';
import {
  MULTIHOP_V4_BATTERY,
  MULTIHOP_V4_CORPUS_SIZE,
  MULTIHOP_V4_DENSITY_COUNTS,
  MULTIHOP_V4_FREEZE,
  MULTIHOP_V4_K,
  MULTIHOP_V4_KNOBS,
  MULTIHOP_V4_PROBES,
  MULTIHOP_V4_SPLITS,
} from '../../multihop/policy-v4.js';
import { auditAdapterDependencies } from '../../registered-adapters.js';
import { validateDatasetRegistry } from '../../registry/validate.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const ORDER_SEED = 'memberry-ret007-v4-order-2026-08-25';
const ROLE_LEAK = /(?:^|[-_])(a|b|required|relevant|hop-?1|hop-?2|twin|broken)(?:$|[-_])/i;
const HOP1 = /^(.+?) (is warehoused at|is rostered to|is fitted inside|is safeguarded by|is serviced by) (.+?)\.$/;

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
  twin: boolean;
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
  const twin = (scenario.input.split as string) === 'twin';
  if (twin) {
    assert.ok(!second.includes(lastName(bridge)), `${scenario.input.id}: twin bridge must be severed`);
  } else {
    assert.ok(second.toLowerCase().startsWith(bridge.toLowerCase()), `${scenario.input.id}: second-hop bridge continuity`);
  }
  return {
    subject,
    subjectName: lastName(subject),
    bridge,
    bridgeName: twin ? second.replace(/\.$/, '').split(' ')[2]! : lastName(bridge),
    answerName: lastName(second.replace(/\.$/, '')),
    twin,
  };
}

async function allScenarios(): Promise<LabScenario[]> {
  return [
    ...await loadMultiHopV4CalibScenariosForCalibration(REPO_ROOT),
    ...await loadMultiHopV4ScenariosForScoring('dev', REPO_ROOT),
    ...await loadMultiHopV4ScenariosForScoring('holdout', REPO_ROOT),
    ...await loadMultiHopV4TwinScenariosForEvidence(REPO_ROOT),
  ];
}

describe('RET-007 v4 frozen candidate-blind multi-hop datasets', () => {
  it('anchors canonical raw-LF/no-BOM v4 bytes and the four-way registry arity', async () => {
    expect(sha256(ORDER_SEED)).toBe(MULTIHOP_V4_FREEZE.seedCommitmentSha256);
    expect(MULTIHOP_V4_FREEZE.orderKeyDerivation).toBe('sha256-utf8(seed+LF+scenario_id+LF+neutral_slot_id)');
    const registry = JSON.parse(await readFile(resolve(REPO_ROOT, 'bench/lab/registry/datasets.json'), 'utf8')) as {
      datasets: Array<{
        id: string; version: string; requiredInCi: boolean; oracleAccess: string; split: string;
        source: { revision: string };
        artifacts: Array<{ role: string; access: string; repositoryPath: string; sha256: string; sizeBytes: number }>;
      }>;
    };
    const v4 = registry.datasets.filter(({ id }) => id.startsWith('memberry-multihop-v4-'));
    expect(v4.map(({ id }) => id)).toEqual([
      'memberry-multihop-v4-calib', 'memberry-multihop-v4-dev', 'memberry-multihop-v4-holdout', 'memberry-multihop-v4-twin',
    ]);
    expect(v4.map(({ split, requiredInCi, oracleAccess, version }) => ({ split, requiredInCi, oracleAccess, version }))).toEqual([
      { split: 'calib', requiredInCi: false, oracleAccess: 'scorer-only', version: '4.0.0' },
      { split: 'dev', requiredInCi: false, oracleAccess: 'scorer-only', version: '4.0.0' },
      { split: 'holdout', requiredInCi: false, oracleAccess: 'scorer-only', version: '4.0.0' },
      { split: 'twin', requiredInCi: false, oracleAccess: 'scorer-only', version: '4.0.0' },
    ]);
    for (const dataset of v4) expect(dataset.source.revision).toBe('lab-ret007-candidate-blind-v4');
    for (const [id, split] of [
      ['memberry-multihop-v4-dev', 'dev'],
      ['memberry-multihop-v4-holdout', 'holdout'],
    ] as const) {
      const mutation = structuredClone(registry);
      mutation.datasets.find((dataset) => dataset.id === id)!.requiredInCi = true;
      expect(validateDatasetRegistry(mutation)).toContain(
        `multi-hop requires exactly one immutable required CI ${split} split`,
      );
    }
    // validate.ts:95 permits calib/twin split values ONLY while requiredInCi is false.
    for (const id of ['memberry-multihop-v4-calib', 'memberry-multihop-v4-twin']) {
      const mutation = structuredClone(registry);
      mutation.datasets.find((dataset) => dataset.id === id)!.requiredInCi = true;
      expect(validateDatasetRegistry(mutation).join('\n')).toMatch(/requiredInCi split must be exactly dev or holdout/);
    }
    expect(validateDatasetRegistry(registry)).toEqual([]);
    const registered = v4.flatMap(({ artifacts }) => artifacts);
    for (const split of MULTIHOP_V4_SPLITS) {
      for (const role of ['input', 'oracle'] as const) {
        const repositoryPath = `bench/lab/datasets/multihop/v4/${split}/${role}.jsonl`;
        const bytes = await readFile(resolve(REPO_ROOT, repositoryPath));
        expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
        expect(bytes.includes(Buffer.from('\r\n'))).toBe(false);
        expect({ sha256: sha256(bytes), sizeBytes: bytes.byteLength }).toEqual(MULTIHOP_V4_FREEZE.artifacts[split][role]);
        expect(registered.find((artifact) => artifact.repositoryPath === repositoryPath))
          .toMatchObject(MULTIHOP_V4_FREEZE.artifacts[split][role]);
      }
    }
  });

  it('loads exactly 45+60+100+30 probes with k=10, knob-sized opaque memories, and two scorer-only hops', async () => {
    expect(MULTIHOP_V4_DATASET_IDS).toEqual({
      calib: 'memberry-multihop-v4-calib', dev: 'memberry-multihop-v4-dev',
      holdout: 'memberry-multihop-v4-holdout', twin: 'memberry-multihop-v4-twin',
    });
    const inputs = await loadMultiHopV4ScenarioInputs(REPO_ROOT);
    expect(inputs).toHaveLength(235);
    const allMemoryIds = new Set<string>();
    for (const split of MULTIHOP_V4_SPLITS) {
      const selected = inputs.filter((input) => (input.split as string) === split);
      expect(selected).toHaveLength(MULTIHOP_V4_PROBES[split]);
      for (const input of selected) {
        expect(input.id).toMatch(new RegExp(`^mh4-${split[0]}-[0-9]{${String(MULTIHOP_V4_PROBES[split]).length}}$`));
        expect(input.dimensions).toEqual(['multi-hop']);
        expect(input.tenant).toBe('synthetic-ret007v4');
        expect(input.project).toBe(`synthetic-${input.id}`);
        expect(input.queries).toHaveLength(1);
        expect(input.queries[0]!.limit).toBe(MULTIHOP_V4_K);
        expect(input.memories).toHaveLength(MULTIHOP_V4_CORPUS_SIZE);
        expect(input.tags).toHaveLength(6);
        expect(input.tags).toEqual(expect.arrayContaining(['synthetic', 'lab-ret007-candidate-blind-v4']));
        expect(input.queries[0]!.id).toMatch(/^p4-[0-9a-f]{24}$/);
        expect(input.queries[0]!.id).not.toMatch(ROLE_LEAK);
        for (const memory of input.memories) {
          expect(memory.id).toMatch(/^m4-[0-9a-f]{24}$/);
          expect(memory.id).not.toMatch(ROLE_LEAK);
          expect(allMemoryIds.has(memory.id)).toBe(false);
          allMemoryIds.add(memory.id);
        }
      }
    }
    expect(allMemoryIds.size).toBe(235 * MULTIHOP_V4_CORPUS_SIZE);
    for (const { input, oracle } of await allScenarios()) {
      expect(oracle.probes).toHaveLength(1);
      const required = oracle.probes[0]!.required!;
      expect(required).toHaveLength(2);
      expect(new Set(required).size).toBe(2);
      expect(new Set(oracle.probes[0]!.relevant)).toEqual(new Set(required));
      expect(required.every((id) => input.memories.some((memory) => memory.id === id))).toBe(true);
    }
  });

  it('refuses calib AND twin at the qualification/comparison entry point; twin only via its evidence loader', async () => {
    await expect(loadMultiHopV4ScenariosForScoring('calib' as never, REPO_ROOT))
      .rejects.toThrow(/calib split is refused by qualification\/comparison entry points/);
    await expect(loadMultiHopV4ScenariosForScoring('twin' as never, REPO_ROOT))
      .rejects.toThrow(/twin split is refused by qualification\/comparison entry points/);
    const calib = await loadMultiHopV4CalibScenariosForCalibration(REPO_ROOT);
    expect(calib).toHaveLength(45);
    expect(calib.every(({ input }) => (input.split as string) === 'calib')).toBe(true);
    const twin = await loadMultiHopV4TwinScenariosForEvidence(REPO_ROOT);
    expect(twin).toHaveLength(30);
    expect(twin.every(({ input }) => (input.split as string) === 'twin')).toBe(true);
    expect(await loadMultiHopV4ScenariosForScoring('dev', REPO_ROOT)).toHaveLength(60);
    expect(await loadMultiHopV4ScenariosForScoring('holdout', REPO_ROOT)).toHaveLength(100);
  });

  it('independently recomputes seed-only corpus order and rejects any order mutation', async () => {
    const inputs = await loadMultiHopV4ScenarioInputs(REPO_ROOT);
    for (const input of inputs) {
      const expected = [...input.memories].sort((left, right) => (
        independentOrdinalCompare(independentOrderKey(input.id, left.id), independentOrderKey(input.id, right.id))
          || independentOrdinalCompare(left.id, right.id)
      ));
      expect(input.memories.map(({ id }) => id)).toEqual(expected.map(({ id }) => id));
    }
    const reordered = structuredClone(inputs) as LabScenarioInput[];
    reordered[0]!.memories = [...reordered[0]!.memories].reverse();
    expect(() => validateMultiHopV4ScenarioInputs(reordered)).toThrow(/frozen public seed derivation/);

    const contentMutation = structuredClone(inputs) as LabScenarioInput[];
    contentMutation[0]!.memories[0]!.content += ' Content does not participate in ordering.';
    expect(() => validateMultiHopV4ScenarioInputs(contentMutation)).not.toThrow();

    const loaderSource = await readFile(resolve(REPO_ROOT, 'bench/lab/datasets/load-multihop-v4.ts'), 'utf8');
    expect(loaderSource).toContain('function ordinalCompare(left: string, right: string)');
    expect(loaderSource).not.toContain('localeCompare');
  });

  it('enforces family/density matrices, the pre-registered per-split caps, and global triple uniqueness', async () => {
    const inputs = await loadMultiHopV4ScenarioInputs(REPO_ROOT);
    expect(MULTIHOP_V4_BATTERY).toEqual({
      calib: { probes: 45, cap: 3, minDistinct: 15, familyCount: 9 },
      dev: { probes: 60, cap: 4, minDistinct: 15, familyCount: 12 },
      holdout: { probes: 100, cap: 5, minDistinct: 20, familyCount: 20 },
      twin: { probes: 30, cap: 3, minDistinct: 10, familyCount: 6 },
    });
    for (const split of MULTIHOP_V4_SPLITS) {
      const battery = MULTIHOP_V4_BATTERY[split];
      expect(battery.cap).toBe(Math.ceil(battery.probes / 28) + 1);
      expect(battery.minDistinct).toBe(Math.ceil(battery.probes / battery.cap));
      const selected = inputs.filter((input) => (input.split as string) === split);
      const values = (prefix: string) => selected.map((input) => tag(input, prefix));
      const count = (list: string[]) => {
        const map = new Map<string, number>();
        for (const value of list) map.set(value, (map.get(value) ?? 0) + 1);
        return map;
      };
      const domainCounts = count(values('domain:'));
      const formCounts = count(values('query-form:'));
      const skeletonCounts = count(selected.map((input) => lexicalSkeleton(input.queries[0]!.query)));
      const familyCounts = count(values('family:'));
      const densityCounts = count(values('density:'));
      for (const counts of [domainCounts, formCounts, skeletonCounts]) {
        expect(counts.size).toBeGreaterThanOrEqual(battery.minDistinct);
        expect([...counts.values()].every((value) => value <= battery.cap)).toBe(true);
      }
      expect([...familyCounts.values()]).toEqual(Array(5).fill(battery.familyCount));
      expect(Object.fromEntries([...densityCounts].map(([key, value]) => [key.slice('density:'.length), value])))
        .toEqual(MULTIHOP_V4_DENSITY_COUNTS[split]);
    }
    const triples = new Set(inputs.map((input) => `${tag(input, 'domain:')}|${tag(input, 'family:')}|${tag(input, 'query-form:')}`));
    expect(triples.size).toBe(235);
    for (const facet of ['domain:', 'query-form:'] as const) {
      expect(new Set(inputs.map((input) => tag(input, facet))).size).toBe(28);
    }
    // Bite: a per-split cap breach is rejected by the battery.
    const capped = structuredClone(inputs) as LabScenarioInput[];
    const holdout = capped.filter(({ split }) => (split as string) === 'holdout');
    const domain = tag(holdout[0]!, 'domain:');
    for (const input of holdout.slice(0, MULTIHOP_V4_BATTERY.holdout.cap + 1)) {
      input.tags = input.tags!.map((value) => value.startsWith('domain:') ? domain : value);
    }
    expect(() => validateMultiHopV4ScenarioInputs(capped)).toThrow(/domain diversity\/cap|triple is not unique/);
  });

  it('audits genuine two-hop chains, severed twins, and the calibrated per-density knob realization', async () => {
    const scenarios = await allScenarios();
    for (const scenario of scenarios) {
      const { subject, subjectName, bridge, bridgeName, answerName, twin } = parseChain(scenario);
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
      const bridgeClones = distractors.filter(({ content }) => new RegExp(`\\b${bridgeName}-\\d+\\b`).test(content));
      expect(bridgeClones).toHaveLength(MULTIHOP_V4_KNOBS.bridgeTokenCollisions[density]);
      expect(bridgeClones.length).toBeLessThanOrEqual(1);
      const exactBridge = distractors.filter(({ content }) => new RegExp(`(?:^|[^A-Za-z0-9-])${bridgeName}(?![A-Za-z0-9-])`).test(content));
      expect(exactBridge).toHaveLength(0);
      const echoes = distractors.filter(({ content }) => (
        new RegExp(`\\b${subjectName}\\b`).test(content) || new RegExp(`\\b${answerName}\\b`).test(content)));
      expect(echoes).toHaveLength(MULTIHOP_V4_KNOBS.factTokenEcho[density]);
      expect(twin).toBe((scenario.input.split as string) === 'twin');
    }
  });

  it('rejects adapter-visible labels, diversity mutations, and mismatched scorer custody pairs', async () => {
    const inputs = structuredClone(await loadMultiHopV4ScenarioInputs(REPO_ROOT)) as LabScenarioInput[];
    inputs[0]!.memories[0]!.metadata = { nested: { required: ['hidden'] } };
    expect(() => validateMultiHopV4ScenarioInputs(inputs)).toThrow(/oracle-shaped key.*required/);

    const wrongCorpus = structuredClone(await loadMultiHopV4ScenarioInputs(REPO_ROOT)) as LabScenarioInput[];
    wrongCorpus[0]!.memories = wrongCorpus[0]!.memories.slice(0, MULTIHOP_V4_CORPUS_SIZE - 1);
    expect(() => validateMultiHopV4ScenarioInputs(wrongCorpus))
      .toThrow(new RegExp(`requires exactly ${MULTIHOP_V4_CORPUS_SIZE} eligible memories`));

    const scenarios = await loadMultiHopV4ScenariosForScoring('dev', REPO_ROOT);
    const oracles = scenarios.map(({ oracle }) => structuredClone(oracle)) as LabScenarioOracle[];
    oracles[0]!.scenarioId = 'wrong-oracle-id';
    expect(() => pairMultiHopV4Scenarios(scenarios.map(({ input }) => input), oracles, 'dev'))
      .toThrow(/oracle ID\/order mismatch/);
  });

  it('keeps v4 scorer custody out of public barrels, adapters, and production/package dependency paths', async () => {
    const barrel = await readFile(resolve(REPO_ROOT, 'bench/lab/index.ts'), 'utf8');
    expect(barrel).not.toMatch(/load-multihop-v4|scorer-only-v4|generate-v4|calibrate-v4|exchangeability-v4/);
    const registry = JSON.parse(await readFile(resolve(REPO_ROOT, 'bench/lab/registry/systems.json'), 'utf8')) as {
      systems: Array<{ adapter: string }>;
    };
    const adapters = [...new Set(registry.systems.map(({ adapter }) => adapter)
      .filter((entry) => entry.startsWith('bench/lab/adapters/')))];
    expect(adapters).toContain('bench/lab/adapters/memberry-retrieval-core-funnel.ts');
    for (const entry of adapters) {
      const audit = await auditAdapterDependencies(resolve(REPO_ROOT, entry), REPO_ROOT);
      if (entry === 'bench/lab/adapters/memberry-retrieval-core-funnel.ts') expect(audit.violations).toEqual([]);
      expect(audit.visited.map((path) => path.replace(/\\/g, '/')).join('\n'))
        .not.toMatch(/\/datasets\/load-multihop-v4\.ts|\/multihop\/scorer-only-v4\.ts|\/multihop\/generate-v4\.ts|\/multihop\/policy-v4\.ts/);
    }
    for (const sourcePath of [
      'bench/lab/datasets/load-multihop-v4.ts', 'bench/lab/multihop/policy-v4.ts',
      'bench/lab/multihop/scorer-only-v4.ts', 'bench/lab/multihop/generate-v4.ts',
    ]) {
      const source = await readFile(resolve(REPO_ROOT, sourcePath), 'utf8');
      expect(source).not.toMatch(/from ['"][^'"]*(?:\/adapters\/|\/packages\/)/);
    }
  });

  it('makes a synthetic adapter import of scorer-only-v4 fail the existing transitive dependency audit', async () => {
    const scorerSource = await readFile(resolve(REPO_ROOT, 'bench/lab/multihop/scorer-only-v4.ts'), 'utf8');
    expect(scorerSource).toContain("import type { MultiHopV4ScoringScenario } from '../datasets/load-multihop-v4.js'");
    const temporary = await mkdtemp(resolve(REPO_ROOT, '.ret007v4-scorer-audit-'));
    const entry = resolve(temporary, 'synthetic-adapter.ts');
    try {
      await writeFile(entry, [
        "import { scoreMultiHopV4Comparison } from '../bench/lab/multihop/scorer-only-v4.js';",
        'export const prohibitedScorerImport = scoreMultiHopV4Comparison;',
        '',
      ].join('\n'), 'utf8');
      const audit = await auditAdapterDependencies(entry, REPO_ROOT);
      expect(audit.violations).toEqual(expect.arrayContaining([
        expect.stringMatching(/datasets\/load-multihop-v4\.ts: scorer-only path is forbidden to adapters/),
      ]));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it('keeps oracle access solely in the scorer-custodian routes and ratchets the v4 modules', async () => {
    const source = await readFile(resolve(REPO_ROOT, 'bench/lab/datasets/load-multihop-v4.ts'), 'utf8');
    const inputStart = source.indexOf('export async function loadMultiHopV4ScenarioInputs');
    const scoringStart = source.indexOf('export async function loadMultiHopV4ScenariosForScoring');
    assert.notEqual(inputStart, -1);
    assert.notEqual(scoringStart, -1);
    expect(source.slice(inputStart, scoringStart)).toContain('.inputArtifacts');
    expect(source.slice(inputStart, scoringStart)).not.toContain('.oracleArtifacts');
    expect(source.slice(scoringStart)).toContain('.oracleArtifacts');

    const pkg = JSON.parse(await readFile(resolve(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const command = pkg.scripts['bench:lab:typecheck'];
    assert.ok(command);
    for (const entry of [
      'bench/lab/datasets/load-multihop-v4.ts',
      'bench/lab/multihop/scorer-only-v4.ts',
      'bench/lab/multihop/policy-v4.ts',
      'bench/lab/multihop/generate-v4.ts',
      'bench/lab/multihop/calibrate-v4.ts',
      'bench/lab/multihop/exchangeability-v4.ts',
      'bench/lab/multihop/qualify-control-v4.ts',
      'bench/lab/adapters/memberry-retrieval-core-funnel.ts',
    ]) expect(command.split(/\s+/).filter((value) => value === entry)).toHaveLength(1);
    expect(pkg.scripts['bench:lab:multihop-v4:qualify-control']).toBe('tsx bench/lab/multihop/qualify-control-v4.ts node');
    expect(pkg.scripts['bench:lab:multihop-v4:join-control']).toBe('tsx bench/lab/multihop/qualify-control-v4.ts join');
  });
});
