// Explicit legacy vector fixtures below are unqualified historical compatibility evidence.
// packages/neo4j/src/__tests__/expand.tenant.opt113.test.ts
//
// OPT-113: ScopedQuery.expandByGraph is reachable via berry_load and previously
// returned Semantic neighbors with NO tenant filter — a LIVE cross-tenant read
// leak in multi-tenant deployments that share a project scope (the downstream
// inProjectScope guard filters scope/tag, not tenant_id). Both expansion paths
// (semantic-neighbor and co-episode fact-neighbor) must now scope the RETURNED
// Semantic to the caller's tenant. Adversarial live-Neo4j check (skips when
// unreachable; the CI integration job provides one).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createNeo4jDriver } from '../driver.js';
import { ScopedQuery } from '../query.js';
import { runMigrations } from '../migrations.js';

const NEO4J_URI = process.env.NEO4J_URI || 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || 'password';

const TAG = '__expand_tenanttest__';
const X = '__expand_seed_sem__';   // seed for the semantic-neighbor path
const Y = '__expand_neighbor_sem__';
const W = '__expand_seed_fact__';  // seed for the fact-neighbor path
const Z = '__expand_neighbor_fact__';

async function reachable(driver: ReturnType<typeof createNeo4jDriver>): Promise<boolean> {
  try { await driver.getServerInfo(); return true; } catch { return false; }
}

