// packages/core/src/__tests__/bootstrap-graph.regression.test.ts
//
// gap-14 regression: BootstrapGraphService.mergeEntity must PROMOTE an existing
// same-named Entity to type='project' ON MATCH (so it becomes visible to
// wiki/lint, which only match Entity{type:'project'}), but must NEVER demote or
// alter any other type.
//
// Live-Neo4j test: self-skips when no DB is reachable. Mirrors the probe/skip
// pattern in packages/neo4j/src/__tests__/semantic.test.ts.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createNeo4jDriver } from '@memberry/neo4j';
import { BootstrapGraphService } from '@memberry/core';
import type { BootstrapInput } from '@memberry/core';

// `||` (not `??`) so an empty-string env var (e.g. NEO4J_URI="" in CI's unit
// job) falls back to a valid local default instead of an illegal empty host.
const NEO4J_URI = process.env.NEO4J_URI || 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || 'password';

async function isNeo4jReachable(uri: string, user: string, password: string): Promise<boolean> {
  const probe = createNeo4jDriver(uri, user, password);
  try {
    await probe.getServerInfo();
    return true;
  } catch {
    return false;
  } finally {
    await probe.close().catch(() => {});
  }
}

const TEST_PREFIX = `test-bootstrap-${Date.now()}`;

function baseInput(overrides: Partial<BootstrapInput>): BootstrapInput {
  return {
    project_name: `${TEST_PREFIX}-proj`,
    project_tag: `project:${TEST_PREFIX}`,
    description: 'gap-14 regression project',
    domain: 'test',
    entities: [],
    semantic_seeds: [],
    agents: [],
    ...overrides,
  };
}

