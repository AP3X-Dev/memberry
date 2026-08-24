// MEM-005: findPromotableKeyset must be a true keyset sibling of findPromotable
// — same eligibility and PROMOTED_FROM exclusion, same tier-first ordering —
// plus the continuation predicate that lets a pass resume after a cursor.
import { describe, expect, it, vi } from 'vitest';
import type { Driver } from 'neo4j-driver';
// Through the package index on purpose: proves @memberry/core re-exports the
// MEM-005 scheduler contract the cursor in this call was minted from.
import { promotionClassTierV1 } from '@memberry/core';
import { EpisodicStore } from '../episodic.js';

describe('EpisodicStore.findPromotableKeyset cypher shape', () => {
  async function runKeyset() {
    const run = vi.fn().mockResolvedValue({ records: [] });
    const close = vi.fn().mockResolvedValue(undefined);
    const driver = { session: vi.fn(() => ({ run, close })) } as unknown as Driver;

    const after = {
      classTier: promotionClassTierV1({ id: 'ep-9', created_at: '2026-08-01T00:00:00.000Z' }),
      createdAt: '2026-08-01T00:00:00.000Z',
      id: 'ep-9',
    };
    await new EpisodicStore(driver).findPromotableKeyset('project:test', 20, 'default', after);
    return { cypher: run.mock.calls[0]?.[0] as string, params: run.mock.calls[0]?.[1] as Record<string, unknown> };
  }

  it('keeps the exact eligibility and PROMOTED_FROM exclusion of findPromotable', async () => {
    const { cypher } = await runKeyset();
    expect(cypher).toContain('($scope IS NULL OR e.scope = $scope)');
    expect(cypher).toContain('coalesce(e.tenant_id, $tenantId) = $tenantId');
    expect(cypher).toContain("e.memory_type = 'decision' AND e.outcome = 'approved'");
    expect(cypher).toContain('OR e.embedding IS NOT NULL');
    expect(cypher).toContain('NOT EXISTS { MATCH (:Semantic)-[:PROMOTED_FROM]->(e) }');
  });

  it('adds the keyset continuation predicate over the computed tier', async () => {
    const { cypher, params } = await runKeyset();
    expect(cypher).toContain('tier > $afterTier');
    expect(cypher).toContain('tier = $afterTier AND e.created_at > $afterCreatedAt');
    expect(cypher).toContain('tier = $afterTier AND e.created_at = $afterCreatedAt AND e.id > $afterId');
    expect(params).toMatchObject({
      scope: 'project:test',
      tenantId: 'default',
      limit: 20,
      afterTier: 2,
      afterCreatedAt: '2026-08-01T00:00:00.000Z',
      afterId: 'ep-9',
    });
  });

  it('orders tier before created_at before id, with a parameterized LIMIT', async () => {
    const { cypher } = await runKeyset();
    expect(cypher).toContain('ORDER BY tier ASC, e.created_at ASC, e.id ASC');
    // Same tier CASE as findPromotable's ORDER BY, computed once in WITH.
    expect(cypher).toContain("e.memory_type IN ['pattern', 'convention'] THEN 1");
    expect(cypher).toContain('ELSE 2');
    expect(cypher).toContain('THEN 0');
    expect(cypher).toContain('LIMIT toInteger($limit)');
  });
});
