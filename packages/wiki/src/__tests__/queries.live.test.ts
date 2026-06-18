// packages/wiki/src/__tests__/queries.live.test.ts
// gap-13: live-Neo4j tests proving structured ep.scope/ep.tags is the canonical
// project association for wiki episodic discovery, with the legacy `[project:…]`
// task prefix retained only as a fallback. Skipped when Neo4j is unreachable
// (mirrors the skip pattern in packages/neo4j/src/__tests__/semantic.test.ts).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';
import { fetchEpisodicsForProject } from '../queries.js';

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

const TEST_PREFIX = `test-wiki-gap13-${Date.now()}`;
const STRUCTURED_ID = `${TEST_PREFIX}-structured`;
const LEGACY_ID = `${TEST_PREFIX}-legacy`;
const UNDERSCORE_ID = `${TEST_PREFIX}-underscore`;

describe('fetchEpisodicsForProject (gap-13, live Neo4j)', () => {
  let neo4jAvailable = false;
  const driver = createDriver();

  beforeAll(async () => {
    neo4jAvailable = await isNeo4jReachable();
    if (!neo4jAvailable) {
      console.warn(`[skip] Neo4j not reachable at ${NEO4J_URI} — skipping gap-13 live tests`);
      return;
    }
    const session = driver.session();
    try {
      // (a) Structured episode: scope + tags set, but NO `[project:` task prefix.
      // This is exactly what berry_store produces; it was previously invisible.
      await session.run(
        `CREATE (e:Episodic {
           id: $id, session_id: $sid, task: $task, content: $content,
           outcome: $outcome, created_at: $created_at,
           scope: $scope, tags: $tags
         })`,
        {
          id: STRUCTURED_ID,
          sid: 'sess-gap13-structured',
          task: 'did a thing', // deliberately NO [project:...] prefix
          content: 'structured-only episode',
          outcome: 'approved',
          created_at: '2026-04-09T12:00:00Z',
          scope: 'project:t7x',
          tags: ['project:t7x'],
        },
      );
      // (b) Legacy episode: only the `[project:…]` task prefix, no scope/tags.
      await session.run(
        `CREATE (e:Episodic {
           id: $id, session_id: $sid, task: $task, content: $content,
           outcome: $outcome, created_at: $created_at
         })`,
        {
          id: LEGACY_ID,
          sid: 'sess-gap13-legacy',
          task: '[project:t7y] legacy work',
          content: 'legacy prefix-only episode',
          outcome: 'approved',
          created_at: '2026-04-08T12:00:00Z',
        },
      );
      // (c) Structured episode whose scope contains an underscore — berry_store
      // stores it lowercased (NOT slugified), so the query must lowercase (not
      // slugify) to match. slugify would search 'project:my-proj-t7' and miss.
      await session.run(
        `CREATE (e:Episodic {
           id: $id, session_id: $sid, task: $task, content: $content,
           outcome: $outcome, created_at: $created_at,
           scope: $scope, tags: $tags
         })`,
        {
          id: UNDERSCORE_ID,
          sid: 'sess-gap13-underscore',
          task: 'underscore episode no prefix',
          content: 'underscore-scope episode',
          outcome: 'approved',
          created_at: '2026-04-07T12:00:00Z',
          scope: 'project:my_proj_t7',
          tags: ['project:my_proj_t7'],
        },
      );
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    if (neo4jAvailable) {
      const session = driver.session();
      try {
        await session.run(
          `MATCH (e:Episodic) WHERE e.id STARTS WITH $prefix DETACH DELETE e`,
          { prefix: TEST_PREFIX },
        );
      } finally {
        await session.close();
      }
    }
    await driver.close().catch(() => {});
  });

  // Core gap-13 fix: structured discovery works WITHOUT any task prefix.
  it('finds an episode by structured scope/tags with NO [project:] task prefix', async () => {
    if (!neo4jAvailable) return;
    const episodes = await fetchEpisodicsForProject(driver, 't7x');
    const ids = episodes.map((e) => e.id);
    expect(ids).toContain(STRUCTURED_ID);
    const found = episodes.find((e) => e.id === STRUCTURED_ID)!;
    expect(found.task).toBe('did a thing'); // confirms it matched WITHOUT a prefix
    expect(found.scope).toBe('project:t7x');
    expect(found.tags).toEqual(['project:t7x']);
  });

  // Fallback intact: legacy prefix-only episodes are still discovered.
  it('still finds a legacy episode by the [project:] task prefix (fallback)', async () => {
    if (!neo4jAvailable) return;
    const episodes = await fetchEpisodicsForProject(driver, 't7y');
    const ids = episodes.map((e) => e.id);
    expect(ids).toContain(LEGACY_ID);
  });

  // Regression for canonTag normalization: a scope with an underscore must match
  // (lowercase, not slugify). The mixed-case input also proves the case-fold.
  // slugify would have produced 'project:my-proj-t7' and missed entirely.
  it('matches a project scope with an underscore (lowercase, not slugified)', async () => {
    if (!neo4jAvailable) return;
    const episodes = await fetchEpisodicsForProject(driver, 'My_Proj_T7');
    expect(episodes.map((e) => e.id)).toContain(UNDERSCORE_ID);
  });
});
