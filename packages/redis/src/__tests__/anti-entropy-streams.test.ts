// packages/redis/src/__tests__/anti-entropy-streams.test.ts
//
// MEM-007 stream hygiene coverage:
//  - mocked units pin the XPENDING/XINFO CONSUMERS/XGROUP DELCONSUMER command
//    shapes, the pending>0 hard guard, and the absent-group report-don't-create
//    behavior;
//  - the real-Redis fault-injection sequence (skip-guarded, streams.test.ts
//    precedent) strands a PEL entry under a dead consumer, verifies the
//    EXISTING healer (SignalStream.consume reclaim) redelivers it, and pins
//    that consumer-name GC removes only empty-PEL idle consumers.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { createRedisClient } from '../client.js';
import { SignalStream, EpisodicBuffer } from '../streams.js';
import type { StreamSignal } from '@memberry/core';

// Isolated logical DB: streams.test.ts exercises the same hardcoded
// 'amp:signals' key on DB 0 in a concurrent vitest worker, and its DEL
// destroys this suite's consumer group mid-test on a shared Redis.
const REDIS_URL = `${(process.env.REDIS_URL || 'redis://localhost:6379').replace(/\/\d+$/, '')}/9`;

async function isRedisReachable(url: string): Promise<boolean> {
  const probe = createRedisClient(url, {
    maxRetriesPerRequest: 0,
    connectTimeout: 1000,
    retryStrategy: () => null,
  });
  try {
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    await probe.quit().catch(() => {});
  }
}

function signal(targetId: string): StreamSignal {
  return {
    type: 'reinforcement',
    target_id: targetId,
    detail: 'stranded work',
    source_session: 'session-ae',
    agent_id: 'agent-1',
    timestamp: '2026-08-25T00:00:00.000Z',
  };
}

describe('SignalStream.groupHealth (mocked redis)', () => {
  it('reads XPENDING summary + XINFO CONSUMERS and computes oldest pending age from the min stream id', async () => {
    const nowMs = 1_756_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    const xpending = vi.fn().mockResolvedValue([2, `${nowMs - 5000}-0`, `${nowMs - 1000}-0`, [['dead-1', '2']]]);
    const xinfo = vi.fn().mockResolvedValue([
      ['name', 'dead-1', 'pending', 2, 'idle', 90_000, 'inactive', 90_000],
      ['name', 'live-1', 'pending', 0, 'idle', 100, 'inactive', 100],
    ]);
    const stream = new SignalStream({ xpending, xinfo } as unknown as Redis);

    const health = await stream.groupHealth('consolidation');

    expect(xpending).toHaveBeenCalledWith('amp:signals', 'consolidation');
    expect(xinfo).toHaveBeenCalledWith('CONSUMERS', 'amp:signals', 'consolidation');
    expect(health.pelCount).toBe(2);
    expect(health.oldestIdleMs).toBe(5000);
    expect(health.consumers).toEqual([
      { name: 'dead-1', pending: 2, idleMs: 90_000 },
      { name: 'live-1', pending: 0, idleMs: 100 },
    ]);
    vi.restoreAllMocks();
  });

  it('reports an absent group as zeros without creating it', async () => {
    const xpending = vi.fn().mockRejectedValue(new Error("NOGROUP No such key 'amp:signals' or consumer group 'consolidation'"));
    const xinfo = vi.fn();
    const xgroup = vi.fn();
    const stream = new SignalStream({ xpending, xinfo, xgroup } as unknown as Redis);

    const health = await stream.groupHealth('consolidation');

    expect(health).toEqual({ pelCount: 0, oldestIdleMs: 0, consumers: [] });
    // Report, don't create: no XGROUP CREATE from the health path.
    expect(xgroup).not.toHaveBeenCalled();
  });
});

