// packages/redis/src/__tests__/cache.test.ts
import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest';
import type { Redis } from 'ioredis';
import { createRedisClient } from '../client.js';
import {
  ACTIVE_SEMANTIC_POLICY_VERSION,
  CONTEXT_CACHE_SCHEMA_VERSION,
  ContextCache,
  type ContextCacheMetadata,
} from '../cache.js';
import type { MemoryContext } from '@memberry/core';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

function metadata(
  tenantId = 'default',
  knowledgeEpoch = '1',
  overrides: Partial<ContextCacheMetadata> = {},
): ContextCacheMetadata {
  return {
    schemaVersion: CONTEXT_CACHE_SCHEMA_VERSION,
    tenantId,
    projectScope: 'project:test',
    readFrame: { mode: 'current' },
    policyVersion: ACTIVE_SEMANTIC_POLICY_VERSION,
    embeddingGeneration: 'embedding-v1',
    knowledgeEpoch,
    ...overrides,
  };
}

async function writeContext(
  cache: ContextCache,
  scopeHash: string,
  context: MemoryContext,
  sourceNodeIds: string[],
  tenantId = 'default',
  scopeTags?: string[],
  knowledgeEpoch = '1',
): Promise<boolean> {
  return cache.set({
    scopeHash,
    metadata: metadata(tenantId, knowledgeEpoch),
    context,
    sourceNodeIds,
    ttl: 60,
    scopeTags,
  });
}

function readContext(cache: ContextCache, scopeHash: string, tenantId = 'default', knowledgeEpoch = '1') {
  return cache.get({ scopeHash, metadata: metadata(tenantId, knowledgeEpoch) });
}

async function isRedisReachable(url: string): Promise<boolean> {
  const probe = createRedisClient(url, {
    maxRetriesPerRequest: 0,
    connectTimeout: 1000,
    retryStrategy: () => null,
  });
  try {
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    await probe.quit().catch(() => {});
  }
}

