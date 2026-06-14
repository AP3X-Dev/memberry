// packages/redis/src/dedup.ts
import type { Redis } from 'ioredis';
import { createHash } from 'crypto';

const DEFAULT_TTL = 86400; // 24 hours

function dedupKey(agentId: string, contentHash: string): string {
  const combined = createHash('sha256').update(`${agentId}:${contentHash}`).digest('hex');
  return `amp:dedup:${combined}`;
}

export class DedupChecker {
  constructor(private redis: Redis) {}

  async isDuplicate(agentId: string, contentHash: string): Promise<boolean> {
    const exists = await this.redis.exists(dedupKey(agentId, contentHash));
    return exists === 1;
  }

  async markSeen(agentId: string, contentHash: string, ttl: number = DEFAULT_TTL): Promise<void> {
    await this.redis.setex(dedupKey(agentId, contentHash), ttl, '1');
  }

  /**
   * Atomically check-and-mark a content hash as seen using SET NX EX.
   * Returns true if the content was already seen (duplicate), false if it was
   * newly marked (not a duplicate). This eliminates the TOCTOU race between
   * separate isDuplicate/markSeen calls.
   */
  async checkAndMark(agentId: string, contentHash: string, ttl: number = DEFAULT_TTL): Promise<boolean> {
    const result = await this.redis.set(dedupKey(agentId, contentHash), '1', 'EX', ttl, 'NX');
    // SET ... NX returns 'OK' if the key was set (not a duplicate), null if it already existed (duplicate)
    return result === null;
  }

  /**
   * Release a dedup key previously set via markSeen/checkAndMark. Used to roll
   * back the dedup mark when downstream persistence fails, so a retry of the
   * same content is not silently swallowed as a duplicate for the 24h TTL.
   * Uses the SAME key construction as mark.
   */
  async unmark(agentId: string, contentHash: string): Promise<void> {
    await this.redis.del(dedupKey(agentId, contentHash));
  }
}
