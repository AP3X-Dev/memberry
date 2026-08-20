import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { LabScenarioInput, LabScenarioOracle } from '../../contracts/scenario.js';
import {
  MULTIHOP_DATASET_IDS,
  loadMultiHopScenarioInputs,
  loadMultiHopScenariosForScoring,
  pairMultiHopScenarios,
  validateMultiHopScenarioInputs,
} from '../load-multihop.js';
import { MULTIHOP_K, MULTIHOP_PROBES_PER_SPLIT } from '../../multihop/policy.js';
import { auditAdapterDependencies } from '../../registered-adapters.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const FROZEN_V1_CHANGE_POLICY = 'Future fixture changes require additive multihop/v2 artifacts and review.';
const FROZEN_V1_ARTIFACTS = Object.freeze([
  { repositoryPath: 'bench/lab/datasets/multihop/v1/dev/input.jsonl', sha256: '5ee4eebdcf9b7edf8fdfaeba256e7be4db075b683430c12be126e1de8ae0490b', sizeBytes: 17172 },
  { repositoryPath: 'bench/lab/datasets/multihop/v1/dev/oracle.jsonl', sha256: 'eb1786aaac5add95d7832bf76c5e277002e53db9c399c66e2e70516fb3627be5', sizeBytes: 1680 },
  { repositoryPath: 'bench/lab/datasets/multihop/v1/holdout/input.jsonl', sha256: '33b7e4b6ce3ce0ef2fdab52a75c678055a70915247a8e20eb5c99fe1c092f962', sizeBytes: 17860 },
  { repositoryPath: 'bench/lab/datasets/multihop/v1/holdout/oracle.jsonl', sha256: 'b1e56a88d6496b2a9e4c297d6295b0901bbcfa9bb2e7900dd4bb80ae1bb1853e', sizeBytes: 1920 },
] as const);

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('LAB-012 frozen multi-hop datasets', () => {
  it('anchors canonical raw-LF v1 bytes independently of coordinated registry edits', async () => {
    const registry = JSON.parse(await readFile(resolve(REPO_ROOT, 'bench/lab/registry/datasets.json'), 'utf8')) as {
      datasets: Array<{ artifacts: Array<{ repositoryPath: string; sha256: string; sizeBytes: number }> }>;
    };
    const registered = registry.datasets.flatMap(({ artifacts }) => artifacts);
    for (const frozen of FROZEN_V1_ARTIFACTS) {
      const bytes = await readFile(resolve(REPO_ROOT, frozen.repositoryPath));
      expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
      expect(bytes.includes(Buffer.from('\r\n'))).toBe(false);
      expect({ sha256: sha256(bytes), sizeBytes: bytes.byteLength }).toEqual({
        sha256: frozen.sha256, sizeBytes: frozen.sizeBytes,
      });
      const artifact = registered.find(({ repositoryPath }) => repositoryPath === frozen.repositoryPath);
      expect(artifact).toMatchObject({ sha256: frozen.sha256, sizeBytes: frozen.sizeBytes });
    }

    const holdout = FROZEN_V1_ARTIFACTS[2];
    const canonical = await readFile(resolve(REPO_ROOT, holdout.repositoryPath), 'utf8');
    const mutated = Buffer.from(canonical.replace('sample Opal', 'sample Pearl'), 'utf8');
    const coordinatedMutation = { sha256: sha256(mutated), sizeBytes: mutated.byteLength };
    expect(coordinatedMutation).not.toEqual({ sha256: holdout.sha256, sizeBytes: holdout.sizeBytes });
    expect(FROZEN_V1_CHANGE_POLICY).toBe('Future fixture changes require additive multihop/v2 artifacts and review.');
  });

  it('loads physically separated, registry-hashed synthetic dev and holdout inputs', async () => {
    expect(MULTIHOP_DATASET_IDS).toEqual({
      dev: 'memberry-multihop-dev',
      holdout: 'memberry-multihop-holdout',
    });
    const inputs = await loadMultiHopScenarioInputs(REPO_ROOT);
    for (const split of ['dev', 'holdout'] as const) {
      const selected = inputs.filter((input) => input.split === split);
      expect(selected).toHaveLength(MULTIHOP_PROBES_PER_SPLIT);
      expect(selected).toHaveLength(10);
      for (const input of selected) {
        expect(input.dimensions).toEqual(['multi-hop']);
        expect(input.queries).toHaveLength(1);
        expect(input.queries[0]!.limit).toBe(MULTIHOP_K);
        expect(input.memories.length).toBeGreaterThanOrEqual(11);
        expect(input.tags).toHaveLength(5);
        expect(input.tags).toEqual(expect.arrayContaining(['synthetic', 'lab-012-pre-ret007']));
        expect(input.tags!.filter((tag) => tag.startsWith('domain:'))).toHaveLength(1);
        expect(input.tags!.filter((tag) => tag.startsWith('shape:'))).toHaveLength(1);
        expect(input.tags!.filter((tag) => tag.startsWith('query-form:'))).toHaveLength(1);
        expect(input.queries[0]!.query).not.toMatch(/domain:|shape:|query-form:/);
      }
      const scenarios = await loadMultiHopScenariosForScoring(split, REPO_ROOT);
      expect(scenarios).toHaveLength(10);
      for (const { input, oracle } of scenarios) {
        expect(oracle.probes).toHaveLength(1);
        const required = oracle.probes[0]!.required!;
        expect(required).toHaveLength(2);
        expect(new Set(required).size).toBe(required.length);
        expect(required.every((id) => input.memories.some((memory) => memory.id === id))).toBe(true);
      }
    }
  });

  it('enforces the frozen domain, shape, and query-form diversity matrix', async () => {
    const inputs = await loadMultiHopScenarioInputs(REPO_ROOT);
    const tag = (input: LabScenarioInput, prefix: string) => input.tags!.find((value) => value.startsWith(prefix))!;
    const sets = Object.fromEntries(['dev', 'holdout'].map((split) => {
      const selected = inputs.filter((input) => input.split === split);
      const values = (prefix: string) => selected.map((input) => tag(input, prefix));
      const shapeCounts = new Map<string, number>();
      for (const shape of values('shape:')) shapeCounts.set(shape, (shapeCounts.get(shape) ?? 0) + 1);
      expect(new Set(values('domain:')).size).toBeGreaterThanOrEqual(5);
      expect(new Set(values('query-form:')).size).toBeGreaterThanOrEqual(5);
      expect([...shapeCounts.values()]).toEqual([2, 2, 2, 2, 2]);
      return [split, { domains: new Set(values('domain:')), forms: new Set(values('query-form:')), shapes: new Set(shapeCounts.keys()) }] as const;
    })) as Record<'dev' | 'holdout', { domains: Set<string>; forms: Set<string>; shapes: Set<string> }>;
    expect([...sets.dev.domains].some((value) => sets.holdout.domains.has(value))).toBe(false);
    expect([...sets.dev.forms].some((value) => sets.holdout.forms.has(value))).toBe(false);
    expect(sets.dev.shapes).toEqual(sets.holdout.shapes);
  });

  it('recursively rejects oracle-shaped keys from adapter-visible input', async () => {
    const inputs = structuredClone(await loadMultiHopScenarioInputs(REPO_ROOT)) as LabScenarioInput[];
    inputs[0]!.memories[0]!.metadata = { nested: { required: ['hidden'] } };
    expect(() => validateMultiHopScenarioInputs(inputs)).toThrow(/oracle-shaped key.*required/);
  });

  it('rejects diversity-cap and cross-split query-template mutations', async () => {
    const inputs = structuredClone(await loadMultiHopScenarioInputs(REPO_ROOT)) as LabScenarioInput[];
    const devDomain = inputs.find((input) => input.split === 'dev')!.tags!.find((tag) => tag.startsWith('domain:'))!;
    for (const input of inputs.filter((value) => value.split === 'dev').slice(0, 3)) {
      input.tags = input.tags!.map((tag) => tag.startsWith('domain:') ? devDomain : tag);
    }
    expect(() => validateMultiHopScenarioInputs(inputs)).toThrow(/domain diversity\/cap/);

    const templates = structuredClone(await loadMultiHopScenarioInputs(REPO_ROOT)) as LabScenarioInput[];
    const devQuery = templates.find((input) => input.split === 'dev')!.queries[0]!.query;
    templates.find((input) => input.split === 'holdout')!.queries[0]!.query = devQuery;
    expect(() => validateMultiHopScenarioInputs(templates)).toThrow(/query templates must be distinct|lexical skeleton/);
  });

  it('rejects n below ten, split substitution, and mismatched oracle identities', async () => {
    const inputs = structuredClone(await loadMultiHopScenarioInputs(REPO_ROOT)) as LabScenarioInput[];
    expect(() => validateMultiHopScenarioInputs(inputs.filter((_, index) => index !== 0)))
      .toThrow(/dev requires exactly 10/);

    const splitMutation = structuredClone(inputs);
    splitMutation[0]!.split = 'holdout';
    expect(() => validateMultiHopScenarioInputs(splitMutation)).toThrow(/dev requires exactly 10|duplicate scenario id|split/);

    const scenarios = await loadMultiHopScenariosForScoring('dev', REPO_ROOT);
    const devInputs = scenarios.map(({ input }) => input);
    const oracles = scenarios.map(({ oracle }) => structuredClone(oracle)) as LabScenarioOracle[];
    oracles[0]!.scenarioId = 'wrong-oracle-id';
    expect(() => pairMultiHopScenarios(devInputs, oracles, 'dev')).toThrow(/oracle ID\/order mismatch/);
  });

  it('keeps scorer-only loading out of public barrels and every adapter dependency graph', async () => {
    const barrel = await readFile(resolve(REPO_ROOT, 'bench/lab/index.ts'), 'utf8');
    expect(barrel).not.toMatch(/load-multihop|multihop\/scorer-only/);
    const registry = JSON.parse(await readFile(resolve(REPO_ROOT, 'bench/lab/registry/systems.json'), 'utf8')) as {
      systems: Array<{ adapter: string }>;
    };
    const adapters = [...new Set(registry.systems.map(({ adapter }) => adapter)
      .filter((entry) => entry.startsWith('bench/lab/adapters/')))];
    for (const entry of adapters) {
      const audit = await auditAdapterDependencies(resolve(REPO_ROOT, entry), REPO_ROOT);
      expect(audit.visited.map((path) => path.replace(/\\/g, '/')).join('\n'))
        .not.toMatch(/\/datasets\/load-multihop\.ts|\/multihop\/scorer-only\.ts/);
    }
  });

  it('keeps oracle artifact access exclusively in the scorer-only loading route', async () => {
    const source = await readFile(resolve(REPO_ROOT, 'bench/lab/datasets/load-multihop.ts'), 'utf8');
    const inputStart = source.indexOf('export async function loadMultiHopScenarioInputs');
    const scoringStart = source.indexOf('export async function loadMultiHopScenariosForScoring');
    assert.notEqual(inputStart, -1);
    assert.notEqual(scoringStart, -1);
    const inputRoute = source.slice(inputStart, scoringStart);
    const scoringRoute = source.slice(scoringStart);
    expect(inputRoute).toContain('.inputArtifacts');
    expect(inputRoute).not.toContain('.oracleArtifacts');
    expect(scoringRoute).toContain('.oracleArtifacts');
  });

  it('ratchets all non-test LAB-012 modules into the strict hosted typecheck', async () => {
    const pkg = JSON.parse(await readFile(resolve(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const command = pkg.scripts['bench:lab:typecheck'];
    assert.ok(command);
    for (const entry of [
      'bench/lab/datasets/load-multihop.ts',
      'bench/lab/multihop/scorer-only.ts',
      'bench/lab/multihop/policy.ts',
    ]) expect(command.split(/\s+/)).toContain(entry);
  });
});
