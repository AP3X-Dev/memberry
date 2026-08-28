// IDX-004 acceptance gate — spec §5, assertions S1-S8 and S13-S16.
// (S9/S10 cover the adapter and live in packages/retrieval; A11' extends the existing tripwire
// in search.kind-rank.test.ts rather than being duplicated here.)
//
// The flag is read ONCE at module load, so every flag-sensitive assertion uses the A10
// convention: vi.resetModules() -> set env -> dynamic import(). No Neo4j, no network.

import { describe, expect, it, vi } from 'vitest';

import { CODE_RERANK_FLAG, KIND_RANK_FLAG, widenLimit } from '../search.js';
import type { CodeSearchResult } from '../types.js';

interface Row {
  name: string;
  kind?: string;
  file_path?: string;
  score?: number;
}

function symbolRecord(r: Row, index: number) {
  const properties = {
    id: `${r.file_path ?? 'src/x.ts'}#${r.name}`,
    name: r.name,
    kind: r.kind ?? 'function',
    language: 'typescript',
    file_path: r.file_path ?? 'src/x.ts',
    start_line: 1,
    signature: `function ${r.name}()`,
    doc_comment: '',
  };
  return { get: (key: string) => (key === 's' ? { properties } : (r.score ?? 1 - index / 1000)) };
}

function semanticRecord(id: string, content: string, score: number) {
  return {
    get: (key: string) => (key === 's' ? { properties: { id, content } } : score),
  };
}

/**
 * Fake driver that answers each channel by index name and records every call, so an assertion
 * can read the limit the channel was actually queried with.
 */
function driverFor(opts: { symbols?: Row[]; semantics?: Array<[string, string, number]> }) {
  const calls: Array<{ query: string; params: Record<string, unknown> }> = [];
  const run = vi.fn(async (query: string, params: Record<string, unknown> = {}) => {
    calls.push({ query, params });
    if (query.includes('symbol_search')) {
      return { records: (opts.symbols ?? []).map(symbolRecord) };
    }
    if (query.includes('semantic_embedding')) {
      return { records: (opts.semantics ?? []).map((s) => semanticRecord(...s)) };
    }
    return { records: [] };
  });
  return { driver: { session: () => ({ run, close: vi.fn(async () => undefined) }) }, calls };
}

const embedding = () => ({
  available: true,
  embed: vi.fn(async () => [0.1, 0.2]),
  embedBatch: vi.fn(async () => [[0.1, 0.2]]),
});

/** Load a fresh copy of search.ts under an exact flag environment. */
async function withFlags<T>(
  flags: Record<string, string | undefined>,
  body: (mod: typeof import('../search.js')) => Promise<T>,
): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(flags)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
  try {
    return await body(await import('../search.js'));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
  }
}

const names = (rows: CodeSearchResult[]): string[] => rows.map((r) => r.name);

/**
 * Sort key, NOT an ad-hoc comparator. A comparator written as
 * `a.source_type === 'semantic' ? -1 : b.source_type === 'semantic' ? 1 : 0` is not transitive,
 * and V8's insertion sort left the memory row where it started — which the S5/S14 preconditions
 * caught. A numeric key is a total order and cannot do that.
 */
const memoryFirst = (r: CodeSearchResult): number => (r.source_type === 'semantic' ? 0 : 1);

/** The limit the FULLTEXT channel was queried with — it receives `limit` undivided. */
function fulltextLimit(calls: Array<{ query: string; params: Record<string, unknown> }>): number {
  const call = calls.find((c) => c.query.includes('symbol_search'));
  const raw = call?.params.limit as { toNumber?: () => number } | number | undefined;
  if (raw === undefined) throw new Error('fulltext channel was never queried');
  return typeof raw === 'number' ? raw : raw.toNumber!();
}

function manySymbols(count: number, over: (i: number) => Row): Row[] {
  return Array.from({ length: count }, (_, i) => over(i));
}

