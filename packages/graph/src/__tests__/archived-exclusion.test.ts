// packages/graph/src/__tests__/archived-exclusion.test.ts
//
// MEM-006 §2.5.1: the graph snapshot's Semantic and Episodic collection queries
// exclude lifecycle-archived nodes. The pre-existing project predicate is a
// top-level OR, so the archived conjunct must be parenthesised with it.

import { describe, it, expect, vi } from 'vitest';
import { GraphSnapshotService } from '../snapshot.js';

function captureDriver() {
  const cyphers: string[] = [];
  const session = {
    run: vi.fn(async (cypher: string) => { cyphers.push(cypher); return { records: [] }; }),
    close: vi.fn(),
  };
  return { driver: { session: vi.fn(() => session) } as any, cyphers };
}

describe('graph snapshot excludes archived memory', () => {
  it('semantic and episodic queries carry the parenthesised predicate', async () => {
    const { driver, cyphers } = captureDriver();
    await new GraphSnapshotService(driver).snapshot({ include_episodes: true });

    const semantic = cyphers.find((c) => c.includes('MATCH (s:Semantic)'));
    const episodic = cyphers.find((c) => c.includes('MATCH (e:Episodic)'));
    expect(semantic).toBeDefined();
    expect(semantic).toContain('($projectTag IS NULL OR $projectTag IN s.tags) AND coalesce(s.archived, false) = false');
    expect(episodic).toBeDefined();
    expect(episodic).toContain('($projectTag IS NULL OR e.scope = $projectTag) AND coalesce(e.archived, false) = false');
  });
});
