// packages/core/src/__tests__/confidence-calibration.test.ts
//
// MEM-004 acceptance surface for the reliability report (MEM-FR-5): pooled
// bin math, calibration-error metrics, observation gating, determinism, and
// the full contract-hostility battery in the MEM-003 conventions.
import { describe, expect, it } from 'vitest';

// Package-index import proves no export-* ambiguity from index.ts (Task 4).
import { observedCorrectnessV1 } from '@memberry/core';

import {
  CALIBRATION_BIN_COUNT,
  CALIBRATION_CONTRACT_VERSION,
  CALIBRATION_ENV_CONTRADICTION_WEIGHT,
  CALIBRATION_ENV_CORRECTION_WEIGHT,
  CALIBRATION_ENV_MIN_SIGNAL_WEIGHT,
  CALIBRATION_ENV_REINFORCEMENT_WEIGHT,
  CalibrationContractError,
  DEFAULT_CALIBRATION_CONFIG,
  buildReliabilityReportV1,
  calibrationConfigIdentityV1,
  canonicalCalibrationConfigV1,
  confidenceToPermille,
  parseCalibrationConfigV1,
  parseCalibrationObservationV1,
  reportIdentityV1,
  resolveCalibrationConfig,
  type CalibrationConfigV1,
  type CalibrationObservationV1,
} from '../confidence-calibration.js';

function obs(
  confidencePermille: number,
  reinforcements: number,
  corrections: number,
  contradictions: number,
): CalibrationObservationV1 {
  return { confidencePermille, reinforcements, corrections, contradictions };
}

function config(overrides: {
  reinforcement?: number;
  correction?: number;
  contradiction?: number;
  minSignalWeight?: number;
} = {}): CalibrationConfigV1 {
  return {
    signalWeights: {
      reinforcement: overrides.reinforcement ?? DEFAULT_CALIBRATION_CONFIG.signalWeights.reinforcement,
      correction: overrides.correction ?? DEFAULT_CALIBRATION_CONFIG.signalWeights.correction,
      contradiction: overrides.contradiction ?? DEFAULT_CALIBRATION_CONFIG.signalWeights.contradiction,
    },
    minSignalWeight: overrides.minSignalWeight ?? DEFAULT_CALIBRATION_CONFIG.minSignalWeight,
  };
}

