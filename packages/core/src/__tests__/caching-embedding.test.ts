// packages/core/src/__tests__/caching-embedding.test.ts
//
// RED-before-green coverage for the read-through embedding cache (OPT-20 / OPT-65).
// Fully deterministic: the inner provider and the cache are in-memory mocks, so
// no Redis or OpenAI is touched.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CachingEmbeddingProvider, type EmbeddingCachePort } from '../caching-embedding.js';
import type { EmbeddingProvider } from '../types.js';

/** A trivial in-memory EmbeddingCache that records calls via vi.fn spies. */
function makeMemoryCache() {
  const store = new Map<string, number[]>();
  const get = vi.fn(async (content: string): Promise<number[] | null> => store.get(content) ?? null);
  const set = vi.fn(async (content: string, vec: number[]): Promise<void> => {
    store.set(content, vec);
  });
  const cache: EmbeddingCachePort = { get, set };
  return { cache, get, set, store };
}

/** Inner provider whose embed/embedBatch return a deterministic vector per text. */
function makeInnerProvider() {
  // Encode the text length as a 1-element vector so each text maps to a stable vec.
  const embed = vi.fn(async (text: string): Promise<number[]> => [text.length, 1]);
  const embedBatch = vi.fn(async (texts: string[]): Promise<number[][]> => texts.map((t) => [t.length, 1]));
  const inner: EmbeddingProvider = { embed, embedBatch, available: true };
  return { inner, embed, embedBatch };
}

describe('CachingEmbeddingProvider', () => {
  let mem: ReturnType<typeof makeMemoryCache>;
  let prov: ReturnType<typeof makeInnerProvider>;
  let caching: CachingEmbeddingProvider;

  beforeEach(() => {
    mem = makeMemoryCache();
    prov = makeInnerProvider();
    caching = new CachingEmbeddingProvider(prov.inner, mem.cache);
  });

  it('embed(): second identical call is served from cache; inner called ONCE, set ONCE', async () => {
    const first = await caching.embed('hello world');
    const second = await caching.embed('hello world');

    expect(prov.embed).toHaveBeenCalledTimes(1); // miss then HIT — inner not re-called
    expect(mem.set).toHaveBeenCalledTimes(1); // cached on the miss only
    expect(second).toEqual(first); // same vector returned from cache
  });

  it('embedBatch(): only the cache MISSES are sent to inner.embedBatch', async () => {
    // Pre-cache "a" so it is a HIT; "bb" and "ccc" are misses.
    await caching.embed('a');
    prov.embed.mockClear();
    prov.embedBatch.mockClear();

    const out = await caching.embedBatch(['a', 'bb', 'ccc']);

    // inner.embedBatch must be called exactly once, with ONLY the misses.
    expect(prov.embedBatch).toHaveBeenCalledTimes(1);
    expect(prov.embedBatch).toHaveBeenCalledWith(['bb', 'ccc']);
    // Order preserved relative to input, hits spliced back into place.
    expect(out).toEqual([
      [1, 1], // "a" from cache
      [2, 1], // "bb" fetched
      [3, 1], // "ccc" fetched
    ]);
  });

  it('embedBatch(): fully-cached batch never calls inner.embedBatch', async () => {
    await caching.embed('x');
    await caching.embed('yy');
    prov.embedBatch.mockClear();

    const out = await caching.embedBatch(['x', 'yy']);
    expect(prov.embedBatch).not.toHaveBeenCalled();
    expect(out).toEqual([[1, 1], [2, 1]]);
  });

  it('cache.get error falls through to the inner provider (no throw)', async () => {
    mem.get.mockRejectedValueOnce(new Error('redis down'));

    const vec = await caching.embed('resilient');
    expect(vec).toEqual([9, 1]); // 'resilient'.length === 9 — inner used
    expect(prov.embed).toHaveBeenCalledTimes(1);
  });

  it('cache.set error does not break embed (result still returned)', async () => {
    mem.set.mockRejectedValueOnce(new Error('redis write failed'));

    const vec = await caching.embed('still works');
    expect(vec).toEqual(['still works'.length, 1]);
    expect(prov.embed).toHaveBeenCalledTimes(1);
  });

  it('mirrors the inner provider availability flag', () => {
    const degraded = new CachingEmbeddingProvider(
      { embed: async () => [0], embedBatch: async () => [[0]], available: false },
      mem.cache,
    );
    expect(degraded.available).toBe(false);
    expect(caching.available).toBe(true);
  });
});
