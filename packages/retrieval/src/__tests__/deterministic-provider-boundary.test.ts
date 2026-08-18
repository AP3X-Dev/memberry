import { Buffer } from 'node:buffer';
import { Record as Neo4jRecord } from 'neo4j-driver';
import { describe, expect, it, vi } from 'vitest';
import { UnifiedAssembler, type TracedUnifiedContext } from '../assembler.js';
import { DeterministicAssembler } from '../deterministic.js';

const MAX_STRING_BYTES = 65_536;
const MAX_AGGREGATE_STRING_BYTES = 2 * 1024 * 1024;
const MAX_BATCH_RECORDS = 512;

type Lane = 'ordinary' | 'traced';
type Path = 'discovery-ft' | 'discovery-fallback' | 'ancestors' | 'entity'
  | 'dependencies' | 'dependents' | 'aspects' | 'semantics';

function record(keys: string[], values: unknown[]): Neo4jRecord {
  return new Neo4jRecord(keys, values);
}

function pathFor(cypher: string): Path | 'other' {
  if (cypher.includes("queryNodes('entity_name_search'")) return 'discovery-ft';
  if (cypher.includes('ANY(word IN $words')) return 'discovery-fallback';
  if (cypher.includes('MATCH path =')) return 'ancestors';
  if (cypher.includes('RETURN targetName AS targetName, e')) return 'entity';
  if (cypher.includes('MATCH (e:Entity {name: targetName})-[r]->')) return 'dependencies';
  if (cypher.includes('MATCH (dep:Entity)-[r]->')) return 'dependents';
  if (cypher.includes('MATCH (a:Aspect)')) return 'aspects';
  if (cypher.includes('MATCH (s:Semantic)-[:ABOUT]')) return 'semantics';
  return 'other';
}

function validResult(path: Path | 'other'): { records: Neo4jRecord[] } {
  switch (path) {
    case 'discovery-ft':
      return { records: [record(['name'], ['Target'])] };
    case 'discovery-fallback':
      return { records: [record(['name'], ['Target'])] };
    case 'ancestors':
      return { records: [record(
        ['targetName', 'name', 'depth', 'responsibility'],
        ['Target', 'Parent', 1, 'Owns target'],
      )] };
    case 'entity':
      return { records: [record(['targetName', 'e'], ['Target', { properties: {
        id: 'target-id', name: 'Target', category: 'component', responsibility: 'Does work',
        interface_desc: 'run()', internals: 'private',
      } }])] };
    case 'dependencies':
      return { records: [record(
        ['targetName', 'name', 'relation', 'interface_desc'],
        ['Target', 'Dependency', 'USES', 'call()'],
      )] };
    case 'dependents':
      return { records: [record(['targetName', 'name', 'relation'], ['Target', 'Dependent', 'CALLS'])] };
    case 'aspects':
      return { records: [record(
        ['targetName', 'name', 'stability_tier', 'description'],
        ['Target', 'Security', 'protocol', 'Checks boundaries'],
      )] };
    case 'semantics':
      return { records: [record(
        ['targetName', 'id', 'content', 'confidence', 'tags'],
        ['Target', 'sem-1', 'Remember this', 0.9, ['retrieval']],
      )] };
    default:
      return { records: [] };
  }
}

function makeAssembler(overrides: Partial<Record<Path, unknown>> = {}) {
  const run = vi.fn(async (cypher: string) => {
    const path = pathFor(cypher);
    return path !== 'other' && Object.hasOwn(overrides, path)
      ? overrides[path] as never
      : validResult(path);
  });
  const closes: ReturnType<typeof vi.fn>[] = [];
  const session = vi.fn(() => {
    const close = vi.fn(async () => undefined);
    closes.push(close);
    return { run, close };
  });
  const redis = {
    zincrby: vi.fn(async () => 0), zrevrangeWithScores: vi.fn(async () => []),
    lpush: vi.fn(async () => 0), ltrim: vi.fn(async () => undefined),
  };
  const embedding = { available: false, embed: vi.fn(), embedBatch: vi.fn() };
  return {
    assembler: new UnifiedAssembler({ session } as never, redis, null, null, embedding),
    run, closes, session,
  };
}

async function invoke(lane: Lane, assembler: UnifiedAssembler) {
  const options = { strategy: 'deterministic' as const, max_tokens: 1_000_000 };
  return lane === 'traced'
    ? assembler.assembleTraced('find Target', options)
    : { context: await assembler.assemble('find Target', options) };
}

