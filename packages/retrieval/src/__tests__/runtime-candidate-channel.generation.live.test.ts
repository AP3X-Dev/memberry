import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { embeddingDescriptorFingerprint, type EmbeddingDescriptor, type EmbeddingProvider } from '@memberry/core';
import { createNeo4jDriver, initSchema, EmbeddingGenerationStore, EMBEDDING_SOURCE_KINDS, generationIndexName, ScopedQuery } from '@memberry/neo4j';
import { RuntimeCandidateChannelService, EPISODIC_STRUCTURED_INDEX_FLAG, type RuntimeCandidateDriver } from '../runtime-candidate-channel.js';
import { resolveRuntimeQueryPlannerAuthorityV1 } from '../runtime-query-planner.js';

const mode = process.env.MEMBERRY_PR03_LIVE;
if (mode !== undefined && mode !== 'required') throw new Error('MEMBERRY_PR03_LIVE must be exactly required when set');
const liveDescribe = mode === 'required' ? describe : describe.skip;
const descriptor: EmbeddingDescriptor = { schemaVersion: 1, provider: 'deterministic-fixture', model: 'candidate-fixture', revision: 'fixture-r1', dimensions: 2, normalization: 'l2', preprocessingVersion: 'v1' };
const provider: EmbeddingProvider = { descriptor, embed: async () => [1, 0], embedBatch: async texts => texts.map(() => [1, 0]) };

