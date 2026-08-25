// packages/core/src/__tests__/hebbian-config.test.ts
//
// MEM-006H hebbian sub-flag configuration: the MEMBERRY_LIFECYCLE_HEBBIAN enum
// (parameterized parseMode — unrecognized never enables the pass), the frozen
// factor/window constants, and the guarantee that resolving the sub-flag
// leaves the MEM-006 LifecycleConfig resolution untouched.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  HEBBIAN_HALF_LIFE_FACTORS,
  HEBBIAN_RECENCY_WINDOW_DAYS,
  resolveHebbianConfig,
  resolveLifecycleConfig,
} from '../config/lifecycle.js';

const HEBBIAN_ENV = ['MEMBERRY_LIFECYCLE_HEBBIAN', 'MEMBERRY_LIFECYCLE_V1'];

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of HEBBIAN_ENV) {
    saved.set(key, process.env[key]);
    delete process.env[key];
    delete process.env[`AMP_${key.slice('MEMBERRY_'.length)}`];
  }
});

afterEach(() => {
  for (const key of HEBBIAN_ENV) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

describe('resolveHebbianConfig', () => {
  it('defaults to disabled with no env set', () => {
    expect(resolveHebbianConfig()).toEqual({ mode: 'disabled' });
  });

  it('enables only on the exact enum value "live"', () => {
    process.env.MEMBERRY_LIFECYCLE_HEBBIAN = 'live';
    expect(resolveHebbianConfig().mode).toBe('live');
    process.env.MEMBERRY_LIFECYCLE_HEBBIAN = 'disabled';
    expect(resolveHebbianConfig().mode).toBe('disabled');
  });

  it('treats an unrecognized value as disabled (with a warning naming the var), never live', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.MEMBERRY_LIFECYCLE_HEBBIAN = 'enabled';
    expect(resolveHebbianConfig().mode).toBe('disabled');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[lifecycle] MEMBERRY_LIFECYCLE_HEBBIAN has an unrecognized value; treating as disabled.',
    );
  });

  it('leaves the MEM-006 LifecycleConfig resolution unchanged whether or not the sub-flag is set', () => {
    const without = resolveLifecycleConfig('.');
    process.env.MEMBERRY_LIFECYCLE_HEBBIAN = 'live';
    const withFlag = resolveLifecycleConfig('.');
    expect(withFlag).toEqual(without);
    expect(Object.keys(withFlag)).not.toContain('hebbian');
  });
});

describe('hebbian constant tables (frozen, not config)', () => {
  it('pins the closed half-life factor table and the recency window', () => {
    expect(HEBBIAN_RECENCY_WINDOW_DAYS).toBe(90);
    expect(HEBBIAN_HALF_LIFE_FACTORS).toEqual({
      U0_never_accessed: 0.75,
      U1_stale_access: 1.0,
      U2_recent_low: 1.5,
      U3_recent_habitual: 2.0,
      U4_recent_heavy: 3.0,
    });
    expect(Object.isFrozen(HEBBIAN_HALF_LIFE_FACTORS)).toBe(true);
  });
});
