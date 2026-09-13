import { createHash } from 'node:crypto';

export interface EmbeddingDescriptor {
  readonly schemaVersion: 1;
  readonly provider: string;
  readonly model: string;
  /** Explicit operator/provider revision. An alias is not a pinned provider revision. */
  readonly revision: string;
  readonly dimensions: number;
  readonly normalization: 'none' | 'l2';
  readonly preprocessingVersion: string;
}

export interface EmbeddingRequest {
  readonly tenantId: string;
  readonly projectScope: string | null;
}

/** Structural port; Redis validates the same primitive identity without importing Core. */
export interface EmbeddingCacheAddress extends EmbeddingRequest {
  readonly schemaVersion: 2;
  readonly descriptorFingerprint: string;
  readonly contentHash: string;
  readonly dimensions: number;
  readonly normalization: 'none' | 'l2';
}

export const EMBEDDING_NORMALIZATION_TOLERANCE = 1e-5;
const descriptorFields = ['schemaVersion', 'provider', 'model', 'revision', 'dimensions', 'normalization', 'preprocessingVersion'];
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('embedding_descriptor:invalid_object');
  return value as Record<string, unknown>;
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}
export function parseEmbeddingDescriptor(value: unknown): Readonly<EmbeddingDescriptor> {
  const d = record(value);
  if (Object.keys(d).length !== descriptorFields.length || descriptorFields.some((key) => !Object.hasOwn(d, key))
    || d.schemaVersion !== 1 || !text(d.provider) || !text(d.model) || !text(d.revision)
    || !text(d.preprocessingVersion) || !Number.isInteger(d.dimensions) || (d.dimensions as number) < 1
    || (d.dimensions as number) > 65536 || (d.normalization !== 'none' && d.normalization !== 'l2')) {
    throw new Error('embedding_descriptor:invalid');
  }
  return Object.freeze({ schemaVersion: 1, provider: d.provider, model: d.model, revision: d.revision,
    dimensions: d.dimensions as number, normalization: d.normalization, preprocessingVersion: d.preprocessingVersion });
}
export function serializeEmbeddingDescriptor(value: EmbeddingDescriptor): string {
  return JSON.stringify(parseEmbeddingDescriptor(value));
}
export function embeddingDescriptorFingerprint(value: EmbeddingDescriptor): string {
  return createHash('sha256').update(serializeEmbeddingDescriptor(value), 'utf8').digest('hex');
}
export function parseEmbeddingRequest(value: unknown): Readonly<EmbeddingRequest> {
  const r = record(value);
  if (Object.keys(r).length !== 2 || !Object.hasOwn(r, 'tenantId') || !Object.hasOwn(r, 'projectScope')
    || !text(r.tenantId) || /\*/.test(r.tenantId)
    || (r.projectScope !== null && (!text(r.projectScope) || !/^project:[^\s*]+$/.test(r.projectScope)))) {
    throw new Error('embedding_scope:invalid');
  }
  return Object.freeze({ tenantId: r.tenantId, projectScope: r.projectScope as string | null });
}
export function validateEmbeddingVector(value: unknown, descriptor: Pick<EmbeddingDescriptor, 'dimensions' | 'normalization'>): number[] {
  if (!Array.isArray(value) || value.length !== descriptor.dimensions) throw new Error('embedding_vector:dimensions');
  let squared = 0;
  for (let i = 0; i < value.length; i++) {
    const n: unknown = value[i];
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error('embedding_vector:nonfinite');
    squared += n * n;
  }
  if (descriptor.normalization === 'l2' && Math.abs(Math.sqrt(squared) - 1) > EMBEDDING_NORMALIZATION_TOLERANCE) {
    throw new Error('embedding_vector:normalization');
  }
  return value.slice() as number[];
}
export function validateEmbeddingBatch(value: unknown, count: number, descriptor: EmbeddingDescriptor): number[][] {
  if (!Array.isArray(value) || value.length !== count) throw new Error('embedding_batch:count');
  return Array.from({ length: count }, (_, i) => validateEmbeddingVector(value[i], descriptor));
}
export function embeddingCacheAddress(content: string, descriptor: EmbeddingDescriptor, request: EmbeddingRequest): EmbeddingCacheAddress {
  const scope = parseEmbeddingRequest(request);
  const d = parseEmbeddingDescriptor(descriptor);
  return Object.freeze({ schemaVersion: 2, ...scope, descriptorFingerprint: embeddingDescriptorFingerprint(d),
    contentHash: createHash('sha256').update(content, 'utf8').digest('hex'), dimensions: d.dimensions, normalization: d.normalization });
}
