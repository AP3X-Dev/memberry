// packages/wiki/src/__tests__/archived-exclusion.test.ts
//
// MEM-006 §2.5.1: every wiki compile query and lint check that reads memory
// nodes excludes lifecycle-archived rows via coalesce(alias.archived, false),
// following the existing NOT EXISTS { ...SUPERSEDES... } idiom — lint must
// match queries.ts or it reports on pages that no longer compile.

import { describe, it, expect, vi } from 'vitest';
import {
  fetchEpisodicProjectScopes,
  fetchEntitiesModifiedByProject,
  fetchSemanticsForEntity,
  fetchSemanticCountForEntity,
  fetchAllSemantics,
  fetchEpisodicsForProject,
  fetchEpisodicsForEntity,
  fetchEpisodicsForEntities,
  fetchRecentEpisodics,
  fetchBacklinks,
  fetchClaimsForSource,
  fetchAllTags,
  fetchSemanticsForTag,
  fetchInboundLinkCount,
  fetchSourcesForEntity,
} from '../queries.js';
import { WikiLinter } from '../lint.js';

function captureDriver() {
  const cyphers: string[] = [];
  const session = {
    run: vi.fn(async (cypher: string) => { cyphers.push(cypher); return { records: [] }; }),
    close: vi.fn(),
  };
  return { driver: { session: vi.fn(() => session) } as any, cyphers };
}

const PRED = /coalesce\((s|s2|ep)\.archived, false\) = false/;

describe('wiki compile queries exclude archived memory', () => {
  it('every memory-serving query carries the predicate', async () => {
    const { driver, cyphers } = captureDriver();
    await fetchEpisodicProjectScopes(driver);
    await fetchEntitiesModifiedByProject(driver, 'project:x');
    await fetchSemanticsForEntity(driver, 'E');
    await fetchSemanticCountForEntity(driver, 'E');
    await fetchAllSemantics(driver);
    await fetchEpisodicsForProject(driver, 'x');
    await fetchEpisodicsForEntity(driver, 'E', 'x');
    await fetchEpisodicsForEntities(driver, [{ id: 'e1', name: 'E' }], 'x');
    await fetchRecentEpisodics(driver, 10);
    await fetchBacklinks(driver, 'E');
    await fetchClaimsForSource(driver, 'src-1');
    await fetchAllTags(driver);
    await fetchSemanticsForTag(driver, 't');
    await fetchInboundLinkCount(driver, 'E');
    await fetchSourcesForEntity(driver, 'E');

    const memoryReads = cyphers.filter((c) => c.includes(':Semantic)') || c.includes(':Episodic)'));
    expect(memoryReads.length).toBeGreaterThanOrEqual(15);
    for (const cypher of memoryReads) {
      expect(cypher, cypher).toMatch(PRED);
    }
    // fetchEpisodicProjectScopes carries BOTH halves of the UNION.
    const scopes = cyphers[0];
    expect(scopes).toContain('coalesce(ep.archived, false) = false');
    expect(scopes).toContain('coalesce(s.archived, false) = false');
  });
});

describe('wiki lint checks match the compile-side exclusion', () => {
  it('every memory-reading check carries the predicate (archived pages are not lintable)', async () => {
    const { driver, cyphers } = captureDriver();
    await new WikiLinter(driver).lint({ project_tag: 'project:x' });
    const memoryReads = cyphers.filter((c) => c.includes(':Semantic)'));
    expect(memoryReads.length).toBeGreaterThanOrEqual(9);
    for (const cypher of memoryReads) {
      expect(cypher, cypher).toMatch(PRED);
    }
  });
});
