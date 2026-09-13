import type { Redis } from 'ioredis';
import type { MemoryContext } from '@memberry/core';
import { DEFAULT_TENANT } from '@memberry/core';

export const CONTEXT_CACHE_SCHEMA_VERSION = 2 as const;
export const ACTIVE_SEMANTIC_POLICY_VERSION = 'semantic-active-v1' as const;
export type RenderedContextCacheMode = 'disabled' | 'versioned';
export type ContextCacheReadFrame =
  | Readonly<{ mode: 'current' }>
  | Readonly<{ mode: 'historical'; asOf: string }>;

/** Authority-bound identity of rendered bytes. Epoch stays a decimal string so
 * Neo4j integers beyond JavaScript's safe range remain exact. */
export interface ContextCacheMetadata {
  readonly schemaVersion: typeof CONTEXT_CACHE_SCHEMA_VERSION;
  readonly tenantId: string;
  readonly projectScope: string | null;
  readonly readFrame: ContextCacheReadFrame;
  readonly policyVersion: string;
  readonly embeddingGeneration: string;
  readonly knowledgeEpoch: string;
}

export interface ContextCacheRead { readonly scopeHash: string; readonly metadata: ContextCacheMetadata }
export interface ContextCacheWrite extends ContextCacheRead {
  readonly context: MemoryContext;
  readonly sourceNodeIds: readonly string[];
  readonly ttl?: number;
  readonly scopeTags?: readonly string[];
}
export interface ContextCacheEntry { readonly metadata: ContextCacheMetadata; readonly context: MemoryContext }
export interface ContextCacheOptions { readonly mode?: RenderedContextCacheMode }

function resolveTenant(tenantId?: string | null): string {
  const tenant = (tenantId ?? '').trim();
  return tenant.length > 0 ? tenant : DEFAULT_TENANT;
}
function isDefaultTenant(tenantId?: string | null): boolean { return resolveTenant(tenantId) === DEFAULT_TENANT; }
function ctxKey(scopeHash: string, tenant: string): string {
  return isDefaultTenant(tenant) ? `amp:ctx:v2:${scopeHash}` : `amp:ctx:v2:${tenant}:${scopeHash}`;
}
function epochKey(metadata: ContextCacheMetadata): string {
  const project = metadata.projectScope ?? '_unscoped';
  return isDefaultTenant(metadata.tenantId)
    ? `amp:knowledge-epoch:${project}`
    : `amp:knowledge-epoch:${metadata.tenantId}:${project}`;
}
function scopeDepsKey(scope: string, tenant: string): string {
  return isDefaultTenant(tenant) ? `amp:scope-deps:${scope}` : `amp:scope-deps:${tenant}:${scope}`;
}
function nodeDepsKey(nodeId: string, tenant: string): string {
  return isDefaultTenant(tenant) ? `amp:deps:${nodeId}` : `amp:deps:${tenant}:${nodeId}`;
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function validEpoch(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value);
}
function validMetadata(value: unknown): value is ContextCacheMetadata {
  if (!isPlainRecord(value) || value.schemaVersion !== CONTEXT_CACHE_SCHEMA_VERSION
    || typeof value.tenantId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.tenantId)
    || (value.projectScope !== null
      && (typeof value.projectScope !== 'string'
        || !/^project:[a-z0-9][a-z0-9._-]{0,127}$/.test(value.projectScope)))
    || typeof value.policyVersion !== 'string' || value.policyVersion.length === 0
    || value.policyVersion.length > 128
    || typeof value.embeddingGeneration !== 'string' || value.embeddingGeneration.length === 0
    || value.embeddingGeneration.length > 256
    || !validEpoch(value.knowledgeEpoch) || !isPlainRecord(value.readFrame)) return false;
  return value.readFrame.mode === 'current'
    || (value.readFrame.mode === 'historical' && typeof value.readFrame.asOf === 'string'
      && value.readFrame.asOf.length > 0);
}
function metadataEquals(left: ContextCacheMetadata, right: ContextCacheMetadata): boolean {
  return left.schemaVersion === right.schemaVersion && left.tenantId === right.tenantId
    && left.projectScope === right.projectScope && left.policyVersion === right.policyVersion
    && left.embeddingGeneration === right.embeddingGeneration
    && left.knowledgeEpoch === right.knowledgeEpoch && left.readFrame.mode === right.readFrame.mode
    && (left.readFrame.mode === 'current'
      || (right.readFrame.mode === 'historical' && left.readFrame.asOf === right.readFrame.asOf));
}
function parseEntry(raw: string): ContextCacheEntry | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainRecord(parsed) || !validMetadata(parsed.metadata) || !isPlainRecord(parsed.context)) return null;
    const context = parsed.context;
    if (typeof context.markdown !== 'string' || typeof context.tokens !== 'number'
      || !Number.isFinite(context.tokens) || !Array.isArray(context.sources)
      || !context.sources.every((source) => typeof source === 'string')
      || typeof context.assembled_at !== 'string') return null;
    return { metadata: parsed.metadata, context: context as unknown as MemoryContext };
  } catch { return null; }
}

