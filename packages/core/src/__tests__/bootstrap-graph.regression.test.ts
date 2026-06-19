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
import type { Driver } from 'neo4j-driver';
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

// OPT-3: the orphan-Episodic linker must NOT substring-match a sibling project
// whose tag merely CONTAINS this project's tag. Before the fix the linker used
// `ep.task CONTAINS $tag` (with $tag = 'project:foo'), so bootstrapping 'foo'
// REFERENCES-linked episodes belonging to 'project:foobar'. The fix mirrors the
// wiki gap-13/T7 structured match (ep.scope/ep.tags equality + a BRACKETED task
// fallback), so a sibling whose tag is a strict superstring is never matched.
describe('BootstrapGraphService OPT-3 (orphan linker: no substring cross-link)', () => {
  let neo4jAvailable = false;
  const driver = createNeo4jDriver(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
  let service: BootstrapGraphService;

  // Unique per-run slugs so names can't collide with other runs/tests. `sub` is a
  // strict superstring of `base` (base is a substring of sub) — the cross-link trap.
  const RUN = `opt3-${Date.now()}`;
  const BASE_NAME = `${RUN}foo`;
  const SUB_NAME = `${RUN}foobar`; // BASE_NAME is a substring of SUB_NAME
  const BASE_TAG = `project:${BASE_NAME.toLowerCase()}`;
  const SUB_TAG = `project:${SUB_NAME.toLowerCase()}`;
  const SUB_EP_ID = `${TEST_PREFIX}-${RUN}-foobar-ep`;
  const BASE_EP_ID = `${TEST_PREFIX}-${RUN}-foo-ep`;

  beforeAll(async () => {
    neo4jAvailable = await isNeo4jReachable(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
    if (!neo4jAvailable) {
      console.warn(`[skip] Neo4j not reachable at ${NEO4J_URI} — skipping OPT-3 tests`);
      return;
    }
    service = new BootstrapGraphService(driver);

    const session = driver.session();
    try {
      // Episode that belongs to the DISTINCT 'foobar' project, stored exactly as
      // berry_store would: scope/tags = lowercased canonical tag, NO task prefix.
      await session.run(
        `CREATE (ep:Episodic {
           id: $id, session_id: $sid, task: $task, content: $content,
           created_at: $now, scope: $scope, tags: $tags
         })`,
        {
          id: SUB_EP_ID,
          sid: `sess-${RUN}-foobar`,
          task: 'unrelated foobar work', // deliberately NO [project:...] prefix
          content: 'belongs to foobar, must NOT link to foo',
          now: new Date().toISOString(),
          scope: SUB_TAG,
          tags: [SUB_TAG],
        },
      );
      // Episode that genuinely belongs to 'foo' (the control: it MUST link).
      await session.run(
        `CREATE (ep:Episodic {
           id: $id, session_id: $sid, task: $task, content: $content,
           created_at: $now, scope: $scope, tags: $tags
         })`,
        {
          id: BASE_EP_ID,
          sid: `sess-${RUN}-foo`,
          task: 'real foo work',
          content: 'belongs to foo, must link',
          now: new Date().toISOString(),
          scope: BASE_TAG,
          tags: [BASE_TAG],
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
          `MATCH (e:Entity) WHERE e.name STARTS WITH $run DETACH DELETE e`,
          { run: RUN },
        );
        await session.run(
          `MATCH (ep:Episodic) WHERE ep.id = $a OR ep.id = $b DETACH DELETE ep`,
          { a: SUB_EP_ID, b: BASE_EP_ID },
        );
      } finally {
        await session.close();
      }
    }
    await driver.close().catch(() => {});
  });

  async function isLinked(episodeId: string, projectName: string): Promise<boolean> {
    const session = driver.session();
    try {
      const res = await session.run(
        `MATCH (ep:Episodic {id: $epId})-[:REFERENCES]->(p:Entity {name: $name})
         RETURN count(*) AS cnt`,
        { epId: episodeId, name: projectName },
      );
      const cnt = res.records[0].get('cnt') as { toNumber: () => number } | number;
      return (typeof cnt === 'object' ? cnt.toNumber() : cnt) > 0;
    } finally {
      await session.close();
    }
  }

  it('does NOT REFERENCES-link a substring-sibling project\'s episode (foobar ↛ foo)', async () => {
    if (!neo4jAvailable) return;

    // Bootstrap ONLY the 'foo' project. The pre-seeded foobar episode shares the
    // 'foo' substring but must stay unlinked. The old `ep.task CONTAINS 'project:foo'`
    // logic would NOT match here anyway (no task prefix) — but the prior code only
    // matched the task, so the real regression is that the new structured match
    // must use EQUALITY on scope/tags, not membership of a superstring tag.
    await service.bootstrap({
      project_name: BASE_NAME,
      project_tag: BASE_TAG,
      description: 'OPT-3 base project',
      domain: 'test',
      entities: [],
      semantic_seeds: [],
      agents: [],
    });

    // The foobar episode must NOT be linked to the foo project entity.
    expect(await isLinked(SUB_EP_ID, BASE_NAME)).toBe(false);
    // The genuine foo episode MUST be linked (proves the structured match works).
    expect(await isLinked(BASE_EP_ID, BASE_NAME)).toBe(true);
  });

  it('matches via the legacy [project:foo] task prefix but not a [project:foobar] one', async () => {
    if (!neo4jAvailable) return;

    // Two legacy prefix-only episodes: one for foo, one for foobar. The old code
    // `ep.task CONTAINS 'project:foo'` matched BOTH (foobar's task contains the
    // substring 'project:foo'); the bracketed fallback '[project:<foo>]' matches
    // only the foo one.
    const legacyFooId = `${TEST_PREFIX}-${RUN}-legacy-foo`;
    const legacyFoobarId = `${TEST_PREFIX}-${RUN}-legacy-foobar`;
    const seed = driver.session();
    try {
      await seed.run(
        `CREATE (ep:Episodic { id: $id, session_id: $sid, task: $task, content: 'c', created_at: $now })`,
        { id: legacyFooId, sid: `sess-${RUN}-lfoo`, task: `[project:${BASE_NAME}] legacy foo`, now: new Date().toISOString() },
      );
      await seed.run(
        `CREATE (ep:Episodic { id: $id, session_id: $sid, task: $task, content: 'c', created_at: $now })`,
        { id: legacyFoobarId, sid: `sess-${RUN}-lfoobar`, task: `[project:${SUB_NAME}] legacy foobar`, now: new Date().toISOString() },
      );
    } finally {
      await seed.close();
    }

    try {
      // Re-bootstrap foo (idempotent) to run the orphan linker over the new episodes.
      await service.bootstrap({
        project_name: BASE_NAME,
        project_tag: BASE_TAG,
        description: 'OPT-3 base project',
        domain: 'test',
        entities: [],
        semantic_seeds: [],
        agents: [],
      });

      expect(await isLinked(legacyFooId, BASE_NAME)).toBe(true);
      // foobar's task contains the substring 'project:<run>foo' but the bracketed
      // token '[project:<run>foo]' is NOT a substring of '[project:<run>foobar] …'.
      expect(await isLinked(legacyFoobarId, BASE_NAME)).toBe(false);
    } finally {
      const cleanup = driver.session();
      try {
        await cleanup.run(
          `MATCH (ep:Episodic) WHERE ep.id = $a OR ep.id = $b DETACH DELETE ep`,
          { a: legacyFooId, b: legacyFoobarId },
        );
      } finally {
        await cleanup.close();
      }
    }
  });
});

// OPT-8: a single semantic-seed failure must NOT abort the whole bootstrap. The
// seed loop wraps each seed's createSemantic + ABOUT links in its own try/catch,
// so a transient/contended/malformed seed is skipped (logged) while the good
// seeds still get created and bootstrap() resolves — letting the downstream
// ingest phases (code indexing, component bridge, block seeding) still run.
//
// This is a pure UNIT test driven by an injected fake driver whose `run` throws
// ONLY for the poison seed's MERGE (matched by its claim text), and succeeds for
// everything else. Against the pre-fix code (no per-seed try/catch) the thrown
// MERGE rejects the whole bootstrap() — so `expect(...).resolves` FAILS.
describe('BootstrapGraphService OPT-8 (one bad seed must not abort bootstrap)', () => {
  // Markers embedded in seed claims; the fake throws on POISON, succeeds on GOOD.
  const POISON = 'opt8-POISON-seed';
  const GOOD_A = 'opt8-GOOD-seed-A';
  const GOOD_B = 'opt8-GOOD-seed-B';

  /** Records of every Semantic MERGE that the fake actually executed. */
  interface FakeState {
    semanticClaims: string[];
  }

  /**
   * Minimal fake Neo4j driver. Returns shape-compatible records for every query
   * bootstrap() issues, but THROWS for the createSemantic MERGE whose `content`
   * param contains POISON. Records the claims of the Semantic MERGEs that ran so
   * we can assert the good seeds were created.
   */
  function makeFakeDriver(state: FakeState): Driver {
    let idCounter = 0;
    const rec = (fields: Record<string, unknown>) => ({
      get: (key: string) => fields[key],
    });
    const run = async (query: string, params?: Record<string, unknown>) => {
      // createSemantic MERGE — throw for the poison seed, else record + succeed.
      if (query.includes('MERGE (s:Semantic')) {
        const content = (params?.content as string) ?? '';
        if (content.includes(POISON)) {
          throw new Error('simulated transient MERGE contention on poison seed');
        }
        state.semanticClaims.push(content);
        return { records: [rec({ id: `sem-${++idCounter}`, isNew: true })] };
      }
      // mergeEntity MERGE.
      if (query.includes('MERGE (e:Entity')) {
        return { records: [rec({ id: `ent-${++idCounter}`, isNew: true })] };
      }
      // mergeAgent MERGE.
      if (query.includes('MERGE (a:Agent')) {
        return { records: [rec({ isNew: true })] };
      }
      // Entity name lookup (parent link OR ABOUT link) — return one match.
      if (query.includes('RETURN e.id AS id')) {
        return { records: [rec({ id: `ent-${++idCounter}` })] };
      }
      // ABOUT MERGE and CONTAINS MERGE — no records needed.
      if (query.includes('MERGE (s)-[:ABOUT]->(e)') || query.includes('MERGE (a)-[:')) {
        return { records: [] };
      }
      // Orphan-Episodic linker — no episodes linked.
      if (query.includes('count(ep) AS linked')) {
        return { records: [rec({ linked: 0 })] };
      }
      return { records: [] };
    };
    const session = { run, close: async () => {} };
    return { session: () => session, close: async () => {} } as unknown as Driver;
  }

  function opt8Input(): BootstrapInput {
    return {
      project_name: 'opt8-proj',
      project_tag: 'project:opt8',
      description: 'OPT-8 best-effort seed project',
      domain: 'test',
      entities: [{ name: 'opt8-mod', type: 'module' }],
      semantic_seeds: [
        { claim: GOOD_A, domain: 'architecture', confidence: 0.3, about: ['opt8-mod'] },
        { claim: POISON, domain: 'architecture', confidence: 0.3, about: ['opt8-mod'] },
        { claim: GOOD_B, domain: 'architecture', confidence: 0.3, about: ['opt8-mod'] },
      ],
      agents: [],
    };
  }

  it('skips the failing seed and still resolves, creating the good seeds', async () => {
    const state: FakeState = { semanticClaims: [] };
    const service = new BootstrapGraphService(makeFakeDriver(state));

    // Pre-fix (no try/catch in the seed loop): the poison MERGE throws and this
    // whole call rejects — so `.resolves` is the assertion that breaks.
    const result = await service.bootstrap(opt8Input());

    // Both good seeds were created; the poison one was skipped (not recorded).
    expect(state.semanticClaims).toContain(GOOD_A);
    expect(state.semanticClaims).toContain(GOOD_B);
    expect(state.semanticClaims).not.toContain(POISON);
    // Result reflects only the seeds that succeeded.
    expect(result.semantics_created).toBe(2);
  });

  it('a thrown ENTITY merge still hard-fails (only seeding is best-effort)', async () => {
    // Replace the fake's entity MERGE with a throw to prove entity merges are NOT
    // swallowed — a genuine bootstrap failure must still reject.
    const state: FakeState = { semanticClaims: [] };
    const base = makeFakeDriver(state);
    const failingDriver = {
      session: () => {
        const s = base.session();
        const origRun = s.run.bind(s);
        return {
          run: async (query: string, params?: Record<string, unknown>) => {
            if (query.includes('MERGE (e:Entity')) {
              throw new Error('simulated hard entity-merge failure');
            }
            return origRun(query, params);
          },
          close: async () => {},
        };
      },
      close: async () => {},
    } as unknown as Driver;

    const service = new BootstrapGraphService(failingDriver);
    await expect(service.bootstrap(opt8Input())).rejects.toThrow(/hard entity-merge failure/);
  });
});

// OPT-21: the parent CONTAINS link must NOT depend on entity insertion order. A
// child that names a parent listed LATER in the `entities` array still gets the
// parent→child CONTAINS edge, because all entities are MERGEd before any parent
// link runs. Against the pre-fix code (parent link inline in the merge loop) the
// later parent isn't created yet when the child looks it up, so the edge is
// silently dropped and this test FAILS.
describe('BootstrapGraphService OPT-21 (parent listed later still links)', () => {
  let neo4jAvailable = false;
  const driver = createNeo4jDriver(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
  let service: BootstrapGraphService;
  const RUN = `opt21-${Date.now()}`;
  const CHILD = `${RUN}-child`;
  const PARENT = `${RUN}-parent`;
  const tag = `project:${RUN}`;

  beforeAll(async () => {
    neo4jAvailable = await isNeo4jReachable(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
    if (!neo4jAvailable) {
      console.warn(`[skip] Neo4j not reachable at ${NEO4J_URI} — skipping OPT-21 tests`);
      return;
    }
    service = new BootstrapGraphService(driver);
  });

  afterAll(async () => {
    if (neo4jAvailable) {
      const session = driver.session();
      try {
        await session.run(
          `MATCH (e:Entity) WHERE e.name STARTS WITH $run DETACH DELETE e`,
          { run: RUN },
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

  it('creates parent→child CONTAINS even when the parent comes LATER in the array', async () => {
    if (!neo4jAvailable) return;

    // CHILD is listed BEFORE its PARENT. Pre-fix, the parent did not yet exist
    // when the child's inline parent lookup ran, so no parent edge was created.
    await service.bootstrap({
      project_name: `${RUN}-proj`,
      project_tag: tag,
      description: 'OPT-21 ordering project',
      domain: 'test',
      entities: [
        { name: CHILD, type: 'module', parent: PARENT },
        { name: PARENT, type: 'module' },
      ],
      semantic_seeds: [],
      agents: [],
    });

    const verify = driver.session();
    try {
      const res = await verify.run(
        `MATCH (p:Entity {name: $parent})-[:CONTAINS]->(c:Entity {name: $child})
         RETURN count(*) AS cnt`,
        { parent: PARENT, child: CHILD },
      );
      const cnt = res.records[0].get('cnt') as { toNumber: () => number } | number;
      const count = typeof cnt === 'object' ? cnt.toNumber() : cnt;
      expect(count).toBe(1);
    } finally {
      await verify.close();
    }
  });
});
