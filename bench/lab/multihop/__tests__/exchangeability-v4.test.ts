// RET-007 v4 — exchangeability report determinism + headroom H computation on a synthetic calib.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { AdapterRunReport } from '../../contracts/report.js';
import type { LabScenario } from '../../contracts/scenario.js';
import { averageMetrics, scoreProbe } from '../../metrics.js';
import { computeMultiHopV4CalibDiagnostics } from '../calibrate-v4.js';
import { computeMultiHopV4ExchangeabilityReport, twoProportionTest } from '../exchangeability-v4.js';
import { MULTIHOP_V4_CALIB_ACCEPTANCE } from '../policy-v4.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const ZERO_STATS = { memories: 0, queries: 0, feedbackEvents: 0 };

function scenario(id: string, density: string, contents: readonly string[], query: string, bIndex = 1): LabScenario {
  const memories = contents.map((content, index) => ({ id: `${id}-m-${index}`, content, recordedAt: '2026-08-01T00:00:00.000Z' }));
  const required = [memories[0]!.id, memories[bIndex]!.id];
  return {
    input: {
      version: '1.0.0', id, split: 'calib' as never, title: 'synthetic', description: 'synthetic',
      dimensions: ['multi-hop'], tenant: 't', project: id, memories,
      queries: [{ id: `${id}-probe`, query, limit: 10 }],
      tags: ['synthetic', `density:${density}`],
    },
    oracle: { version: '1.0.0', scenarioId: id, probes: [{ probeId: `${id}-probe`, relevant: required, required }] },
  };
}

function report(fixtures: readonly LabScenario[], successes: readonly boolean[]): AdapterRunReport {
  const scenarioReports = fixtures.map((fixture, index) => {
    const required = fixture.oracle.probes[0]!.required!;
    const others = fixture.input.memories.map(({ id }) => id).filter((id) => !required.includes(id));
    const resultIds = successes[index] ? [...required, ...others.slice(0, 8)] : [required[0]!, ...others.slice(0, 9)];
    const query = fixture.input.queries[0]!;
    const metrics = scoreProbe(fixture.input, fixture.oracle.probes[0]!, 10, resultIds.map((id) => ({ id, score: 0 })));
    return {
      scenarioId: fixture.input.id, split: fixture.input.split, dimensions: fixture.input.dimensions,
      capabilityGaps: [], outcome: 'scored' as const,
      probes: [{ probeId: query.id, query: query.query, resultIds, metrics }], metrics,
    };
  });
  return {
    contractVersion: '1.0.0', runId: 'synthetic', adapterId: 'memberry-retrieval-core-funnel-v1', adapterName: 'x',
    executionMode: 'fixture', health: 'ready', outcome: 'scored', excludedScenarios: [], scenarioReports,
    metrics: averageMetrics(scenarioReports.map(({ metrics }) => metrics)), stats: ZERO_STATS, gateFailures: [], passed: true,
  };
}

