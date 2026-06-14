// packages/research/src/__tests__/research-log-schema.opt40.test.ts
//
// OPT-40: ResearchLogSchema.secondary_metrics was z.record(z.number()) —
// unbounded key COUNT, unbounded key LENGTH, and NaN/Infinity values all
// accepted. It now bounds keys (≤100 chars), entry count (≤50), and requires
// finite numeric values.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ResearchLogSchema } from '../tools.js';

const schema = z.object(ResearchLogSchema);

function base(extra: Record<string, unknown> = {}) {
  return {
    campaign_id: 'camp-1',
    session_id: 'sess-1',
    experiment_number: 0,
    branch: 'main',
    metric_value: 1.5,
    status: 'keep',
    duration_s: 12,
    hypothesis: 'h',
    description: 'd',
    insight: 'i',
    ...extra,
  };
}

describe('ResearchLogSchema.secondary_metrics bounds (OPT-40)', () => {
  it('accepts a small finite map and an absent value', () => {
    expect(schema.safeParse(base({ secondary_metrics: { mem_mb: 220, cpu_pct: 85 } })).success).toBe(true);
    expect(schema.safeParse(base()).success).toBe(true); // optional
    expect(schema.safeParse(base({ secondary_metrics: {} })).success).toBe(true);
  });

  it('accepts exactly 50 entries', () => {
    const fifty = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
    expect(schema.safeParse(base({ secondary_metrics: fifty })).success).toBe(true);
  });

  it('rejects more than 50 entries', () => {
    const fiftyOne = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, i]));
    expect(schema.safeParse(base({ secondary_metrics: fiftyOne })).success).toBe(false);
  });

  it('rejects a key longer than 100 chars', () => {
    expect(schema.safeParse(base({ secondary_metrics: { ['k'.repeat(101)]: 1 } })).success).toBe(false);
  });

  it('rejects NaN / Infinity metric values', () => {
    expect(schema.safeParse(base({ secondary_metrics: { x: NaN } })).success).toBe(false);
    expect(schema.safeParse(base({ secondary_metrics: { x: Infinity } })).success).toBe(false);
    expect(schema.safeParse(base({ secondary_metrics: { x: -Infinity } })).success).toBe(false);
  });

  it('rejects a non-number metric value', () => {
    expect(schema.safeParse(base({ secondary_metrics: { x: 'oops' } })).success).toBe(false);
  });
});
