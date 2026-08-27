// IDX-002A acceptance gate — spec §5.1, assertions A1-A11.
// Unit: the exported pure functions `noisePenalty` / `rankByNoise`.
// No Neo4j, no embedding provider, no MCP, no network (A10 uses the fake-driver
// convention from search.observed.test.ts:7-27).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { CODE_SCOPE_FLAG, KIND_RANK_FLAG, noisePenalty, rankByNoise } from '../search.js';
import { TEST_FILE_PATTERNS, isTestPath } from '../types.js';
import type { CodeSearchResult } from '../types.js';

const FLAG = KIND_RANK_FLAG;

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

/** The 2026-08-27 live probe, in the order it was returned (spec §1.2). */
function liveDefectWindow(): CodeSearchResult[] {
  return [
    row({ name: 'results', kind: 'variable', file_path: 'packages/retrieval/src/__tests__/code-plane.test.ts', score: 0.91 }),
    row({ name: 'ranked', kind: 'variable', file_path: 'packages/retrieval/src/assembler.ts', score: 0.88 }),
    row({ name: 'compose', kind: 'function', file_path: 'packages/retrieval/src/__tests__/assembler.test.ts', score: 0.85 }),
    row({ name: 'UnifiedAssembler', kind: 'class', file_path: 'packages/retrieval/src/assembler.ts', score: 0.82 }),
  ];
}

const names = (rows: CodeSearchResult[]): string[] => rows.map((r) => r.name);

