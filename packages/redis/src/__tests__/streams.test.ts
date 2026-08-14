// packages/redis/src/__tests__/streams.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { createRedisClient } from '../client.js';
import { SignalStream, EpisodicBuffer } from '../streams.js';
import type { BufferEvent } from '../streams.js';
import type { StreamSignal } from '@memberry/core';

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

describe('SignalStream.publish — durable XADD (mocked redis)', () => {
  it('does not MAXLEN-trim potentially unacked signals and preserves the payload', async () => {
    const xadd = vi.fn().mockResolvedValue('1-0');
    const fakeRedis = { xadd } as unknown as Redis;
    const stream = new SignalStream(fakeRedis);

    const signal: StreamSignal = {
      type: 'reinforcement',
      target_id: 'node-001',
      detail: 'Great answer',
      source_session: 'session-abc',
      agent_id: 'agent-1',
      timestamp: '2026-06-14T00:00:00.000Z',
    };

    const id = await stream.publish(signal);
    expect(id).toBe('1-0');
    expect(xadd).toHaveBeenCalledTimes(1);

    const args = xadd.mock.calls[0];
    expect(args[0]).toBe('amp:signals');
    expect(args).not.toContain('MAXLEN');

    const starIdx = args.indexOf('*');
    expect(starIdx).toBe(1);
    expect(args.slice(starIdx)).toEqual([
      '*',
      'type', 'reinforcement',
      'target_id', 'node-001',
      'detail', 'Great answer',
      'source_session', 'session-abc',
      'agent_id', 'agent-1',
      'timestamp', '2026-06-14T00:00:00.000Z',
      'scope', '',
      'tenant_id', '',
    ]);
  });
});

describe('SignalStream.consume — durable delivery (mocked redis)', () => {
  const fields = [
    'type', 'reinforcement',
    'target_id', 'node-backlog',
    'detail', 'still valid',
    'source_session', 'session-1',
    'agent_id', 'agent-1',
    'timestamp', '2026-08-14T00:00:00.000Z',
  ];

  it('creates a first consumer group at 0-0 and does not ACK during read', async () => {
    const xgroup = vi.fn().mockResolvedValue('OK');
    const xreadgroup = vi.fn()
      .mockResolvedValueOnce(null) // this consumer's pending entries
      .mockResolvedValueOnce([['amp:signals', [['1-0', fields]]]]); // backlog/new delivery
    const xautoclaim = vi.fn().mockResolvedValue(['0-0', []]);
    const xack = vi.fn().mockResolvedValue(1);
    const stream = new SignalStream({ xgroup, xreadgroup, xautoclaim, xack } as unknown as Redis);

    const delivered = await stream.consume('durable-group', 'consumer-1', 10);

    expect(xgroup).toHaveBeenCalledWith(
      'CREATE', 'amp:signals', 'durable-group', '0-0', 'MKSTREAM',
    );
    expect(delivered).toEqual([
      expect.objectContaining({ stream_id: '1-0', target_id: 'node-backlog' }),
    ]);
    expect(xack).not.toHaveBeenCalled();
  });

  it('reclaims a crashed consumer delivery and ACKs only when explicitly asked', async () => {
    const xgroup = vi.fn().mockResolvedValue('OK');
    const xreadgroup = vi.fn().mockResolvedValue(null);
    const xautoclaim = vi.fn().mockResolvedValue(['0-0', [['2-0', fields]]]);
    const xack = vi.fn().mockReturnThis();
    const xdel = vi.fn().mockReturnThis();
    const exec = vi.fn().mockResolvedValue([[null, 1], [null, 1]]);
    const multi = vi.fn(() => ({ xack, xdel, exec }));
    const stream = new SignalStream({ xgroup, xreadgroup, xautoclaim, multi } as unknown as Redis);

    const delivered = await stream.consume('durable-group', 'consumer-after-crash', 10, '>', 0);
    expect(delivered[0]?.stream_id).toBe('2-0');
    expect(xack).not.toHaveBeenCalled();

    await stream.ack('durable-group', ['2-0']);
    expect(xack).toHaveBeenCalledWith('amp:signals', 'durable-group', '2-0');
    expect(xdel).toHaveBeenCalledWith('amp:signals', '2-0');
    expect(exec).toHaveBeenCalledOnce();
  });

  it('reserves capacity for new work when the pending prefix is full of poison', async () => {
    const poison = (id: string): [string, string[]] => [
      id,
      [...fields.slice(0, 2), 'target_id', `missing-${id}`, ...fields.slice(4)],
    ];
    const validFields = [...fields];
    validFields[3] = 'valid-later';
    const xgroup = vi.fn().mockResolvedValue('OK');
    const xreadgroup = vi.fn()
      .mockResolvedValueOnce([['amp:signals', [poison('1-0'), poison('2-0')]]])
      .mockResolvedValueOnce([['amp:signals', [['200-0', validFields]]]]);
    const xautoclaim = vi.fn().mockResolvedValue(['0-0', []]);
    const stream = new SignalStream({ xgroup, xreadgroup, xautoclaim } as unknown as Redis);

    const delivered = await stream.consume('fair-group', 'consumer-1', 4);

    expect(delivered.some((signal) => signal.stream_id === '200-0')).toBe(true);
    expect(xreadgroup).toHaveBeenLastCalledWith(
      'GROUP', 'fair-group', 'consumer-1', 'COUNT', 2,
      'STREAMS', 'amp:signals', '>',
    );
  });
});

