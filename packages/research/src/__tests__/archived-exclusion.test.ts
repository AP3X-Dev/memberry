// packages/research/src/__tests__/archived-exclusion.test.ts
//
// MEM-006 §2.5.1: the three research-package tag-scoped Semantic scans exclude
// lifecycle-archived nodes — the conflicted-signal scan and findUncertain
// (contradictions.ts), the campaign principles read (context.ts), and
// detectSemanticUpdates (consolidation.ts).

import { describe, it, expect, vi } from 'vitest';
import { ContradictionDetector } from '../contradictions.js';
import { ResearchConsolidation } from '../consolidation.js';
import { ResearchContextBuilder } from '../context.js';

function captureDriver() {
  const cyphers: string[] = [];
  const session = {
    run: vi.fn(async (cypher: string) => { cyphers.push(cypher); return { records: [] }; }),
    close: vi.fn(),
  };
  return { driver: { session: vi.fn(() => session) } as any, cyphers };
}

const PRED = 'coalesce(s.archived, false) = false';

describe('research reads exclude archived semantics', () => {
  it('conflicted-signal scan and findUncertain carry the predicate', async () => {
    const { driver, cyphers } = captureDriver();
    const detector = new ContradictionDetector(driver);
    await detector.detect('camp-1');
    await detector.findUncertain('camp-1');
    const scans = cyphers.filter((c) => c.includes('MATCH (s:Semantic)'));
    expect(scans.length).toBeGreaterThanOrEqual(2);
    for (const cypher of scans) expect(cypher, cypher).toContain(PRED);
  });

  it('getSemanticPrinciples carries the predicate', async () => {
    const { driver, cyphers } = captureDriver();
    const builder = new ResearchContextBuilder(driver);
    await (builder as unknown as { getSemanticPrinciples(id: string): Promise<unknown> })
      .getSemanticPrinciples('camp-1');
    expect(cyphers[0]).toContain(PRED);
  });

  it('detectSemanticUpdates carries the predicate', async () => {
    const { driver, cyphers } = captureDriver();
    const consolidation = new ResearchConsolidation(driver);
    await (consolidation as unknown as { detectSemanticUpdates(id: string): Promise<unknown> })
      .detectSemanticUpdates('camp-1');
    expect(cyphers[0]).toContain(PRED);
  });
});
