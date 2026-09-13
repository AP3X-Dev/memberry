// Explicit legacy vector fixtures below are unqualified historical compatibility evidence.
import { describe, expect, it, vi } from 'vitest';
import { ScopedQuery, semanticEligibilityWhere } from '../query.js';

function captureDriver() {
  const calls: Array<{ cypher: string; params: Record<string, unknown> }> = [];
  const session = {
    run: vi.fn(async (cypher: string, params: Record<string, unknown> = {}) => {
      calls.push({ cypher, params });
      return { records: [] };
    }),
    close: vi.fn(async () => undefined),
  };
  return { driver: { session: vi.fn(() => session) } as never, calls };
}

describe('semanticEligibilityWhere', () => {
  it('defines one half-open lifecycle and authorized same-scope supersession predicate', () => {
    const predicate = semanticEligibilityWhere('s', 'tenant-a');

    expect(predicate).toContain('coalesce(s.archived, false) = false');
    expect(predicate).toContain('datetime(coalesce(s.valid_at, s.created_at)) IS NOT NULL');
    expect(predicate).toContain('datetime(coalesce(s.valid_at, s.created_at)) <= datetime($semanticAsOf)');
    expect(predicate).toContain('datetime(s.invalid_at) > datetime($semanticAsOf)');
    expect(predicate).toContain('size(reduce(scopes = [], projectTag IN [tag IN coalesce(s.tags, [])');
    expect(predicate).toContain("all(projectTag IN [tag IN coalesce(s.tags, [])");
    expect(predicate).toContain('projectTag = toLower(toString(s.scope))');
    expect(predicate).toContain('MATCH (eligibleSuccessor:Semantic)-[:SUPERSEDES]->(s)');
    expect(predicate).toContain('eligibleSuccessor.tenant_id = $tenantId');
    expect(predicate).toContain("coalesce(toLower(toString(eligibleSuccessor.scope))");
    expect(predicate).toContain("= coalesce(toLower(toString(s.scope))");
    expect(predicate).toContain('projectTag = toLower(toString(eligibleSuccessor.scope))');
    expect(predicate).toContain('datetime(coalesce(eligibleSuccessor.valid_at, eligibleSuccessor.created_at)) <= datetime($semanticAsOf)');
    expect(predicate).not.toContain('eligibleSuccessor.archived');
    expect(predicate).not.toContain('eligibleSuccessor.invalid_at');
    expect(predicate).toContain('ELSE true END');
  });

  it('uses the caller-selected parameter for historical reads', () => {
    const predicate = semanticEligibilityWhere('node', 'default', 'asOf');
    expect(predicate).toContain('<= datetime($asOf)');
    expect(predicate).toContain('> datetime($asOf)');
    expect(predicate).toContain('(eligibleSuccessor.tenant_id IS NULL OR eligibleSuccessor.tenant_id = $tenantId)');
    expect(predicate).not.toContain('$semanticAsOf');
  });
});

