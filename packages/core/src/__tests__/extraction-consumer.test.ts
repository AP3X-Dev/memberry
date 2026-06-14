// packages/core/src/__tests__/extraction-consumer.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ExtractionConsumer, type ExtractionQueuePort, type QueuedJob } from '../extraction-consumer.js';

/** In-memory fake of the durable queue for deterministic consumer tests. */
class FakeQueue implements ExtractionQueuePort {
  available: QueuedJob[] = [];
  delivered = new Map<string, QueuedJob>();
  dead: Array<{ job: QueuedJob; error: string }> = [];
  acked: string[] = [];
  private seq = 0;

  async ensureGroup(): Promise<void> {}

  async read(_consumer: string, count: number): Promise<QueuedJob[]> {
    const batch = this.available.splice(0, count);
    for (const j of batch) this.delivered.set(j.id, j);
    return batch;
  }

  async claimStale(): Promise<QueuedJob[]> {
    return [];
  }

  async ack(id: string): Promise<void> {
    this.acked.push(id);
    this.delivered.delete(id);
  }

  async enqueue(job: { episodeId: string; content: string; attempt?: number }): Promise<string> {
    const id = `m${++this.seq}`;
    this.available.push({ id, episodeId: job.episodeId, content: job.content, attempt: job.attempt ?? 0 });
    return id;
  }

  async deadLetter(job: QueuedJob, error: string): Promise<void> {
    this.dead.push({ job, error });
  }
}

/** Queue that implements the OPT-56 atomic ops (requeue / deadLetterAndAck). */
class AtomicFakeQueue extends FakeQueue {
  requeueCalls: Array<{ originalId: string; retry: { episodeId: string; content: string; tenantId?: string; attempt?: number } }> = [];
  dlAckCalls: Array<{ job: QueuedJob; error: string }> = [];
  private rseq = 0;

  async requeue(originalId: string, retry: { episodeId: string; content: string; tenantId?: string; attempt?: number }): Promise<string> {
    this.requeueCalls.push({ originalId, retry });
    this.delivered.delete(originalId); // atomic: original removed in the same op
    const id = `r${++this.rseq}`;
    this.available.push({ id, episodeId: retry.episodeId, content: retry.content, attempt: retry.attempt ?? 0 });
    return id;
  }

  async deadLetterAndAck(job: QueuedJob, error: string): Promise<void> {
    this.dlAckCalls.push({ job, error });
    this.dead.push({ job, error });
    this.delivered.delete(job.id); // atomic: original removed in the same op
  }
}

