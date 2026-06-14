// packages/mcp/src/__tests__/store-schema.opt36.test.ts
//
// OPT-36: berry_store's signals[] had unbounded target_id/detail strings and no
// array-length cap, so a single store call could attach an arbitrarily large
// signal payload. These tests pin the new bounds on the (now-exported) schema.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AmpStoreSchema } from '../tools.js';

const schema = z.object(AmpStoreSchema);

/** Minimal valid store payload (required fields only). */
function base(extra: Record<string, unknown> = {}) {
  return { session_id: 's', task: 't', content: 'c', ...extra };
}

describe('AmpStoreSchema signals bounds (OPT-36)', () => {
  it('accepts a small, well-formed signals array', () => {
    const r = schema.safeParse(
      base({ signals: [{ type: 'reinforcement', target_id: 'sem-1', detail: 'good tone' }] }),
    );
    expect(r.success).toBe(true);
  });

  it('accepts values exactly at the bounds (500 / 2000 / 50)', () => {
    const r = schema.safeParse(
      base({
        signals: Array.from({ length: 50 }, () => ({
          type: 'correction' as const,
          target_id: 'a'.repeat(500),
          detail: 'b'.repeat(2000),
        })),
      }),
    );
    expect(r.success).toBe(true);
  });

  it('rejects a target_id over 500 chars', () => {
    const r = schema.safeParse(
      base({ signals: [{ type: 'reinforcement', target_id: 'a'.repeat(501), detail: 'x' }] }),
    );
    expect(r.success).toBe(false);
  });

  it('rejects a detail over 2000 chars', () => {
    const r = schema.safeParse(
      base({ signals: [{ type: 'reinforcement', target_id: 'sem-1', detail: 'b'.repeat(2001) }] }),
    );
    expect(r.success).toBe(false);
  });

  it('rejects a signals array longer than 50', () => {
    const r = schema.safeParse(
      base({
        signals: Array.from({ length: 51 }, () => ({
          type: 'contradiction' as const,
          target_id: 'sem-1',
          detail: 'x',
        })),
      }),
    );
    expect(r.success).toBe(false);
  });

  it('still rejects an invalid signal type (enum unchanged)', () => {
    const r = schema.safeParse(
      base({ signals: [{ type: 'bogus', target_id: 'sem-1', detail: 'x' }] }),
    );
    expect(r.success).toBe(false);
  });
});
