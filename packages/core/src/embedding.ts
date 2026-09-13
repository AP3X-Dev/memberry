// packages/core/src/embedding.ts
import OpenAI from 'openai';
import { EMBEDDING_DIM, type EmbeddingProvider, type EmbeddingRequest, type EmbeddingDescriptor } from './types.js';
import { parseEmbeddingDescriptor, parseEmbeddingRequest, validateEmbeddingVector } from './embedding-descriptor.js';

export function defaultEmbeddingDescriptor(): Readonly<EmbeddingDescriptor> {
  return parseEmbeddingDescriptor({ schemaVersion: 1, provider: 'openai', model: 'text-embedding-3-small',
    revision: 'unversioned-provider-alias', dimensions: EMBEDDING_DIM, normalization: 'l2', preprocessingVersion: 'utf8-raw-v1' });
}

export class OpenAIEmbedding implements EmbeddingProvider {
  private client: OpenAI;
  readonly descriptor: Readonly<EmbeddingDescriptor>;
  /** Real provider: semantic vector search is usable. */
  readonly available = true;

  constructor(apiKey: string, descriptor: EmbeddingDescriptor = defaultEmbeddingDescriptor()) {
    this.descriptor = parseEmbeddingDescriptor(descriptor);
    if (this.descriptor.provider !== 'openai') throw new Error('embedding_provider:unsupported');
    this.client = new OpenAI({ apiKey });
  }

  private decode(data: unknown, count: number): number[][] {
    if (!Array.isArray(data) || data.length === 0) throw new Error('OpenAI embeddings API returned empty data array');
    if (data.length !== count) throw new Error('embedding_batch:count');
    const result: number[][] = new Array(count);
    const seen = new Set<number>();
    for (const item of data) {
      if (!item || !Number.isInteger(item.index) || item.index < 0 || item.index >= count || seen.has(item.index)) {
        throw new Error('embedding_batch:index');
      }
      seen.add(item.index);
      result[item.index] = validateEmbeddingVector(item.embedding, this.descriptor);
    }
    return result;
  }

  async embed(text: string, request?: EmbeddingRequest): Promise<number[]> {
    if (request !== undefined) parseEmbeddingRequest(request);
    try {
      const response = await this.client.embeddings.create({ model: this.descriptor.model, input: text,
        dimensions: this.descriptor.dimensions, encoding_format: 'float' });
      return this.decode(response.data, 1)[0];
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`OpenAI embedding request failed: ${message}`);
    }
  }

  async embedBatch(texts: string[], request?: EmbeddingRequest): Promise<number[][]> {
    if (request !== undefined) parseEmbeddingRequest(request);
    if (texts.length === 0) return [];
    try {
      const response = await this.client.embeddings.create({ model: this.descriptor.model, input: texts,
        dimensions: this.descriptor.dimensions, encoding_format: 'float' });
      return this.decode(response.data, texts.length);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`OpenAI embedBatch request failed: ${message}`);
    }
  }
}