describe('ExtractionConsumer', () => {
  it('processes a job and acks it on success', async () => {
    const q = new FakeQueue();
    await q.enqueue({ episodeId: 'ep1', content: 'hello' });
    const handler = vi.fn().mockResolvedValue(undefined);
    const consumer = new ExtractionConsumer(q, handler, { maxAttempts: 3 });

    const n = await consumer.drainOnce();

    expect(n).toBe(1);
    expect(handler).toHaveBeenCalledWith('hello', 'ep1', undefined);
    expect(q.acked).toHaveLength(1);
    expect(q.dead).toHaveLength(0);
    expect(q.available).toHaveLength(0);
  });

  it('re-enqueues with an incremented attempt on failure (below maxAttempts)', async () => {
    const q = new FakeQueue();
    await q.enqueue({ episodeId: 'ep1', content: 'boom' });
    const handler = vi.fn().mockRejectedValue(new Error('extract failed'));
    const consumer = new ExtractionConsumer(q, handler, { maxAttempts: 3 });

    await consumer.drainOnce();

    // original acked, a retry job re-queued with attempt=1, not yet dead-lettered
    expect(q.acked).toHaveLength(1);
    expect(q.dead).toHaveLength(0);
    expect(q.available).toHaveLength(1);
    expect(q.available[0].attempt).toBe(1);
  });

  it('dead-letters after exhausting maxAttempts', async () => {
    const q = new FakeQueue();
    const handler = vi.fn().mockRejectedValue(new Error('always fails'));
    const consumer = new ExtractionConsumer(q, handler, { maxAttempts: 3 });

    await q.enqueue({ episodeId: 'ep1', content: 'x' }); // attempt 0
    await consumer.drainOnce(); // -> attempt 1
    await consumer.drainOnce(); // -> attempt 2
    await consumer.drainOnce(); // attempt 2 -> 3 == max -> dead-letter

    expect(handler).toHaveBeenCalledTimes(3);
    expect(q.dead).toHaveLength(1);
    expect(q.dead[0].job.episodeId).toBe('ep1');
    expect(q.dead[0].error).toContain('always fails');
    expect(q.available).toHaveLength(0); // not re-queued after dead-letter
  });

  it('OPT-56: uses atomic requeue (enqueue+ack in one op), not separate enqueue+ack, on retry', async () => {
    const q = new AtomicFakeQueue();
    await q.enqueue({ episodeId: 'ep1', content: 'boom' });
    const handler = vi.fn().mockRejectedValue(new Error('extract failed'));
    const consumer = new ExtractionConsumer(q, handler, { maxAttempts: 3 });

    await consumer.drainOnce();

    // Retry went through the atomic op — NOT the separate ack() path.
    expect(q.requeueCalls).toHaveLength(1);
    expect(q.requeueCalls[0].originalId).toBeTruthy();
    expect(q.requeueCalls[0].retry.attempt).toBe(1);
    expect(q.acked).toHaveLength(0);      // standalone ack() NOT used (atomic acked internally)
    expect(q.dead).toHaveLength(0);
    expect(q.available).toHaveLength(1);  // the retry is queued
    expect(q.available[0].attempt).toBe(1);
  });

  it('OPT-56: uses atomic deadLetterAndAck (no separate ack) when exhausting maxAttempts', async () => {
    const q = new AtomicFakeQueue();
    const handler = vi.fn().mockRejectedValue(new Error('always fails'));
    const consumer = new ExtractionConsumer(q, handler, { maxAttempts: 3 });

    await q.enqueue({ episodeId: 'ep1', content: 'x' }); // attempt 0
    await consumer.drainOnce(); // 0 → 1 (atomic requeue)
    await consumer.drainOnce(); // 1 → 2 (atomic requeue)
    await consumer.drainOnce(); // 2 → max → atomic dead-letter+ack

    expect(handler).toHaveBeenCalledTimes(3);
    expect(q.requeueCalls).toHaveLength(2);   // two retries via atomic requeue
    expect(q.dlAckCalls).toHaveLength(1);     // final dead-letter via atomic op
    expect(q.dead).toHaveLength(1);
    expect(q.acked).toHaveLength(0);          // standalone ack() never used on the atomic path
    expect(q.available).toHaveLength(0);
  });

  it('drains a batch of multiple jobs in one pass', async () => {
    const q = new FakeQueue();
    await q.enqueue({ episodeId: 'a', content: '1' });
    await q.enqueue({ episodeId: 'b', content: '2' });
    await q.enqueue({ episodeId: 'c', content: '3' });
    const handler = vi.fn().mockResolvedValue(undefined);
    const consumer = new ExtractionConsumer(q, handler, { batch: 10 });

    const n = await consumer.drainOnce();

    expect(n).toBe(3);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(q.acked).toHaveLength(3);
  });

  it('start()/stop() are safe and stop halts the loop', async () => {
    const q = new FakeQueue();
    const handler = vi.fn().mockResolvedValue(undefined);
    const consumer = new ExtractionConsumer(q, handler, { pollMs: 5 });
    await consumer.start();
    await consumer.stop();
    // After stop, enqueuing should not be processed (loop halted).
    await q.enqueue({ episodeId: 'late', content: 'z' });
    await new Promise((r) => setTimeout(r, 20));
    expect(handler).not.toHaveBeenCalled();
  });
});
