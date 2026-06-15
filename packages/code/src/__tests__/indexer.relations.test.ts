import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SymbolNode } from '../types.js';

const mocks = vi.hoisted(() => {
  const symbolStore = {
    getHashesByFile: vi.fn(),
    findByCompositeKey: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    getByFile: vi.fn(),
  };
  return {
    parseFile: vi.fn(),
    symbolStore,
    resolveImports: vi.fn(),
    linkAllSymbolsToEntities: vi.fn(),
  };
});

vi.mock('../parser.js', () => ({
  parseFile: mocks.parseFile,
}));

vi.mock('../symbol-store.js', () => ({
  SymbolStore: vi.fn(() => mocks.symbolStore),
}));

vi.mock('../resolver.js', () => ({
  ImportResolver: vi.fn(() => ({
    resolveImports: mocks.resolveImports,
    linkAllSymbolsToEntities: mocks.linkAllSymbolsToEntities,
  })),
}));

function makeSymbol(overrides: Partial<SymbolNode>): SymbolNode {
  return {
    id: 'sym-default',
    name: 'defaultSymbol',
    kind: 'function',
    language: 'typescript',
    file_path: '/repo/src/sample.ts',
    start_line: 1,
    end_line: 1,
    signature: 'function defaultSymbol() {}',
    doc_comment: '',
    content_hash: 'hash-default',
    parent_symbol: null,
    created_at: '2026-05-29T00:00:00.000Z',
    updated_at: '2026-05-29T00:00:00.000Z',
    ...overrides,
  };
}

describe('CodeIndexer relation resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveImports.mockResolvedValue(0);
    mocks.linkAllSymbolsToEntities.mockResolvedValue(0);
  });

  it('batches same-type relations into ONE UNWIND round-trip, carrying per-row fallback metadata', async () => {
    const { CodeIndexer } = await import('../indexer.js');
    const run = makeSymbol({
      id: 'fresh-run-id',
      name: 'run',
      start_line: 5,
      end_line: 7,
      content_hash: 'hash-run',
    });
    const helper = makeSymbol({
      id: 'fresh-helper-id',
      name: 'helper',
      start_line: 1,
      end_line: 3,
      content_hash: 'hash-helper',
    });
    const other = makeSymbol({
      id: 'fresh-other-id',
      name: 'other',
      start_line: 9,
      end_line: 11,
      content_hash: 'hash-other',
    });

    mocks.parseFile.mockResolvedValue({
      file_path: '/repo/src/sample.ts',
      language: 'typescript',
      symbols: [helper, run, other],
      imports: [],
      // Two relations of the SAME type — the batch must issue ONE query, not two.
      relations: [
        { from_symbol: run.id, to_symbol: 'helper', type: 'SYMBOL_CALLS' },
        { from_symbol: run.id, to_symbol: 'other', type: 'SYMBOL_CALLS' },
      ],
    });
    mocks.symbolStore.getHashesByFile.mockResolvedValue(new Set(['hash-run', 'hash-helper', 'hash-other']));
    mocks.symbolStore.getByFile.mockResolvedValue([helper, run, other]);

    const runCalls: Array<{ query: string; params: Record<string, unknown> }> = [];
    const session = {
      run: vi.fn(async (query: string, params: Record<string, unknown> = {}) => {
        runCalls.push({ query, params });
        return { records: [{ get: () => 2 }] };
      }),
      close: vi.fn(),
    };
    const driver = { session: vi.fn(() => session) };

    const indexer = new CodeIndexer(driver as never);
    const result = await indexer.indexFile('/repo/src/sample.ts', 'typescript');

    // Exactly ONE relation round-trip for both SYMBOL_CALLS relations (was 2).
    const relationCalls = runCalls.filter((call) => call.query.includes('MERGE (from)-[:SYMBOL_CALLS]->(to)'));
    expect(relationCalls).toHaveLength(1);

    const relationCall = relationCalls[0]!;
    expect(relationCall.query).toContain('UNWIND $rows AS row');
    expect(relationCall.query).toContain('from.name = row.fromName');
    expect(relationCall.params.filePath).toBe('/repo/src/sample.ts');

    // Both relations are carried as rows, each with the stable fallback metadata
    // used when an unchanged symbol's transient parser id can't be matched.
    const rows = relationCall.params.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      fromRef: run.id,
      fromName: 'run',
      fromKind: 'function',
      fromStartLine: 5,
      toRef: 'helper',
    });
    expect(rows[1]).toMatchObject({ fromRef: run.id, toRef: 'other' });

    // count(*) from the batch flows back as relations_created.
    expect(result.relations_created).toBe(2);
  });
});
