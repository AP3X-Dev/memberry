import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { embeddingDescriptorFingerprint, type EmbeddingDescriptor, type EmbeddingProvider } from '@memberry/core';
import { createNeo4jDriver } from '../driver.js';
import { initSchema } from '../schema.js';
import { bumpKnowledgeEpoch } from '../knowledge-epoch.js';
import { EmbeddingGenerationStore, EMBEDDING_SOURCE_KINDS, generationIndexName, type GenerationReplayQuery } from '../embedding-generation.js';

const mode = process.env.MEMBERRY_PR03_LIVE;
if (mode !== undefined && mode !== 'required') throw new Error('MEMBERRY_PR03_LIVE must be exactly "required" when set');
const liveDescribe = mode === 'required' ? describe : describe.skip;
const prefix = `generation-live-${Date.now()}`;
const scope = { tenantId: 'default', projectScope: `project:${prefix}` };
const descriptor: EmbeddingDescriptor = { schemaVersion: 1, provider: 'deterministic-fixture', model: 'fixture-model-a',
  revision: 'fixture-r1', dimensions: 3, normalization: 'l2', preprocessingVersion: 'utf8-raw-v1' };
function vector(text: string): number[] {
  if (text.includes('semantic')) return [1, 0, 0];
  if (text.includes('symbol')) return [0, 1, 0];
  return [0, 0, 1];
}
const provider: EmbeddingProvider = { descriptor, embed: async text => vector(text), embedBatch: async texts => texts.map(vector) };
const replay: GenerationReplayQuery[] = EMBEDDING_SOURCE_KINDS.map(kind => ({
  id: kind, text: kind, kind, expectedIds: [`${prefix}-${kind}`],
}));

