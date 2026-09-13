import { describe, it, expect, vi } from 'vitest';
import { embeddingDescriptorFingerprint } from '@memberry/core';
import { ScopedQuery } from '../query.js';

const descriptor = { schemaVersion: 1 as const, provider: 'fixture', model: 'model-a', revision: 'r1', dimensions: 2, normalization: 'l2' as const, preprocessingVersion: 'v1' };
function fixture(response: unknown) {
  const session = vi.fn();
  const search = vi.fn().mockResolvedValue(response);
  const query = new ScopedQuery({ session } as never, { descriptor, store: { search } as never });
  return { query, search, session };
}

describe('ScopedQuery compatible generation serving', () => {
  it.each([undefined, embeddingDescriptorFingerprint({ ...descriptor, model: 'other-model' })])('rejects unknown or foreign query vector identity %s', async fingerprint => {
    const { query, search, session } = fixture({ generationId: 'g1', results: [] });
    expect(await query.byVector([1, 0], 10, 'tenant-a', 'project:a', fingerprint)).toEqual([]);
    expect(await query.byVectorEpisodic([1, 0], 10, 'tenant-a', 'project:a', fingerprint)).toEqual([]);
    expect(query.generationStatus).toBe('embedding_query_descriptor_mismatch');
    expect(search).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
  });
  it('a stale legacy flag cannot override supplied generation authority', async () => {
    const session = vi.fn();
    const search = vi.fn().mockResolvedValue({ generationId: null, results: [] });
    const query = new ScopedQuery({ session } as never, {
      descriptor, store: { search } as never, legacyUnqualified: true,
    } as never);
    expect(await query.byVector([1, 0], 10, undefined, undefined, embeddingDescriptorFingerprint(descriptor))).toEqual([]);
    expect(search).toHaveBeenCalledOnce();
    expect(session).not.toHaveBeenCalled();
  });
  it('binds semantic dense reads to descriptor, tenant and project', async () => {
    const { query, search, session } = fixture({ generationId: 'g1', results: [{ id: 's1', score: 0.8, properties: { id: 's1', content: 'current', signal_count: 1, tags: [] } }] });
    expect(await query.byVector([1, 0], 10, 'tenant-a', 'project:a', embeddingDescriptorFingerprint(descriptor))).toMatchObject([{ id: 's1', score: 0.8 }]);
    expect(search).toHaveBeenCalledWith({ tenantId: 'tenant-a', projectScope: 'project:a' }, { descriptorFingerprint: embeddingDescriptorFingerprint(descriptor), vector: [1, 0], kind: 'semantic', limit: 10 });
    expect(session).not.toHaveBeenCalled();
    expect(query.generationStatus).toBe('ready');
  });
  it('preserves episodic scope metadata', async () => {
    const { query, search, session } = fixture({ generationId: 'g1', results: [{ id: 'e1', score: 0.9, properties: { id: 'e1', content: 'episode', scope: 'project:a', tags: ['project:a'], tenant_id: 'tenant-a' } }] });
    expect(await query.byVectorEpisodic([1, 0], 10, 'tenant-a', 'project:a', embeddingDescriptorFingerprint(descriptor))).toMatchObject([{ id: 'e1', score: 0.9, scope: 'project:a', tenant_id: 'tenant-a', tags: ['project:a'] }]);
    expect(search.mock.calls[0][1].kind).toBe('episodic');
    expect(session).not.toHaveBeenCalled();
  });
  it.each(['byVector', 'byVectorEpisodic'] as const)('never falls back to canonical raw vectors on missing generation or outage: %s', async method => {
    const { query, search, session } = fixture({ generationId: null, results: [], degradedReason: 'embedding_generation_unavailable' });
    expect(await query[method]([1, 0], 10, undefined, undefined, embeddingDescriptorFingerprint(descriptor))).toEqual([]);
    expect(query.generationStatus).toBe('embedding_generation_unavailable');
    search.mockRejectedValueOnce(new Error('offline'));
    expect(await query[method]([1, 0], 10, undefined, undefined, embeddingDescriptorFingerprint(descriptor))).toEqual([]);
    expect(session).not.toHaveBeenCalled();
  });
  it('fails malformed query vectors before cache/index IO', async () => {
    const { query, search, session } = fixture({ generationId: 'g1', results: [] });
    expect(await query.byVector([2, 0], 10, undefined, undefined, embeddingDescriptorFingerprint(descriptor))).toEqual([]);
    expect(search).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
  });
  it('defaults to unavailable and requires explicit unqualified legacy opt-in', async () => {
    const session = vi.fn();
    const query = new ScopedQuery({ session } as never);
    expect(query.generationStatus).toBe('embedding_generation_unavailable');
    expect(await query.byVector([1, 0], 10, undefined, undefined, embeddingDescriptorFingerprint(descriptor))).toEqual([]);
    expect(await query.byVectorEpisodic([1, 0], 10, undefined, undefined, embeddingDescriptorFingerprint(descriptor))).toEqual([]);
    expect(session).not.toHaveBeenCalled();
    expect(new ScopedQuery({} as never, { legacyUnqualified: true }).generationStatus).toBe('unqualified-legacy');
  });
});
