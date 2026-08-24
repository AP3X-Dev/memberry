// packages/neo4j/src/__tests__/lifecycle-sidecar-indexes.test.ts
//
// MEM-006: the sidecar observed_at indexes back the oldest-first retention
// scan. They are delivered through the idempotent initSchema() INDEXES list
// (every statement IF NOT EXISTS, safe to re-run on any existing graph) rather
// than a MIGRATIONS append: pure index creation needs no once-only semantics,
// and the migration-runner regression tests pin the shipped list's tail.

import { describe, it, expect, vi } from 'vitest';
import { initSchema } from '../schema.js';

function makeRecordingDriver() {
  const statements: string[] = [];
  const session = {
    run: vi.fn(async (cypher: string) => {
      statements.push(cypher);
      return { records: [] };
    }),
    close: vi.fn(),
  };
  return { driver: { session: vi.fn(() => session) } as any, statements };
}

describe('lifecycle sidecar observed_at indexes', () => {
  it('initSchema creates both composite indexes with IF NOT EXISTS', async () => {
    const { driver, statements } = makeRecordingDriver();
    await initSchema(driver);

    const observation = statements.find((s) => s.includes('admission_observation_observed_at'));
    const routing = statements.find((s) => s.includes('admission_routing_recommendation_observed_at'));
    expect(observation).toBeDefined();
    expect(observation).toContain('IF NOT EXISTS');
    expect(observation).toContain('(o.tenant_id, o.project_scope, o.observed_at)');
    expect(routing).toBeDefined();
    expect(routing).toContain('IF NOT EXISTS');
    expect(routing).toContain('(r.tenant_id, r.project_scope, r.observed_at)');
  });

  it('re-running initSchema issues the identical idempotent statements (applies twice cleanly)', async () => {
    const { driver, statements } = makeRecordingDriver();
    await initSchema(driver);
    const first = [...statements];
    await initSchema(driver);
    expect(statements).toEqual([...first, ...first]);
    expect(first.every((s) => s.includes('IF NOT EXISTS'))).toBe(true);
  });
});
