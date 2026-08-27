// IDX-002B acceptance gate — assertions B1-B12.
//
// Measured defect, live probe 2026-08-27 (flag KIND_RANK_V1 already on in prod):
// a `berry_code_search` scoped to `project:memberry` returned 42% memberry code
// in its top 5. The other 58% was
//   (a) memory prose with no file and no line     — 28 of 50 top-5 slots, and
//   (b) another project's Python test file        — admitted by the legacy
//       un-stamped-symbol fallback, which without a path hint admits EVERY
//       un-stamped symbol in the graph (5,136 of them on the live box: 4,465
//       from a foreign project, 667 a stale duplicate index of memberry itself,
//       4 from a third project — and ZERO legitimate un-stamped memberry rows).
//
// Two mechanisms, two flags:
//   D3  noisePenalty  — a non-code row sorts below every code row. Rides the
//                       EXISTING MEMBERRY_KIND_RANK_V1 (this refines that sort).
//   D1/D2 scope       — the semantic channel is project-scoped, and the
//                       un-stamped fallback requires path evidence. Behind the
//                       NEW MEMBERRY_CODE_SCOPE_V2, default OFF.
//
// No Neo4j, no embedding provider, no MCP, no network: the fake-driver
// convention from search.observed.test.ts:7-27 captures the generated Cypher,
// which IS the scope contract.

import { describe, expect, it, vi } from 'vitest';

import { CODE_SCOPE_FLAG, KIND_RANK_FLAG, noisePenalty, rankByNoise } from '../search.js';
import type { CodeSearchResult } from '../types.js';

function row(over: Partial<CodeSearchResult> & { name: string }): CodeSearchResult {
  return {
    id: `${over.file_path ?? 'src/x.ts'}:${over.name}`,
    source_type: 'symbol',
    name: over.name,
    kind: 'function',
    file_path: 'src/x.ts',
    start_line: 1,
    signature: '',
    doc_comment: '',
    score: 0.5,
    ...over,
  };
}

/** A memory row exactly as `semanticVectorSearch` emits it (search.ts:545-557). */
function memoryRow(id: string): CodeSearchResult {
  return row({
    id,
    name: `[Semantic] ${id.slice(0, 12)}`,
    source_type: 'semantic',
    kind: 'semantic',
    file_path: '',
    start_line: 0,
  });
}

/**
 * Case oc-01 of the outcome probe, in the order the live box returned it on
 * 2026-08-27 with KIND_RANK_V1 already on. Three memory rows hold ranks 1, 3
 * and 4; the code row at rank 5 outscores the rank-1 memory row nearly 2:1.
 */
function liveTopFive(): CodeSearchResult[] {
  return [
    memoryRow('semantic-decision-a'),
    row({ name: 'ServedRerankerApplicationResultV1', kind: 'type', file_path: 'packages/retrieval/src/served-reranker.ts', score: 0.0161 }),
    memoryRow('semantic-decision-b'),
    memoryRow('semantic-decision-c'),
    row({ name: 'applied', kind: 'variable', file_path: 'packages/neo4j/src/lifecycle.ts', score: 0.0317 }),
  ];
}

const names = (rows: CodeSearchResult[]): string[] => rows.map((r) => r.name);

// ─── D3: a code search ranks code first ──────────────────────────────────────

