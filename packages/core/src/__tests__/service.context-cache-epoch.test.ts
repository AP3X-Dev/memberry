import { describe, expect, it, vi } from 'vitest';
import { AMPService, type KnowledgeEpochPort, type Neo4jLayer, type RedisLayer } from '../service.js';
import { safeLoad } from '../hooks/safe-load.js';
import type { AMPConfig, SemanticNode } from '../types.js';

const node = (id: string): SemanticNode => ({
  id, content: id, confidence: 0.8, signal_count: 1,
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  decay_class: 'stable', tags: ['project:test'], scope: 'project:test', tenant_id: 'tenant-a',
});

function fixture(epochs: Array<string | Error>, cacheOverrides: Record<string, unknown> = {}) {
  const get = vi.fn().mockResolvedValue(null);
  const set = vi.fn().mockResolvedValue(true);
  const advanceKnowledgeEpoch = vi.fn().mockResolvedValue(true);
  Object.assign({ get, set, advanceKnowledgeEpoch }, cacheOverrides);
  const cache = { get, set, advanceKnowledgeEpoch, invalidateByScope: vi.fn(), invalidateByNodeId: vi.fn(), ...cacheOverrides };
  const redis = { cache, embeddings: { get: vi.fn(), set: vi.fn() }, dedup: {
    isDuplicate: vi.fn(), markSeen: vi.fn(), checkAndMark: vi.fn(), unmark: vi.fn(),
  }, signals: { publish: vi.fn() }, queue: { incrementScore: vi.fn() } } as unknown as RedisLayer;
  const byScope = vi.fn().mockResolvedValue([node('current')]);
  const neo4j = { episodic: { create: vi.fn(), linkToAgent: vi.fn(), linkToEntity: vi.fn(),
    linkToModel: vi.fn(), linkSignal: vi.fn() }, query: {
    byScope, byVector: vi.fn().mockResolvedValue([]),
    evaluateActiveEligibility: vi.fn(async ({ semanticIds }: { semanticIds: readonly string[] }) =>
      semanticIds.map((id) => ({ id, status: 'eligible' as const }))),
  } } as unknown as Neo4jLayer;
  const read = vi.fn(async () => {
    const value = epochs.shift();
    if (value instanceof Error) throw value;
    return { knowledgeEpoch: value ?? '1' };
  });
  const authority: KnowledgeEpochPort = { read };
  const config: AMPConfig = { redis: { url: '' }, neo4j: { uri: '', user: '', password: '' },
    embedding: { provider: 'openai', apiKey: '' }, cache: { defaultTTL: 300, contextTTL: 300,
      embeddingTTL: 300, renderedContextMode: 'versioned', embeddingGeneration: 'embedding-v1' },
    consolidation: { autoApply: false, signalThreshold: 3 }, exportPath: '' };
  const embedding = { available: false, embed: vi.fn(), embedBatch: vi.fn() };
  return { service: new AMPService(redis, neo4j, embedding, config, undefined, undefined, undefined, authority),
    cache, read, byScope };
}

const scope = { task: 'task', tags: ['project:test'], tenantId: 'tenant-a' };

