// packages/neo4j/src/__tests__/query-scope-enforcement.test.ts
//
// Rebuild Phase 1 — structural tenancy at the Cypher layer. Asserts that
// byScope/byVector emit a HARD project-scope predicate when projectScope is
// set, and emit none when it isn't (deliberate cross-project reads).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScopedQuery } from '../query.js';
import type { Driver } from 'neo4j-driver';

function makeMockDriver() {
  const run = vi.fn().mockResolvedValue({ records: [] });
  const close = vi.fn().mockResolvedValue(undefined);
  const driver = {
    session: vi.fn(() => ({ run, close })),
  } as unknown as Driver;
  return { driver, run };
}

const SCOPE_PRED_S = '(s.scope = $projectScope OR $projectScope IN s.tags)';
const SCOPE_PRED_NODE = '(node.scope = $projectScope OR $projectScope IN node.tags)';

describe('ScopedQuery structural scope enforcement', () => {
  let mock: ReturnType<typeof makeMockDriver>;
  let query: ScopedQuery;

  beforeEach(() => {
    mock = makeMockDriver();
    query = new ScopedQuery(mock.driver);
  });

  it('byScope adds the scope predicate to the tags branch', async () => {
    await query.byScope({ tags: ['project:amp', 'architecture'], limit: 10, projectScope: 'project:amp' });
    const [cypher, params] = mock.run.mock.calls[0];
    expect(cypher).toContain(SCOPE_PRED_S);
    expect(params.projectScope).toBe('project:amp');
  });

  it('byScope adds the scope predicate to the entities branch', async () => {
    await query.byScope({ entities: ['amp'], limit: 10, projectScope: 'project:amp' });
    const [cypher] = mock.run.mock.calls[0];
    expect(cypher).toContain(SCOPE_PRED_S);
  });

  it('byScope adds the scope predicate to the entities+tags and unfiltered branches', async () => {
    await query.byScope({ entities: ['amp'], tags: ['architecture'], limit: 10, projectScope: 'project:amp' });
    await query.byScope({ limit: 10, projectScope: 'project:amp' });
    for (const call of mock.run.mock.calls) {
      expect(call[0]).toContain(SCOPE_PRED_S);
    }
  });

  it('byScope lowercases the bound scope', async () => {
    await query.byScope({ tags: ['Project:AMP'], limit: 10, projectScope: 'Project:AMP' });
    const [, params] = mock.run.mock.calls[0];
    expect(params.projectScope).toBe('project:amp');
  });

  it('byScope emits no scope predicate without projectScope (cross-project read)', async () => {
    await query.byScope({ tags: ['architecture'], limit: 10 });
    const [cypher] = mock.run.mock.calls[0];
    expect(cypher).not.toContain('$projectScope');
  });

  it('byVector adds the scope predicate and over-fetches when scoped', async () => {
    await query.byVector(new Array(8).fill(0.1), 20, undefined, 'project:amp');
    const [cypher, params] = mock.run.mock.calls[0];
    expect(cypher).toContain(SCOPE_PRED_NODE);
    expect(params.projectScope).toBe('project:amp');
    // Over-fetch: the index returns K nearest BEFORE filtering, so the scoped
    // query must fetch more than it returns.
    expect(Number(params.fetch)).toBeGreaterThan(Number(params.limit));
  });

  it('byVector emits no scope predicate without projectScope', async () => {
    await query.byVector(new Array(8).fill(0.1), 20);
    const [cypher, params] = mock.run.mock.calls[0];
    expect(cypher).not.toContain('$projectScope');
    expect(Number(params.fetch)).toBe(20);
  });
});
