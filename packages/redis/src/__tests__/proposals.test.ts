// packages/redis/src/__tests__/proposals.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { ConsolidationProposal } from '@memberry/core';
import { createRedisClient } from '../client.js';
import { ProposalStore } from '../proposals.js';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

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

function makeProposal(overrides: Partial<ConsolidationProposal> = {}): ConsolidationProposal {
  return {
    id: 'test-proposal-001',
    type: 'promote',
    scope: 'test-scope',
    affected_ids: ['node-1', 'node-2'],
    before: { confidence: 0.5 },
    after: { confidence: 0.9 },
    score: 0.85,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('ProposalStore', () => {
  const redis = createRedisClient(REDIS_URL);
  const store = new ProposalStore(redis);
  let redisAvailable = false;

  beforeAll(async () => {
    redisAvailable = await isRedisReachable(REDIS_URL);
    if (!redisAvailable) {
      console.warn(`[skip] Redis not reachable at ${REDIS_URL} — skipping proposal store tests`);
    }
  });

  beforeEach(async () => {
    if (!redisAvailable) return;
    const propKeys = await redis.keys('amp:proposals:*');
    if (propKeys.length) await redis.del(...propKeys);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('should return null for a missing proposal', async () => {
    if (!redisAvailable) return;
    const result = await store.get('nonexistent-id');
    expect(result).toBeNull();
  });

  it('should save and retrieve a proposal', async () => {
    if (!redisAvailable) return;
    const proposal = makeProposal();
    await store.save(proposal);
    const result = await store.get(proposal.id);
    expect(result).toEqual(proposal);
  });

  it('should add the proposal id to the pending set on save', async () => {
    if (!redisAvailable) return;
    const proposal = makeProposal({ id: 'pending-test-001' });
    await store.save(proposal);
    const pending = await store.listPending();
    expect(pending).toContain('pending-test-001');
  });

  it('should list all pending proposal ids', async () => {
    if (!redisAvailable) return;
    const p1 = makeProposal({ id: 'list-test-001' });
    const p2 = makeProposal({ id: 'list-test-002', type: 'merge' });
    await store.save(p1);
    await store.save(p2);
    const pending = await store.listPending();
    expect(pending).toContain('list-test-001');
    expect(pending).toContain('list-test-002');
  });

  it('should remove a proposal and its pending entry', async () => {
    if (!redisAvailable) return;
    const proposal = makeProposal({ id: 'remove-test-001' });
    await store.save(proposal);

    await store.remove(proposal.id);

    const result = await store.get(proposal.id);
    expect(result).toBeNull();

    const pending = await store.listPending();
    expect(pending).not.toContain('remove-test-001');
  });

  it('should preserve other proposals when one is removed', async () => {
    if (!redisAvailable) return;
    const p1 = makeProposal({ id: 'keep-001' });
    const p2 = makeProposal({ id: 'remove-002' });
    await store.save(p1);
    await store.save(p2);

    await store.remove(p2.id);

    expect(await store.get(p1.id)).toEqual(p1);
    const pending = await store.listPending();
    expect(pending).toContain('keep-001');
    expect(pending).not.toContain('remove-002');
  });

  it('OPT-48: self-heals dangling pending ids when the proposal key has expired', async () => {
    if (!redisAvailable) return;
    await store.save(makeProposal({ id: 'live-001' }));
    await store.save(makeProposal({ id: 'dead-001' }));
    // Simulate TTL expiry of `dead`: drop its proposal key but NOT its set id
    // (the bug — remove() would srem it, but expiry doesn't).
    await redis.del('amp:proposals:dead-001');

    const pending = await store.listPending();
    expect(pending).toContain('live-001');
    expect(pending).not.toContain('dead-001'); // dangling id filtered out

    // …and pruned from the set, so it cannot reappear on the next call.
    const rawSet = await redis.smembers('amp:proposals:pending');
    expect(rawSet).toContain('live-001');
    expect(rawSet).not.toContain('dead-001');
  });

  it('should store all proposal fields including nested objects', async () => {
    if (!redisAvailable) return;
    const proposal = makeProposal({
      id: 'nested-test-001',
      type: 'supersede',
      before: { confidence: 0.3, tags: ['old-tag'] },
      after: { confidence: 0.95, tags: ['new-tag', 'updated'] },
      affected_ids: ['node-A', 'node-B', 'node-C'],
    });
    await store.save(proposal);
    const result = await store.get(proposal.id);
    expect(result).toEqual(proposal);
  });
});

describe('ProposalStore durable save (mocked redis)', () => {
  function fakeRedis(execResult: unknown) {
    const pipeline: Record<string, ReturnType<typeof vi.fn>> = {};
    pipeline.set = vi.fn(() => pipeline);
    pipeline.setex = vi.fn(() => pipeline);
    pipeline.sadd = vi.fn(() => pipeline);
    pipeline.exec = vi.fn().mockResolvedValue(execResult);
    return {
      redis: { pipeline: () => pipeline } as unknown as Redis,
      pipeline,
    };
  }

  it('stores review-gated proposals without expiry by default', async () => {
    const prior = process.env.MEMBERRY_PROPOSAL_TTL_SECONDS;
    delete process.env.MEMBERRY_PROPOSAL_TTL_SECONDS;
    try {
      const { redis, pipeline } = fakeRedis([[null, 'OK'], [null, 1]]);
      await new ProposalStore(redis).save(makeProposal());
      expect(pipeline.set).toHaveBeenCalledOnce();
      expect(pipeline.setex).not.toHaveBeenCalled();
    } finally {
      if (prior === undefined) delete process.env.MEMBERRY_PROPOSAL_TTL_SECONDS;
      else process.env.MEMBERRY_PROPOSAL_TTL_SECONDS = prior;
    }
  });

  it('rejects a partial pipeline failure so consolidation cannot ACK the signal', async () => {
    const failure = new Error('SADD failed');
    const { redis } = fakeRedis([[null, 'OK'], [failure, null]]);
    await expect(new ProposalStore(redis).save(makeProposal())).rejects.toThrow('SADD failed');
  });
});
