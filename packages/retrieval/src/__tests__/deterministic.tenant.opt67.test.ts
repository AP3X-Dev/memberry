// packages/retrieval/src/__tests__/deterministic.tenant.opt67.test.ts
//
// OPT-67: the DeterministicAssembler's semantic read (Semantic is a tenant-scoped
// node) must enforce data-layer tenant isolation, not rely solely on the tools.ts
// routing guard. Adversarial check against a live Neo4j (skips when unreachable;
// the CI integration job provides one). Entity/Aspect are shared arch nodes and
// are intentionally NOT tenant-scoped, so this seeds ONE shared Entity and three
// Semantics (tenantA / tenantB / legacy) ABOUT it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createNeo4jDriver, runMigrations } from '@memberry/neo4j';
import { DeterministicAssembler } from '../deterministic.js';

const NEO4J_URI = process.env.NEO4J_URI || 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || 'password';

const TAG = '__det_tenanttest__';     // unique marker for cleanup
const ENTITY = '__det_tenanttest_entity__';

async function reachable(driver: ReturnType<typeof createNeo4jDriver>): Promise<boolean> {
  try { await driver.getServerInfo(); return true; } catch { return false; }
}

/** Flatten the 'Semantic Knowledge' section's item contents. */
function semanticContents(sections: Awaited<ReturnType<DeterministicAssembler['assemble']>>): string[] {
  const sec = sections.find((s) => s.source_type === 'semantic');
  return (sec?.items ?? []).map((i) => i.content);
}

describe('OPT-67: DeterministicAssembler tenant isolation (adversarial)', () => {
  const driver = createNeo4jDriver(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
  const assembler = new DeterministicAssembler(driver);
  let ok = false;

  beforeAll(async () => {
    ok = await reachable(driver);
    if (!ok) { console.warn('[skip] Neo4j not reachable — skipping deterministic tenant isolation tests'); return; }
    await runMigrations(driver);
    const s = driver.session();
    try {
      // One SHARED Entity (no tenant_id — arch nodes are shared by design) plus
      // three Semantics ABOUT it: tenant A, tenant B, and a legacy (no tenant_id).
      await s.run(
        `CREATE (e:Entity {id:$eid, name:$ename, type:'module', created_at:$now})
         CREATE (a:Semantic {id:$a, content:'A secret', confidence:0.9, signal_count:0,
            created_at:$now, updated_at:$now, decay_class:'stable', tags:[$tag], tenant_id:'tenantA'})
         CREATE (b:Semantic {id:$b, content:'B secret', confidence:0.8, signal_count:0,
            created_at:$now, updated_at:$now, decay_class:'stable', tags:[$tag], tenant_id:'tenantB'})
         CREATE (l:Semantic {id:$l, content:'legacy note', confidence:0.7, signal_count:0,
            created_at:$now, updated_at:$now, decay_class:'stable', tags:[$tag]})
         CREATE (a)-[:ABOUT]->(e)
         CREATE (b)-[:ABOUT]->(e)
         CREATE (l)-[:ABOUT]->(e)`,
        {
          eid: `${TAG}-eid`, ename: ENTITY,
          a: `${TAG}-A`, b: `${TAG}-B`, l: `${TAG}-legacy`,
          tag: TAG, now: new Date().toISOString(),
        },
      );
    } finally { await s.close(); }
  });

  afterAll(async () => {
    if (ok) {
      const s = driver.session();
      try {
        await s.run(`MATCH (n) WHERE $tag IN n.tags OR n.name = $ename DETACH DELETE n`,
          { tag: TAG, ename: ENTITY });
      } finally { await s.close(); }
    }
    await driver.close().catch(() => {});
  });

  it('a named tenant sees ONLY its own semantics (not other tenants, not legacy)', async () => {
    if (!ok) return;
    const a = semanticContents(await assembler.assemble('ignored', { entity_scope: [ENTITY], tenantId: 'tenantA' }));
    expect(a).toContain('A secret');
    expect(a).not.toContain('B secret');     // never another tenant
    expect(a).not.toContain('legacy note');  // named tenant: strict, no legacy

    const b = semanticContents(await assembler.assemble('ignored', { entity_scope: [ENTITY], tenantId: 'tenantB' }));
    expect(b).toContain('B secret');
    expect(b).not.toContain('A secret');
  });

  it('the default tenant sees legacy (null-tenant) semantics but NOT named tenants', async () => {
    if (!ok) return;
    const d = semanticContents(await assembler.assemble('ignored', { entity_scope: [ENTITY], tenantId: 'default' }));
    expect(d).toContain('legacy note');
    expect(d).not.toContain('A secret');
    expect(d).not.toContain('B secret');
  });

  it('no tenantId behaves as the default tenant (single-tenant output-identity: legacy still visible)', async () => {
    if (!ok) return;
    const d = semanticContents(await assembler.assemble('ignored', { entity_scope: [ENTITY] }));
    expect(d).toContain('legacy note'); // legacy/no-tenant data is unchanged for single-tenant callers
  });
});
