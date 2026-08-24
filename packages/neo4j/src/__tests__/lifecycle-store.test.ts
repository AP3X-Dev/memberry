// packages/neo4j/src/__tests__/lifecycle-store.test.ts
//
// MEM-006 LifecycleStore unit coverage (mock driver, sibling harness style):
//  - sidecar retention: age + budget deletion oldest-first, exact counts,
//    protected-tier rows surviving BOTH rules on BOTH labels, other
//    tenants/scopes untouched;
//  - archive planner: every P1-P6 protection predicate, unreferenced rules,
//    half-life anchors (Semantic updated_at / Episodic created_at);
//  - setArchived / stampDecayProposedAt never touch updated_at.
//
// The fake session implements the store's three sidecar query shapes over an
// in-memory row table so deletion behaviour (not just query text) is pinned.

import { describe, it, expect, vi } from 'vitest';
import { LifecycleStore, SIDECAR_LABELS } from '../lifecycle.js';

interface FakeRow {
  id: string;
  label: (typeof SIDECAR_LABELS)[number];
  tenant_id: string;
  project_scope: string;
  recommended_tier: string;
  observed_at: string;
}

function day(n: number): string {
  return new Date(Date.UTC(2026, 0, n)).toISOString();
}

function record(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] };
}

/** Fake driver serving the sidecar plan/count/delete query shapes over `rows`. */
function makeSidecarDriver(rows: FakeRow[]) {
  const queries: Array<{ cypher: string; params: Record<string, unknown> }> = [];
  const session = {
    run: vi.fn(async (cypher: string, params: Record<string, unknown> = {}) => {
      queries.push({ cypher, params });
      const label = SIDECAR_LABELS.find((l) => cypher.includes(`(x:${l} `));
      if (!label) return { records: [] };
      const inGroup = rows.filter(
        (r) => r.label === label && r.tenant_id === params.tenantId && r.project_scope === params.projectScope,
      );
      if (cypher.includes('DETACH DELETE')) {
        const ids = params.ids as string[];
        const doomed = inGroup.filter((r) => ids.includes(r.id) && r.recommended_tier !== 'protected');
        for (const d of doomed) rows.splice(rows.indexOf(d), 1);
        return { records: [record({ c: doomed.length })] };
      }
      if (cypher.includes("x.recommended_tier = 'protected'")) {
        return { records: [record({ c: inGroup.filter((r) => r.recommended_tier === 'protected').length })] };
      }
      // non-protected fetch, ORDER BY observed_at ASC
      const nonProtected = inGroup
        .filter((r) => r.recommended_tier !== 'protected')
        .sort((a, b) => (a.observed_at < b.observed_at ? -1 : a.observed_at > b.observed_at ? 1 : 0));
      return { records: nonProtected.map((r) => record({ props: { ...r } })) };
    }),
    close: vi.fn(),
  };
  return { driver: { session: vi.fn(() => session) } as any, queries };
}

function seedRows(): FakeRow[] {
  const rows: FakeRow[] = [];
  for (const label of SIDECAR_LABELS) {
    // Target group: tenant-a / project:x — 6 non-protected spread over days 1..6
    // plus 2 protected rows OLDER than everything (must survive the age rule).
    for (let n = 1; n <= 6; n++) {
      rows.push({ id: `${label}-a-${n}`, label, tenant_id: 'tenant-a', project_scope: 'project:x', recommended_tier: 'candidate', observed_at: day(n) });
    }
    rows.push({ id: `${label}-a-p1`, label, tenant_id: 'tenant-a', project_scope: 'project:x', recommended_tier: 'protected', observed_at: day(0 + 1) });
    rows.push({ id: `${label}-a-p2`, label, tenant_id: 'tenant-a', project_scope: 'project:x', recommended_tier: 'protected', observed_at: day(1) });
    // Bystanders: same scope other tenant, same tenant other scope — untouched.
    rows.push({ id: `${label}-b-1`, label, tenant_id: 'tenant-b', project_scope: 'project:x', recommended_tier: 'candidate', observed_at: day(1) });
    rows.push({ id: `${label}-a-y1`, label, tenant_id: 'tenant-a', project_scope: 'project:y', recommended_tier: 'candidate', observed_at: day(1) });
  }
  return rows;
}

