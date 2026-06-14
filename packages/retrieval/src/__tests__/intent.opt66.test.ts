// packages/retrieval/src/__tests__/intent.opt66.test.ts
// OPT-66: the intent classifier caches each exemplar's L2 norm alongside its
// vector (instead of recomputing l2Norm(exemplarVec) for all ~29 exemplars on
// every embedding-path query). These tests exercise classifyByEmbedding — the
// path the existing intent.test.ts never reaches — to pin that (a) the cached
// norm yields the correct cosine similarity (output-identical), and (b) the
// exemplar cache (vectors + norms) is built once per provider and reused.
import { describe, it, expect } from 'vitest';
import type { EmbeddingProvider } from '@memberry/core';
import { classifyIntent } from '../intent.js';

// A query that matches NO rule pattern, so classifyIntent falls through to the
// embedding path. (Multi-word, no graph/semantic/identifier keywords.)
const QUERY = 'lorem ipsum dolor sit amet consectetur';

// Deterministic fake provider with NON-uniform magnitudes so the test actually
// depends on the norms being right:
//   - every exemplar embeds to E = [1, 0, 0]   (norm 1)
//   - the query embeds to        Q = [1, 1, 0]   (norm √2)
//   cos(Q, E) = (1·1 + 1·0) / (√2 · 1) = 1/√2 ≈ 0.70710678
// All exemplars tie at that cosine, so the first intent in insertion order
// (GRAPH) wins the strict `>` tie-break — and 0.7071 ≥ GRAPH threshold (0.55).
function makeFakeProvider(): EmbeddingProvider & { embedBatchCalls: number; embedCalls: number } {
  const vecFor = (text: string): number[] => (text === QUERY ? [1, 1, 0] : [1, 0, 0]);
  return {
    available: true,
    embedBatchCalls: 0,
    embedCalls: 0,
    async embed(text: string): Promise<number[]> {
      this.embedCalls++;
      return vecFor(text);
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      this.embedBatchCalls++;
      return texts.map(vecFor);
    },
  };
}

describe('OPT-66: intent classifier exemplar-norm caching', () => {
  it('classifies via the embedding path with the correct cached-norm cosine', async () => {
    const provider = makeFakeProvider();
    const result = await classifyIntent(QUERY, provider);

    expect(result.method).toBe('embedding'); // proves the embedding path ran
    expect(result.intent).toBe('GRAPH'); // first-in-insertion-order tie-break preserved
    // confidence === cos(Q, E) === 1/√2; only correct if BOTH the query norm (√2)
    // and the cached exemplar norm (1) are applied correctly.
    expect(result.confidence).toBeCloseTo(1 / Math.sqrt(2), 10);
  });

  it('builds the exemplar cache (vectors + norms) once and reuses it per provider', async () => {
    const provider = makeFakeProvider();

    await classifyIntent(QUERY, provider);
    const afterFirst = provider.embedBatchCalls;
    expect(afterFirst).toBeGreaterThan(0); // exemplars embedded on first use

    // Second classification with the SAME provider must hit the cache — no
    // further embedBatch calls (and therefore no exemplar re-embedding or
    // norm rebuild).
    await classifyIntent(QUERY, provider);
    expect(provider.embedBatchCalls).toBe(afterFirst);

    // A different provider instance must rebuild its own cache (WeakMap keyed
    // by provider) — guards against a global cache leaking across providers.
    const other = makeFakeProvider();
    await classifyIntent(QUERY, other);
    expect(other.embedBatchCalls).toBe(afterFirst);
  });
});