describe('ContextCache', () => {
  const redis = createRedisClient(REDIS_URL);
  const cache = new ContextCache(redis, { mode: 'versioned' });
  let redisAvailable = false;

  beforeAll(async () => {
    redisAvailable = await isRedisReachable(REDIS_URL);
    if (!redisAvailable) {
      console.warn(`[skip] Redis not reachable at ${REDIS_URL} — skipping cache tests`);
    }
  });

  beforeEach(async () => {
    if (!redisAvailable) return;
    const keys = await redis.keys('amp:ctx:*test-*');
    if (keys.length) await redis.del(...keys);
    const depKeys = await redis.keys('amp:deps:test-*');
    if (depKeys.length) await redis.del(...depKeys);
    const epochKeys = await redis.keys('amp:knowledge-epoch:*project:test');
    if (epochKeys.length) await redis.del(...epochKeys);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('should return null for cache miss', async () => {
    if (!redisAvailable) return;
    const result = await readContext(cache, 'nonexistent-scope-hash');
    expect(result).toBeNull();
  });

  it('should store and retrieve context', async () => {
    if (!redisAvailable) return;
    const context = {
      markdown: '# Memory\nSome content',
      tokens: 100,
      sources: ['test-node-1', 'test-node-2'],
      assembled_at: new Date().toISOString(),
    };
    await writeContext(cache, 'test-scope-1', context, ['test-node-1', 'test-node-2']);
    const result = await readContext(cache, 'test-scope-1');
    expect(result).toEqual(context);
  });

  it('should track dependencies for invalidation', async () => {
    if (!redisAvailable) return;
    const context = {
      markdown: '# Test',
      tokens: 50,
      sources: ['test-node-A'],
      assembled_at: new Date().toISOString(),
    };
    await writeContext(cache, 'test-scope-2', context, ['test-node-A']);

    const invalidated = await cache.invalidateByNodeId('test-node-A');
    expect(invalidated).toBeGreaterThan(0);

    const result = await readContext(cache, 'test-scope-2');
    expect(result).toBeNull();
  });

  it('should return 0 when invalidating a node with no dependencies', async () => {
    if (!redisAvailable) return;
    const invalidated = await cache.invalidateByNodeId('test-node-nonexistent');
    expect(invalidated).toBe(0);
  });

  it('should invalidate multiple caches sharing the same source node', async () => {
    if (!redisAvailable) return;
    const contextA = {
      markdown: '# Context A',
      tokens: 10,
      sources: ['test-node-shared'],
      assembled_at: new Date().toISOString(),
    };
    const contextB = {
      markdown: '# Context B',
      tokens: 20,
      sources: ['test-node-shared'],
      assembled_at: new Date().toISOString(),
    };

    await writeContext(cache, 'test-scope-3', contextA, ['test-node-shared']);
    await writeContext(cache, 'test-scope-4', contextB, ['test-node-shared']);

    const invalidated = await cache.invalidateByNodeId('test-node-shared');
    expect(invalidated).toBe(2);

    expect(await readContext(cache, 'test-scope-3')).toBeNull();
    expect(await readContext(cache, 'test-scope-4')).toBeNull();
  });
});

// ─── Per-tenant key isolation (deterministic, mock-backed) ───────────────────
// These tests don't need a live Redis: they use a tiny in-memory fake that
// implements only the surface ContextCache touches (get/setex + a pipeline with
// sadd/expire/del/exec, plus smembers). They pin the cross-tenant isolation
// contract introduced by OPT-27.

interface FakeRedis {
  store: Map<string, string>;
  sets: Map<string, Set<string>>;
}

function makeFakeRedis(): { redis: Redis; backing: FakeRedis } {
  const backing: FakeRedis = { store: new Map(), sets: new Map() };

  const pipeline = () => {
    const ops: Array<() => void> = [];
    const chain: any = {
      sadd(key: string, member: string) {
        ops.push(() => {
          const s = backing.sets.get(key) ?? new Set<string>();
          s.add(member);
          backing.sets.set(key, s);
        });
        return chain;
      },
      expire(_key: string, _ttl: number) {
        ops.push(() => {});
        return chain;
      },
      del(key: string) {
        ops.push(() => {
          backing.store.delete(key);
          backing.sets.delete(key);
        });
        return chain;
      },
      async exec() {
        for (const op of ops) op();
        return [];
      },
    };
    return chain;
  };

  const redis = {
    async get(key: string): Promise<string | null> {
      return backing.store.get(key) ?? null;
    },
    async setex(key: string, _ttl: number, value: string): Promise<'OK'> {
      backing.store.set(key, value);
      return 'OK';
    },
    async eval(_script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<number> {
      const keys = args.slice(0, numberOfKeys).map(String);
      const argv = args.slice(numberOfKeys).map(String);
      if (numberOfKeys === 2) {
        const [contextKey, knowledgeEpochKey] = keys;
        const [epoch, _ttl, value] = argv;
        const current = backing.store.get(knowledgeEpochKey!);
        if (current === undefined) backing.store.set(knowledgeEpochKey!, epoch!);
        else if (current !== epoch) return 0;
        backing.store.set(contextKey!, value!);
        return 1;
      }
      const [knowledgeEpochKey] = keys;
      const [epoch] = argv;
      const current = backing.store.get(knowledgeEpochKey!);
      if (current !== undefined && BigInt(current) > BigInt(epoch!)) return 0;
      backing.store.set(knowledgeEpochKey!, epoch!);
      return 1;
    },
    async smembers(key: string): Promise<string[]> {
      return Array.from(backing.sets.get(key) ?? []);
    },
    pipeline,
  } as unknown as Redis;

  return { redis, backing };
}

function ctx(markdown: string, sources: string[]): MemoryContext {
  return { markdown, tokens: 1, sources, assembled_at: '2026-01-01T00:00:00.000Z' };
}

describe('ContextCache — per-tenant isolation', () => {
  it('defaults to disabled and requires explicit versioned opt-in', async () => {
    const { redis, backing } = makeFakeRedis();
    const cache = new ContextCache(redis);
    expect(cache.mode).toBe('disabled');
    expect(await writeContext(cache, 'scope', ctx('# hidden', ['n1']), ['n1'])).toBe(false);
    expect(backing.store.size).toBe(0);
  });

  it('rejects legacy entries and every versioned metadata mismatch', async () => {
    const { redis, backing } = makeFakeRedis();
    const cache = new ContextCache(redis, { mode: 'versioned' });
    const value = ctx('# current', ['n1']);
    expect(await writeContext(cache, 'scope', value, ['n1'], 'tenant-a')).toBe(true);

    backing.store.set('amp:ctx:v2:tenant-a:legacy', JSON.stringify(value));
    expect(await readContext(cache, 'legacy', 'tenant-a')).toBeNull();
    expect(await cache.get({
      scopeHash: 'scope',
      metadata: metadata('tenant-a', '1', { policyVersion: 'semantic-active-v2' }),
    })).toBeNull();
    expect(await cache.get({
      scopeHash: 'scope',
      metadata: metadata('tenant-a', '1', { embeddingGeneration: 'embedding-v2' }),
    })).toBeNull();
    expect(await cache.get({
      scopeHash: 'scope',
      metadata: metadata('tenant-a', '1', { readFrame: { mode: 'historical', asOf: '2026-01-01T00:00:00.000Z' } }),
    })).toBeNull();
    expect(await readContext(cache, 'scope', 'tenant-a', '2')).toBeNull();
  });

  it('rejects a stale worker write after a newer authoritative epoch is observed', async () => {
    const { redis } = makeFakeRedis();
    const cache = new ContextCache(redis, { mode: 'versioned' });
    expect(await cache.advanceKnowledgeEpoch(metadata('tenant-a', '7'))).toBe(true);
    expect(await writeContext(cache, 'scope', ctx('# stale', ['old']), ['old'], 'tenant-a', undefined, '6')).toBe(false);
    expect(await readContext(cache, 'scope', 'tenant-a', '7')).toBeNull();
    expect(await writeContext(cache, 'scope', ctx('# current', ['new']), ['new'], 'tenant-a', undefined, '7')).toBe(true);
    expect(await readContext(cache, 'scope', 'tenant-a', '7')).toEqual(ctx('# current', ['new']));
    expect(await cache.advanceKnowledgeEpoch(metadata('tenant-a', '6'))).toBe(false);
  });

  it('disabled mode always misses and never writes rendered bytes', async () => {
    const { redis, backing } = makeFakeRedis();
    const cache = new ContextCache(redis, { mode: 'disabled' });
    expect(await writeContext(cache, 'scope', ctx('# hidden', ['n1']), ['n1'])).toBe(false);
    expect(await readContext(cache, 'scope')).toBeNull();
    expect(backing.store.size).toBe(0);
  });

  it("invalidateByScope for tenant A evicts A's ctx but NOT B's under a shared tag", async () => {
    const { redis } = makeFakeRedis();
    const cache = new ContextCache(redis, { mode: 'versioned' });
    const sharedTag = 'project:shared';

    await writeContext(cache, 'scopeA', ctx('# A', ['n1']), ['n1'], 'tenant-a', [sharedTag]);
    await writeContext(cache, 'scopeB', ctx('# B', ['n2']), ['n2'], 'tenant-b', [sharedTag]);

    const evicted = await cache.invalidateByScope(sharedTag, 'tenant-a');
    expect(evicted).toBe(1); // only A's dep set is touched

    // Within-tenant: A's ctx is gone…
    expect(await readContext(cache, 'scopeA', 'tenant-a')).toBeNull();
    // …but B's ctx (same tag, different tenant) survives.
    expect(await readContext(cache, 'scopeB', 'tenant-b')).toEqual(ctx('# B', ['n2']));
  });

  it("invalidateByNodeId for tenant A evicts A's ctx but NOT B's under a shared node id", async () => {
    const { redis } = makeFakeRedis();
    const cache = new ContextCache(redis, { mode: 'versioned' });

    await writeContext(cache, 'scopeA', ctx('# A', ['shared-node']), ['shared-node'], 'tenant-a');
    await writeContext(cache, 'scopeB', ctx('# B', ['shared-node']), ['shared-node'], 'tenant-b');

    const evicted = await cache.invalidateByNodeId('shared-node', 'tenant-a');
    expect(evicted).toBe(1);

    expect(await readContext(cache, 'scopeA', 'tenant-a')).toBeNull();
    expect(await readContext(cache, 'scopeB', 'tenant-b')).toEqual(ctx('# B', ['shared-node']));
  });

  it('within-tenant invalidation still works (ctx key + dep set share the tenant segment)', async () => {
    const { redis } = makeFakeRedis();
    const cache = new ContextCache(redis, { mode: 'versioned' });

    await writeContext(cache, 'scopeA', ctx('# A', ['n1']), ['n1'], 'tenant-a', ['project:x']);
    expect(await readContext(cache, 'scopeA', 'tenant-a')).toEqual(ctx('# A', ['n1']));

    // scope invalidation finds and evicts A's ctx
    expect(await cache.invalidateByScope('project:x', 'tenant-a')).toBe(1);
    expect(await readContext(cache, 'scopeA', 'tenant-a')).toBeNull();

    // node invalidation also works within tenant. Use a distinct node id (n2) so
    // this sub-case isn't polluted by the stale member the scope-invalidation
    // above leaves in amp:deps:tenant-a:n1 (scope-invalidation deletes the ctx
    // key + scope-deps set but never the node-deps set — faithful to real Redis).
    await writeContext(cache, 'scopeA2', ctx('# A2', ['n2']), ['n2'], 'tenant-a');
    expect(await cache.invalidateByNodeId('n2', 'tenant-a')).toBe(1);
    expect(await readContext(cache, 'scopeA2', 'tenant-a')).toBeNull();
  });

  it('default tenant stays un-namespaced while legacy/unversioned values are rejected', async () => {
    const { redis, backing } = makeFakeRedis();
    const cache = new ContextCache(redis, { mode: 'versioned' });

    await writeContext(cache, 'scopeD', ctx('# D', ['n1']), ['n1'], 'default', ['project:x']);
    expect(await readContext(cache, 'scopeD')).toEqual(ctx('# D', ['n1']));

    expect(backing.store.has('amp:ctx:v2:scopeD')).toBe(true);
    expect(backing.sets.has('amp:deps:n1')).toBe(true);
    expect(backing.sets.has('amp:scope-deps:project:x')).toBe(true);

    await writeContext(cache, 'scopeD2', ctx('# D2', ['n2']), ['n2'], 'default', ['project:y']);
    expect(backing.store.has('amp:ctx:v2:scopeD2')).toBe(true);
    expect(backing.sets.has('amp:deps:n2')).toBe(true);
    expect(await cache.invalidateByScope('project:y')).toBe(1);
    expect(await readContext(cache, 'scopeD2')).toBeNull();

    backing.store.set('amp:ctx:legacy', JSON.stringify(ctx('# legacy', [])));
    expect(await cache.get('legacy')).toBeNull();
  });

  it('named tenant keys carry the tenant segment for ctx + dep sets', async () => {
    const { redis, backing } = makeFakeRedis();
    const cache = new ContextCache(redis, { mode: 'versioned' });

    await writeContext(cache, 'scopeT', ctx('# T', ['n1']), ['n1'], 'acme', ['project:x']);

    // ctx value key is tenant-segmented…
    expect(backing.store.has('amp:ctx:v2:acme:scopeT')).toBe(true);
    expect(backing.store.has('amp:ctx:v2:scopeT')).toBe(false);
    // …and so are BOTH dep-set keys.
    expect(backing.sets.has('amp:deps:acme:n1')).toBe(true);
    expect(backing.sets.has('amp:deps:n1')).toBe(false);
    expect(backing.sets.has('amp:scope-deps:acme:project:x')).toBe(true);
    expect(backing.sets.has('amp:scope-deps:project:x')).toBe(false);

    // And the ctx key registered inside the dep set is itself tenant-segmented,
    // so invalidation (which del()s those members) hits the right ctx key.
    expect(Array.from(backing.sets.get('amp:scope-deps:acme:project:x')!)).toEqual(['amp:ctx:v2:acme:scopeT']);
  });
});