liveDescribe('PR-03 generation-backed runtime candidates on disposable Neo4j', () => {
  let driver: ReturnType<typeof createNeo4jDriver>;
  let store: EmbeddingGenerationStore;
  let generation: string | undefined;
  const owner = `pr03candidate-${randomUUID().replaceAll('-', '')}`;
  const scope = { tenantId: owner, projectScope: `project:${owner}` };
  const ids = { root: `${owner}-root`, bridge: `${owner}-bridge`, semantic: `${owner}-semantic`, seed: `${owner}-seed`, plain: `${owner}-plain`, neighbor: `${owner}-neighbor`, key: `${owner}-key`, neighborKey: `${owner}-neighbor-key` };
  const priorFlag = process.env[EPISODIC_STRUCTURED_INDEX_FLAG];
  const queryFailures: Array<{ code: string; message: string; generationQuery: boolean }> = [];

  function diagnosticDriver(): RuntimeCandidateDriver {
    return {
      session(config) {
        const session = driver.session(config as never);
        return {
          run: async (query, params, options) => session.run(query, params, options),
          beginTransaction(options) {
            const tx = session.beginTransaction(options);
            return {
              async run(query, params) {
                try { return await tx.run(query, params); }
                catch (error) {
                  // These tests create only synthetic fixture data on a guarded disposable database.
                  queryFailures.push({ code: String((error as { code?: unknown }).code ?? ''),
                    message: error instanceof Error ? error.message : String(error),
                    generationQuery: query.includes('EmbeddingProjection') });
                  throw error;
                }
              },
              commit: () => tx.commit(), rollback: () => tx.rollback(),
            };
          },
          close: () => session.close(),
        };
      },
    };
  }

  beforeAll(async () => {
    if (process.env.MEMBERRY_PR03_DISPOSABLE !== '1') throw new Error('PR-03 candidate fixture requires MEMBERRY_PR03_DISPOSABLE=1');
    if (!process.env.NEO4J_URI || !process.env.NEO4J_USER || !process.env.NEO4J_PASSWORD) throw new Error('PR-03 candidate fixture requires explicit disposable Neo4j credentials');
    driver = createNeo4jDriver(process.env.NEO4J_URI, process.env.NEO4J_USER, process.env.NEO4J_PASSWORD);
    await driver.getServerInfo();
    await initSchema(driver);
    store = new EmbeddingGenerationStore(driver);
    const session = driver.session();
    try {
      await session.run(`CREATE (root:Entity {id: $root, name: $owner, type: 'project', tenant_id: $tenant})
        CREATE (bridge:Entity {id: $bridge, name: 'bridge', type: 'module', tenant_id: $tenant})
        CREATE (root)-[:CONTAINS]->(bridge)
        CREATE (s:Semantic {id: $semantic, content: 'qualified semantic', scope: $project, tenant_id: $tenant,
          created_at: '2026-01-01T00:00:00.000Z', confidence: 0.9, signal_count: 1, archived: false, embedding: [0.0, 1.0]})
        CREATE (s)-[:ABOUT {valid_at: '2026-01-01T00:00:00.000Z'}]->(root)
        CREATE (seed:Episodic {id: $seed, content: 'qualified seed', scope: $project, tenant_id: $tenant, created_at: '2026-01-01T00:00:00.000Z', embedding: [0.0, 1.0]})
        CREATE (plain:Episodic {id: $plain, content: 'qualified without key', scope: $project, tenant_id: $tenant, created_at: '2026-01-01T00:00:00.000Z'})
        CREATE (neighbor:Episodic {id: $neighbor, content: 'qualified neighbor', scope: $project, tenant_id: $tenant, created_at: '2026-01-01T00:00:00.000Z'})
        CREATE (seed)-[:REFERENCES {valid_at: '2026-01-01T00:00:00.000Z'}]->(root)
        CREATE (plain)-[:REFERENCES {valid_at: '2026-01-01T00:00:00.000Z'}]->(root)
        CREATE (seed)-[:REFERENCES {valid_at: '2026-01-01T00:00:00.000Z'}]->(bridge)
        CREATE (neighbor)-[:REFERENCES {valid_at: '2026-01-01T00:00:00.000Z'}]->(bridge)
        CREATE (key:EpisodicIndexKey {id: $key, episode_id: $seed, value: 'seed index key', kind: 'fact', schema_version: 1, tenant_id: $tenant, project_scope: $project, source_hash: $hash, entity_id: $bridge})
        CREATE (nkey:EpisodicIndexKey {id: $neighborKey, episode_id: $neighbor, value: 'neighbor index key', kind: 'fact', schema_version: 1, tenant_id: $tenant, project_scope: $project, source_hash: $hash, entity_id: $bridge})
        CREATE (seed)-[:HAS_INDEX_KEY]->(key) CREATE (neighbor)-[:HAS_INDEX_KEY]->(nkey)`,
        { ...ids, owner, tenant: scope.tenantId, project: scope.projectScope, hash: 'a'.repeat(64) });
      generation = await store.create(scope, descriptor, { revisionBindingEvidence: 'Deterministic provider defined in this fixture; no external calls.' });
      await session.run('CALL db.awaitIndexes(30)');
      expect(await store.backfill(scope, generation, provider, { batchSize: 20 })).toMatchObject({ failed: 0, remaining: 0 });
      await store.complete(scope, generation);
      expect((await store.replayAndQualify(scope, generation, provider, { queries: [
        { id: 'semantic', text: 'semantic', kind: 'semantic', expectedIds: [ids.semantic] },
        { id: 'episodic', text: 'qualified', kind: 'episodic', expectedIds: [ids.seed, ids.plain, ids.neighbor] },
        { id: 'keys', text: 'index key', kind: 'episodic-index-key', expectedIds: [ids.key, ids.neighborKey] },
      ] })).passed).toBe(true);
      await store.activate(scope, generation, null);
      await warmChannelPlans();
    } finally { await session.close(); }
  }, 90_000);

  // ponytail: QUERY_TIMEOUT_MS (2,000 ms) is charged for Cypher planning. Measured on the disposable
  // 4-core Cerebro host under load: the structured episodic query executes in 10-27 ms with a cached
  // plan but plans cold in 1,400-2,370 ms, so a first call after restart or a statistics replan can
  // settle `timeout` by design (disclosed degradation, RET-009). This fixture asserts projection
  // correctness and pointer enforcement, not the planner's cold cost, so it captures each channel
  // query through one throwaway pass and warms the plan cache with EXPLAIN under a generous bound.
  // Upgrade path: PR-04/PR-06 operational-limits item for the cold-plan-versus-bound class.
  async function warmChannelPlans() {
    const captured = new Map<string, Record<string, unknown>>();
    const capturing: RuntimeCandidateDriver = { session(config) {
      const session = driver.session(config as never);
      return {
        run: async (query, params, options) => session.run(query, params, options),
        beginTransaction(options) {
          const tx = session.beginTransaction(options);
          return { run(query, params) { captured.set(query, params ?? {}); return tx.run(query, params); }, commit: () => tx.commit(), rollback: () => tx.rollback() };
        },
        close: () => session.close(),
      };
    } };
    for (const structured of [false, true]) {
      if (structured) process.env[EPISODIC_STRUCTURED_INDEX_FLAG] = '1'; else delete process.env[EPISODIC_STRUCTURED_INDEX_FLAG];
      const receipt = await resolveRuntimeQueryPlannerAuthorityV1({ authenticated: true, plannerEnabled: true,
        tenantId: scope.tenantId, projectName: scope.projectScope, entityScope: [owner],
        resolverFactory: () => ({ resolve: async () => ({ resolution: { state: 'resolved', canonicalEntityIds: [ids.root] }, diagnostics: [] }) }) });
      await new RuntimeCandidateChannelService(capturing, undefined, { store, descriptor })
        .execute(receipt, { includeArchitecture: false, includeMemory: true, queryVector: [1, 0], queryDescriptorFingerprint: embeddingDescriptorFingerprint(descriptor) });
    }
    for (const [query, params] of captured) {
      const session = driver.session({ defaultAccessMode: 'READ' });
      try { await session.run(`EXPLAIN ${query}`, params, { timeout: 30_000 }); } finally { await session.close(); }
    }
  }

  afterAll(async () => {
    if (priorFlag === undefined) delete process.env[EPISODIC_STRUCTURED_INDEX_FLAG];
    else process.env[EPISODIC_STRUCTURED_INDEX_FLAG] = priorFlag;
    if (!driver) return;
    const session = driver.session();
    try {
      if (generation) for (const kind of EMBEDDING_SOURCE_KINDS) await session.run(`DROP INDEX ${generationIndexName(generation, kind)} IF EXISTS`);
      await session.run(`MATCH (n) WHERE n.tenant_id = $tenant OR n.tenantId = $tenant
        OR (n:EmbeddingProjection AND n.generationId = $generation)
        OR (n:EmbeddingBackfillFailure AND n.generationId = $generation) DETACH DELETE n`, { tenant: scope.tenantId, generation: generation ?? null });
    } finally { await session.close(); await driver.close(); }
  }, 60_000);

  async function execute(structured: boolean, override = descriptor) {
    if (structured) process.env[EPISODIC_STRUCTURED_INDEX_FLAG] = '1';
    else delete process.env[EPISODIC_STRUCTURED_INDEX_FLAG];
    const receipt = await resolveRuntimeQueryPlannerAuthorityV1({ authenticated: true, plannerEnabled: true,
      tenantId: scope.tenantId, projectName: scope.projectScope, entityScope: [owner],
      resolverFactory: () => ({ resolve: async () => ({ resolution: { state: 'resolved', canonicalEntityIds: [ids.root] }, diagnostics: [] }) }),
    });
    const service = new RuntimeCandidateChannelService(diagnosticDriver(), undefined, { store, descriptor: override });
    return service.execute(receipt, { includeArchitecture: false, includeMemory: true, queryVector: [1, 0], queryDescriptorFingerprint: embeddingDescriptorFingerprint(override) });
  }

  it('serves semantic and direct episodes from projections even with absent or incompatible raw embeddings', async () => {
    const result = await execute(false);
    expect(result.settlements.filter(item => item.channel.startsWith('memory.') && item.channel.endsWith('-vector')).every(item => item.outcome === 'success'),
      JSON.stringify({ settlements: result.settlements, queryFailures })).toBe(true);
    const dense = result.candidates.filter(item => item.channel.endsWith('-vector'));
    expect(dense.map(item => item.evidenceId)).toEqual(expect.arrayContaining([ids.semantic, ids.seed, ids.plain]));
    expect(dense.every(item => item.score > 0.99)).toBe(true);
  });

  it('retains missing-key episodes and qualifies key plus neighbor operands in structured expansion', async () => {
    const result = await execute(true);
    const settlement = result.settlements.find(item => item.channel === 'memory.episodic-vector');
    expect(settlement?.outcome, JSON.stringify({ settlements: result.settlements, queryFailures })).toBe('success');
    expect(result.candidates.filter(item => item.channel === 'memory.episodic-vector').map(item => item.evidenceId))
      .toEqual(expect.arrayContaining([ids.seed, ids.plain, ids.neighbor]));
  });

  it('fails dense lanes closed for another model at identical dimensions', async () => {
    const result = await execute(true, { ...descriptor, model: 'different-space' });
    expect(result.candidates.some(item => item.channel.endsWith('-vector'))).toBe(false);
    expect(result.candidates.some(item => item.channel === 'memory.scope')).toBe(true);
  });

  it('maps actual generation-backed ScopedQuery semantic and episodic reads', async () => {
    const query = new ScopedQuery(driver, { store, descriptor });
    const fingerprint = embeddingDescriptorFingerprint(descriptor);
    const semantics = await query.byVector([1, 0], 10, scope.tenantId, scope.projectScope, fingerprint);
    expect(semantics).toHaveLength(1);
    expect(semantics[0]).toMatchObject({ id: ids.semantic, content: 'qualified semantic', confidence: 0.9, signal_count: 1, scope: scope.projectScope });
    expect(semantics[0].score).toBeGreaterThan(0.99);
    expect(semantics[0].embedding).toBeUndefined();
    const episodes = await query.byVectorEpisodic([1, 0], 10, scope.tenantId, scope.projectScope, fingerprint);
    expect(episodes.map(item => item.id)).toEqual(expect.arrayContaining([ids.seed, ids.plain, ids.neighbor]));
    expect(episodes.every(item => item.score > 0.99 && item.tenant_id === scope.tenantId && item.scope === scope.projectScope)).toBe(true);
    expect(episodes.every(item => item.embedding === undefined)).toBe(true);
    expect(query.generationStatus).toBe('ready');
  });

  it('rejects unknown and wrong query descriptors through actual ScopedQuery composition', async () => {
    const query = new ScopedQuery(driver, { store, descriptor });
    const wrong = embeddingDescriptorFingerprint({ ...descriptor, model: 'same-size-foreign-space' });
    for (const fingerprint of [undefined, wrong]) {
      expect(await query.byVector([1, 0], 10, scope.tenantId, scope.projectScope, fingerprint)).toEqual([]);
      expect(await query.byVectorEpisodic([1, 0], 10, scope.tenantId, scope.projectScope, fingerprint)).toEqual([]);
      expect(query.generationStatus).toBe('embedding_query_descriptor_mismatch');
    }
    const fingerprint = embeddingDescriptorFingerprint(descriptor);
    expect(await query.byVector([1, 0], 10, `${scope.tenantId}-foreign`, scope.projectScope, fingerprint)).toEqual([]);
    expect(await query.byVectorEpisodic([1, 0], 10, scope.tenantId, `${scope.projectScope}-foreign`, fingerprint)).toEqual([]);
  });

  it('excludes changed canonical source input without consulting its old raw vector', async () => {
    const session = driver.session();
    try { await session.run('MATCH (s:Semantic {id: $id}) SET s.content = $content', { id: ids.semantic, content: 'changed after projection' }); }
    finally { await session.close(); }
    const result = await execute(false);
    expect(result.candidates.some(item => item.channel === 'memory.semantic-vector' && item.evidenceId === ids.semantic)).toBe(false);
    expect(result.candidates.some(item => item.channel === 'memory.scope' && item.evidenceId === ids.semantic)).toBe(true);
  });
});
