// packages/wiki/src/__tests__/ingest-idempotent.live.test.ts
// OPT-11: live-Neo4j proof that re-ingesting the SAME source is idempotent.
//
// Before the fix, createSourceNode and createSemanticNode used CREATE with random
// nanoid ids, so ingesting the same document twice DUPLICATED the Source node and
// every claim Semantic. The fix MERGEs both on content-addressed identities:
//   - Source: id = sha1(path|source_type|project_tag)  (sourceNodeId helper)
//   - Semantic: dedupe_key = semanticDedupeKey(scope, about[0], content)
//     (mirrors BootstrapGraphService.createSemantic; backed by the
//      `semantic_dedupe_unique` UNIQUE constraint, so it's race-safe).
//
// This MUST be a live test: a mock driver can't catch a CREATE-vs-MERGE
// difference. Skipped when Neo4j is unreachable (mirrors ingest.live.test.ts).
//
// Against the OLD CREATE-based code this FAILS: the second ingest would create a
// second Source node and a second copy of every claim Semantic, so the counts
// would double instead of staying flat.

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

// Unique per-run identity so this run's nodes can't collide with other runs/tests.
const RUN = `opt11ingest${Date.now()}`;
const PROJECT_NAME = `${RUN}proj`;
const PROJECT_TAG = `project:${PROJECT_NAME}`;
const SOURCE_PATH = `/tmp/${RUN}-doc.md`;
const ENTITY_A = `${RUN}-alpha`;
const ENTITY_B = `${RUN}-beta`;

// Two explicit claims (no extractor) so the test is deterministic.
const CLAIMS = [
  { content: `${RUN}: alpha drives the pipeline`, about: [ENTITY_A] },
  { content: `${RUN}: beta caches the result`, about: [ENTITY_B] },
];

const INPUT = {
  source_path: SOURCE_PATH,
  content: `# ${RUN} notes\n\nThe ${ENTITY_A} and ${ENTITY_B} components.`,
  source_type: 'note' as const,
  project_tag: PROJECT_TAG,
  title: `${RUN} doc`,
  entities: [ENTITY_A, ENTITY_B],
  claims: CLAIMS,
  ensure_project: true,
};

describe('IngestionService OPT-11 (re-ingest is idempotent, live Neo4j)', () => {
  let neo4jAvailable = false;
  const driver = createDriver();

  beforeAll(async () => {
    neo4jAvailable = await isNeo4jReachable();
    if (!neo4jAvailable) {
      console.warn(`[skip] Neo4j not reachable at ${NEO4J_URI} — skipping OPT-11 ingest tests`);
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
        await session.run(
          `MATCH (s:Source) WHERE s.project_tag = $tag DETACH DELETE s`,
          { tag: PROJECT_TAG },
        );
        await session.run(
          `MATCH (s:Semantic) WHERE $tag IN s.tags DETACH DELETE s`,
          { tag: PROJECT_TAG },
        );
      } finally {
        await session.close();
      }
    }
    await driver.close().catch(() => {});
  });

  async function countSources(): Promise<number> {
    const session = driver.session();
    try {
      const res = await session.run(
        `MATCH (s:Source) WHERE s.project_tag = $tag RETURN count(s) AS cnt`,
        { tag: PROJECT_TAG },
      );
      const cnt = res.records[0].get('cnt') as { toNumber: () => number } | number;
      return typeof cnt === 'object' ? cnt.toNumber() : cnt;
    } finally {
      await session.close();
    }
  }

  async function countSemantics(): Promise<number> {
    const session = driver.session();
    try {
      const res = await session.run(
        `MATCH (s:Semantic) WHERE $tag IN s.tags RETURN count(s) AS cnt`,
        { tag: PROJECT_TAG },
      );
      const cnt = res.records[0].get('cnt') as { toNumber: () => number } | number;
      return typeof cnt === 'object' ? cnt.toNumber() : cnt;
    } finally {
      await session.close();
    }
  }

  it('re-ingesting the same source creates ZERO new Source and ZERO new Semantic nodes', async () => {
    if (!neo4jAvailable) return;

    const service = new IngestionService(driver);

    // First ingest establishes the baseline: 1 Source + 2 claim Semantics.
    await service.ingest({ ...INPUT });
    const sourcesAfterFirst = await countSources();
    const semanticsAfterFirst = await countSemantics();

    expect(sourcesAfterFirst).toBe(1);
    expect(semanticsAfterFirst).toBe(CLAIMS.length);

    // Second ingest of the IDENTICAL source must be a no-op for node counts:
    // MERGE matches the existing Source (content-addressed id) and the existing
    // claim Semantics (dedupe_key). With the OLD CREATE-based code these counts
    // would DOUBLE — this is the regression assertion.
    await service.ingest({ ...INPUT });

    expect(await countSources()).toBe(sourcesAfterFirst);
    expect(await countSemantics()).toBe(semanticsAfterFirst);
  });
});
