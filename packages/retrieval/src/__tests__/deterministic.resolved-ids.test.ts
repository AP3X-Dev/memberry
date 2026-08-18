import { describe, expect, it, vi } from 'vitest';
import { Record as Neo4jRecord } from 'neo4j-driver';
import { DeterministicAssembler } from '../deterministic.js';

function emptyDriver() {
  const runs: ReturnType<typeof vi.fn>[] = [];
  const driver = {
    session: vi.fn(() => {
      const run = vi.fn(async (cypher: string, params: Record<string, unknown>) => ({
        records: cypher.includes('OPTIONAL MATCH (e:Entity {id: targetId})')
          ? (params.ids as string[]).map((targetId, ordinal) => new Neo4jRecord(
            ['ordinal', 'targetId', 'e', 'projectName'], [String(ordinal), targetId, null, null],
          ))
          : [],
      }));
      runs.push(run);
      return { run, close: vi.fn(async () => undefined) };
    }),
  };
  return { driver, runs };
}

describe('RET-002C deterministic stable-ID lane', () => {
  it('uses only direct target and ABOUT Entity.id queries, never connected topology or discovery', async () => {
    const { driver, runs } = emptyDriver();
    const assembler = new DeterministicAssembler(driver as never);

    await assembler.assemble('SECRET-TASK-DISCOVERY-CANARY', {
      resolvedEntityIds: ['entity-b', 'entity-a', 'entity-b'],
    });

    expect(runs).toHaveLength(2);
    for (const run of runs) {
      const [cypher, params] = run.mock.calls[0] as [string, Record<string, unknown>];
      expect(cypher).toContain('id: targetId');
      expect(cypher).not.toContain('queryNodes');
      expect(cypher).not.toContain('{name: targetName}');
      expect(params.ids).toEqual(['entity-b', 'entity-a']);
      expect(Object.isFrozen(params.ids)).toBe(true);
      if (cypher.includes('OPTIONAL MATCH (e:Entity')) expect(cypher).toContain('CONTAINS*0..64');
      else expect(cypher).not.toContain('CONTAINS');
      expect(cypher).not.toContain('APPLIES_TO');
    }
  });

  it('treats an explicit empty stable-ID lane as no-match without discovery', async () => {
    const { driver } = emptyDriver();
    const assembler = new DeterministicAssembler(driver as never);
    const sections = await assembler.assemble('discovery canary', { resolvedEntityIds: [] });
    expect(driver.session).not.toHaveBeenCalled();
    expect(sections.map((section) => section.heading)).toEqual(['No matching entities found']);
  });

  it('keeps traced execution on the same two direct ID-qualified reads as ordinary execution', async () => {
    const { driver, runs } = emptyDriver();
    const assembler = new DeterministicAssembler(driver as never);
    const result = await assembler.assembleTraced('trace discovery canary', {
      resolvedEntityIds: ['entity-b', 'entity-a', 'entity-b'],
    });
    expect(result.sections).toEqual([]);
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      const [cypher, params] = run.mock.calls[0] as [string, Record<string, unknown>];
      expect(cypher).toContain('id: targetId');
      expect(cypher).not.toContain('queryNodes');
      expect(params.ids).toEqual(['entity-b', 'entity-a']);
    }
  });

  it.each(['ordinary', 'traced'] as const)('preserves legacy alias/case bytes in %s mode', async (mode) => {
    const record = (values: Record<string, unknown>) => new Neo4jRecord(Object.keys(values), Object.values(values));
    const runs: ReturnType<typeof vi.fn>[] = [];
    const driver = {
      session: vi.fn(() => {
        const run = vi.fn(async (cypher: string) => {
          if (cypher.includes('RETURN targetName AS targetName, e')) {
            return { records: [record({ targetName: 'AliasCase', e: { properties: { name: 'CanonicalName', category: 'component' } } })] };
          }
          if (cypher.includes('MATCH (e:Entity {name: targetName})-[r]->(dep:Entity)')) {
            return { records: [record({ targetName: 'AliasCase', name: 'Dependency', relation: 'USES', interface_desc: '' })] };
          }
          return { records: [] };
        });
        runs.push(run);
        return { run, close: vi.fn(async () => undefined) };
      }),
    };
    const assembler = new DeterministicAssembler(driver as never);
    const sections = mode === 'ordinary'
      ? await assembler.assemble('legacy', { entity_scope: ['AliasCase'] })
      : (await assembler.assembleTraced('legacy', { entity_scope: ['AliasCase'] })).sections;
    const dependency = sections.find((section) => section.heading === 'Dependencies & Dependents')?.items[0]?.content;
    expect(dependency).toContain('**AliasCase**');
    expect(dependency).not.toContain('**CanonicalName** —');
    expect(runs).toHaveLength(6);
  });

  it('preserves the exact legacy name-query lane when stable IDs are absent', async () => {
    const { driver, runs } = emptyDriver();
    const assembler = new DeterministicAssembler(driver as never);
    await assembler.assemble('legacy', { entity_scope: ['DuplicateName'] });
    expect(runs).toHaveLength(6);
    for (const run of runs) {
      const [cypher, params] = run.mock.calls[0] as [string, Record<string, unknown>];
      expect(cypher).toContain('targetName');
      expect(params).toEqual({ names: ['DuplicateName'], ...(params.tenantId ? { tenantId: params.tenantId } : {}) });
      expect(params).not.toHaveProperty('ids');
    }
  });

  it.each([
    ['sparse', (() => { const value: unknown[] = []; value.length = 1; return value; })()],
    ['extra', Object.assign(['entity-a'], { extra: 'blocked' })],
    ['accessor', (() => { const value: unknown[] = []; Object.defineProperty(value, '0', { enumerable: true, get: () => { throw new Error('hook'); } }); value.length = 1; return value; })()],
  ])('rejects hostile %s arrays before opening a session', async (_label, value) => {
    const { driver } = emptyDriver();
    const assembler = new DeterministicAssembler(driver as never);
    await expect(assembler.assemble('task', { resolvedEntityIds: value as never }))
      .rejects.toThrow('resolved_entity_ids_invalid');
    expect(driver.session).not.toHaveBeenCalled();
  });

  it.each(['ordinary', 'traced'] as const)('rejects hostile %s option roots before hooks or sessions', async (mode) => {
    const hooks = vi.fn();
    const proxy = new Proxy({ resolvedEntityIds: ['entity-a'] }, {
      get: (target, key, receiver) => { hooks(); return Reflect.get(target, key, receiver); },
      ownKeys: (target) => { hooks(); return Reflect.ownKeys(target); },
    });
    const revoked = Proxy.revocable({ resolvedEntityIds: ['entity-a'] }, {}); revoked.revoke();
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, 'resolvedEntityIds', { get: () => { hooks(); return ['entity-a']; } });
    const customProto = Object.assign(Object.create({ inherited: true }), { resolvedEntityIds: ['entity-a'] });
    const extra = { resolvedEntityIds: ['entity-a'], secret: 'blocked' };
    for (const options of [proxy, revoked.proxy, accessor, customProto, extra]) {
      const { driver } = emptyDriver();
      const assembler = new DeterministicAssembler(driver as never);
      const operation = mode === 'ordinary'
        ? assembler.assemble('task', options as never)
        : assembler.assembleTraced('task', options as never);
      await expect(operation).rejects.toThrow('deterministic_options_invalid');
      expect(driver.session).not.toHaveBeenCalled();
    }
    expect(hooks).not.toHaveBeenCalled();
  });

  it.each([
    ['current', undefined],
    ['asOf', '2024-01-01T00:00:00.000Z'],
  ])('enforces active ABOUT relationships in stable %s semantic reads', async (_label, asOf) => {
    const { driver, runs } = emptyDriver();
    await new DeterministicAssembler(driver as never).assemble('task', {
      resolvedEntityIds: ['entity-a'], ...(asOf ? { as_of: asOf } : {}),
    });
    const semanticCall = runs.map((run) => run.mock.calls[0] as [string, Record<string, unknown>])
      .find(([cypher]) => cypher.includes('Semantic'))!;
    expect(semanticCall[0]).toContain('[r:ABOUT]');
    expect(semanticCall[0]).toContain('r.invalid_at');
    if (asOf) {
      expect(semanticCall[0]).toContain("COALESCE(r.valid_at, '1970-01-01T00:00:00.000Z') <= $asOf");
      expect(semanticCall[1].asOf).toBe(asOf);
    } else {
      expect(semanticCall[0]).toContain('r.invalid_at IS NULL');
      expect(semanticCall[1]).not.toHaveProperty('asOf');
    }
  });

  it('rejects substituted official stable Entity and Semantic records', async () => {
    const neoRecord = (values: Record<string, unknown>) => new Neo4jRecord(Object.keys(values), Object.values(values));
    for (const [lane, foreignRecord] of [
      ['entity', neoRecord({ ordinal: '0', targetId: 'entity-foreign', e: { properties: { id: 'entity-foreign', name: 'FOREIGN-SECRET' } }, projectName: null })],
      ['semantic', neoRecord({ ordinal: '0', targetId: 'entity-foreign', id: 'semantic-secret', content: 'FOREIGN-SECRET', confidence: 1, tags: [], tenantId: 'default', scope: 'project:alpha' })],
    ] as const) {
      const driver = {
        session: vi.fn(() => ({
          run: vi.fn(async (cypher: string) => ({ records:
            lane === 'entity'
              ? (cypher.includes('OPTIONAL MATCH (e:Entity') ? [foreignRecord] : [])
              : (cypher.includes('Semantic') ? [foreignRecord]
                : [neoRecord({ ordinal: '0', targetId: 'entity-a', e: null, projectName: null })]),
          })),
          close: vi.fn(async () => undefined),
        })),
      };
      await expect(new DeterministicAssembler(driver as never).assemble('task', { resolvedEntityIds: ['entity-a'] }))
        .rejects.toThrow('stable_deterministic_result_invalid');
    }
  });

  it('rejects proxied stable deterministic records without invoking hooks', async () => {
    const hooks = vi.fn();
    const records = new Proxy([], {
      get: (target, key, receiver) => { hooks(); return Reflect.get(target, key, receiver); },
      ownKeys: (target) => { hooks(); return Reflect.ownKeys(target); },
    });
    const driver = { session: vi.fn(() => ({ run: vi.fn(async () => ({ records })), close: vi.fn(async () => undefined) })) };
    await expect(new DeterministicAssembler(driver as never).assemble('task', { resolvedEntityIds: ['entity-a'] }))
      .rejects.toThrow('stable_deterministic_result_invalid');
    expect(hooks).not.toHaveBeenCalled();
  });

  it.each(['entity', 'semantic'] as const)('rejects missing, extra, sparse, and accessor stable %s shapes', async (lane) => {
    const hooks = vi.fn();
    const entityFields = ['ordinal', 'targetId', 'e', 'projectName'];
    const entityValues = ['0', 'entity-a', null, null];
    const semanticFields = ['ordinal', 'targetId', 'id', 'content', 'confidence', 'tags', 'tenantId', 'scope'];
    const semanticValues = ['0', 'entity-a', 'semantic-a', 'safe', 1, ['project:alpha'], 'default', 'project:alpha'];
    const fields = lane === 'entity' ? entityFields : semanticFields;
    const values = lane === 'entity' ? entityValues : semanticValues;
    const sparse = new Neo4jRecord(fields, values) as Neo4jRecord & { _fields: unknown[] };
    const sparseFields: unknown[] = []; sparseFields.length = fields.length;
    sparse._fields = sparseFields;
    const hostileProperties: Record<string, unknown> = {};
    Object.defineProperty(hostileProperties, 'id', { get: () => { hooks(); return 'entity-a'; } });
    const nestedAccessor = new Neo4jRecord(entityFields, [
      '0', 'entity-a', { properties: hostileProperties }, null,
    ]);
    const malformed = [
      new Neo4jRecord(fields.slice(0, -1), values.slice(0, -1)),
      new Neo4jRecord([...fields, 'extra'], [...values, 'blocked']),
      sparse,
      ...(lane === 'entity' ? [nestedAccessor] : []),
    ];
    for (const hostileRecord of malformed) {
      const validEntity = new Neo4jRecord(entityFields, ['0', 'entity-a', null, null]);
      const driver = {
        session: vi.fn(() => ({
          run: vi.fn(async (cypher: string) => ({ records: cypher.includes('Semantic')
            ? (lane === 'semantic' ? [hostileRecord] : [])
            : (lane === 'entity' ? [hostileRecord] : [validEntity]) })),
          close: vi.fn(async () => undefined),
        })),
      };
      await expect(new DeterministicAssembler(driver as never).assemble('task', { resolvedEntityIds: ['entity-a'] }))
        .rejects.toThrow('stable_deterministic_result_invalid');
    }
    expect(hooks).not.toHaveBeenCalled();
  });

  it('binds and returns tenant/project authority for stable Semantic rows', async () => {
    const { driver, runs } = emptyDriver();
    await new DeterministicAssembler(driver as never).assemble('task', {
      resolvedEntityIds: ['entity-a'], tenantId: 'tenant-a', project_name: 'Alpha',
    });
    const [cypher, params] = runs.map((run) => run.mock.calls[0] as [string, Record<string, unknown>])
      .find(([query]) => query.includes('Semantic'))!;
    expect(cypher).toContain('$projectScope');
    expect(cypher).toContain('s.tenant_id AS tenantId');
    expect(cypher).toContain('s.scope AS scope');
    expect(params.projectScope).toBe('project:alpha');
  });

  it('rejects per-target stable Semantic order violations and rows beyond the cap of ten', async () => {
    const entity = new Neo4jRecord(['ordinal', 'targetId', 'e', 'projectName'], ['0', 'entity-a', null, null]);
    const semantic = (id: string, confidence: number) => new Neo4jRecord(
      ['ordinal', 'targetId', 'id', 'content', 'confidence', 'tags', 'tenantId', 'scope'],
      ['0', 'entity-a', id, 'safe', confidence, ['project:alpha'], 'tenant-a', 'project:alpha'],
    );
    for (const rows of [
      [semantic('semantic-a', 0.8), semantic('semantic-b', 0.9)],
      Array.from({ length: 11 }, (_, index) => semantic(`semantic-${index}`, 1 - index / 100)),
    ]) {
      const driver = { session: vi.fn(() => ({
        run: vi.fn(async (cypher: string) => ({ records: cypher.includes('Semantic') ? rows : [entity] })),
        close: vi.fn(async () => undefined),
      })) };
      await expect(new DeterministicAssembler(driver as never).assemble('task', {
        resolvedEntityIds: ['entity-a'], tenantId: 'tenant-a', project_name: 'alpha',
      })).rejects.toThrow('stable_deterministic_result_invalid');
    }
  });

  it('accepts code-unit ordered mixed-case and punctuation stable Semantic ties', async () => {
    const entity = new Neo4jRecord(['ordinal', 'targetId', 'e', 'projectName'], ['0', 'entity-a', null, null]);
    const rows = ['semantic-A', 'semantic-a', 'semantic.a', 'semantic:a'].map((id) => new Neo4jRecord(
      ['ordinal', 'targetId', 'id', 'content', 'confidence', 'tags', 'tenantId', 'scope'],
      ['0', 'entity-a', id, 'safe', 0.9, ['project:alpha'], 'tenant-a', 'project:alpha'],
    ));
    const driver = { session: vi.fn(() => ({
      run: vi.fn(async (cypher: string) => ({ records: cypher.includes('Semantic') ? rows : [entity] })),
      close: vi.fn(async () => undefined),
    })) };
    await expect(new DeterministicAssembler(driver as never).assemble('task', {
      resolvedEntityIds: ['entity-a'], tenantId: 'tenant-a', project_name: 'alpha',
    })).resolves.toBeDefined();
  });

  it('rejects oversized stable deterministic provider strings before UTF-8 scanning in ordinary and traced lanes', async () => {
    const originalByteLength = Buffer.byteLength;
    let target = '';
    let targetScans = 0;
    Buffer.byteLength = ((
      input: Parameters<typeof Buffer.byteLength>[0],
      encoding?: BufferEncoding,
    ): number => {
      if (input === target) targetScans += 1;
      return originalByteLength(input, encoding);
    }) as typeof Buffer.byteLength;
    vi.resetModules();
    try {
      const { DeterministicAssembler: DynamicDeterministicAssembler } = await import('../deterministic.js');
      const invoke = (
        mode: 'ordinary' | 'traced', properties: Record<string, unknown>,
      ): Promise<unknown> => {
        const entity = new Neo4jRecord(
          ['ordinal', 'targetId', 'e', 'projectName'],
          ['0', 'entity-a', { properties }, null],
        );
        const driver = { session: vi.fn(() => ({
          run: vi.fn(async (cypher: string) => ({
            records: cypher.includes('OPTIONAL MATCH (e:Entity {id: targetId})') ? [entity] : [],
          })),
          close: vi.fn(async () => undefined),
        })) };
        const assembler = new DynamicDeterministicAssembler(driver as never);
        const options = { resolvedEntityIds: ['entity-a'] };
        return mode === 'ordinary'
          ? assembler.assemble('task', options)
          : assembler.assembleTraced('task', options);
      };

      for (const mode of ['ordinary', 'traced'] as const) {
        const expectProviderFailure = async (properties: Record<string, unknown>): Promise<void> => {
          const operation = invoke(mode, properties);
          if (mode === 'ordinary') {
            await expect(operation).rejects.toThrow('stable_deterministic_result_invalid');
          } else {
            await expect(operation).resolves.toMatchObject({
              trace: { events: expect.arrayContaining([
                expect.objectContaining({ channel: 'arch.entity', outcome: 'safe-failure', code: 'invalid-result' }),
              ]) },
            });
          }
        };

        target = 'provider-safe-name';
        targetScans = 0;
        await expect(invoke(mode, { id: 'entity-a', name: target })).resolves.toBeDefined();
        expect(targetScans).toBeGreaterThan(0);

        target = 'x'.repeat(65_537);
        targetScans = 0;
        await expectProviderFailure({ id: 'entity-a', name: target });
        expect(targetScans).toBe(0);

        target = 'é'.repeat(32_769);
        targetScans = 0;
        await expectProviderFailure({ id: 'entity-a', name: target });
        expect(targetScans).toBeGreaterThan(0);

        target = 't'.repeat(65_536);
        targetScans = 0;
        const aggregateProperties: Record<string, unknown> = { id: 'entity-a', name: 'safe-name' };
        for (let index = 0; index < 31; index += 1) {
          aggregateProperties[`padding${index}`] = 'f'.repeat(65_536);
        }
        aggregateProperties.boundary = target;
        await expectProviderFailure(aggregateProperties);
        expect(targetScans).toBe(0);
      }
    } finally {
      Buffer.byteLength = originalByteLength;
      vi.resetModules();
    }
  });
});