function expectError(fn: () => unknown, code: string, field: string): void {
  try {
    fn();
    throw new Error('expected contract rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(CalibrationContractError);
    expect(error).toMatchObject({ code, field });
    expect(String(error)).not.toContain('777');
  }
}

// ─── 1. Reliability report correctness (hand-computed fixture) ───────────────

describe('buildReliabilityReportV1 — hand-computed fixture', () => {
  // Default weights {reinforcement 10, correction 50, contradiction 30}, min 10.
  // A: 850‰, 9r/1c → correct 90, incorrect 50, oc = round(90000/140) = 643, bin 8
  // B: 880‰, 4r     → correct 40, oc = 1000, bin 8
  // C: 120‰, 1r/1c  → correct 10, incorrect 50, oc = round(10000/60) = 167, bin 1
  // D: 300‰, no signals → unobserved
  const fixture = [obs(850, 9, 1, 0), obs(880, 4, 0, 0), obs(120, 1, 1, 0), obs(300, 0, 0, 0)];
  const report = buildReliabilityReportV1(fixture, DEFAULT_CALIBRATION_CONFIG);

  it('carries contract version, config identity, and counts', () => {
    expect(report.contractVersion).toBe(CALIBRATION_CONTRACT_VERSION);
    expect(report.configIdentity).toBe(calibrationConfigIdentityV1(DEFAULT_CALIBRATION_CONFIG));
    expect(report.totalCount).toBe(4);
    expect(report.observedCount).toBe(3);
    expect(report.unobservedCount).toBe(1);
    expect(report.bins).toHaveLength(CALIBRATION_BIN_COUNT);
  });

  it('pools bin 8 over integer weight sums, never averaging rounded values', () => {
    // Pooled: round(1000·(90+40)/(140+40)) = round(722.22…) = 722.
    // Averaging per-node rounded values would give round((643+1000)/2) = 822.
    expect(report.bins[8]).toEqual({
      lowerPermille: 800,
      upperPermille: 900,
      observedCount: 2,
      meanPredictedPermille: 865,
      observedCorrectPermille: 722,
      gapPermille: 143,
      empty: false,
    });
  });

  it('reports the singleton bin 1 with a signed negative gap', () => {
    expect(report.bins[1]).toEqual({
      lowerPermille: 100,
      upperPermille: 200,
      observedCount: 1,
      meanPredictedPermille: 120,
      observedCorrectPermille: 167,
      gapPermille: -47,
      empty: false,
    });
  });

  it('emits closed null-free sentinels for empty bins', () => {
    expect(report.bins[0]).toEqual({
      lowerPermille: 0,
      upperPermille: 100,
      observedCount: 0,
      meanPredictedPermille: 50,
      observedCorrectPermille: 50,
      gapPermille: 0,
      empty: true,
    });
    expect(report.bins[9]!.empty).toBe(true);
    expect(report.bins[9]!.meanPredictedPermille).toBe(950);
  });

  it('computes ECE, maxGap, and Brier exactly in integer permille', () => {
    // ECE = round((1·47 + 2·143)/3) = round(111) = 111
    expect(report.expectedCalibrationErrorPermille).toBe(111);
    expect(report.maxCalibrationGapPermille).toBe(143);
    // Brier = round((207² + 120² + 47²)/(1000·3)) = round(59458/3000) = 20
    expect(report.brierPermille).toBe(20);
  });

  it('deep-freezes the report and its bins', () => {
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.bins)).toBe(true);
    expect(Object.isFrozen(report.bins[8])).toBe(true);
  });

  it('assigns confidencePermille 1000 to the last bin (half-open grid, closed top)', () => {
    const r = buildReliabilityReportV1([obs(1000, 1, 0, 0)], DEFAULT_CALIBRATION_CONFIG);
    expect(r.bins[9]!.observedCount).toBe(1);
    expect(r.bins[9]!.empty).toBe(false);
  });
});

// ─── 2. Perfect calibration ──────────────────────────────────────────────────

describe('perfect calibration', () => {
  it('yields zero gap in every bin and ECE 0', () => {
    // 500‰ nodes at 5r/1c → 50/(50+50) = 500‰; 750‰ node at 15r/1c → 150/200 = 750‰.
    const report = buildReliabilityReportV1(
      [obs(500, 5, 1, 0), obs(500, 5, 1, 0), obs(750, 15, 1, 0)],
      DEFAULT_CALIBRATION_CONFIG,
    );
    for (const bin of report.bins) expect(bin.gapPermille).toBe(0);
    expect(report.expectedCalibrationErrorPermille).toBe(0);
    expect(report.maxCalibrationGapPermille).toBe(0);
  });
});

// ─── 3. Systematic overconfidence ────────────────────────────────────────────

describe('systematic overconfidence', () => {
  it('shows gap +400 in the 900 bin with ECE and maxGap 400', () => {
    // All at 900‰ but observed 50/(50+50) = 500‰.
    const report = buildReliabilityReportV1(
      [obs(900, 5, 1, 0), obs(900, 5, 1, 0), obs(900, 5, 1, 0)],
      DEFAULT_CALIBRATION_CONFIG,
    );
    expect(report.bins[9]!.gapPermille).toBe(400);
    expect(report.expectedCalibrationErrorPermille).toBe(400);
    expect(report.maxCalibrationGapPermille).toBe(400);
  });
});

// ─── 4. Observation gating ───────────────────────────────────────────────────

