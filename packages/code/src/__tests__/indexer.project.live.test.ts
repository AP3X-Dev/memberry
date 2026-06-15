// packages/code/src/__tests__/indexer.project.live.test.ts
// End-to-end: indexProject over a real temp project against a real Neo4j.
// Exercises the whole indexing pipeline together — bounded-concurrency Phase 1,
// top-level (null-parent) symbol upsert, batched intra-file relations, and batched
// cross-file import resolution. Skips when Neo4j is unreachable.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createNeo4jDriver } from '@memberry/neo4j';
import { CodeIndexer } from '../indexer.js';

const NEO4J_URI = process.env.NEO4J_URI || 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || 'password';

const HELPERS = `export function add(a: number, b: number): number {
  return a + b;
}

export function double(n: number): number {
  return add(n, n);
}
`;
const MAIN = `import { add } from './helpers';

export function run(): number {
  return add(1, 2);
}
`;

describe('CodeIndexer.indexProject — end-to-end (live Neo4j)', () => {
  let available = false;
  const driver = createNeo4jDriver(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
  let dir = '';

  async function wipe(): Promise<void> {
    if (!dir) return;
    const s = driver.session();
    try {
      await s.run('MATCH (n:Symbol) WHERE n.file_path STARTS WITH $d DETACH DELETE n', { d: dir });
      await s.run('MATCH (e:Entity:Component) WHERE e.path STARTS WITH $d DETACH DELETE e', { d: dir });
    } finally { await s.close(); }
  }

  beforeAll(async () => {
    try { await driver.getServerInfo(); available = true; }
    catch { console.warn(`[skip] Neo4j not reachable at ${NEO4J_URI}`); return; }
    dir = await mkdtemp(join(tmpdir(), 'amp-indexproj-'));
    await writeFile(join(dir, 'helpers.ts'), HELPERS, 'utf8');
    await writeFile(join(dir, 'main.ts'), MAIN, 'utf8');
    await wipe();
  });

  afterAll(async () => {
    if (available) await wipe();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    await driver.close().catch(() => {});
  });

  it('indexes top-level symbols, intra-file calls, and cross-file imports', async () => {
    if (!available) return;
    const indexer = new CodeIndexer(driver);
    const result = await indexer.indexProject(dir);

    // Both files parsed, top-level symbols created (parent_symbol fix — no crash).
    expect(result.files_parsed).toBe(2);
    expect(result.symbols_created).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);

    const s = driver.session();
    try {
      // Top-level functions are present and read back with null parent.
      const syms = await s.run(
        `MATCH (sym:Symbol) WHERE sym.file_path STARTS WITH $d RETURN sym.name AS name, sym.parent_symbol AS parent`,
        { d: dir },
      );
      const names = syms.records.map((r) => r.get('name'));
      expect(names).toEqual(expect.arrayContaining(['add', 'double', 'run']));
      // Top-level symbols store the '' sentinel (raw) — proves the upsert no longer
      // crashes on null parent. mapSymbol normalises '' -> null for callers (covered
      // by symbol-store.parent-symbol.live.test.ts).
      const addRow = syms.records.find((r) => r.get('name') === 'add');
      expect(addRow!.get('parent')).toBe('');

      // Intra-file SYMBOL_CALLS: double() -> add() (batched relation resolver).
      const calls = await s.run(
        `MATCH (:Symbol {name: 'double'})-[:SYMBOL_CALLS]->(:Symbol {name: 'add'})
         WHERE true RETURN count(*) AS n`,
      );
      expect(calls.records[0]!.get('n').toNumber()).toBeGreaterThan(0);

      // Cross-file SYMBOL_IMPORTS: main.ts -> helpers.ts (batched import resolver).
      const imports = await s.run(
        `MATCH (f:Symbol)-[:SYMBOL_IMPORTS]->(t:Symbol)
         WHERE f.file_path ENDS WITH 'main.ts' AND t.file_path ENDS WITH 'helpers.ts'
           AND f.file_path STARTS WITH $d
         RETURN count(*) AS n`,
        { d: dir },
      );
      expect(imports.records[0]!.get('n').toNumber()).toBeGreaterThan(0);
    } finally {
      await s.close();
    }
  });
});