describe('LifecycleStore sidecar retention', () => {
  it('plans age + budget deletion oldest-first with exact counts and protected accounting', async () => {
    const rows = seedRows();
    const { driver, queries } = makeSidecarDriver(rows);
    const store = new LifecycleStore(driver);

    // cutoff after day 2 → rows 1,2 expired; budget 2 of the 4 survivors →
    // rows 3,4 (the oldest survivors) over budget; rows 5,6 kept.
    const plan = await store.planSidecarDeletions('tenant-a', 'project:x', day(3), 2);

    for (const label of SIDECAR_LABELS) {
      const p = plan[label];
      expect(p.expiredCount).toBe(2);
      expect(p.overBudgetCount).toBe(2);
      expect(p.keptCount).toBe(2);
      expect(p.protectedCount).toBe(2);
      expect(p.doomed.map((r) => r.id)).toEqual([
        `${label}-a-1`, `${label}-a-2`, `${label}-a-3`, `${label}-a-4`,
      ]);
    }
    // Every plan query excludes protected rows and orders oldest-first.
    const planQueries = queries.filter((q) => !q.cypher.includes('DETACH DELETE') && !q.cypher.includes("= 'protected'"));
    expect(planQueries.length).toBeGreaterThan(0);
    for (const q of planQueries) {
      expect(q.cypher).toContain("x.recommended_tier <> 'protected'");
      expect(q.cypher).toContain('ORDER BY x.observed_at ASC');
    }
  });

  it('deletes exactly the planned rows; protected rows and other tenants/scopes survive on both labels', async () => {
    const rows = seedRows();
    const { driver, queries } = makeSidecarDriver(rows);
    const store = new LifecycleStore(driver);

    const plan = await store.planSidecarDeletions('tenant-a', 'project:x', day(3), 2);
    const deleted = await store.deleteSidecars(
      'tenant-a', 'project:x',
      {
        AdmissionObservation: plan.AdmissionObservation.doomed.map((r) => r.id as string),
        AdmissionRoutingRecommendation: plan.AdmissionRoutingRecommendation.doomed.map((r) => r.id as string),
      },
      1000,
    );

    expect(deleted).toEqual({ AdmissionObservation: 4, AdmissionRoutingRecommendation: 4 });
    for (const label of SIDECAR_LABELS) {
      const survivors = rows.filter((r) => r.label === label).map((r) => r.id).sort();
      expect(survivors).toEqual([
        `${label}-a-5`, `${label}-a-6`, `${label}-a-p1`, `${label}-a-p2`,
        `${label}-a-y1`, `${label}-b-1`,
      ].sort());
    }
    const deleteQueries = queries.filter((q) => q.cypher.includes('DETACH DELETE'));
    expect(deleteQueries).toHaveLength(2);
    for (const q of deleteQueries) {
      // The delete WHERE re-asserts the protected exemption and stays batched.
      expect(q.cypher).toContain("x.recommended_tier <> 'protected'");
      expect(q.cypher).toContain('IN TRANSACTIONS OF 1000 ROWS');
      expect(q.cypher).toContain('{tenant_id: $tenantId, project_scope: $projectScope}');
    }
  });

  it('even a hostile plan (protected ids smuggled in) cannot delete protected rows', async () => {
    const rows = seedRows();
    const { driver } = makeSidecarDriver(rows);
    const store = new LifecycleStore(driver);
    const deleted = await store.deleteSidecars(
      'tenant-a', 'project:x',
      { AdmissionObservation: ['AdmissionObservation-a-p1', 'AdmissionObservation-a-p2'] },
      1000,
    );
    expect(deleted.AdmissionObservation).toBe(0);
    expect(rows.some((r) => r.id === 'AdmissionObservation-a-p1')).toBe(true);
  });

  it('rejects a non-integer batch size (interpolated into IN TRANSACTIONS)', async () => {
    const { driver } = makeSidecarDriver([]);
    const store = new LifecycleStore(driver);
    await expect(store.deleteSidecars('t', 'project:x', { AdmissionObservation: ['a'] }, 10.5))
      .rejects.toThrow('invalid_batch_rows');
    await expect(store.setArchived(['a'], true, day(1), 0)).rejects.toThrow('invalid_batch_rows');
  });
});

