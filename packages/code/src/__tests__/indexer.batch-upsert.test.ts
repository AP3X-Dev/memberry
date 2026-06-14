// packages/code/src/__tests__/indexer.batch-upsert.test.ts
// Pins the N+1 fix for the per-symbol upsert in CodeIndexer.indexFile.
//
// The prior loop issued findByCompositeKey + create/update PER changed symbol
// (O(N) round-trips for N symbols). The fix collects changed symbols and upserts
// them in ONE batched SymbolStore.upsertSymbols call, while preserving:
//   - the content-hash skip (unchanged symbols are not rewritten),
//   - the same symbol set / properties handed to the store,
//   - the create/update tally returned by indexFile.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SymbolNode } from '../types.js';

const mocks = vi.hoisted(() => {
  const symbolStore = {
    getHashesByFile: vi.fn(),
    findByCompositeKey: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    upsertSymbols: vi.fn(),
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

function makeDriver() {
  const session = {
    run: vi.fn(async () => ({ records: [{ get: () => 0 }] })),
    close: vi.fn(),
  };
  return { session: vi.fn(() => session) };
}

describe('CodeIndexer batched symbol upsert (N+1 fix)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveImports.mockResolvedValue(0);
    mocks.linkAllSymbolsToEntities.mockResolvedValue(0);
    mocks.symbolStore.getByFile.mockResolvedValue([]);
  });

  it('upserts all changed symbols in ONE batched call, not per-symbol', async () => {
    const { CodeIndexer } = await import('../indexer.js');

    const a = makeSymbol({ id: 'a', name: 'alpha', content_hash: 'h-a', start_line: 1 });
    const b = makeSymbol({ id: 'b', name: 'beta', content_hash: 'h-b', start_line: 5 });
    const c = makeSymbol({ id: 'c', name: 'gamma', content_hash: 'h-c', start_line: 9 });

    mocks.parseFile.mockResolvedValue({
      file_path: '/repo/src/sample.ts',
      language: 'typescript',
      symbols: [a, b, c],
      imports: [],
      relations: [],
    });
    // No existing hashes -> all three are "changed".
    mocks.symbolStore.getHashesByFile.mockResolvedValue(new Set<string>());
    mocks.symbolStore.upsertSymbols.mockResolvedValue({ created: 3, updated: 0 });

    const indexer = new CodeIndexer(makeDriver() as never);
    const result = await indexer.indexFile('/repo/src/sample.ts', 'typescript');

    // The N+1 is gone: ONE batched upsert for the whole file's symbols.
    expect(mocks.symbolStore.upsertSymbols).toHaveBeenCalledTimes(1);
    // The per-symbol path must NOT be used anymore.
    expect(mocks.symbolStore.findByCompositeKey).not.toHaveBeenCalled();
    expect(mocks.symbolStore.create).not.toHaveBeenCalled();
    expect(mocks.symbolStore.update).not.toHaveBeenCalled();

    // Same symbol SET handed to the store (identity-preserving).
    const batched = mocks.symbolStore.upsertSymbols.mock.calls[0][0] as SymbolNode[];
    expect(batched).toHaveLength(3);
    expect(batched.map((s) => s.id).sort()).toEqual(['a', 'b', 'c']);
    expect(batched.map((s) => s.name).sort()).toEqual(['alpha', 'beta', 'gamma']);

    // Created/updated tally is preserved from the batched result.
    expect(result.symbols_created).toBe(3);
    expect(result.symbols_updated).toBe(0);
  });

  it('preserves content-hash skip: unchanged file produces no upsert (no-op batch)', async () => {
    const { CodeIndexer } = await import('../indexer.js');

    const a = makeSymbol({ id: 'a', name: 'alpha', content_hash: 'h-a' });
    const b = makeSymbol({ id: 'b', name: 'beta', content_hash: 'h-b' });

    mocks.parseFile.mockResolvedValue({
      file_path: '/repo/src/sample.ts',
      language: 'typescript',
      symbols: [a, b],
      imports: [],
      relations: [],
    });
    // Both hashes already present -> nothing changed.
    mocks.symbolStore.getHashesByFile.mockResolvedValue(new Set(['h-a', 'h-b']));
    mocks.symbolStore.getByFile.mockResolvedValue([a, b]);

    const indexer = new CodeIndexer(makeDriver() as never);
    const result = await indexer.indexFile('/repo/src/sample.ts', 'typescript');

    // Skip preserved: no symbols rewritten at all.
    expect(mocks.symbolStore.upsertSymbols).not.toHaveBeenCalled();
    expect(result.symbols_created).toBe(0);
    expect(result.symbols_updated).toBe(0);
  });

  it('batches only the changed subset when some symbols are unchanged', async () => {
    const { CodeIndexer } = await import('../indexer.js');

    const unchanged = makeSymbol({ id: 'u', name: 'keep', content_hash: 'h-keep' });
    const changed = makeSymbol({ id: 'x', name: 'edited', content_hash: 'h-new' });

    mocks.parseFile.mockResolvedValue({
      file_path: '/repo/src/sample.ts',
      language: 'typescript',
      symbols: [unchanged, changed],
      imports: [],
      relations: [],
    });
    // Only the unchanged symbol's hash is already present.
    mocks.symbolStore.getHashesByFile.mockResolvedValue(new Set(['h-keep']));
    mocks.symbolStore.upsertSymbols.mockResolvedValue({ created: 0, updated: 1 });

    const indexer = new CodeIndexer(makeDriver() as never);
    const result = await indexer.indexFile('/repo/src/sample.ts', 'typescript');

    expect(mocks.symbolStore.upsertSymbols).toHaveBeenCalledTimes(1);
    const batched = mocks.symbolStore.upsertSymbols.mock.calls[0][0] as SymbolNode[];
    expect(batched).toHaveLength(1);
    expect(batched[0].id).toBe('x');
    expect(result.symbols_updated).toBe(1);
    expect(result.symbols_created).toBe(0);
  });
});