describe('SignalStream.removeIdleConsumers (mocked redis)', () => {
  it('DELCONSUMERs only empty-PEL consumers past the idle floor and never one with pending entries', async () => {
    const xpending = vi.fn().mockResolvedValue([2, '1-0', '2-0', [['dead-with-pel', '2']]]);
    const xinfo = vi.fn().mockResolvedValue([
      ['name', 'dead-with-pel', 'pending', 2, 'idle', 700_000_000],
      ['name', 'dead-empty', 'pending', 0, 'idle', 700_000_000],
      ['name', 'live', 'pending', 0, 'idle', 100],
    ]);
    const xgroup = vi.fn().mockResolvedValue(1);
    const stream = new SignalStream({ xpending, xinfo, xgroup } as unknown as Redis);

    const removed = await stream.removeIdleConsumers('consolidation', 604_800_000 / 2);

    expect(removed).toEqual(['dead-empty']);
    expect(xgroup).toHaveBeenCalledTimes(1);
    expect(xgroup).toHaveBeenCalledWith('DELCONSUMER', 'amp:signals', 'consolidation', 'dead-empty');
  });

  it('is a no-op on an absent group', async () => {
    const xpending = vi.fn().mockRejectedValue(new Error('NOGROUP no such group'));
    const xgroup = vi.fn();
    const stream = new SignalStream({ xpending, xgroup } as unknown as Redis);
    expect(await stream.removeIdleConsumers('consolidation', 0)).toEqual([]);
    expect(xgroup).not.toHaveBeenCalled();
  });
});

describe('EpisodicBuffer.length (mocked redis)', () => {
  it('reports XLEN of amp:episodic-buffer and issues no deletes', async () => {
    const xlen = vi.fn().mockResolvedValue(3);
    const xdel = vi.fn();
    const buffer = new EpisodicBuffer({ xlen, xdel } as unknown as Redis);
    expect(await buffer.length()).toBe(3);
    expect(xlen).toHaveBeenCalledWith('amp:episodic-buffer');
    expect(xdel).not.toHaveBeenCalled();
  });
});

describe('anti-entropy stream hygiene (real Redis fault injection)', () => {
  const GROUP = 'antientropy-test-group';
  const redis = createRedisClient(REDIS_URL);
  const stream = new SignalStream(redis);
  let redisAvailable = false;

  beforeAll(async () => {
    redisAvailable = await isRedisReachable(REDIS_URL);
    if (!redisAvailable) {
      console.warn(`[skip] Redis not reachable at ${REDIS_URL} — skipping anti-entropy stream tests`);
    }
  });

  beforeEach(async () => {
    if (!redisAvailable) return;
    await redis.del('amp:signals');
  });

  afterAll(async () => {
    await redis.quit().catch(() => {});
  });

  it('strands a PEL entry, reports it, lets the existing reclaim heal it, then GCs only the empty dead consumer name', async () => {
    if (!redisAvailable) return;

    // Inject the strand: dead-1 reads the entry and never ACKs.
    const publishedId = await stream.publish(signal('node-strand'));
    const strandStream = new SignalStream(redis);
    const stranded = await strandStream.consume(GROUP, 'dead-1', 10);
    expect(stranded.map((s) => s.stream_id)).toContain(publishedId);

    // (a) detection: the strand is attributed to dead-1.
    const health = await stream.groupHealth(GROUP);
    expect(health.pelCount).toBe(1);
    expect(health.oldestIdleMs).toBeGreaterThanOrEqual(0);
    const dead = health.consumers.find((c) => c.name === 'dead-1');
    expect(dead?.pending).toBe(1);

    // (c-1) the pending>0 hard guard: even with a zero idle floor, a consumer
    // holding PEL entries is never removed.
    const removedWhilePending = await stream.removeIdleConsumers(GROUP, 0);
    expect(removedWhilePending).not.toContain('dead-1');
    expect((await stream.groupHealth(GROUP)).consumers.map((c) => c.name)).toContain('dead-1');

    // (b) the EXISTING healer: a live consumer's consume() reclaims the strand
    // (reclaimIdleMs 0 — the crash-recovery idiom from streams.test.ts).
    const liveStream = new SignalStream(redis);
    const redelivered = await liveStream.consume(GROUP, 'live-1', 10, '>', 0);
    expect(redelivered.map((s) => s.stream_id)).toContain(publishedId);
    await liveStream.ack(GROUP, [publishedId]);

    // (c-2) with its PEL drained, the dead consumer name is GC'd; re-run is a no-op.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const removed = await stream.removeIdleConsumers(GROUP, 0);
    expect(removed).toContain('dead-1');
    const removedAgain = await stream.removeIdleConsumers(GROUP, 0);
    expect(removedAgain).not.toContain('dead-1');
  });
});
