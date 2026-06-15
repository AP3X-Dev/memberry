// packages/code/src/__tests__/resolver.import-batch.test.ts
// resolveImportsBatch resolves every import's target path IN MEMORY against the
// indexed-file set and creates all SYMBOL_IMPORTS edges in ONE UNWIND round-trip
// (was one fs.stat storm + one Neo4j round-trip per import).
import { describe, it, expect, vi } from 'vitest';
import { ImportResolver } from '../resolver.js';
import type { ImportInfo } from '../types.js';

describe('ImportResolver.resolveImportsBatch', () => {
  it('resolves imports in-memory and issues exactly ONE UNWIND round-trip', async () => {
    const calls: Array<{ q: string; p: Record<string, unknown> }> = [];
    const session = {
      run: vi.fn(async (q: string, p: Record<string, unknown> = {}) => {
        calls.push({ q, p });
        return { records: [{ get: () => 2 }] };
      }),
      close: vi.fn(),
    };
    const driver = { session: vi.fn(() => session) };
    const resolver = new ImportResolver(driver as never);

    // Target files exist only in the indexed set (NOT on disk) — so a created edge
    // proves resolution happened in memory, not via fs.stat.
    const indexed = new Set(['/proj/b.ts', '/proj/c.ts']);
    const imports: ImportInfo[] = [
      { file_path: '/proj/a.ts', source: './b', specifiers: ['foo'] } as ImportInfo,
      { file_path: '/proj/a.ts', source: './c', specifiers: [] } as ImportInfo,
    ];

    const n = await resolver.resolveImportsBatch(imports, '/proj', indexed);

    const importCalls = calls.filter((c) => c.q.includes('MERGE (from)-[:SYMBOL_IMPORTS]->(to)'));
    expect(importCalls).toHaveLength(1); // one round-trip for both imports
    expect(importCalls[0]!.q).toContain('UNWIND $rows AS row');

    const rows = importCalls[0]!.p.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ fromPath: '/proj/a.ts', toPath: '/proj/b.ts', specifiers: ['foo'], noSpecifiers: false });
    expect(rows[1]).toMatchObject({ fromPath: '/proj/a.ts', toPath: '/proj/c.ts', noSpecifiers: true });
    expect(n).toBe(2);
  });

  it('drops imports that resolve nowhere (no row, no edge)', async () => {
    const session = { run: vi.fn(), close: vi.fn() };
    const driver = { session: vi.fn(() => session) };
    const resolver = new ImportResolver(driver as never);

    // bare module specifier (not ./ or /) → unresolvable → no rows → no query at all.
    const imports: ImportInfo[] = [
      { file_path: '/proj/a.ts', source: 'react', specifiers: ['useState'] } as ImportInfo,
    ];
    const n = await resolver.resolveImportsBatch(imports, '/proj', new Set());

    expect(n).toBe(0);
    expect(session.run).not.toHaveBeenCalled();
  });
});
