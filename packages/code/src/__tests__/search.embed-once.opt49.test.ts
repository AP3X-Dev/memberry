// packages/code/src/__tests__/search.embed-once.opt49.test.ts
//
// OPT-49: CodeSearch.search ran the symbol dense channel (vectorSearch) and the
// semantic dense channel (semanticVectorSearch), each of which embedded the
// query independently — so a single search() embedded the query TWICE. search()
// now embeds it ONCE into a shared promise both channels await.
import { describe, it, expect, vi } from 'vitest';
import type { EmbeddingDescriptor } from '@memberry/core';
import { embeddingDescriptorFingerprint } from '@memberry/core';
import { CodeSearch } from '../search.js';

function makeDriver(): unknown {
  // Every index query returns no records — we only care about embed call count.
  const session = { run: vi.fn(async () => ({ records: [] })), close: vi.fn() };
  return { session: vi.fn(() => session) };
}

describe('OPT-49: CodeSearch embeds the query once per search()', () => {
  it('embeds the query exactly once across the symbol + semantic dense channels', async () => {
    const embed = vi.fn(async () => new Array(1536).fill(0));
    const embedding = {
      embed,
      embedBatch: vi.fn(async (t: string[]) => t.map(() => new Array(1536).fill(0))),
    };
    const search = new CodeSearch(makeDriver() as never, embedding as never, undefined, undefined, { legacyUnqualified: true });

    await search.search('find the auth handler', { include_semantics: true, limit: 10 });

    expect(embed).toHaveBeenCalledTimes(1); // was 2 before OPT-49
    expect(embed).toHaveBeenCalledWith('find the auth handler');
  });

  it('does not embed at all when the provider is unavailable', async () => {
    const embed = vi.fn(async () => new Array(1536).fill(0));
    const embedding = { available: false, embed, embedBatch: vi.fn() };
    const search = new CodeSearch(makeDriver() as never, embedding as never, undefined, undefined, { legacyUnqualified: true });

    await search.search('q', { include_semantics: true });

    expect(embed).not.toHaveBeenCalled();
  });
});


it('shares one scoped embed across dense channels and reuses an externally supplied vector', async () => {
  const embed = vi.fn().mockResolvedValue([0.1, 0.2]);
  const search = new CodeSearch(makeDriver() as never, { embed, embedBatch: vi.fn() }, undefined, undefined, { legacyUnqualified: true });
  await search.search('scoped query', { project_tag: 'project:memberry', include_semantics: true });
  expect(embed).toHaveBeenCalledExactlyOnceWith('scoped query', { tenantId: 'default', projectScope: 'project:memberry' });
  embed.mockClear();
  await search.search('scoped query', { project_tag: 'project:memberry', queryVector: [0.1, 0.2] });
  expect(embed).not.toHaveBeenCalled();
});


const descriptor: EmbeddingDescriptor = {
  schemaVersion: 1, provider: 'fixture', model: 'qualified', revision: '1',
  dimensions: 2, normalization: 'none', preprocessingVersion: '1',
};

function generationFixture(mode: 'ready' | 'missing' | 'throw' = 'ready') {
  const run = vi.fn(async (query: string): Promise<{ records: Array<{ get: (key: string) => unknown }> }> => {
    if (query.includes('symbol_embedding') || query.includes('semantic_embedding') || query.includes('s.embedding')) {
      throw new Error('raw embedding read forbidden');
    }
    return { records: [] };
  });
  const driver = { session: () => ({ run, close: vi.fn() }) };
  const embed = vi.fn().mockResolvedValue([0.1, 0.2]);
  const authority = { evaluateActiveEligibility: vi.fn(async ({ semanticIds }: { semanticIds: readonly string[] }) =>
    semanticIds.map((id) => ({ id, status: 'eligible' as const }))) };
  const generationSearch = vi.fn(async (_scope: unknown, input: { kind: string }) => {
    if (mode === 'throw') throw new Error('generation unavailable');
    if (mode === 'missing') return { generationId: null, results: [], degradedReason: 'embedding_generation_unavailable' };
    const properties = input.kind === 'symbol'
      ? { id: 'symbol-1', name: 'qualifiedSymbol', kind: 'function', language: 'typescript', file_path: 'src/qualified.ts', start_line: 1, project_tag: 'project:memberry' }
      : { id: 'semantic-1', content: 'Qualified semantic' };
    return { generationId: 'qualified-generation', results: [{ id: properties.id, properties, score: 0.9 }] };
  });
  const provider = { descriptor, embed, embedBatch: vi.fn() };
  const search = new CodeSearch(driver as never, provider, undefined, authority, {
    descriptor, store: { search: generationSearch },
  });
  return { search, run, embed, generationSearch, authority, driver, provider };
}

