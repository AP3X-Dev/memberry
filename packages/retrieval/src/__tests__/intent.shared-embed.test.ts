// packages/retrieval/src/__tests__/intent.shared-embed.test.ts
// Shared query embedding: berry_context embeds the task string ONCE and shares the
// vector across intent classification, code search, and memory load. classifyIntent
// accepts an optional getQueryVec thunk and, when provided, uses that vector instead
// of issuing its own embed() — output-identical (deterministic embedding for a fixed
// model + input), one fewer embedding-API round-trip on the hot path.
import { describe, it, expect, vi } from 'vitest';
import { embeddingDescriptorFingerprint } from '@memberry/core';
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


it('forwards request authority to query fallback while leaving static exemplars uncached', async () => {
  const provider = makeFakeProvider();
  const embed = vi.spyOn(provider, 'embed');
  const batch = vi.spyOn(provider, 'embedBatch');
  const request = { tenantId: 'tenant-a', projectScope: 'project:memberry' };
  await classifyIntent(QUERY, provider, undefined, request);
  expect(embed).toHaveBeenCalledExactlyOnceWith(QUERY, request);
  expect(batch.mock.calls.length).toBeGreaterThan(0);
  expect(batch.mock.calls.every((args) => args.length === 1)).toBe(true);
});


it('rebuilds static exemplars when an injected provider descriptor changes', async () => {
  const provider = Object.assign(makeFakeProvider(), { descriptor: {
    schemaVersion: 1 as const, provider: 'fixture', model: 'intent', revision: 'first',
    dimensions: 3, normalization: 'none' as const, preprocessingVersion: '1',
  } });
  await classifyIntent(QUERY, provider);
  const initialBatches = provider.embedBatchCalls;
  await classifyIntent(QUERY, provider);
  expect(provider.embedBatchCalls).toBe(initialBatches);
  provider.descriptor = { ...provider.descriptor, revision: 'second' };
  await classifyIntent(QUERY, provider);
  expect(provider.embedBatchCalls).toBe(initialBatches * 2);
});

it('does not publish mixed-space exemplars when a provider changes during a batch', async () => {
  const provider = Object.assign(makeFakeProvider(), { descriptor: {
    schemaVersion: 1 as const, provider: 'fixture', model: 'intent', revision: 'first',
    dimensions: 3, normalization: 'none' as const, preprocessingVersion: '1',
  } });
  const original = provider.embedBatch.bind(provider);
  provider.embedBatch = async (texts) => {
    const values = await original(texts);
    provider.descriptor = { ...provider.descriptor, revision: 'second' };
    return values;
  };
  const result = await classifyIntent(QUERY, provider);
  expect(result.method).toBe('fallback');
  expect(provider.embedCalls).toBe(0);
});


it('does not compare unknown shared-vector space against qualified exemplars', async () => {
  const provider = Object.assign(makeFakeProvider(), { descriptor: {
    schemaVersion: 1 as const, provider: 'fixture', model: 'intent', revision: '1',
    dimensions: 3, normalization: 'none' as const, preprocessingVersion: '1',
  } });
  const shared = vi.fn().mockResolvedValue([1, 1, 0]);
  await classifyIntent(QUERY, provider, shared);
  expect(shared).not.toHaveBeenCalled();
  expect(provider.embedCalls).toBe(1);
  await classifyIntent(QUERY, provider, shared, undefined, embeddingDescriptorFingerprint(provider.descriptor));
  expect(shared).toHaveBeenCalledTimes(1);
  expect(provider.embedCalls).toBe(1);
});
