import { describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_LEVEL,
  BOOTSTRAP_RESAMPLES,
  MIN_PAIRED_PROBES,
  fnv1a32,
  pairedEfficiencyInterval,
  pairedVectorSeed,
  percentileIndex,
  unsupportedEfficiencyInterval,
  type LabPairedProbe,
  type LabPairedBinaryOutcome,
  pairedBinaryMeanDeltaInterval,
} from '../stats.js';

function pair(index: number, overrides: Partial<LabPairedProbe> = {}): LabPairedProbe {
  return {
    scenarioId: `scenario-${index}`,
    probeId: `probe-${index}`,
    controlCoverage: 0.5,
    controlTokens: 40,
    candidateCoverage: 1,
    candidateTokens: 40,
    ...overrides,
  };
}

function pairs(count: number, overrides: Partial<LabPairedProbe> = {}): LabPairedProbe[] {
  return Array.from({ length: count }, (_, index) => pair(index, overrides));
}

describe('paired percentile bootstrap', () => {
  it('applies the exact Math.round(q*(B-1)) percentile index rule', () => {
    // Hand-computed: 0.025 * 1999 = 49.975 -> 50; 0.975 * 1999 = 1949.025 -> 1949.
    expect(percentileIndex(0.025, 2000)).toBe(50);
    expect(percentileIndex(0.975, 2000)).toBe(1949);
    // 0.05 * 1999 = 99.95 -> 100.
    expect(percentileIndex(0.05, 2000)).toBe(100);
    // Math.round half-up: 0.5 * 3 = 1.5 -> 2.
    expect(percentileIndex(0.5, 4)).toBe(2);
    // Clamped to [0, B-1].
    expect(percentileIndex(0, 5)).toBe(0);
    expect(percentileIndex(1, 5)).toBe(4);
  });

  it('is bit-reproducible with a seed derived from the paired data vector', () => {
    const data = pairs(12);
    const first = pairedEfficiencyInterval(data);
    const second = pairedEfficiencyInterval(data);
    expect(second).toEqual(first);
    expect(first.outcome).toBe('measured');
    expect(first.resamples).toBe(BOOTSTRAP_RESAMPLES);
    expect(first.level).toBe(BOOTSTRAP_LEVEL);
    const canonical = JSON.stringify(data.map((entry) => [
      entry.scenarioId,
      entry.probeId,
      entry.controlCoverage,
      entry.controlTokens,
      entry.candidateCoverage,
      entry.candidateTokens,
    ]));
    expect(first.seed).toBe(fnv1a32(canonical));
    expect(pairedVectorSeed(data)).toBe(fnv1a32(canonical));
  });

  it('enforces the paired-probe floor: n=9 unsupported, n=10 measured', () => {
    expect(MIN_PAIRED_PROBES).toBe(10);
    const nine = pairedEfficiencyInterval(pairs(9));
    expect(nine.outcome).toBe('unsupported');
    expect(nine.unsupportedReason).toBe('insufficient-paired-probes');
    expect(nine.pairedProbes).toBe(9);
    expect(nine.point).toBeNull();
    expect(nine.lower).toBeNull();
    expect(nine.upper).toBeNull();
    expect(nine.oneSidedLower).toBeNull();

    const ten = pairedEfficiencyInterval(pairs(10));
    expect(ten.outcome).toBe('measured');
    expect(ten.pairedProbes).toBe(10);
  });

  it('computes a sign-correct paired delta in both directions', () => {
    // Identical pairs: every resample statistic is exactly
    // 1000*(10/400) - 1000*(5/400) = 25 - 12.5 = 12.5.
    const better = pairedEfficiencyInterval(pairs(10));
    expect(better.point).toBe(12.5);
    expect(better.lower).toBe(12.5);
    expect(better.upper).toBe(12.5);
    expect(better.oneSidedLower).toBe(12.5);

    const swapped = pairedEfficiencyInterval(pairs(10).map((entry) => ({
      ...entry,
      controlCoverage: entry.candidateCoverage,
      controlTokens: entry.candidateTokens,
      candidateCoverage: entry.controlCoverage,
      candidateTokens: entry.controlTokens,
    })));
    expect(swapped.point).toBe(-12.5);
    expect(swapped.upper).toBe(-12.5);
  });

  it('types a zero-denominator resample as unsupported, never Infinity', () => {
    const interval = pairedEfficiencyInterval(pairs(10, { candidateTokens: 0 }));
    expect(interval.outcome).toBe('unsupported');
    expect(interval.unsupportedReason).toBe('zero-context-tokens');
    expect(interval.point).toBeNull();
    expect(interval.lower).toBeNull();
    expect(interval.upper).toBeNull();
    expect(interval.oneSidedLower).toBeNull();
    expect(interval.pairedProbes).toBe(10);
  });

  it('reports an unscored arm as unsupported with full provenance fields', () => {
    const interval = unsupportedEfficiencyInterval('arm-not-scored', []);
    expect(interval.outcome).toBe('unsupported');
    expect(interval.unsupportedReason).toBe('arm-not-scored');
    expect(interval.pairedProbes).toBe(0);
    expect(interval.resamples).toBe(BOOTSTRAP_RESAMPLES);
    expect(interval.level).toBe(BOOTSTRAP_LEVEL);
    expect(interval.seed).toBe(pairedVectorSeed([]));
    expect(interval.point).toBeNull();
  });
});