describe('IDX-004 retrieve wide, rerank, prior last (spec §5)', () => {
  it('S4 — widenLimit never narrows what the caller asked for', () => {
    expect(widenLimit(10)).toBe(50);
    expect(widenLimit(20)).toBe(50);
    expect(widenLimit(50)).toBe(50);
    expect(widenLimit(100)).toBe(100);
  });

  it('S1 — only MEMBERRY_CODE_RERANK_V1=\'1\' engages; every other value is the shipped path', async () => {
    const rows = manySymbols(30, (i) => ({ name: `sym${i}`, score: 1 - i / 100 }));
    const probe = async (flagValue: string | undefined) => withFlags(
      { [CODE_RERANK_FLAG]: flagValue, [KIND_RANK_FLAG]: undefined },
      async ({ CodeSearch }) => {
        const { driver, calls } = driverFor({ symbols: rows });
        const reranker = vi.fn(async (_q: string, r: CodeSearchResult[]) => [...r].reverse());
        const search = new CodeSearch(driver as never, embedding(), reranker);
        const out = await search.search('q', { limit: 10, include_semantics: false, rerank: true });
        return { first: out[0]?.name, length: out.length, widened: fulltextLimit(calls), reranker };
      },
    );

    // Truthy-looking values must NOT coerce. This is the mutation "flag truthy-coerced".
    for (const value of [undefined, '0', 'true', 'yes', '']) {
      const r = await probe(value);
      expect(r.widened).toBe(10);
      expect(r.first).toBe('sym0');
      expect(r.reranker).not.toHaveBeenCalled();
    }
    const on = await probe('1');
    expect(on.widened).toBe(50);
    expect(on.reranker).toHaveBeenCalled();
  });

  it('S2 — flag ON + option widens the channel query to widenLimit(limit)', async () => {
    await withFlags({ [CODE_RERANK_FLAG]: '1' }, async ({ CodeSearch }) => {
      const { driver, calls } = driverFor({ symbols: manySymbols(60, (i) => ({ name: `s${i}` })) });
      const search = new CodeSearch(driver as never, embedding());
      await search.search('q', { limit: 10, include_semantics: false, rerank: true });
      expect(fulltextLimit(calls)).toBe(50);
    });
  });

  it('S3 — widening never leaks a bigger result set to the caller', async () => {
    await withFlags({ [CODE_RERANK_FLAG]: '1' }, async ({ CodeSearch }) => {
      const { driver } = driverFor({ symbols: manySymbols(60, (i) => ({ name: `s${i}` })) });
      const search = new CodeSearch(driver as never, embedding());
      const out = await search.search('q', { limit: 10, include_semantics: false, rerank: true });
      expect(out).toHaveLength(10);
    });
  });

  it('S5 — the prior runs AFTER the reranker: a memory row the reranker put first is demoted', async () => {
    await withFlags({ [CODE_RERANK_FLAG]: '1', [KIND_RANK_FLAG]: '1' }, async ({ CodeSearch }) => {
      const { driver } = driverFor({
        symbols: [{ name: 'realAnswer' }, { name: 'other' }],
        semantics: [['sem-aaaaaaaaaaaa', 'some memory prose', 0.99]],
      });
      const reranked: CodeSearchResult[][] = [];
      const reranker = vi.fn(async (_q: string, rows: CodeSearchResult[]) => {
        // Precondition, asserted rather than assumed: this fake MUST put the memory row first,
        // or the test proves nothing about ordering. (Verifier note on v3.)
        const out = [...rows].sort((a, b) => memoryFirst(a) - memoryFirst(b));
        // Snapshot, not the reference: `rankByNoise` sorts the array the reranker returned IN
        // PLACE, so storing `out` itself would show the post-prior order and the precondition
        // would silently describe the wrong moment.
        reranked.push([...out]);
        return out;
      });
      const search = new CodeSearch(driver as never, embedding(), reranker);
      const out = await search.search('q', { limit: 10, rerank: true });

      expect(reranked[0][0].source_type).toBe('semantic');
      expect(out[0].source_type).toBe('symbol');
      expect(out.at(-1)!.source_type).toBe('semantic');
    });
  });

  it('S14 — the prior still runs when KIND_RANK_V1 is UNSET, because rerank implies it', async () => {
    await withFlags({ [CODE_RERANK_FLAG]: '1', [KIND_RANK_FLAG]: undefined }, async ({ CodeSearch }) => {
      const { driver } = driverFor({
        symbols: [{ name: 'realAnswer' }, { name: 'other' }],
        semantics: [['sem-bbbbbbbbbbbb', 'some memory prose', 0.99]],
      });
      const reranked: CodeSearchResult[][] = [];
      const reranker = vi.fn(async (_q: string, rows: CodeSearchResult[]) => {
        const out = [...rows].sort((a, b) => memoryFirst(a) - memoryFirst(b));
        // Snapshot, not the reference: `rankByNoise` sorts the array the reranker returned IN
        // PLACE, so storing `out` itself would show the post-prior order and the precondition
        // would silently describe the wrong moment.
        reranked.push([...out]);
        return out;
      });
      const search = new CodeSearch(driver as never, embedding(), reranker);
      const out = await search.search('q', { limit: 10, rerank: true });

      // Same precondition as S5: without it this passes whether or not the prior ran.
      expect(reranked[0][0].source_type).toBe('semantic');
      // KIND_RANK_V1 is OFF. If the prior were gated on it alone, the memory row would lead.
      expect(out[0].source_type).toBe('symbol');
      expect(out.at(-1)!.source_type).toBe('semantic');
    });
  });

  it('S13 — truncation happens LAST, so the prior can promote a row from deep in the window', async () => {
    await withFlags({ [CODE_RERANK_FLAG]: '1' }, async ({ CodeSearch }) => {
      // 50 rows. The reranker puts 10 `variable` rows (penalty 1) inside positions 0-24 and the
      // real answer at position 25. After the prior the answer lands at index 15 — inside a
      // limit of 20. Slice BEFORE the prior and it is cut at 25 and never seen again.
      const rows = manySymbols(50, (i) => ({
        name: i === 25 ? 'TARGET' : `s${i}`,
        kind: i < 25 && i % 2 === 1 ? 'variable' : 'function',
      }));
      const { driver } = driverFor({ symbols: rows });
      const order = rows.map((r) => r.name);
      const reranker = async (_q: string, got: CodeSearchResult[]) =>
        [...got].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
      const search = new CodeSearch(driver as never, embedding(), reranker);
      const out = await search.search('q', { limit: 20, include_semantics: false, rerank: true });

      expect(out).toHaveLength(20);
      expect(names(out)).toContain('TARGET');
    });
  });

  it('S6 — a reranker that throws degrades to the fused order, it does not reject', async () => {
    await withFlags({ [CODE_RERANK_FLAG]: '1' }, async ({ CodeSearch }) => {
      const { driver } = driverFor({ symbols: manySymbols(30, (i) => ({ name: `s${i}` })) });
      const reranker = vi.fn(async () => { throw new Error('provider exploded'); });
      const search = new CodeSearch(driver as never, embedding(), reranker);
      const out = await search.search('q', { limit: 10, include_semantics: false, rerank: true });
      expect(reranker).toHaveBeenCalled();
      expect(out).toHaveLength(10);
      expect(out[0].name).toBe('s0');
    });
  });

  it('S7 — a reranker that DROPS rows is ignored outright; the full window survives', async () => {
    await withFlags({ [CODE_RERANK_FLAG]: '1' }, async ({ CodeSearch }) => {
      const { driver } = driverFor({ symbols: manySymbols(30, (i) => ({ name: `s${i}` })) });
      // Reversed AND truncated. If the length guard is dropped, 's29' leads and length shrinks.
      const reranker = async (_q: string, rows: CodeSearchResult[]) => [...rows].reverse().slice(0, 3);
      const search = new CodeSearch(driver as never, embedding(), reranker);
      const out = await search.search('q', { limit: 10, include_semantics: false, rerank: true });
      expect(out).toHaveLength(10);
      expect(out[0].name).toBe('s0');
    });
  });

  it('S8 — no reranker injected: widen and truncate still work, prior still applies, no crash', async () => {
    await withFlags({ [CODE_RERANK_FLAG]: '1', [KIND_RANK_FLAG]: undefined }, async ({ CodeSearch }) => {
      const { driver, calls } = driverFor({
        symbols: [
          ...manySymbols(20, (i) => ({ name: `v${i}`, kind: 'variable' })),
          { name: 'cleanFn', kind: 'function' },
        ],
      });
      const search = new CodeSearch(driver as never, embedding()); // no third argument
      const out = await search.search('q', { limit: 5, include_semantics: false, rerank: true });
      expect(fulltextLimit(calls)).toBe(50);
      expect(out).toHaveLength(5);
      expect(out[0].name).toBe('cleanFn'); // prior ran despite KIND_RANK_V1 being unset
    });
  });

  it('S15 — confinement: with the option ABSENT nothing widens and the reranker is never called', async () => {
    await withFlags({ [CODE_RERANK_FLAG]: '1' }, async ({ CodeSearch }) => {
      const rows = manySymbols(60, (i) => ({ name: `s${i}` }));

      // (a) the assembler's shape: a direct search with no `rerank` option.
      const a = driverFor({ symbols: rows });
      const rerankerA = vi.fn(async (_q: string, r: CodeSearchResult[]) => [...r].reverse());
      const searchA = new CodeSearch(a.driver as never, embedding(), rerankerA);
      const outA = await searchA.search('q', { limit: 20, include_semantics: false });
      expect(fulltextLimit(a.calls)).toBe(20);
      expect(rerankerA).not.toHaveBeenCalled();
      expect(outA[0].name).toBe('s0');

      // (b) buildContext, which serves berry_code_context. It spreads CodeContextFilters, a type
      // that cannot carry `rerank` TODAY — asserting it means a future field added to that type
      // cannot silently opt the memory-adjacent path in.
      const b = driverFor({ symbols: rows });
      const rerankerB = vi.fn(async (_q: string, r: CodeSearchResult[]) => [...r].reverse());
      const searchB = new CodeSearch(b.driver as never, embedding(), rerankerB);
      await searchB.buildContext('q', 6000);
      expect(fulltextLimit(b.calls)).toBe(30);
      expect(rerankerB).not.toHaveBeenCalled();
    });
  });

  it('S16 — finalIds describe what was RETURNED, not the wider window considered', async () => {
    await withFlags({ [CODE_RERANK_FLAG]: '1' }, async ({ CodeSearch }) => {
      const { driver } = driverFor({ symbols: manySymbols(50, (i) => ({ name: `s${i}` })) });
      const reranker = async (_q: string, rows: CodeSearchResult[]) => [...rows].reverse();
      const search = new CodeSearch(driver as never, embedding(), reranker);
      const { value, observation } = await (search as unknown as {
        searchObserved(q: string, o: Record<string, unknown>): Promise<{
          value: CodeSearchResult[];
          observation: { finalIds: string[]; candidates: unknown[] };
        }>;
      }).searchObserved('q', { limit: 20, include_semantics: false, rerank: true });

      expect(value).toHaveLength(20);
      expect(observation.finalIds).toHaveLength(20);
      expect(observation.finalIds).toEqual(value.map((r) => r.id));
      // The wider set considered is legitimately larger than what was returned.
      expect(observation.candidates.length).toBeGreaterThan(20);
    });
  });
});
