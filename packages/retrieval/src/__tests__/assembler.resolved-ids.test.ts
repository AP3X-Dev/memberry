import { describe, expect, it, vi } from 'vitest';
import { Record as Neo4jRecord } from 'neo4j-driver';
import { UnifiedAssembler, type AssemblerMemoryLayer } from '../assembler.js';

function dependencies(memory: AssemblerMemoryLayer | null) {
  const run = vi.fn(async (cypher: string, params?: Record<string, unknown>) => ({
    records: cypher.includes('OPTIONAL MATCH (e:Entity)')
      ? ((params?.entityIds ?? []) as string[]).map((targetId, ordinal) => new Neo4jRecord(
        ['ordinal', 'targetId', 'e', 'score', 'projectName'], [String(ordinal), targetId, null, 1, null],
      ))
      : cypher.includes('MATCH (s:Symbol)') ? [{ get: () => 0 }] : [],
  }));
  const driver = { session: vi.fn(() => ({ run, close: vi.fn(async () => undefined) })) };
  const redis = {
    zincrby: vi.fn(async () => 0), zrevrangeWithScores: vi.fn(async () => []),
    lpush: vi.fn(async () => 0), ltrim: vi.fn(async () => undefined),
  };
  const embedding = { embed: vi.fn(async () => [0]), embedBatch: vi.fn(async () => []) };
  return { driver, redis, embedding, assembler: new UnifiedAssembler(driver as never, redis, null, memory, embedding) };
}

