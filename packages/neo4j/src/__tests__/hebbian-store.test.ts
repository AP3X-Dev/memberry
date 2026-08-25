// packages/neo4j/src/__tests__/hebbian-store.test.ts
//
// MEM-006H LifecycleStore surface (session-mock, lifecycle-store.test.ts
// style):
//  - applyUsage: two labeled anchored-id statements (Semantic + Episodic) with
//    tenant re-assertion, coalesced increment, monotonic last_accessed CASE,
//    batched IN TRANSACTIONS — and NEVER updated_at; matched ids are the UNION
//    of both labels' hits, so a Semantic hit is never "unmatched" just because
//    the Episodic pass missed it;
//  - findDecayCandidates returns the new OPTIONAL usage columns;
//  - planArchive without options emits today's exact query shape (no
//    last_accessed anywhere); with hebbian options it adds the narrowing-only
//    access guard and the never-accessed-first ordering, plus guarded counts;
//  - stampReclassProposedAt / updateDecayClass never touch updated_at.

import { describe, it, expect, vi } from 'vitest';
import { LifecycleStore } from '../lifecycle.js';
import { SemanticStore } from '../semantic.js';

function day(n: number): string {
  return new Date(Date.UTC(2026, 0, n)).toISOString();
}

function record(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] };
}

function capture(respond?: (cypher: string, params: Record<string, unknown>) => { records: Array<{ get: (k: string) => unknown }> }) {
  const queries: Array<{ cypher: string; params: Record<string, unknown> }> = [];
  const run = vi.fn(async (cypher: string, params: Record<string, unknown> = {}) => {
    queries.push({ cypher, params });
    return respond?.(cypher, params) ?? { records: [record({ c: 0 })] };
  });
  const session = {
    run,
    executeWrite: vi.fn(async (work: (tx: { run: typeof run }) => unknown) => work({ run })),
    close: vi.fn(),
  };
  return { driver: { session: vi.fn(() => session) } as any, queries };
}

describe('LifecycleStore.applyUsage', () => {
  it('matches per label with tenant re-assertion; the union of both labels feeds matched (P2-6)', async () => {
    // sem-1 exists as Semantic, ep-1 as Episodic, ghost-1 as neither.
    const { driver, queries } = capture((cypher) => {
      if (cypher.includes('(n:Semantic')) {
        return { records: [record({ applied: [{ id: 'sem-1', scope: 'project:x' }] })] };
      }
      return { records: [record({ applied: [{ id: 'ep-1', scope: 'project:x' }] })] };
    });
    const store = new LifecycleStore(driver);
    const rows = [
      { id: 'sem-1', inc: 1, ts: day(10) },
      { id: 'ep-1', inc: 0, ts: day(10) },
      { id: 'ghost-1', inc: 1, ts: day(10) },
    ];
    const result = await store.applyUsage('tenant-a', rows, 1000);

    // One statement per label, both anchored on the unique id constraint.
    expect(queries).toHaveLength(2);
    expect(queries[0].cypher).toContain('MATCH (n:Semantic {id: row.id})');
    expect(queries[1].cypher).toContain('MATCH (n:Episodic {id: row.id})');
    for (const q of queries) {
      // Tenant re-assertion: a hostile cross-tenant result_id matches nothing.
      expect(q.cypher).toContain('coalesce(n.tenant_id, $defaultTenant) = $tenantId');
      expect(q.params.tenantId).toBe('tenant-a');
      // Coalesced increment + monotonic last_accessed.
      expect(q.cypher).toContain('n.access_count = coalesce(n.access_count, 0) + row.inc');
      expect(q.cypher).toContain('n.last_accessed IS NULL OR n.last_accessed < row.ts');
      expect(q.cypher).toContain('IN TRANSACTIONS OF 1000 ROWS');
      // Usage recency must never reset the decay anchor.
      expect(q.cypher).not.toContain('updated_at');
    }

    // UNION of both labels: a Semantic hit is matched even though the
    // Episodic pass missed it, and vice versa; only ghost-1 remains.
    const matched = new Set(result.applied.map((a) => a.id));
    expect([...matched].sort()).toEqual(['ep-1', 'sem-1']);
    expect(rows.filter((r) => !matched.has(r.id)).map((r) => r.id)).toEqual(['ghost-1']);
  });

  it('is a no-op on empty rows and rejects bad batch sizes', async () => {
    const { driver, queries } = capture();
    const store = new LifecycleStore(driver);
    expect(await store.applyUsage('t', [], 1000)).toEqual({ applied: [] });
    expect(queries).toHaveLength(0);
    await expect(store.applyUsage('t', [{ id: 'a', inc: 1, ts: day(1) }], 0))
      .rejects.toThrow('invalid_batch_rows');
  });
});

