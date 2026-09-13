import { createHash } from 'crypto';
import type { Redis } from 'ioredis';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EmbeddingCache, type EmbeddingCacheAddress } from '../embeddings.js';

const address: EmbeddingCacheAddress = {
  schemaVersion: 2,
  tenantId: 'tenant-a',
  projectScope: 'project:alpha',
  descriptorFingerprint: 'a'.repeat(64),
  contentHash: 'b'.repeat(64),
  dimensions: 2,
  normalization: 'none',
};
const vector = [0.123456789012345, -0.987654321098765];

describe('EmbeddingCache v2', () => {
  const entries = new Map<string, string>();
  const redis = {
    get: vi.fn(async (key: string) => entries.get(key) ?? null),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      entries.set(key, value);
      return 'OK';
    }),
  };
  const cache = new EmbeddingCache(redis as unknown as Redis);
  beforeEach(() => {
    entries.clear();
    vi.clearAllMocks();
  });

  it('round trips double precision with full hashes and default TTL', async () => {
    expect(await cache.get(address)).toBeNull();
    await cache.set(address, vector);
    expect(await cache.get(address)).toEqual(vector);
    const scope = createHash('sha256')
      .update(JSON.stringify([address.tenantId, address.projectScope]))
      .digest('hex');
    expect(redis.setex).toHaveBeenCalledWith(
      `amp:emb:v2:${scope}:${address.descriptorFingerprint}:${address.contentHash}`,
      86400,
      JSON.stringify({ ...address, embedding: vector }),
    );
  });

  it.each([
    { tenantId: 'tenant-b' },
    { projectScope: 'project:beta' },
    { projectScope: null },
    { descriptorFingerprint: 'c'.repeat(64) },
    { contentHash: 'd'.repeat(64) },
  ])('isolates cache identity %j at the same dimensions', async (change) => {
    await cache.set(address, vector);
    expect(await cache.get({ ...address, ...change })).toBeNull();
    await cache.set({ ...address, ...change }, [1, 2]);
    expect(entries.size).toBe(2);
    expect(await cache.get(address)).toEqual(vector);
  });

  it('preserves custom TTL', async () => {
    await cache.set(address, vector, 60);
    expect(redis.setex.mock.calls[0][1]).toBe(60);
  });

  it('never reads or writes legacy content-only keys', async () => {
    entries.set('amp:emb:legacy', Buffer.from(new Float32Array(vector).buffer).toString());
    expect(await cache.get('legacy')).toBeNull();
    await cache.set('legacy', vector);
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.setex).not.toHaveBeenCalled();
    expect(await cache.get(address)).toBeNull();
  });

  it.each([
    null,
    {},
    { schemaVersion: 1 },
    { tenantId: '' },
    { tenantId: ' x' },
    { tenantId: '*' },
    { tenantId: 'x\n' },
    { tenantId: 'x'.repeat(513) },
    { projectScope: undefined },
    { projectScope: 'project:' },
    { projectScope: 'alpha' },
    { projectScope: 'project:*' },
    { projectScope: 'project:x y' },
    { projectScope: 'project:x\u0085' },
    { descriptorFingerprint: 'A'.repeat(64) },
    { descriptorFingerprint: 'a'.repeat(16) },
    { contentHash: 'z'.repeat(64) },
    { dimensions: 0 },
    { dimensions: 65537 },
    { dimensions: 2.5 },
    { normalization: 'unit' },
  ])('rejects malformed explicit address before IO %j', async (change) => {
    const invalid = (change === null
      ? null
      : {
          ...address,
          ...change,
          ...(Object.keys(change).length === 0 ? { tenantId: undefined } : {}),
        }) as unknown as EmbeddingCacheAddress;
    await expect(cache.get(invalid)).rejects.toThrow('address');
    await expect(cache.set(invalid, vector)).rejects.toThrow('address');
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.setex).not.toHaveBeenCalled();
  });

  it.each([
    { schemaVersion: 1 },
    { tenantId: 'other' },
    { projectScope: null },
    { descriptorFingerprint: 'c'.repeat(64) },
    { contentHash: 'd'.repeat(64) },
    { dimensions: 3 },
    { normalization: 'l2' },
    { embedding: [1] },
    { embedding: ['1', 2] },
    { embedding: [null, 2] },
    { embedding: {} },
  ])('treats mismatched or corrupt envelope as miss %j', async (change) => {
    await cache.set(address, vector);
    const key = [...entries.keys()][0];
    entries.set(key, JSON.stringify({ ...address, embedding: vector, ...change }));
    expect(await cache.get(address)).toBeNull();
  });

  it.each(['invalid JSON', 'null', '[]', '{}', '1', '{"embedding":[1e999,2]}'])(
    'treats malformed serialization as miss %s',
    async (corrupt) => {
      await cache.set(address, vector);
      entries.set([...entries.keys()][0], corrupt);
      expect(await cache.get(address)).toBeNull();
    },
  );

  it.each([[1], [NaN, 1], [Infinity, 1], ['1', 2], new Array(2)])(
    'rejects invalid write vector %j',
    async (invalid) => {
      await expect(cache.set(address, invalid as number[])).rejects.toThrow('vector');
      expect(redis.setex).not.toHaveBeenCalled();
    },
  );

  it('validates normalization on both reads and writes', async () => {
    const normalized = { ...address, normalization: 'l2' as const };
    await cache.set(normalized, [0.6, 0.8]);
    expect(await cache.get(normalized)).toEqual([0.6, 0.8]);
    await expect(cache.set(normalized, [0, 0])).rejects.toThrow('vector');
    await expect(cache.set(normalized, [1.00002, 0])).rejects.toThrow('vector');
    const key = [...entries.keys()][0];
    entries.set(key, JSON.stringify({ ...normalized, embedding: [2, 0] }));
    expect(await cache.get(normalized)).toBeNull();
  });

  it('supports large vectors without Float32 rounding', async () => {
    const large = Array.from({ length: 1536 }, (_, i) => Math.sin(i));
    await cache.set({ ...address, dimensions: 1536 }, large);
    expect(await cache.get({ ...address, dimensions: 1536 })).toEqual(large);
  });

  it.each([0, -1, 1.5, Infinity])('rejects invalid TTL %s', async (ttl) => {
    await expect(cache.set(address, vector, ttl)).rejects.toThrow('TTL');
    expect(redis.setex).not.toHaveBeenCalled();
  });

  it('propagates cache IO failures', async () => {
    redis.get.mockRejectedValueOnce(new Error('offline'));
    await expect(cache.get(address)).rejects.toThrow('offline');
    redis.setex.mockRejectedValueOnce(new Error('offline'));
    await expect(cache.set(address, vector)).rejects.toThrow('offline');
  });
});
