// IDX-002A spec §5.2b — budget-drop detector, the runnable check for §3.3.
//
// "Deprioritize, never exclude" is a property of the SORT, not of the pipeline:
// `CodeSearch.buildContext` fills a token budget greedily in list order
// (search.ts:252-254, `continue` not `break`), so reordering can change membership.
// This re-implements that six-line fill verbatim over the frozen §5.2 window and
// diffs the admitted set before vs after `rankByNoise`.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { noisePenalty, rankByNoise } from '../search.js';
import type { CodeSearchResult } from '../types.js';

interface FixtureRow {
  id: string; name: string; kind: string; file_path: string; start_line: number | null; score: number;
}

const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'fixtures/live-window-2026-08-27.json'), 'utf8'),
) as { rows: FixtureRow[] };

/**
 * One shared set of row objects, so admitted sets are compared by IDENTITY.
 * The window contains repeated semantic ids, which an id-keyed set would collapse.
 */
const rows: CodeSearchResult[] = fixture.rows.map((r) => ({
  id: r.id,
  source_type: r.kind === 'semantic' ? ('semantic' as const) : ('symbol' as const),
  name: r.name,
  kind: r.kind,
  file_path: r.file_path,
  start_line: r.start_line ?? 0,
  signature: '',
  doc_comment: '',
  score: r.score,
}));

/** Verbatim from CodeSearch.buildContext (search.ts:252-254). */
const cost = (r: CodeSearchResult): number =>
  Math.ceil((r.signature.length + r.doc_comment.length + 50) / 4);

function admitted(list: CodeSearchResult[], maxTokens: number): Set<CodeSearchResult> {
  const out = new Set<CodeSearchResult>();
  let tokenCount = 0;
  for (const result of list) {
    const estimatedTokens = cost(result);
    if (tokenCount + estimatedTokens > maxTokens) continue;
    out.add(result);
    tokenCount += estimatedTokens;
  }
  return out;
}

const totalCost = rows.reduce((sum, r) => sum + cost(r), 0);
const BUDGETS: Array<[label: string, maxTokens: number]> = [
  ['tight (half the window)', Math.floor(totalCost / 2)],
  ['buildContext default', 6000],
  ['unbounded', Number.MAX_SAFE_INTEGER],
];

describe('IDX-002A budget-drop detector (spec §5.2b)', () => {
  const sorted = rankByNoise([...rows]);

  it('(i) at an unbounded budget the admitted sets are identical', () => {
    const before = admitted(rows, Number.MAX_SAFE_INTEGER);
    const after = admitted(sorted, Number.MAX_SAFE_INTEGER);
    expect(after.size).toBe(before.size);
    expect([...after].every((r) => before.has(r))).toBe(true);
  });

  it('(ii) reports the symmetric difference at each budget', () => {
    console.log(
      `[§5.2b] window=${rows.length} rows, totalCost=${totalCost} tokens. ` +
        'NOTE: the captured fixture carries no signature/doc_comment, so every row costs ' +
        `${cost(rows[0])} tokens — the detector runs, but this window cannot exercise the ` +
        'variable-cost case of §3.3.3.',
    );
    for (const [label, maxTokens] of BUDGETS) {
      const before = admitted(rows, maxTokens);
      const after = admitted(sorted, maxTokens);
      const droppedAfter = [...before].filter((r) => !after.has(r));
      const gainedAfter = [...after].filter((r) => !before.has(r));
      console.log(
        `[§5.2b] budget=${label} (${maxTokens}): admitted ${before.size} -> ${after.size}; ` +
          `dropped=[${droppedAfter.map((r) => `${r.name}#${noisePenalty(r)}`).join(', ')}]; ` +
          `gained=[${gainedAfter.map((r) => `${r.name}#${noisePenalty(r)}`).join(', ')}]`,
      );
    }
    expect(BUDGETS).toHaveLength(3);
  });

  it('(iii) no penalty-0 row is admitted before and dropped after, at any budget', () => {
    for (const [label, maxTokens] of BUDGETS) {
      const before = admitted(rows, maxTokens);
      const after = admitted(sorted, maxTokens);
      const cleanDrops = [...before].filter((r) => !after.has(r) && noisePenalty(r) === 0);
      expect(cleanDrops.map((r) => `${label}:${r.name}`)).toEqual([]);
    }
  });
});
