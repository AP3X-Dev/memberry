// IDX-002A spec §5.2 — frozen real-window replay, judged on the ANSWER, not on the kind.
//
// The fixture was captured from the live index on 2026-08-27 BEFORE any implementation
// edit existed, and its `answerIds` were authored by reading
// packages/retrieval/src/assembler.ts, with kind excluded from every justification
// (see `answerKeyJustification` in the fixture).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { rankByNoise } from '../search.js';
import { isTestPath } from '../types.js';
import type { CodeSearchResult } from '../types.js';

interface FixtureRow {
  id: string;
  name: string;
  kind: string;
  file_path: string;
  start_line: number | null;
  score: number;
}
interface Fixture {
  query: string;
  answerIds: string[];
  rows: FixtureRow[];
  beforeRanks: { UnifiedAssembler: number; assembleCandidateExecution: number; minAnswerRankBefore: number };
}

const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'fixtures/live-window-2026-08-27.json'), 'utf8'),
) as Fixture;

/** The fixture stores exactly the fields berry_code_search returned; the rest are the type's defaults. */
function window(): CodeSearchResult[] {
  return fixture.rows.map((r) => ({
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
}

const rankOf = (rows: CodeSearchResult[], id: string): number => rows.findIndex((r) => r.id === id) + 1;
const minAnswerRank = (rows: CodeSearchResult[]): number =>
  Math.min(...fixture.answerIds.map((id) => rankOf(rows, id)));
const testPathsInTop5 = (rows: CodeSearchResult[]): number =>
  rows.slice(0, 5).filter((r) => isTestPath(r.file_path)).length;

describe('IDX-002A frozen live-window replay (spec §5.2)', () => {
  const before = window();
  const after = rankByNoise(window());

  it('(a) the best-ranked answer does not lose rank, and the before-value is on the record', () => {
    const beforeRank = minAnswerRank(before);
    const afterRank = minAnswerRank(after);
    console.log(
      `[§5.2a] min(rank of answerIds): before=${beforeRank} after=${afterRank} ` +
        `(fixture beforeRanks.minAnswerRankBefore=${fixture.beforeRanks.minAnswerRankBefore})`,
    );
    expect(beforeRank).toBe(fixture.beforeRanks.minAnswerRankBefore);
    expect(afterRank).toBeLessThanOrEqual(beforeRank);
  });

  it('(b) at least one answer id is retrievable at display width (top 5)', () => {
    const inTop5 = after.slice(0, 5).filter((r) => fixture.answerIds.includes(r.id));
    console.log(`[§5.2b] answerIds in top 5 after: ${inTop5.map((r) => r.name).join(', ') || '(none)'}`);
    expect(inTop5.length).toBeGreaterThanOrEqual(1);
  });

  it('(c) the sort is a permutation: same length, same id multiset (§3.3.1 on real data)', () => {
    expect(after).toHaveLength(before.length);
    expect([...after.map((r) => r.id)].sort()).toEqual([...before.map((r) => r.id)].sort());
    expect([...after.map((r) => r.score)].sort()).toEqual([...before.map((r) => r.score)].sort());
  });

  it('(d) reports — not asserts — the test-path count in the first 5', () => {
    console.log(
      `[§5.2d] test-path items in top 5: before=${testPathsInTop5(before)} after=${testPathsInTop5(after)} ` +
        '(instrumentation only — this reads back penalty term 2, spec §6 T7)',
    );
    expect(true).toBe(true);
  });

  it('reproduces the measured dry-run over this fixture', () => {
    const moved = (name: string): string =>
      `${name} ${rankOf(before, idFor(name))} -> ${rankOf(after, idFor(name))}`;
    console.log(`[dry-run] ${moved('UnifiedAssembler')}; ${moved('assembleCandidateExecution')}`);

    expect(rankOf(before, idFor('UnifiedAssembler'))).toBe(fixture.beforeRanks.UnifiedAssembler);
    expect(rankOf(after, idFor('UnifiedAssembler'))).toBe(1);
    expect(rankOf(before, idFor('assembleCandidateExecution'))).toBe(fixture.beforeRanks.assembleCandidateExecution);
    expect(rankOf(after, idFor('assembleCandidateExecution'))).toBe(5);
    expect(testPathsInTop5(before)).toBe(2);
    expect(testPathsInTop5(after)).toBe(0);
  });

  // Spec §8 addendum (found during the dry run): the predicate's deliberate narrowness
  // means `semantic` rows score 0 and therefore rise with the code rows. On this window
  // they occupy ranks 2-4 of a CODE search. Pinned so it is a visible, deliberate fact
  // rather than a surprise — widening the predicate to fix it is a separate packet.
  it('records that non-code rows float up with the promoted code rows', () => {
    const kinds = after.slice(0, 5).map((r) => r.kind);
    console.log(`[§8] kinds in top 5 after: ${kinds.join(', ')}`);
    expect(kinds).toEqual(['class', 'semantic', 'semantic', 'semantic', 'method']);
  });
});

function idFor(name: string): string {
  const match = fixture.rows.find((r) => r.name === name);
  if (!match) throw new Error(`fixture has no row named ${name}`);
  return match.id;
}