describe('qualified generation code search', () => {
  it('uses the same scoped query vector in both qualified channels without raw reads', async () => {
    const f = generationFixture();
    const result = await f.search.searchObserved('qualified query', { project_tag: 'project:memberry', include_semantics: true });
    expect(f.embed).toHaveBeenCalledExactlyOnceWith('qualified query', { tenantId: 'default', projectScope: 'project:memberry' });
    expect(f.generationSearch).toHaveBeenCalledTimes(2);
    for (const [scope, request] of f.generationSearch.mock.calls) {
      expect(scope).toEqual({ tenantId: 'default', projectScope: 'project:memberry' });
      expect(request).toEqual(expect.objectContaining({ descriptorFingerprint: embeddingDescriptorFingerprint(descriptor), vector: [0.1, 0.2] }));
    }
    expect(result.value.map((row) => row.id)).toEqual(expect.arrayContaining(['symbol-1', 'semantic-1']));
    expect(f.authority.evaluateActiveEligibility).toHaveBeenCalled();
    expect(f.run.mock.calls.every(([query]) => !query.includes('symbol_embedding') && !query.includes('semantic_embedding') && !query.includes('s.embedding'))).toBe(true);
  });

  it.each(['missing', 'throw'] as const)('degrades %s generation without reading raw vectors', async (mode) => {
    const f = generationFixture(mode);
    f.run.mockImplementation(async (query: string) => ({ records: query.includes('symbol_search')
      ? [{ get: (key: string) => key === 's' ? { properties: {
        id: 'lexical-survivor', name: 'lexicalSurvivor', kind: 'function', file_path: 'src/lexical.ts',
        start_line: 1, project_tag: 'project:memberry',
      } } : 0.8 }]
      : [] }));
    const result = await f.search.searchObserved('qualified query', { project_tag: 'project:memberry' });
    expect(result.value.map((row) => row.id)).toEqual(['lexical-survivor']);
    expect(result.observation.channels).toEqual(expect.arrayContaining([
      expect.objectContaining({ channel: 'code.dense-vector', outcome: 'safe-failure' }),
      expect.objectContaining({ channel: 'code.semantic-vector', outcome: 'safe-failure' }),
    ]));
    expect(f.run.mock.calls.every(([query]) => !query.includes('symbol_embedding') && !query.includes('semantic_embedding') && !query.includes('s.embedding'))).toBe(true);
  });

  it('requires a generation context and concrete project scope before embedding', async () => {
    const f = generationFixture();
    const bare = new CodeSearch(f.driver as never, { embed: f.embed, embedBatch: vi.fn() });
    await bare.search('without context', { project_tag: 'project:memberry' });
    await f.search.search('without scope');
    expect(f.embed).not.toHaveBeenCalled();
    expect(f.generationSearch).not.toHaveBeenCalled();
  });

  it('does not substitute current semantic projections for historical requests', async () => {
    const f = generationFixture();
    await f.search.search('historical', { project_tag: 'project:memberry', as_of: '2025-01-01T00:00:00.000Z' });
    expect(f.generationSearch.mock.calls.map(([, input]) => input.kind)).toEqual(['symbol']);
    expect(f.search.generationStatus.semantic).toBe('embedding_generation_historical_unavailable');
  });

  it('rejects a wrong-dimension shared query vector before the generation store', async () => {
    const f = generationFixture();
    await f.search.search('invalid vector', { project_tag: 'project:memberry', queryVector: [0.1], queryDescriptorFingerprint: embeddingDescriptorFingerprint(descriptor) });
    expect(f.embed).not.toHaveBeenCalled();
    expect(f.generationSearch).not.toHaveBeenCalled();
  });
});


it('reuses only descriptor-matched shared vectors and recomputes unknown or wrong spaces', async () => {
  const f = generationFixture();
  for (const fingerprint of [undefined, 'a'.repeat(64)]) {
    await f.search.search('foreign shared vector', { project_tag: 'project:memberry', queryVector: [0.9, 0.8], queryDescriptorFingerprint: fingerprint });
    expect(f.generationSearch).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ vector: [0.1, 0.2] }));
  }
  expect(f.embed).toHaveBeenCalledTimes(2);
  f.embed.mockClear();
  await f.search.search('compatible shared vector', { project_tag: 'project:memberry', queryVector: [0.9, 0.8], queryDescriptorFingerprint: embeddingDescriptorFingerprint(descriptor) });
  expect(f.embed).not.toHaveBeenCalled();
  expect(f.generationSearch).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ vector: [0.9, 0.8] }));
});

it('disables dense reads if its provider descriptor drifts from generation context', async () => {
  const f = generationFixture();
  f.provider.descriptor = { ...descriptor, revision: 'other-revision' };
  await f.search.search('provider changed', { project_tag: 'project:memberry', queryVector: [0.1, 0.2], queryDescriptorFingerprint: embeddingDescriptorFingerprint(descriptor) });
  expect(f.embed).not.toHaveBeenCalled();
  expect(f.generationSearch).not.toHaveBeenCalled();
});