describe('IDX-002B non-code rank prior', () => {
  it('B1 — replays the live defect: every code row outranks every memory row', () => {
    const out = rankByNoise(liveTopFive());
    expect(names(out).slice(0, 2)).toEqual(['ServedRerankerApplicationResultV1', 'applied']);
    expect(out.slice(2).every((r) => r.source_type === 'semantic')).toBe(true);
  });

  it('B2 — a memory row sorts below even a test-path variable, the noisiest code there is', () => {
    const out = rankByNoise([
      memoryRow('semantic-decision-a'),
      row({ name: 'tmp', kind: 'variable', file_path: 'src/__tests__/x.test.ts' }),
    ]);
    expect(names(out)).toEqual(['tmp', '[Semantic] semantic-dec']);
    expect(noisePenalty(memoryRow('m'))).toBeGreaterThan(noisePenalty(
      row({ name: 'tmp', kind: 'variable', file_path: 'src/__tests__/x.test.ts' }),
    ));
  });

  it('B3 — the discriminator is source_type, not the free-text kind string', () => {
    // `kind` comes from the parser and is open vocabulary; a SYMBOL whose kind
    // happens to read 'semantic' is still code and must not be exiled.
    expect(noisePenalty(row({ name: 'S', kind: 'semantic', file_path: 'src/s.ts' }))).toBe(0);
    expect(noisePenalty(memoryRow('semantic-decision-a'))).toBeGreaterThan(0);
  });

  it('B4 — never-exclude: memory rows are reordered, never dropped', () => {
    const input = liveTopFive();
    const before = input.map((r) => ({ id: r.id, score: r.score }));
    const out = rankByNoise(input);

    expect(out).toHaveLength(5);
    expect([...out.map((r) => r.id)].sort()).toEqual([...before.map((r) => r.id)].sort());
    expect(out.filter((r) => r.source_type === 'semantic')).toHaveLength(3);
  });

  it('B5 — score invariance holds: the new term is a comparator, not a weight', () => {
    const withScores = (scores: number[]): string[] =>
      names(rankByNoise(liveTopFive().map((r, i) => ({ ...r, score: scores[i] }))));

    const baseline = names(rankByNoise(liveTopFive()));
    expect(withScores([0, 0, 0, 0, 0])).toEqual(baseline);
    expect(withScores([1, 1, 1, 1, 1])).toEqual(baseline);
    expect(withScores([0.9, 0.1, 0.8, 0.7, 0.2])).toEqual(baseline);
  });

  it('B6 — memory rows keep their relative order among themselves (stable)', () => {
    const out = rankByNoise(liveTopFive()).filter((r) => r.source_type === 'semantic');
    expect(out.map((r) => r.id)).toEqual(['semantic-decision-a', 'semantic-decision-b', 'semantic-decision-c']);
  });
});

// ─── D1/D2: project scope actually scopes ────────────────────────────────────

interface Captured { query: string; params: Record<string, unknown> }

function captureDriver(): { driver: unknown; calls: Captured[] } {
  const calls: Captured[] = [];
  const run = vi.fn(async (query: string, params: Record<string, unknown>) => {
    calls.push({ query, params });
    return { records: [] };
  });
  return { driver: { session: () => ({ run, close: vi.fn(async () => undefined) }) }, calls };
}

/** Re-import the module under a given flag value so the module-load read is honoured. */
async function searchWithScopeFlag(
  flagValue: string | undefined,
  options: Record<string, unknown>,
): Promise<Captured[]> {
  const previous = process.env[CODE_SCOPE_FLAG];
  vi.resetModules();
  if (flagValue === undefined) delete process.env[CODE_SCOPE_FLAG];
  else process.env[CODE_SCOPE_FLAG] = flagValue;
  try {
    const { CodeSearch } = await import('../search.js');
    const { driver, calls } = captureDriver();
    const search = new CodeSearch(driver as never, {
      available: true,
      embed: vi.fn(async () => [0.1]),
      embedBatch: vi.fn(),
    });
    await search.search('rrf fusion', options);
    return calls;
  } finally {
    if (previous === undefined) delete process.env[CODE_SCOPE_FLAG];
    else process.env[CODE_SCOPE_FLAG] = previous;
    vi.resetModules();
  }
}

const fulltextOf = (calls: Captured[]): Captured =>
  calls.find((c) => c.query.includes('symbol_search'))!;
const semanticOf = (calls: Captured[]): Captured =>
  calls.find((c) => c.query.includes('semantic_embedding'))!;


