import { createHash } from 'crypto';
import type { Redis } from 'ioredis';

const DEFAULT_TTL = 86400;
const HASH = /^[a-f0-9]{64}$/;

/** Structural port: Redis does not import Core at runtime. */
export interface EmbeddingCacheAddress {
  schemaVersion: 2;
  tenantId: string;
  projectScope: string | null;
  descriptorFingerprint: string;
  contentHash: string;
  dimensions: number;
  normalization: 'none' | 'l2';
}

function validIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    !value.includes('*') &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || (code >= 127 && code <= 159);
    })
  );
}

function validateAddress(address: EmbeddingCacheAddress): void {
  if (
    !address ||
    address.schemaVersion !== 2 ||
    !validIdentity(address.tenantId) ||
    (address.projectScope !== null &&
      (!validIdentity(address.projectScope) || !/^project:[^\s*]+$/.test(address.projectScope))) ||
    typeof address.descriptorFingerprint !== 'string' ||
    !HASH.test(address.descriptorFingerprint) ||
    typeof address.contentHash !== 'string' ||
    !HASH.test(address.contentHash) ||
    !Number.isInteger(address.dimensions) ||
    address.dimensions < 1 ||
    address.dimensions > 65536 ||
    (address.normalization !== 'none' && address.normalization !== 'l2')
  ) {
    throw new Error('Invalid embedding cache address');
  }
}

function validVector(value: unknown, address: EmbeddingCacheAddress): value is number[] {
  if (!Array.isArray(value) || value.length !== address.dimensions) return false;
  let norm = 0;
  for (const component of value) {
    if (typeof component !== 'number' || !Number.isFinite(component)) return false;
    norm = Math.hypot(norm, component);
  }
  return address.normalization === 'none' || Math.abs(norm - 1) <= 1e-5;
}

function cacheKey(address: EmbeddingCacheAddress): string {
  const scope = createHash('sha256')
    .update(JSON.stringify([address.tenantId, address.projectScope]))
    .digest('hex');
  return `amp:emb:v2:${scope}:${address.descriptorFingerprint}:${address.contentHash}`;
}

export class EmbeddingCache {
  constructor(private redis: Redis) {}

  async get(address: EmbeddingCacheAddress | string): Promise<number[] | null> {
    // Legacy content-only callers cannot establish a qualified cache identity.
    if (typeof address === 'string') return null;
    validateAddress(address);
    const serialized = await this.redis.get(cacheKey(address));
    if (serialized === null) return null;
    try {
      const envelope: unknown = JSON.parse(serialized);
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return null;
      const entry = envelope as Record<string, unknown>;
      for (const field of [
        'schemaVersion',
        'tenantId',
        'projectScope',
        'descriptorFingerprint',
        'contentHash',
        'dimensions',
        'normalization',
      ] as const) {
        if (entry[field] !== address[field]) return null;
      }
      return validVector(entry.embedding, address) ? entry.embedding : null;
    } catch {
      return null;
    }
  }

  async set(
    address: EmbeddingCacheAddress | string,
    embedding: number[],
    ttl: number = DEFAULT_TTL,
  ): Promise<void> {
    if (typeof address === 'string') return;
    validateAddress(address);
    if (!validVector(embedding, address)) throw new Error('Invalid embedding cache vector');
    if (!Number.isSafeInteger(ttl) || ttl < 1) throw new Error('Invalid embedding cache TTL');
    // JSON retains JS double precision, including declared L2 normalization.
    await this.redis.setex(cacheKey(address), ttl, JSON.stringify({ ...address, embedding }));
  }
}