async function invokeAutoGraph(lane: Lane, assembler: UnifiedAssembler) {
  const options = { strategy: 'auto' as const, max_tokens: 1_000_000 };
  return lane === 'traced'
    ? assembler.assembleTraced('who calls Target', options)
    : { context: await assembler.assemble('who calls Target', options) };
}

function contextIds(result: { context: Awaited<ReturnType<UnifiedAssembler['assemble']>> }): string[] {
  return result.context.sections.flatMap((section) => section.items.map((item) => item.id));
}

function expectInvalidTrace(result: unknown, channel: string): void {
  expect((result as TracedUnifiedContext).trace.events).toContainEqual(expect.objectContaining({
    kind: 'channel-terminal', channel, outcome: 'safe-failure', code: 'invalid-result',
  }));
}

function accessorResult(hooks: ReturnType<typeof vi.fn>, marker: string): object {
  const result = {} as Record<string, unknown>;
  Object.defineProperty(result, 'records', {
    enumerable: true,
    get() { hooks(); throw new Error(marker); },
  });
  return result;
}

function hostileValue(hooks: ReturnType<typeof vi.fn>): object {
  return new Proxy({
    toString() { hooks(); return 'hostile'; },
    valueOf() { hooks(); return 1; },
    map() { hooks(); return []; },
  }, { get(target, key, receiver) { hooks(); return Reflect.get(target, key, receiver); } });
}

