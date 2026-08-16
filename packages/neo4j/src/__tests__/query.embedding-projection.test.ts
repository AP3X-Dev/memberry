// packages/neo4j/src/__tests__/query.embedding-projection.test.ts
// Semantic read paths must NOT ship the 1536-float embedding over the wire.
// byScope / byVector / byEntity / byTag / expandByGraph use map-projection cyphers
// (s {.*, embedding: null}) so the large vector — which no consumer of these reads
// uses (GDS reads the stored property via its own Cypher; getById/getByIds keep it)
// — is excluded from the Bolt payload. Output-identical for every other field.
//
// Live test: requires a reachable Neo4j (skips otherwise, like query.test.ts).
import { int } from 'neo4j-driver';
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { createNeo4jDriver } from '../driver.js';
import { ScopedQuery } from '../query.js';
import { EMBEDDING_DIM } from '@memberry/core';

const NEO4J_URI = process.env.NEO4J_URI || 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || 'password';

async function isNeo4jReachable(): Promise<boolean> {
  const probe = createNeo4jDriver(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
  try {
    await probe.getServerInfo();
    return true;
  } catch {
    return false;
  } finally {
    await probe.close().catch(() => {});
  }
}

const ID = 'qep-sem-1';
const ENTITY = 'qep-entity';
const TAG = 'qep-tag';
// Distinctive unit vector → cosine 1.0 with itself, so byVector ranks it #1.
const EMB = (() => { const v = new Array(EMBEDDING_DIM).fill(0); v[0] = 1; return v; })();

function fakeSemanticProps(signalCount: unknown) {
  return {
    id: 'fake-semantic',
    content: 'fake semantic content',
    confidence: 0.9,
    signal_count: signalCount,
    created_at: '2024-01-01',
    updated_at: '2024-01-02',
    decay_class: 'stable',
    tags: ['project:test'],
  };
}

describe('semantic Integer mapping through ScopedQuery', () => {
  it('normalizes an official Integer through byScope', async () => {
    const props = fakeSemanticProps(int(7));
    const close = vi.fn(async () => undefined);
    const run = vi.fn(async () => ({
      records: [{ get: () => props }],
    }));
    const query = new ScopedQuery({ session: () => ({ run, close }) } as never);

    const [mapped] = await query.byScope({ limit: 1 });

    expect(mapped.signal_count).toBe(7);
    expect(typeof mapped.signal_count).toBe('number');
    expect(close).toHaveBeenCalledOnce();
  });

  it('normalizes an official Integer through byVector', async () => {
    const props = fakeSemanticProps(int(8));
    const close = vi.fn(async () => undefined);
    const run = vi.fn(async () => ({
      records: [{
        get: (key: string) => key === 'score' ? 0.75 : props,
      }],
    }));
    const query = new ScopedQuery({ session: () => ({ run, close }) } as never);

    const [mapped] = await query.byVector([0.1], 1);

    expect(mapped.signal_count).toBe(8);
    expect(typeof mapped.signal_count).toBe('number');
    expect(mapped.score).toBe(0.75);
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('semantic reads project away the embedding vector', () => {
  let available = false;
  const driver = createNeo4jDriver(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
  let query: ScopedQuery;

  beforeAll(async () => {
    available = await isNeo4jReachable();
    if (!available) {
      console.warn(`[skip] Neo4j not reachable at ${NEO4J_URI} — skipping embedding-projection tests`);
      return;
    }
    const session = driver.session();
    try {
      await session.run(`MATCH (n) WHERE n.id IN $ids DETACH DELETE n`, { ids: [ID, 'qep-ent'] });
      await session.run(`MATCH (e:Entity {name: $name}) DETACH DELETE e`, { name: ENTITY });
      await session.run(
        `CREATE (s:Semantic {
           id: $id, content: 'embedding projection probe',
           confidence: 0.91, signal_count: 1,
           created_at: '2024-01-01', updated_at: '2024-01-02',
           decay_class: 'stable', tags: $tags, embedding: $emb
         })`,
        { id: ID, tags: [TAG], emb: EMB },
      );
      await session.run(
        `CREATE (e:Entity {id: 'qep-ent', name: $name, type: 'test', created_at: '2024-01-01'})`,
        { name: ENTITY },
      );
      await session.run(
        `MATCH (s:Semantic {id: $id}), (e:Entity {name: $name}) MERGE (s)-[:ABOUT]->(e)`,
        { id: ID, name: ENTITY },
      );
    } finally {
      await session.close();
    }
    query = new ScopedQuery(driver);
  });

  afterAll(async () => {
    if (available) {
      const session = driver.session();
      try {
        await session.run(`MATCH (n) WHERE n.id IN $ids DETACH DELETE n`, { ids: [ID, 'qep-ent'] });
        await session.run(`MATCH (e:Entity {name: $name}) DETACH DELETE e`, { name: ENTITY });
      } finally {
        await session.close();
      }
    }
    await driver.close().catch(() => {});
  });

  it('byEntity drops embedding but keeps all other fields', async () => {
    if (!available) return;
    const [s] = await query.byEntity(ENTITY, 10);
    expect(s).toBeDefined();
    expect(s!.id).toBe(ID);
    expect(s!.embedding).toBeUndefined();
    // every other mapped field survives the projection
    expect(s!.content).toBe('embedding projection probe');
    expect(s!.confidence).toBeCloseTo(0.91, 5);
    // The trusted record mapper normalizes Neo4j's lossless Integer before the
    // Semantic leaves this package.
    expect(s!.signal_count).toBe(1);
    expect(typeof s!.signal_count).toBe('number');
    expect(s!.decay_class).toBe('stable');
    expect(s!.tags).toContain(TAG);
    expect(s!.created_at).toBe('2024-01-01');
    expect(s!.updated_at).toBe('2024-01-02');
  });

  it('byTag drops embedding', async () => {
    if (!available) return;
    const got = await query.byTag(TAG, 10);
    const s = got.find((r) => r.id === ID);
    expect(s).toBeDefined();
    expect(s!.embedding).toBeUndefined();
  });

  it('byScope (entity filter) drops embedding', async () => {
    if (!available) return;
    const got = await query.byScope({ entities: [ENTITY], limit: 10 });
    const s = got.find((r) => r.id === ID);
    expect(s).toBeDefined();
    expect(s!.embedding).toBeUndefined();
    expect(s!.signal_count).toBe(1);
    expect(typeof s!.signal_count).toBe('number');
  });

  it('byScope (tag filter, DISTINCT) drops embedding', async () => {
    if (!available) return;
    const got = await query.byScope({ tags: [TAG], limit: 10 });
    const s = got.find((r) => r.id === ID);
    expect(s).toBeDefined();
    expect(s!.embedding).toBeUndefined();
  });

  it('byScope (entity + tag, DISTINCT) drops embedding and preserves ordering fields', async () => {
    if (!available) return;
    const got = await query.byScope({ entities: [ENTITY], tags: [TAG], limit: 10 });
    const s = got.find((r) => r.id === ID);
    expect(s).toBeDefined();
    expect(s!.embedding).toBeUndefined();
    expect(s!.confidence).toBeCloseTo(0.91, 5);
  });

  it('byVector drops embedding on every returned node', async () => {
    if (!available) return;
    const got = await query.byVector(EMB, 25);
    // The probe (cosine 1.0 with itself) must be in the results…
    const mine = got.find((r) => r.id === ID);
    expect(mine).toBeDefined();
    expect(mine!.score).toBeGreaterThan(0.99);
    expect(mine!.signal_count).toBe(1);
    expect(typeof mine!.signal_count).toBe('number');
    // …and NO returned node carries an embedding (it searched BY embedding then
    // would otherwise echo every match's 1536-float vector straight back).
    for (const r of got) {
      expect(r.embedding).toBeUndefined();
    }
  });
});