describe('AMPService authoritative rendered-context epoch', () => {
  it('preserves the cache method receiver when advancing its epoch fence', async () => {
    const built = fixture(['1', '1']);
    built.cache.advanceKnowledgeEpoch = function () {
      expect(this).toBe(built.cache);
      return Promise.resolve(true);
    } as typeof built.cache.advanceKnowledgeEpoch;
    const result = await built.service.load(scope);
    expect(result.sources).toContain('current');
    expect(result.degraded).toBeUndefined();
  });

  it('rechecks a cache hit and retries instead of serving bytes across an epoch change', async () => {
    const stale = { markdown: 'stale', tokens: 1, sources: ['old'], assembled_at: 'old' };
    const current = { markdown: 'current', tokens: 1, sources: ['new'], assembled_at: 'new' };
    const get = vi.fn()
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(current);
    const { service } = fixture(['1', '2', '2', '2'], { get });
    await expect(service.load(scope)).resolves.toEqual(current);
  });

  it('discards source work and retries once when the epoch changes during assembly', async () => {
    const { service, byScope, cache } = fixture(['1', '2', '2', '2']);
    byScope.mockResolvedValueOnce([node('old')]).mockResolvedValueOnce([node('new')]);
    const result = await service.load(scope);
    expect(result.sources).toContain('new');
    expect(result.sources).not.toContain('old');
    expect(byScope).toHaveBeenCalledTimes(2);
    expect(cache.set).toHaveBeenCalledOnce();
  });

  it('fails closed when the stale-worker fence rejects final cache publication', async () => {
    const { service } = fixture(['2', '2'], { set: vi.fn().mockResolvedValue(false) });
    await expect(service.load(scope)).resolves.toMatchObject({
      markdown: '', sources: [], degraded: { code: 'knowledge-epoch-changed' },
    });
  });

  it('fails closed before authority or retrieval work when the cache epoch fence is absent', async () => {
    const built = fixture(['1'], { advanceKnowledgeEpoch: undefined });
    await expect(built.service.load(scope)).resolves.toMatchObject({
      markdown: '', sources: [], degraded: { code: 'knowledge-epoch-unavailable' },
    });
    expect(built.read).not.toHaveBeenCalled();
    expect(built.byScope).not.toHaveBeenCalled();
    expect(built.cache.get).not.toHaveBeenCalled();
    expect(built.cache.set).not.toHaveBeenCalled();
  });

  it('fails closed and observably when authoritative epoch reads fail', async () => {
    const { service, byScope } = fixture([new Error('authority timeout')]);
    await expect(service.load(scope)).resolves.toMatchObject({
      markdown: '', sources: [], degraded: { code: 'knowledge-epoch-unavailable' },
    });
    expect(byScope).not.toHaveBeenCalled();
  });

  it('threads a bounded AbortSignal contract into every authority read', async () => {
    const built = fixture(['1', '1']);
    await built.service.load(scope);
    expect(built.read).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a', projectScope: null, timeoutMs: 1_000,
      signal: expect.any(AbortSignal),
    }));
  });

  it('retains timed-out authority operations against the cap until they actually settle', async () => {
    const built = fixture([]);
    const releases: Array<(value: { knowledgeEpoch: string }) => void> = [];
    const read = vi.fn(() => new Promise<{ knowledgeEpoch: string }>((resolve) => { releases.push(resolve); }));
    (built.service as unknown as { knowledgeEpoch: KnowledgeEpochPort }).knowledgeEpoch = { read };
    const internal = built.service as unknown as {
      readKnowledgeEpoch(tenantId: string, projectScope: string | null): Promise<string | null>;
    };
    const pending = Array.from({ length: 32 }, () =>
      internal.readKnowledgeEpoch('tenant-a', 'project:test'));
    await expect(internal.readKnowledgeEpoch('tenant-a', 'project:test')).resolves.toBeNull();
    expect(read).toHaveBeenCalledTimes(32);
    for (const release of releases) release({ knowledgeEpoch: '1' });
    await expect(Promise.all(pending)).resolves.toEqual(Array(32).fill('1'));
  });

  it('disabled mode bypasses both rendered cache and epoch authority', async () => {
    const built = fixture([]);
    (built.service as unknown as { config: AMPConfig }).config.cache.renderedContextMode = 'disabled';
    const result = await built.service.load(scope);
    expect(result.sources).toContain('current');
    expect(built.cache.get).not.toHaveBeenCalled();
    expect(built.cache.set).not.toHaveBeenCalled();
    expect(built.read).not.toHaveBeenCalled();
  });

  it('reports an already-aborted request distinctly', async () => {
    const built = fixture([]);
    const controller = new AbortController();
    controller.abort();
    await expect(built.service.load({ ...scope, signal: controller.signal })).resolves.toMatchObject({
      sources: [], degraded: { code: 'request-aborted' },
    });
  });

  it('an aborted safe-load completion cannot publish rendered cache bytes', async () => {
    let release!: (value: SemanticNode[]) => void;
    const pending = new Promise<SemanticNode[]>((resolve) => { release = resolve; });
    const built = fixture(['1', '1']);
    built.byScope.mockReturnValueOnce(pending);
    await expect(safeLoad(built.service, scope, 10)).resolves.toBeNull();
    release([node('late')]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(built.cache.set).not.toHaveBeenCalled();
  });

  it('caps distinct in-flight loads while underlying providers cannot be cancelled', async () => {
    const built = fixture([]);
    built.byScope.mockReturnValue(new Promise<SemanticNode[]>(() => {}));
    for (let index = 0; index < 32; index += 1) {
      void built.service.load({ ...scope, task: `hung-${index}` });
    }
    await expect(built.service.load({ ...scope, task: 'overflow' })).resolves.toMatchObject({
      sources: [], degraded: { code: 'load-capacity-exceeded' },
    });
  });
});
