import { describe, expect, it } from 'vitest';

import type { AdapterRunReport, ComparisonReport, ProbeMetrics } from '../../contracts/report.js';
import type { LabScenario } from '../../contracts/scenario.js';
import { loadMultiHopScenariosForScoring } from '../../datasets/load-multihop.js';
import { averageMetrics, scoreProbe } from '../../metrics.js';
import { pairedBinaryMeanDeltaInterval } from '../../stats.js';
import { evaluateMultiHopPolicy } from '../policy.js';
import { scoreMultiHopComparison } from '../scorer-only.js';

const ZERO_STATS = { memories: 0, queries: 0, feedbackEvents: 0 };

const CHAIN_AUDIT = {
  'mh-dev-01': ['seedling batch alder', 'seedling batch alder', 'greenhouse bay seven', 'greenhouse bay seven', 'cistern north'],
  'mh-dev-02': ['fabric roll saffron', 'fabric roll saffron', 'depot loom three', 'depot loom three', 'dock amber'],
  'mh-dev-03': ['observer mira', 'observer mira', 'telescope orion', 'telescope orion', 'dawn'],
  'mh-dev-04': ['tutor niko', 'tutor niko', 'classroom cedar', 'classroom cedar', 'tuesday'],
  'mh-dev-05': ['kiln atlas', 'kiln atlas', 'sensor quartz', 'sensor quartz', 'ceramic shield'],
  'mh-dev-06': ['organ echo', 'organ echo', 'pedal linden', 'pedal linden', 'brass spring'],
  'mh-dev-07': ['tablet iris', 'tablet iris', 'archive west', 'archive west', 'cotton gloves'],
  'mh-dev-08': ['manuscript lark', 'manuscript lark', 'curator sela', 'curator sela', 'blue sleeves'],
  'mh-dev-09': ['buoy kestrel', 'buoy kestrel', 'station harbor nine', 'station harbor nine', 'desk coral'],
  'mh-dev-10': ['oven juniper', 'oven juniper', 'crew maple', 'crew maple', 'counter east'],
  'mh-holdout-01': ['sample opal', 'sample opal', 'cavern ridge four', 'cavern ridge four', 'vault silver'],
  'mh-holdout-02': ['crates of pears', 'pear crates', 'pantry willow', 'pantry willow', 'hatch copper'],
  'mh-holdout-03': ['intern ivo', 'intern ivo', 'ward heron', 'ward heron', 'half past six'],
  'mh-holdout-04': ['actor uma', 'uma', 'stage blue', 'stage blue', 'thursday evening'],
  'mh-holdout-05': ['brake assembly', 'brake assembly', 'cable called fern', 'cable fern', 'graphite lubricant'],
  'mh-holdout-06': ['scope vela', 'scope vela', 'lens pearl', 'lens pearl', 'amber coating'],
  'mh-holdout-07': ['map rill', 'map rill', 'vault keeper oren', 'vault keeper oren', 'green transfer sleeve'],
  'mh-holdout-08': ['coin set mica', 'coin set mica', 'steward pia', 'steward pia', 'humidity log'],
  'mh-holdout-09': ['sensor gale', 'sensor gale', 'team nimbus', 'team nimbus', 'console rain'],
  'mh-holdout-10': ['pump delta', 'pump delta', 'technician noor', 'technician noor', 'terminal tide'],
} as const satisfies Record<string, readonly [string, string, string, string, string]>;

