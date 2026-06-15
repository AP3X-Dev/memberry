// packages/code/src/__tests__/indexer.relations.live.test.ts
// Validates the BATCHED intra-file relation resolver (resolveRelationsBatch — one
// UNWIND round-trip per type, per-row CALL{} endpoint resolution + ORDER BY
// tie-break, MERGE) against a real Neo4j. The unit test mocks the driver, so the
// actual Cypher is only exercised here.
//
// Symbols are CREATEd directly (not via indexFile) so this test is independent of
// the symbol-upsert path. Skips when Neo4j is unreachable.
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createNeo4jDriver } from '@memberry/neo4j';
import { CodeIndexer } from '../indexer.js';

const NEO4J_URI = process.env.NEO4J_URI || 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || 'password';

const P = '/tmp/amp-relbatch/sample.ts';
const OTHER = '/tmp/amp-relbatch/other.ts';

// Reach the private batch method without adding a production test seam.
type BatchFn = (
  relations: Array<{ from_symbol: string; to_symbol: string; type: string }>,
  filePath: string,
  symbolById: Map<string, { name: string; kind: string; start_line: number }>,
) => Promise<number>;

describe('resolveRelationsBatch — batched intra-file relations (live Neo4j)', () => {
  let available = false;
  const driver = createNeo4jDriver(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);

  async function wipe(): Promise<void> {
    const s = driver.session();
    try {
      await s.run('MATCH (n:Symbol) WHERE n.file_path IN $paths DETACH DELETE n', { paths: [P, OTHER] });
    } finally {
      await s.close();
    }
  }

  beforeAll(async () => {
    try { await driver.getServerInfo(); available = true; }
    catch { console.warn(`[skip] Neo4j not reachable at ${NEO4J_URI} — skipping live relation batch test`); return; }
    await wipe();
    const s = driver.session();
    try {
      // helper@1, run@5, two same-named dup@10 / dup@20 (tie-break), and a
      // same-named helper in ANOTHER file (must not be matched by file-scoped rules).
      await s.run(
        `UNWIND $rows AS r
         CREATE (x:Symbol { id: r.id, name: r.name, kind: 'function', language: 'typescript',
                            file_path: r.fp, start_line: r.line, end_line: r.line, parent_symbol: '' })`,
        { rows: [
          { id: 'rb-a', name: 'helper', fp: P, line: 1 },
          { id: 'rb-b', name: 'run', fp: P, line: 5 },
          { id: 'rb-c', name: 'dup', fp: P, line: 10 },
          { id: 'rb-d', name: 'dup', fp: P, line: 20 },
          { id: 'rb-e', name: 'helper', fp: OTHER, line: 1 },
        ] },
      );
    } finally { await s.close(); }
  });

  afterAll(async () => {
    if (available) await wipe();
    await driver.close().catch(() => {});
  });

  it('resolves id, name+file, and tie-break endpoints in one batch — correct, file-scoped, idempotent', async () => {
    if (!available) return;
    const indexer = new CodeIndexer(driver);
    const batch = (indexer as unknown as { resolveRelationsBatch: BatchFn }).resolveRelationsBatch.bind(indexer);

    // Fallback metadata keyed by parser ref (mirrors indexFile's symbolById).
    const symbolById = new Map<string, { name: string; kind: string; start_line: number }>([
      ['run', { name: 'run', kind: 'function', start_line: 5 }],
      ['helper', { name: 'helper', kind: 'function', start_line: 1 }],
      ['dup', { name: 'dup', kind: 'function', start_line: 20 }], // tie-break → dup@20
    ]);

    const resolved = await batch(
      [
        { from_symbol: 'rb-b', to_symbol: 'rb-a', type: 'SYMBOL_CALLS' }, // id → id
        { from_symbol: 'run', to_symbol: 'helper', type: 'SYMBOL_CALLS' }, // name+file → SAME edge (idempotent)
        { from_symbol: 'rb-b', to_symbol: 'dup', type: 'SYMBOL_CALLS' },  // name tie-break → dup@20 (rb-d), not rb-c
      ],
      P,
      symbolById,
    );

    expect(resolved).toBe(3); // all three rows reached MERGE

    const s = driver.session();
    try {
      // run → helper exists exactly once despite two rows targeting it.
      const calls = await s.run(
        `MATCH (a:Symbol {id: 'rb-b'})-[r:SYMBOL_CALLS]->(b:Symbol {id: 'rb-a'}) RETURN count(r) AS n`,
      );
      expect(calls.records[0]!.get('n').toNumber()).toBe(1);

      // The 'dup' tie-break picked start_line 20 (rb-d), NOT rb-c.
      const dup = await s.run(
        `MATCH (a:Symbol {id: 'rb-b'})-[:SYMBOL_CALLS]->(t:Symbol {name: 'dup'}) RETURN t.id AS id, t.start_line AS line`,
      );
      expect(dup.records).toHaveLength(1);
      expect(dup.records[0]!.get('id')).toBe('rb-d');
      expect(Number(dup.records[0]!.get('line'))).toBe(20);

      // File scoping: the same-named helper in OTHER.ts was never linked.
      const leak = await s.run(
        `MATCH (a:Symbol {id: 'rb-b'})-[:SYMBOL_CALLS]->(x:Symbol {file_path: $other}) RETURN count(x) AS n`,
        { other: OTHER },
      );
      expect(leak.records[0]!.get('n').toNumber()).toBe(0);
    } finally {
      await s.close();
    }
  });
});