describe('observation gating at minSignalWeight', () => {
  const unit = config({ reinforcement: 1, correction: 1, contradiction: 1, minSignalWeight: 5 });

  it('excludes below-threshold nodes from bins but counts them as unobserved', () => {
    const report = buildReliabilityReportV1([obs(400, 4, 0, 0), obs(400, 5, 0, 0)], unit);
    expect(report.totalCount).toBe(2);
    expect(report.observedCount).toBe(1);
    expect(report.unobservedCount).toBe(1);
    expect(report.bins[4]!.observedCount).toBe(1);
  });

  it('includes a node at exactly minSignalWeight (boundary is observed)', () => {
    const exact = observedCorrectnessV1(obs(400, 5, 0, 0), unit);
    expect(exact).toEqual({ observed: true, observedCorrectPermille: 1000 });
    const below = observedCorrectnessV1(obs(400, 4, 0, 0), unit);
    expect(below).toEqual({ observed: false, observedCorrectPermille: null });
    expect(Object.isFrozen(exact)).toBe(true);
  });

  it('weights incorrect evidence by correction and contradiction weights', () => {
    // correct = 2·10 = 20; incorrect = 1·50 + 1·30 = 80 → round(20000/100) = 200.
    expect(observedCorrectnessV1(obs(500, 2, 1, 1), DEFAULT_CALIBRATION_CONFIG)).toEqual({
      observed: true,
      observedCorrectPermille: 200,
    });
  });

  it('returns an all-sentinel report with zero metrics when nothing is observed', () => {
    const report = buildReliabilityReportV1([obs(500, 0, 0, 0)], DEFAULT_CALIBRATION_CONFIG);
    expect(report.observedCount).toBe(0);
    expect(report.unobservedCount).toBe(1);
    expect(report.expectedCalibrationErrorPermille).toBe(0);
    expect(report.maxCalibrationGapPermille).toBe(0);
    expect(report.brierPermille).toBe(0);
  });
});

// ─── 5. Determinism and identities ───────────────────────────────────────────

