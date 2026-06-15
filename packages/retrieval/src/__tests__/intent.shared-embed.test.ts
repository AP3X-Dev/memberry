// packages/retrieval/src/__tests__/intent.shared-embed.test.ts
// Shared query embedding: berry_context embeds the task string ONCE and shares the
// vector across intent classification, code search, and memory load. classifyIntent
// accepts an optional getQueryVec thunk and, when provided, uses that vector instead
// of issuing its own embed() — output-identical (deterministic embedding for a fixed
// model + input), one fewer embedding-API round-trip on the hot path.
import { describe, it, expect, vi } from 'vitest';
import type { EmbeddingProvider } from '@memberry/core';
import { classifyIntent } from '../intent.js';

// A query that matches NO rule pattern, so classifyIntent falls through to the
// embedding path (mirrors intent.opt66.test.ts).
const QUERY = 'lorem ipsum dolor sit amet consectetur';

function makeFakeProvider(): EmbeddingProvider & { embedCalls: number; embedBatchCalls: number } {
  const vecFor = (text: string): number[] => (text === QUERY ? [1, 1, 0] : [1, 0, 0]);
  return {
    available: true,
    embedCalls: 0,
    embedBatchCalls: 0,
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

describe('classifyIntent — shared query embedding', () => {
  it('reuses a provided shared query vector instead of re-embedding the query', async () => {
    const provider = makeFakeProvider();
    // The same vector provider.embed(QUERY) would have produced — so the cosine
    // result (and intent) is byte-identical to the un-shared path.
    const sharedVec = [1, 1, 0];
    const getQueryVec = vi.fn().mockResolvedValue(sharedVec);

    const result = await classifyIntent(QUERY, provider, getQueryVec);

    // Same classification as without sharing (proves the vector was used correctly).
    expect(result.method).toBe('embedding');
    expect(result.confidence).toBeCloseTo(1 / Math.sqrt(2), 10);
    // The shared vector was consumed…
    expect(getQueryVec).toHaveBeenCalledTimes(1);
    // …and the query was NOT embedded again (embedBatch still builds the exemplar cache).
    expect(provider.embedCalls).toBe(0);
  });

  it('falls back to embedding the query itself when no shared vector is provided', async () => {
    const provider = makeFakeProvider();

    const result = await classifyIntent(QUERY, provider);

    expect(result.method).toBe('embedding');
    // No thunk → classifier embeds the query exactly once (current behaviour preserved).
    expect(provider.embedCalls).toBe(1);
  });

  it('falls back to its own embed when the shared thunk resolves undefined', async () => {
    const provider = makeFakeProvider();
    const getQueryVec = vi.fn().mockResolvedValue(undefined);

    const result = await classifyIntent(QUERY, provider, getQueryVec);

    expect(result.method).toBe('embedding');
    expect(getQueryVec).toHaveBeenCalledTimes(1);
    expect(provider.embedCalls).toBe(1); // thunk gave nothing → embed the query
  });
});
