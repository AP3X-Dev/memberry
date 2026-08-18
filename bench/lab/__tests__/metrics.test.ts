import { describe, expect, it } from 'vitest';
import { LAB_SCENARIO_VERSION, type LabProbeOracle, type LabScenarioInput } from '../contracts/scenario.js';
import { ndcgAtK, reciprocalRank, scoreProbe } from '../metrics.js';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAB_CONTRACT_VERSION } from '../contracts/adapter.js';
import type { ProbeReport } from '../contracts/report.js';
import {
  LAB_TOKEN_ESTIMATOR_ID,
  aggregateContextAccounting,
  averageMetrics,
  estimateLabTokens,
  probeContextTokens,
} from '../metrics.js';

const scenario: LabScenarioInput = {
  version: LAB_SCENARIO_VERSION,
  id: 'metric-fixture',
  split: 'dev',
  title: 'Metric fixture',
  description: 'Hand-computable fixture.',
  dimensions: ['recall'],
  tenant: 'tenant',
  project: 'project',
  memories: ['a', 'b', 'stale', 'forbidden', 'noise'].map((id) => ({
    id,
    content: id,
    recordedAt: '2026-01-01T00:00:00.000Z',
  })),
  queries: [],
};

const probe: LabProbeOracle = {
  probeId: 'probe',
  relevant: ['a', 'b'],
  required: ['a'],
  stale: ['stale'],
  forbidden: ['forbidden'],
};

describe('deterministic metrics', () => {
  it('matches hand-calculated rankings and safety rates', () => {
    const metrics = scoreProbe(scenario, probe, 4, [
      { id: 'noise', score: 4 },
      { id: 'a', score: 3 },
      { id: 'stale', score: 2 },
      { id: 'forbidden', score: 1 },
    ].slice(0, 4));
    expect(metrics.recallAtK).toBe(0.5);
    expect(metrics.precisionAtK).toBe(0.25);
    expect(metrics.reciprocalRank).toBe(0.5);
    expect(metrics.answerCoverage).toBe(1);
    expect(metrics.staleLeakRate).toBe(0.25);
    expect(metrics.isolationLeakRate).toBe(0.25);
    expect(metrics.staleSafety).toBe(0.75);
    expect(metrics.isolationSafety).toBe(0.75);
  });

  it('does not reward empty results for being leak-free', () => {
    const metrics = scoreProbe(scenario, probe, 4, []);
    expect(metrics.staleLeakRate).toBe(0);
    expect(metrics.isolationLeakRate).toBe(0);
    expect(metrics.answerCoverage).toBe(0);
    expect(metrics.staleSafety).toBe(0);
    expect(metrics.isolationSafety).toBe(0);
  });

  it('penalizes duplicate and unknown result ids', () => {
    const metrics = scoreProbe(scenario, probe, 4, [
      { id: 'a', score: 4 },
      { id: 'a', score: 3 },
      { id: 'not-in-corpus', score: 2 },
      { id: 'noise', score: 1 },
    ]);
    expect(metrics.duplicateRate).toBe(0.25);
    expect(metrics.unknownResultRate).toBe(0.25);
    expect(metrics.precisionAtK).toBe(0.25);
  });

  it('calculates reciprocal rank and nDCG deterministically', () => {
    expect(reciprocalRank(['noise', 'a', 'b'], new Set(['a', 'b']))).toBe(0.5);
    expect(ndcgAtK(['a', 'noise', 'b'], new Set(['a', 'b']), 3)).toBeCloseTo(0.9197207891, 8);
  });
});

function probeReport(answerCoverage: number, contextTokens: number): ProbeReport {
  return {
    probeId: 'probe',
    query: 'query',
    resultIds: [],
    metrics: { ...scoreProbe(scenario, probe, 4, []), answerCoverage },
    contextTokens,
  };
}