describe('OPT-113: expandByGraph tenant isolation (adversarial)', () => {
  const driver = createNeo4jDriver(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
  const query = new ScopedQuery(driver, { legacyUnqualified: true });
  let ok = false;

  beforeAll(async () => {
    ok = await reachable(driver);
    if (!ok) { console.warn('[skip] Neo4j not reachable — skipping expandByGraph tenant isolation tests'); return; }
    await runMigrations(driver);
    const now = new Date().toISOString();
    const sem = (id: string, content: string, conf: number, tenant?: string) =>
      `{id:'${id}', content:'${content}', confidence:${conf}, signal_count:0, created_at:'${now}', updated_at:'${now}', decay_class:'stable', tags:['${TAG}']${tenant ? `, tenant_id:'${tenant}'` : ''}}`;
    const s = driver.session();
    try {
      // Path 1 uses separate tenant-owned copies of every endpoint.
      await s.run(
        `CREATE (eXA:Entity {name:$x, tags:[$tag], tenant_id:'tenantA'})
         CREATE (eYA:Entity {name:$y, tags:[$tag], tenant_id:'tenantA'})
         CREATE (eXB:Entity {name:$x, tags:[$tag], tenant_id:'tenantB'})
         CREATE (eYB:Entity {name:$y, tags:[$tag], tenant_id:'tenantB'})
         CREATE (eXL:Entity {name:$x, tags:[$tag]})
         CREATE (eYL:Entity {name:$y, tags:[$tag]})
         CREATE (bridgeA:Semantic ${sem(`${TAG}-bridgeA`, 'bridge A', 0.95, 'tenantA')})
         CREATE (bridgeB:Semantic ${sem(`${TAG}-bridgeB`, 'bridge B', 0.95, 'tenantB')})
         CREATE (bridgeL:Semantic ${sem(`${TAG}-bridgeL`, 'bridge legacy', 0.95)})
         CREATE (sA:Semantic ${sem(`${TAG}-semA`, 'sem A secret', 0.9, 'tenantA')})
         CREATE (sB:Semantic ${sem(`${TAG}-semB`, 'sem B secret', 0.8, 'tenantB')})
         CREATE (sL:Semantic ${sem(`${TAG}-semL`, 'sem legacy', 0.7)})
         CREATE (bridgeA)-[:ABOUT]->(eXA)
         CREATE (bridgeA)-[:ABOUT]->(eYA)
         CREATE (bridgeB)-[:ABOUT]->(eXB)
         CREATE (bridgeB)-[:ABOUT]->(eYB)
         CREATE (bridgeL)-[:ABOUT]->(eXL)
         CREATE (bridgeL)-[:ABOUT]->(eYL)
         CREATE (sA)-[:ABOUT]->(eYA)
         CREATE (sB)-[:ABOUT]->(eYB)
         CREATE (sL)-[:ABOUT]->(eYL)`,
        { x: X, y: Y, tag: TAG },
      );
      // Path 2 also gives every Entity/Fact/Semantic endpoint an authority lane.
      await s.run(
        `CREATE (eWA:Entity {name:$w, tags:[$tag], tenant_id:'tenantA'})
         CREATE (eZA:Entity {name:$z, tags:[$tag], tenant_id:'tenantA'})
         CREATE (eWB:Entity {name:$w, tags:[$tag], tenant_id:'tenantB'})
         CREATE (eZB:Entity {name:$z, tags:[$tag], tenant_id:'tenantB'})
         CREATE (f1A:Fact {id:$f1a, tags:[$tag], tenant_id:'tenantA'})
         CREATE (f2A:Fact {id:$f2a, tags:[$tag], tenant_id:'tenantA'})
         CREATE (f1B:Fact {id:$f1b, tags:[$tag], tenant_id:'tenantB'})
         CREATE (f2B:Fact {id:$f2b, tags:[$tag], tenant_id:'tenantB'})
         CREATE (fA:Semantic ${sem(`${TAG}-factA`, 'fact A secret', 0.9, 'tenantA')})
         CREATE (fB:Semantic ${sem(`${TAG}-factB`, 'fact B secret', 0.8, 'tenantB')})
         CREATE (f1A)-[:FACT_ABOUT]->(eWA)
         CREATE (f2A)-[:FACT_ABOUT]->(eZA)
         CREATE (f1A)-[:SAME_EPISODE]->(f2A)
         CREATE (f1B)-[:FACT_ABOUT]->(eWB)
         CREATE (f2B)-[:FACT_ABOUT]->(eZB)
         CREATE (f1B)-[:SAME_EPISODE]->(f2B)
         CREATE (fA)-[:ABOUT]->(eZA)
         CREATE (fB)-[:ABOUT]->(eZB)`,
        {
          w: W,
          z: Z,
          f1a: `${TAG}-f1a`,
          f2a: `${TAG}-f2a`,
          f1b: `${TAG}-f1b`,
          f2b: `${TAG}-f2b`,
          tag: TAG,
        },
      );
    } finally { await s.close(); }
  });

  afterAll(async () => {
    if (ok) {
      const s = driver.session();
      try { await s.run(`MATCH (n) WHERE $tag IN n.tags DETACH DELETE n`, { tag: TAG }); }
      finally { await s.close(); }
    }
    await driver.close().catch(() => {});
  });

  it('semantic-neighbor path: a named tenant expands only to its own semantics', async () => {
    if (!ok) return;
    const a = (await query.expandByGraph([X], 1, 5, undefined, 'tenantA')).map((n) => n.id);
    expect(a).toContain(`${TAG}-semA`);
    expect(a).not.toContain(`${TAG}-semB`);
    expect(a).not.toContain(`${TAG}-semL`);

    const b = (await query.expandByGraph([X], 1, 5, undefined, 'tenantB')).map((n) => n.id);
    expect(b).toContain(`${TAG}-semB`);
    expect(b).not.toContain(`${TAG}-semA`);
  });

  it('fact-neighbor path: a named tenant expands only to its own semantics', async () => {
    if (!ok) return;
    const a = (await query.expandByGraph([W], 1, 5, undefined, 'tenantA')).map((n) => n.id);
    expect(a).toContain(`${TAG}-factA`);
    expect(a).not.toContain(`${TAG}-factB`);
    expect(a).not.toContain(`${TAG}-factL`);
  });

  it('the default tenant expands to legacy (null-tenant) semantics but NOT named tenants', async () => {
    if (!ok) return;
    const d = (await query.expandByGraph([X], 1, 5, undefined, 'default')).map((n) => n.id);
    expect(d).toContain(`${TAG}-semL`);
    expect(d).not.toContain(`${TAG}-semA`);
    expect(d).not.toContain(`${TAG}-semB`);
  });

  it('no tenantId behaves as default (single-tenant output-identity: legacy still expanded)', async () => {
    if (!ok) return;
    const d = (await query.expandByGraph([X], 1, 5)).map((n) => n.id);
    expect(d).toContain(`${TAG}-semL`); // legacy/no-tenant neighbor unchanged for single-tenant callers
  });
});