describe('BootstrapGraphService gap-14 (promote to project, never demote)', () => {
  let neo4jAvailable = false;
  const driver = createNeo4jDriver(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
  let service: BootstrapGraphService;

  beforeAll(async () => {
    neo4jAvailable = await isNeo4jReachable(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
    if (!neo4jAvailable) {
      console.warn(`[skip] Neo4j not reachable at ${NEO4J_URI} — skipping bootstrap-graph tests`);
      return;
    }
    service = new BootstrapGraphService(driver);
  });

  afterAll(async () => {
    if (neo4jAvailable) {
      const session = driver.session();
      try {
        // Clean ALL nodes created by these tests (matched by TEST_PREFIX in
        // either name or id). Semantic seeds carry the project tag in scope/tags.
        await session.run(
          `MATCH (e:Entity)
           WHERE e.name STARTS WITH $prefix OR e.id STARTS WITH $prefix
           DETACH DELETE e`,
          { prefix: TEST_PREFIX },
        );
        await session.run(
          `MATCH (s:Semantic) WHERE $tag IN s.tags DETACH DELETE s`,
          { tag: `project:${TEST_PREFIX}` },
        );
      } finally {
        await session.close();
      }
    }
    await driver.close().catch(() => {});
  });

  it('promotes an existing concept Entity to type=project on bootstrap (gap-14)', async () => {
    if (!neo4jAvailable) return;

    const projectName = `${TEST_PREFIX}-proj`;

    // Pre-create the entity as a plain 'concept' — the bug scenario.
    const seedSession = driver.session();
    try {
      await seedSession.run(
        `CREATE (:Entity {id: $id, name: $name, type: 'concept', created_at: $now})`,
        { id: `${TEST_PREFIX}-existing`, name: projectName, now: new Date().toISOString() },
      );
    } finally {
      await seedSession.close();
    }

    // Bootstrap the project under that same name (type=project).
    await service.bootstrap(baseInput({ project_name: projectName, project_tag: `project:${TEST_PREFIX}` }));

    const verifySession = driver.session();
    try {
      // The existing node was promoted, not re-created.
      const typeRes = await verifySession.run(
        `MATCH (e:Entity {name: $name}) RETURN e.type AS type`,
        { name: projectName },
      );
      expect(typeRes.records).toHaveLength(1);
      expect(typeRes.records[0].get('type')).toBe('project');

      // It is now discoverable via the type='project' filter wiki/lint use.
      const discoverRes = await verifySession.run(
        `MATCH (e:Entity {type: 'project'}) WHERE e.name = $name RETURN count(e) AS cnt`,
        { name: projectName },
      );
      const cnt = discoverRes.records[0].get('cnt') as { toNumber: () => number } | number;
      const count = typeof cnt === 'object' ? cnt.toNumber() : cnt;
      expect(count).toBe(1);
    } finally {
      await verifySession.close();
    }
  });

  it('never demotes a non-project Entity (a module stays a module)', async () => {
    if (!neo4jAvailable) return;

    const moduleName = `${TEST_PREFIX}-mod`;

    // Pre-create the entity as a 'module'.
    const seedSession = driver.session();
    try {
      await seedSession.run(
        `CREATE (:Entity {id: $id, name: $name, type: 'module', created_at: $now})`,
        { id: `${TEST_PREFIX}-mod-existing`, name: moduleName, now: new Date().toISOString() },
      );
    } finally {
      await seedSession.close();
    }

    // Bootstrap a (different) project that includes this name as a NON-project entity.
    await service.bootstrap(
      baseInput({
        project_name: `${TEST_PREFIX}-proj2`,
        project_tag: `project:${TEST_PREFIX}`,
        entities: [{ name: moduleName, type: 'module' }],
      }),
    );

    const verifySession = driver.session();
    try {
      const typeRes = await verifySession.run(
        `MATCH (e:Entity {name: $name}) RETURN e.type AS type`,
        { name: moduleName },
      );
      expect(typeRes.records).toHaveLength(1);
      // Still a module — promotion is project-only, never a demotion or rewrite.
      expect(typeRes.records[0].get('type')).toBe('module');
    } finally {
      await verifySession.close();
    }
  });
});

// gap-16: BootstrapGraphService.createSemantic must be idempotent — re-ingesting
// the SAME seeds must NOT duplicate Semantic nodes (the MERGE on the stable
// dedupe_key). Module seeds guarantee module pages have content.
describe('BootstrapGraphService gap-16 (per-module seeds + dedupe guard)', () => {
  let neo4jAvailable = false;
  const driver = createNeo4jDriver(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
  let service: BootstrapGraphService;
  const tag = `project:${TEST_PREFIX}-g16`;

  beforeAll(async () => {
    neo4jAvailable = await isNeo4jReachable(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
    if (!neo4jAvailable) {
      console.warn(`[skip] Neo4j not reachable at ${NEO4J_URI} — skipping gap-16 tests`);
      return;
    }
    service = new BootstrapGraphService(driver);
  });

  afterAll(async () => {
    if (neo4jAvailable) {
      const session = driver.session();
      try {
        await session.run(
          `MATCH (e:Entity) WHERE e.name STARTS WITH $prefix OR e.id STARTS WITH $prefix DETACH DELETE e`,
          { prefix: `${TEST_PREFIX}-g16` },
        );
        await session.run(
          `MATCH (s:Semantic) WHERE $tag IN s.tags DETACH DELETE s`,
          { tag },
        );
      } finally {
        await session.close();
      }
    }
    await driver.close().catch(() => {});
  });

  function g16Input(): BootstrapInput {
    return {
      project_name: `${TEST_PREFIX}-g16-proj`,
      project_tag: tag,
      description: 'gap-16 dedupe project',
      domain: 'test',
      entities: [
        { name: `${TEST_PREFIX}-g16-modA`, type: 'module', parent: `${TEST_PREFIX}-g16-proj` },
        { name: `${TEST_PREFIX}-g16-modB`, type: 'module', parent: `${TEST_PREFIX}-g16-proj` },
      ],
      semantic_seeds: [
        { claim: `${TEST_PREFIX}-g16-modA is a module`, domain: 'architecture', confidence: 0.3, about: [`${TEST_PREFIX}-g16-modA`] },
        { claim: `${TEST_PREFIX}-g16-modB is a module`, domain: 'architecture', confidence: 0.3, about: [`${TEST_PREFIX}-g16-modB`] },
      ],
      agents: [],
    };
  }

  async function semanticCountFor(about: string): Promise<number> {
    const session = driver.session();
    try {
      const res = await session.run(
        `MATCH (s:Semantic)-[:ABOUT]->(e:Entity {name: $name}) RETURN count(s) AS cnt`,
        { name: about },
      );
      const cnt = res.records[0].get('cnt') as { toNumber: () => number } | number;
      return typeof cnt === 'object' ? cnt.toNumber() : cnt;
    } finally {
      await session.close();
    }
  }

  it('seeds ≥1 Semantic per module (module pages get content)', async () => {
    if (!neo4jAvailable) return;
    await service.bootstrap(g16Input());

    expect(await semanticCountFor(`${TEST_PREFIX}-g16-modA`)).toBeGreaterThanOrEqual(1);
    expect(await semanticCountFor(`${TEST_PREFIX}-g16-modB`)).toBeGreaterThanOrEqual(1);
  });

  it('re-ingesting the same fixture does NOT double the per-module Semantic count', async () => {
    if (!neo4jAvailable) return;

    // First ingest establishes the baseline.
    await service.bootstrap(g16Input());
    const beforeA = await semanticCountFor(`${TEST_PREFIX}-g16-modA`);
    const beforeB = await semanticCountFor(`${TEST_PREFIX}-g16-modB`);
    expect(beforeA).toBeGreaterThanOrEqual(1);

    // Re-ingest the identical input — MERGE on dedupe_key must be idempotent.
    const result = await service.bootstrap(g16Input());

    const afterA = await semanticCountFor(`${TEST_PREFIX}-g16-modA`);
    const afterB = await semanticCountFor(`${TEST_PREFIX}-g16-modB`);
    expect(afterA).toBe(beforeA);
    expect(afterB).toBe(beforeB);
    // The matched re-ingest reports zero NEW semantics (no count inflation).
    expect(result.semantics_created).toBe(0);
  });
});
