import { describe, expect, it, vi } from 'vitest';
import neo4j from 'neo4j-driver';
import type { Driver } from 'neo4j-driver';
import type { EpisodeIndexKeyNodeV1 } from '@memberry/core';
import { EpisodicIndexStore } from '../episodic-index.js';

function record(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] };
}

describe('IDX-001A backfill store', () => {
  it('uses scoped keyset pagination and skips already-indexed episodes', async () => {
    const run = vi.fn(async (_query: string, _params: Record<string, unknown>) => ({ records: [record({
      id: 'ep2', createdAt: '2026-08-30T00:00:00.000Z', content: 'fact',
    })] }));
    const close = vi.fn(async () => undefined);
    const driver = { session: () => ({ run, close }) } as unknown as Driver;
    const rows = await new EpisodicIndexStore(driver).nextBackfillBatch({
      tenantId: 'tenant-a', projectScope: 'project:memberry', limit: 10,
      after: { createdAt: '2026-08-29T00:00:00.000Z', id: 'ep1' },
    });
    expect(run.mock.calls[0]![0]).toContain('ep.tenant_id = $tenantId');
    expect(run.mock.calls[0]![0]).toContain('ep.scope = $projectScope');
    expect(run.mock.calls[0]![0]).toContain('NOT EXISTS { (ep)-[:HAS_INDEX_KEY]');
    expect(run.mock.calls[0]![0]).toContain('NOT EXISTS { (ep)-[:HAS_INDEX_OUTCOME]');
    expect(run.mock.calls[0]![1]).toMatchObject({
      tenantId: 'tenant-a', projectScope: 'project:memberry', afterId: 'ep1',
    });
    expect(neo4j.isInt(run.mock.calls[0]![1].limit)).toBe(true);
    expect(run.mock.calls[0]![1].limit.toNumber()).toBe(10);
    expect(rows).toEqual([expect.objectContaining({ id: 'ep2', tenantId: 'tenant-a' })]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('derives a bounded current same-tenant Fact set with project authority from the Episode', async () => {
    const facts = [{
      source_fact_id: 'fact-1', entity_id: 'entity-1', subject: 'A', predicate: 'uses', object: 'B',
    }];
    const run = vi.fn(async () => ({ records: [record({
      id: 'ep2', createdAt: '2026-08-30T00:00:00.000Z', content: 'fact', facts,
    })] }));
    const close = vi.fn(async () => undefined);
    const driver = { session: () => ({ run, close }) } as unknown as Driver;
    const rows = await new EpisodicIndexStore(driver).nextGraphBackfillBatch({
      tenantId: 'tenant-a', projectScope: 'project:memberry', limit: 10,
    });
    const [query, params] = run.mock.calls[0]!;
    expect(query).toContain('ep.tenant_id = $tenantId');
    expect(query).toContain('ep.scope = $projectScope');
    expect(query).toContain("source: 'agent'");
    expect(query).toContain('derivation: $derivation');
    expect(query).toContain('fact.tenant_id = $tenantId');
    expect(query).toContain("fact.status <> 'invalidated'");
    expect(query).toContain('about.invalid_at IS NULL');
    expect(query).toContain('fact.entity_id = entity.id');
    expect(query).not.toContain('fact.scope = $projectScope');
    expect(query).toContain('[0..$factLimit]');
    expect(neo4j.isInt(params.factLimit)).toBe(true);
    expect(params.factLimit.toNumber()).toBe(16);
    expect(rows).toEqual([expect.objectContaining({ id: 'ep2', facts })]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('persists an idempotent scoped outcome for successful empty extraction', async () => {
    const queries: string[] = [];
    const run = vi.fn(async (query: string) => {
      queries.push(query);
      return query.includes('RETURN count(ep)') || query.includes('RETURN count(outcome)')
        ? { records: [record({ count: 1 })] }
        : { records: [] };
    });
    const close = vi.fn(async () => undefined);
    const driver = { session: () => ({
      executeWrite: (work: (tx: { run: typeof run }) => unknown) => work({ run }), close,
    }) } as unknown as Driver;
    await new EpisodicIndexStore(driver).markBackfillEmpty({
      id: 'ep1', createdAt: '2026-08-30T00:00:00.000Z', content: 'no extractable fact',
      tenantId: 'tenant-a', projectScope: 'project:memberry',
    });
    expect(queries[0]).toContain('tenant_id: $tenantId, scope: $projectScope');
    expect(queries[1]).toContain('MERGE (outcome:EpisodicIndexOutcome {id: $outcomeId})');
    expect(queries[1]).toContain("outcome.outcome = 'empty'");
    expect(close).toHaveBeenCalledOnce();
  });

  it('marks graph-empty separately so a prior model outcome cannot suppress the deterministic pass', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const run = vi.fn(async (query: string, params: Record<string, unknown>) => {
      calls.push([query, params]);
      return query.includes('RETURN count(ep)') || query.includes('RETURN count(outcome)')
        ? { records: [record({ count: 1 })] }
        : { records: [] };
    });
    const close = vi.fn(async () => undefined);
    const driver = { session: () => ({
      executeWrite: (work: (tx: { run: typeof run }) => unknown) => work({ run }), close,
    }) } as unknown as Driver;
    await new EpisodicIndexStore(driver).markBackfillEmpty({
      id: 'ep1', createdAt: '2026-08-30T00:00:00.000Z', content: 'no graph facts',
      tenantId: 'tenant-a', projectScope: 'project:memberry',
    }, 'graph-v1');
    expect(calls[1]![1]).toMatchObject({
      outcomeId: 'eio1:ep1:graph-v1:empty', derivation: 'graph-v1',
    });
    expect(calls[1]![0]).toContain('outcome.derivation = $derivation');
  });

  it('rejects a colliding empty outcome whose stored authority does not match', async () => {
    const run = vi.fn(async (query: string) => query.includes('RETURN count(ep)')
      ? { records: [record({ count: 1 })] }
      : { records: [record({ count: 0 })] });
    const close = vi.fn(async () => undefined);
    const driver = { session: () => ({
      executeWrite: (work: (tx: { run: typeof run }) => unknown) => work({ run }), close,
    }) } as unknown as Driver;
    await expect(new EpisodicIndexStore(driver).markBackfillEmpty({
      id: 'ep1', createdAt: '2026-08-30T00:00:00.000Z', content: 'empty',
      tenantId: 'tenant-a', projectScope: 'project:memberry',
    }, 'graph-v1')).rejects.toThrow('outcome_authority_mismatch');
  });

  it('replaces only backfill keys after proving exact episode ownership', async () => {
    const queries: string[] = [];
    const run = vi.fn(async (query: string) => {
      queries.push(query);
      return query.includes('RETURN count(ep)')
        ? { records: [record({ count: 1 })] }
        : { records: [] };
    });
    const close = vi.fn(async () => undefined);
    const driver = { session: () => ({
      executeWrite: (work: (tx: { run: typeof run }) => unknown) => work({ run }), close,
    }) } as unknown as Driver;
    const key: EpisodeIndexKeyNodeV1 = {
      id: 'eik1:ep1:x', episode_id: 'ep1', kind: 'fact', value: 'fact', embedding: [1],
      schema_version: 1, source: 'backfill', source_hash: 'x', tenant_id: 'tenant-a',
      project_scope: 'project:memberry', created_at: '2026-08-30T00:00:00.000Z',
    };
    await new EpisodicIndexStore(driver).replaceBackfillKeys({
      id: 'ep1', createdAt: key.created_at, content: 'fact',
      tenantId: 'tenant-a', projectScope: 'project:memberry',
    }, [key]);
    expect(queries[0]).toContain('tenant_id: $tenantId, scope: $projectScope');
    expect(queries[1]).toContain("source: 'backfill'");
    expect(queries[2]).toContain('CREATE (k:EpisodicIndexKey');
    expect(queries[2]).toContain('source_fact_id: key.source_fact_id');
    expect(queries[2]).toContain('derivation: key.derivation');
    expect(close).toHaveBeenCalledOnce();
  });

  it('rolls back by deleting only derived keys in the exact tenant/project', async () => {
    const calls: Array<[string, unknown]> = [];
    const run = vi.fn(async (query: string, params: unknown) => {
      calls.push([query, params]);
      return query.includes('keyCount + outcomeCount AS count')
        ? { records: [record({ count: 3 })] }
        : { records: [] };
    });
    const close = vi.fn(async () => undefined);
    const driver = { session: () => ({
      executeWrite: (work: (tx: { run: typeof run }) => unknown) => work({ run }), close,
    }) } as unknown as Driver;
    await expect(new EpisodicIndexStore(driver).deleteDerived({
      tenantId: 'tenant-a', projectScope: 'project:memberry',
    })).resolves.toBe(3);
    expect(calls).toHaveLength(3);
    expect(calls[0]![0]).toContain('WITH keyCount, count(outcome) AS outcomeCount');
    expect(calls[1]![0]).toContain('DETACH DELETE key');
    expect(calls[1]![0]).not.toContain('DELETE ep');
    expect(calls[1]![1]).toEqual({ tenantId: 'tenant-a', projectScope: 'project:memberry' });
    expect(calls[2]![0]).toContain('DETACH DELETE outcome');
    expect(calls[2]![0]).not.toContain('DELETE ep');
    expect(close).toHaveBeenCalledOnce();
  });
});
