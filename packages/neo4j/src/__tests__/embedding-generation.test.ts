import { describe, expect, it, vi } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';
import { embeddingDescriptorFingerprint, type EmbeddingDescriptor } from '@memberry/core';
import { EmbeddingGenerationStore, generationIndexName, generationActivePointerMatch, generationProjectionMatch, generationReadParameters, evaluateGenerationReplayRow, generationIndexCompatible } from '../embedding-generation.js';

const descriptor: EmbeddingDescriptor = { schemaVersion: 1, provider: 'fixture', model: 'space-a', revision: 'fixture-v1',
  dimensions: 3, normalization: 'l2', preprocessingVersion: 'raw-v1' };
const scope = { tenantId: 'tenant-a', projectScope: 'project:a' };
const id = 'a'.repeat(32);

describe('embedding generation boundary', () => {
  it('accepts Neo4j normalized cosine metadata and rejects incompatible index configuration', () => {
    const metadata = { name: 'index', state: 'ONLINE', type: 'VECTOR', labelsOrTypes: ['index'], properties: ['vector'],
      options: { indexConfig: { 'vector.dimensions': neo4j.int(3), 'vector.similarity_function': 'COSINE' } } };
    expect(generationIndexCompatible(metadata, 'index', descriptor)).toBe(true);
    expect(generationIndexCompatible({ ...metadata, state: 'POPULATING' }, 'index', descriptor)).toBe(false);
    expect(generationIndexCompatible(metadata, 'other-index', descriptor)).toBe(false);
    expect(generationIndexCompatible(metadata, 'index', { ...descriptor, dimensions: 4 })).toBe(false);
    expect(generationIndexCompatible({ ...metadata, options: { indexConfig: { 'vector.dimensions': 3, 'vector.similarity_function': 'euclidean' } } }, 'index', descriptor)).toBe(false);
  });
  it('rejects a replay rank regression even when all expected sources are found', () => {
    const degraded = evaluateGenerationReplayRow('rank', ['correct'], ['distractor', 'correct'], ['correct', 'distractor']);
    expect(degraded).toMatchObject({ candidateRecall: 1, baselineRecall: 1, candidateReciprocalRank: 0.5, baselineReciprocalRank: 1, passed: false });
    expect(evaluateGenerationReplayRow('equal', ['correct'], ['correct'], ['correct']).passed).toBe(true);
    expect(evaluateGenerationReplayRow('missing', ['correct', 'qualifier'], ['correct'], ['correct']).passed).toBe(false);
    expect(evaluateGenerationReplayRow('gain', ['correct'], ['correct'], []).passed).toBe(true);
  });
  it('never permits user-selected schema identifiers', () => {
    expect(generationIndexName(id, 'episodic-index-key')).toBe(`eg_${id}_episodic_index_key`);
    expect(() => generationIndexName('x) MATCH (n) DELETE n', 'semantic')).toThrow('invalid_id');
    expect(() => generationProjectionMatch('semantic', 's) DELETE n', 'v')).toThrow('invalid_alias');
    expect(() => generationProjectionMatch('unknown' as 'semantic', 's', 'v')).toThrow('invalid_source_kind');
  });

  it('binds tenant, project, descriptor and generation separately', () => {
    const fingerprint = embeddingDescriptorFingerprint(descriptor);
    const a = generationReadParameters(scope, fingerprint, id);
    expect(a.embeddingScopeKey).not.toBe(generationReadParameters({ ...scope, tenantId: 'tenant-b' }, fingerprint, id).embeddingScopeKey);
    expect(a.embeddingScopeKey).not.toBe(generationReadParameters({ ...scope, projectScope: null }, fingerprint, id).embeddingScopeKey);
    expect(a.embeddingDescriptorFingerprint).toBe(fingerprint);
    expect(a.embeddingGenerationId).toBe(id);
    expect(() => generationReadParameters({ ...scope, projectScope: 'project:*' }, fingerprint, id)).toThrow();
    expect(() => generationReadParameters(scope, 'shape-only', id)).toThrow('invalid_fingerprint');
  });

  it('checks active pointer once per query and canonical input in each projection join', () => {
    const guard = generationActivePointerMatch();
    expect(guard).toContain('pointer.activeId = $embeddingGenerationId');
    expect(guard).toContain("generation.state = 'active'");
    expect(guard).toContain('generation.descriptorFingerprint = $embeddingDescriptorFingerprint');
    expect(guard).toContain('generation.qualificationDigest IS NOT NULL');
    expect(guard).not.toContain('EXISTS');
    const query = generationProjectionMatch('semantic', 's', 'projection');
    expect(query).toContain('projection.inputText = s.content');
    expect(query).toContain('projection.generationId = $embeddingGenerationId');
    expect(query).not.toContain('EmbeddingGenerationPointer');
    expect(query).not.toContain('qualificationDigest');
    expect(query).not.toContain('s.embedding');
    const keys = generationProjectionMatch('episodic-index-key', 'key', 'keyVector', 'episode');
    expect(keys).toContain('keyVector.dependencyText = episode.content');
    expect(keys).toContain('key.source_hash = keyVector.keySourceHash');
    expect(() => generationProjectionMatch('episodic-index-key', 'key', 'vector')).toThrow('parent_alias_required');
  });

  it.each(['unversioned-provider-alias', 'alias:model', 'unknown'])('rejects unpinned revision %s before database allocation', async revision => {
    const session = vi.fn();
    const store = new EmbeddingGenerationStore({ session } as unknown as Driver);
    await expect(store.create(scope, { ...descriptor, revision }, { revisionBindingEvidence: 'cannot pin an alias' })).rejects.toThrow('revision_binding_required');
    expect(session).not.toHaveBeenCalled();
  });

  it('bounds batches, vectors and observation windows before work', async () => {
    const session = vi.fn();
    const store = new EmbeddingGenerationStore({ session } as unknown as Driver);
    await expect(store.create(scope, descriptor, { revisionBindingEvidence: 'fixture', observationWindowMs: 0 })).rejects.toThrow('invalid_observation_window');
    await expect(store.backfill(scope, id, { embed: vi.fn(), embedBatch: vi.fn() }, { batchSize: 101 })).rejects.toThrow('invalid_limit');
    await expect(store.search(scope, { descriptorFingerprint: 'a'.repeat(64), vector: [1, 0, 0], kind: 'semantic', limit: 101 })).rejects.toThrow('invalid_limit');
    await expect(store.vectors(scope, { descriptorFingerprint: 'a'.repeat(64), kind: 'semantic', sourceIds: Array(101).fill('x') })).rejects.toThrow('source_limit_exceeded');
    expect(session).not.toHaveBeenCalled();
  });

  it('reports lexical/scoped degradation without touching a legacy index', async () => {
    const run = vi.fn().mockResolvedValue({ records: [] }); const close = vi.fn();
    const executeRead = vi.fn(async work => work({ run }));
    const store = new EmbeddingGenerationStore({ session: () => ({ executeRead, close }) } as unknown as Driver);
    await expect(store.search(scope, { descriptorFingerprint: embeddingDescriptorFingerprint(descriptor), vector: [1, 0, 0], kind: 'semantic' }))
      .resolves.toEqual({ generationId: null, results: [], degradedReason: 'embedding_generation_unavailable' });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![0]).toContain('EmbeddingGenerationPointer');
    expect(run.mock.calls[0]![0]).not.toContain('semantic_embedding');
    expect(executeRead.mock.calls[0]![1]).toEqual({ timeout: 5_000 });
    expect(close).toHaveBeenCalledOnce();
  });
});
