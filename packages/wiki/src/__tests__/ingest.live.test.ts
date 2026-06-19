// packages/wiki/src/__tests__/ingest.live.test.ts
// OPT-3: live-Neo4j proof that IngestionService links a Source/Entity ONLY to the
// EXACT-named project, never to a sibling project whose name merely CONTAINS it.
//
// Before the fix, linkSourceToProject / linkEntityToProject matched the project
// with `WHERE p.name CONTAINS $projectName`, so ingesting for "<run>app" also
// linked the unrelated "<run>appendix" project (whose name contains "<run>app").
// The fix matches `{name: $projectName, type: 'project'}` exactly.
//
// Skipped when Neo4j is unreachable (mirrors the probe/skip pattern in
// queries.live.test.ts and bootstrap-graph.regression.test.ts). A mock driver
// cannot catch a CONTAINS-vs-exact difference, so this MUST be a live test.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';
import { IngestionService } from '../ingest.js';

const NEO4J_URI = process.env.NEO4J_URI || 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || 'password';

function createDriver(): Driver {
  return neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD), {
    maxConnectionPoolSize: 50,
    connectionAcquisitionTimeout: 10000,
  });
}

async function isNeo4jReachable(): Promise<boolean> {
  const probe = createDriver();
  try {
    await probe.getServerInfo();
    return true;
  } catch {
    return false;
  } finally {
    await probe.close().catch(() => {});
  }
}

// Unique per-run names so the two projects can't collide with other runs/tests.
// SIBLING_NAME is a strict superstring of TARGET_NAME (TARGET is a substring of
// SIBLING) — exactly the cross-link trap the old CONTAINS match fell into.
const RUN = `opt3ingest${Date.now()}`;
const TARGET_NAME = `${RUN}app`;
const SIBLING_NAME = `${RUN}appendix`; // contains TARGET_NAME as a substring
const TARGET_TAG = `project:${TARGET_NAME}`;
const ENTITY_NAME = `${RUN}-widget`; // a dump entity linked under the project

describe('IngestionService OPT-3 (link only the exact-named project, live Neo4j)', () => {
  let neo4jAvailable = false;
  const driver = createDriver();

  beforeAll(async () => {
    neo4jAvailable = await isNeo4jReachable();
    if (!neo4jAvailable) {
      console.warn(`[skip] Neo4j not reachable at ${NEO4J_URI} — skipping OPT-3 ingest tests`);
      return;
    }
    const session = driver.session();
    try {
      // Two DISTINCT project Entities coexist. The sibling's name CONTAINS the
      // target's name, so a substring match would wrongly pick it up too.
      await session.run(
        `CREATE (:Entity {id: $id, name: $name, type: 'project', created_at: $now})`,
        { id: `${RUN}-target`, name: TARGET_NAME, now: new Date().toISOString() },
      );
      await session.run(
        `CREATE (:Entity {id: $id, name: $name, type: 'project', created_at: $now})`,
        { id: `${RUN}-sibling`, name: SIBLING_NAME, now: new Date().toISOString() },
      );
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    if (neo4jAvailable) {
      const session = driver.session();
      try {
        // Clean only this run's nodes (unique RUN prefix on every name/id).
        await session.run(
          `MATCH (n) WHERE n.name STARTS WITH $run OR n.id STARTS WITH $run DETACH DELETE n`,
          { run: RUN },
        );
        // Sources carry the project_tag, not a RUN-prefixed name — delete by tag.
        await session.run(
          `MATCH (s:Source) WHERE s.project_tag = $tag DETACH DELETE s`,
          { tag: TARGET_TAG },
        );
        // Semantic claims created by the ingest carry the project tag.
        await session.run(
          `MATCH (s:Semantic) WHERE $tag IN s.tags DETACH DELETE s`,
          { tag: TARGET_TAG },
        );
      } finally {
        await session.close();
      }
    }
    await driver.close().catch(() => {});
  });

  async function countLinked(rel: string, projectName: string): Promise<number> {
    const session = driver.session();
    try {
      const res = await session.run(
        `MATCH (p:Entity {name: $name, type: 'project'})-[:${rel}]->() RETURN count(*) AS cnt`,
        { name: projectName },
      );
      const cnt = res.records[0].get('cnt') as { toNumber: () => number } | number;
      return typeof cnt === 'object' ? cnt.toNumber() : cnt;
    } finally {
      await session.close();
    }
  }

  it('links the Source (HAS_SOURCE) and dump entity (CONTAINS) ONLY to the exact project', async () => {
    if (!neo4jAvailable) return;

    const service = new IngestionService(driver);
    await service.ingest({
      content: `# ${TARGET_NAME} notes\n\nThe ${ENTITY_NAME} component does a thing.`,
      source_type: 'note',
      project_tag: TARGET_TAG,
      entities: [ENTITY_NAME],
      // ensure_project drives BOTH link paths: linkSourceToProject (always) and
      // linkEntityToProject (only under ensure_project) — the two CONTAINS sites.
      ensure_project: true,
    });

    // Exact project gets exactly one HAS_SOURCE and at least one CONTAINS edge.
    expect(await countLinked('HAS_SOURCE', TARGET_NAME)).toBe(1);
    expect(await countLinked('CONTAINS', TARGET_NAME)).toBeGreaterThanOrEqual(1);

    // The substring-sibling project must receive NEITHER edge. Under the old
    // `p.name CONTAINS $projectName` match it got both (the regression).
    expect(await countLinked('HAS_SOURCE', SIBLING_NAME)).toBe(0);
    expect(await countLinked('CONTAINS', SIBLING_NAME)).toBe(0);
  });
});
