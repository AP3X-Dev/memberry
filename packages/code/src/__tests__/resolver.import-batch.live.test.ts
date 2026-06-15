// packages/code/src/__tests__/resolver.import-batch.live.test.ts
// End-to-end validation of resolveImportsBatch against a real Neo4j: one UNWIND
// round-trip resolves an import in memory and creates the correct, specifier-
// filtered SYMBOL_IMPORTS edge. The target file is in the indexed set but NOT on
// disk, so a created edge proves resolution did not rely on fs.stat.
//
// Skips when Neo4j is unreachable.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createNeo4jDriver } from '@memberry/neo4j';
import { ImportResolver } from '../resolver.js';
import type { ImportInfo } from '../types.js';

const NEO4J_URI = process.env.NEO4J_URI || 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || 'password';

const ROOT = '/tmp/amp-impbatch';
const A = `${ROOT}/a.ts`; // importer
const B = `${ROOT}/b.ts`; // target — NOT written to disk

describe('resolveImportsBatch — batched import edges (live Neo4j)', () => {
  let available = false;
  const driver = createNeo4jDriver(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);

  async function wipe(): Promise<void> {
    const s = driver.session();
    try { await s.run('MATCH (n:Symbol) WHERE n.file_path IN $p DETACH DELETE n', { p: [A, B] }); }
    finally { await s.close(); }
  }

  beforeAll(async () => {
    try { await driver.getServerInfo(); available = true; }
    catch { console.warn(`[skip] Neo4j not reachable at ${NEO4J_URI}`); return; }
    await wipe();
    const s = driver.session();
    try {
      await s.run(
        `UNWIND $rows AS r
         CREATE (x:Symbol { id: r.id, name: r.name, kind: r.kind, language: 'typescript',
                            file_path: r.fp, start_line: 1, end_line: 1, parent_symbol: '' })`,
        { rows: [
          { id: 'ib-a', name: 'a', kind: 'module', fp: A },
          { id: 'ib-foo', name: 'foo', kind: 'function', fp: B },
          { id: 'ib-bar', name: 'bar', kind: 'function', fp: B },
        ] },
      );
    } finally { await s.close(); }
  });

  afterAll(async () => {
    if (available) await wipe();
    await driver.close().catch(() => {});
  });

  it('creates the specifier-filtered import edge via one in-memory-resolved UNWIND', async () => {
    if (!available) return;
    const resolver = new ImportResolver(driver);

    // B is indexed but the file does not exist on disk → resolution must be in-memory.
    const indexedPaths = new Set([A, B]);
    const imports: ImportInfo[] = [
      { file_path: A, source: './b', specifiers: ['foo'] } as ImportInfo,
    ];

    const created = await resolver.resolveImportsBatch(imports, ROOT, indexedPaths);
    expect(created).toBeGreaterThan(0);

    const s = driver.session();
    try {
      // a → foo (the imported specifier) exists.
      const hit = await s.run(
        `MATCH (:Symbol {id: 'ib-a'})-[:SYMBOL_IMPORTS]->(t:Symbol {id: 'ib-foo'}) RETURN count(*) AS n`,
      );
      expect(hit.records[0]!.get('n').toNumber()).toBe(1);

      // a → bar (NOT imported) must not exist — specifier filter holds.
      const miss = await s.run(
        `MATCH (:Symbol {id: 'ib-a'})-[:SYMBOL_IMPORTS]->(t:Symbol {id: 'ib-bar'}) RETURN count(*) AS n`,
      );
      expect(miss.records[0]!.get('n').toNumber()).toBe(0);
    } finally {
      await s.close();
    }
  });
});
