import { describe, expect, it, vi } from 'vitest';
import type { Driver } from 'neo4j-driver';

import { BootstrapGraphService } from '../bootstrap-graph.js';

describe('BootstrapGraphService admission sidecar isolation', () => {
  it('excludes OBSERVES only from the relationship total and preserves every other status field', async () => {
    const values: Record<string, unknown> = {
      bootstrapped: true,
      entityCount: 2,
      agentCount: 3,
      semCount: 5,
      epCount: 7,
      relCount: 11,
    };
    const run = vi.fn(async (_query: string, _params?: Record<string, unknown>) => ({
      records: [{ get: (key: string) => values[key] }],
    }));
    const driver = {
      session: vi.fn(() => ({ run, close: vi.fn(async () => undefined) })),
    } as unknown as Driver;

    await expect(new BootstrapGraphService(driver).status('memberry')).resolves.toEqual({
      bootstrapped: true,
      entities: 2,
      agents: 3,
      semantics: 5,
      episodics: 7,
      relationships: 11,
    });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![0]).toContain("WHERE type(r) <> 'OBSERVES'");
  });
});

// ─── RET-005B-AUTH-001B6P: semantic lifecycle producer, site 4 ───────────────
//
// A hand-authored seed carries no date field, so under (A)'s bound semantics
// ($now IS the instant the seed asserts its claim) stamping $now is truthful
// rather than invented. The ON MATCH arm is the fencing half: a re-ingest must
// never re-stamp, and because that clause is a single line the slice assertion
// below is a TOTAL guard on it, not a tail guard.
describe('BootstrapGraphService semantic lifecycle stamping (RET-005B-AUTH-001B6P)', () => {
  it('T9: stamps valid_at ON CREATE only and never inside ON MATCH SET', async () => {
    const run = vi.fn(async (_query: string, _params?: Record<string, unknown>) => ({
      records: [{ get: (key: string) => (key === 'isNew' ? true : 'mock-id') }],
    }));
    const driver = {
      session: vi.fn(() => ({ run, close: vi.fn(async () => undefined) })),
    } as unknown as Driver;

    await new BootstrapGraphService(driver).bootstrap({
      project_name: 'lifecycle-proj',
      project_tag: 'project:lifecycle',
      description: 'lifecycle producer seed',
      domain: 'test',
      entities: [],
      semantic_seeds: [{ claim: 'Seeded claim', domain: 'test' }],
      agents: [],
    });

    const semanticCall = run.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('MERGE (s:Semantic'),
    );
    expect(semanticCall).toBeDefined();
    const query = semanticCall![0] as string;

    // ON CREATE half.
    expect(query).toContain('s.valid_at = $now,');
    expect(query).not.toContain('invalid_at');
    const params = semanticCall![1] as Record<string, unknown>;
    expect(params.now).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // ON MATCH half — total, because the clause is exactly one line.
    const matchStart = query.indexOf('ON MATCH SET');
    expect(matchStart).toBeGreaterThan(-1);
    const onMatchClause = query.slice(matchStart, query.indexOf('RETURN', matchStart));
    expect(onMatchClause).not.toContain('valid_at');
    expect(onMatchClause).not.toContain('invalid_at');
    expect(query).not.toMatch(/(valid_at|invalid_at)\s*[=:]\s*null/i);
    expect(Object.prototype.hasOwnProperty.call(params, 'valid_at')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(params, 'invalid_at')).toBe(false);
  });
});