liveDescribe('embedding generation disposable qualification', () => {
  const driver = createNeo4jDriver(process.env.NEO4J_URI || 'bolt://localhost:7687', process.env.NEO4J_USER || 'neo4j', process.env.NEO4J_PASSWORD || 'password');
  const store = new EmbeddingGenerationStore(driver);
  const generations: string[] = [];
  // ponytail: fixture disposal budget, not a product bound. Cleanup is 48 sequential DROP INDEX
  // statements (12 generations x 4 source kinds), measured 21.2 s at host load 5 on the disposable
  // Cerebro Neo4j (442 ms per drop) and past 60 s at load 11, where the 2026-09-13 Node 20 arm
  // timed out after all 13 cases passed. Setup also stalled past 60 s once under the same load.
  // Upgrade path: fewer generations per suite or concurrent drops if this budget is ever reached.
  const FIXTURE_HOOK_TIMEOUT_MS = 300_000;
  let first: string;
  let available = false;

  async function create(): Promise<string> {
    const id = await store.create(scope, descriptor, { revisionBindingEvidence: 'Synthetic deterministic fixture source in this test; no provider traffic.' });
    generations.push(id);
    const session = driver.session();
    try { await session.run('CALL db.awaitIndexes(30)'); } finally { await session.close(); }
    return id;
  }
  async function build(id: string) {
    for (let n = 0; n < 10; n++) {
      const result = await store.backfill(scope, id, provider, { batchSize: 2 });
      expect(result.failed).toBe(0);
      if (result.remaining === 0) return;
    }
    throw new Error('fixture backfill did not converge');
  }

  beforeAll(async () => {
    if (process.env.MEMBERRY_PR03_DISPOSABLE !== '1') throw new Error('PR03 live tests require MEMBERRY_PR03_DISPOSABLE=1');
    if (!process.env.NEO4J_URI || !process.env.NEO4J_USER || !process.env.NEO4J_PASSWORD) {
      throw new Error('PR03 required mode needs explicit disposable Neo4j credentials');
    }
    await driver.getServerInfo(); await initSchema(driver); available = true;
    const session = driver.session();
    try {
      await session.executeWrite(async tx => {
        await tx.run(`CREATE (:Semantic {id: $semantic, content: 'semantic evidence', scope: $scope, tenant_id: 'default',
          created_at: '2026-01-01T00:00:00.000Z', archived: false, embedding: [0.0, 1.0, 0.0]})
          CREATE (ep:Episodic {id: $episodic, content: 'episodic evidence', scope: $scope, tenant_id: 'default', created_at: '2026-01-01T00:00:00.000Z'})
          CREATE (:Symbol {id: $symbol, name: 'symbol', signature: 'symbol()', doc_comment: 'symbol evidence', project_tag: $scope})
          CREATE (key:EpisodicIndexKey {id: $key, episode_id: $episodic, kind: 'fact', value: 'episodic-index-key',
            schema_version: 1, source_hash: $keyHash, tenant_id: 'default', project_scope: $scope})
          CREATE (ep)-[:HAS_INDEX_KEY]->(key)`,
        { semantic: `${prefix}-semantic`, episodic: `${prefix}-episodic`, symbol: `${prefix}-symbol`, key: `${prefix}-episodic-index-key`,
          scope: scope.projectScope, keyHash: createHash('sha256').update('fact\0\0episodic-index-key').digest('hex') });
        await bumpKnowledgeEpoch(tx, scope);
      });
    } finally { await session.close(); }
  }, FIXTURE_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    if (available) {
      const session = driver.session();
      try {
        for (const id of generations) for (const kind of EMBEDDING_SOURCE_KINDS) {
          await session.run(`DROP INDEX ${generationIndexName(id, kind)} IF EXISTS`);
        }
        await session.run(`MATCH (n) WHERE (n:EmbeddingGeneration AND n.id IN $ids)
          OR (n:EmbeddingProjection AND n.generationId IN $ids) OR (n:EmbeddingBackfillFailure AND n.generationId IN $ids)
          OR (n:EmbeddingGenerationReplay AND n.generationId IN $ids)
          OR (n:EmbeddingGenerationPointer AND n.projectScope = $scope AND n.tenantId = 'default')
          OR ((n:Semantic OR n:Episodic OR n:Symbol OR n:EpisodicIndexKey) AND n.id STARTS WITH $prefix)
          DETACH DELETE n`, { ids: generations, scope: scope.projectScope, prefix });
        await session.run("MATCH (e:KnowledgeEpoch {tenant_id: 'default', project_scope: $scope}) DELETE e", { scope: scope.projectScope });
      } finally { await session.close(); }
    }
    await driver.close();
  }, FIXTURE_HOOK_TIMEOUT_MS);

  it('keeps interrupted builds inactive and resumes all four canonical source kinds', async () => {
    first = await create();
    const partial = await store.backfill(scope, first, provider, { batchSize: 1 });
    expect(partial).toEqual({ written: 1, failed: 0, remaining: 3 });
    await expect(store.complete(scope, first)).rejects.toThrow('incomplete');
    expect(await store.compatible(scope, embeddingDescriptorFingerprint(descriptor))).toBeNull();
    await build(first);
    expect(await store.backfill(scope, first, provider)).toEqual({ written: 0, failed: 0, remaining: 0 });
    await store.complete(scope, first);
    await expect(store.activate(scope, first, null)).rejects.toThrow('not_qualified');
    const result = await store.replayAndQualify(scope, first, provider, { queries: replay });
    expect(result.passed).toBe(true); expect(result.baseline).toBe('bounded-lexical-v1');
    await store.activate(scope, first, null);
    for (const kind of EMBEDDING_SOURCE_KINDS) {
      const found = await store.search(scope, { descriptorFingerprint: embeddingDescriptorFingerprint(descriptor), vector: vector(kind), kind });
      expect(found.results.map(row => row.id)).toEqual([`${prefix}-${kind}`]);
      expect(found.generationId).toBe(first);
    }
  }, 60_000);

  it('never accepts same-dimensional different spaces or another scope', async () => {
    const mismatch = embeddingDescriptorFingerprint({ ...descriptor, model: 'fixture-model-b' });
    expect((await store.search(scope, { descriptorFingerprint: mismatch, vector: [1, 0, 0], kind: 'semantic' })).degradedReason).toBe('embedding_generation_unavailable');
    expect(await store.compatible({ ...scope, tenantId: 'foreign' }, embeddingDescriptorFingerprint(descriptor))).toBeNull();
    expect(await store.compatible({ ...scope, projectScope: `${scope.projectScope}-foreign` }, embeddingDescriptorFingerprint(descriptor))).toBeNull();
    await expect(store.backfill(scope, first, { ...provider, descriptor: { ...descriptor, model: 'fixture-model-b' } })).rejects.toThrow('provider_mismatch');
  });

  it('records failed backfills and retries without promoting the interrupted generation', async () => {
    const id = await create();
    const bad: EmbeddingProvider = { ...provider, embed: async () => [1, NaN, 0] };
    expect((await store.backfill(scope, id, bad, { batchSize: 1 })).failed).toBe(1);
    await expect(store.complete(scope, id)).rejects.toThrow('incomplete');
    await build(id); await store.complete(scope, id);
    const result = await store.replayAndQualify(scope, id, provider, { queries: replay.map((q, i) => i === 0 ? { ...q, expectedIds: ['not-a-source'] } : q) });
    expect(result.passed).toBe(false);
    await expect(store.activate(scope, id, first)).rejects.toThrow('not_qualified');
    await expect(store.replayAndQualify(scope, id, provider, { queries: replay })).rejects.toThrow('replay_manifest_changed_reopen_required');
  }, 60_000);

  it('qualifies a separate index, atomically switches, retains rollback and enforces observation', async () => {
    const id = await create(); await build(id); await store.complete(scope, id);
    expect((await store.replayAndQualify(scope, id, provider, { queries: replay })).baseline).toBe(first);
    await expect(store.activate(scope, id, null)).rejects.toThrow('pointer_conflict');
    await store.activate(scope, id, first);
    await expect(store.retire(scope, first, id)).rejects.toThrow('observation_required');
    expect(await store.observe(scope, provider, replay[0]!)).toBe(true);
    await expect(store.retire(scope, first, id)).rejects.toThrow('observation_required');
    await expect(store.rollback(scope, first, id, '0'.repeat(64))).rejects.toThrow('rollback_incompatible');
    await store.rollback(scope, first, id, embeddingDescriptorFingerprint(descriptor));
    expect((await store.compatible(scope, embeddingDescriptorFingerprint(descriptor)))?.id).toBe(first);
  }, 60_000);

  it('rejects stale completion when an authoritative writer changes the epoch', async () => {
    const id = await create(); await build(id); await store.complete(scope, id);
    const session = driver.session();
    try { await session.executeWrite(tx => bumpKnowledgeEpoch(tx, scope)); } finally { await session.close(); }
    await expect(store.replayAndQualify(scope, id, provider, { queries: replay })).rejects.toThrow('source_changed');
    await store.reopen(scope, id); await build(id); await store.complete(scope, id);
    expect((await store.replayAndQualify(scope, id, provider, { queries: replay })).passed).toBe(true);
  }, 60_000);

  it('excludes stale canonical inputs immediately and repairs active projections', async () => {
    const session = driver.session();
    try {
      await session.executeWrite(async tx => {
        await tx.run('MATCH (s:Semantic {id: $id}) SET s.content = $text', { id: `${prefix}-semantic`, text: 'semantic revised evidence' });
        await bumpKnowledgeEpoch(tx, scope);
      });
    } finally { await session.close(); }
    const stale = await store.search(scope, { descriptorFingerprint: embeddingDescriptorFingerprint(descriptor), vector: [1, 0, 0], kind: 'semantic' });
    expect(stale.results).toEqual([]);
    expect((await store.backfill(scope, first, provider)).written).toBe(1);
    const fresh = await store.vectors(scope, { descriptorFingerprint: embeddingDescriptorFingerprint(descriptor), kind: 'semantic', sourceIds: [`${prefix}-semantic`] });
    expect(fresh.rows[0]?.inputText).toBe('semantic revised evidence');
  }, 60_000);

  it('permits only one competing pointer replacement', async () => {
    const left = await create(); const right = await create();
    for (const id of [left, right]) {
      await build(id); await store.complete(scope, id);
      expect((await store.replayAndQualify(scope, id, provider, { queries: replay })).passed).toBe(true);
    }
    const outcomes = await Promise.allSettled([store.activate(scope, left, first), store.activate(scope, right, first)]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejected.reason)).toContain('pointer_conflict');
    const winner = (await store.compatible(scope, embeddingDescriptorFingerprint(descriptor)))!.id;
    await store.rollback(scope, first, winner, embeddingDescriptorFingerprint(descriptor));
  }, 60_000);

  it('rejects a source edit during model work and retries from fresh canonical input', async () => {
    const id = await create();
    let mutated = false;
    const racing: EmbeddingProvider = { ...provider, embed: async text => {
      if (!mutated) {
        mutated = true;
        const session = driver.session();
        try {
          await session.executeWrite(async tx => {
            await tx.run('MATCH (s:Semantic {id: $id}) SET s.content = $text', { id: `${prefix}-semantic`, text: 'semantic edited during model work' });
            await bumpKnowledgeEpoch(tx, scope);
          });
        } finally { await session.close(); }
      }
      return vector(text);
    } };
    expect((await store.backfill(scope, id, racing, { batchSize: 1 })).failed).toBe(1);
    await expect(store.complete(scope, id)).rejects.toThrow('incomplete');
    await build(id); await store.complete(scope, id);
    expect((await store.replayAndQualify(scope, id, provider, { queries: replay })).passed).toBe(true);
    expect((await store.status(scope, embeddingDescriptorFingerprint(descriptor))).generations.find(g => g.id === id)?.failureCount).toBe(0);
    await store.backfill(scope, first, provider);
  }, 60_000);

  it('refuses an index with the right name and wrong configuration', async () => {
    const id = await create(); const name = generationIndexName(id, 'semantic');
    const session = driver.session();
    try {
      await session.run(`DROP INDEX ${name}`);
      await session.run(`CREATE VECTOR INDEX ${name} FOR (p:${name}) ON (p.vector)
        OPTIONS {indexConfig: {\`vector.dimensions\`: 2, \`vector.similarity_function\`: 'cosine'}}`);
      await session.run('CALL db.awaitIndexes(30)');
    } finally { await session.close(); }
    await expect(store.complete(scope, id)).rejects.toThrow('index_not_compatible');
    expect((await store.status(scope)).generations.find(g => g.id === id)?.indexCompatible).toBe(false);
  }, 60_000);

  it('rejects provider descriptor drift during backfill and qualification', async () => {
    const id = await create();
    const changing = { ...provider, descriptor: { ...descriptor }, embed: async (_text: string) => {
      changing.descriptor.model = 'different-same-dimensional-space'; return [1, 0, 0];
    } };
    expect((await store.backfill(scope, id, changing, { batchSize: 1 })).failed).toBe(1);
    expect((await store.status(scope)).generations.find(g => g.id === id)?.currentCount).toBe(0);
    await build(id); await store.complete(scope, id);
    changing.descriptor.model = descriptor.model;
    await expect(store.replayAndQualify(scope, id, changing, { queries: replay })).rejects.toThrow('provider_mismatch');
    await expect(store.activate(scope, id, first)).rejects.toThrow('not_qualified');
    expect((await store.replayAndQualify(scope, id, provider, { queries: replay })).passed).toBe(true);
  }, 60_000);

  it('does not let a late failed worker poison a concurrently repaired projection', async () => {
    const id = await create();
    let entered!: () => void; let rejectEmbedding!: (error: Error) => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const failing = { ...provider, embed: async () => {
      entered(); return new Promise<number[]>((_resolve, reject) => { rejectEmbedding = reject; });
    } };
    const lateFailure = store.backfill(scope, id, failing, { batchSize: 1 });
    await started;
    expect((await store.backfill(scope, id, provider, { batchSize: 1 })).written).toBe(1);
    rejectEmbedding(new Error('synthetic delayed failure'));
    expect((await lateFailure).failed).toBe(1);
    expect((await store.status(scope)).generations.find(g => g.id === id)?.failureCount).toBe(0);
    await build(id); await store.complete(scope, id);
    expect((await store.replayAndQualify(scope, id, provider, { queries: replay })).passed).toBe(true);
  }, 60_000);

  it('retains the frozen scope when the caller mutates its request during model work', async () => {
    const id = await create(); const mutableScope = { ...scope }; const observed: unknown[] = [];
    const mutating: EmbeddingProvider = { ...provider, embed: async (text, request) => {
      observed.push(request);
      mutableScope.tenantId = 'foreign-after-start'; mutableScope.projectScope = 'project:foreign';
      return vector(text);
    } };
    expect((await store.backfill(mutableScope, id, mutating)).written).toBe(4);
    expect(observed).toHaveLength(4);
    for (const request of observed) expect(request).toEqual(scope);
    expect((await store.status(scope)).generations.find(g => g.id === id)?.currentCount).toBe(4);
  }, 60_000);

  it('cannot retire rollback evidence after the active replacement loses coverage', async () => {
    const id = await create(); await build(id); await store.complete(scope, id);
    await store.replayAndQualify(scope, id, provider, { queries: replay });
    await store.activate(scope, id, first);
    const session = driver.session();
    try {
      // Synthetic qualification clock: no claim that this test observed a real 24-hour window.
      await session.run('MATCH (g:EmbeddingGeneration {id: $id}) SET g.activatedAt = $past',
        { id, past: new Date(Date.now() - 86_400_001).toISOString() });
    } finally { await session.close(); }
    expect(await store.observe(scope, provider, replay[0]!)).toBe(true);
    const mutation = driver.session();
    try {
      await mutation.executeWrite(async tx => {
        await tx.run('MATCH (s:Semantic {id: $id}) SET s.content = $text', { id: `${prefix}-semantic`, text: 'semantic changed after observation' });
        await bumpKnowledgeEpoch(tx, scope);
      });
    } finally { await mutation.close(); }
    await expect(store.retire(scope, first, id)).rejects.toThrow('incomplete');
    await store.backfill(scope, id, provider);
    const schema = driver.session();
    try { await schema.run(`DROP INDEX ${generationIndexName(id, 'semantic')}`); } finally { await schema.close(); }
    await expect(store.retire(scope, first, id)).rejects.toThrow('index_not_compatible');
  }, 60_000);
});