describe('determinism', () => {
  const observations = [
    obs(850, 9, 1, 0),
    obs(880, 4, 0, 0),
    obs(120, 1, 1, 0),
    obs(300, 0, 0, 0),
    obs(500, 5, 1, 0),
    obs(1000, 2, 0, 1),
  ];

  it('produces byte-identical reports and identities for shuffled inputs', () => {
    const forward = buildReliabilityReportV1(observations, DEFAULT_CALIBRATION_CONFIG);
    const shuffled = buildReliabilityReportV1(
      [...observations].reverse(),
      DEFAULT_CALIBRATION_CONFIG,
    );
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(forward));
    expect(reportIdentityV1(shuffled)).toBe(reportIdentityV1(forward));
    expect(reportIdentityV1(forward)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('distinguishes config identities for differing weights', () => {
    const identityA = calibrationConfigIdentityV1(DEFAULT_CALIBRATION_CONFIG);
    const identityB = calibrationConfigIdentityV1(config({ reinforcement: 11 }));
    expect(identityA).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(identityB).not.toBe(identityA);
    expect(canonicalCalibrationConfigV1(DEFAULT_CALIBRATION_CONFIG)).toBe(
      canonicalCalibrationConfigV1(config()),
    );
  });
});

// ─── 6. Contract hostility ───────────────────────────────────────────────────

describe('observation contract hostility', () => {
  it('rejects non-objects', () => {
    for (const bad of [null, undefined, 777, 'x', [obs(500, 1, 0, 0)]]) {
      expectError(() => parseCalibrationObservationV1(bad), 'not_object', 'calibrationObservation');
    }
  });

  it('rejects prototype-poisoned and proxy inputs', () => {
    expectError(
      () => parseCalibrationObservationV1(Object.create({ confidencePermille: 500 })),
      'invalid_type',
      'calibrationObservation',
    );
    expectError(
      () => parseCalibrationObservationV1(new Proxy(obs(500, 1, 0, 0), {})),
      'invalid_type',
      'calibrationObservation',
    );
    expectError(
      () => parseCalibrationObservationV1(JSON.parse('{"__proto__":{"polluted":true}}')),
      'unknown_key',
      'calibrationObservation',
    );
  });

  it('rejects unknown, missing, and getter-backed keys', () => {
    expectError(
      () => parseCalibrationObservationV1({ ...obs(500, 1, 0, 0), extra: 1 }),
      'unknown_key',
      'calibrationObservation',
    );
    expectError(
      () => parseCalibrationObservationV1({ confidencePermille: 500, reinforcements: 1, corrections: 0 }),
      'missing_key',
      'calibrationObservation.contradictions',
    );
    const trapped: Record<string, unknown> = { reinforcements: 1, corrections: 0, contradictions: 0 };
    Object.defineProperty(trapped, 'confidencePermille', { get: () => 500, enumerable: true });
    expectError(() => parseCalibrationObservationV1(trapped), 'invalid_type', 'calibrationObservation');
  });

  it('rejects NaN, floats, -0, and out-of-range numbers with closed field paths', () => {
    expectError(
      () => parseCalibrationObservationV1(obs(Number.NaN, 1, 0, 0)),
      'invalid_number',
      'calibrationObservation.confidencePermille',
    );
    expectError(
      () => parseCalibrationObservationV1(obs(500.5, 1, 0, 0)),
      'noncanonical',
      'calibrationObservation.confidencePermille',
    );
    expectError(
      () => parseCalibrationObservationV1(obs(500, -0, 0, 0)),
      'noncanonical',
      'calibrationObservation.reinforcements',
    );
    expectError(
      () => parseCalibrationObservationV1(obs(1001, 1, 0, 0)),
      'out_of_bounds',
      'calibrationObservation.confidencePermille',
    );
    expectError(
      () => parseCalibrationObservationV1(obs(500, 1, -1, 0)),
      'out_of_bounds',
      'calibrationObservation.corrections',
    );
    expectError(
      () => parseCalibrationObservationV1(obs(500, 1, 0, Number.POSITIVE_INFINITY)),
      'invalid_number',
      'calibrationObservation.contradictions',
    );
  });

  it('rejects a non-array observations input to the report builder', () => {
    expectError(
      () => buildReliabilityReportV1({} as never, DEFAULT_CALIBRATION_CONFIG),
      'invalid_type',
      'calibrationObservations',
    );
  });
});

describe('config contract hostility (band-free bounds)', () => {
  it('accepts the exact bounds of every field', () => {
    expect(() => parseCalibrationConfigV1(config({ reinforcement: 1, correction: 1000 }))).not.toThrow();
    expect(() => parseCalibrationConfigV1(config({ minSignalWeight: 1 }))).not.toThrow();
    expect(() => parseCalibrationConfigV1(config({ minSignalWeight: 100_000 }))).not.toThrow();
  });

  it('rejects out-of-bounds weights and minSignalWeight', () => {
    expectError(
      () => parseCalibrationConfigV1(config({ reinforcement: 0 })),
      'out_of_bounds',
      'calibrationConfig.signalWeights.reinforcement',
    );
    expectError(
      () => parseCalibrationConfigV1(config({ contradiction: 1001 })),
      'out_of_bounds',
      'calibrationConfig.signalWeights.contradiction',
    );
    expectError(
      () => parseCalibrationConfigV1(config({ minSignalWeight: 0 })),
      'out_of_bounds',
      'calibrationConfig.minSignalWeight',
    );
    expectError(
      () => parseCalibrationConfigV1(config({ minSignalWeight: 100_001 })),
      'out_of_bounds',
      'calibrationConfig.minSignalWeight',
    );
  });

  it('rejects poisoned nested signalWeights', () => {
    expectError(
      () => parseCalibrationConfigV1({ signalWeights: Object.create({ reinforcement: 10 }), minSignalWeight: 10 }),
      'invalid_type',
      'calibrationConfig.signalWeights',
    );
    expectError(
      () =>
        parseCalibrationConfigV1({
          signalWeights: { reinforcement: 10, correction: 50, contradiction: 30, extra: 1 },
          minSignalWeight: 10,
        }),
      'unknown_key',
      'calibrationConfig.signalWeights',
    );
  });

  it('freezes the parsed config and defaults', () => {
    const parsed = parseCalibrationConfigV1(config());
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.signalWeights)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CALIBRATION_CONFIG)).toBe(true);
  });
});

