import { describe, expect, it, vi } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { EpisodicStore } from '../episodic.js';

describe('EpisodicStore.findPromotable classification eligibility', () => {
  it('prioritizes approved decisions and classified recurrence ahead of legacy backlog', async () => {
    const run = vi.fn().mockResolvedValue({ records: [] });
    const close = vi.fn().mockResolvedValue(undefined);
    const driver = { session: vi.fn(() => ({ run, close })) } as unknown as Driver;

    await new EpisodicStore(driver).findPromotable('project:test', 20, 'default');

    const cypher = run.mock.calls[0]?.[0] as string;
    expect(cypher).toContain("e.memory_type = 'decision' AND e.outcome = 'approved'");
    expect(cypher).toContain('OR e.embedding IS NOT NULL');
    expect(cypher.indexOf('CASE')).toBeLessThan(cypher.indexOf('e.created_at ASC'));
    expect(cypher).toContain("e.memory_type IN ['pattern', 'convention'] THEN 1");
    expect(cypher).toContain('ELSE 2');
    expect(cypher).toContain('THEN 0');
  });
});
