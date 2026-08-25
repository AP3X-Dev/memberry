// RET-007 v3 — knob-to-bytes custody (spec P1-1 / packet-ledger F1, BLOCKING):
// hash-only custody proves immutability, not provenance. This test re-emits
// ALL THREE committed splits from the frozen MULTIHOP_V3_KNOBS and asserts
// byte equality against the committed artifacts. Re-emitting holdout computes
// no per-case outcome and is not an inspection.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { LabScenarioInput } from '../../contracts/scenario.js';
import { validateMultiHopV3ScenarioInputs } from '../../datasets/load-multihop-v3.js';
import { generateMultiHopV3Split, multiHopV3OrderKey } from '../generate-v3.js';
import {
  MULTIHOP_V3_FREEZE,
  MULTIHOP_V3_KNOBS,
  MULTIHOP_V3_KNOB_BOUNDS,
  validateMultiHopV3Knobs,
  type MultiHopV3Knobs,
} from '../policy-v3.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const DATASET_ROOT = resolve(REPO_ROOT, 'bench', 'lab', 'datasets', 'multihop', 'v3');
const SPLITS = ['calib', 'dev', 'holdout'] as const;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function knobs(overrides: Partial<{
  corpusSizePerScenario: number;
  bridgeTokenCollisions: Record<'low' | 'medium' | 'high', number>;
  domainLexicalOverlapShare: Record<'low' | 'medium' | 'high', number>;
  factTokenEcho: Record<'low' | 'medium' | 'high', number>;
}>): MultiHopV3Knobs {
  return { ...structuredClone(MULTIHOP_V3_KNOBS), ...overrides } as MultiHopV3Knobs;
}

describe('RET-007 v3 deterministic committed generator', () => {
  it('re-emits ALL THREE committed splits byte-identically from the frozen knobs', async () => {
    for (const split of SPLITS) {
      const generated = generateMultiHopV3Split(split, MULTIHOP_V3_KNOBS);
      const committedInput = await readFile(resolve(DATASET_ROOT, split, 'input.jsonl'), 'utf8');
      const committedOracle = await readFile(resolve(DATASET_ROOT, split, 'oracle.jsonl'), 'utf8');
      expect(generated.input, `${split} input bytes`).toBe(committedInput);
      expect(generated.oracle, `${split} oracle bytes`).toBe(committedOracle);
    }
  });

  it('binds the frozen dev/holdout artifact hashes and sizes to the committed bytes', async () => {
    for (const split of ['dev', 'holdout'] as const) {
      for (const role of ['input', 'oracle'] as const) {
        const bytes = await readFile(resolve(DATASET_ROOT, split, `${role}.jsonl`), 'utf8');
        expect(sha256(bytes)).toBe(MULTIHOP_V3_FREEZE.artifacts[split][role].sha256);
        expect(Buffer.byteLength(bytes, 'utf8')).toBe(MULTIHOP_V3_FREEZE.artifacts[split][role].sizeBytes);
      }
    }
    expect(sha256(MULTIHOP_V3_FREEZE.publicOrderSeed)).toBe(MULTIHOP_V3_FREEZE.seedCommitmentSha256);
  });

  it('is deterministic across repeated in-process emissions', () => {
    for (const split of SPLITS) {
      const first = generateMultiHopV3Split(split, MULTIHOP_V3_KNOBS);
      const second = generateMultiHopV3Split(split, MULTIHOP_V3_KNOBS);
      expect(second.input).toBe(first.input);
      expect(second.oracle).toBe(first.oracle);
    }
  });

  it('rejects knob values outside the pre-registered measured bounds', () => {
    expect(() => validateMultiHopV3Knobs(MULTIHOP_V3_KNOBS)).not.toThrow();
    expect(() => generateMultiHopV3Split('calib', knobs({ corpusSizePerScenario: 25 })))
      .toThrow(/corpusSizePerScenario is outside/);
    expect(() => generateMultiHopV3Split('calib', knobs({ corpusSizePerScenario: 10 })))
      .toThrow(/corpusSizePerScenario is outside/);
    expect(() => generateMultiHopV3Split('calib', knobs({ bridgeTokenCollisions: { low: 2, medium: 1, high: 2 } })))
      .toThrow(/bridgeTokenCollisions\.low is outside/);
    expect(() => generateMultiHopV3Split('calib', knobs({ factTokenEcho: { low: 0, medium: 1, high: 5 } })))
      .toThrow(/factTokenEcho\.high is outside/);
    expect(() => generateMultiHopV3Split('calib', knobs({ domainLexicalOverlapShare: { low: 0.3, medium: 0.4, high: 1.1 } })))
      .toThrow(/domainLexicalOverlapShare\.high is outside/);
    // The bounds themselves pin the measured v2 endpoints (measure-v2-knobs.output.txt).
    expect(MULTIHOP_V3_KNOB_BOUNDS.corpusSizePerScenario).toEqual({ min: 11, max: 24 });
    expect(MULTIHOP_V3_KNOB_BOUNDS.bridgeTokenCollisions).toEqual({
      low: { min: 0, max: 1 }, medium: { min: 0, max: 2 }, high: { min: 0, max: 2 },
    });
    expect(MULTIHOP_V3_KNOB_BOUNDS.factTokenEcho).toEqual({
      low: { min: 0, max: 2 }, medium: { min: 0, max: 2 }, high: { min: 0, max: 4 },
    });
    expect(MULTIHOP_V3_KNOB_BOUNDS.domainLexicalOverlapShare).toEqual({
      low: { min: 0, max: 1 }, medium: { min: 0, max: 1 }, high: { min: 0, max: 1 },
    });
  });

  it('emits scenarios that pass the full v3 loader lint battery and the frozen order derivation', () => {
    const inputs = SPLITS.flatMap((split) => (
      generateMultiHopV3Split(split, MULTIHOP_V3_KNOBS).input.split('\n').filter((line) => line.trim())
        .map((line) => JSON.parse(line) as LabScenarioInput)
    ));
    const validated = validateMultiHopV3ScenarioInputs(inputs);
    expect(validated).toHaveLength(55);
    for (const input of validated.slice(0, 3)) {
      const keys = [...input.memories]
        .sort((left, right) => (multiHopV3OrderKey(input.id, left.id) < multiHopV3OrderKey(input.id, right.id) ? -1 : 1))
        .map(({ id }) => id);
      expect(input.memories.map(({ id }) => id)).toEqual(keys);
    }
  });

  it('never consults ambient nondeterminism in the generator source', async () => {
    const source = await readFile(resolve(REPO_ROOT, 'bench/lab/multihop/generate-v3.ts'), 'utf8');
    expect(source).not.toMatch(/Math\.random\(|Date\.now\(|new Date\(/);
    expect(source).not.toMatch(/process\.env/);
  });
});
