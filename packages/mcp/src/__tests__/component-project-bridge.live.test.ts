// packages/mcp/src/__tests__/component-project-bridge.live.test.ts
// T6/gap-12 — end-to-end: berry_ingest_codebase wires indexed Component file
// nodes to their module Entities and the project, so the wiki compiler's
// `fetchProjectEntities` CONTAINS traversal can discover them.
//
// Drives the REAL bridge against a live Neo4j: a real BootstrapGraphService +
// real CodeIndexer (both need only a driver); the load/store/query/block
// services the handler also touches are inert stubs (the bridge path doesn't
// depend on them). Skips when Neo4j is unreachable (mirrors
// packages/neo4j/src/__tests__/semantic.test.ts: getServerInfo probe +
// neo4jAvailable flag + unique prefix + afterAll DETACH DELETE).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { createNeo4jDriver } from '@memberry/neo4j';
import { BootstrapGraphService } from '@memberry/core';
import { CodeIndexer } from '@memberry/code';
import {
  buildToolHandlers,
  createServiceContainer,
  type IAMPService,
  type IScopedQuery,
  type IMemoryBlockService,
} from '../tools.js';

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

// Unique per-run project name so assertions never collide with other graph data.
const PROJECT_NAME = `t6-bridge-${Date.now()}`;

// Inert stubs for services the handler calls but the bridge path doesn't need.
const ampStub: IAMPService = {
  load: vi.fn().mockResolvedValue({ markdown: '', tokens: 0, sources: [], assembled_at: '' }),
  store: vi.fn().mockResolvedValue({ id: 'ep-1', duplicate: false }),
};
const scopedQueryStub: IScopedQuery = { rawCypher: vi.fn().mockResolvedValue([]) };
const memoryBlockStub: IMemoryBlockService = {
  read: vi.fn().mockResolvedValue(null),
  insert: vi.fn().mockResolvedValue({ id: 'b-1', name: 'x', tier: 'core', content: '', scope: '' }),
  replace: vi.fn().mockResolvedValue({ id: 'b-1', name: 'x', tier: 'core', content: '', scope: '' }),
  rewrite: vi.fn().mockResolvedValue({ id: 'b-1', name: 'x', tier: 'core', content: '', scope: '' }),
  promote: vi.fn().mockResolvedValue({ id: 'b-1', name: 'x', tier: 'core', content: '', scope: '' }),
  archive: vi.fn().mockResolvedValue(''),
};