describe('RET-002C UnifiedAssembler stable-ID routing', () => {
  it('passes one ordered, deduplicated, frozen ID list to ranked memory', async () => {
    const load = vi.fn(async () => ({ markdown: '', tokens: 0, sources: [] }));
    const { assembler } = dependencies({ load });
    await assembler.assemble('task', {
      strategy: 'ranked', include_arch: false, include_code: false,
      resolvedEntityIds: ['entity-b', 'entity-a', 'entity-b'],
    });
    const scope = load.mock.calls[0]![0];
    expect(scope.resolvedEntityIds).toEqual(['entity-b', 'entity-a']);
    expect(Object.isFrozen(scope.resolvedEntityIds)).toBe(true);
  });

  it('passes the same ordered stable IDs to deterministic assembly', async () => {
    const { assembler } = dependencies(null);
    const assemble = vi.fn(async () => []);
    (assembler as unknown as { deterministic: { assemble: typeof assemble } }).deterministic = { assemble };
    await assembler.assemble('task', {
      strategy: 'deterministic', resolvedEntityIds: ['entity-b', 'entity-a', 'entity-b'],
    });
    expect(assemble.mock.calls[0]![1].resolvedEntityIds).toEqual(['entity-b', 'entity-a']);
    expect(Object.isFrozen(assemble.mock.calls[0]![1].resolvedEntityIds)).toBe(true);
  });

  it('threads identical frozen stable IDs through ordinary and traced deterministic paths', async () => {
    const { assembler } = dependencies(null);
    const assemble = vi.fn(async () => []);
    const assembleTraced = vi.fn(async () => ({ sections: [], trace: {} }));
    (assembler as unknown as { deterministic: { assemble: typeof assemble; assembleTraced: typeof assembleTraced } }).deterministic = {
      assemble, assembleTraced,
    };
    const options = { strategy: 'deterministic' as const, resolvedEntityIds: ['entity-b', 'entity-a', 'entity-b'] };
    await assembler.assemble('task', options);
    await assembler.assembleTraced('task', options);
    const ordinaryIds = assemble.mock.calls[0]![1].resolvedEntityIds;
    const tracedIds = assembleTraced.mock.calls[0]![1].resolvedEntityIds;
    expect(ordinaryIds).toEqual(['entity-b', 'entity-a']);
    expect(tracedIds).toEqual(ordinaryIds);
    expect(Object.isFrozen(ordinaryIds)).toBe(true);
    expect(Object.isFrozen(tracedIds)).toBe(true);
  });

  it('preserves the exact ranked memory scope when stable IDs are absent', async () => {
    const load = vi.fn(async () => ({ markdown: '', tokens: 0, sources: [] }));
    const { assembler } = dependencies({ load });
    await assembler.assemble('task', {
      strategy: 'ranked', include_arch: false, include_code: false,
      entity_scope: ['LegacyName'], max_tokens: 900,
    });
    expect(load.mock.calls[0]![0]).toEqual({
      task: 'task', entities: ['LegacyName'], tags: undefined,
      max_tokens: 300, tenantId: 'default', queryVector: [0],
    });
    expect(load.mock.calls[0]![0]).not.toHaveProperty('resolvedEntityIds');
  });

  it('queries architecture by stable Entity.id without task fulltext discovery', async () => {
    const { assembler, driver } = dependencies(null);
    await assembler.assemble('SECRET-TASK-CANARY', {
      strategy: 'ranked', include_arch: true, include_code: false, include_memory: false,
      resolvedEntityIds: ['entity-b', 'entity-a'], tenantId: 'named-tenant',
    });
    const calls = driver.session.mock.results
      .map((result) => result.value.run.mock.calls)
      .flat() as Array<[string, Record<string, unknown>]>;
    const arch = calls.find(([cypher]) => cypher.includes('Entity'));
    expect(arch).toBeDefined();
    expect(arch![0]).toContain('e.id IN $entityIds');
    expect(arch![0]).not.toContain('queryNodes');
    expect(arch![0]).not.toContain('tenant_id');
    expect(arch![1].entityIds).toEqual(['entity-b', 'entity-a']);
    expect(arch![1]).not.toHaveProperty('tenantId');
  });

  it('rejects proxy and accessor ID containers without invoking their hooks or layers', async () => {
    const hooks = vi.fn();
    const proxy = new Proxy(['entity-a'], {
      get: (target, key, receiver) => { hooks(); return Reflect.get(target, key, receiver); },
      ownKeys: (target) => { hooks(); return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor: (target, key) => { hooks(); return Reflect.getOwnPropertyDescriptor(target, key); },
    });
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, '0', { enumerable: true, get: () => { hooks(); return 'entity-a'; } });
    accessor.length = 1;
    for (const value of [proxy, accessor]) {
      const load = vi.fn(async () => ({ markdown: '', tokens: 0, sources: [] }));
      const { assembler, driver } = dependencies({ load });
      await expect(assembler.assemble('task', { strategy: 'ranked', resolvedEntityIds: value as never }))
        .rejects.toThrow('resolved_entity_ids_invalid');
      expect(load).not.toHaveBeenCalled();
      expect(driver.session).not.toHaveBeenCalled();
    }
    expect(hooks).not.toHaveBeenCalled();
  });

  it.each(['ordinary', 'traced'] as const)('rejects hostile %s option roots before hooks or layers', async (mode) => {
    const hooks = vi.fn();
    const proxy = new Proxy({ strategy: 'ranked', resolvedEntityIds: ['entity-a'] }, {
      get: (target, key, receiver) => { hooks(); return Reflect.get(target, key, receiver); },
      ownKeys: (target) => { hooks(); return Reflect.ownKeys(target); },
    });
    const revoked = Proxy.revocable({ strategy: 'ranked', resolvedEntityIds: ['entity-a'] }, {}); revoked.revoke();
    const accessor = { strategy: 'ranked' } as Record<string, unknown>;
    Object.defineProperty(accessor, 'resolvedEntityIds', { get: () => { hooks(); return ['entity-a']; } });
    const customProto = Object.assign(Object.create({ inherited: true }), { strategy: 'ranked', resolvedEntityIds: ['entity-a'] });
    const extra = { strategy: 'ranked', resolvedEntityIds: ['entity-a'], secret: 'blocked' };
    for (const options of [proxy, revoked.proxy, accessor, customProto, extra]) {
      const load = vi.fn(async () => ({ markdown: '', tokens: 0, sources: [] }));
      const { assembler, driver } = dependencies({ load });
      const operation = mode === 'ordinary'
        ? assembler.assemble('task', options as never)
        : assembler.assembleTraced('task', options as never);
      await expect(operation).rejects.toThrow('retrieval_options_invalid');
      expect(load).not.toHaveBeenCalled();
      expect(driver.session).not.toHaveBeenCalled();
    }
    expect(hooks).not.toHaveBeenCalled();
  });

  it('rejects substituted official stable architecture rows before foreign data enters', async () => {
    const foreign = new Neo4jRecord(
      ['targetId', 'e', 'score'],
      ['entity-foreign', { properties: { id: 'entity-foreign', name: 'FOREIGN-SECRET' } }, 1],
    );
    const { assembler, driver } = dependencies(null);
    for (const session of driver.session.mock.results) void session;
    driver.session.mockImplementation(() => ({
      run: vi.fn(async (cypher: string) => ({ records: cypher.includes('MATCH (e:Entity)') ? [foreign] : [] })),
      close: vi.fn(async () => undefined),
    }));
    await expect(assembler.assemble('task', {
      strategy: 'ranked', include_arch: true, include_code: false, include_memory: false,
      resolvedEntityIds: ['entity-a'],
    })).rejects.toThrow('stable_arch_result_invalid');
  });

  it('rejects proxied stable architecture result arrays without invoking hooks', async () => {
    const hooks = vi.fn();
    const records = new Proxy([], {
      get: (target, key, receiver) => { hooks(); return Reflect.get(target, key, receiver); },
      ownKeys: (target) => { hooks(); return Reflect.ownKeys(target); },
    });
    const { assembler, driver } = dependencies(null);
    driver.session.mockImplementation(() => ({
      run: vi.fn(async (cypher: string) => ({ records: cypher.includes('OPTIONAL MATCH (e:Entity)') ? records : [] })),
      close: vi.fn(async () => undefined),
    }));
    await expect(assembler.assemble('task', {
      strategy: 'ranked', include_arch: true, include_code: false, include_memory: false,
      resolvedEntityIds: ['entity-a'],
    })).rejects.toThrow('stable_arch_result_invalid');
    expect(hooks).not.toHaveBeenCalled();
  });

  it('rejects missing, extra, sparse, and accessor stable architecture shapes without hooks', async () => {
    const hooks = vi.fn();
    const fields = ['ordinal', 'targetId', 'e', 'score', 'projectName'];
    const values = ['0', 'entity-a', null, 1, null];
    const sparse = new Neo4jRecord(fields, values) as Neo4jRecord & { _fields: unknown[] };
    const sparseFields: unknown[] = []; sparseFields.length = fields.length;
    sparse._fields = sparseFields;
    const hostileProperties: Record<string, unknown> = {};
    Object.defineProperty(hostileProperties, 'id', { get: () => { hooks(); return 'entity-a'; } });
    const malformed = [
      new Neo4jRecord(fields.slice(0, -1), values.slice(0, -1)),
      new Neo4jRecord([...fields, 'extra'], [...values, 'blocked']),
      sparse,
      new Neo4jRecord(fields, ['0', 'entity-a', { properties: hostileProperties }, 1, null]),
    ];
    for (const hostileRecord of malformed) {
      const { assembler, driver } = dependencies(null);
      driver.session.mockImplementation(() => ({
        run: vi.fn(async (cypher: string) => ({
          records: cypher.includes('OPTIONAL MATCH (e:Entity)') ? [hostileRecord] : [],
        })),
        close: vi.fn(async () => undefined),
      }));
      await expect(assembler.assemble('task', {
        strategy: 'ranked', include_arch: true, include_code: false, include_memory: false,
        resolvedEntityIds: ['entity-a'],
      })).rejects.toThrow('stable_arch_result_invalid');
    }
    expect(hooks).not.toHaveBeenCalled();
  });
});
