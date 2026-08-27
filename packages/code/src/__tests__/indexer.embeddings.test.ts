// IDX-003 acceptance gate — assertions C1-C8.
//
// THE DEFECT. CodeIndexer's constructor was `constructor(private driver: Driver)`.
// It had no embedding provider, so `symbol.embedding` was never assigned and the
// `if (symbol.embedding)` branch that derives `mini_vector` never once executed.
// Live graph, 2026-08-27, every project since the code index was built:
//
//   project:memberry      16,399 symbols   embedding: 0   mini_vector: 0
//   project:hermes-agent  15,055           0              0
//   project:neuri         12,339           0              0
//   project:ag3ntic        5,385           0              0
//   (un-stamped)           5,136           0              0
//
// So `symbol_embedding` was an empty vector index, the `code.dense-vector`
// channel returned zero rows on every query, and code search ran lexical-only.
// It reported SUCCESS throughout, which is why it survived this long — see C9-C11
// in migrations.empty-vectors.test.ts for the guard that makes it loud.
//
// Consequence, measured: "reciprocal rank fusion" could not retrieve fusion.ts
// (which exports `rrfFusion`) at any rank, while the literal token "rrf" found
// it at rank 2. Concepts did not retrieve; only substrings did.

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
    resolveImportsBatch: vi.fn(),
    linkAllSymbolsToEntities: vi.fn(),
  };
});

