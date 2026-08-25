// packages/core/src/__tests__/hebbian-engine.test.ts
//
// MEM-006H HebbianEngine (fake ring/graph ports, anti-entropy harness style):
//  - sub-flag disabled => not constructible (sibling shape);
//  - destructive tail-drain consumes each ring entry exactly once, per-tenant
//    keys (default un-namespaced vs amp:feedback:<tenant>:log);
//  - §2.3 mapping: was_useful:true increments + touches recency,
//    was_useful:false touches recency only, non-memory sources and malformed
//    entries are counted and dropped, future timestamps clamp to now;
//  - unmatched = requested minus the UNION of both labels' matched ids;
//  - artifact written (injected writer) BEFORE applyUsage;
//  - the 50k per-tenant drain cap bounds a spammed ring;
//  - dry-run drains NOTHING (reports LLEN only).

import { describe, it, expect, vi } from 'vitest';
import { HebbianEngine, HEBBIAN_DRAIN_CAP_RECORDS, type HebbianEngineDeps, type HebbianUsageRow } from '../hebbian.js';

const NOW = Date.UTC(2026, 7, 25);
function iso(ms: number): string { return new Date(ms).toISOString(); }

function entry(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    query: 'how does decay work',
    result_id: 'sem-1',
    source_type: 'semantic',
    was_useful: true,
    session_id: 'session-1',
    timestamp: iso(NOW - 3_600_000),
    ...overrides,
  });
}

function makeDeps(lists: Map<string, string[]>, options: {
  scopes?: Array<{ tenantId: string; scope: string }>;
  matchedIds?: (rows: HebbianUsageRow[]) => Array<{ id: string; scope: string | null }>;
} = {}) {
  const ops: string[] = [];
  const artifacts: Array<{ filePath: string; json: string }> = [];
  const applyCalls: Array<{ tenantId: string; rows: HebbianUsageRow[]; batchRows: number }> = [];

  const ring = {
    // Destructive tail-drain: RPOP consumes from the END (head = index 0).
    rpopBatch: vi.fn(async (key: string, count: number) => {
      ops.push(`rpop:${key}`);
      const list = lists.get(key) ?? [];
      return list.splice(Math.max(0, list.length - count), count).reverse();
    }),
    llen: vi.fn(async (key: string) => (lists.get(key) ?? []).length),
  };
  const graph = {
    listScopes: vi.fn(async () => options.scopes ?? [{ tenantId: 'default', scope: 'project:lab' }]),
    applyUsage: vi.fn(async (tenantId: string, rows: HebbianUsageRow[], batchRows: number) => {
      ops.push(`applyUsage:${tenantId}`);
      applyCalls.push({ tenantId, rows, batchRows });
      const applied = options.matchedIds
        ? options.matchedIds(rows)
        : rows.map((r) => ({ id: r.id, scope: 'project:lab' }));
      return { applied };
    }),
  };
  const deps: HebbianEngineDeps = {
    ring,
    graph,
    config: { mode: 'live' },
    lifecycle: { dryRun: false, batchRows: 500, exportDir: '/tmp/memberry-test' },
    now: () => new Date(NOW),
    writeArtifact: vi.fn((filePath: string, json: string) => {
      ops.push('writeArtifact');
      artifacts.push({ filePath, json });
    }),
  };
  return { deps, ops, artifacts, applyCalls, ring, graph };
}

describe('HebbianEngine construction gate', () => {
  it('cannot be constructed when the sub-flag is disabled', () => {
    const { deps } = makeDeps(new Map());
    expect(() => new HebbianEngine({ ...deps, config: { mode: 'disabled' } })).toThrow(/not_live/);
  });
});

