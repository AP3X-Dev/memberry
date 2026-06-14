// packages/redis/src/__tests__/cache.test.ts
import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest';
import type { Redis } from 'ioredis';
import { createRedisClient } from '../client.js';
import { ContextCache } from '../cache.js';
import type { MemoryContext } from '@memberry/core';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

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
  const cache = new ContextCache(redis);
  let redisAvailable = false;

  beforeAll(async () => {
    redisAvailable = await isRedisReachable(REDIS_URL);
    if (!redisAvailable) {
      console.warn(`[skip] Redis not reachable at ${REDIS_URL} — skipping cache tests`);
    }
  });

  beforeEach(async () => {
    if (!redisAvailable) return;
    const keys = await redis.keys('amp:ctx:test-*');
    if (keys.length) await redis.del(...keys);
    const depKeys = await redis.keys('amp:deps:test-*');
    if (depKeys.length) await redis.del(...depKeys);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('should return null for cache miss', async () => {
    if (!redisAvailable) return;
    const result = await cache.get('nonexistent-scope-hash');
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
    await cache.set('test-scope-1', context, ['test-node-1', 'test-node-2'], 60);
    const result = await cache.get('test-scope-1');
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
    await cache.set('test-scope-2', context, ['test-node-A'], 60);

    const invalidated = await cache.invalidateByNodeId('test-node-A');
    expect(invalidated).toBeGreaterThan(0);

    const result = await cache.get('test-scope-2');
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

    await cache.set('test-scope-3', contextA, ['test-node-shared'], 60);
    await cache.set('test-scope-4', contextB, ['test-node-shared'], 60);

    const invalidated = await cache.invalidateByNodeId('test-node-shared');
    expect(invalidated).toBe(2);

    expect(await cache.get('test-scope-3')).toBeNull();
    expect(await cache.get('test-scope-4')).toBeNull();
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
  it("invalidateByScope for tenant A evicts A's ctx but NOT B's under a shared tag", async () => {
    const { redis } = makeFakeRedis();
    const cache = new ContextCache(redis);
    const sharedTag = 'project:shared';

    await cache.set('scopeA', ctx('# A', ['n1']), ['n1'], 60, [sharedTag], 'tenant-a');
    await cache.set('scopeB', ctx('# B', ['n2']), ['n2'], 60, [sharedTag], 'tenant-b');

    const evicted = await cache.invalidateByScope(sharedTag, 'tenant-a');
    expect(evicted).toBe(1); // only A's dep set is touched

    // Within-tenant: A's ctx is gone…
    expect(await cache.get('scopeA', 'tenant-a')).toBeNull();
    // …but B's ctx (same tag, different tenant) survives.
    expect(await cache.get('scopeB', 'tenant-b')).toEqual(ctx('# B', ['n2']));
  });

  it("invalidateByNodeId for tenant A evicts A's ctx but NOT B's under a shared node id", async () => {
    const { redis } = makeFakeRedis();
    const cache = new ContextCache(redis);

    await cache.set('scopeA', ctx('# A', ['shared-node']), ['shared-node'], 60, undefined, 'tenant-a');
    await cache.set('scopeB', ctx('# B', ['shared-node']), ['shared-node'], 60, undefined, 'tenant-b');

    const evicted = await cache.invalidateByNodeId('shared-node', 'tenant-a');
    expect(evicted).toBe(1);

    expect(await cache.get('scopeA', 'tenant-a')).toBeNull();
    expect(await cache.get('scopeB', 'tenant-b')).toEqual(ctx('# B', ['shared-node']));
  });

  it('within-tenant invalidation still works (ctx key + dep set share the tenant segment)', async () => {
    const { redis } = makeFakeRedis();
    const cache = new ContextCache(redis);

    await cache.set('scopeA', ctx('# A', ['n1']), ['n1'], 60, ['project:x'], 'tenant-a');
    expect(await cache.get('scopeA', 'tenant-a')).toEqual(ctx('# A', ['n1']));

    // scope invalidation finds and evicts A's ctx
    expect(await cache.invalidateByScope('project:x', 'tenant-a')).toBe(1);
    expect(await cache.get('scopeA', 'tenant-a')).toBeNull();

    // node invalidation also works within tenant. Use a distinct node id (n2) so
    // this sub-case isn't polluted by the stale member the scope-invalidation
    // above leaves in amp:deps:tenant-a:n1 (scope-invalidation deletes the ctx
    // key + scope-deps set but never the node-deps set — faithful to real Redis).
    await cache.set('scopeA2', ctx('# A2', ['n2']), ['n2'], 60, undefined, 'tenant-a');
    expect(await cache.invalidateByNodeId('n2', 'tenant-a')).toBe(1);
    expect(await cache.get('scopeA2', 'tenant-a')).toBeNull();
  });

  it('default tenant round-trips on legacy un-namespaced keys', async () => {
    const { redis, backing } = makeFakeRedis();
    const cache = new ContextCache(redis);

    // No tenant arg → DEFAULT tenant → legacy keys, identical to single-tenant.
    await cache.set('scopeD', ctx('# D', ['n1']), ['n1'], 60, ['project:x']);
    expect(await cache.get('scopeD')).toEqual(ctx('# D', ['n1']));

    // Legacy key shape, no tenant segment.
    expect(backing.store.has('amp:ctx:scopeD')).toBe(true);
    expect(backing.sets.has('amp:deps:n1')).toBe(true);
    expect(backing.sets.has('amp:scope-deps:project:x')).toBe(true);

    // Explicit 'default' tenant is identical to omitting it.
    await cache.set('scopeD2', ctx('# D2', ['n2']), ['n2'], 60, ['project:y'], 'default');
    expect(backing.store.has('amp:ctx:scopeD2')).toBe(true);
    expect(backing.sets.has('amp:deps:n2')).toBe(true);
    expect(await cache.invalidateByScope('project:y')).toBe(1);
    expect(await cache.get('scopeD2')).toBeNull();
  });

  it('named tenant keys carry the tenant segment for ctx + dep sets', async () => {
    const { redis, backing } = makeFakeRedis();
    const cache = new ContextCache(redis);

    await cache.set('scopeT', ctx('# T', ['n1']), ['n1'], 60, ['project:x'], 'acme');

    // ctx value key is tenant-segmented…
    expect(backing.store.has('amp:ctx:acme:scopeT')).toBe(true);
    expect(backing.store.has('amp:ctx:scopeT')).toBe(false);
    // …and so are BOTH dep-set keys.
    expect(backing.sets.has('amp:deps:acme:n1')).toBe(true);
    expect(backing.sets.has('amp:deps:n1')).toBe(false);
    expect(backing.sets.has('amp:scope-deps:acme:project:x')).toBe(true);
    expect(backing.sets.has('amp:scope-deps:project:x')).toBe(false);

    // And the ctx key registered inside the dep set is itself tenant-segmented,
    // so invalidation (which del()s those members) hits the right ctx key.
    expect(Array.from(backing.sets.get('amp:scope-deps:acme:project:x')!)).toEqual(['amp:ctx:acme:scopeT']);
  });
});
