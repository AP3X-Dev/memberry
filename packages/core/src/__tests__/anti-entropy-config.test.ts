// packages/core/src/__tests__/anti-entropy-config.test.ts
//
// Hostile-parse coverage for the MEM-007 anti-entropy env configuration: the
// MEMBERRY_LIFECYCLE_ANTIENTROPY sub-flag enum (unrecognized never enables the
// pass) and the consumer-GC idle bound. Also pins that parameterizing the
// shared parseMode helper left the MEM-006 MEMBERRY_LIFECYCLE_V1 warning
// byte-identical.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  LifecycleConfigError,
  resolveAntiEntropyConfig,
  resolveLifecycleConfig,
} from '../config/lifecycle.js';

const ANTIENTROPY_ENV = [
  'MEMBERRY_LIFECYCLE_ANTIENTROPY',
  'MEMBERRY_ANTIENTROPY_CONSUMER_GC_IDLE_MS',
  'MEMBERRY_LIFECYCLE_V1',
];

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ANTIENTROPY_ENV) {
    saved.set(key, process.env[key]);
    delete process.env[key];
    delete process.env[`AMP_${key.slice('MEMBERRY_'.length)}`];
  }
});

afterEach(() => {
  for (const key of ANTIENTROPY_ENV) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

describe('resolveAntiEntropyConfig', () => {
  it('returns the documented defaults with no env set (disabled, 7d GC idle)', () => {
    expect(resolveAntiEntropyConfig()).toEqual({
      mode: 'disabled',
      consumerGcIdleMs: 604_800_000,
    });
  });

  it('enables only on the exact enum value "live"', () => {
    process.env.MEMBERRY_LIFECYCLE_ANTIENTROPY = 'live';
    expect(resolveAntiEntropyConfig().mode).toBe('live');
    process.env.MEMBERRY_LIFECYCLE_ANTIENTROPY = 'disabled';
    expect(resolveAntiEntropyConfig().mode).toBe('disabled');
  });

  it('treats an unrecognized sub-flag value as disabled (with a warning naming the var), never live', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.MEMBERRY_LIFECYCLE_ANTIENTROPY = 'enabled';
    expect(resolveAntiEntropyConfig().mode).toBe('disabled');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[lifecycle] MEMBERRY_LIFECYCLE_ANTIENTROPY has an unrecognized value; treating as disabled.',
    );
  });

  it('keeps the MEM-006 MEMBERRY_LIFECYCLE_V1 fallback warning byte-identical after parameterization', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.MEMBERRY_LIFECYCLE_V1 = 'enabled';
    expect(resolveLifecycleConfig('.').mode).toBe('disabled');
    expect(warn).toHaveBeenCalledWith(
      '[lifecycle] MEMBERRY_LIFECYCLE_V1 has an unrecognized value; treating as disabled.',
    );
  });

  it('rejects non-integer GC idle values (fail closed, no default fallback)', () => {
    for (const value of ['abc', '12.5', '1e3', '-200', '0x10']) {
      process.env.MEMBERRY_ANTIENTROPY_CONSUMER_GC_IDLE_MS = value;
      expect(() => resolveAntiEntropyConfig(), `value=${value}`).toThrow(LifecycleConfigError);
    }
  });

  it('bounds the GC idle to 1h..365d in milliseconds', () => {
    process.env.MEMBERRY_ANTIENTROPY_CONSUMER_GC_IDLE_MS = '3600000';
    expect(resolveAntiEntropyConfig().consumerGcIdleMs).toBe(3_600_000);
    process.env.MEMBERRY_ANTIENTROPY_CONSUMER_GC_IDLE_MS = '31536000000';
    expect(resolveAntiEntropyConfig().consumerGcIdleMs).toBe(31_536_000_000);
    process.env.MEMBERRY_ANTIENTROPY_CONSUMER_GC_IDLE_MS = '3599999';
    expect(() => resolveAntiEntropyConfig()).toThrow(/out_of_bounds/);
    process.env.MEMBERRY_ANTIENTROPY_CONSUMER_GC_IDLE_MS = '31536000001';
    expect(() => resolveAntiEntropyConfig()).toThrow(/out_of_bounds/);
  });

  it('leaves the MEM-006 lifecycle config shape untouched (no new keys on resolveLifecycleConfig)', () => {
    expect(Object.keys(resolveLifecycleConfig('.'))).not.toContain('antiEntropy');
    expect(resolveLifecycleConfig('.').mode).toBe('disabled');
  });
});