describe('RET-007 v4 exchangeability report and headroom diagnostic', () => {
  it('computes a two-proportion z-test with the expected reference values', () => {
    expect(twoProportionTest(10, 20, 10, 20)).toMatchObject({ p1: 0.5, p2: 0.5, z: 0 });
    expect(twoProportionTest(10, 20, 10, 20).pValue).toBeCloseTo(1, 6);
    const strong = twoProportionTest(20, 20, 0, 20);
    expect(strong.z).toBeCloseTo(6.3246, 3);
    expect(strong.pValue).toBeLessThan(1e-6);
    const mild = twoProportionTest(22, 45, 33, 60);
    expect(Math.abs(mild.z)).toBeLessThan(1.96);
    expect(mild.pValue).toBeGreaterThan(0.05);
    expect(() => twoProportionTest(1, 0, 1, 1)).toThrow(/positive sample sizes/);
  });

  it('computes H, score-driven share, and tie straddles on a synthetic calib', () => {
    const query = 'alpha beta gamma';
    // Scenario 1: B has no probe tokens; 13 others score above it -> withheld, score-driven.
    const s1 = scenario('s1', 'low', [
      'alpha beta gamma delta', 'zeta omega',
      // Distinct lengths -> distinct BM25 scores -> no ties at the boundary.
      ...Array.from({ length: 13 }, (_, index) => `alpha ${Array.from({ length: index + 1 }, (__, j) => `fill${j}`).join(' ')}`),
    ], query);
    // Scenario 2: corpus of 12 -> everything emitted (no boundary).
    const s2 = scenario('s2', 'medium', [
      'alpha beta gamma delta', 'zeta omega',
      ...Array.from({ length: 10 }, (_, index) => `alpha ${'y'.repeat(index + 2)}`),
    ], query);
    // Scenario 3: B ties three others at the boundary (identical token structure); B sits last in
    // corpus order -> withheld by tie, NOT score-driven; ties straddle the boundary.
    const s3 = scenario('s3', 'high', [
      'alpha beta gamma delta',
      ...Array.from({ length: 10 }, (_, index) => `alpha beta ${'q'.repeat(index + 2)}`),
      'alpha qa', 'alpha qb', 'alpha qc',
      'alpha zz',
    ], query, 14);
    const fixtures = [s1, s2, s3];
    const diagnostics = computeMultiHopV4CalibDiagnostics(fixtures, report(fixtures, [false, true, false]));
    expect(diagnostics.n).toBe(3);
    expect(diagnostics.successes).toBe(1);
    expect(diagnostics.bWithheld).toBe(2);
    expect(diagnostics.headroom).toBeCloseTo(2 / 3, 10);
    expect(diagnostics.scoreDrivenWithheld).toBe(1);
    expect(diagnostics.scoreDrivenShare).toBeCloseTo(0.5, 10);
    expect(diagnostics.scenarios.map(({ bEmitted }) => bEmitted)).toEqual([false, true, false]);
    expect(diagnostics.scenarios[0]).toMatchObject({ bWithholdingScoreDriven: true, tiedAtBoundary: 1, tiesStraddlingBoundary: 0 });
    expect(diagnostics.scenarios[1]).toMatchObject({ bWithholdingScoreDriven: null, tiedAtBoundary: 0 });
    expect(diagnostics.scenarios[2]!.bWithholdingScoreDriven).toBe(false);
    expect(diagnostics.scenarios[2]!.tiedAtBoundary).toBeGreaterThanOrEqual(2);
    expect(diagnostics.scenarios[2]!.tiesStraddlingBoundary).toBeGreaterThanOrEqual(1);
    expect(diagnostics.tieSummary.scenariosWithStraddle).toBe(1);
    expect(diagnostics.accepted).toBe(false);
    expect(diagnostics.failures).toEqual(expect.arrayContaining(['headroom-not-score-driven']));
    expect(MULTIHOP_V4_CALIB_ACCEPTANCE).toEqual({
      minimumSuccessRateInclusive: 0.42, maximumSuccessRateInclusive: 0.58,
      minimumSuccessesPerStratumInclusive: 3, minimumFailuresPerStratumInclusive: 3,
      minimumHeadroomInclusive: 0.25, minimumScoreDrivenShareInclusive: 0.8, headroomLedgerFlagBelow: 0.3,
    });
  });

  it('regenerates the committed exchangeability report byte-identically from the frozen bytes', async () => {
    const committed = await readFile(resolve(REPO_ROOT, 'bench/lab/multihop/EXCHANGEABILITY-V4.md'), 'utf8');
    const regenerated = await computeMultiHopV4ExchangeabilityReport(REPO_ROOT);
    expect(regenerated).toBe(committed);
    expect(committed).toContain('CALIB-ONLY');
    expect(committed).toContain('DEFERRED to D3');
    expect(committed).toMatch(/headroom H = 14\/45 = 0\.3111/);
    expect(committed).not.toMatch(/mh4-(d|h|t)-\d+/);
  }, 120_000);
});