describe('IDX-002B project scope', () => {
  it('B7 — ON: an un-stamped symbol needs path evidence, so the tag clause has no IS NULL escape', async () => {
    const calls = await searchWithScopeFlag('1', { limit: 10, project_tag: 'project:memberry' });
    const clause = fulltextOf(calls).query;
    expect(clause).toContain('s.project_tag = $project_tag');
    expect(clause).not.toContain('s.project_tag IS NULL');
  });

  it('B8 — ON: the un-stamped fallback SURVIVES when a path hint constrains it', async () => {
    const calls = await searchWithScopeFlag('1', {
      limit: 10, project_tag: 'project:memberry', file_path: 'packages/retrieval',
    });
    const clause = fulltextOf(calls).query;
    expect(clause).toContain('s.project_tag IS NULL');
    expect(clause).toContain('CONTAINS toLower($file_path)');
  });

  it('B9 — ON: the semantic channel is scoped to the same project tag', async () => {
    const calls = await searchWithScopeFlag('1', { limit: 10, project_tag: 'project:memberry' });
    const semantic = semanticOf(calls);
    expect(semantic.query).toContain('$project_tag IN s.tags');
    expect(semantic.params.project_tag).toBe('project:memberry');
  });

  it('B10 — ON: an unscoped call is unchanged — no tag, no new filter', async () => {
    const calls = await searchWithScopeFlag('1', { limit: 10 });
    expect(semanticOf(calls).query).not.toContain('IN s.tags');
    expect(fulltextOf(calls).query).not.toContain('project_tag');
  });

  it('B11 — default OFF is byte-identical to the shipped behaviour', async () => {
    const options = { limit: 10, project_tag: 'project:memberry' };
    const off = await searchWithScopeFlag(undefined, options);
    const zero = await searchWithScopeFlag('0', options);
    const truthy = await searchWithScopeFlag('true', options);

    for (const calls of [off, zero, truthy]) {
      expect(fulltextOf(calls).query).toContain('s.project_tag IS NULL');
      expect(semanticOf(calls).query).not.toContain('IN s.tags');
    }
    expect(zero.map((c) => c.query)).toEqual(off.map((c) => c.query));
    expect(truthy.map((c) => c.query)).toEqual(off.map((c) => c.query));
  });
});

describe('IDX-002B post-filter parity', () => {
  const untagged = { file_path: '/app/foreign/x.py', project_tag: undefined };
  const tagged = { file_path: 'packages/code/src/search.ts', project_tag: 'project:memberry' };

  async function postFilterUnder(flagValue: string | undefined) {
    const previous = process.env[CODE_SCOPE_FLAG];
    vi.resetModules();
    if (flagValue === undefined) delete process.env[CODE_SCOPE_FLAG];
    else process.env[CODE_SCOPE_FLAG] = flagValue;
    try {
      const mod = await import('../search.js');
      return mod.applyScopePostFilterForTest;
    } finally {
      if (previous === undefined) delete process.env[CODE_SCOPE_FLAG];
      else process.env[CODE_SCOPE_FLAG] = previous;
    }
  }

  it('B12 — ON: the post-filter mirrors the Cypher, so the vector path leaks nothing', async () => {
    // An un-stamped row admitted by one channel and rejected by the other would
    // put the leak straight back through the vector path.
    const filter = await postFilterUnder('1');
    expect(filter([untagged, tagged], { project_tag: 'project:memberry' })).toEqual([tagged]);
    // The path-hint fallback survives here too.
    expect(filter([untagged], { project_tag: 'project:memberry', file_path: '/app/foreign' }))
      .toEqual([untagged]);
  });

  it('B13 — OFF: the post-filter still admits un-stamped rows', async () => {
    const filter = await postFilterUnder(undefined);
    expect(filter([untagged, tagged], { project_tag: 'project:memberry' }))
      .toEqual([untagged, tagged]);
  });
});

describe('IDX-002B flag independence', () => {
  it('B14 — the two mechanisms are separately revertible', () => {
    expect(CODE_SCOPE_FLAG).toBe('MEMBERRY_CODE_SCOPE_V2');
    expect(KIND_RANK_FLAG).toBe('MEMBERRY_KIND_RANK_V1');
    expect(CODE_SCOPE_FLAG).not.toBe(KIND_RANK_FLAG);
  });
});
