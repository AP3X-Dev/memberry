import { describe, expect, it, vi } from 'vitest';
import { BootstrapGraphService, type BootstrapInput } from '@memberry/core';

function input(overrides: Partial<BootstrapInput> = {}): BootstrapInput {
  return {
    project_name: 'DealerBot3.0',
    project_tag: 'project:dealerbot',
    description: 'DealerBot project',
    domain: 'agent-memory',
    entities: [],
    semantic_seeds: [],
    agents: [],
    ...overrides,
  };
}

function record(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] };
}

describe('BootstrapGraphService project authority mapping', () => {
  it('persists the declared canonical project scope while promoting the display-name Entity', async () => {
    const run = vi.fn(async (query: string) => {
      if (query.includes('MERGE (e:Entity')) return { records: [record({
        id: 'ent-YOX6g9puSeht',
        isNew: false,
        storedProjectScope: 'project:dealerbot',
        storedTenantId: 'default',
      })] };
      if (query.includes('KnowledgeEpoch')) return { records: [record({ knowledgeEpoch: '1' })] };
      return { records: [record({ linked: 0 })] };
    });
    const close = vi.fn().mockResolvedValue(undefined);
    const driver = {
      session: () => ({ run, executeWrite: (work: (tx: { run: typeof run }) => unknown) => work({ run }), close }),
    } as never;

    await expect(new BootstrapGraphService(driver).bootstrap(input())).resolves.toMatchObject({
      project_entity_id: 'ent-YOX6g9puSeht',
      entities_existing: 1,
    });

    expect(run).toHaveBeenCalledTimes(4);
    expect(run.mock.calls[0]![0]).toContain('e.project_scope = $projectScope');
    expect(run.mock.calls[0]![1]).toMatchObject({
      name: 'DealerBot3.0',
      type: 'project',
      projectScope: 'project:dealerbot',
    });
    const orphanCall = run.mock.calls.find(([query]) => query.includes('count(ep) AS linked'))!;
    expect(orphanCall[1]).toMatchObject({ canonTag: 'project:dealerbot' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed project tags before touching Neo4j', async () => {
    const session = vi.fn();
    const driver = { session } as never;

    await expect(new BootstrapGraphService(driver).bootstrap(input({
      project_tag: 'project:dealerbot/foreign',
    }))).rejects.toThrow('bootstrap: project_tag must be a canonical project scope');
    expect(session).not.toHaveBeenCalled();
  });

  it('rejects an oversized canonical-looking project tag before touching Neo4j', async () => {
    const session = vi.fn();
    const driver = { session } as never;

    await expect(new BootstrapGraphService(driver).bootstrap(input({
      project_tag: `project:${'a'.repeat(129)}`,
    }))).rejects.toThrow('bootstrap: project_tag must be a canonical project scope');
    expect(session).not.toHaveBeenCalled();
  });

  it('fails closed instead of overwriting an existing canonical project scope', async () => {
    const run = vi.fn().mockResolvedValueOnce({ records: [record({
      id: 'ent-YOX6g9puSeht',
      isNew: false,
      storedProjectScope: 'project:other',
      storedTenantId: 'default',
    })] });
    const close = vi.fn().mockResolvedValue(undefined);
    const driver = {
      session: () => ({ run, executeWrite: (work: (tx: { run: typeof run }) => unknown) => work({ run }), close }),
    } as never;

    await expect(new BootstrapGraphService(driver).bootstrap(input()))
      .rejects.toThrow('bootstrap: project scope conflicts with existing project authority');
    expect(run).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rolls foundation mutations back when the in-transaction epoch bump fails', async () => {
    const committed: string[] = [];
    const run = vi.fn();
    const executeWrite = vi.fn(async (work: (tx: { run: typeof run }) => unknown) => {
      const staged: string[] = [];
      const txRun = vi.fn(async (query: string, params?: Record<string, unknown>) => {
        if (query.includes('MERGE (e:Entity')) {
          staged.push('entity');
          return { records: [record({
            id: 'ent-project',
            isNew: true,
            storedProjectScope: params?.projectScope,
            storedTenantId: params?.tenantId,
          })] };
        }
        if (query.includes('KnowledgeEpoch')) throw new Error('epoch unavailable');
        return { records: [] };
      });
      const value = await work({ run: txRun as typeof run });
      committed.push(...staged);
      return value;
    });
    const close = vi.fn();
    const driver = { session: () => ({ run, executeWrite, close }) } as never;

    await expect(new BootstrapGraphService(driver).bootstrap(input()))
      .rejects.toThrow('epoch unavailable');
    expect(executeWrite).toHaveBeenCalledOnce();
    expect(committed).toEqual([]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('binds ABOUT and orphan links to this bootstrap project and advances both epoch lanes', async () => {
    const calls: Array<{ query: string; params?: Record<string, unknown> }> = [];
    const run = vi.fn(async (query: string, params?: Record<string, unknown>) => {
      calls.push({ query, params });
      if (query.includes('MERGE (e:Entity')) {
        const project = params?.type === 'project';
        return { records: [record({
          id: project ? 'ent-project' : 'ent-local-module',
          isNew: true,
          storedProjectScope: params?.projectScope,
          storedTenantId: params?.tenantId,
        })] };
      }
      if (query.includes('MERGE (s:Semantic')) return { records: [record({
        id: 'sem-local',
        isNew: true,
        storedScope: params?.scope,
        storedTenantId: params?.tenantId,
      })] };
      if (query.includes('KnowledgeEpoch')) return { records: [record({ knowledgeEpoch: '1' })] };
      if (query.includes('count(ep) AS linked')) return { records: [record({ linked: 0 })] };
      return { records: [] };
    });
    const executeWrite = vi.fn(async (work: (tx: { run: typeof run }) => unknown) => work({ run }));
    const driver = { session: () => ({ run, executeWrite, close: vi.fn() }) } as never;

    await new BootstrapGraphService(driver).bootstrap(input({
      entities: [{ name: 'shared-name', type: 'module' }],
      semantic_seeds: [{ claim: 'Scoped seed', domain: 'test', about: ['shared-name'] }],
    }));

    const about = calls.find(({ query }) => query.includes('MERGE (s)-[:ABOUT]->(e)'))!;
    expect(about.params).toEqual({ semId: 'sem-local', entityId: 'ent-local-module' });
    expect(calls.some(({ query }) => query.includes('MATCH (e:Entity {name:'))).toBe(false);
    const orphan = calls.find(({ query }) => query.includes('count(ep) AS linked'))!;
    expect(orphan.query).toContain('coalesce(ep.tenant_id, $tenantId) = $tenantId');
    expect(orphan.params).toMatchObject({ projectId: 'ent-project', tenantId: 'default' });

    const epochScopes = calls
      .filter(({ query }) => query.includes('KnowledgeEpoch'))
      .map(({ params }) => params?.epochProjectScope);
    expect(epochScopes).toEqual([
      'project:dealerbot', '_unscoped',
      'project:dealerbot', '_unscoped',
    ]);
  });
});