const SET_IF_CURRENT_EPOCH = `
local current = redis.call('GET', KEYS[2])
if current == false then redis.call('SET', KEYS[2], ARGV[1])
elseif current ~= ARGV[1] then return 0 end
redis.call('SETEX', KEYS[1], ARGV[2], ARGV[3])
return 1`;
const ADVANCE_EPOCH = `
local current = redis.call('GET', KEYS[1])
if current ~= false and string.len(current) > string.len(ARGV[1]) then return 0 end
if current ~= false and string.len(current) == string.len(ARGV[1]) and current > ARGV[1] then return 0 end
if current == ARGV[1] then return 1 end
redis.call('SET', KEYS[1], ARGV[1])
return 1`;

export class ContextCache {
  readonly mode: RenderedContextCacheMode;
  constructor(private redis: Redis, options: ContextCacheOptions = {}) { this.mode = options.mode ?? 'disabled'; }

  /** Legacy/unversioned reads are deliberately cache misses. */
  async get(scopeHash: string, tenantId?: string): Promise<null>;
  async get(read: ContextCacheRead): Promise<MemoryContext | null>;
  async get(readOrScope: ContextCacheRead | string, _tenantId?: string): Promise<MemoryContext | null> {
    if (this.mode === 'disabled' || typeof readOrScope === 'string') return null;
    const tenant = resolveTenant(readOrScope.metadata.tenantId);
    if (tenant !== readOrScope.metadata.tenantId || !validMetadata(readOrScope.metadata)) return null;
    const [raw, fencedEpoch] = await Promise.all([
      this.redis.get(ctxKey(readOrScope.scopeHash, tenant)),
      this.redis.get(epochKey(readOrScope.metadata)),
    ]);
    if (!raw || fencedEpoch !== readOrScope.metadata.knowledgeEpoch) return null;
    const entry = parseEntry(raw);
    return entry && metadataEquals(entry.metadata, readOrScope.metadata) ? entry.context : null;
  }

  async set(write: ContextCacheWrite): Promise<boolean>;
  async set(scopeHash: string, context: MemoryContext, sourceNodeIds: string[], ttl?: number,
    scopeTags?: string[], tenantId?: string): Promise<void>;
  async set(writeOrScope: ContextCacheWrite | string, _context?: MemoryContext,
    _sourceNodeIds?: string[], _ttl?: number, _scopeTags?: string[], _tenantId?: string): Promise<boolean | void> {
    if (this.mode === 'disabled') return typeof writeOrScope === 'string' ? undefined : false;
    if (typeof writeOrScope === 'string') throw new Error('context_cache_version_metadata_required');
    const write = writeOrScope;
    if (!validMetadata(write.metadata) || resolveTenant(write.metadata.tenantId) !== write.metadata.tenantId) {
      throw new Error('context_cache_metadata_invalid');
    }
    const ttl = write.ttl ?? 300;
    if (!Number.isSafeInteger(ttl) || ttl < 1) throw new Error('context_cache_ttl_invalid');
    const tenant = write.metadata.tenantId;
    const key = ctxKey(write.scopeHash, tenant);
    const entry: ContextCacheEntry = { metadata: write.metadata, context: write.context };
    const stored = await this.redis.eval(SET_IF_CURRENT_EPOCH, 2, key, epochKey(write.metadata),
      write.metadata.knowledgeEpoch, String(ttl), JSON.stringify(entry));
    if (Number(stored) !== 1) return false;
    const pipeline = this.redis.pipeline();
    for (const nodeId of write.sourceNodeIds) {
      const dependencyKey = nodeDepsKey(nodeId, tenant);
      pipeline.sadd(dependencyKey, key).expire(dependencyKey, ttl * 2);
    }
    for (const scope of write.scopeTags ?? []) {
      const dependencyKey = scopeDepsKey(scope, tenant);
      pipeline.sadd(dependencyKey, key).expire(dependencyKey, ttl * 2);
    }
    await pipeline.exec();
    return true;
  }

  /** Mirrors an authoritative graph epoch and fences older in-flight writers. */
  async advanceKnowledgeEpoch(metadata: ContextCacheMetadata): Promise<boolean> {
    if (this.mode === 'disabled') return false;
    if (!validMetadata(metadata)) throw new Error('context_cache_metadata_invalid');
    const result = await this.redis.eval(ADVANCE_EPOCH, 1, epochKey(metadata), metadata.knowledgeEpoch);
    return Number(result) === 1;
  }

  async invalidateByScope(scope: string, tenantId?: string): Promise<number> {
    const depsKey = scopeDepsKey(scope, resolveTenant(tenantId));
    const cacheKeys = await this.redis.smembers(depsKey);
    if (cacheKeys.length === 0) return 0;
    const pipeline = this.redis.pipeline();
    for (const key of cacheKeys) pipeline.del(key);
    pipeline.del(depsKey);
    await pipeline.exec();
    return cacheKeys.length;
  }
  async invalidateByNodeId(nodeId: string, tenantId?: string): Promise<number> {
    const depsKey = nodeDepsKey(nodeId, resolveTenant(tenantId));
    const cacheKeys = await this.redis.smembers(depsKey);
    if (cacheKeys.length === 0) return 0;
    const pipeline = this.redis.pipeline();
    for (const key of cacheKeys) pipeline.del(key);
    pipeline.del(depsKey);
    await pipeline.exec();
    return cacheKeys.length;
  }
}
