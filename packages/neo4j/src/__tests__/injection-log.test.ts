// packages/neo4j/src/__tests__/injection-log.test.ts
//
// Unit tests for the injection-telemetry store (rebuild Phase 0 scaffolding).
// Uses a mocked driver — schema/index creation is covered by migrations tests.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InjectionLogStore } from '../injection-log.js';
import type { Driver } from 'neo4j-driver';

function makeMockDriver() {
  const run = vi.fn().mockResolvedValue({ records: [] });
  const close = vi.fn().mockResolvedValue(undefined);
  const driver = {
    session: vi.fn(() => ({ run, close })),
  } as unknown as Driver;
  return { driver, run, close };
}

describe('InjectionLogStore', () => {
  let mock: ReturnType<typeof makeMockDriver>;
  let store: InjectionLogStore;

  beforeEach(() => {
    mock = makeMockDriver();
    store = new InjectionLogStore(mock.driver);
  });

  it('append creates an :InjectionLog node with usage=unknown and returns the id', async () => {
    const id = await store.append({
      session_id: 'session-1',
      scope: 'project:amp',
      task: 'rebuild roadmap phase 0',
      source_ids: ['sem-a', 'fact-b'],
      scores: [0.8, 0.5],
      tokens: 740,
      channel: 'load',
    });

    expect(id).toMatch(/^inj-/);
    expect(mock.run).toHaveBeenCalledOnce();
    const [cypher, params] = mock.run.mock.calls[0];
    expect(cypher).toContain('CREATE (i:InjectionLog');
    expect(cypher).toContain("usage: 'unknown'");
    expect(params.source_ids).toEqual(['sem-a', 'fact-b']);
    expect(params.scope).toBe('project:amp');
    expect(params.injected_at).toBeTruthy();
    expect(mock.close).toHaveBeenCalled();
  });

  it('append truncates oversized task text', async () => {
    await store.append({ task: 'x'.repeat(2000), source_ids: [] });
    const [, params] = mock.run.mock.calls[0];
    expect((params.task as string).length).toBe(500);
  });

  it('append is best-effort: returns null and does not throw on driver failure', async () => {
    mock.run.mockRejectedValueOnce(new Error('boom'));
    const id = await store.append({ source_ids: ['sem-a'] });
    expect(id).toBeNull();
    expect(mock.close).toHaveBeenCalled();
  });

  it('markUsage sets the usage label and observation time', async () => {
    await store.markUsage('inj-1', 'used', 'cited in response');
    const [cypher, params] = mock.run.mock.calls[0];
    expect(cypher).toContain('SET i.usage = $usage');
    expect(params).toMatchObject({ id: 'inj-1', usage: 'used', detail: 'cited in response' });
  });

  it('query filters by session, scope and usage', async () => {
    await store.query({ session_id: 's-1', scope: 'project:amp', usage: 'ignored', limit: 10 });
    const [cypher] = mock.run.mock.calls[0];
    expect(cypher).toContain('i.session_id = $session_id');
    expect(cypher).toContain('i.scope = $scope');
    expect(cypher).toContain('i.usage = $usage');
    expect(cypher).toContain('ORDER BY i.injected_at DESC');
  });

  it('query maps node properties back to InjectionRecord', async () => {
    mock.run.mockResolvedValueOnce({
      records: [
        {
          get: () => ({
            properties: {
              id: 'inj-9',
              session_id: 's-9',
              scope: 'project:amp',
              source_ids: ['sem-a'],
              scores: [0.7],
              tokens: 512,
              channel: 'load',
              usage: 'used',
              usage_detail: 'applied',
              injected_at: '2026-06-09T00:00:00.000Z',
            },
          }),
        },
      ],
    });
    const records = await store.query({});
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: 'inj-9',
      source_ids: ['sem-a'],
      usage: 'used',
      tokens: 512,
    });
  });
});
