// Explicit legacy vector fixtures below are unqualified historical compatibility evidence.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createNeo4jDriver,
  bumpKnowledgeEpoch,
  EpisodicStore,
  FactStore,
  initSchema,
  KnowledgeEpochStore,
  ScopedQuery,
  SemanticStore,
} from '@memberry/neo4j';
import {
  ContextCache,
  createRedisClient,
  EmbeddingCache,
  DedupChecker,
  SignalStream,
  ConsolidationQueue,
  type ContextCacheRead,
  type ContextCacheWrite,
} from '@memberry/redis';
import { AMPService } from '../service.js';
import {
  EMBEDDING_DIM,
  type AMPConfig,
  type FactNode,
  type MemoryContext,
  type SemanticNode,
} from '../types.js';
import { UnifiedAssembler } from '../../../retrieval/src/assembler.js';
import { RuntimeCandidateChannelService } from '../../../retrieval/src/runtime-candidate-channel.js';
import { resolveRuntimeQueryPlannerAuthorityV1 } from '../../../retrieval/src/runtime-query-planner.js';
import { ScopedEntityResolver } from '../../../retrieval/src/scoped-entity-resolver.js';
import type { FeedbackRedisLayer } from '../../../retrieval/src/feedback.js';

const flags = [process.env.MEMBERRY_PR01_LIVE, process.env.MEMBERRY_PR02_LIVE];
if (flags.some((flag) => flag !== undefined && flag !== 'required')) {
  throw new Error('PR-01/02 live flags must be exactly required when set');
}
if (flags.some((flag) => flag === 'required') && flags.some((flag) => flag !== 'required')) {
  throw new Error('Cross-package delivery requires both PR-01 and PR-02 live flags');
}
const liveDescribe = flags.every((flag) => flag === 'required') ? describe : describe.skip;

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