describe('ScopedQuery semantic eligibility coverage', () => {
  it('applies the canonical predicate to every legacy semantic candidate query', async () => {
    const { driver, calls } = captureDriver();
    const query = new ScopedQuery(driver, { legacyUnqualified: true });

    await query.byEntity('entity', 5);
    await query.byTag('tag', 5);
    await query.byScope({ entityIds: ['entity-id'], tags: ['tag'], limit: 5 });
    await query.byScope({ entityIds: ['entity-id'], limit: 5 });
    await query.byScope({ entities: ['entity'], tags: ['tag'], limit: 5 });
    await query.byScope({ entities: ['entity'], limit: 5 });
    await query.byScope({ tags: ['tag'], limit: 5 });
    await query.byScope({ limit: 5 });
    await query.byVector([0.1], 5);
    await query.byEntityWithFacts('entity');
    await query.expandByGraph(['entity']);

    const semanticCalls = calls.filter(({ cypher }) =>
      cypher.includes(':Semantic') && !cypher.includes(':Episodic'),
    );
    expect(semanticCalls).toHaveLength(13);

    for (const { cypher, params } of semanticCalls) {
      expect(cypher).toContain(':SUPERSEDES');
      expect(cypher).toContain('.valid_at');
      expect(cypher).toContain('.invalid_at');
      expect(params.semanticAsOf).toEqual(expect.any(String));
      expect(Number.isNaN(Date.parse(params.semanticAsOf as string))).toBe(false);
    }

    const vectorCall = calls.find(({ cypher }) => cypher.includes("queryNodes('semantic_embedding'"));
    expect(Number(vectorCall?.params.fetch)).toBeGreaterThan(Number(vectorCall?.params.limit));
    const fallbackCall = calls.find(({ cypher }) => cypher.includes('node.embedding AS embedding'));
    expect(fallbackCall?.cypher).toContain(':SUPERSEDES');
    expect(Number(fallbackCall?.params.fallbackScanLimit)).toBe(1001);

    const byEntity = calls.find(({ cypher }) => cypher.includes('(e:Entity {name: $entityName})')
      && cypher.includes('LIMIT $limit'));
    expect(byEntity?.cypher).toContain('e.tenant_id');
    const graphCalls = calls.filter(({ cypher }) => cypher.includes('hopScore'));
    expect(graphCalls).toHaveLength(2);
    expect(graphCalls[0]?.cypher).toContain('e.tenant_id');
    expect(graphCalls[0]?.cypher).toContain('s.tenant_id');
    expect(graphCalls[0]?.cypher).toContain('e2.tenant_id');
    expect(graphCalls[0]?.cypher).toContain('s2.tenant_id');
    expect(graphCalls[0]?.cypher.match(/:SUPERSEDES/g)).toHaveLength(2);
    expect(graphCalls[1]?.cypher).toContain('f1.tenant_id');
    expect(graphCalls[1]?.cypher).toContain('f2.tenant_id');
  });

  it('binds the requested instant consistently for historical semantic reads', async () => {
    const { driver, calls } = captureDriver();
    const query = new ScopedQuery(driver, { legacyUnqualified: true });
    const asOf = '2025-02-03T04:05:06.789Z';

    await query.byEntity('entity', 5, asOf, 'tenant-a');
    await query.byScope({ tags: ['tag'], limit: 5, asOf, tenantId: 'tenant-a' });
    await query.byEntityWithFacts('entity', { time_mode: 'historical', as_of: asOf }, 'tenant-a');
    await query.expandByGraph(['entity'], 1, 5, asOf, 'tenant-a');

    const semanticCalls = calls.filter(({ cypher }) =>
      cypher.includes(':Semantic') && !cypher.includes(':Episodic'),
    );
    expect(semanticCalls).toHaveLength(5);
    for (const { cypher, params } of semanticCalls) {
      expect(cypher).toContain('coalesce(');
      expect(cypher).toContain('<= datetime($asOf)');
      expect(cypher).toContain('> datetime($asOf)');
      expect(params.asOf).toBe(asOf);
      expect(params).not.toHaveProperty('semanticAsOf');
    }
    const expansion = semanticCalls.find(({ cypher }) => cypher.includes('[r2:ABOUT]'));
    expect(expansion?.cypher).toContain("COALESCE(r2.valid_at, '1970-01-01T00:00:00.000Z') <= $asOf");
    expect(expansion?.cypher).toContain("COALESCE(r3.valid_at, '1970-01-01T00:00:00.000Z') <= $asOf");
  });

  it('binds exact tenant and project authority at every graph endpoint', async () => {
    const { driver, calls } = captureDriver();
    const query = new ScopedQuery(driver, { legacyUnqualified: true });
    await query.byEntity('entity', 5, undefined, 'tenant-a', 'PROJECT:Alpha');
    await query.byEntityWithFacts('entity', undefined, 'tenant-a', 'PROJECT:Alpha');
    await query.expandByGraph(['entity'], 1, 5, undefined, 'tenant-a', 'PROJECT:Alpha');

    expect(calls.every(({ params }) => params.tenantId === 'tenant-a')).toBe(true);
    expect(calls.every(({ params }) => params.projectScope === 'project:alpha')).toBe(true);
    const joined = calls.map(({ cypher }) => cypher).join('\n');
    for (const alias of ['e', 'e2', 's', 's2', 'f', 'f1', 'f2', 'ep']) {
      expect(joined).toContain(`${alias}.tenant_id`);
    }
    expect(joined).toContain('project_scope');
    expect(joined).toContain("candidate STARTS WITH 'project:'");
  });

  it('uses an eligibility-filtered bounded cosine scan when the vector index underfills', async () => {
    const current = {
      id: 'sem-v2', content: 'current', confidence: 0.4, signal_count: 1,
      created_at: '2026-01-02T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z',
      decay_class: 'stable', tags: ['project:alpha'], scope: 'project:alpha',
    };
    const run = vi.fn()
      .mockResolvedValueOnce({ records: [] })
      .mockResolvedValueOnce({ records: [{
        get: (key: string) => key === 'node' ? current : [1, 0],
      }] });
    const driver = {
      session: vi.fn(() => ({ run, close: vi.fn(async () => undefined) })),
    } as never;

    const result = await new ScopedQuery(driver, { legacyUnqualified: true }).byVector([1, 0], 1, 'tenant-a', 'project:alpha');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'sem-v2', score: 1 });
    const [fallbackCypher, fallbackParams] = run.mock.calls[1] as unknown as [string, Record<string, unknown>];
    expect(fallbackCypher).toContain('MATCH (node:Semantic)');
    expect(fallbackCypher).toContain(':SUPERSEDES');
    expect(fallbackCypher).toContain('(node.scope = $projectScope OR $projectScope IN node.tags)');
    expect(Number(fallbackParams.fallbackScanLimit)).toBe(1001);
  });

  it('uses a source-filtered deterministic recall fallback when the cosine scan exceeds its hard cap', async () => {
    const overflowRecord = { get: () => { throw new Error('overflow rows must not be materialized'); } };
    const current = {
      id: 'sem-current', content: 'current', confidence: 0.9, signal_count: 3,
      created_at: '2026-01-02T00:00:00.000Z', updated_at: '2026-01-03T00:00:00.000Z',
      decay_class: 'stable', tags: [], scope: 'global',
    };
    const run = vi.fn()
      .mockResolvedValueOnce({ records: [] })
      .mockResolvedValueOnce({ records: new Array(1001).fill(overflowRecord) })
      .mockResolvedValueOnce({ records: [{ get: () => current }] });
    const driver = {
      session: vi.fn(() => ({ run, close: vi.fn(async () => undefined) })),
    } as never;

    await expect(new ScopedQuery(driver, { legacyUnqualified: true }).byVector([1, 0], 1, 'tenant-a'))
      .resolves.toEqual([expect.objectContaining({ id: 'sem-current', score: 0 })]);
    expect(run).toHaveBeenCalledTimes(3);
    const [safeCypher] = run.mock.calls[2] as unknown as [string, Record<string, unknown>];
    expect(safeCypher).toContain(':SUPERSEDES');
    expect(safeCypher).toContain('ORDER BY coalesce(node.confidence, 0) DESC');
  });
});