describe('LifecycleStore.findDecayCandidates usage columns', () => {
  it('returns last_accessed / access_count / reclass_proposed_at as optional columns', async () => {
    const { driver, queries } = capture(() => ({
      records: [record({
        id: 'sem-1', confidence: 0.9, decay_class: 'stable', updated_at: day(1),
        last_accessed: day(5), access_count: 12, reclass_proposed_at: null,
      })],
    }));
    const store = new LifecycleStore(driver);
    const [candidate] = await store.findDecayCandidates('tenant-a', 'project:x', day(1));
    expect(queries[0].cypher).toContain('s.last_accessed AS last_accessed');
    expect(queries[0].cypher).toContain('s.access_count AS access_count');
    expect(queries[0].cypher).toContain('s.reclass_proposed_at AS reclass_proposed_at');
    expect(candidate).toMatchObject({
      id: 'sem-1', last_accessed: day(5), access_count: 12, reclass_proposed_at: null,
    });
  });
});

describe('LifecycleStore.planArchive hebbian options', () => {
  const cutoffs = { volatile: day(10), stable: day(5), episodic: day(5) };

  it('without options: today\'s exact query shape — no access guard, no last_accessed, old ordering', async () => {
    const { driver, queries } = capture(() => ({ records: [] }));
    const store = new LifecycleStore(driver);
    await store.planArchive('tenant-a', 'project:x', cutoffs, []);
    expect(queries).toHaveLength(2);
    for (const q of queries) {
      expect(q.cypher).not.toContain('last_accessed');
      expect(q.cypher).not.toContain('$accessCutoff');
      expect(q.params).not.toHaveProperty('accessCutoff');
    }
    expect(queries[0].cypher).toContain('ORDER BY s.updated_at ASC, s.id ASC');
    expect(queries[1].cypher).toContain('ORDER BY e.created_at ASC, e.id ASC');
  });

  it('with options: narrowing-only access guard + never-accessed-first ordering + guarded counts', async () => {
    const { driver, queries } = capture((cypher) => {
      if (cypher.includes('count(')) return { records: [record({ c: 3 })] };
      return { records: [] };
    });
    const store = new LifecycleStore(driver);
    const plan = await store.planArchive('tenant-a', 'project:x', cutoffs, [],
      { hebbian: { accessCutoffIso: day(2) } });

    const semantic = queries.find((q) => q.cypher.includes('(s:Semantic)') && !q.cypher.includes('count('))!;
    const episodic = queries.find((q) => q.cypher.includes('(e:Episodic)') && !q.cypher.includes('count('))!;
    // Narrowing-only guard: it can only REMOVE nodes from the plan.
    expect(semantic.cypher).toContain('(s.last_accessed IS NULL OR s.last_accessed < $accessCutoff)');
    expect(episodic.cypher).toContain('(e.last_accessed IS NULL OR e.last_accessed < $accessCutoff)');
    expect(semantic.params.accessCutoff).toBe(day(2));
    // Never-accessed nodes sink to archive first (deterministic plan order).
    expect(semantic.cypher).toContain('ORDER BY s.last_accessed IS NOT NULL, s.updated_at ASC, s.id ASC');
    expect(episodic.cypher).toContain('ORDER BY e.last_accessed IS NOT NULL, e.created_at ASC, e.id ASC');
    // Every P1-P6 predicate and the cutoff TIMES survive byte-for-byte.
    expect(semantic.cypher).toContain("coalesce(s.memory_type, '') <> 'decision'");
    expect(semantic.cypher).toContain("(s.decay_class = 'volatile' AND s.updated_at < $volatileCutoff)");
    expect(episodic.cypher).toContain('e.created_at < $episodicCutoff');
    // Guarded counts (recently-accessed rows the guard excluded) per label.
    expect(plan.accessGuarded).toBe(6);
  });
});

describe('reclass stamps and application writes', () => {
  it('stampReclassProposedAt is a single-property SET that never touches updated_at', async () => {
    const { driver, queries } = capture();
    const store = new LifecycleStore(driver);
    await store.stampReclassProposedAt('sem-1', day(3));
    const q = queries[0];
    expect(q.cypher).toContain('SET s.reclass_proposed_at = $now');
    expect((q.cypher.match(/SET /g) ?? []).length).toBe(1);
    expect(q.cypher).not.toContain('updated_at');
  });

  it('updateDecayClass mirrors the updateConfidence ledger but sets ONLY decay_class (no updated_at)', async () => {
    const { driver, queries } = capture(() => ({ records: [record({ id: 'sem-1' })] }));
    const store = new SemanticStore(driver);
    await store.updateDecayClass('sem-1', 'stable', 'proposal-key-1');
    const q = queries[0];
    // Same lock + applied_consolidation_keys idempotency ledger as updateConfidence.
    expect(q.cypher).toContain('__confidence_application_lock');
    expect(q.cypher).toContain('applied_consolidation_keys');
    expect(q.cypher).toContain('$application_key IS NULL OR NOT $application_key IN applied');
    expect(q.cypher).toContain('s.decay_class = $decay_class');
    // The class change deliberately does NOT reset the decay anchor.
    expect(q.cypher).not.toContain('updated_at');
    expect(q.params.application_key).toBe('proposal-key-1');
    expect(q.params.decay_class).toBe('stable');
  });
});