describe('context-token accounting', () => {
  it('estimates tokens as ceil(length / 4) under a versioned estimator id', () => {
    expect(LAB_TOKEN_ESTIMATOR_ID).toBe('chars-div-4-ceil-v1');
    expect(estimateLabTokens('')).toBe(0);
    expect(estimateLabTokens('x')).toBe(1);
    expect(estimateLabTokens('xxxx')).toBe(1);
    expect(estimateLabTokens('xxxxx')).toBe(2);
  });

  it('sums hand-counted fixture tokens over the deduplicated top-k ids', () => {
    // Fixture contents equal their ids: a=1 char, noise=5, stale=5 -> 1 + 2 + 2 tokens.
    expect(probeContextTokens(scenario, 4, [
      { id: 'a', score: 3 },
      { id: 'noise', score: 2 },
      { id: 'stale', score: 1 },
    ])).toBe(5);
  });

  it('counts duplicate ids once and unknown ids as zero tokens', () => {
    expect(probeContextTokens(scenario, 4, [
      { id: 'a', score: 4 },
      { id: 'a', score: 3 },
      { id: 'noise', score: 2 },
    ])).toBe(3);
    expect(probeContextTokens(scenario, 4, [
      { id: 'a', score: 2 },
      { id: 'not-in-corpus', score: 1 },
    ])).toBe(1);
  });

  it('ignores results beyond the probe limit', () => {
    expect(probeContextTokens(scenario, 2, [
      { id: 'a', score: 3 },
      { id: 'noise', score: 2 },
      { id: 'stale', score: 1 },
    ])).toBe(3);
  });

  it('types zero scored probes as unsupported, not zero efficiency', () => {
    const accounting = aggregateContextAccounting([]);
    expect(accounting.outcome).toBe('unsupported');
    expect(accounting.unsupportedReason).toBe('no-scored-probes');
    expect(accounting.taskSuccessPer1kTokens).toBeNull();
    expect(accounting.scoredProbes).toBe(0);
  });

  it('types zero context tokens as unsupported, never infinite efficiency', () => {
    const accounting = aggregateContextAccounting([probeReport(1, 0), probeReport(1, 0)]);
    expect(accounting.outcome).toBe('unsupported');
    expect(accounting.unsupportedReason).toBe('zero-context-tokens');
    expect(accounting.taskSuccessPer1kTokens).toBeNull();
    expect(accounting.contextTokens).toBe(0);
  });

  it('reports zero success over positive tokens as a measured zero', () => {
    const accounting = aggregateContextAccounting([probeReport(0, 25)]);
    expect(accounting.outcome).toBe('measured');
    expect(accounting.unsupportedReason).toBeUndefined();
    expect(accounting.taskSuccessPer1kTokens).toBe(0);
  });

  it('aggregates as a run-level ratio of sums stamped with the estimator id', () => {
    const accounting = aggregateContextAccounting([probeReport(1, 100), probeReport(1, 5)]);
    expect(accounting.estimatorId).toBe(LAB_TOKEN_ESTIMATOR_ID);
    expect(accounting.taskSuccessTotal).toBe(2);
    expect(accounting.contextTokens).toBe(105);
    expect(accounting.taskSuccessPer1kTokens).toBeCloseTo(2000 / 105, 10);
    // Mean-of-probe-ratios would be (1000/100 + 1000/5) / 2 = 105; ratio-of-sums differs.
    expect(Math.abs((accounting.taskSuccessPer1kTokens ?? 0) - 105)).toBeGreaterThan(1e-6);
  });
});

describe('measurement labeling and contract stability', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));

  it('never over-claims agent-level task success in metrics or report sources', async () => {
    const metricsSource = await readFile(resolve(HERE, '..', 'metrics.ts'), 'utf8');
    const reportSource = await readFile(resolve(HERE, '..', 'contracts', 'report.ts'), 'utf8');
    for (const source of [metricsSource, reportSource]) {
      expect(source).not.toMatch(/agent task success|measures task success/i);
      expect(source).toContain('deterministic-lab proxy');
    }
  });

  it('keeps the lab contract version and metric key set unchanged', () => {
    expect(LAB_CONTRACT_VERSION).toBe('1.0.0');
    expect(Object.keys(averageMetrics([]))).toEqual([
      'recallAtK', 'precisionAtK', 'reciprocalRank', 'ndcgAtK', 'answerCoverage',
      'staleLeakRate', 'isolationLeakRate', 'duplicateRate', 'unknownResultRate',
      'staleSafety', 'isolationSafety',
    ]);
  });
});
