// packages/core/src/__tests__/consolidation.scheduling.test.ts
//
// MEM-005: the dual-window promotion fetch. A backlog of eligible-but-never-
// promotable episodes used to pin the fetch window at the head of the order
// forever, starving newer evidence; the keyset cursor makes deferral finite.
// Scheduling must never break a promotion pass, and an accessor without the
// keyset method must behave byte-identically to the old single fetch.
import { describe, it, expect, vi } from 'vitest';
import { ConsolidationEngine } from '../consolidation.js';
import {
  SCHEDULER_CONTRACT_VERSION,
  parsePromotionCursorV1,
  serializePromotionCursorV1,
} from '../promotion-scheduler.js';
import type { AMPConfig, EpisodicNode } from '../types.js';

// ─── fixtures ────────────────────────────────────────────────────────────────

function ep(id: string, createdAt: string, overrides: Partial<EpisodicNode> = {}): EpisodicNode {
  return {
    id,
    session_id: `sess-${id}`,
    agent_id: 'agent-1',
    task: `task ${id}`,
    content: `content ${id}`,
    created_at: createdAt,
    embedding: [1, 0],
    scope: 'project:test',
    tags: ['project:test'],
    ...overrides,
  };
}

// maxCandidates 8 → headLimit 4, continuationLimit 4 (small enough to saturate).
const CONFIG: AMPConfig = {
  redis: { url: 'redis://localhost:6379' },
  neo4j: { uri: 'bolt://localhost:7687', user: 'neo4j', password: '' },
  embedding: { provider: 'openai', apiKey: 'test-key' },
  cache: { defaultTTL: 300, contextTTL: 300, embeddingTTL: 86400 },
  consolidation: {
    autoApply: false,
    signalThreshold: 3,
    promote: { minClusterSize: 3, similarityThreshold: 0.9, maxPerRun: 3, maxCandidates: 8 },
  },
  exportPath: '/tmp',
};

const CURSOR_KEY = 'memberry:consolidation:promote-cursor:v1:tenant-a:all';

/** No signals, no queue — isolates the promote path — plus the MEM-005 cursor
 *  KV backed by a real map so the cursor survives across engine.run calls. */
