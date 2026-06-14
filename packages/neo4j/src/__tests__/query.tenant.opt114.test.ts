// packages/neo4j/src/__tests__/query.tenant.opt114.test.ts
//
// OPT-114: byEntity, byTag, and the Semantic+Episodic halves of byEntityWithFacts
// previously omitted tenantWhere (their siblings byScope/byVector/byFacts enforce
// it). No production callers today — defense-in-depth — but a future caller must
// not be able to reintroduce a cross-tenant read. Adversarial live-Neo4j check
// (skips when unreachable; the CI integration job provides one).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createNeo4jDriver } from '../driver.js';
import { ScopedQuery } from '../query.js';
import { runMigrations } from '../migrations.js';

const NEO4J_URI = process.env.NEO4J_URI || 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || 'password';

const TAG = '__q114_tenanttest__';
const ENTITY = '__q114_entity__';

async function reachable(driver: ReturnType<typeof createNeo4jDriver>): Promise<boolean> {
  try { await driver.getServerInfo(); return true; } catch { return false; }
}

describe('OPT-114: byEntity/byTag/byEntityWithFacts tenant isolation (adversarial)', () => {
  const driver = createNeo4jDriver(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
  const query = new ScopedQuery(driver);
  let ok = false;

  beforeAll(async () => {
    ok = await reachable(driver);
    if (!ok) { console.warn('[skip] Neo4j not reachable — skipping OPT-114 tenant isolation tests'); return; }
    await runMigrations(driver);
    const now = new Date().toISOString();
    const sem = (id: string, conf: number, tenant?: string) =>
      `{id:'${id}', content:'${id}', confidence:${conf}, signal_count:0, created_at:'${now}', updated_at:'${now}', decay_class:'stable', tags:['${TAG}']${tenant ? `, tenant_id:'${tenant}'` : ''}}`;
    const ep = (id: string, tenant?: string) =>
      `{id:'${id}', session_id:'s', agent_id:'a', task:'t', content:'${id}', created_at:'${now}', tags:['${TAG}']${tenant ? `, tenant_id:'${tenant}'` : ''}}`;
    const s = driver.session();
    try {
      await s.run(
        `CREATE (e:Entity {name:$ename, tags:[$tag]})
         CREATE (sA:Semantic ${sem(`${TAG}-semA`, 0.9, 'tenantA')})
         CREATE (sB:Semantic ${sem(`${TAG}-semB`, 0.8, 'tenantB')})
         CREATE (sL:Semantic ${sem(`${TAG}-semL`, 0.7)})
         CREATE (sA)-[:ABOUT]->(e)
         CREATE (sB)-[:ABOUT]->(e)
         CREATE (sL)-[:ABOUT]->(e)
         CREATE (epA:Episodic ${ep(`${TAG}-epA`, 'tenantA')})
         CREATE (epB:Episodic ${ep(`${TAG}-epB`, 'tenantB')})
         CREATE (epL:Episodic ${ep(`${TAG}-epL`)})
         CREATE (epA)-[:REFERENCES]->(e)
         CREATE (epB)-[:REFERENCES]->(e)
         CREATE (epL)-[:REFERENCES]->(e)`,
        { ename: ENTITY, tag: TAG },
      );
    } finally { await s.close(); }
  });

  afterAll(async () => {
    if (ok) {
      const s = driver.session();
      try { await s.run(`MATCH (n) WHERE $tag IN n.tags OR n.name = $ename DETACH DELETE n`, { tag: TAG, ename: ENTITY }); }
      finally { await s.close(); }
    }
    await driver.close().catch(() => {});
  });

  it('byEntity: a named tenant sees only its own semantics; default sees legacy not named', async () => {
    if (!ok) return;
    const a = (await query.byEntity(ENTITY, 50, undefined, 'tenantA')).map((n) => n.id);
    expect(a).toContain(`${TAG}-semA`);
    expect(a).not.toContain(`${TAG}-semB`);
    expect(a).not.toContain(`${TAG}-semL`);

    const d = (await query.byEntity(ENTITY, 50, undefined, 'default')).map((n) => n.id);
    expect(d).toContain(`${TAG}-semL`);
    expect(d).not.toContain(`${TAG}-semA`);
    expect(d).not.toContain(`${TAG}-semB`);
  });

  it('byEntity: no tenantId behaves as default (single-tenant output-identity: legacy visible)', async () => {
    if (!ok) return;
    const d = (await query.byEntity(ENTITY, 50)).map((n) => n.id);
    expect(d).toContain(`${TAG}-semL`);
  });

  it('byTag: a named tenant sees only its own tagged semantics; default sees legacy not named', async () => {
    if (!ok) return;
    const b = (await query.byTag(TAG, 50, 'tenantB')).map((n) => n.id);
    expect(b).toContain(`${TAG}-semB`);
    expect(b).not.toContain(`${TAG}-semA`);
    expect(b).not.toContain(`${TAG}-semL`);

    const d = (await query.byTag(TAG, 50, 'default')).map((n) => n.id);
    expect(d).toContain(`${TAG}-semL`);
    expect(d).not.toContain(`${TAG}-semA`);
    expect(d).not.toContain(`${TAG}-semB`);
  });

  it('byEntityWithFacts: semantics AND episodes are tenant-scoped', async () => {
    if (!ok) return;
    const a = await query.byEntityWithFacts(ENTITY, undefined, 'tenantA');
    const aSem = a.semantics.map((n) => n.id);
    const aEp = a.episodes.map((n) => n.id);
    expect(aSem).toContain(`${TAG}-semA`);
    expect(aSem).not.toContain(`${TAG}-semB`);
    expect(aSem).not.toContain(`${TAG}-semL`);
    expect(aEp).toContain(`${TAG}-epA`);
    expect(aEp).not.toContain(`${TAG}-epB`);
    expect(aEp).not.toContain(`${TAG}-epL`);

    const d = await query.byEntityWithFacts(ENTITY, undefined, 'default');
    expect(d.semantics.map((n) => n.id)).toContain(`${TAG}-semL`);
    expect(d.semantics.map((n) => n.id)).not.toContain(`${TAG}-semA`);
    expect(d.episodes.map((n) => n.id)).toContain(`${TAG}-epL`);
    expect(d.episodes.map((n) => n.id)).not.toContain(`${TAG}-epA`);
  });
});
