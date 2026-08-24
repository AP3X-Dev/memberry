// packages/core/src/__tests__/lifecycle-config.test.ts
//
// Hostile-parse coverage for the MEM-006 lifecycle env configuration: bad
// integers, out-of-bounds values, the degenerate 0 budget, the flag enum, and
// cooldown bounds. The parser must fail closed on malformed input rather than
// silently running with defaults.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DECAY_HALF_LIVES_DAYS,
  LifecycleConfigError,
  resolveLifecycleConfig,
} from '../config/lifecycle.js';

const LIFECYCLE_ENV = [
  'MEMBERRY_LIFECYCLE_V1',
  'MEMBERRY_LIFECYCLE_DRY_RUN',
  'MEMBERRY_LIFECYCLE_SIDECAR_BUDGET',
  'MEMBERRY_LIFECYCLE_SIDECAR_MAX_AGE_DAYS',
  'MEMBERRY_LIFECYCLE_ARCHIVE_HALFLIFE_MULTIPLIER',
  'MEMBERRY_LIFECYCLE_DECAY_CONFIDENCE_FLOOR',
  'MEMBERRY_LIFECYCLE_MAX_DECAY_PROPOSALS_PER_SCOPE',
  'MEMBERRY_LIFECYCLE_DECAY_COOLDOWN_DAYS',
  'MEMBERRY_LIFECYCLE_BATCH_ROWS',
  'MEMBERRY_LIFECYCLE_EXPORT_DIR',
];

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of LIFECYCLE_ENV) {
    saved.set(key, process.env[key]);
    delete process.env[key];
    delete process.env[`AMP_${key.slice('MEMBERRY_'.length)}`];
  }
});

afterEach(() => {
  for (const key of LIFECYCLE_ENV) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

describe('resolveLifecycleConfig', () => {
  it('returns the documented defaults with no env set', () => {
    const config = resolveLifecycleConfig('./.memberry');
    expect(config).toEqual({
      mode: 'disabled',
      dryRun: false,
      sidecarBudget: 5000,
      sidecarMaxAgeDays: 180,
      archiveHalfLifeMultiplier: 2,
      decayConfidenceFloor: 0.1,
      maxDecayProposalsPerScope: 25,
      decayCooldownDays: 30,
      batchRows: 1000,
      exportDir: './.memberry',
    });
  });

  it('enables only on the exact enum value "live"', () => {
    process.env.MEMBERRY_LIFECYCLE_V1 = 'live';
    expect(resolveLifecycleConfig('.').mode).toBe('live');
  });

  it('treats an unrecognized flag value as disabled (with a warning), never live', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.MEMBERRY_LIFECYCLE_V1 = 'enabled';
    expect(resolveLifecycleConfig('.').mode).toBe('disabled');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('parses the truthy set for dry-run', () => {
    for (const value of ['1', 'true', 'yes', 'on', 'TRUE']) {
      process.env.MEMBERRY_LIFECYCLE_DRY_RUN = value;
      expect(resolveLifecycleConfig('.').dryRun).toBe(true);
    }
    process.env.MEMBERRY_LIFECYCLE_DRY_RUN = 'nope';
    expect(resolveLifecycleConfig('.').dryRun).toBe(false);
  });

  it('rejects non-integer budget values (fail closed, no default fallback)', () => {
    for (const value of ['abc', '12.5', '1e3', '-200', '0x10', '']) {
      process.env.MEMBERRY_LIFECYCLE_SIDECAR_BUDGET = value;
      if (value === '') {
        // readEnv treats empty as unset — default applies.
        expect(resolveLifecycleConfig('.').sidecarBudget).toBe(5000);
        continue;
      }
      expect(() => resolveLifecycleConfig('.')).toThrow(LifecycleConfigError);
    }
  });

  it('rejects the degenerate 0 budget (would delete every non-protected row)', () => {
    process.env.MEMBERRY_LIFECYCLE_SIDECAR_BUDGET = '0';
    expect(() => resolveLifecycleConfig('.')).toThrow(/out_of_bounds/);
  });

  it('rejects out-of-bounds values on every bounded knob', () => {
    const cases: Array<[string, string]> = [
      ['MEMBERRY_LIFECYCLE_SIDECAR_BUDGET', '99'],
      ['MEMBERRY_LIFECYCLE_SIDECAR_BUDGET', '1000001'],
      ['MEMBERRY_LIFECYCLE_SIDECAR_MAX_AGE_DAYS', '6'],
      ['MEMBERRY_LIFECYCLE_SIDECAR_MAX_AGE_DAYS', '3651'],
      ['MEMBERRY_LIFECYCLE_ARCHIVE_HALFLIFE_MULTIPLIER', '0'],
      ['MEMBERRY_LIFECYCLE_ARCHIVE_HALFLIFE_MULTIPLIER', '11'],
      ['MEMBERRY_LIFECYCLE_MAX_DECAY_PROPOSALS_PER_SCOPE', '0'],
      ['MEMBERRY_LIFECYCLE_MAX_DECAY_PROPOSALS_PER_SCOPE', '501'],
      ['MEMBERRY_LIFECYCLE_BATCH_ROWS', '99'],
      ['MEMBERRY_LIFECYCLE_BATCH_ROWS', '10001'],
    ];
    for (const [key, value] of cases) {
      process.env[key] = value;
      expect(() => resolveLifecycleConfig('.'), `${key}=${value}`).toThrow(/out_of_bounds/);
      delete process.env[key];
    }
  });

  it('bounds the decay cooldown to 1..365 days and rejects garbage', () => {
    process.env.MEMBERRY_LIFECYCLE_DECAY_COOLDOWN_DAYS = '365';
    expect(resolveLifecycleConfig('.').decayCooldownDays).toBe(365);
    process.env.MEMBERRY_LIFECYCLE_DECAY_COOLDOWN_DAYS = '366';
    expect(() => resolveLifecycleConfig('.')).toThrow(/out_of_bounds/);
    process.env.MEMBERRY_LIFECYCLE_DECAY_COOLDOWN_DAYS = 'monthly';
    expect(() => resolveLifecycleConfig('.')).toThrow(/invalid_int/);
  });

  it('bounds the confidence floor to 0.01..0.5 as a float', () => {
    process.env.MEMBERRY_LIFECYCLE_DECAY_CONFIDENCE_FLOOR = '0.25';
    expect(resolveLifecycleConfig('.').decayConfidenceFloor).toBe(0.25);
    process.env.MEMBERRY_LIFECYCLE_DECAY_CONFIDENCE_FLOOR = '0.6';
    expect(() => resolveLifecycleConfig('.')).toThrow(/out_of_bounds/);
    process.env.MEMBERRY_LIFECYCLE_DECAY_CONFIDENCE_FLOOR = '-0.1';
    expect(() => resolveLifecycleConfig('.')).toThrow(/invalid_float/);
  });

  it('rejects a blank export dir but accepts an explicit path', () => {
    process.env.MEMBERRY_LIFECYCLE_EXPORT_DIR = '   ';
    expect(() => resolveLifecycleConfig('.')).toThrow(/blank_value/);
    process.env.MEMBERRY_LIFECYCLE_EXPORT_DIR = '/var/lib/memberry';
    expect(resolveLifecycleConfig('.').exportDir).toBe('/var/lib/memberry');
  });

  it('pins the shared decay half-life constants (wiki row and engine read the same object)', () => {
    expect(DECAY_HALF_LIVES_DAYS).toEqual({ volatile: 14, stable: 90, permanent: 365 });
  });
});
