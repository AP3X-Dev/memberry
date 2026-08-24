// packages/redis/src/streams.ts
import type { Redis } from 'ioredis';
import type { StreamSignal } from '@memberry/core';

export interface BufferEvent {
  event_type: string;
  content: string;
}

/** Scope fields are repeated here so Redis can build against an older core declaration. */
export interface ScopedStreamSignal extends StreamSignal {
  scope?: string;
  tenant_id?: string;
}

/** A delivered signal remains pending until its stream ID is explicitly ACKed. */
export interface ConsumedSignal extends ScopedStreamSignal {
  stream_id: string;
}

const SIGNALS_STREAM = 'amp:signals';
const EPISODIC_BUFFER_STREAM = 'amp:episodic-buffer';

export interface ConsumerHealth {
  name: string;
  pending: number;
  idleMs: number;
}

export interface GroupHealth {
  /** Total PEL depth for the group (XPENDING summary). */
  pelCount: number;
  /** Age of the oldest pending entry, derived from its stream-id timestamp. */
  oldestIdleMs: number;
  consumers: ConsumerHealth[];
}

/** Parse a flat [key, value, key, value, ...] array into a plain object. */
function parseFields(fields: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    obj[fields[i]] = fields[i + 1];
  }
  return obj;
}

export class SignalStream {
  /** Fair cursors prevent poison/foreign pending entries from starving later work. */
  private readonly pendingCursors = new Map<string, string>();
  private readonly claimCursors = new Map<string, string>();

  constructor(private redis: Redis) {}

  /**
   * Publish a signal to the amp:signals Redis Stream.
   * Returns the XADD message ID.
   */
  async publish(signal: ScopedStreamSignal): Promise<string> {
    const payload = [
      'type', signal.type,
      'target_id', signal.target_id,
      'detail', signal.detail,
      'source_session', signal.source_session,
      'agent_id', signal.agent_id,
      'timestamp', signal.timestamp,
      'scope', signal.scope ?? '',
      'tenant_id', signal.tenant_id ?? '',
    ];
    // Never MAXLEN-trim this stream: Redis may delete an unacked message body
    // while leaving its PEL entry behind, violating at-least-once delivery.
    const id = await this.redis.xadd(SIGNALS_STREAM, '*', ...payload);
    if (!id) throw new Error('XADD returned null');
    return id;
  }

  /**
   * Consume signals from the amp:signals stream using at-least-once delivery.
   *
   * A new group starts at `0-0`, so signals published before the first
   * consolidation run are not skipped. The default read first redelivers this
   * consumer's pending work, then reclaims stale work left by a crashed
   * consumer, and finally reads never-delivered messages. Call {@link ack} only
   * after the resulting work has been durably saved or applied.
   */
  async consume(
    group: string,
    consumer: string,
    count: number,
    startId: string = '>',
    reclaimIdleMs: number = 60_000,
  ): Promise<ConsumedSignal[]> {
    // Ensure consumer group exists; ignore BUSYGROUP if already created
    try {
      await this.redis.xgroup('CREATE', SIGNALS_STREAM, group, '0-0', 'MKSTREAM');
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        !err.message.startsWith('BUSYGROUP')
      ) {
        throw err;
      }
    }

    const signals: ConsumedSignal[] = [];
    const seen = new Set<string>();
    const append = (messages: [string, string[]][]): void => {
      for (const [msgId, fields] of messages) {
        if (seen.has(msgId)) continue;
        seen.add(msgId);
        const obj = parseFields(fields);
        signals.push({
          stream_id: msgId,
          type: obj['type'] as StreamSignal['type'],
          target_id: obj['target_id'],
          detail: obj['detail'],
          source_session: obj['source_session'],
          agent_id: obj['agent_id'],
          timestamp: obj['timestamp'],
          ...(obj['scope'] ? { scope: obj['scope'] } : {}),
          ...(obj['tenant_id'] ? { tenant_id: obj['tenant_id'] } : {}),
        });
      }
    };

    const read = async (id: string, limit: number): Promise<[string, string[]][]> => {
      if (limit <= 0) return [];
      const results = await this.redis.xreadgroup(
        'GROUP', group, consumer,
        'COUNT', limit,
        'STREAMS', SIGNALS_STREAM, id,
      ) as [string, [string, string[]][]][] | null;
      const messages = results?.[0]?.[1] ?? [];
      append(messages);
      return messages;
    };

