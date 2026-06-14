// packages/core/src/caching-embedding.ts
//
// A read-through caching decorator for any EmbeddingProvider.
//
// Retrieval, code-search and intent-classification hot paths embed the SAME
// query strings over and over. Without a cache, every identical query re-hits
// the OpenAI embeddings API (latency + $). A Redis-backed EmbeddingCache already
// exists (@memberry/redis EmbeddingCache); this wrapper finally wires it in
// front of the raw provider so repeated queries are served from cache.
//
// CORRECTNESS > CACHE: the cache is a pure optimization. A cache get/set failure
// MUST NOT break embedding — on any cache error we log and fall through to the
// inner provider. The wrapper also preserves input ordering for embedBatch.

import type { EmbeddingProvider } from './types.js';

/**
 * Minimal cache port the wrapper needs. Matches @memberry/redis EmbeddingCache
 * (get(content) -> vec|null, set(content, vec, ttl?)). Declared structurally so
 * tests can inject a trivial mock without a real Redis client.
 */
export interface EmbeddingCachePort {
  get(content: string): Promise<number[] | null>;
  set(content: string, embedding: number[], ttl?: number): Promise<void>;
}

export class CachingEmbeddingProvider implements EmbeddingProvider {
  /** Mirror the inner provider so degraded (no-key) providers stay degraded. */
  readonly available?: boolean;

  constructor(
    private readonly inner: EmbeddingProvider,
    private readonly cache: EmbeddingCachePort,
  ) {
    this.available = inner.available;
  }

  /**
   * Read-through single embed: cache hit returns immediately; on miss the inner
   * provider is called and the result is cached. Cache errors never propagate —
   * they degrade to a direct inner call.
   */
  async embed(text: string): Promise<number[]> {
    try {
      const hit = await this.cache.get(text);
      if (hit) return hit;
    } catch (err: unknown) {
      // Cache read failed — log and treat as a miss. Embedding still works.
      console.error(`[caching-embedding] cache get failed, bypassing cache: ${errMsg(err)}`);
    }

    const vec = await this.inner.embed(text);

    try {
      await this.cache.set(text, vec);
    } catch (err: unknown) {
      // Cache write failed — the embedding is already computed; just log.
      console.error(`[caching-embedding] cache set failed, result not cached: ${errMsg(err)}`);
    }

    return vec;
  }

  /**
   * Read-through batch embed. Only the cache MISSES are sent to the inner
   * provider's embedBatch; cached entries are spliced back into their original
   * positions so the returned array matches the input order exactly.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: (number[] | undefined)[] = new Array(texts.length);
    const missIndices: number[] = [];
    const missTexts: string[] = [];

    // Probe the cache for each input, recording which positions miss.
    for (let i = 0; i < texts.length; i++) {
      let hit: number[] | null = null;
      try {
        hit = await this.cache.get(texts[i]);
      } catch (err: unknown) {
        // Treat a cache error as a miss for this entry.
        console.error(`[caching-embedding] batch cache get failed for index ${i}, treating as miss: ${errMsg(err)}`);
        hit = null;
      }
      if (hit) {
        results[i] = hit;
      } else {
        missIndices.push(i);
        missTexts.push(texts[i]);
      }
    }

    // Fetch only the misses (preserving their relative order), then place each
    // result back at its original input index.
    if (missTexts.length > 0) {
      const fetched = await this.inner.embedBatch(missTexts);
      for (let j = 0; j < missIndices.length; j++) {
        const vec = fetched[j];
        results[missIndices[j]] = vec;
        try {
          await this.cache.set(missTexts[j], vec);
        } catch (err: unknown) {
          console.error(`[caching-embedding] batch cache set failed for "${missTexts[j].slice(0, 32)}…": ${errMsg(err)}`);
        }
      }
    }

    // Every slot is now filled (hits + freshly fetched misses), in input order.
    return results as number[][];
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
