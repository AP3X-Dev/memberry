// MEM-002 seal-time packet: input/oracle alignment by scenario id and count
// ONLY (spec 1.3 acceptance, oracle-blind form). Each oracle line is parsed as
// JSON and ONLY its scenarioId/split keys are ever read; the dimensions object
// (the sealed labels) is never touched, printed, or carried into any assertion
// message.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadAdmissionFeatureInputsV3 } from '../../inputs-v3.js';
import { ADMISSION_FEATURE_ORACLE_PATHS_V3 } from '../load-v3.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..', '..');

async function oracleIdentities(
  split: 'dev' | 'holdout',
): Promise<readonly { scenarioId: string; split: string }[]> {
  const content = await readFile(resolve(REPO_ROOT, ADMISSION_FEATURE_ORACLE_PATHS_V3[split]), 'utf8');
  return content
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      // Identity projection only: no other key of the record is ever read.
      return { scenarioId: String(record.scenarioId), split: String(record.split) };
    });
}

describe('MEM-002 v3 input/oracle alignment (id and count only)', () => {
  it('aligns each split by exact scenario-id sequence and count', async () => {
    const inputs = await loadAdmissionFeatureInputsV3(['dev', 'holdout']);
    for (const split of ['dev', 'holdout'] as const) {
      const inputIds = inputs.filter((input) => input.split === split).map(({ scenarioId }) => scenarioId);
      const oracles = await oracleIdentities(split);
      expect(oracles).toHaveLength(inputIds.length);
      expect(oracles.every((oracle) => oracle.split === split)).toBe(true);
      expect(oracles.map(({ scenarioId }) => scenarioId)).toEqual(inputIds);
    }
  });
});
