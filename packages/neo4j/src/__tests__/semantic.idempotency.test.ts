import { describe, expect, it, vi } from 'vitest';
import type { Driver } from 'neo4j-driver';
import type { SemanticNode } from '@memberry/core';
import { SemanticStore } from '../semantic.js';

describe('SemanticStore promotion ambiguous-commit replay contract', () => {
  it('uses deterministic-id exact-provenance replay while rejecting other overlaps', async () => {
    const queries: string[] = [];
    const run = vi.fn(async (query: string) => {
      queries.push(query);
      return { records: [{ get: () => 'semantic-stable' }] };
    });
    const executeWrite = vi.fn(async (work: (tx: { run: typeof run }) => Promise<unknown>) =>
      work({ run }));
    const close = vi.fn().mockResolvedValue(undefined);
    const driver = { session: vi.fn(() => ({ executeWrite, close })) } as unknown as Driver;
    const store = new SemanticStore(driver);
    const now = new Date().toISOString();
    const semantic: SemanticNode = {
      id: 'semantic-stable',
      content: 'Stable promotion',
      confidence: 0.9,
      signal_count: 3,
      created_at: now,
      updated_at: now,
      decay_class: 'stable',
      tags: ['project:test'],
    };

    await expect(store.promoteFromEpisodic(['ep-a', 'ep-b'], semantic)).resolves.toBe('semantic-stable');
    await expect(store.promoteFromEpisodic(['ep-a', 'ep-b'], semantic)).resolves.toBe('semantic-stable');

    const cypher = queries[0];
    expect(cypher).toContain('OPTIONAL MATCH (existing:Semantic {id: $id})');
    expect(cypher).toContain('size(existingSourceIds) = size($episodicIds)');
    expect(cypher).toContain('other.id <> $id');
    expect(cypher).toContain('MERGE (s:Semantic {id: $id})');
    expect(cypher).not.toMatch(/CALL\s*\{\s*WITH\s+existing\s*WHERE/);
    expect(cypher).toContain('MERGE (s)-[:PROMOTED_FROM]->(ep)');
  });
});

// ─── RET-005B-AUTH-001B6P: semantic lifecycle producer ───────────────────────
//
// Sites 1 (create), 2 (supersede) and 3 (promoteFromEpisodic) of the bound
// nine-site value table, asserted on the emitted Cypher and the captured param
// objects — the only surface this mock harness can observe. The ON CREATE-only
// fencing is proven by the TAIL assertions (T5/T8): everything from the first
// line after each ON CREATE clause must be free of node lifecycle writes. Note
// T5 is a tail guard, not total fencing — the standalone embedding ternary sits
// between supersede's ON CREATE clause and this slice.

// AMENDMENT 4's bound site-3 expression, byte-for-byte including the `null`
// reduce seed and the `>` comparator. An earliest-picking implementation cannot
// produce this string.
const PROMOTE_VALID_AT_EXPRESSION = [
  '                      s.valid_at = coalesce(reduce(latest = null, ep IN episodes |',
  '                        CASE WHEN latest IS NULL OR ep.created_at > latest',
  '                             THEN ep.created_at ELSE latest END), $created_at)',
].join('\n');

/** A node lifecycle write on the `s`/`new` aliases. Deliberately excludes the
 *  pre-existing RELATIONSHIP aliases (`newR.`, `oldR.`, `about.`, `sourceR.`)
 *  that legitimately live in these tails. */
const NODE_LIFECYCLE_WRITE = /\b(s|new)\.(valid_at|invalid_at)\b/;

type Captured = { query: string; params: Record<string, unknown> };

function makeCapturingStore(): { store: SemanticStore; calls: Captured[] } {
  const calls: Captured[] = [];
  const run = vi.fn(async (query: string, params: Record<string, unknown>) => {
    calls.push({ query, params });
    return { records: [{ get: () => 'sem-lifecycle' }] };
  });
  const executeWrite = vi.fn(async (work: (tx: { run: typeof run }) => Promise<unknown>) =>
    work({ run }));
  const close = vi.fn().mockResolvedValue(undefined);
  const driver = { session: vi.fn(() => ({ run, executeWrite, close })) } as unknown as Driver;
  return { store: new SemanticStore(driver), calls };
}

function makeNode(overrides: Partial<SemanticNode> = {}): SemanticNode {
  const now = new Date().toISOString();
  return {
    id: 'sem-lifecycle',
    content: 'Lifecycle producer content',
    confidence: 0.8,
    signal_count: 2,
    created_at: now,
    updated_at: now,
    decay_class: 'stable',
    tags: ['project:test'],
    ...overrides,
  };
}

/** T2-PRIME: no permitted writer may ever emit a literal null for either
 *  lifecycle field, in the Cypher or through a parameter. `SET x = null`
 *  REMOVES the property in Neo4j, which is why (A) binds `?: string` and not
 *  `| null`.
 *
 *  The `= null` half is scoped to the NODE aliases for the same reason the
 *  T5/T8 tail regex is: these queries already carry pre-existing RELATIONSHIP
 *  lifecycle writes (`newR.invalid_at = null`, `about.invalid_at = null`) that
 *  are explicitly out of scope for this packet. An unscoped form would indict
 *  master's own untouched bytes. The map-literal half needs no scoping — no
 *  relationship write in these queries uses the `key: value` form. */
function expectNoNullLifecycleEmission({ query, params }: Captured): void {
  expect(query).not.toMatch(/\b(s|new)\.(valid_at|invalid_at)\s*=\s*null/i);
  expect(query).not.toMatch(/(valid_at|invalid_at)\s*:\s*null/i);
  expect(Object.prototype.hasOwnProperty.call(params, 'valid_at')).toBe(false);
  expect(Object.prototype.hasOwnProperty.call(params, 'invalid_at')).toBe(false);
}

describe('SemanticStore semantic lifecycle producer (RET-005B-AUTH-001B6P)', () => {
  it('T3: create stamps valid_at from the caller-supplied created_at and never an invalid_at', async () => {
    const { store, calls } = makeCapturingStore();
    const node = makeNode({ created_at: '2026-01-02T03:04:05.000Z' });

    await store.create(node);

    const call = calls[0]!;
    expect(call.query).toContain('valid_at: $created_at');
    expect(call.params.created_at).toBe('2026-01-02T03:04:05.000Z');
    expect(call.query).not.toContain('invalid_at');
    expectNoNullLifecycleEmission(call);
  });

  it('T4/T5/T6: supersede stamps the new node at the supersede instant, leaves the old node alone, and writes no lifecycle field after ON CREATE', async () => {
    const { store, calls } = makeCapturingStore();

    await store.supersede('sem-old', makeNode({ id: 'sem-new' }));

    const call = calls[0]!;
    // T4 — the new node carries the supersede instant.
    expect(call.query).toContain('new.valid_at = $now');
    expect(call.params.now).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // T6 — supersession is the [:SUPERSEDES] axis; the OLD node is never stamped.
    expect(call.query).not.toMatch(/\bold\.(valid_at|invalid_at)\b/);

    // T5 — tail guard: nothing from the SUPERSEDES merge onward touches a node
    // lifecycle property, so no lifecycle write can run on the MATCH path.
    const tailStart = call.query.indexOf('MERGE (new)-[:SUPERSEDES]->(old)');
    expect(tailStart).toBeGreaterThan(-1);
    expect(call.query.slice(tailStart)).not.toMatch(NODE_LIFECYCLE_WRITE);

    expectNoNullLifecycleEmission(call);
  });

  it('T7a/T8: promoteFromEpisodic stamps the LATEST source-episode instant and writes no lifecycle field after ON CREATE', async () => {
    const { store, calls } = makeCapturingStore();

    await store.promoteFromEpisodic(['ep-a', 'ep-b'], makeNode({ id: 'sem-promoted' }));

    const call = calls[0]!;
    // T7a — byte-equal expression. `reduce(latest = null …)` with `>` picks the
    // LATEST instant; an earliest-picking implementation cannot emit this.
    expect(call.query).toContain(PROMOTE_VALID_AT_EXPRESSION);
    expect(call.query).toContain('$created_at)');

    // T8 — tail guard from the first line after the ON CREATE clause.
    const tailStart = call.query.indexOf('WITH s, episodes');
    expect(tailStart).toBeGreaterThan(-1);
    expect(call.query.slice(tailStart)).not.toMatch(NODE_LIFECYCLE_WRITE);

    expectNoNullLifecycleEmission(call);
  });
});
