import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

import {
  G2_HOLDOUT_LANES,
  loadG2HoldoutScenarioInputs,
  loadG2HoldoutScenariosForScoring,
} from '../load-suite.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

/**
 * One compareRegisteredAdapters call is one aggregation unit: runner.ts:143,165
 * flatten every probe into an unweighted mean and metrics.ts:87-93 has no k
 * awareness, so a lane whose queries carry different limits reports a mixture
 * rather than recall@10 or precision@5. This assertion is what stops a later
 * fixture edit from silently reintroducing that mixture.
 */
test('each holdout lane scores exactly one k for every query in its selected set', async () => {
  for (const lane of G2_HOLDOUT_LANES) {
    const scenarios = await loadG2HoldoutScenariosForScoring(lane.dimension, REPO_ROOT);
    const limits = new Set(scenarios.flatMap(({ input }) => input.queries.map((query) => query.limit)));
    assert.deepEqual([...limits], [lane.limit], `${lane.dimension} lane must be uniform-k at ${lane.limit}`);
    for (const { input } of scenarios) assert.deepEqual([...input.dimensions], [lane.dimension]);
    const holdout = scenarios.filter(({ input }) => input.split === 'holdout');
    assert.equal(holdout.length, 10, `${lane.dimension} lane needs n >= 10 scored holdout scenarios`);
    assert.equal(holdout.reduce((sum, { oracle }) => sum + oracle.probes.length, 0), 10);
  }
});

/**
 * precisionAtK is relevantHits/returned (metrics.ts:60,68), so a probe that
 * returns fewer than five results reports P@returned and inflates the lane;
 * minAnswerCoverage gates required-set recall at the same k (metrics.ts:51),
 * which a relevant set larger than the limit cannot satisfy.
 */
test('every precision-lane probe can fill five slots and fit its relevant set inside them', async () => {
  const scenarios = await loadG2HoldoutScenariosForScoring('precision', REPO_ROOT);
  for (const { input, oracle } of scenarios) {
    assert.ok(input.memories.length >= 5, `${input.id} cannot return five results`);
    for (const probe of oracle.probes) {
      assert.ok(probe.relevant.length <= 5, `${probe.probeId} relevant set cannot fit in top 5`);
      assert.ok(probe.relevant.length >= 3, `${probe.probeId} would cap precision@5 below the 0.5 floor`);
    }
  }
});

test('the adapter-visible half of the suite carries no oracle labels', async () => {
  const inputs = await loadG2HoldoutScenarioInputs(REPO_ROOT);
  assert.doesNotMatch(JSON.stringify(inputs), /"(?:oracle|relevant|required|stale|forbidden)"\s*:/);
  assert.deepEqual([...new Set(inputs.map(({ split }) => split))].sort(), ['dev', 'holdout']);
});

test('the scorer-side suite loader stays out of the public lab barrel', async () => {
  const barrel = await readFile(resolve(REPO_ROOT, 'bench/lab/index.ts'), 'utf8');
  assert.doesNotMatch(barrel, /load-suite/);
});
