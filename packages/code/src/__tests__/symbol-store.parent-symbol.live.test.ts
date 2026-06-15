// packages/code/src/__tests__/symbol-store.parent-symbol.live.test.ts
// Regression: upsertSymbols MERGEs on (name, file_path, kind, parent_symbol).
// Neo4j REJECTS a null property in a MERGE pattern ("Cannot merge node because of
// null property value"), so top-level symbols (parent_symbol = null — virtually
// every file) failed to index. Fix: write a '' sentinel for "no parent" and
// normalise '' -> null on read, preserving the string|null contract.
//
// Live test (skips when Neo4j unreachable).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createNeo4jDriver } from '@memberry/neo4j';
import { SymbolStore } from '../symbol-store.js';
import type { SymbolNode } from '../types.js';

const NEO4J_URI = process.env.NEO4J_URI || 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || 'password';

const P = '/tmp/amp-parentsym/sample.ts';

function sym(over: Partial<SymbolNode>): SymbolNode {
  return {
    id: 'ps-x', name: 'x', kind: 'function', language: 'typescript',
    file_path: P, start_line: 1, end_line: 2, signature: '', doc_comment: '',
    content_hash: 'h', parent_symbol: null,
    created_at: '2024-01-01', updated_at: '2024-01-01', ...over,
  };
}

describe('SymbolStore.upsertSymbols — top-level (null parent_symbol) symbols (live Neo4j)', () => {
  let available = false;
  const driver = createNeo4jDriver(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
  let store: SymbolStore;

  async function wipe(): Promise<void> {
    const s = driver.session();
    try { await s.run('MATCH (n:Symbol {file_path: $p}) DETACH DELETE n', { p: P }); }
    finally { await s.close(); }
  }

  beforeAll(async () => {
    try { await driver.getServerInfo(); available = true; }
    catch { console.warn(`[skip] Neo4j not reachable at ${NEO4J_URI}`); return; }
    await wipe();
    store = new SymbolStore(driver);
  });

  afterAll(async () => {
    if (available) await wipe();
    await driver.close().catch(() => {});
  });

  it('upserts a top-level symbol (null parent), reads it back as null, and is idempotent', async () => {
    if (!available) return;
    const top = sym({ id: 'ps-top', name: 'topFn', parent_symbol: null, content_hash: 'h-top' });

    const r1 = await store.upsertSymbols([top]); // pre-fix: throws on null MERGE key
    expect(r1.created).toBe(1);

    const read = (await store.getByFile(P)).find((s) => s.id === 'ps-top');
    expect(read).toBeDefined();
    expect(read!.parent_symbol).toBeNull(); // string|null contract preserved

    // Re-upsert the same symbol → ON MATCH (no duplicate node).
    const r2 = await store.upsertSymbols([top]);
    expect(r2.created).toBe(0);
    expect(r2.updated).toBe(1);
    expect((await store.getByFile(P)).filter((s) => s.name === 'topFn')).toHaveLength(1);
  });

  it('still stores a child symbol (non-null parent) and reads the parent back unchanged', async () => {
    if (!available) return;
    const child = sym({ id: 'ps-child', name: 'method', kind: 'method', parent_symbol: 'ps-top', content_hash: 'h-child' });

    const r = await store.upsertSymbols([child]);
    expect(r.created).toBe(1);

    const read = (await store.getByFile(P)).find((s) => s.id === 'ps-child');
    expect(read!.parent_symbol).toBe('ps-top');
  });
});