describe('LifecycleStore archive planner', () => {
  function capture() {
    const queries: Array<{ cypher: string; params: Record<string, unknown> }> = [];
    const session = {
      run: vi.fn(async (cypher: string, params: Record<string, unknown> = {}) => {
        queries.push({ cypher, params });
        return { records: [record({ c: 0 })] };
      }),
      close: vi.fn(),
    };
    return { driver: { session: vi.fn(() => session) } as any, queries };
  }

  it('carries every protection row P1-P6, the unreferenced rules, and per-class anchors', async () => {
    const { driver, queries } = capture();
    const store = new LifecycleStore(driver);
    await store.planArchive('tenant-a', 'project:x',
      { volatile: day(10), stable: day(5), episodic: day(5) }, ['pending-1']);

    const semantic = queries.find((q) => q.cypher.includes('(s:Semantic)'))!;
    const episodic = queries.find((q) => q.cypher.includes('(e:Episodic)'))!;

    // P1 (both labels)
    expect(semantic.cypher).toContain("coalesce(s.memory_type, '') <> 'decision'");
    expect(episodic.cypher).toContain("coalesce(e.memory_type, '') <> 'decision'");
    // P2 — reinforcement edge, deliberately NOT filtering invalid_at
    expect(semantic.cypher).toContain('NOT EXISTS { MATCH (:Episodic)-[:REINFORCES]->(s) }');
    expect(semantic.cypher).not.toContain('invalid_at IS NULL');
    // P3
    expect(semantic.cypher).toContain("s.decay_class <> 'permanent'");
    // P4
    expect(episodic.cypher).toContain("coalesce(e.outcome, '') <> 'approved'");
    // P5 — both sidecar labels
    expect(episodic.cypher).toContain("(:AdmissionObservation {recommended_tier: 'protected'})-[:OBSERVES]->(e)");
    expect(episodic.cypher).toContain("(:AdmissionRoutingRecommendation {recommended_tier: 'protected'})-[:RECOMMENDS_FOR]->(e)");
    // P6
    expect(semantic.cypher).toContain('NOT s.id IN $pendingIds');
    expect(episodic.cypher).toContain('NOT e.id IN $pendingIds');
    expect(semantic.params.pendingIds).toEqual(['pending-1']);
    // Unreferenced (episodic)
    expect(episodic.cypher).toContain('NOT EXISTS { MATCH (:Semantic)-[:PROMOTED_FROM]->(e) }');
    expect(episodic.cypher).toContain('NOT EXISTS { MATCH ()-[:CORRECTS|REINFORCES|CONTRADICTS]->(e) }');
    // Already-archived rows never re-planned; anchors per class.
    expect(semantic.cypher).toContain('coalesce(s.archived, false) = false');
    expect(episodic.cypher).toContain('coalesce(e.archived, false) = false');
    expect(semantic.cypher).toContain("(s.decay_class = 'volatile' AND s.updated_at < $volatileCutoff)");
    expect(semantic.cypher).toContain("(s.decay_class = 'stable' AND s.updated_at < $stableCutoff)");
    expect(episodic.cypher).toContain('e.created_at < $episodicCutoff');
    expect(semantic.params.volatileCutoff).toBe(day(10));
    expect(episodic.params.episodicCutoff).toBe(day(5));
  });

  it('plan is stable across re-runs (same inputs, byte-identical queries)', async () => {
    const { driver, queries } = capture();
    const store = new LifecycleStore(driver);
    const cutoffs = { volatile: day(10), stable: day(5), episodic: day(5) };
    await store.planArchive('tenant-a', 'project:x', cutoffs, []);
    const first = queries.map((q) => q.cypher);
    await store.planArchive('tenant-a', 'project:x', cutoffs, []);
    expect(queries.slice(first.length).map((q) => q.cypher)).toEqual(first);
  });

  it('setArchived and stampDecayProposedAt never touch updated_at', async () => {
    const { driver, queries } = capture();
    const store = new LifecycleStore(driver);
    await store.setArchived(['sem-1'], true, day(1), 1000);
    await store.setArchived(['sem-1'], false, day(2), 1000);
    await store.stampDecayProposedAt('sem-1', day(3));

    for (const q of queries) {
      expect(q.cypher).not.toContain('updated_at');
    }
    const stamp = queries[queries.length - 1];
    // Single-property SET — the cooldown stamp writes decay_proposed_at only.
    expect(stamp.cypher).toContain('SET s.decay_proposed_at = $now');
    expect((stamp.cypher.match(/SET /g) ?? []).length).toBe(1);
    const archive = queries[0];
    expect(archive.cypher).toContain('SET n.archived = $archived');
    expect(archive.cypher).toContain('IN TRANSACTIONS OF 1000 ROWS');
  });
});

describe('LifecycleStore decay candidates', () => {
  it('excludes protected/archived/cooling-down semantics in the candidate query', async () => {
    const queries: string[] = [];
    const session = {
      run: vi.fn(async (cypher: string) => { queries.push(cypher); return { records: [] }; }),
      close: vi.fn(),
    };
    const store = new LifecycleStore({ session: vi.fn(() => session) } as any);
    await store.findDecayCandidates('tenant-a', 'project:x', day(1));
    const q = queries[0];
    expect(q).toContain("coalesce(s.memory_type, '') <> 'decision'");
    expect(q).toContain("s.decay_class <> 'permanent'");
    expect(q).toContain('NOT EXISTS { MATCH (:Episodic)-[:REINFORCES]->(s) }');
    expect(q).toContain('coalesce(s.archived, false) = false');
    expect(q).toContain('s.decay_proposed_at IS NULL OR s.decay_proposed_at < $cooldownCutoff');
  });
});
