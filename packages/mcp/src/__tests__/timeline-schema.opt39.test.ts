// packages/mcp/src/__tests__/timeline-schema.opt39.test.ts
//
// OPT-39: AmpTimelineSchema.limit allowed negative/zero and the handler sliced
// raw — limit:0 fell through to "return all", and limit:-n did
// tl.facts.slice(0, -n), silently dropping the LAST n facts. The schema now
// requires a positive int (1–100), and the handler only slices for a positive
// limit (defense-in-depth for direct callers).
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  AmpTimelineSchema,
  buildToolHandlers,
  createServiceContainer,
  type IFactStore,
} from '../tools.js';

const schema = z.object(AmpTimelineSchema);
const base = { entity: 'Ent' };

describe('AmpTimelineSchema.limit bounds (OPT-39)', () => {
  it('accepts a positive int within range and an absent limit', () => {
    expect(schema.safeParse({ ...base, limit: 10 }).success).toBe(true);
    expect(schema.safeParse({ ...base }).success).toBe(true); // optional
    expect(schema.safeParse({ ...base, limit: 100 }).success).toBe(true);
  });

  it('rejects zero, negative, non-integer, and over-cap limits', () => {
    expect(schema.safeParse({ ...base, limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ ...base, limit: -1 }).success).toBe(false);
    expect(schema.safeParse({ ...base, limit: 2.5 }).success).toBe(false);
    expect(schema.safeParse({ ...base, limit: 101 }).success).toBe(false);
  });
});

// ─── Handler slice behavior ──────────────────────────────────────────────────
function fact(i: number) {
  return {
    event: 'created',
    at: `2026-01-0${i}T00:00:00.000Z`,
    subject: `subj${i}`,
    predicate: 'is',
    object: `obj${i}`,
    status: 'active',
    valid_at: `2026-01-0${i}T00:00:00.000Z`,
    invalid_at: null,
    confidence: 0.5,
  };
}

function handlersWithFacts(n: number) {
  const facts = Array.from({ length: n }, (_, i) => fact(i));
  const factStore = {
    timeline: vi.fn().mockResolvedValue({ entity: 'Ent', facts }),
    diff: vi.fn(),
  } as unknown as IFactStore;
  return buildToolHandlers(createServiceContainer({ factStore }));
}

describe('berry_timeline handler slice (OPT-39)', () => {
  it('a positive limit slices to the first N facts', async () => {
    const handlers = handlersWithFacts(5);
    const text = (await handlers.berry_timeline({ entity: 'Ent', limit: 2 })).content[0].text;
    expect(text).toContain('subj0');
    expect(text).toContain('subj1');
    expect(text).not.toContain('subj2');
  });

  it('an absent limit returns all facts', async () => {
    const handlers = handlersWithFacts(5);
    const text = (await handlers.berry_timeline({ entity: 'Ent' })).content[0].text;
    for (let i = 0; i < 5; i++) expect(text).toContain(`subj${i}`);
  });

  it('a direct negative limit returns all facts (no tail-dropping slice)', async () => {
    const handlers = handlersWithFacts(5);
    // Bypasses the Zod boundary (direct handler call) — the hardened handler must
    // NOT do slice(0, -1) (which would silently drop the last fact).
    const text = (await handlers.berry_timeline({ entity: 'Ent', limit: -1 })).content[0].text;
    expect(text).toContain('subj4'); // last fact still present
  });

  it('a direct zero limit returns all facts', async () => {
    const handlers = handlersWithFacts(3);
    const text = (await handlers.berry_timeline({ entity: 'Ent', limit: 0 })).content[0].text;
    for (let i = 0; i < 3; i++) expect(text).toContain(`subj${i}`);
  });
});
