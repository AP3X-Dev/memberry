import { createHash, randomUUID } from 'crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createRedisClient } from '../client.js';
import { EmbeddingCache, type EmbeddingCacheAddress } from '../embeddings.js';

const mode = process.env.MEMBERRY_PR03_LIVE;
if (mode !== undefined && mode !== 'required')
  throw new Error('MEMBERRY_PR03_LIVE must be exactly required when set');
const liveDescribe = mode === 'required' ? describe : describe.skip;

liveDescribe('PR-03 real Redis embedding cache', () => {
  let redis: ReturnType<typeof createRedisClient>;
  let cache: EmbeddingCache;
  const keys = new Set<string>();
  const address: EmbeddingCacheAddress = {
    schemaVersion: 2,
    tenantId: `pr03-${randomUUID()}`,
    projectScope: 'project:cache-fixture',
    descriptorFingerprint: 'a'.repeat(64),
    contentHash: 'b'.repeat(64),
    dimensions: 2,
    normalization: 'l2',
  };
  function keyFor(value: EmbeddingCacheAddress): string {
    const scope = createHash('sha256')
      .update(JSON.stringify([value.tenantId, value.projectScope]))
      .digest('hex');
    const key = `amp:emb:v2:${scope}:${value.descriptorFingerprint}:${value.contentHash}`;
    keys.add(key);
    return key;
  }
  beforeAll(async () => {
    if (process.env.MEMBERRY_PR03_DISPOSABLE !== '1')
      throw new Error('PR-03 fixtures require MEMBERRY_PR03_DISPOSABLE=1');
    if (!process.env.REDIS_URL) throw new Error('PR-03 required live mode needs REDIS_URL');
    redis = createRedisClient(process.env.REDIS_URL, {
      retryStrategy: () => null,
      maxRetriesPerRequest: 0,
    });
    await redis.ping();
    cache = new EmbeddingCache(redis);
  });
  afterAll(async () => {
    if (!redis) return;
    try {
      if (redis.status === 'ready' && keys.size) await redis.del(...keys);
    } finally {
      redis.disconnect();
    }
  });

  it('round trips precise normalized vectors and enforces custom/default TTL', async () => {
    const key = keyFor(address);
    await cache.set(address, [0.6, 0.8]);
    expect(await cache.get(address)).toEqual([0.6, 0.8]);
    expect(await redis.ttl(key)).toBeGreaterThan(86390);
    await cache.set(address, [0.6, 0.8], 60);
    expect(await redis.ttl(key)).toBeGreaterThan(50);
    expect(await redis.ttl(key)).toBeLessThanOrEqual(60);
  });

  it('isolates tenants, projects, tenant-wide scope and same-dimension descriptors', async () => {
    keyFor(address);
    await cache.set(address, [0.6, 0.8]);
    for (const change of [
      { tenantId: `${address.tenantId}-other` },
      { projectScope: 'project:other' },
      { projectScope: null },
      { descriptorFingerprint: 'c'.repeat(64) },
    ]) {
      const other = { ...address, ...change };
      keyFor(other);
      expect(await cache.get(other)).toBeNull();
      await cache.set(other, [1, 0]);
      expect(await cache.get(other)).toEqual([1, 0]);
    }
    expect(await cache.get(address)).toEqual([0.6, 0.8]);
  });

  it('misses corrupt envelope identity, vector shape and normalization', async () => {
    const key = keyFor(address);
    for (const value of [
      { ...address, tenantId: 'wrong', embedding: [0.6, 0.8] },
      { ...address, embedding: [1] },
      { ...address, embedding: [2, 0] },
      { ...address, embedding: ['1', 0] },
      { ...address, embedding: [null, 0] },
    ]) {
      await redis.set(key, JSON.stringify(value));
      expect(await cache.get(address)).toBeNull();
    }
    await redis.set(key, Buffer.from(new Float32Array([0.6, 0.8]).buffer));
    expect(await cache.get(address)).toBeNull();
  });

  it('leaves legacy Float32 keys cold and unchanged', async () => {
    const content = `legacy-${address.tenantId}`;
    const key = `amp:emb:${createHash('sha256').update(content).digest('hex').slice(0, 16)}`;
    keys.add(key);
    const legacy = Buffer.from(new Float32Array([0.6, 0.8]).buffer);
    await redis.set(key, legacy);
    expect(await cache.get(content)).toBeNull();
    await cache.set(content, [1, 0]);
    expect(await redis.getBuffer(key)).toEqual(legacy);
  });
});