describe('ScopedQuery.evaluateActiveEligibility', () => {
  it('returns ordered statuses, deduplicates IDs, and fails missing rows closed as unknown', async () => {
    const records = [
      { get: (key: string) => (key === 'id' ? 'sem-a' : 'eligible') },
      { get: (key: string) => (key === 'id' ? 'sem-b' : 'ineligible') },
    ];
    const run = vi.fn(async () => ({ records }));
    const close = vi.fn(async () => undefined);
    const driver = { session: vi.fn(() => ({ run, close })) } as never;

    await expect(new ScopedQuery(driver, { legacyUnqualified: true }).evaluateActiveEligibility({
      semanticIds: ['sem-a', 'sem-b', 'sem-c', 'sem-a'],
      tenantId: 'tenant-a',
      projectScope: 'Project:Alpha',
      asOf: '2025-02-03T04:05:06.789Z',
    })).resolves.toEqual([
      { id: 'sem-a', status: 'eligible' },
      { id: 'sem-b', status: 'ineligible' },
      { id: 'sem-c', status: 'unknown' },
    ]);

    const [cypher, params] = run.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(cypher).toContain('OPTIONAL MATCH (s:Semantic {id: id})');
    expect(cypher).toContain('s.tenant_id = $tenantId');
    expect(cypher).toContain('(s.scope = $projectScope OR $projectScope IN s.tags)');
    expect(cypher).toContain("THEN 'unknown'");
    expect(cypher).toContain("THEN 'eligible'");
    expect(cypher).toContain(':SUPERSEDES');
    expect(params).toMatchObject({
      semanticIds: ['sem-a', 'sem-b', 'sem-c'],
      tenantId: 'tenant-a',
      projectScope: 'project:alpha',
      asOf: '2025-02-03T04:05:06.789Z',
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects empty, oversized, and malformed batches before opening a session', async () => {
    const driver = { session: vi.fn() } as never;
    const query = new ScopedQuery(driver, { legacyUnqualified: true });

    await expect(query.evaluateActiveEligibility({ semanticIds: [] }))
      .rejects.toThrow('semantic_eligibility_ids_invalid');
    await expect(query.evaluateActiveEligibility({ semanticIds: new Array(129).fill('sem-a') }))
      .rejects.toThrow('semantic_eligibility_ids_invalid');
    await expect(query.evaluateActiveEligibility({ semanticIds: ['bad id'] }))
      .rejects.toThrow('semantic_eligibility_ids_invalid');
    expect((driver as { session: ReturnType<typeof vi.fn> }).session).not.toHaveBeenCalled();
  });
});