    // An explicit start ID preserves the old low-level escape hatch. The
    // default path adds pending and crash recovery before reading new work.
    if (startId !== '>') {
      await read(startId, count);
      return signals;
    }

    // Always reserve capacity for never-delivered entries. Pending work uses a
    // rotating cursor instead of restarting at the oldest ID every run, so a
    // bounded set of poison/foreign entries cannot monopolize the batch.
    const newQuota = count > 1 ? Math.max(1, Math.floor(count / 4)) : 1;
    const pendingQuota = Math.max(0, count - newQuota);
    const ownPendingQuota = Math.ceil(pendingQuota / 2);
    const cursorKey = `${group}:${consumer}`;
    const pendingCursor = this.pendingCursors.get(cursorKey) ?? '0';
    const pendingMessages = await read(pendingCursor, ownPendingQuota);
    if (pendingMessages.length < ownPendingQuota) {
      this.pendingCursors.set(cursorKey, '0');
    } else {
      this.pendingCursors.set(cursorKey, pendingMessages.at(-1)?.[0] ?? '0');
    }

    const claimQuota = pendingQuota - signals.length;
    if (claimQuota > 0) {
      try {
        const claimCursor = this.claimCursors.get(group) ?? '0-0';
        const claimed = (await (this.redis as unknown as {
          xautoclaim: (...args: unknown[]) => Promise<unknown>;
        }).xautoclaim(
          SIGNALS_STREAM,
          group,
          consumer,
          reclaimIdleMs,
          claimCursor,
          'COUNT',
          claimQuota,
        )) as [string, [string, string[]][], string[]?] | null;
        if (claimed?.[1]) append(claimed[1]);
        this.claimCursors.set(group, claimed?.[0] && claimed[0] !== '0-0' ? claimed[0] : '0-0');
      } catch (err: unknown) {
        // Redis < 6.2 has no XAUTOCLAIM. Own-consumer pending recovery still
        // works; surface every other error so transport failures are not hidden.
        if (!(err instanceof Error && /unknown command.*xautoclaim/i.test(err.message))) {
          throw err;
        }
      }
    }

    await read('>', Math.max(newQuota, count - signals.length));

