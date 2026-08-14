import { describe, expect, it, vi } from 'vitest';
import type { Driver } from 'neo4j-driver';
import type { SemanticNode } from '@memberry/core';
import { SemanticStore } from '../semantic.js';

describe('SemanticStore promotion ambiguous-commit replay contract', () => {
  it('uses deterministic-id exact-provenance replay while rejecting other overlaps', async () => {
    const queries: string[] = [];
    const run = vi.fn(async (query: string) => {
      queries.push(query);
      return { records: [{ get: () => 'semantic-stable' }] };
    });
    const executeWrite = vi.fn(async (work: (tx: { run: typeof run }) => Promise<unknown>) =>
      work({ run }));
    const close = vi.fn().mockResolvedValue(undefined);
    const driver = { session: vi.fn(() => ({ executeWrite, close })) } as unknown as Driver;
    const store = new SemanticStore(driver);
    const now = new Date().toISOString();
    const semantic: SemanticNode = {
      id: 'semantic-stable',
      content: 'Stable promotion',
      confidence: 0.9,
      signal_count: 3,
      created_at: now,
      updated_at: now,
      decay_class: 'stable',
      tags: ['project:test'],
    };

    await expect(store.promoteFromEpisodic(['ep-a', 'ep-b'], semantic)).resolves.toBe('semantic-stable');
    await expect(store.promoteFromEpisodic(['ep-a', 'ep-b'], semantic)).resolves.toBe('semantic-stable');

    const cypher = queries[0];
    expect(cypher).toContain('OPTIONAL MATCH (existing:Semantic {id: $id})');
    expect(cypher).toContain('size(existingSourceIds) = size($episodicIds)');
    expect(cypher).toContain('other.id <> $id');
    expect(cypher).toContain('MERGE (s:Semantic {id: $id})');
    expect(cypher).not.toMatch(/CALL\s*\{\s*WITH\s+existing\s*WHERE/);
    expect(cypher).toContain('MERGE (s)-[:PROMOTED_FROM]->(ep)');
  });
});