function binaryPair(
  index: number,
  controlOutcome: 0 | 1,
  candidateOutcome: 0 | 1,
): LabPairedBinaryOutcome {
  return { scenarioId: `binary-scenario-${index}`, probeId: `binary-probe-${index}`, controlOutcome, candidateOutcome };
}

describe('paired binary mean-delta bootstrap', () => {
  it('uses the frozen bootstrap constants and is bit-repeatable from its binary vector seed', () => {
    const pairs = Array.from({ length: 10 }, (_, index) => binaryPair(index, 0, 1));
    const first = pairedBinaryMeanDeltaInterval(pairs);
    expect(pairedBinaryMeanDeltaInterval(pairs)).toEqual(first);
    expect(first).toMatchObject({
      outcome: 'measured',
      pairedProbes: 10,
      resamples: 2000,
      level: 0.95,
      point: 1,
      lower: 1,
      upper: 1,
      oneSidedLower: 1,
    });
    expect(first.seed).toBe(fnv1a32(JSON.stringify(pairs.map((entry) => [
      entry.scenarioId, entry.probeId, entry.controlOutcome, entry.candidateOutcome,
    ]))));
  });

  it('reports all-win, all-tie, and all-loss signs exactly', () => {
    const vector = (control: 0 | 1, candidate: 0 | 1) => (
      Array.from({ length: 10 }, (_, index) => binaryPair(index, control, candidate))
    );
    expect(pairedBinaryMeanDeltaInterval(vector(0, 1)).point).toBe(1);
    expect(pairedBinaryMeanDeltaInterval(vector(1, 1)).point).toBe(0);
    expect(pairedBinaryMeanDeltaInterval(vector(1, 0)).point).toBe(-1);
  });

  it('keeps n=9 unsupported and n=10 measured', () => {
    const nine = Array.from({ length: 9 }, (_, index) => binaryPair(index, 0, 1));
    expect(pairedBinaryMeanDeltaInterval(nine)).toMatchObject({
      outcome: 'unsupported',
      unsupportedReason: 'insufficient-paired-probes',
      pairedProbes: 9,
      point: null,
      oneSidedLower: null,
    });
    expect(pairedBinaryMeanDeltaInterval([...nine, binaryPair(9, 0, 1)]).outcome).toBe('measured');
  });

  it('rejects duplicate pair identities and non-binary outcomes', () => {
    const pairs = Array.from({ length: 10 }, (_, index) => binaryPair(index, 0, 1));
    expect(() => pairedBinaryMeanDeltaInterval([...pairs.slice(0, 9), pairs[0]!]))
      .toThrow(/duplicate paired binary identity/);
    expect(() => pairedBinaryMeanDeltaInterval([
      ...pairs.slice(0, 9),
      { ...pairs[9]!, candidateOutcome: 0.5 as 0 },
    ])).toThrow(/binary outcomes must be 0 or 1/);
  });
});