describe('environment resolution', () => {
  it('returns the defaults for an empty environment', () => {
    expect(resolveCalibrationConfig({})).toEqual(DEFAULT_CALIBRATION_CONFIG);
  });

  it('applies digits-only overrides for all four variables', () => {
    const resolved = resolveCalibrationConfig({
      [CALIBRATION_ENV_REINFORCEMENT_WEIGHT]: '20',
      [CALIBRATION_ENV_CORRECTION_WEIGHT]: '60',
      [CALIBRATION_ENV_CONTRADICTION_WEIGHT]: ' 40 ',
      [CALIBRATION_ENV_MIN_SIGNAL_WEIGHT]: '25',
    });
    expect(resolved).toEqual({
      signalWeights: { reinforcement: 20, correction: 60, contradiction: 40 },
      minSignalWeight: 25,
    });
  });

  it('keeps defaults for empty-string variables', () => {
    expect(resolveCalibrationConfig({ [CALIBRATION_ENV_MIN_SIGNAL_WEIGHT]: '' })).toEqual(
      DEFAULT_CALIBRATION_CONFIG,
    );
  });

  it('rejects non-digit values without echoing them', () => {
    expectError(
      () => resolveCalibrationConfig({ [CALIBRATION_ENV_REINFORCEMENT_WEIGHT]: 'abc' }),
      'invalid_number',
      'calibrationConfig.signalWeights.reinforcement',
    );
    expectError(
      () => resolveCalibrationConfig({ [CALIBRATION_ENV_MIN_SIGNAL_WEIGHT]: '12.5' }),
      'invalid_number',
      'calibrationConfig.minSignalWeight',
    );
    expectError(
      () => resolveCalibrationConfig({ [CALIBRATION_ENV_CORRECTION_WEIGHT]: '-5' }),
      'invalid_number',
      'calibrationConfig.signalWeights.correction',
    );
  });

  it('re-validates bounds on resolved values', () => {
    expectError(
      () => resolveCalibrationConfig({ [CALIBRATION_ENV_CORRECTION_WEIGHT]: '0' }),
      'out_of_bounds',
      'calibrationConfig.signalWeights.correction',
    );
  });
});

// ─── 7. confidenceToPermille ─────────────────────────────────────────────────

describe('confidenceToPermille', () => {
  it.each([
    [0, 0],
    [1, 1000],
    [0.5, 500],
    [0.8949, 895],
    [0.0004, 0],
    [0.0005, 1],
  ])('maps %d to %d permille (round half up)', (input, expected) => {
    expect(confidenceToPermille(input)).toBe(expected);
  });

  it('rejects NaN, infinities, out-of-range, and -0', () => {
    expectError(() => confidenceToPermille(Number.NaN), 'invalid_number', 'confidence');
    expectError(() => confidenceToPermille(Number.POSITIVE_INFINITY), 'invalid_number', 'confidence');
    expectError(() => confidenceToPermille(-0.1), 'out_of_bounds', 'confidence');
    expectError(() => confidenceToPermille(1.01), 'out_of_bounds', 'confidence');
    expectError(() => confidenceToPermille(-0), 'noncanonical', 'confidence');
  });
});