vi.mock('../parser.js', () => ({ parseFile: mocks.parseFile }));
vi.mock('../symbol-store.js', () => ({ SymbolStore: vi.fn(() => mocks.symbolStore) }));
vi.mock('../resolver.js', () => ({
  ImportResolver: vi.fn(() => ({
    resolveImports: mocks.resolveImports,
    resolveImportsBatch: mocks.resolveImportsBatch,
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
  const session = { run: vi.fn(async () => ({ records: [{ get: () => 0 }] })), close: vi.fn() };
  return { session: vi.fn(() => session) };
}

/** A provider that returns a distinct deterministic 1536-vector per input. */
function makeProvider(over: Partial<{ available: boolean; embedBatch: unknown }> = {}) {
  return {
    available: over.available,
    embed: vi.fn(async () => new Array(1536).fill(0.1)),
    embedBatch: over.embedBatch ?? vi.fn(async (texts: string[]) =>
      texts.map((_t, i) => new Array(1536).fill((i + 1) / 100))),
  };
}

async function indexWith(provider: unknown, symbols: SymbolNode[]) {
  const { CodeIndexer } = await import('../indexer.js');
  mocks.parseFile.mockResolvedValue({
    file_path: '/repo/src/sample.ts', language: 'typescript', symbols, imports: [], relations: [],
  });
  mocks.symbolStore.getHashesByFile.mockResolvedValue(new Set<string>());
  mocks.symbolStore.upsertSymbols.mockResolvedValue({ created: symbols.length, updated: 0 });
  const indexer = new CodeIndexer(makeDriver() as never, provider as never);
  await indexer.indexFile('/repo/src/sample.ts', 'typescript');
  return (mocks.symbolStore.upsertSymbols.mock.calls[0]?.[0] ?? []) as SymbolNode[];
}

describe('IDX-003 dense embeddings at index time', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveImports.mockResolvedValue(0);
    mocks.resolveImportsBatch.mockResolvedValue(0);
    mocks.linkAllSymbolsToEntities.mockResolvedValue(0);
    mocks.symbolStore.getByFile.mockResolvedValue([]);
  });

  it('C1 — with a provider, every stored symbol carries an embedding AND a mini_vector', async () => {
    const stored = await indexWith(makeProvider(), [
      makeSymbol({ id: 'a', name: 'alpha', content_hash: 'h-a' }),
      makeSymbol({ id: 'b', name: 'beta', content_hash: 'h-b' }),
    ]);
    expect(stored).toHaveLength(2);
    for (const s of stored) {
      expect(s.embedding).toHaveLength(1536);
      // mini_vector was unreachable before: it is derived FROM the embedding.
      expect(s.mini_vector).toHaveLength(64);
    }
  });

  it('C2 — the whole file is ONE provider call, not one per symbol', async () => {
    const provider = makeProvider();
    await indexWith(provider, [1, 2, 3, 4, 5].map((n) =>
      makeSymbol({ id: `s${n}`, name: `sym${n}`, content_hash: `h-${n}` })));
    expect(provider.embedBatch).toHaveBeenCalledTimes(1);
    expect((provider.embedBatch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toHaveLength(5);
    expect(provider.embed).not.toHaveBeenCalled();
  });

  it('C3 — the embedded text is exactly symbolVectorText: name, signature, doc', async () => {
    const { symbolVectorText } = await import('../indexer.js');
    const provider = makeProvider();
    const symbol = makeSymbol({
      id: 'a', name: 'rrfFusion', content_hash: 'h-a',
      signature: 'function rrfFusion(lists, limit)',
      doc_comment: 'Reciprocal rank fusion across channel lists.',
    });
    await indexWith(provider, [symbol]);
    const sent = (provider.embedBatch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
    expect(sent).toEqual([symbolVectorText(symbol)]);
    // The concept the query would use must actually be IN the embedded text —
    // this is the whole reason "reciprocal rank fusion" could not find this file.
    expect(sent[0]).toContain('Reciprocal rank fusion');
    expect(sent[0]).toContain('rrfFusion');
  });

  it('C4 — symbolVectorText joins only the non-empty parts, in a stable order', async () => {
    const { symbolVectorText } = await import('../indexer.js');
    expect(symbolVectorText({ name: 'a', signature: 'sig', doc_comment: 'doc' })).toBe('a sig doc');
    expect(symbolVectorText({ name: 'a', signature: '', doc_comment: 'doc' })).toBe('a doc');
    expect(symbolVectorText({ name: 'a', signature: '', doc_comment: '' })).toBe('a');
  });

  it('C5 — no provider: indexing still succeeds, lexical-only, exactly as before', async () => {
    const stored = await indexWith(undefined, [
      makeSymbol({ id: 'a', name: 'alpha', content_hash: 'h-a' }),
    ]);
    expect(stored).toHaveLength(1);
    expect(stored[0].embedding).toBeUndefined();
    expect(stored[0].mini_vector).toBeUndefined();
    // The lexical channels are unaffected — they never depended on the provider.
    expect(stored[0].lexical_vector).toBeDefined();
    expect(stored[0].sparse_indices).toBeDefined();
  });

  it('C6 — a degraded provider (available === false) is skipped, not called', async () => {
    const provider = makeProvider({ available: false });
    const stored = await indexWith(provider, [
      makeSymbol({ id: 'a', name: 'alpha', content_hash: 'h-a' }),
    ]);
    expect(provider.embedBatch).not.toHaveBeenCalled();
    expect(stored[0].embedding).toBeUndefined();
    // Its vectors would be meaningless (all-zeros); storing them would rank on noise.
  });

  it('C7 — an embedding outage is NON-FATAL: symbols are still indexed', async () => {
    const provider = makeProvider({
      embedBatch: vi.fn(async () => { throw new Error('429 rate limit'); }),
    });
    const stored = await indexWith(provider, [
      makeSymbol({ id: 'a', name: 'alpha', content_hash: 'h-a' }),
      makeSymbol({ id: 'b', name: 'beta', content_hash: 'h-b' }),
    ]);
    // Losing the dense channel must degrade retrieval, never lose the code.
    expect(stored).toHaveLength(2);
    expect(stored[0].embedding).toBeUndefined();
    expect(stored[0].lexical_vector).toBeDefined();
  });

  it('C8 — a malformed vector is rejected rather than stored', async () => {
    const provider = makeProvider({
      embedBatch: vi.fn(async () => [[], new Array(1536).fill(0.5)]),
    });
    const stored = await indexWith(provider, [
      makeSymbol({ id: 'a', name: 'alpha', content_hash: 'h-a' }),
      makeSymbol({ id: 'b', name: 'beta', content_hash: 'h-b' }),
    ]);
    // An empty vector is a provider contract violation. Storing it would put a
    // meaningless point in the index and rank real queries against it.
    expect(stored[0].embedding).toBeUndefined();
    expect(stored[0].mini_vector).toBeUndefined();
    expect(stored[1].embedding).toHaveLength(1536);
    expect(stored[1].mini_vector).toHaveLength(64);
  });

  it('C9 — unchanged symbols are not re-embedded: a no-op reindex costs nothing', async () => {
    const { CodeIndexer } = await import('../indexer.js');
    const provider = makeProvider();
    const a = makeSymbol({ id: 'a', name: 'alpha', content_hash: 'h-a' });
    const b = makeSymbol({ id: 'b', name: 'beta', content_hash: 'h-b' });
    mocks.parseFile.mockResolvedValue({
      file_path: '/repo/src/sample.ts', language: 'typescript',
      symbols: [a, b], imports: [], relations: [],
    });
    // Both already stored with identical content hashes.
    mocks.symbolStore.getHashesByFile.mockResolvedValue(new Set(['h-a', 'h-b']));
    mocks.symbolStore.upsertSymbols.mockResolvedValue({ created: 0, updated: 0 });

    const indexer = new CodeIndexer(makeDriver() as never, provider as never);
    await indexer.indexFile('/repo/src/sample.ts', 'typescript');

    // Embedding is the expensive step; the content-hash skip must gate it.
    expect(provider.embedBatch).not.toHaveBeenCalled();
    expect(mocks.symbolStore.upsertSymbols).not.toHaveBeenCalled();
  });
});
