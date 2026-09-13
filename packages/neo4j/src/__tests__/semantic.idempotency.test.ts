import { describe, expect, it, vi } from 'vitest';
import type { Driver } from 'neo4j-driver';
import type { SemanticNode, EmbeddingProvider } from '@memberry/core';
import { SemanticStore } from '../semantic.js';

describe('SemanticStore promotion ambiguous-commit replay contract', () => {
  it('uses deterministic-id exact-provenance replay while rejecting other overlaps', async () => {
    const queries: string[] = [];
    const run = vi.fn(async (query: string) => {
      queries.push(query);
      if (query.includes('KnowledgeEpoch')) {
        return { records: [{ get: () => '1' }] };
      }
      return {
        records: [{
          get: (key: string) => {
            if (key === 'tenantId') return 'default';
            if (key === 'projectScope') return 'project:test';
            return 'semantic-stable';
          },
        }],
      };
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
// objects — the only surface this mock harness can observe. Successor valid_at
// remains ON CREATE-only so replay cannot restamp it; PR-01 intentionally adds
// the matching predecessor invalid_at write after successor creation.

// AMENDMENT 4's bound site-3 expression, byte-for-byte including the `null`
// reduce seed and the `>` comparator. An earliest-picking implementation cannot
// produce this string.
const PROMOTE_VALID_AT_EXPRESSION = [
  '                      s.valid_at = coalesce(reduce(latest = null, ep IN episodes |',
  '                        CASE WHEN latest IS NULL OR ep.created_at > latest',
  '                             THEN ep.created_at ELSE latest END), $created_at)',
].join('\n');

/** A successor lifecycle rewrite after creation. The predecessor's
 * `invalid_at` write is intentional: PR-01 makes it the authoritative end of
 * the old Semantic's active interval. */
const SUCCESSOR_LIFECYCLE_WRITE = /\bSET\s+new\.(valid_at|invalid_at)\b/;
const NODE_LIFECYCLE_WRITE = /\b(s|new)\.(valid_at|invalid_at)\b/;

type Captured = { query: string; params: Record<string, unknown> };

function makeCapturingStore(resultId: string | null = 'sem-lifecycle', embedding?: EmbeddingProvider): {
  store: SemanticStore;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const run = vi.fn(async (query: string, params: Record<string, unknown>) => {
    calls.push({ query, params });
    if (query.includes('KnowledgeEpoch')) {
      return { records: [{ get: () => '1' }] };
    }
    return {
      records: resultId === null ? [] : [{
        get: (key: string) => {
          if (key === 'tenantId') return params.tenant_id ?? 'default';
          if (key === 'projectScope') return params.scope ?? 'project:test';
          return resultId;
        },
      }],
    };
  });
  const executeWrite = vi.fn(async (work: (tx: { run: typeof run }) => Promise<unknown>) =>
    work({ run }));
  const close = vi.fn().mockResolvedValue(undefined);
  const driver = { session: vi.fn(() => ({ run, executeWrite, close })) } as unknown as Driver;
  return { store: new SemanticStore(driver, embedding), calls };
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

  it('T4/T5/T6: supersede closes the old node and ABOUT edges at the successor valid_at instant', async () => {
    const { store, calls } = makeCapturingStore();

    await store.supersede('sem-old', makeNode({ id: 'sem-new' }));

    const call = calls[0]!;
    // T4 — the new node carries the supersede instant.
    expect(call.query).toContain('new.valid_at = $now');
    expect(call.params.now).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // PR-01 — one instant owns the entire transition. The old node and each
    // active old ABOUT edge close at the successor's persisted valid_at.
    expect(call.query).toContain('old.invalid_at = new.valid_at');
    expect(call.query).toContain('SET oldR.invalid_at = new.valid_at');
    expect(call.query).toContain('SET newR.valid_at = new.valid_at');
    expect(call.query).toContain('SET transition.valid_at = new.valid_at');
    expect(call.query).toContain('FOREACH (_ IN CASE WHEN size(successors) = 0 THEN [1] ELSE [] END');
    expect(call.query).toContain('WHERE applied');
    expect(call.query).toContain('coalesce(e.tenant_id, $default_tenant) = $tenant_id');
    expect(call.query).toContain('= new.scope');
    expect(call.query).toContain('datetime(oldR.invalid_at) > datetime(new.valid_at) ELSE false END');
    expect(call.query).toContain('datetime(coalesce(oldR.valid_at, old.valid_at, old.created_at)) <= datetime(new.valid_at) ELSE false END');
    expect(call.query).not.toContain('oldR.invalid_at >=');
    expect(call.query).toContain("old.status = 'superseded'");

    // Exact replay must not restamp the successor's lifecycle window.
    const tailStart = call.query.indexOf('MERGE (new)-[transition:SUPERSEDES]->(old)');
    expect(tailStart).toBeGreaterThan(-1);
    expect(call.query.slice(tailStart)).not.toMatch(SUCCESSOR_LIFECYCLE_WRITE);

    expectNoNullLifecycleEmission(call);
  });

  it('serializes on the predecessor and permits only an exact existing successor replay', async () => {
    const { store, calls } = makeCapturingStore();

    await store.supersede('sem-old', makeNode({ id: 'sem-new' }));

    const call = calls[0]!;
    expect(call.query).toContain('SET old.__supersede_lock = true');
    expect(call.query).toContain('REMOVE old.__supersede_lock');
    expect(call.query.indexOf('REMOVE old.__supersede_lock')).toBeLessThan(
      call.query.indexOf('coalesce(old.tenant_id, $default_tenant) = $tenant_id'),
    );
    expect(call.query).toContain('OPTIONAL MATCH (successor:Semantic)-[:SUPERSEDES]->(old)');
    expect(call.query).toContain('all(candidate IN successors WHERE candidate.id = $id)');
    expect(call.query).toContain('SET new.__supersession_claim_lock = true');
    expect(call.query).toContain('REMOVE new.__supersession_claim_lock');
    expect(call.query).toContain('OPTIONAL MATCH (new)-[:SUPERSEDES]->(claimedPredecessor:Semantic)');
    expect(call.query).toContain('new.supersession_operation_digest = $operation_digest');
    expect(call.query).toContain("coalesce(new.status, 'active') = 'active'");
    expect(call.query).toContain('claimedPredecessors[0].id = old.id');
    expect(call.query).toContain('old.invalid_at = new.valid_at');
  });

  it('rejects cross-tenant, cross-project, and colliding successor identities before MERGE', async () => {
    const { store, calls } = makeCapturingStore();

    await store.supersede('sem-old', makeNode({
      id: 'sem-new',
      tenant_id: 'tenant-a',
      scope: 'PROJECT:Alpha',
      tags: ['PROJECT:Alpha'],
    }));

    const call = calls[0]!;
    expect(call.params.tenant_id).toBe('tenant-a');
    expect(call.params.scope).toBe('project:alpha');
    expect(call.params.non_project_tags).toEqual([]);
    expect(call.query).toContain('coalesce(old.tenant_id, $default_tenant) = $tenant_id');
    expect(call.query).toContain("toLower(tag) STARTS WITH 'project:'");
    expect(call.query).toContain('$scope IS NULL OR oldProjectScope = $scope');
    expect(call.query).toContain('coalesce(new.tenant_id, $default_tenant) = $tenant_id');
    expect(call.query).toContain("coalesce(toLower(new.scope), '') = oldProjectScope");
    expect(call.query).toContain('size(successors) = 0');
    expect(call.query.indexOf('$scope IS NULL OR oldProjectScope = $scope')).toBeLessThan(
      call.query.indexOf('MERGE (new:Semantic {id: $id})'),
    );
  });

  it('requires the predecessor to be currently eligible at the single transaction instant', async () => {
    const { store, calls } = makeCapturingStore();

    await store.supersede('sem-old', makeNode({ id: 'sem-new' }));

    const call = calls[0]!;
    expect(call.query).toContain('datetime(coalesce(old.valid_at, old.created_at)) <= datetime($now) ELSE false END');
    expect(call.query).toContain('toString(coalesce(old.valid_at, old.created_at)) =~');
    expect(call.query).toContain('old.invalid_at IS NULL');
    expect(call.query).toContain('coalesce(old.archived, false) = false');
    expect(call.query).toContain("coalesce(old.status, 'active') = 'active'");
    expect(call.query).toContain('datetime(coalesce(new.valid_at, new.created_at)) <= datetime($now) ELSE false END');
    expect(call.query).toContain('toString(coalesce(new.valid_at, new.created_at)) =~');
    expect(call.query).toContain('new.invalid_at IS NULL');
    expect(call.query).toContain('coalesce(new.archived, false) = false');
  });

  it('rejects ambiguous caller project identity before opening a database session', async () => {
    const session = vi.fn();
    const store = new SemanticStore({ session } as unknown as Driver);
    const cases: SemanticNode[] = [
      makeNode({ scope: 'project:alpha', tags: ['project:beta'] }),
      makeNode({ tags: ['project:alpha', 'project:alpha'] }),
      makeNode({ tags: ['project:*'] }),
      makeNode({ scope: 'project:' }),
    ];

    for (const node of cases) {
      await expect(store.supersede('sem-old', node)).rejects.toThrow(/project/);
    }
    expect(session).not.toHaveBeenCalled();
  });

  it('binds every caller-owned immutable field to a deterministic replay digest', async () => {
    const { store, calls } = makeCapturingStore();
    const base: SemanticNode & { embedding?: number[] } = makeNode({
      id: 'sem-new',
      scope: 'project:test',
      tags: ['durable', 'project:test'],
      memory_type: 'decision',
    });
    base.embedding = [0.1, 0.2];

    await store.supersede('sem-old', base);
    await store.supersede('sem-old', { ...base });
    const variants: Array<[string, SemanticNode & { embedding?: number[] }]> = [
      ['sem-old-other', { ...base }],
      ['sem-old', { ...base, id: 'sem-new-other' }],
      ['sem-old', { ...base, content: `${base.content} changed` }],
      ['sem-old', { ...base, confidence: 0.7 }],
      ['sem-old', { ...base, signal_count: 3 }],
      ['sem-old', { ...base, created_at: '2026-01-01T00:00:00.000Z' }],
      ['sem-old', { ...base, updated_at: '2026-01-02T00:00:00.000Z' }],
      ['sem-old', { ...base, decay_class: 'volatile' }],
      ['sem-old', { ...base, memory_type: 'preference' }],
      ['sem-old', { ...base, tags: ['different', 'project:test'] }],
      ['sem-old', { ...base, scope: 'project:other', tags: ['durable', 'project:other'] }],
      ['sem-old', { ...base, tenant_id: 'tenant-other' }],
      ['sem-old', { ...base, embedding: [0.3, 0.4] }],
    ];
    for (const [candidateOldId, candidate] of variants) {
      await store.supersede(candidateOldId, candidate);
    }

    const supersessionCalls = calls.filter((call) => !call.query.includes('KnowledgeEpoch'));
    expect(supersessionCalls[0]!.params.operation_digest).toBe(
      supersessionCalls[1]!.params.operation_digest,
    );
    for (const call of supersessionCalls.slice(2)) {
      expect(call.params.operation_digest).not.toBe(
        supersessionCalls[0]!.params.operation_digest,
      );
    }
    expect(supersessionCalls[0]!.params.non_project_tags).toEqual(['durable']);
    expect(supersessionCalls[0]!.query).toContain(
      'new.supersession_operation_digest = $operation_digest',
    );
    expect(supersessionCalls[0]!.query).toContain(
      'new.tags = $non_project_tags + [oldProjectScope]',
    );
  });

  it('fails closed when the transactional ownership guards reject the write', async () => {
    const { store } = makeCapturingStore(null);

    await expect(store.supersede('sem-old', makeNode({ id: 'sem-new' }))).rejects.toThrow(
      'outside tenant/project, inactive, or already has a conflicting successor',
    );
  });

  it('throws a rejected post-MERGE claim inside executeWrite so the transaction rolls back', async () => {
    let callbackRejected = false;
    let query = '';
    const close = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn(async (cypher: string) => {
      query = cypher;
      return { records: [] };
    });
    const executeWrite = vi.fn(async (work: (tx: { run: typeof run }) => Promise<unknown>) => {
      try {
        return await work({ run });
      } catch (error) {
        callbackRejected = true;
        throw error;
      }
    });
    const store = new SemanticStore({
      session: vi.fn(() => ({ executeWrite, close })),
    } as unknown as Driver);

    await expect(store.supersede('sem-old', makeNode({ id: 'shared-new-id' }))).rejects.toThrow(
      'conflicting successor',
    );

    expect(callbackRejected).toBe(true);
    expect(query.indexOf('new.supersession_operation_digest = $operation_digest')).toBeLessThan(
      query.indexOf('MERGE (new)-[transition:SUPERSEDES]->(old)'),
    );
    expect(query.indexOf('MERGE (new)-[transition:SUPERSEDES]->(old)')).toBeLessThan(
      query.lastIndexOf('old.invalid_at = new.valid_at'),
    );
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


describe('Semantic embedding request authority', () => {
  it('uses explicit node authority for create and supersede; leaves source-derived promotion uncached', async () => {
    const embed = vi.fn().mockResolvedValue([0.1, 0.2]);
    const { store } = makeCapturingStore('sem-lifecycle', { embed, embedBatch: vi.fn() });
    const node = makeNode({ tenant_id: 'tenant-a', scope: 'project:test' });
    await store.create(node);
    expect(embed).toHaveBeenLastCalledWith(node.content, { tenantId: 'tenant-a', projectScope: 'project:test' });
    await store.supersede('old-semantic', node);
    expect(embed).toHaveBeenLastCalledWith(node.content, { tenantId: 'tenant-a', projectScope: 'project:test' });
    await store.promoteFromEpisodic(['episode'], node, 'tenant-a');
    expect(embed).toHaveBeenLastCalledWith(node.content);
  });

  it('keeps ambiguous create and predecessor-inherited supersession uncached', async () => {
    const embed = vi.fn().mockResolvedValue([0.1, 0.2]);
    const { store } = makeCapturingStore('sem-lifecycle', { embed, embedBatch: vi.fn() });
    await store.create(makeNode({ scope: 'project:other' }));
    expect(embed).toHaveBeenLastCalledWith('Lifecycle producer content');
    await store.create(makeNode({ tags: [] }));
    expect(embed).toHaveBeenLastCalledWith('Lifecycle producer content');
    await store.supersede('old-semantic', makeNode({ tags: [] }));
    expect(embed).toHaveBeenLastCalledWith('Lifecycle producer content');
  });
});
