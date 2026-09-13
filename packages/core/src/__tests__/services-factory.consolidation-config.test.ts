import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCoreServices } from '../services-factory.js';
import { defaultEmbeddingDescriptor } from '../embedding.js';

const managedEnv = [
  'MEMBERRY_CONSOLIDATION_AUTO_APPLY',
  'MEMBERRY_READONLY',
  'MEMBERRY_REDACT_ON_INGEST',
  'MEMBERRY_ADMISSION_SHADOW_ENABLED',
  'MEMBERRY_ADMISSION_SHADOW_TIMEOUT_MS',
  'NEO4J_URI',
  'NEO4J_USER',
  'REDIS_URL',
  'MEMBERRY_EMBEDDING_DESCRIPTOR',
] as const;
const originalEnv = Object.fromEntries(managedEnv.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of managedEnv) {
    const original = originalEnv[name];
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});
describe('createCoreServices consolidation policy config', () => {
  it('binds generation serving even when the provider is disabled', async () => {
    const descriptor = { ...defaultEmbeddingDescriptor(), dimensions: 3 };
    const core = createCoreServices({ openaiKey: '', embeddingDescriptor: descriptor });
    try {
      expect(core.embedding.available).toBe(false);
      expect(await core.embedding.embed('fixture')).toEqual([0, 0, 0]);
      expect(core.embeddingDescriptor).toEqual(descriptor);
      expect(core.scopedQuery.generationStatus).toBe('not-read');
      expect(core.consolidationGeneration.descriptor).toEqual(descriptor);
    } finally { await core.close(); }
  });

  it('rejects malformed or unsupported descriptor configuration before construction', () => {
    process.env.MEMBERRY_EMBEDDING_DESCRIPTOR = '{"dimensions":3}';
    expect(() => createCoreServices()).toThrow('embedding_descriptor:invalid');
    expect(() => createCoreServices({ embeddingDescriptor: { ...defaultEmbeddingDescriptor(), provider: 'other' } }))
      .toThrow('embedding_provider:unsupported');
  });

  it('discards consolidation vectors when the active generation changes between bounded batches', async () => {
    const core = createCoreServices({ openaiKey: '' });
    try {
      const spy = vi.spyOn(core.embeddingGenerations, 'vectors')
        .mockResolvedValueOnce({ generationId: 'a', rows: [{ id: 'episode-0', vector: [1], inputText: '', dependencyText: '' }] })
        .mockResolvedValueOnce({ generationId: 'b', rows: [] });
      const result = await core.consolidationGeneration.readEpisodeVectors({ tenantId: 'default', projectScope: 'project:a',
        sourceIds: Array.from({ length: 101 }, (_, i) => `episode-${i}`) });
      expect(result.status).toBe('embedding_generation_unavailable');
      expect(result.vectors.size).toBe(0);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls[0]?.[1].sourceIds).toHaveLength(100);
    } finally { await core.close(); }
  });
  it('keeps admission observation default-off with a 50ms bound', async () => {
    delete process.env.MEMBERRY_ADMISSION_SHADOW_ENABLED;
    delete process.env.MEMBERRY_ADMISSION_SHADOW_TIMEOUT_MS;
    const core = createCoreServices();
    try {
      expect(core.config.admissionShadow).toEqual({ enabled: false, timeoutMs: 50 });
      expect(core.admissionShadow.snapshot()).toMatchObject({ enabled: false, maxInFlight: 32 });
    } finally {
      await core.close();
    }
  });

  it('requires strict explicit admission shadow configuration', async () => {
    process.env.MEMBERRY_ADMISSION_SHADOW_ENABLED = 'true';
    process.env.MEMBERRY_ADMISSION_SHADOW_TIMEOUT_MS = '75';
    const core = createCoreServices();
    try {
      expect(core.config.admissionShadow).toEqual({ enabled: true, timeoutMs: 75 });
      expect(core.admissionShadow.snapshot().enabled).toBe(true);
    } finally {
      await core.close();
    }
    expect(core.admissionShadow.snapshot()).toMatchObject({ stopping: true, inFlight: 0 });

    process.env.MEMBERRY_ADMISSION_SHADOW_ENABLED = '1';
    expect(() => createCoreServices()).toThrowError('admission_shadow_config:invalid_enabled');
  });
  it('keeps the library-safe review-first default', async () => {
    const core = createCoreServices();
    try {
      expect(core.config.consolidation.autoApply).toBe(false);
    } finally {
      await core.close();
    }
  });

  it.each(['1', 'true', 'YES', 'on'])('accepts %s as the explicit safe-auto-apply opt-in', async (value) => {
    process.env['MEMBERRY_CONSOLIDATION_AUTO_APPLY'] = value;
    const core = createCoreServices();
    try {
      expect(core.config.consolidation.autoApply).toBe(true);
    } finally {
      await core.close();
    }
  });

  // A7: protections parse the loose truthy set — `=1` must not silently
  // disable redaction or leave the core writable under a read-only coordinator.
  it.each([
    ['MEMBERRY_REDACT_ON_INGEST', '1', 'redactOnIngest'],
    ['MEMBERRY_READONLY', 'yes', 'readonly'],
  ] as const)('%s=%s enables config.%s', async (name, value, key) => {
    process.env[name] = value;
    const core = createCoreServices();
    try {
      expect(core.config[key]).toBe(true);
    } finally {
      await core.close();
    }
  });

  it.each(['', '   '])('treats blank connection environment values as unset (%j)', async (value) => {
    process.env['NEO4J_URI'] = value;
    process.env['NEO4J_USER'] = value;
    process.env['REDIS_URL'] = value;
    const core = createCoreServices();
    try {
      expect(core.config.neo4j.uri).toBe('bolt://localhost:7687');
      expect(core.config.neo4j.user).toBe('neo4j');
      expect(core.config.redis.url).toBe('redis://localhost:6379');
    } finally {
      await core.close();
    }
  });

  it('treats blank explicit connection overrides as unset', async () => {
    const core = createCoreServices({ neo4jUri: ' ', neo4jUser: '\t', redisUrl: '\n' });
    try {
      expect(core.config.neo4j.uri).toBe('bolt://localhost:7687');
      expect(core.config.neo4j.user).toBe('neo4j');
      expect(core.config.redis.url).toBe('redis://localhost:6379');
    } finally {
      await core.close();
    }
  });
});
