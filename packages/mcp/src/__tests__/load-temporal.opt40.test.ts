// packages/mcp/src/__tests__/load-temporal.opt40.test.ts
//
// OPT-40: AmpLoadSchema.temporal.{as_of,from,to} were unbounded z.string(), so
// an agent could submit an arbitrarily long "timestamp". They are now bounded to
// 40 chars. NOT z.string().datetime() — the documented contract accepts BOTH
// date-only ("2025-06-01") and full ISO ("2021-03-01T00:00:00.000Z").
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AmpLoadSchema } from '../tools.js';

const schema = z.object(AmpLoadSchema);
const base = { task: 'do a thing' };

describe('AmpLoadSchema.temporal timestamp bounds (OPT-40)', () => {
  it('accepts a date-only as_of (documented contract)', () => {
    expect(schema.safeParse({ ...base, temporal: { time_mode: 'historical', as_of: '2025-06-01' } }).success).toBe(true);
  });

  it('accepts a full ISO datetime in from/to', () => {
    expect(
      schema.safeParse({
        ...base,
        temporal: { time_mode: 'interval', from: '2021-03-01T00:00:00.000Z', to: '2021-04-01T00:00:00.000Z' },
      }).success,
    ).toBe(true);
  });

  it('accepts an absent temporal block', () => {
    expect(schema.safeParse({ ...base }).success).toBe(true);
  });

  it('rejects an over-length timestamp string (> 40 chars)', () => {
    expect(schema.safeParse({ ...base, temporal: { as_of: '2'.repeat(41) } }).success).toBe(false);
    expect(schema.safeParse({ ...base, temporal: { from: 'x'.repeat(100) } }).success).toBe(false);
    expect(schema.safeParse({ ...base, temporal: { to: 'y'.repeat(5000) } }).success).toBe(false);
  });
});