    return signals;
  }

  /**
   * ACK and remove one or more signals after their resulting work is durable.
   * Both operations share one Redis transaction so a crash cannot leave an
   * acknowledged body growing the stream forever.
   */
  async ack(group: string, messageIds: string[]): Promise<number> {
    if (messageIds.length === 0) return 0;
    const results = await this.redis
      .multi()
      .xack(SIGNALS_STREAM, group, ...messageIds)
      .xdel(SIGNALS_STREAM, ...messageIds)
      .exec();
    if (!results) throw new Error('Redis signal ACK transaction was aborted');
    for (const [error] of results) {
      if (error) throw error;
    }
    return Number(results[0]?.[1] ?? 0);
  }

  /**
   * Health snapshot of one consumer group on amp:signals (MEM-007 report path).
   * An absent group reads as zeros — the anti-entropy pass reports, it never
   * creates groups (absent means no signals were ever consumed).
   *
   * Why consumer names need GC at all: every ConsolidationEngine instance
   * mints a fresh `consolidation-engine-<nanoid>` consumer name — one per MCP
   * process start and per tenant engine, NOT per consolidation run (there is
   * no consolidation cron minting names) — so the group's consumer list grows
   * slowly but unboundedly across process restarts.
   */
  async groupHealth(group: string): Promise<GroupHealth> {
    try {
      // XPENDING summary form: [count, minId, maxId, [[consumer, count], ...]].
      const summary = (await (this.redis as unknown as {
        xpending: (...args: unknown[]) => Promise<unknown>;
      }).xpending(SIGNALS_STREAM, group)) as
        [number, string | null, string | null, Array<[string, string]> | null] | null;
      const consumersRaw = (await (this.redis as unknown as {
        xinfo: (...args: unknown[]) => Promise<unknown>;
      }).xinfo('CONSUMERS', SIGNALS_STREAM, group)) as Array<Array<string | number>>;
      const consumers: ConsumerHealth[] = (consumersRaw ?? []).map((flat) => {
        const obj: Record<string, string | number> = {};
        for (let i = 0; i < flat.length; i += 2) obj[String(flat[i])] = flat[i + 1];
        return {
          name: String(obj['name'] ?? ''),
          pending: Number(obj['pending'] ?? 0),
          idleMs: Number(obj['idle'] ?? 0),
        };
      });
      const pelCount = Number(summary?.[0] ?? 0);
      const minId = summary?.[1];
      // Stream ids are `<ms-timestamp>-<seq>`, so the oldest pending age falls
      // out of the min id without any per-entry XPENDING scan.
      const oldestIdleMs = pelCount > 0 && minId
        ? Math.max(0, Date.now() - Number(minId.split('-')[0]))
        : 0;
      return { pelCount, oldestIdleMs, consumers };
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith('NOGROUP')) {
        return { pelCount: 0, oldestIdleMs: 0, consumers: [] };
      }
      throw err;
    }
  }

  /**
   * GC dead consumer names (MEM-007 repair path). Hard invariant: NEVER call
   * XGROUP DELCONSUMER on a consumer with pending entries — Redis drops that
   * consumer's PEL entries, silently losing undelivered signals. A dead
   * consumer WITH pending work is left alone (consolidation's own reclaim
   * drains it within a cycle, see consume() above) and GC'd on a later pass.
   * The pending check and the DELCONSUMER are two commands; a consumer past
   * the idle floor cannot acquire new pending entries between them without a
   * read that resets its idle clock first (accepted race, spec §8 R2).
   * Removing an absent consumer is a no-op, so re-runs converge.
   */
  async removeIdleConsumers(group: string, minIdleMs: number): Promise<string[]> {
    const health = await this.groupHealth(group);
    const removed: string[] = [];
    for (const consumer of health.consumers) {
      if (consumer.pending !== 0 || consumer.idleMs <= minIdleMs) continue;
      await this.redis.xgroup('DELCONSUMER', SIGNALS_STREAM, group, consumer.name);
      removed.push(consumer.name);
    }
    return removed;
  }
}

export class EpisodicBuffer {
  constructor(private redis: Redis) {}

  /**
   * XLEN of the buffer stream (MEM-007 report only). Residual entries are
   * captured-but-unconsumed memory events — they are NEVER auto-deleted, only
   * surfaced for an operator's eye.
   */
  async length(): Promise<number> {
    return Number(await this.redis.xlen(EPISODIC_BUFFER_STREAM));
  }

  /**
   * Add a micro-event to the episodic buffer stream.
   * Returns the XADD message ID.
   */
  async add(sessionId: string, event: BufferEvent): Promise<string> {
    const id = await this.redis.xadd(
      EPISODIC_BUFFER_STREAM,
      '*',
      'session_id', sessionId,
      'event_type', event.event_type,
      'content', event.content,
    );
    if (!id) throw new Error('XADD returned null');
    return id;
  }

  /**
   * Flush all buffered events for a given session.
   * Reads the full stream, filters by sessionId, then deletes only the
   * specific message IDs that were returned by XRANGE.  This prevents a
   * concurrent `add` from inserting entries between the read and delete
   * that would be silently lost, and prevents concurrent flushes from
   * re-delivering already-consumed messages.
   */
  async flush(sessionId: string): Promise<BufferEvent[]> {
    const results = await this.redis.xrange(
      EPISODIC_BUFFER_STREAM,
      '-',
      '+',
    ) as [string, string[]][];

    if (!results || results.length === 0) return [];

    const events: BufferEvent[] = [];
    const fetchedIds: string[] = [];

    for (const [msgId, fields] of results) {
      const obj = parseFields(fields);
      if (obj['session_id'] === sessionId) {
        events.push({
          event_type: obj['event_type'],
          content: obj['content'],
        });
        fetchedIds.push(msgId);
      }
    }

    // Only delete the exact message IDs we read — never a range-based
    // delete.  This ensures entries added between the XRANGE and XDEL
    // are not affected.  Skip entirely when there are no matching entries
    // to avoid a spurious XDEL call.
    if (fetchedIds.length > 0) {
      await this.redis.xdel(EPISODIC_BUFFER_STREAM, ...fetchedIds);
    }

    return events;
  }
}
