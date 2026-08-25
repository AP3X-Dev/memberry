// packages/core/src/__tests__/hebbian-decay.test.ts
//
// MEM-006H computeDecay usage seam. The load-bearing pin is §2.6.1: without a
// usage argument (or with usage === undefined) computeDecay MUST be
// bit-identical to the MEM-006 implementation across a broad input grid, and
// the U1 band (factor 1.0) must reproduce the same outputs THROUGH the factor
// table — so a mutated table (e.g. every factor 1.1) fails this file.

import { describe, it, expect } from 'vitest';
import { computeDecay, usageBand } from '../lifecycle.js';

const DAY_MS = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
function iso(ms: number): string { return new Date(ms).toISOString(); }

/** Stale access (older than the 90d window) — the U1 "classic behavior" band. */
const U1_USAGE = { last_accessed: iso(T0 - 200 * DAY_MS), access_count: 50 };

describe('usageBand', () => {
  it('maps absence, staleness, and counts onto the closed bands', () => {
    expect(usageBand({}, T0)).toBe('U0_never_accessed');
    expect(usageBand({ last_accessed: null }, T0)).toBe('U0_never_accessed');
    expect(usageBand(U1_USAGE, T0)).toBe('U1_stale_access');
    expect(usageBand({ last_accessed: iso(T0 - DAY_MS), access_count: 1 }, T0)).toBe('U2_recent_low');
    expect(usageBand({ last_accessed: iso(T0 - DAY_MS), access_count: 2 }, T0)).toBe('U2_recent_low');
    expect(usageBand({ last_accessed: iso(T0 - DAY_MS), access_count: 3 }, T0)).toBe('U3_recent_habitual');
    expect(usageBand({ last_accessed: iso(T0 - DAY_MS), access_count: 9 }, T0)).toBe('U3_recent_habitual');
    expect(usageBand({ last_accessed: iso(T0 - DAY_MS), access_count: 10 }, T0)).toBe('U4_recent_heavy');
  });

  it('fails neutral (U1, never faster) on an unparseable last_accessed', () => {
    expect(usageBand({ last_accessed: 'not-a-date', access_count: 99 }, T0)).toBe('U1_stale_access');
  });
});

describe('computeDecay §2.6.1 bit-identical default (equivalence grid)', () => {
  it('no-usage, explicit-undefined, and the U1 band all deep-equal on the full grid', () => {
    const config = (floor: number) => ({ decayConfidenceFloor: floor });
    const classes = ['volatile', 'stable', 'permanent'] as const;
    const halfLives = { volatile: 14, stable: 90, permanent: 365 };
    const confidences = [0.11, 0.2, 0.35, 0.5, 0.72, 0.9, 1.0];
    const elapsedHalfLives = [0.5, 1, 2, 5, 10, 40];
    const floors = [0.01, 0.1, 0.3, 0.5];
    let checked = 0;
    for (const decay_class of classes) {
      for (const confidence of confidences) {
        for (const e of elapsedHalfLives) {
          for (const floor of floors) {
            const node = {
              confidence, decay_class,
              updated_at: iso(T0 - e * halfLives[decay_class] * DAY_MS),
            };
            const control = computeDecay(node, T0, config(floor));
            expect(computeDecay(node, T0, config(floor), undefined)).toEqual(control);
            expect(computeDecay(node, T0, config(floor), U1_USAGE)).toEqual(control);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBe(3 * 7 * 6 * 4);
  });

  it('degenerate inputs stay identical too (bad anchor, future anchor, at-floor)', () => {
    const config = { decayConfidenceFloor: 0.1 };
    for (const node of [
      { confidence: 0.9, decay_class: 'stable' as const, updated_at: 'not-a-date' },
      { confidence: 0.9, decay_class: 'stable' as const, updated_at: iso(T0 + DAY_MS) },
      { confidence: 0.1, decay_class: 'stable' as const, updated_at: iso(T0 - 500 * DAY_MS) },
    ]) {
      expect(computeDecay(node, T0, config, undefined)).toEqual(computeDecay(node, T0, config));
      expect(computeDecay(node, T0, config, U1_USAGE)).toEqual(computeDecay(node, T0, config));
    }
  });
});

describe('computeDecay usage modulation', () => {
  const config = { decayConfidenceFloor: 0.1 };

  it('U0 (never accessed) decays faster: volatile 14d becomes an effective 10.5d half-life', () => {
    const node = { confidence: 0.8, decay_class: 'volatile' as const, updated_at: iso(T0 - 10.5 * DAY_MS) };
    // 10.5 elapsed days = exactly one U0-effective half-life (14 x 0.75).
    expect(computeDecay(node, T0, config, {})?.proposedConfidence).toBe(0.4);
    // Classic behavior is slower (10.5/14 of a half-life).
    expect(computeDecay(node, T0, config)?.proposedConfidence).toBe(0.48);
  });

  it('U2-U4 lengthen the effective half-life monotonically', () => {
    const node = { confidence: 0.9, decay_class: 'stable' as const, updated_at: iso(T0 - 90 * DAY_MS) };
    const recent = (count: number) => ({ last_accessed: iso(T0 - DAY_MS), access_count: count });
    const classic = computeDecay(node, T0, config)!.proposedConfidence; // 0.45
    const u2 = computeDecay(node, T0, config, recent(1))!.proposedConfidence;  // 90 x 1.5
    const u3 = computeDecay(node, T0, config, recent(5))!.proposedConfidence;  // 90 x 2.0
    const u4 = computeDecay(node, T0, config, recent(20))!.proposedConfidence; // 90 x 3.0
    expect(classic).toBe(0.45);
    expect(u2).toBe(0.57);
    expect(u3).toBe(0.64);
    expect(u4).toBe(0.71);
    expect(u2).toBeGreaterThan(classic);
    expect(u4).toBeGreaterThan(u3);
  });

  it('a young permanent-class node returns null with or without heavy usage (as before)', () => {
    const node = { confidence: 0.9, decay_class: 'permanent' as const, updated_at: iso(T0 - 20 * DAY_MS) };
    expect(computeDecay(node, T0, config)).toBeNull();
    expect(computeDecay(node, T0, config, { last_accessed: iso(T0 - DAY_MS), access_count: 20 })).toBeNull();
  });

  it('an unparseable last_accessed modulates as U1 — never faster than classic', () => {
    const node = { confidence: 0.9, decay_class: 'stable' as const, updated_at: iso(T0 - 90 * DAY_MS) };
    expect(computeDecay(node, T0, config, { last_accessed: 'garbage', access_count: 99 }))
      .toEqual(computeDecay(node, T0, config));
  });
});
