// packages/redis/src/proposals.ts
import type { Redis } from 'ioredis';
import type { ConsolidationProposal } from '@memberry/core';

const PENDING_SET = 'amp:proposals:pending';

/**
 * Review-gated proposals are durable by default. Operators may opt into a TTL
 * for low-risk deployments, but zero/absent means no silent expiry.
 */
function configuredTtlSeconds(): number | null {
  const parsed = Number.parseInt(process.env.MEMBERRY_PROPOSAL_TTL_SECONDS ?? '0', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function proposalKey(id: string): string {
  return `amp:proposals:${id}`;
}

export class ProposalStore {
  constructor(private redis: Redis) {}

  async save(proposal: ConsolidationProposal): Promise<void> {
    const key = proposalKey(proposal.id);
    const pipeline = this.redis.pipeline();
    const ttl = configuredTtlSeconds();
    if (ttl === null) pipeline.set(key, JSON.stringify(proposal));
    else pipeline.setex(key, ttl, JSON.stringify(proposal));
    pipeline.sadd(PENDING_SET, proposal.id);
    const results = await pipeline.exec();
    if (!results || results.some(([err]) => err !== null)) {
      const firstError = results?.find(([err]) => err !== null)?.[0];
      throw firstError instanceof Error ? firstError : new Error('Proposal save transaction failed');
    }
  }

  async get(id: string): Promise<ConsolidationProposal | null> {
    const raw = await this.redis.get(proposalKey(id));
    if (!raw) return null;
    return JSON.parse(raw) as ConsolidationProposal;
  }

  async listPending(): Promise<string[]> {
    const ids = await this.redis.smembers(PENDING_SET);
    if (ids.length === 0) return [];
    // OPT-48: self-heal if an operator-configured TTL or manual key deletion
    // leaves a dangling set id. Check each
    // id's key existence in one pipeline, prune the dead ones, and return only
    // ids backed by a live proposal.
    const pipeline = this.redis.pipeline();
    for (const id of ids) pipeline.exists(proposalKey(id));
    const results = await pipeline.exec();
    // Defensive: if the pipeline failed wholesale, return the unpruned ids rather
    // than risk nuking the set on a transient error.
    if (!results) return ids;

    const live: string[] = [];
    const dead: string[] = [];
    ids.forEach((id, i) => {
      // ioredis pipeline result row = [err, value]; EXISTS → 1 (present) / 0 (gone).
      if (results[i]?.[1] === 1) live.push(id);
      else dead.push(id);
    });
    if (dead.length > 0) await this.redis.srem(PENDING_SET, ...dead);
    return live;
  }

  async remove(id: string): Promise<void> {
    const pipeline = this.redis.pipeline();
    pipeline.del(proposalKey(id));
    pipeline.srem(PENDING_SET, id);
    const results = await pipeline.exec();
    if (!results || results.some(([err]) => err !== null)) {
      const firstError = results?.find(([err]) => err !== null)?.[0];
      throw firstError instanceof Error ? firstError : new Error('Proposal removal transaction failed');
    }
  }
}
