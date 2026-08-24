// packages/neo4j/src/__tests__/archived-exclusion.test.ts
//
// MEM-006 §2.5.1: every memory-serving read in this package excludes
// lifecycle-archived nodes via `coalesce(alias.archived, false) = false`,
// while by-id hydration fetches (semantic.getById / episodic.getById)
// deliberately stay unfiltered. Mock-driver query-text pinning, sibling style;
// live behaviour rides the infra-gated suites on the clone.

import { describe, it, expect, vi } from 'vitest';
import { ScopedQuery, validateReadOnlyCypher, archivedWhere } from '../query.js';
import { EpisodicStore } from '../episodic.js';
import { SemanticStore } from '../semantic.js';
import { GDSAlgorithms } from '../gds.js';

function captureDriver() {
  const cyphers: string[] = [];
  const session = {
    run: vi.fn(async (cypher: string) => { cyphers.push(cypher); return { records: [] }; }),
    close: vi.fn(),
  };
  return { driver: { session: vi.fn(() => session) } as any, cyphers };
}

const PRED = /coalesce\((s|s2|e|ep|node)\.archived, false\) = false/;

describe('archivedWhere helper', () => {
  it('emits the canonical coalesce predicate for any alias', () => {
    expect(archivedWhere('s')).toBe('coalesce(s.archived, false) = false');
    expect(archivedWhere('node')).toBe('coalesce(node.archived, false) = false');
  });

  it('passes the read-only validator (grep-shaped rawCypher can carry it)', () => {
    expect(() => validateReadOnlyCypher(
      `MATCH (s:Semantic) WHERE s.content CONTAINS 'jwt' AND ${archivedWhere('s')} RETURN s`,
    )).not.toThrow();
  });
});

describe('ScopedQuery excludes archived memory', () => {
  it('byEntity / byTag / byScope (all branches) / byVector / byVectorEpisodic / byEntityWithFacts / expandByGraph', async () => {
    const { driver, cyphers } = captureDriver();
    const query = new ScopedQuery(driver);

    await query.byEntity('E', 5);
    await query.byTag('t', 5);
    await query.byScope({ tags: ['t'], limit: 5 });
    await query.byScope({ entities: ['E'], limit: 5 });
    await query.byScope({ entities: ['E'], tags: ['t'], limit: 5 });
    await query.byScope({ limit: 5, projectScope: 'project:x' });
    await query.byVector([0.1], 5);
    await query.byVectorEpisodic([0.1], 5);
    await query.byEntityWithFacts('E');
    await query.expandByGraph(['E']);

    // byFacts (Fact label — no archived lifecycle) legitimately lacks the predicate.
    const memoryReads = cyphers.filter((c) => c.includes(':Semantic') || c.includes(':Episodic')
      || c.includes('semantic_embedding') || c.includes('episodic_embedding'));
    expect(memoryReads.length).toBeGreaterThanOrEqual(10);
    for (const cypher of memoryReads) {
      expect(cypher, cypher).toMatch(PRED);
    }
  });
});

describe('EpisodicStore promotion fetches exclude archived episodes', () => {
  it('findPromotable and findPromotableKeyset carry the identical predicate (resurrection guard)', async () => {
    const { driver, cyphers } = captureDriver();
    const store = new EpisodicStore(driver);
    await store.findPromotable('project:x', 10);
    await store.findPromotableKeyset('project:x', 10, undefined, { classTier: 0, createdAt: 'a', id: 'b' });
    expect(cyphers).toHaveLength(2);
    for (const cypher of cyphers) expect(cypher).toContain('coalesce(e.archived, false) = false');
    // MEM-005 invariant: both eligibility predicates stay byte-identical.
    const eligibility = (c: string) => c.slice(c.indexOf('WHERE'), c.indexOf('PROMOTED_FROM'));
    expect(eligibility(cyphers[0])).toBe(eligibility(cyphers[1]));
  });

  it('getById stays deliberately unfiltered (consolidation hydration)', async () => {
    const { driver, cyphers } = captureDriver();
    await new EpisodicStore(driver).getById('ep-1');
    expect(cyphers[0]).not.toContain('archived');
  });
});

describe('SemanticStore', () => {
  it('existingIds rejects archived signal targets', async () => {
    const { driver, cyphers } = captureDriver();
    await new SemanticStore(driver).existingIds(['sem-1']);
    expect(cyphers[0]).toContain('coalesce(s.archived, false) = false');
  });

  it('getById stays deliberately unfiltered (archived nodes remain fetchable by id)', async () => {
    const { driver, cyphers } = captureDriver();
    await new SemanticStore(driver).getById('sem-1');
    expect(cyphers[0]).not.toContain('archived');
  });
});

describe('GDSAlgorithms exclude archived semantics', () => {
  it('all four analytics queries carry the predicate', async () => {
    const { driver, cyphers } = captureDriver();
    const gds = new GDSAlgorithms(driver);
    await gds.findSimilarSemantics('E');
    await gds.pageRank('E');
    await gds.communityDetection();
    await gds.findCorrectionClusters('E');
    const semanticReads = cyphers.filter((c) => c.includes('(s:Semantic)'));
    expect(semanticReads.length).toBeGreaterThanOrEqual(4);
    for (const cypher of semanticReads) expect(cypher).toContain('coalesce(s.archived, false) = false');
  });
});
