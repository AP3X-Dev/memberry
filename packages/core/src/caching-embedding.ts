import type { EmbeddingProvider, EmbeddingRequest, EmbeddingDescriptor, EmbeddingCacheAddress } from './types.js';
import { embeddingCacheAddress, parseEmbeddingDescriptor, parseEmbeddingRequest, validateEmbeddingVector,
  validateEmbeddingBatch, embeddingDescriptorFingerprint } from './embedding-descriptor.js';

export interface EmbeddingCachePort {
  get(address: EmbeddingCacheAddress): Promise<number[] | null>;
  set(address: EmbeddingCacheAddress, embedding: number[], ttl?: number): Promise<void>;
}

/** Cache identity is explicit; omitted scope/descriptor always takes the uncached path. */
export class CachingEmbeddingProvider implements EmbeddingProvider {
  readonly available?: boolean;
  readonly descriptor?: Readonly<EmbeddingDescriptor>;
  private readonly descriptorHash?: string;
  constructor(private readonly inner: EmbeddingProvider, private readonly cache: EmbeddingCachePort) {
    this.available = inner.available;
    this.descriptor = inner.descriptor === undefined ? undefined : parseEmbeddingDescriptor(inner.descriptor);
    this.descriptorHash = this.descriptor && embeddingDescriptorFingerprint(this.descriptor);
  }
  private scope(request?: EmbeddingRequest): EmbeddingRequest | undefined {
    const parsed = request === undefined ? undefined : parseEmbeddingRequest(request);
    if (this.descriptorHash !== undefined && (this.inner.descriptor === undefined
      || embeddingDescriptorFingerprint(this.inner.descriptor) !== this.descriptorHash)) {
      throw new Error('embedding_descriptor:provider_changed');
    }
    return parsed;
  }
  private async read(address: EmbeddingCacheAddress): Promise<number[] | null> {
    try {
      const value = await this.cache.get(address);
      return value === null ? null : validateEmbeddingVector(value, address);
    } catch {
      console.error('[caching-embedding] cache read unavailable or invalid; bypassing');
      return null;
    }
  }
  private async write(address: EmbeddingCacheAddress, vector: number[]): Promise<void> {
    try { await this.cache.set(address, vector); }
    catch { console.error('[caching-embedding] cache write unavailable; result not cached'); }
  }
  async embed(text: string, request?: EmbeddingRequest): Promise<number[]> {
    const scope = this.scope(request);
    const address = scope && this.descriptor && this.available !== false
      ? embeddingCacheAddress(text, this.descriptor, scope) : undefined;
    if (address) {
      const hit = await this.read(address);
      if (hit !== null) return hit;
    }
    const fetched = scope ? await this.inner.embed(text, scope) : await this.inner.embed(text);
    const vector = this.descriptor && this.available !== false ? validateEmbeddingVector(fetched, this.descriptor) : fetched;
    if (address) await this.write(address, vector);
    return vector;
  }
  async embedBatch(texts: string[], request?: EmbeddingRequest): Promise<number[][]> {
    const scope = this.scope(request);
    if (texts.length === 0) return [];
    if (!scope || !this.descriptor || this.available === false) {
      const fetched = scope ? await this.inner.embedBatch(texts, scope) : await this.inner.embedBatch(texts);
      return this.descriptor && this.available !== false ? validateEmbeddingBatch(fetched, texts.length, this.descriptor) : fetched;
    }
    const addresses = texts.map((text) => embeddingCacheAddress(text, this.descriptor!, scope));
    const result: number[][] = new Array(texts.length);
    const misses: number[] = [];
    for (let i = 0; i < texts.length; i++) {
      const hit = await this.read(addresses[i]);
      if (hit === null) misses.push(i); else result[i] = hit;
    }
    if (misses.length) {
      const fetched = validateEmbeddingBatch(await this.inner.embedBatch(misses.map((i) => texts[i]), scope), misses.length, this.descriptor);
      // Validate the whole batch before publishing any member.
      for (let j = 0; j < misses.length; j++) {
        const i = misses[j];
        result[i] = fetched[j];
        await this.write(addresses[i], fetched[j]);
      }
    }
    return result;
  }
}