function sentenceSkeleton(value: string): string {
  return value.replace(/\b[A-Z][A-Za-z0-9'-]*\b/g, '<slot>').replace(/\b\d+\b/g, '<slot>')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

function scenarios(count = 10, split: 'dev' | 'holdout' = 'holdout'): LabScenario[] {
  return Array.from({ length: count }, (_, index) => {
    const prefix = `unit-${split}-${index}`;
    const memories = Array.from({ length: 11 }, (__, memoryIndex) => ({
      id: `${prefix}-memory-${memoryIndex}`,
      content: `Synthetic domain-neutral statement ${memoryIndex} for ${prefix}.`,
      recordedAt: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    }));
    return {
      input: {
        version: '1.0.0', id: prefix, split,
        title: 'Synthetic multi-hop unit scenario',
        description: 'Authored before RET-007; no product result informed these bytes.',
        dimensions: ['multi-hop'], tenant: 'synthetic-tenant', project: prefix,
        memories, queries: [{ id: `${prefix}-probe`, query: 'combine the two synthetic statements', limit: 10 }],
        tags: ['synthetic', 'lab-012-pre-ret007'],
      },
      oracle: {
        version: '1.0.0', scenarioId: prefix,
        probes: [{
          probeId: `${prefix}-probe`,
          relevant: [memories[0]!.id, memories[1]!.id],
          required: [memories[0]!.id, memories[1]!.id],
        }],
      },
    };
  });
}

type ResultMode = 'complete' | 'partial' | 'beyond-k' | 'unknown';

function resultIds(scenario: LabScenario, mode: ResultMode): string[] {
  const ids = scenario.input.memories.map(({ id }) => id);
  if (mode === 'complete') return [ids[0]!, ids[1]!, ...ids.slice(2, 10)];
  if (mode === 'partial') return [ids[0]!, ...ids.slice(2, 11)];
  if (mode === 'beyond-k') return [ids[0]!, ...ids.slice(2, 11), ids[1]!];
  return [ids[0]!, ids[1]!, ...ids.slice(2, 9), 'unknown-result-id'];
}

function arm(adapterId: string, fixtures: readonly LabScenario[], mode: ResultMode): AdapterRunReport {
  const scenarioReports = fixtures.map((scenario) => {
    const query = scenario.input.queries[0]!;
    const oracle = scenario.oracle.probes[0]!;
    const ids = resultIds(scenario, mode);
    const metrics = scoreProbe(
      scenario.input,
      oracle,
      query.limit,
      ids.map((id) => ({ id, score: 0 })),
    );
    return {
      scenarioId: scenario.input.id,
      split: scenario.input.split,
      dimensions: scenario.input.dimensions,
      capabilityGaps: [],
      outcome: 'scored' as const,
      probes: [{ probeId: query.id, query: query.query, resultIds: ids, metrics }],
      metrics,
    };
  });
  return {
    contractVersion: '1.0.0', runId: `run-${adapterId}`, adapterId, adapterName: adapterId,
    executionMode: 'fixture', health: 'ready', outcome: 'scored', excludedScenarios: [],
    scenarioReports, metrics: averageMetrics(scenarioReports.map(({ metrics }) => metrics)),
    stats: ZERO_STATS, gateFailures: [], passed: true,
  };
}

function comparison(
  fixtures: readonly LabScenario[],
  controlMode: ResultMode,
  candidateMode: ResultMode,
): ComparisonReport {
  const control = arm('control-v1', fixtures, controlMode);
  const candidate = arm('candidate-v1', fixtures, candidateMode);
  const metrics = Object.keys(control.metrics) as Array<keyof ProbeMetrics>;
  return {
    runId: 'lab-012-unit', evidenceMode: 'registered-ci', control, candidate,
    deltas: metrics.map((metric) => ({
      metric, control: control.metrics[metric], candidate: candidate.metrics[metric],
      delta: candidate.metrics[metric] - control.metrics[metric],
    })),
    failures: [], passed: true,
  };
}

describe('LAB-012 scorer-only strict multi-hop metric', () => {
  it('audits genuine A-to-B-to-C chains and required-sentence template diversity behind scorer access', async () => {
    const fixtures = [
      ...await loadMultiHopScenariosForScoring('dev'),
      ...await loadMultiHopScenariosForScoring('holdout'),
    ];
    expect(new Set(fixtures.map(({ input }) => input.id))).toEqual(new Set(Object.keys(CHAIN_AUDIT)));
    const templates = new Map<'dev' | 'holdout', string[]>([['dev', []], ['holdout', []]]);
    for (const scenario of fixtures) {
      const [aFact, aQuery, bFact1, bFact2, c] = CHAIN_AUDIT[scenario.input.id as keyof typeof CHAIN_AUDIT];
      const requiredIds = scenario.oracle.probes[0]!.required!;
      expect(requiredIds).toHaveLength(2);
      const required = requiredIds.map((id) => scenario.input.memories.find((memory) => memory.id === id)!);
      const fact1 = required.find(({ content }) => content.toLowerCase().includes(aFact))!;
      const fact2 = required.find(({ id }) => id !== fact1.id)!;
      const first = fact1.content.toLowerCase();
      const second = fact2.content.toLowerCase();
      const query = scenario.input.queries[0]!.query.toLowerCase();
      expect(first).toContain(bFact1);
      expect(first).not.toContain(c);
      expect(second).toContain(bFact2);
      expect(second).toContain(c);
      expect(second).not.toContain(aFact);
      expect(query).toContain(aQuery);
      expect(query).not.toContain(c);
      const distractors = scenario.input.memories.filter(({ id }) => !requiredIds.includes(id));
      for (const { content } of distractors) {
        const text = content.toLowerCase();
        const hasBridge = text.includes(bFact1) || text.includes(bFact2);
        expect((text.includes(aFact) && hasBridge) || (hasBridge && text.includes(c))).toBe(false);
      }
      templates.get(scenario.input.split)!.push(...required.map(({ content }) => sentenceSkeleton(content)));
    }
    for (const split of ['dev', 'holdout'] as const) {
      const counts = new Map<string, number>();
      for (const template of templates.get(split)!) counts.set(template, (counts.get(template) ?? 0) + 1);
      expect(counts.size).toBeGreaterThanOrEqual(5);
      expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
    }
    const devTemplates = new Set(templates.get('dev'));
    expect(templates.get('holdout')!.some((template) => devTemplates.has(template))).toBe(false);
  });

  it('counts success only when every required hop is inside top ten and returns a frozen aggregate', () => {
    const fixtures = scenarios();
    const report = scoreMultiHopComparison(fixtures, comparison(fixtures, 'partial', 'complete'));
    expect(report).toMatchObject({
      metric: 'strict-multi-hop-task-success-v1', split: 'holdout', k: 10, n: 10,
      controlAdapterId: 'control-v1', candidateAdapterId: 'candidate-v1',
      controlSuccessRate: 0, candidateSuccessRate: 1, delta: 1,
    });
    expect(report.interval).toMatchObject({ outcome: 'measured', point: 1, oneSidedLower: 1 });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.interval)).toBe(true);
    expect(Object.keys(report)).toEqual([
      'metric', 'split', 'k', 'n', 'controlAdapterId', 'candidateAdapterId',
      'controlSuccessRate', 'candidateSuccessRate', 'delta', 'interval',
    ]);
    expect(Object.keys(report.interval)).toEqual([
      'outcome', 'pairedProbes', 'resamples', 'level', 'point', 'lower', 'upper', 'oneSidedLower',
    ]);
    expect(JSON.stringify(report)).not.toMatch(
      /seed|scenarioId|probeId|query|resultIds|required|relevant|oracle|unit-holdout|memory-0|combine the two/i,
    );
    expect(evaluateMultiHopPolicy(report, comparison(fixtures, 'partial', 'complete'))).toEqual([]);
  });

  it('does not expose internal binary-vector seeds or ordering through equal approved aggregates', () => {
    const ordered = scenarios();
    const reversed = [...ordered].reverse();
    const internalOrdered = pairedBinaryMeanDeltaInterval(ordered.map((scenario) => ({
      scenarioId: scenario.input.id, probeId: scenario.input.queries[0]!.id,
      controlOutcome: 0, candidateOutcome: 1,
    })));
    const internalReversed = pairedBinaryMeanDeltaInterval(reversed.map((scenario) => ({
      scenarioId: scenario.input.id, probeId: scenario.input.queries[0]!.id,
      controlOutcome: 0, candidateOutcome: 1,
    })));
    expect(internalOrdered.seed).not.toBe(internalReversed.seed);
    const orderedPublic = scoreMultiHopComparison(ordered, comparison(ordered, 'partial', 'complete'));
    const reversedPublic = scoreMultiHopComparison(reversed, comparison(reversed, 'partial', 'complete'));
    expect(orderedPublic).toEqual(reversedPublic);
    expect('seed' in orderedPublic.interval).toBe(false);
  });

  it('does not promote fractional answer coverage or a required hop beyond k into success', () => {
    const fixtures = scenarios();
    const partial = comparison(fixtures, 'partial', 'partial');
    expect(partial.candidate.metrics.answerCoverage).toBe(0.5);
    expect(scoreMultiHopComparison(fixtures, partial).candidateSuccessRate).toBe(0);
    expect(scoreMultiHopComparison(fixtures, comparison(fixtures, 'partial', 'beyond-k')).candidateSuccessRate).toBe(0);
  });

  it('keeps n=9 unsupported and n=10 measured', () => {
    const nine = scenarios(9);
    const unsupported = scoreMultiHopComparison(nine, comparison(nine, 'partial', 'complete')).interval;
    expect(unsupported.outcome).toBe('unsupported');
    expect(Object.keys(unsupported)).toEqual([
      'outcome', 'unsupportedReason', 'pairedProbes', 'resamples', 'level',
      'point', 'lower', 'upper', 'oneSidedLower',
    ]);
    const ten = scenarios(10);
    expect(scoreMultiHopComparison(ten, comparison(ten, 'partial', 'complete')).interval.outcome).toBe('measured');
  });

  it('fails closed on duplicate, reordered, split-mismatched, and oracle-mismatched pairs', () => {
    const fixtures = scenarios();
    const duplicate = comparison(fixtures, 'partial', 'complete');
    duplicate.control.scenarioReports = [duplicate.control.scenarioReports[0]!, ...duplicate.control.scenarioReports.slice(0, 9)];
    expect(() => scoreMultiHopComparison(fixtures, duplicate)).toThrow(/control scenario ID\/order mismatch/);

    const reordered = comparison(fixtures, 'partial', 'complete');
    reordered.candidate.scenarioReports = [...reordered.candidate.scenarioReports].reverse();
    expect(() => scoreMultiHopComparison(fixtures, reordered)).toThrow(/candidate scenario ID\/order mismatch/);

    const splitMismatch = comparison(fixtures, 'partial', 'complete');
    splitMismatch.candidate.scenarioReports[0]!.split = 'dev';
    expect(() => scoreMultiHopComparison(fixtures, splitMismatch)).toThrow(/split mismatch/);

    const badOracle = structuredClone(fixtures);
    badOracle[0]!.oracle.scenarioId = 'wrong-oracle';
    expect(() => scoreMultiHopComparison(badOracle, comparison(fixtures, 'partial', 'complete'))).toThrow(/oracle scenario ID mismatch/);

    const invalidSplit = structuredClone(fixtures);
    invalidSplit[0]!.input.split = 'hostile-private-split' as 'holdout';
    expect(() => scoreMultiHopComparison(invalidSplit, comparison(fixtures, 'partial', 'complete')))
      .toThrow(/^multi-hop scorer requires a valid split$/);
  });

  it('policy rejects ties, losses, insufficient n, and every standard regression', () => {
    const fixtures = scenarios();
    const tieComparison = comparison(fixtures, 'complete', 'complete');
    const tie = scoreMultiHopComparison(fixtures, tieComparison);
    expect(evaluateMultiHopPolicy(tie, tieComparison)).toContain('point-delta-not-positive');

    const lossComparison = comparison(fixtures, 'complete', 'partial');
    const loss = scoreMultiHopComparison(fixtures, lossComparison);
    expect(evaluateMultiHopPolicy(loss, lossComparison)).toEqual(expect.arrayContaining([
      'point-delta-not-positive', 'one-sided-lower-below-zero', 'quality-regression:answerCoverage',
    ]));

    const nine = scenarios(9);
    const nineComparison = comparison(nine, 'partial', 'complete');
    expect(evaluateMultiHopPolicy(scoreMultiHopComparison(nine, nineComparison), nineComparison))
      .toContain('insufficient-paired-probes');

    const safetyComparison = comparison(fixtures, 'complete', 'unknown');
    const safety = scoreMultiHopComparison(fixtures, safetyComparison);
    expect(evaluateMultiHopPolicy(safety, safetyComparison)).toContain('safety-regression:unknownResultRate');
  });
});
