// packages/redis/src/cache.ts
import type { Redis } from 'ioredis';
import type { MemoryContext } from '@memberry/core';
import { DEFAULT_TENANT } from '@memberry/core';

// Per-tenant key namespacing (mirrors OPT-26's feedback.ts scheme).
//
// The context cache and its reverse-dependency sets were keyed by NAKED
// scope/node ids (`amp:ctx:<hash>`, `amp:scope-deps:<tag>`, `amp:deps:<id>`).
// On a SHARED project tag, tenant A's berry_store would invalidate tenant B's
// cached context — a cross-tenant correctness/perf coupling and a covert
// cache-miss-timing side channel. Namespacing both the ctx value key AND the
// dep-set keys by the resolved tenant isolates eviction to a single tenant.
//
// Back-compat: the DEFAULT (single-tenant / legacy) tenant keeps the original
// un-namespaced keys, so existing cache entries keep working with no cold start
// — identical to OPT-26. Every named tenant gets its own `…:<tenant>:…`
// segment. The ctx key and the dep-set keys are derived from the SAME resolved
// tenant, so within-tenant invalidation still finds the contexts it registered.

function resolveTenant(tenantId?: string | null): string {
  const t = (tenantId ?? '').trim();
  return t.length > 0 ? t : DEFAULT_TENANT;
}

function isDefaultTenant(tenantId?: string | null): boolean {
  return resolveTenant(tenantId) === DEFAULT_TENANT;
}

function ctxKey(scopeHash: string, tenant: string): string {
  return isDefaultTenant(tenant) ? `amp:ctx:${scopeHash}` : `amp:ctx:${tenant}:${scopeHash}`;
}

function scopeDepsKey(scope: string, tenant: string): string {
  return isDefaultTenant(tenant) ? `amp:scope-deps:${scope}` : `amp:scope-deps:${tenant}:${scope}`;
}

function nodeDepsKey(nodeId: string, tenant: string): string {
  return isDefaultTenant(tenant) ? `amp:deps:${nodeId}` : `amp:deps:${tenant}:${nodeId}`;
}

export class ContextCache {
  constructor(private redis: Redis) {}

  async get(scopeHash: string, tenantId?: string): Promise<MemoryContext | null> {
    const raw = await this.redis.get(ctxKey(scopeHash, resolveTenant(tenantId)));
    if (!raw) return null;
    return JSON.parse(raw) as MemoryContext;
  }

  async set(
    scopeHash: string,
    context: MemoryContext,
    sourceNodeIds: string[],
    ttl: number = 300,
    scopeTags?: string[],
    tenantId?: string,
  ): Promise<void> {
    const tenant = resolveTenant(tenantId);
    const key = ctxKey(scopeHash, tenant);
    await this.redis.setex(key, ttl, JSON.stringify(context));

    // Track reverse dependencies for targeted invalidation
    // Use a longer TTL for dep sets so they outlive the context keys they reference
    const depsTtl = ttl * 2;
    const pipeline = this.redis.pipeline();
    for (const nodeId of sourceNodeIds) {
      const dk = nodeDepsKey(nodeId, tenant);
      pipeline.sadd(dk, key);
      pipeline.expire(dk, depsTtl);
    }
    // Track scope→cache-keys mapping for block mutation invalidation
    if (scopeTags) {
      for (const tag of scopeTags) {
        const sk = scopeDepsKey(tag, tenant);
        pipeline.sadd(sk, key);
        pipeline.expire(sk, depsTtl);
      }
    }
    await pipeline.exec();
  }

  async invalidateByScope(scope: string, tenantId?: string): Promise<number> {
    const depsKey = scopeDepsKey(scope, resolveTenant(tenantId));
    const cacheKeys = await this.redis.smembers(depsKey);
    if (cacheKeys.length === 0) return 0;

    const pipeline = this.redis.pipeline();
    for (const key of cacheKeys) {
      pipeline.del(key);
    }
    pipeline.del(depsKey);
    await pipeline.exec();
    return cacheKeys.length;
  }

  async invalidateByNodeId(nodeId: string, tenantId?: string): Promise<number> {
    const depsKey = nodeDepsKey(nodeId, resolveTenant(tenantId));
    const cacheKeys = await this.redis.smembers(depsKey);
    if (cacheKeys.length === 0) return 0;

    const pipeline = this.redis.pipeline();
    for (const key of cacheKeys) {
      pipeline.del(key);
    }
    pipeline.del(depsKey);
    await pipeline.exec();
    return cacheKeys.length;
  }
}