function redisWithKv(store = new Map<string, string>()) {
  return {
    lock: { acquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
    signals: { consume: vi.fn().mockResolvedValue([]) },
    queue: { popHighest: vi.fn().mockResolvedValue(null) },
    proposals: {
      save: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      listPending: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    cache: { invalidateByNodeId: vi.fn().mockResolvedValue(0) },
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => void store.set(key, value)),
    del: vi.fn(async (key: string) => void store.delete(key)),
  };
}

function neo4jWith(findPromotable: unknown, findPromotableKeyset?: unknown) {
  return {
    semantic: {
      getById: vi.fn().mockResolvedValue(null),
      getByIds: vi.fn().mockResolvedValue([]),
      updateConfidence: vi.fn(),
      supersede: vi.fn(),
      promoteFromEpisodic: vi.fn().mockResolvedValue('sem-new'),
    },
    episodic: {
      getById: vi.fn().mockResolvedValue(null),
      findPromotable,
      ...(findPromotableKeyset ? { findPromotableKeyset } : {}),
    },
  };
}

function engineWith(redis: unknown, neo4j: unknown) {
  return new ConsolidationEngine(redis as never, neo4j as never, CONFIG, undefined, 'tenant-a');
}

// Eligible-but-never-promotable backlog: embedded, unclassified, no LLM wired,
// so they never gain a PROMOTED_FROM edge and re-occupy the head every pass.
const headBacklog = [
  ep('old-1', '2026-01-01T00:00:00.000Z'),
  ep('old-2', '2026-01-02T00:00:00.000Z'),
  ep('old-3', '2026-01-03T00:00:00.000Z'),
  ep('old-4', '2026-01-04T00:00:00.000Z'),
];
const newDecision = ep('new-1', '2026-08-01T00:00:00.000Z', {
  memory_type: 'decision',
  outcome: 'approved',
  embedding: undefined,
});

// ─── scheduling behavior ─────────────────────────────────────────────────────

describe('ConsolidationEngine MEM-005 keyset scheduling', () => {
  it('(a) fetches new evidence stuck behind a saturating backlog by run 2 via the continuation window', async () => {
    const findPromotable = vi.fn().mockResolvedValue(headBacklog);
    const findPromotableKeyset = vi.fn().mockResolvedValue([newDecision]);
    const redis = redisWithKv();
    const engine = engineWith(redis, neo4jWith(findPromotable, findPromotableKeyset));

    // Run 1 seeds the cursor from the head batch — no continuation fetch yet.
    const run1 = await engine.run('global');
    expect(findPromotableKeyset).not.toHaveBeenCalled();
    expect(run1.proposals).toHaveLength(0);

    // Run 2's continuation starts immediately after the head window and finds
    // the new evidence the head-only fetch could never reach.
    const run2 = await engine.run('global');
    expect(findPromotableKeyset).toHaveBeenCalledTimes(1);
    expect(findPromotableKeyset).toHaveBeenCalledWith(
      undefined,
      4,
      'tenant-a',
      expect.objectContaining({ classTier: 2, createdAt: '2026-01-04T00:00:00.000Z', id: 'old-4' }),
    );
    expect(run2.proposals.some((p) => p.affected_ids.includes('new-1'))).toBe(true);
  });

  it('(a2) seed pass writes the cursor keyed to the last head element', async () => {
    const redis = redisWithKv();
    const engine = engineWith(
      redis,
      neo4jWith(vi.fn().mockResolvedValue(headBacklog), vi.fn().mockResolvedValue([])),
    );

    await engine.run('global');

    expect(redis.set).toHaveBeenCalledWith(CURSOR_KEY, expect.any(String));
    const written = parsePromotionCursorV1(redis.set.mock.calls[0]?.[1]);
    expect(written).toEqual({
      contractVersion: SCHEDULER_CONTRACT_VERSION,
      classTier: 2,
      createdAt: '2026-01-04T00:00:00.000Z',
      id: 'old-4',
    });
  });

  it('(a2) writes no cursor when the head batch is shorter than the head window', async () => {
    const redis = redisWithKv();
    const engine = engineWith(
      redis,
      neo4jWith(vi.fn().mockResolvedValue(headBacklog.slice(0, 2)), vi.fn().mockResolvedValue([])),
    );

    await engine.run('global');

    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.del).toHaveBeenCalledWith(CURSOR_KEY);
  });

  it('(b) deletes the cursor (wrap to head) when the continuation batch comes back short', async () => {
    const store = new Map<string, string>();
    store.set(
      CURSOR_KEY,
      serializePromotionCursorV1({
        contractVersion: SCHEDULER_CONTRACT_VERSION,
        classTier: 2,
        createdAt: '2026-01-04T00:00:00.000Z',
        id: 'old-4',
      }),
    );
    const redis = redisWithKv(store);
    const engine = engineWith(
      redis,
      neo4jWith(vi.fn().mockResolvedValue(headBacklog), vi.fn().mockResolvedValue([newDecision])),
    );

    await engine.run('global');

    expect(redis.del).toHaveBeenCalledWith(CURSOR_KEY);
    expect(store.has(CURSOR_KEY)).toBe(false);
  });

  it('(c) treats a corrupt cursor as "restart from head" — head-only pass, no throw', async () => {
    const store = new Map<string, string>([[CURSOR_KEY, 'not-a-cursor{']]);
    const findPromotableKeyset = vi.fn().mockResolvedValue([]);
    const engine = engineWith(
      redisWithKv(store),
      neo4jWith(vi.fn().mockResolvedValue(headBacklog), findPromotableKeyset),
    );

    const result = await engine.run('global');

    expect(result.skipped).toBe(false);
    expect(findPromotableKeyset).not.toHaveBeenCalled();
  });

  it('(d) degrades to a full-limit head-only fetch when redis fails — the pass survives', async () => {
    const redis = redisWithKv();
    redis.get = vi.fn().mockRejectedValue(new Error('redis down'));
    const findPromotable = vi.fn().mockResolvedValue(headBacklog);
    const engine = engineWith(redis, neo4jWith(findPromotable, vi.fn().mockResolvedValue([])));

    const result = await engine.run('global');

    expect(result.skipped).toBe(false);
    expect(findPromotable).toHaveBeenCalledWith(undefined, 8, 'tenant-a');
  });

  it('(e) accessor without the keyset method: one full-limit findPromotable call, no cursor traffic', async () => {
    const redis = redisWithKv();
    const findPromotable = vi.fn().mockResolvedValue(headBacklog);
    const engine = engineWith(redis, neo4jWith(findPromotable));

    await engine.run('global');

    expect(findPromotable).toHaveBeenCalledTimes(1);
    expect(findPromotable).toHaveBeenCalledWith(undefined, 8, 'tenant-a');
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('(f) an episode returned by both windows enters the pipeline exactly once (head wins)', async () => {
    const store = new Map<string, string>();
    store.set(
      CURSOR_KEY,
      serializePromotionCursorV1({
        contractVersion: SCHEDULER_CONTRACT_VERSION,
        classTier: 2,
        createdAt: '2026-01-03T00:00:00.000Z',
        id: 'old-3',
      }),
    );
    const head = [newDecision, ...headBacklog.slice(0, 3)];
    const engine = engineWith(
      redisWithKv(store),
      neo4jWith(vi.fn().mockResolvedValue(head), vi.fn().mockResolvedValue([newDecision])),
    );

    const result = await engine.run('global');

    expect(result.proposals.filter((p) => p.affected_ids.includes('new-1'))).toHaveLength(1);
  });
});