describe('IDX-002A kind-aware ranking (spec §5.1)', () => {
  it('A1 — replays the live defect: the class at rank 4 comes back at rank 1', () => {
    const out = rankByNoise(liveDefectWindow());
    expect(out[0].name).toBe('UnifiedAssembler');
  });

  it('A2 — a local variable is not a better answer than the class it lives in', () => {
    const out = rankByNoise([
      row({ name: 'Foo', kind: 'variable', file_path: 'src/foo.ts', score: 0.7 }),
      row({ name: 'Foo', kind: 'class', file_path: 'src/foo.ts', score: 0.7 }),
    ]);
    expect(out.map((r) => r.kind)).toEqual(['class', 'variable']);
  });

  it('A3 — the path axis in isolation: src outranks __tests__ with kind held constant', () => {
    const out = rankByNoise([
      row({ name: 'ranked', kind: 'variable', file_path: 'src/__tests__/ranked.test.ts', score: 0.7 }),
      row({ name: 'ranked', kind: 'variable', file_path: 'src/ranked.ts', score: 0.7 }),
    ]);
    expect(out.map((r) => r.file_path)).toEqual(['src/ranked.ts', 'src/__tests__/ranked.test.ts']);
  });

  it('A4 — never-exclude (kind) at the sort boundary: 5 variables in, 5 variables out, unmoved', () => {
    const input = [1, 2, 3, 4, 5].map((n) =>
      row({ name: `v${n}`, kind: 'variable', file_path: `src/v${n}.ts`, score: 0.9 - n / 100 }),
    );
    const before = input.map((r) => ({ id: r.id, score: r.score }));
    const out = rankByNoise(input);

    expect(out).toHaveLength(5);
    expect([...out.map((r) => r.id)].sort()).toEqual([...before.map((r) => r.id)].sort());
    expect(out.map((r) => ({ id: r.id, score: r.score }))).toEqual(before);
  });

  it('A5 — never-exclude (path) at the sort boundary: 5 test-path rows in, 5 out, unmoved', () => {
    const kinds = ['class', 'interface', 'function', 'method', 'type'];
    const input = kinds.map((kind, n) =>
      row({ name: `t${n}`, kind, file_path: `src/__tests__/t${n}.test.ts`, score: 0.9 - n / 100 }),
    );
    const before = input.map((r) => ({ id: r.id, score: r.score }));
    const out = rankByNoise(input);

    expect(out).toHaveLength(5);
    expect([...out.map((r) => r.id)].sort()).toEqual([...before.map((r) => r.id)].sort());
    expect(out.map((r) => ({ id: r.id, score: r.score }))).toEqual(before);
  });

  it('A6 — silent where unjustified: the cross-axis pair is decided by input order alone', () => {
    const classInTest = () => row({ name: 'Foo', kind: 'class', file_path: 'src/__tests__/foo.test.ts', score: 0.7 });
    const variableInSrc = () => row({ name: 'bar', kind: 'variable', file_path: 'src/bar.ts', score: 0.7 });

    expect(names(rankByNoise([classInTest(), variableInSrc()]))).toEqual(['Foo', 'bar']);
    expect(names(rankByNoise([variableInSrc(), classInTest()]))).toEqual(['bar', 'Foo']);
  });

  it('A7 — score invariance: the output order does not depend on any score', () => {
    const withScores = (scores: number[]): string[] =>
      names(rankByNoise(liveDefectWindow().map((r, i) => ({ ...r, score: scores[i] }))));

    const baseline = names(rankByNoise(liveDefectWindow()));
    expect(withScores([0, 0, 0, 0])).toEqual(baseline);
    expect(withScores([1, 1, 1, 1])).toEqual(baseline);
    expect(withScores([0.82, 0.85, 0.88, 0.91])).toEqual(baseline);
  });

  it("A8 — frozen kind predicate: only 'variable' is penalised, unknown kinds are neutral", () => {
    const liveVocabulary = [
      'function', 'class', 'method', 'interface', 'type', 'enum', 'module',
      'constant', 'table', 'view', 'resource', 'config',
    ];
    // AMENDED by IDX-002B. A8 was written to catch exactly one thing: the kind
    // predicate being widened to sweep up whatever the current complaint is. It
    // did its job — the semantic-rows finding was left UNFIXED in IDX-002A
    // rather than smuggled in by widening `kind`. IDX-002B fixes it deliberately
    // and on a DIFFERENT axis: `source_type`, the closed channel discriminator.
    // The kind axis stays frozen, which is what A8 exists to guarantee.
    for (const kind of [...liveVocabulary, 'semantic', 'gizmo', '']) {
      expect(noisePenalty(row({ name: 'x', kind, file_path: 'src/x.ts' }))).toBe(0);
    }
    expect(noisePenalty(row({ name: 'x', kind: 'variable', file_path: 'src/x.ts' }))).toBe(1);

    // A semantic row as `semanticVectorSearch` emits it (search.ts:545-557):
    // penalised for its source_type, never for its kind string.
    const memory = row({ name: '[Semantic] abc', kind: 'semantic', file_path: '' });
    expect(noisePenalty({ ...memory, source_type: 'semantic' })).toBe(3);
    expect(noisePenalty({ ...memory, source_type: 'symbol' })).toBe(0);
  });

  it("A9 — frozen path list, case-insensitive, and an absent file_path is not a test path", () => {
    expect(TEST_FILE_PATTERNS).toEqual(['.test.', '.spec.', '__tests__', '__mocks__']);

    expect(isTestPath('SRC/__TESTS__/Foo.TS')).toBe(true);
    expect(isTestPath('src/Foo.TEST.ts')).toBe(true);
    expect(isTestPath('src/Foo.SPEC.ts')).toBe(true);
    expect(isTestPath('src/__MOCKS__/foo.ts')).toBe(true);
    expect(isTestPath('src/foo.ts')).toBe(false);

    // Absent/empty paths reach this predicate in production: `semanticVectorSearch`
    // hardcodes `file_path: ''`, and CodeSearchResult.file_path is not guaranteed
    // non-null for every channel at runtime. Absent means "not a test path", never a throw.
    expect(isTestPath('')).toBe(false);
    expect(isTestPath(null)).toBe(false);
    expect(isTestPath(undefined)).toBe(false);

    const absentPath = [
      row({ name: 'a', kind: 'class', file_path: null as unknown as string }),
      row({ name: 'b', kind: 'variable', file_path: undefined as unknown as string }),
      row({ name: 'c', kind: 'semantic', file_path: '' }),
    ];
    expect(absentPath.map((r) => noisePenalty(r))).toEqual([0, 1, 0]);
    expect(() => rankByNoise(absentPath)).not.toThrow();
  });

  it("A10 — default OFF is the baseline: only MEMBERRY_KIND_RANK_V1='1' reorders", async () => {
    const orderFor = async (flagValue: string | undefined): Promise<string[]> => {
      const previous = process.env[FLAG];
      vi.resetModules();
      if (flagValue === undefined) delete process.env[FLAG];
      else process.env[FLAG] = flagValue;
      try {
        const { CodeSearch } = await import('../search.js');
        const search = new CodeSearch(fakeDriver(liveDefectWindow()) as never, {
          available: false,
          embed: vi.fn(async () => [0.1]),
          embedBatch: vi.fn(),
        });
        const out = await search.search('unified assembler', { limit: 10, include_semantics: false });
        return names(out);
      } finally {
        if (previous === undefined) delete process.env[FLAG];
        else process.env[FLAG] = previous;
        vi.resetModules();
      }
    };

    const baseline = ['results', 'ranked', 'compose', 'UnifiedAssembler'];
    expect(await orderFor(undefined)).toEqual(baseline);
    expect(await orderFor('0')).toEqual(baseline);
    expect(await orderFor('true')).toEqual(baseline);
    expect(await orderFor('yes')).toEqual(baseline);
    expect((await orderFor('1'))[0]).toBe('UnifiedAssembler');
  });

  it('A11 — every flag is read exactly once, at module load, in exactly one file', () => {
    expect(KIND_RANK_FLAG).toBe('MEMBERRY_KIND_RANK_V1');
    const source = readFileSync(resolve(import.meta.dirname, '../search.ts'), 'utf8');

    // Each flag NAME appears exactly once — in its own `export const …_FLAG =` line.
    for (const flag of [FLAG, CODE_SCOPE_FLAG]) {
      expect(source.split(flag).length - 1).toBe(1);
    }

    // AMENDED by IDX-002B, which added a second flag. The tripwire was never
    // "one env read" — it is "no env read anywhere except the module-load
    // constants", so that a flag cannot be re-read per call and drift mid-process.
    // Pinning the exact list is STRICTER than the old count: a stray read now
    // fails on identity, not just on arithmetic.
    const reads = source.match(/process\.env\[[A-Za-z_]+\]/g) ?? [];
    expect(reads).toEqual(['process.env[KIND_RANK_FLAG]', 'process.env[CODE_SCOPE_FLAG]']);
    expect(source.split('process.env').length - 1).toBe(reads.length);
  });
});

/** Single-channel fake driver: fulltext returns `rows`, every other channel is empty. */
function fakeDriver(rows: CodeSearchResult[]) {
  const run = vi.fn(async (query: string) => {
    if (!query.includes('symbol_search')) return { records: [] };
    return {
      records: rows.map((r) => ({
        get: (key: string) =>
          key === 's'
            ? {
                properties: {
                  id: r.id, name: r.name, kind: r.kind, language: 'typescript',
                  file_path: r.file_path, start_line: r.start_line,
                  signature: r.signature, doc_comment: r.doc_comment,
                },
              }
            : r.score,
      })),
    };
  });
  return { session: () => ({ run, close: vi.fn(async () => undefined) }) };
}