describe('berry_ingest_codebase — component→project wiki bridge (live Neo4j)', () => {
  let available = false;
  const driver = createNeo4jDriver(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
  let fixtureDir = '';

  async function wipe(): Promise<void> {
    const s = driver.session();
    try {
      // Remove the project + its modules + the run's component nodes.
      await s.run('MATCH (e:Entity {name: $name}) DETACH DELETE e', { name: PROJECT_NAME });
      await s.run('MATCH (e:Entity {name: "mod_a"}) DETACH DELETE e');
      await s.run('MATCH (e:Entity {name: "mod_b"}) DETACH DELETE e');
      if (fixtureDir) {
        await s.run('MATCH (c:Entity:Component) WHERE c.path STARTS WITH $d DETACH DELETE c', { d: fixtureDir });
        await s.run('MATCH (sym:Symbol) WHERE sym.file_path STARTS WITH $d DETACH DELETE sym', { d: fixtureDir });
      }
    } finally {
      await s.close();
    }
  }

  beforeAll(async () => {
    available = await isNeo4jReachable();
    if (!available) {
      console.warn(`[skip] Neo4j not reachable at ${NEO4J_URI} — skipping T6 bridge test`);
      return;
    }
    // The fixture must live under cwd (getAllowedBaseDir defaults to process.cwd()
    // and the handler confines `path` to it).
    fixtureDir = await mkdtemp(join(process.cwd(), 't6-bridge-fixture-'));
    // A package.json pins a deterministic project name for the assertion.
    await writeFile(
      join(fixtureDir, 'package.json'),
      JSON.stringify({ name: PROJECT_NAME, description: 'T6 bridge fixture' }),
    );
    // Two source files in two DIFFERENT top-level dirs → two derived modules.
    await mkdir(join(fixtureDir, 'mod_a'), { recursive: true });
    await mkdir(join(fixtureDir, 'mod_b'), { recursive: true });
    await writeFile(join(fixtureDir, 'mod_a', 'x.ts'), 'export const x = () => 1;\n');
    await writeFile(join(fixtureDir, 'mod_b', 'y.ts'), 'export const y = () => 2;\n');
    await wipe();
  });

  afterAll(async () => {
    if (available) await wipe();
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
    await driver.close().catch(() => {});
  });

  it('makes indexed modules + file nodes discoverable from the project via CONTAINS*', async () => {
    if (!available) return;

    const container = createServiceContainer({
      ampService: ampStub,
      scopedQuery: scopedQueryStub,
      bootstrapService: new BootstrapGraphService(driver),
      memoryBlockService: memoryBlockStub,
      codeIndexerService: new CodeIndexer(driver),
    });
    const handlers = buildToolHandlers(container);

    const result = await handlers.berry_ingest_codebase({ path: fixtureDir });
    expect(result.content[0].text).toContain('Codebase Ingestion Complete');

    const s = driver.session();
    try {
      // Mirror fetchProjectEntities exactly: discover everything the project
      // reaches via CONTAINS*1.. — the bridge must place modules AND components here.
      const reached = await s.run(
        `MATCH (project:Entity {type: 'project'})-[:CONTAINS*1..]->(e:Entity)
         WHERE project.name = $projectName
         RETURN e.name AS name, e.type AS type, e.path AS path`,
        { projectName: PROJECT_NAME },
      );
      const names = reached.records.map((r) => r.get('name') as string);
      const types = new Map(reached.records.map((r) => [r.get('name') as string, r.get('type') as string]));

      // Both module entities are reachable (created by the bridge — they're not in
      // the scanner's SOURCE_DIRS, so only the bridge can have made them).
      expect(names).toEqual(expect.arrayContaining(['mod_a', 'mod_b']));
      expect(types.get('mod_a')).toBe('module');
      expect(types.get('mod_b')).toBe('module');

      // Both component file nodes are reachable via module → component CONTAINS.
      const componentPaths = reached.records
        .filter((r) => r.get('type') === 'component')
        .map((r) => r.get('path') as string);
      expect(componentPaths.some((p) => p.endsWith('x.ts'))).toBe(true);
      expect(componentPaths.some((p) => p.endsWith('y.ts'))).toBe(true);

      // The two-hop shape holds: project → module → component (mirrors the wiki's
      // module-level granularity — components hang under modules, not the project).
      const twoHop = await s.run(
        `MATCH (p:Entity {type: 'project', name: $projectName})-[:CONTAINS]->(m:Entity {type: 'module'})-[:CONTAINS]->(c:Entity:Component)
         WHERE c.path STARTS WITH $d
         RETURN m.name AS module, c.path AS path`,
        { projectName: PROJECT_NAME, d: fixtureDir },
      );
      const modulesWithFiles = new Set(twoHop.records.map((r) => r.get('module') as string));
      expect(modulesWithFiles).toEqual(new Set(['mod_a', 'mod_b']));
    } finally {
      await s.close();
    }
  });

  it('is idempotent — a second ingest creates no duplicate CONTAINS edges', async () => {
    if (!available) return;

    const container = createServiceContainer({
      ampService: ampStub,
      scopedQuery: scopedQueryStub,
      bootstrapService: new BootstrapGraphService(driver),
      memoryBlockService: memoryBlockStub,
      codeIndexerService: new CodeIndexer(driver),
    });
    const handlers = buildToolHandlers(container);

    // Re-ingest the SAME fixture; MERGE everywhere must not fork edges/nodes.
    await handlers.berry_ingest_codebase({ path: fixtureDir });

    const s = driver.session();
    try {
      const dup = await s.run(
        `MATCH (p:Entity {type: 'project', name: $projectName})-[r:CONTAINS]->(m:Entity {type: 'module'})
         WHERE m.name IN ['mod_a', 'mod_b']
         RETURN m.name AS module, count(r) AS edges`,
        { projectName: PROJECT_NAME },
      );
      for (const rec of dup.records) {
        expect(rec.get('edges').toNumber()).toBe(1);
      }

      // And exactly one module→component edge per file (no duplication on re-run).
      const compEdges = await s.run(
        `MATCH (m:Entity {type: 'module'})-[r:CONTAINS]->(c:Entity:Component)
         WHERE c.path STARTS WITH $d
         RETURN c.path AS path, count(r) AS edges`,
        { d: fixtureDir },
      );
      for (const rec of compEdges.records) {
        expect(rec.get('edges').toNumber()).toBe(1);
      }
    } finally {
      await s.close();
    }
  });
});

// OPT-2 regression — NESTED workspace layout (top-level dir ≠ module name).
//
// The audit found the bridge derived a component's MODULE from the TOP-LEVEL
// directory. That passed CI only because the existing fixture above put each
// module in its OWN top-level dir (`mod_a`, `mod_b`) where the top-level dir
// name coincidentally equalled the module name. In a real monorepo the modules
// live UNDER a workspace root (`packages/<pkg>`), so top-level-dir derivation
// minted a single junk `packages` module that captured ALL components while the
// real per-package modules (`core`, `mcp`, …) got none.
//
// This fixture is a `pkgs/*` workspace: the top-level dir (`pkgs`) differs from
// the module names (`<run>-alpha`, `<run>-beta`, named by the scanner from each
// workspace package's DIRECTORY). Module + package dir names are unique per run
// so cleanup never clobbers shared graph data.
const NESTED_RUN = `opt2-nested-${Date.now()}`;
const NESTED_PROJECT = `${NESTED_RUN}-proj`;
const NESTED_MOD_A = `${NESTED_RUN}-alpha`;
const NESTED_MOD_B = `${NESTED_RUN}-beta`;

describe('berry_ingest_codebase — nested workspace component→module bridge (live Neo4j)', () => {
  let available = false;
  const driver = createNeo4jDriver(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
  let fixtureDir = '';

  async function wipe(): Promise<void> {
    const s = driver.session();
    try {
      // Delete by UNIQUE per-run names only (never bare shared names).
      await s.run('MATCH (e:Entity {name: $name}) DETACH DELETE e', { name: NESTED_PROJECT });
      await s.run('MATCH (e:Entity {name: $name}) DETACH DELETE e', { name: NESTED_MOD_A });
      await s.run('MATCH (e:Entity {name: $name}) DETACH DELETE e', { name: NESTED_MOD_B });
      if (fixtureDir) {
        await s.run('MATCH (c:Entity:Component) WHERE c.path STARTS WITH $d DETACH DELETE c', { d: fixtureDir });
        await s.run('MATCH (sym:Symbol) WHERE sym.file_path STARTS WITH $d DETACH DELETE sym', { d: fixtureDir });
      }
    } finally {
      await s.close();
    }
  }

  beforeAll(async () => {
    available = await isNeo4jReachable();
    if (!available) {
      console.warn(`[skip] Neo4j not reachable at ${NEO4J_URI} — skipping OPT-2 nested-workspace test`);
      return;
    }
    fixtureDir = await mkdtemp(join(process.cwd(), 'opt2-nested-fixture-'));
    // Root manifest declares a `pkgs/*` workspace so the scanner names modules by
    // each workspace package's DIRECTORY (NOT the `pkgs` root).
    await writeFile(
      join(fixtureDir, 'package.json'),
      JSON.stringify({ name: NESTED_PROJECT, description: 'OPT-2 nested fixture', workspaces: ['pkgs/*'] }),
    );
    // Two workspace packages UNDER `pkgs/` — top-level dir (`pkgs`) ≠ module name.
    // Each package's source lives a further level down (`src/`), so the component
    // dir is `pkgs/<mod>/src` — only a longest-prefix match resolves the module.
    await mkdir(join(fixtureDir, 'pkgs', NESTED_MOD_A, 'src'), { recursive: true });
    await mkdir(join(fixtureDir, 'pkgs', NESTED_MOD_B, 'src'), { recursive: true });
    await writeFile(
      join(fixtureDir, 'pkgs', NESTED_MOD_A, 'package.json'),
      JSON.stringify({ name: `@${NESTED_RUN}/alpha` }),
    );
    await writeFile(
      join(fixtureDir, 'pkgs', NESTED_MOD_B, 'package.json'),
      JSON.stringify({ name: `@${NESTED_RUN}/beta` }),
    );
    await writeFile(join(fixtureDir, 'pkgs', NESTED_MOD_A, 'src', 'a.ts'), 'export const a = () => 1;\n');
    await writeFile(join(fixtureDir, 'pkgs', NESTED_MOD_B, 'src', 'b.ts'), 'export const b = () => 2;\n');
    await wipe();
  });

  afterAll(async () => {
    if (available) await wipe();
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
    await driver.close().catch(() => {});
  });

  it('maps each component to its workspace module, not the top-level workspace dir', async () => {
    if (!available) return;

    const container = createServiceContainer({
      ampService: ampStub,
      scopedQuery: scopedQueryStub,
      bootstrapService: new BootstrapGraphService(driver),
      memoryBlockService: memoryBlockStub,
      codeIndexerService: new CodeIndexer(driver),
    });
    const handlers = buildToolHandlers(container);

    const result = await handlers.berry_ingest_codebase({ path: fixtureDir });
    expect(result.content[0].text).toContain('Codebase Ingestion Complete');

    const s = driver.session();
    try {
      // The two-hop project → module → component shape must use the REAL
      // per-package module names. Against the OLD top-level-dir logic the bridge
      // would attach both files under a junk `pkgs` module (which the bootstrap
      // never created), so this query — keyed on the real module names — returns
      // nothing and the assertion fails.
      const twoHop = await s.run(
        `MATCH (p:Entity {type: 'project', name: $projectName})-[:CONTAINS]->(m:Entity {type: 'module'})-[:CONTAINS]->(c:Entity:Component)
         WHERE c.path STARTS WITH $d
         RETURN m.name AS module, c.path AS path`,
        { projectName: NESTED_PROJECT, d: fixtureDir },
      );
      const byModule = new Map<string, string[]>();
      for (const r of twoHop.records) {
        const mod = r.get('module') as string;
        const list = byModule.get(mod) ?? [];
        list.push(r.get('path') as string);
        byModule.set(mod, list);
      }

      // Each component hangs under its OWN workspace module (longest-prefix match).
      expect(new Set(byModule.keys())).toEqual(new Set([NESTED_MOD_A, NESTED_MOD_B]));
      expect((byModule.get(NESTED_MOD_A) ?? []).some((p) => p.endsWith('a.ts'))).toBe(true);
      expect((byModule.get(NESTED_MOD_B) ?? []).some((p) => p.endsWith('b.ts'))).toBe(true);
      // The alpha file must NOT be filed under beta (and vice-versa).
      expect((byModule.get(NESTED_MOD_A) ?? []).some((p) => p.endsWith('b.ts'))).toBe(false);

      // No junk `pkgs` workspace-root module captured the components — the exact
      // failure mode of the old top-level-dir derivation.
      const junk = await s.run(
        `MATCH (p:Entity {type: 'project', name: $projectName})-[:CONTAINS]->(m:Entity {name: 'pkgs'})-[:CONTAINS]->(c:Entity:Component)
         WHERE c.path STARTS WITH $d
         RETURN count(c) AS n`,
        { projectName: NESTED_PROJECT, d: fixtureDir },
      );
      expect(junk.records[0].get('n').toNumber()).toBe(0);
    } finally {
      await s.close();
    }
  });
});