liveDescribe('PR-01/02 real core delivery, Neo4j authority and Redis fencing', () => {
  let driver: ReturnType<typeof createNeo4jDriver>;
  let redis: ReturnType<typeof createRedisClient>;
  const owner = `delivery-${randomUUID()}`;
  const tenants: string[] = [];
  const extraDrivers: Array<ReturnType<typeof createNeo4jDriver>> = [];
  const vector = Object.assign(new Array<number>(EMBEDDING_DIM).fill(0), { 0: 1 });
  const weakVector = Object.assign(new Array<number>(EMBEDDING_DIM).fill(0), { 0: 0.1, 1: 1 });

  beforeAll(async () => {
    for (const name of ['NEO4J_URI', 'NEO4J_USER', 'NEO4J_PASSWORD', 'REDIS_URL']) {
      if (!process.env[name]) throw new Error(`Required delivery live mode needs ${name}`);
    }
    if (process.env.MEMBERRY_PR0102_DISPOSABLE !== '1') {
      throw new Error('Delivery live fixtures require MEMBERRY_PR0102_DISPOSABLE=1');
    }
    driver = createNeo4jDriver(
      process.env.NEO4J_URI!,
      process.env.NEO4J_USER!,
      process.env.NEO4J_PASSWORD!,
    );
    redis = createRedisClient(process.env.REDIS_URL!, {
      retryStrategy: () => null,
      maxRetriesPerRequest: 0,
    });
    await driver.verifyConnectivity();
    await redis.ping();
    await initSchema(driver);
    const session = driver.session();
    try {
      await session.run('CALL db.awaitIndexes(60)');
    } finally {
      await session.close();
    }
  }, 90_000);

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    for (const other of extraDrivers) await other.close();
    try {
      if (driver && tenants.length) {
        const session = driver.session();
        try {
          // Exact per-test tenants; never clear shared labels or the database.
          await session.run('MATCH (n) WHERE n.tenant_id IN $tenants DETACH DELETE n', { tenants });
        } finally {
          await session.close();
        }
      }
      if (redis?.status === 'ready') {
        for (const tenant of tenants) {
          let cursor = '0';
          do {
            const [next, keys] = await redis.scan(
              cursor,
              'MATCH',
              `amp:*:${tenant}:*`,
              'COUNT',
              100,
            );
            cursor = next;
            if (keys.length) await redis.del(...keys);
          } while (cursor !== '0');
        }
      }
    } finally {
      redis?.disconnect();
      if (driver) await driver.close();
    }
  }, 30_000);

  async function fixture(suffix: string) {
    const tenant = `${owner}-${suffix}`;
    const project = `project:${owner}-${suffix}`;
    tenants.push(tenant);
    const store = new SemanticStore(driver);
    const query = new ScopedQuery(driver, { legacyUnqualified: true });
    const authority = new KnowledgeEpochStore(driver);
    const cache = new ContextCache(redis, { mode: 'versioned' });
    const config: AMPConfig = {
      redis: { url: process.env.REDIS_URL! },
      neo4j: {
        uri: process.env.NEO4J_URI!,
        user: process.env.NEO4J_USER!,
        password: process.env.NEO4J_PASSWORD!,
      },
      embedding: { provider: 'openai', apiKey: '' },
      cache: {
        defaultTTL: 300,
        contextTTL: 300,
        embeddingTTL: 300,
        renderedContextMode: 'versioned',
        embeddingGeneration: 'delivery-fixture-v1',
      },
      consolidation: { autoApply: false, signalThreshold: 3 },
      exportPath: '',
    };
    // Only model output is synthetic; stores, queries, epochs, cache and assembly are real.
    const embedding = {
      available: true,
      embed: async () => vector,
      embedBatch: async (texts: string[]) => texts.map(() => vector),
    };
    function service(
      selectedCache = cache,
      selectedAuthority = authority,
      renderedContextMode: 'disabled' | 'versioned' = 'versioned',
    ) {
      return new AMPService(
        {
          cache: selectedCache,
          embeddings: new EmbeddingCache(redis),
          dedup: new DedupChecker(redis),
          signals: new SignalStream(redis),
          queue: new ConsolidationQueue(redis),
        },
        { episodic: new EpisodicStore(driver), query, fact: new FactStore(driver) },
        embedding,
        { ...config, cache: { ...config.cache, renderedContextMode } },
        undefined,
        undefined,
        undefined,
        selectedAuthority,
      );
    }
    function node(version: string, confidence: number): SemanticNode & { embedding: number[] } {
      return {
        id: `${tenant}-${version}`,
        content: `${version} ${suffix} policy evidence`,
        confidence,
        signal_count: version === 'v1' ? 100 : 1,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        decay_class: 'stable',
        memory_type: 'decision',
        tags: [project],
        scope: project,
        tenant_id: tenant,
        embedding: version === 'v1' ? vector : weakVector,
      };
    }
    const old = node('v1', 1);
    const current = node('v2', 0.6);
    await store.create(old);
    const scope = { task: `policy ${suffix}`, tags: [project], tenantId: tenant, max_tokens: 4000 };
    return {
      tenant,
      project,
      store,
      query,
      authority,
      cache,
      service,
      old,
      current,
      scope,
      supersede: () => store.supersede(old.id, current),
    };
  }

  function currentOnly(result: MemoryContext, f: Awaited<ReturnType<typeof fixture>>) {
    expect(result.degraded).toBeUndefined();
    expect(result.sources).toContain(f.current.id);
    expect(result.sources).not.toContain(f.old.id);
    expect(result.markdown).toContain(f.current.content);
    expect(result.markdown).not.toContain(f.old.content);
  }

  async function bindEntity(f: Awaited<ReturnType<typeof fixture>>) {
    const id = `${f.tenant}-entity`;
    const name = `${f.tenant}-component`;
    const session = driver.session();
    try {
      await session.run(
        `
        CREATE (root:Entity {id: $rootId, name: $projectName, type: 'project',
          project_scope: $project, tenant_id: $tenant, aliases: []})
        CREATE (entity:Entity {id: $id, name: $name, type: 'module',
          tenant_id: $tenant, aliases: [], tags: [$project]})
        CREATE (root)-[:CONTAINS]->(entity)
        WITH entity MATCH (old:Semantic {id: $oldId})
        CREATE (old)-[:ABOUT {valid_at: '2026-01-01T00:00:00.000Z'}]->(entity)
      `,
        {
          rootId: `${f.tenant}-root`,
          projectName: f.project.slice(8),
          project: f.project,
          tenant: f.tenant,
          id,
          name,
          oldId: f.old.id,
        },
      );
    } finally {
      await session.close();
    }
    return { id, name };
  }

  function feedbackRedis(): FeedbackRedisLayer {
    return {
      zincrby: async (key, increment, member) =>
        Number(await redis.zincrby(key, increment, member)),
      zrevrangeWithScores: async (key, start, stop) => {
        const pairs = await redis.zrevrange(key, start, stop, 'WITHSCORES');
        return Array.from({ length: pairs.length / 2 }, (_, index) => ({
          member: pairs[index * 2],
          score: Number(pairs[index * 2 + 1]),
        }));
      },
      lpush: (key, value) => redis.lpush(key, value),
      ltrim: async (key, start, stop) => {
        await redis.ltrim(key, start, stop);
      },
    };
  }

  it('filters obsolete strongest evidence through real ranked and deterministic retrieval assembly', async () => {
    const f = await fixture('retrieval');
    const entity = await bindEntity(f);
    await f.supersede();
    const assembler = new UnifiedAssembler(
      driver,
      feedbackRedis(),
      null,
      f.service(),
      {
        available: true,
        embed: async () => vector,
        embedBatch: async (texts) => texts.map(() => vector),
      },
      null,
      null,
      f.query,
    );
    for (const strategy of ['ranked', 'deterministic'] as const) {
      const result = await assembler.assemble(f.scope.task, {
        strategy,
        tenantId: f.tenant,
        project_name: f.project,
        tag_scope: [f.project],
        entity_scope: [entity.name],
        include_code: false,
        include_arch: false,
        include_memory: true,
        max_tokens: 4000,
      });
      const items = result.sections.flatMap((section) => section.items);
      expect(items.map((item) => item.id)).toContain(f.current.id);
      expect(items.map((item) => item.id)).not.toContain(f.old.id);
      expect(items.map((item) => item.content).join('\n')).not.toContain(f.old.content);
    }
    const historical = await assembler.assemble(f.scope.task, {
      strategy: 'deterministic',
      tenantId: f.tenant,
      project_name: f.project,
      entity_scope: [entity.name],
      as_of: '2026-02-01T00:00:00.000Z',
      max_tokens: 4000,
    });
    const items = historical.sections.flatMap((section) => section.items);
    expect(items.map((item) => item.id)).toContain(f.old.id);
    expect(items.map((item) => item.id)).not.toContain(f.current.id);
    expect(items.find((item) => item.id === f.old.id)?.metadata).toMatchObject({
      temporalStatus: 'historical',
      asOf: '2026-02-01T00:00:00.000Z',
    });
  }, 30_000);

  it('excludes superseded candidates through a real resolver receipt and runtime candidate channels', async () => {
    const f = await fixture('runtime');
    const entity = await bindEntity(f);
    await f.supersede();
    const receipt = await resolveRuntimeQueryPlannerAuthorityV1({
      authenticated: true,
      plannerEnabled: true,
      tenantId: f.tenant,
      projectName: f.project,
      entityScope: [entity.name],
      resolverFactory: (trusted) => {
        const resolver = new ScopedEntityResolver(driver, trusted);
        return { resolve: (plan) => resolver.resolve(plan) };
      },
    });
    const execution = await new RuntimeCandidateChannelService(driver, f.query, { legacyUnqualified: true }).execute(receipt, {
      includeArchitecture: false,
      includeMemory: true,
      queryText: f.scope.task,
      queryVector: vector,
    });
    for (const channel of ['memory.scope', 'memory.semantic-vector'] as const) {
      expect(
        execution.settlements.find((settlement) => settlement.channel === channel),
      ).toMatchObject({ outcome: 'success' });
      const ids = execution.candidates
        .filter((candidate) => candidate.channel === channel)
        .map((candidate) => candidate.evidenceId);
      expect(ids).toContain(f.current.id);
      expect(ids).not.toContain(f.old.id);
    }
  }, 30_000);

  it('preserves disputed current facts across all three real readers and assembled conflict groups', async () => {
    const f = await fixture('facts');
    const entity = await bindEntity(f);
    const store = new FactStore(driver);
    function fact(id: string, status: FactNode['status'], object: string): FactNode {
      return {
        id: `${f.tenant}-${id}`,
        subject: entity.name,
        entity_id: entity.id,
        predicate: 'primary_database',
        object,
        confidence: 0.9,
        status,
        inference_type: 'deductive',
        valid_at: '2026-01-01T00:00:00.000Z',
        invalid_at: null,
        source_episode_ids: [],
        supersedes_fact_id: null,
        scope: 'project',
        tenant_id: f.tenant,
        tags: [f.project],
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      };
    }
    const disputed = [
      fact('disputed-a', 'disputed', 'alpha'),
      fact('disputed-b', 'disputed', 'beta'),
    ];
    const active = { ...fact('active', 'active', 'gamma'), predicate: 'supports' };
    const invalid = {
      ...fact('invalid', 'invalidated', 'obsolete'),
      invalid_at: '2026-02-01T00:00:00.000Z',
    };
    const foreignTenant = `${f.tenant}-foreign`;
    tenants.push(foreignTenant);
    const foreign = { ...fact('foreign', 'disputed', 'foreign'), tenant_id: foreignTenant };
    const foreignProject = {
      ...fact('foreign-project', 'active', 'foreign-project-evidence'),
      tags: [`${f.project}-other`],
    };
    const unknownProject = {
      ...fact('unknown-project', 'active', 'unknown-project-evidence'),
      tags: [],
    };
    const ambiguousProject = fact('ambiguous-project', 'active', 'ambiguous-project-evidence');
    const deniedProjectFacts = [foreignProject, unknownProject, ambiguousProject];
    for (const value of [...disputed, active, invalid, foreign, ...deniedProjectFacts])
      await store.create(value);
    // Simulate legacy ambiguous authority, which the current writer rejects.
    const session = driver.session();
    try {
      await session.executeWrite(async (tx) => {
        await tx.run('MATCH (f:Fact {id: $id}) SET f.tags = $tags', {
          id: ambiguousProject.id,
          tags: [f.project, `${f.project}-other`],
        });
        await bumpKnowledgeEpoch(tx, { tenantId: f.tenant, projectScope: null });
      });
    } finally {
      await session.close();
    }
    const readers = [
      await store.getActive(entity.name, undefined, f.tenant),
      (await store.getActiveBatch([entity.name], undefined, f.tenant))[0],
      (await store.getActiveByEntityIdsBatch([entity.id], undefined, f.tenant))[0],
    ];
    for (const facts of readers) {
      expect(facts.map((value) => value.id).sort()).toEqual(
        [...disputed, active, ...deniedProjectFacts].map((value) => value.id).sort(),
      );
      expect(facts.filter((value) => value.status === 'disputed')).toHaveLength(2);
    }
    const scopedReaders = [
      await f.query.byFacts(entity.name, undefined, f.tenant, f.project),
      (await f.query.byEntityWithFacts(entity.name, undefined, f.tenant, f.project)).facts,
    ];
    for (const facts of scopedReaders) {
      expect(facts.map((value) => value.id).sort()).toEqual(
        [...disputed, active].map((value) => value.id).sort(),
      );
      expect(facts.filter((value) => value.status === 'disputed')).toHaveLength(2);
    }
    for (const mode of ['versioned', 'disabled'] as const) {
      const service = f.service(undefined, undefined, mode);
      for (const temporal of [
        undefined,
        { time_mode: 'historical' as const, as_of: '2026-03-01T00:00:00.000Z' },
      ]) {
        const result = await service.load({ ...f.scope, entities: [entity.name], temporal });
        if (!temporal) expect(result.markdown).toContain('Unresolved conflict:');
        for (const value of disputed) expect(result.sources).toContain(value.id);
        expect(result.sources).toContain(active.id);
        for (const denied of [invalid, foreign, ...deniedProjectFacts]) {
          expect(result.sources).not.toContain(denied.id);
          expect(result.markdown).not.toContain(denied.object);
        }
      }
    }
  }, 30_000);

  it('drops strongest obsolete evidence despite missed Redis invalidation and explicitly frames history', async () => {
    const f = await fixture('missed');
    const service = f.service();
    const writes = vi.spyOn(f.cache, 'set');
    const before = await service.load(f.scope);
    expect(before.sources).toContain(f.old.id);
    expect(writes).toHaveBeenCalledOnce();
    // Direct authoritative mutation intentionally sends no Redis invalidation.
    await f.supersede();
    const write = writes.mock.calls[0][0] as unknown as ContextCacheWrite;
    const raw = await redis.get(`amp:ctx:v2:${f.tenant}:${write.scopeHash}`);
    expect(raw).toContain(f.old.id);
    currentOnly(await service.load(f.scope), f);
    expect(writes).toHaveBeenCalledTimes(2);
    const historical = await service.load({
      ...f.scope,
      temporal: { time_mode: 'historical', as_of: '2026-02-01T00:00:00.000Z' },
    });
    expect(historical.sources).toContain(f.old.id);
    expect(historical.sources).not.toContain(f.current.id);
    expect(historical.markdown).toContain('Historical memory frame: 2026-02-01T00:00:00.000Z');
  }, 30_000);

  it('rechecks authority after reading a real Redis cache hit', async () => {
    const f = await fixture('hit');
    const service = f.service();
    expect((await service.load(f.scope)).sources).toContain(f.old.id);
    const get = f.cache.get.bind(f.cache);
    const spy = vi.spyOn(f.cache, 'get').mockImplementationOnce(async (read) => {
      const hit = await get(read as ContextCacheRead);
      expect(hit?.sources).toContain(f.old.id);
      await f.supersede();
      return hit;
    });
    currentOnly(await service.load(f.scope), f);
    expect(spy).toHaveBeenCalledTimes(2);
  }, 30_000);

  it('discards work assembled across a real source mutation and retries', async () => {
    const f = await fixture('assembly');
    const service = f.service();
    const queried = latch();
    const resume = latch();
    const byScope = f.query.byScope.bind(f.query);
    const spy = vi.spyOn(f.query, 'byScope').mockImplementationOnce(async (scope) => {
      const rows = await byScope(scope);
      expect(rows.map((row) => row.id)).toContain(f.old.id);
      queried.release();
      await resume.promise;
      return rows;
    });
    const pending = service.load(f.scope);
    try {
      await queried.promise;
      await f.supersede();
    } finally {
      resume.release();
    }
    currentOnly(await pending, f);
    expect(spy).toHaveBeenCalledTimes(2);
  }, 30_000);

  it('rejects stale in-flight cache publication after a newer worker advances the Redis fence', async () => {
    const f = await fixture('worker');
    const publishing = latch();
    const resume = latch();
    const set = f.cache.set.bind(f.cache);
    vi.spyOn(
      f.cache as { set(write: ContextCacheWrite): Promise<boolean> },
      'set',
    ).mockImplementationOnce(async (write) => {
      publishing.release();
      await resume.promise;
      return set(write);
    });
    const stale = f.service().load(f.scope);
    const newerCache = new ContextCache(redis, { mode: 'versioned' });
    const newerService = f.service(newerCache);
    try {
      await publishing.promise;
      await f.supersede();
      currentOnly(await newerService.load(f.scope), f);
    } finally {
      resume.release();
    }
    await expect(stale).resolves.toMatchObject({
      markdown: '',
      sources: [],
      degraded: { code: 'knowledge-epoch-changed' },
    });
    currentOnly(await newerService.load(f.scope), f);
  }, 30_000);

  it('does not return cached bytes when the real Neo4j authority becomes unavailable', async () => {
    const f = await fixture('unavailable');
    const isolated = createNeo4jDriver(
      process.env.NEO4J_URI!,
      process.env.NEO4J_USER!,
      process.env.NEO4J_PASSWORD!,
    );
    extraDrivers.push(isolated);
    const service = f.service(f.cache, new KnowledgeEpochStore(isolated));
    expect((await service.load(f.scope)).sources).toContain(f.old.id);
    await isolated.close();
    await expect(service.load(f.scope)).resolves.toMatchObject({
      markdown: '',
      sources: [],
      degraded: { code: 'knowledge-epoch-unavailable' },
    });
  }, 30_000);
});