describe('SignalStream', () => {
  const redis = createRedisClient(REDIS_URL);
  const stream = new SignalStream(redis);
  let redisAvailable = false;

  beforeAll(async () => {
    redisAvailable = await isRedisReachable(REDIS_URL);
    if (!redisAvailable) {
      console.warn(`[skip] Redis not reachable at ${REDIS_URL} — skipping SignalStream tests`);
    }
  });

  beforeEach(async () => {
    if (!redisAvailable) return;
    // Clean up the test stream before each test
    await redis.del('amp:signals');
  });

  afterAll(async () => {
    await redis.quit().catch(() => {});
  });

  it('should publish a signal and return a message ID', async () => {
    if (!redisAvailable) return;

    const signal: StreamSignal = {
      type: 'reinforcement',
      target_id: 'node-001',
      detail: 'Great answer',
      source_session: 'session-abc',
      agent_id: 'agent-1',
      timestamp: new Date().toISOString(),
    };

    const msgId = await stream.publish(signal);
    expect(typeof msgId).toBe('string');
    expect(msgId.length).toBeGreaterThan(0);
    // Redis stream IDs look like "1234567890-0"
    expect(msgId).toMatch(/^\d+-\d+$/);
  });

  it('should consume a published signal', async () => {
    if (!redisAvailable) return;

    const signal: StreamSignal = {
      type: 'correction',
      target_id: 'node-002',
      detail: 'Needs revision',
      source_session: 'session-xyz',
      agent_id: 'agent-2',
      timestamp: new Date().toISOString(),
    };

    const msgId = await stream.publish(signal);

    // The group is created after publish; starting at 0-0 must preserve backlog.
    const consumed = await stream.consume('test-consume-group', 'consumer-1', 10);

    expect(consumed.length).toBeGreaterThanOrEqual(1);
    const found = consumed.find((s) => s.target_id === 'node-002');
    expect(found).toBeDefined();
    expect(found!.type).toBe('correction');
    expect(found!.detail).toBe('Needs revision');
    expect(found!.source_session).toBe('session-xyz');
    expect(found!.agent_id).toBe('agent-2');
    expect(found!.stream_id).toBe(msgId);
    expect(msgId).toMatch(/^\d+-\d+$/);
    await stream.ack('test-consume-group', consumed.map((s) => s.stream_id));
  });

  it('should not return already-consumed messages on subsequent consume calls', async () => {
    if (!redisAvailable) return;

    const signal: StreamSignal = {
      type: 'contradiction',
      target_id: 'node-003',
      detail: 'Conflicts with prior answer',
      source_session: 'session-dup',
      agent_id: 'agent-3',
      timestamp: new Date().toISOString(),
    };

    await stream.publish(signal);

    // First consume reads new messages
    const first = await stream.consume('dedup-group', 'consumer-1', 10);
    expect(first.length).toBe(1);
    await stream.ack('dedup-group', first.map((s) => s.stream_id));

    // Second consume should return nothing after explicit durable ACK.
    const second = await stream.consume('dedup-group', 'consumer-1', 10);
    expect(second.length).toBe(0);
  });
});

describe('EpisodicBuffer', () => {
  const redis = createRedisClient(REDIS_URL);
  const buffer = new EpisodicBuffer(redis);
  let redisAvailable = false;

  beforeAll(async () => {
    redisAvailable = await isRedisReachable(REDIS_URL);
    if (!redisAvailable) {
      console.warn(`[skip] Redis not reachable at ${REDIS_URL} — skipping EpisodicBuffer tests`);
    }
  });

  beforeEach(async () => {
    if (!redisAvailable) return;
    await redis.del('amp:episodic-buffer');
  });

  afterAll(async () => {
    await redis.quit().catch(() => {});
  });

  it('should add an event and return a message ID', async () => {
    if (!redisAvailable) return;

    const event: BufferEvent = { event_type: 'tool_call', content: 'Called search tool' };
    const msgId = await buffer.add('session-A', event);
    expect(typeof msgId).toBe('string');
    expect(msgId).toMatch(/^\d+-\d+$/);
  });

  it('should flush events for the correct session only', async () => {
    if (!redisAvailable) return;

    await buffer.add('session-A', { event_type: 'tool_call', content: 'Called search' });
    await buffer.add('session-A', { event_type: 'response', content: 'Got result' });
    await buffer.add('session-B', { event_type: 'tool_call', content: 'Different session' });

    const flushed = await buffer.flush('session-A');

    expect(flushed).toHaveLength(2);
    expect(flushed[0].event_type).toBe('tool_call');
    expect(flushed[0].content).toBe('Called search');
    expect(flushed[1].event_type).toBe('response');
    expect(flushed[1].content).toBe('Got result');

    // session-B event should still be in the stream
    const remaining = await buffer.flush('session-B');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].content).toBe('Different session');
  });

  it('should return empty array when no events exist for session', async () => {
    if (!redisAvailable) return;

    const flushed = await buffer.flush('session-nonexistent');
    expect(flushed).toEqual([]);
  });

  it('should remove flushed events so a second flush returns nothing', async () => {
    if (!redisAvailable) return;

    await buffer.add('session-C', { event_type: 'ping', content: 'hello' });

    const first = await buffer.flush('session-C');
    expect(first).toHaveLength(1);

    const second = await buffer.flush('session-C');
    expect(second).toHaveLength(0);
  });
});