describe('UnifiedAssembler non-stable deterministic provider-result boundaries', () => {
  it.each(['ordinary', 'traced'] as const)('%s preserves valid discovery and every deterministic batch', async (lane) => {
    const deps = makeAssembler();
    const result = await invoke(lane, deps.assembler);
    expect(contextIds(result)).toEqual(expect.arrayContaining([
      'hier-Parent', 'target-Target', 'dep-Target-Dependency', 'dnt-Dependent-Target', 'aspect-Security', 'sem-1',
    ]));
    expect(new Set(deps.run.mock.calls.map(([query]) => pathFor(String(query))))).toEqual(new Set([
      'discovery-ft', 'ancestors', 'entity', 'dependencies', 'dependents', 'aspects', 'semantics',
    ]));
  });

  it.each(['ordinary', 'traced'] as const)('%s preserves the valid fallback discovery lane', async (lane) => {
    const deps = makeAssembler({ 'discovery-ft': { records: [] } });
    const result = await invoke(lane, deps.assembler);
    expect(contextIds(result)).toContain('target-Target');
    expect(deps.run.mock.calls.map(([query]) => pathFor(String(query))))
      .toEqual(expect.arrayContaining(['discovery-ft', 'discovery-fallback']));
  });

  it.each(['ordinary', 'traced'] as const)('%s routes auto GRAPH through the same authenticated provider boundary', async (lane) => {
    const hooks = vi.fn();
    const tags = Proxy.revocable(['safe'], {
      get(target, key, receiver) { hooks(); return Reflect.get(target, key, receiver); },
    });
    void tags.proxy.map;
    expect(hooks).toHaveBeenCalled();
    hooks.mockClear();
    tags.revoke();
    const invalid = record(
      ['targetName', 'id', 'content', 'confidence', 'tags'],
      ['Target', 'sem-1', 'content', 0.9, tags.proxy],
    );
    const deps = makeAssembler({ semantics: { records: [invalid] } });
    if (lane === 'ordinary') {
      await expect(invokeAutoGraph(lane, deps.assembler)).rejects.toThrow('deterministic_provider_result_invalid');
    } else {
      expectInvalidTrace(await invokeAutoGraph(lane, deps.assembler), 'memory.graph');
    }
    expect(hooks).not.toHaveBeenCalled();
    expect(deps.closes).not.toHaveLength(0);
    for (const close of deps.closes) expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps valid deterministic siblings when one traced batch is invalid and closes every session once', async () => {
    const deps = makeAssembler({ dependencies: { records: [record(
      ['targetName', 'name', 'relation', 'interface_desc'],
      ['Target', 'Dependency', {}, 'call()'],
    )] } });
    const result = await invoke('traced', deps.assembler);
    expect(contextIds(result)).toEqual(expect.arrayContaining(['target-Target', 'aspect-Security', 'sem-1']));
    expect(contextIds(result)).not.toContain('dep-Target-Dependency');
    expectInvalidTrace(result, 'arch.dependency');
    expect(deps.closes).toHaveLength(deps.session.mock.calls.length);
    for (const close of deps.closes) expect(close).toHaveBeenCalledTimes(1);
  });

  it.each(['ordinary', 'traced'] as const)('%s rejects revoked nested property arrays with the fixed provider error', async (lane) => {
    const aliases = Proxy.revocable(['alias'], {});
    aliases.revoke();
    const deps = makeAssembler({ entity: { records: [record(
      ['targetName', 'e'],
      ['Target', { properties: { id: 'target-id', name: 'Target', aliases: aliases.proxy } }],
    )] } });
    if (lane === 'ordinary') {
      await expect(invoke(lane, deps.assembler)).rejects.toThrow('deterministic_provider_result_invalid');
    } else {
      expectInvalidTrace(await invoke(lane, deps.assembler), 'arch.entity');
    }
  });

  it.each(['ordinary', 'traced'] as const)('%s authenticates stable-ID nested arrays before Array.isArray', async (lane) => {
    const aliases = Proxy.revocable(['alias'], {});
    aliases.revoke();
    const run = vi.fn(async (cypher: string) => cypher.includes('RETURN toString(ordinal) AS ordinal, targetId, e,')
      ? { records: [record(
          ['ordinal', 'targetId', 'e', 'projectName'],
          ['0', 'entity-a', { properties: { id: 'entity-a', name: 'Target', aliases: aliases.proxy } }, null],
        )] }
      : { records: [] });
    const closes: ReturnType<typeof vi.fn>[] = [];
    const driver = { session: vi.fn(() => {
      const close = vi.fn(async () => undefined);
      closes.push(close);
      return { run, close };
    }) };
    const assembler = new DeterministicAssembler(driver as never);
    const options = { resolvedEntityIds: ['entity-a'] };
    if (lane === 'ordinary') {
      await expect(assembler.assemble('task', options)).rejects.toThrow('stable_deterministic_result_invalid');
    } else {
      const result = await assembler.assembleTraced('task', options);
      expect(result.trace.events).toContainEqual(expect.objectContaining({
        kind: 'channel-terminal', channel: 'arch.entity', outcome: 'safe-failure', code: 'invalid-result',
      }));
    }
    for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
  });

  it.each(['ordinary', 'traced'] as const)('%s contains discovery result accessors without reading them or leaking markers', async (lane) => {
    for (const path of ['discovery-ft', 'discovery-fallback'] as const) {
      const hooks = vi.fn();
      const marker = `private-${path}-marker`;
      const overrides = path === 'discovery-ft'
        ? { 'discovery-ft': accessorResult(hooks, marker), 'discovery-fallback': { records: [] } }
        : { 'discovery-ft': { records: [] }, 'discovery-fallback': accessorResult(hooks, marker) };
      const deps = makeAssembler(overrides);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const result = await invoke(lane, deps.assembler);
      expect(hooks, path).not.toHaveBeenCalled();
      expect(contextIds(result), path).toEqual(['none']);
      expect(JSON.stringify(error.mock.calls), path).not.toContain(marker);
      if (lane === 'traced') expectInvalidTrace(result, 'arch.fulltext');
      error.mockRestore();
    }
  });

  it.each(['ordinary', 'traced'] as const)('%s rejects discovery record proxies and hostile name values without hooks', async (lane) => {
    for (const mode of ['proxy', 'value'] as const) {
      const hooks = vi.fn();
      const hostile = mode === 'proxy'
        ? new Proxy(record(['name'], ['Target']), {
            get(target, key, receiver) { hooks(); return Reflect.get(target, key, receiver); },
            ownKeys(target) { hooks(); return Reflect.ownKeys(target); },
            getOwnPropertyDescriptor(target, key) { hooks(); return Reflect.getOwnPropertyDescriptor(target, key); },
          })
        : record(['name'], [hostileValue(hooks)]);
      const deps = makeAssembler({ 'discovery-ft': { records: [hostile] }, 'discovery-fallback': { records: [] } });
      const result = await invoke(lane, deps.assembler);
      expect(hooks).not.toHaveBeenCalled();
      expect(contextIds(result)).toEqual(['none']);
      if (lane === 'traced') expectInvalidTrace(result, 'arch.fulltext');
    }
  });

  it.each(['ordinary', 'traced'] as const)('%s contains every batch result accessor without later provider work', async (lane) => {
    const channels: Record<Exclude<Path, 'discovery-ft' | 'discovery-fallback'>, string> = {
      ancestors: 'arch.hierarchy', entity: 'arch.entity', dependencies: 'arch.dependency',
      dependents: 'arch.dependency', aspects: 'arch.aspect', semantics: 'memory.graph',
    };
    for (const path of Object.keys(channels) as Array<keyof typeof channels>) {
      const hooks = vi.fn();
      const marker = `private-${path}-marker`;
      const deps = makeAssembler({ [path]: accessorResult(hooks, marker) });
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      if (lane === 'ordinary') {
        await expect(invoke(lane, deps.assembler)).rejects.toThrow('deterministic_provider_result_invalid');
      } else {
        const result = await invoke(lane, deps.assembler);
        expectInvalidTrace(result, channels[path]);
      }
      expect(hooks, path).not.toHaveBeenCalled();
      expect(JSON.stringify(error.mock.calls), path).not.toContain(marker);
      error.mockRestore();
    }
  });

  it.each(['ordinary', 'traced'] as const)('%s rejects proxied records and node-property accessors without traps', async (lane) => {
    for (const [path, invalid] of [
      ['ancestors', { records: [new Proxy(validResult('ancestors').records[0]!, {})] }],
      ['entity', (() => {
        const hooks = vi.fn();
        const node = {} as Record<string, unknown>;
        Object.defineProperty(node, 'properties', { enumerable: true, get() { hooks(); return {}; } });
        return { records: [record(['targetName', 'e'], ['Target', node])], hooks };
      })()],
    ] as const) {
      const hooks = 'hooks' in invalid ? invalid.hooks : vi.fn();
      const deps = makeAssembler({ [path]: { records: invalid.records } });
      if (lane === 'ordinary') {
        await expect(invoke(lane, deps.assembler)).rejects.toThrow('deterministic_provider_result_invalid');
      } else {
        const result = await invoke(lane, deps.assembler);
        expectInvalidTrace(result, path === 'ancestors' ? 'arch.hierarchy' : 'arch.entity');
      }
      expect(hooks).not.toHaveBeenCalled();
    }
  });

  it.each(['ordinary', 'traced'] as const)('%s authenticates scalars for every batch before interpolation, sort, and scoring', async (lane) => {
    const cases: Array<[Path, Neo4jRecord]> = [
      ['ancestors', record(['targetName', 'name', 'depth', 'responsibility'], ['Target', hostileValue(vi.fn()), 1, 'R'])],
      ['entity', record(['targetName', 'e'], ['Target', { properties: { id: 'id', name: hostileValue(vi.fn()) } }])],
      ['dependencies', record(['targetName', 'name', 'relation', 'interface_desc'], ['Target', 'D', hostileValue(vi.fn()), 'I'])],
      ['dependents', record(['targetName', 'name', 'relation'], ['Target', hostileValue(vi.fn()), 'CALLS'])],
      ['aspects', record(['targetName', 'name', 'stability_tier', 'description'], ['Target', 'A', hostileValue(vi.fn()), 'D'])],
      ['semantics', record(['targetName', 'id', 'content', 'confidence', 'tags'], ['Target', 's', 'C', hostileValue(vi.fn()), []])],
    ];
    for (const [path, invalid] of cases) {
      const hooks = vi.fn();
      const fields = [...invalid._fields];
      const hostileIndex = fields.findIndex((value) => typeof value === 'object' && value !== null
        && !Array.isArray(value) && !('properties' in (value as object)));
      if (hostileIndex >= 0) fields[hostileIndex] = hostileValue(hooks);
      if (path === 'entity') fields[1] = { properties: { id: 'id', name: hostileValue(hooks) } };
      const deps = makeAssembler({ [path]: { records: [record([...invalid.keys], fields)] } });
      if (lane === 'ordinary') {
        await expect(invoke(lane, deps.assembler)).rejects.toThrow('deterministic_provider_result_invalid');
      } else {
        const result = await invoke(lane, deps.assembler);
        const channel = path === 'ancestors' ? 'arch.hierarchy'
          : path === 'entity' ? 'arch.entity'
          : path === 'aspects' ? 'arch.aspect'
          : path === 'semantics' ? 'memory.graph' : 'arch.dependency';
        expectInvalidTrace(result, channel);
      }
      expect(hooks, path).not.toHaveBeenCalled();
    }
  });

  it.each(['ordinary', 'traced'] as const)('%s validates semantic tag arrays without accessor/coercion work', async (lane) => {
    const hooks = vi.fn();
    const tags: unknown[] = ['safe'];
    Object.defineProperty(tags, '0', { enumerable: true, get() { hooks(); return 'hostile'; } });
    const invalid = record(
      ['targetName', 'id', 'content', 'confidence', 'tags'],
      ['Target', 'sem-1', 'content', 0.9, tags],
    );
    const deps = makeAssembler({ semantics: { records: [invalid] } });
    if (lane === 'ordinary') {
      await expect(invoke(lane, deps.assembler)).rejects.toThrow('deterministic_provider_result_invalid');
    } else {
      expectInvalidTrace(await invoke(lane, deps.assembler), 'memory.graph');
    }
    expect(hooks).not.toHaveBeenCalled();
  });

  it.each(['ordinary', 'traced'] as const)('%s enforces declared and static record cardinality before entries', async (lane) => {
    const cases: Array<[Path, Neo4jRecord[], string]> = [
      ['discovery-ft', Array.from({ length: 6 }, () => record(['name'], ['Target'])), 'arch.fulltext'],
      ['entity', Array.from({ length: 2 }, () => validResult('entity').records[0]!), 'arch.entity'],
      ['semantics', Array.from({ length: 11 }, () => validResult('semantics').records[0]!), 'memory.graph'],
      ['ancestors', Array.from({ length: MAX_BATCH_RECORDS + 1 }, () => validResult('ancestors').records[0]!), 'arch.hierarchy'],
    ];
    for (const [path, records, channel] of cases) {
      const hooks = vi.fn();
      Object.defineProperty(records, '0', { enumerable: true, get() { hooks(); return validResult(path).records[0]!; } });
      const deps = makeAssembler({ [path]: { records }, ...(path === 'discovery-ft' ? { 'discovery-fallback': { records: [] } } : {}) });
      if (path === 'discovery-ft') {
        const result = await invoke(lane, deps.assembler);
        expect(contextIds(result)).toEqual(['none']);
        if (lane === 'traced') expectInvalidTrace(result, channel);
      } else if (lane === 'ordinary') {
        await expect(invoke(lane, deps.assembler)).rejects.toThrow('deterministic_provider_result_invalid');
      } else {
        expectInvalidTrace(await invoke(lane, deps.assembler), channel);
      }
      expect(hooks, path).not.toHaveBeenCalled();
    }
  });

  it.each(['ordinary', 'traced'] as const)('%s accepts exact deterministic string bytes and rejects the next byte', async (lane) => {
    for (const [label, exact, oversized] of [
      ['ascii', 'x'.repeat(MAX_STRING_BYTES), 'x'.repeat(MAX_STRING_BYTES + 1)],
      ['multibyte', '🙂'.repeat(MAX_STRING_BYTES / 4), `${'🙂'.repeat(MAX_STRING_BYTES / 4)}x`],
    ] as const) {
      const accepted = makeAssembler({ semantics: { records: [record(
        ['targetName', 'id', 'content', 'confidence', 'tags'], ['Target', 'sem-1', exact, 0.9, []],
      )] } });
      expect(contextIds(await invoke(lane, accepted.assembler)), label).toContain('sem-1');
      const rejected = makeAssembler({ semantics: { records: [record(
        ['targetName', 'id', 'content', 'confidence', 'tags'], ['Target', 'sem-1', oversized, 0.9, []],
      )] } });
      if (lane === 'ordinary') {
        await expect(invoke(lane, rejected.assembler), label).rejects.toThrow('deterministic_provider_result_invalid');
      } else {
        expectInvalidTrace(await invoke(lane, rejected.assembler), 'memory.graph');
      }
    }
  });

  it.each(['ordinary', 'traced'] as const)('%s enforces deterministic aggregate bytes before the remaining scan', async (lane) => {
    let remaining = MAX_AGGREGATE_STRING_BYTES;
    const records = Array.from({ length: MAX_BATCH_RECORDS }, (_, index) => {
      const target = 'Target';
      const name = `N${index}`;
      const depth = 1;
      remaining -= Buffer.byteLength(target) + Buffer.byteLength(name);
      return record(['targetName', 'name', 'depth', 'responsibility'], [target, name, depth, '']);
    });
    for (const row of records) {
      const size = Math.min(MAX_STRING_BYTES, Math.max(0, remaining));
      row._fields[3] = 'x'.repeat(size);
      remaining -= size;
    }
    expect(remaining).toBe(0);
    expect(contextIds(await invoke(lane, makeAssembler({ ancestors: { records } }).assembler)))
      .toContain('hier-N0');

    records.at(-1)!._fields[3] = `${records.at(-1)!._fields[3] as string}\ud800`;
    const rejectedTail = records.at(-1)!._fields[3];
    const byteLength = vi.spyOn(Buffer, 'byteLength');
    const before = byteLength.mock.calls.length;
    const rejected = makeAssembler({ ancestors: { records } });
    if (lane === 'ordinary') {
      await expect(invoke(lane, rejected.assembler)).rejects.toThrow('deterministic_provider_result_invalid');
    } else {
      expectInvalidTrace(await invoke(lane, rejected.assembler), 'arch.hierarchy');
    }
    expect(byteLength.mock.calls.slice(before).some(([value]) => value === rejectedTail)).toBe(false);
    byteLength.mockRestore();
  });
});