describe('HebbianEngine.run — drain, mapping, artifact ordering', () => {
  it('tail-drains per-tenant keys destructively, consuming each entry exactly once', async () => {
    const lists = new Map<string, string[]>([
      ['amp:feedback:log', [entry(), entry({ result_id: 'sem-2' })]],
      ['amp:feedback:acme:log', [entry({ result_id: 'sem-acme' })]],
    ]);
    const { deps, applyCalls } = makeDeps(lists, {
      scopes: [
        { tenantId: 'default', scope: 'project:lab' },
        { tenantId: 'acme', scope: 'project:acme' },
      ],
    });
    const result = await new HebbianEngine(deps).run();

    expect(lists.get('amp:feedback:log')).toEqual([]);
    expect(lists.get('amp:feedback:acme:log')).toEqual([]);
    const byTenant = Object.fromEntries(result.tenants.map((t) => [t.tenant_id, t]));
    expect(byTenant['default'].drained).toBe(2);
    expect(byTenant['acme'].drained).toBe(1);
    expect(applyCalls.find((c) => c.tenantId === 'acme')?.rows).toEqual([
      { id: 'sem-acme', inc: 1, ts: iso(NOW - 3_600_000) },
    ]);
    // A second run finds nothing — every entry was consumed exactly once.
    const again = await new HebbianEngine(deps).run();
    expect(again.tenants.every((t) => t.drained === 0)).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('maps §2.3: useful increments + recency, unuseful recency-only, counters for the rest, future clamp', async () => {
    const lists = new Map<string, string[]>([
      ['amp:feedback:log', [
        entry(),                                                       // sem-1 +1
        entry({ was_useful: false, timestamp: iso(NOW - 60_000) }),    // sem-1 recency only (newer)
        entry({ result_id: 'ep-1', source_type: 'episodic' }),         // episodic counts too
        entry({ result_id: 'sym-1', source_type: 'symbol' }),          // non-memory source
        'not-json',                                                    // malformed
        entry({ result_id: '' }),                                      // malformed (empty id)
        entry({ was_useful: 'yes' }),                                  // malformed (non-boolean)
        entry({ timestamp: 'not-a-date' }),                            // malformed (unparseable)
        entry({ result_id: 'sem-future', timestamp: iso(NOW + 365 * 86_400_000) }), // clamped to now
      ]],
    ]);
    const { deps, applyCalls } = makeDeps(lists);
    const result = await new HebbianEngine(deps).run();

    const t = result.tenants.find((x) => x.tenant_id === 'default')!;
    expect(t.drained).toBe(9);
    expect(t.malformed).toBe(4);
    expect(t.non_memory_source).toBe(1);

    const rows = Object.fromEntries(applyCalls[0].rows.map((r) => [r.id, r]));
    // sem-1: one useful (+1) and one unuseful (recency only, no increment).
    expect(rows['sem-1']).toEqual({ id: 'sem-1', inc: 1, ts: iso(NOW - 60_000) });
    expect(rows['ep-1'].inc).toBe(1);
    // A forged future timestamp must not grant years of decay protection.
    expect(rows['sem-future'].ts).toBe(iso(NOW));
  });

  it('counts unmatched as requested minus the UNION of both labels\' matched ids', async () => {
    const lists = new Map<string, string[]>([
      ['amp:feedback:log', [
        entry({ result_id: 'sem-1', source_type: 'semantic' }),
        entry({ result_id: 'ep-1', source_type: 'episodic' }),
        entry({ result_id: 'ghost-1' }),
      ]],
    ]);
    // The graph matches sem-1 in the Semantic pass and ep-1 in the Episodic
    // pass — a hit in EITHER label is matched; only ghost-1 is unmatched.
    const { deps, artifacts } = makeDeps(lists, {
      matchedIds: () => [
        { id: 'sem-1', scope: 'project:lab' },
        { id: 'ep-1', scope: 'project:lab' },
      ],
    });
    const result = await new HebbianEngine(deps).run();
    const t = result.tenants.find((x) => x.tenant_id === 'default')!;
    expect(t.unmatched).toBe(1);
    expect(t.applied).toBe(2);
    const finalArtifact = JSON.parse(artifacts[artifacts.length - 1].json);
    expect(finalArtifact.unmatched).toBe(1);
    expect(finalArtifact.applied.map((r: { id: string }) => r.id).sort()).toEqual(['ep-1', 'sem-1']);
  });

  it('writes + fsyncs the artifact BEFORE applyUsage (drained records are durable first)', async () => {
    const lists = new Map<string, string[]>([['amp:feedback:log', [entry()]]]);
    const { deps, ops, artifacts } = makeDeps(lists);
    await new HebbianEngine(deps).run();
    expect(ops.indexOf('writeArtifact')).toBeGreaterThanOrEqual(0);
    expect(ops.indexOf('writeArtifact')).toBeLessThan(ops.indexOf('applyUsage:default'));
    expect(artifacts[0].filePath).toContain('lifecycle');
    expect(artifacts[0].filePath).toContain('hebbian');
    const first = JSON.parse(artifacts[0].json);
    // The pre-apply artifact already carries the full aggregated rows (replay copy).
    expect(first.applied).toEqual([{ id: 'sem-1', scope: null, inc: 1, last_accessed: iso(NOW - 3_600_000) }]);
    expect(first.replay_note).toContain('not idempotent');
  });

  it('bounds one drain at 50k records per tenant even against a spammed ring', async () => {
    const { deps, ring } = makeDeps(new Map());
    // Infinite ring: always returns exactly what was asked for.
    let served = 0;
    ring.rpopBatch.mockImplementation(async (_key: string, count: number) => {
      served += count;
      return Array.from({ length: count }, () => entry());
    });
    const result = await new HebbianEngine(deps).run();
    // The scope tenant 'default' dedupes with DEFAULT_TENANT: one tenant drained.
    expect(served).toBe(HEBBIAN_DRAIN_CAP_RECORDS);
    expect(result.tenants).toHaveLength(1);
    expect(result.tenants[0].drained).toBe(HEBBIAN_DRAIN_CAP_RECORDS);
  });

  it('dry-run drains NOTHING: reports LLEN, never RPOPs, never applies', async () => {
    const lists = new Map<string, string[]>([['amp:feedback:log', [entry(), entry()]]]);
    const { deps, ring, graph, artifacts } = makeDeps(lists);
    const result = await new HebbianEngine(deps).run({ dryRun: true });
    expect(ring.rpopBatch).not.toHaveBeenCalled();
    expect(graph.applyUsage).not.toHaveBeenCalled();
    expect(lists.get('amp:feedback:log')).toHaveLength(2);
    const t = result.tenants.find((x) => x.tenant_id === 'default')!;
    expect(t.ring_length).toBe(2);
    expect(t.drained).toBe(0);
    expect(result.dry_run).toBe(true);
    expect(artifacts).toHaveLength(0); // nothing was drained; there is nothing to persist
  });

  it('a tenant with graph presence but no ring is left alone (empty drain, no failure)', async () => {
    const { deps, graph } = makeDeps(new Map(), {
      scopes: [{ tenantId: 'quiet', scope: 'project:q' }],
    });
    const result = await new HebbianEngine(deps).run();
    expect(result.failures).toEqual([]);
    expect(result.tenants.map((t) => t.tenant_id).sort()).toEqual(['default', 'quiet']);
    expect(graph.applyUsage).not.toHaveBeenCalled();
  });
});
