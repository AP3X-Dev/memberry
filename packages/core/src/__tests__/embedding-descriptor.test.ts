import { describe, it, expect } from 'vitest';
import { parseEmbeddingDescriptor, embeddingDescriptorFingerprint, serializeEmbeddingDescriptor,
  parseEmbeddingRequest, validateEmbeddingVector, validateEmbeddingBatch, embeddingCacheAddress,
  type EmbeddingDescriptor } from '../embedding-descriptor.js';
const descriptor: EmbeddingDescriptor = { schemaVersion: 1, provider: 'fixture', model: 'model-a', revision: 'r1', dimensions: 2, normalization: 'none', preprocessingVersion: 'raw-v1' };
describe('embedding descriptor contract', () => {
  it('canonicalizes field order and freezes a defensive identity copy', () => {
    const copy = parseEmbeddingDescriptor({ ...descriptor });
    expect(Object.isFrozen(copy)).toBe(true);
    expect(copy).not.toBe(descriptor);
    expect(serializeEmbeddingDescriptor(Object.fromEntries(Object.entries(descriptor).reverse()) as unknown as EmbeddingDescriptor)).toBe(serializeEmbeddingDescriptor(descriptor));
    expect(embeddingDescriptorFingerprint(copy)).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each(['provider','model','revision','dimensions','normalization','preprocessingVersion'] as const)('binds %s to the full fingerprint', key => {
    const next = { ...descriptor, [key]: key === 'dimensions' ? 3 : key === 'normalization' ? 'l2' : 'different' };
    expect(embeddingDescriptorFingerprint(next)).not.toBe(embeddingDescriptorFingerprint(descriptor));
  });
  it.each([null, {}, { ...descriptor, extra: true }, { ...descriptor, schemaVersion: 2 }, { ...descriptor, model: '' }, { ...descriptor, dimensions: 0 }, { ...descriptor, dimensions: 2.5 }, { ...descriptor, dimensions: 65537 }, { ...descriptor, normalization: 'auto' }])('rejects malformed descriptor %#', value => {
    expect(() => parseEmbeddingDescriptor(value)).toThrow();
  });
  it.each([{}, null, { tenantId: 'a' }, { tenantId: '*', projectScope: null }, { tenantId: 'a', projectScope: '*' }, { tenantId: 'a', projectScope: 'project:' }, { tenantId: 'a', projectScope: 'project:a b' }, { tenantId: ' a', projectScope: null }, {tenantId:'a',projectScope:null,extra:1}])('rejects malformed explicit request %#', value => {
    expect(() => parseEmbeddingRequest(value)).toThrow();
  });
  it('separates tenant, project, descriptor and complete content', () => {
    const a = embeddingCacheAddress('hello', descriptor, { tenantId: 'a', projectScope: 'project:p' });
    const b = embeddingCacheAddress('hello', descriptor, { tenantId: 'b', projectScope: 'project:p' });
    expect(a.tenantId).not.toBe(b.tenantId);
    expect(a.contentHash).toHaveLength(64);
    expect(embeddingCacheAddress('hello!', descriptor, { tenantId:'a', projectScope:null }).contentHash).not.toBe(a.contentHash);
  });
  it('rejects sparse, nonfinite, malformed and misnormalized vectors', () => {
    for (const v of [[1], [1,NaN], [Infinity,0], ['1',0], new Array(2)]) expect(() => validateEmbeddingVector(v, descriptor)).toThrow();
    const l2 = { ...descriptor, normalization: 'l2' as const };
    expect(() => validateEmbeddingVector([0,0], l2)).toThrow('normalization');
    expect(() => validateEmbeddingVector([1.01,0], l2)).toThrow('normalization');
    expect(validateEmbeddingVector(Array.from(new Float32Array([Math.SQRT1_2,Math.SQRT1_2])), l2)).toHaveLength(2);
    expect(() => validateEmbeddingBatch([[1,0]],2,descriptor)).toThrow('count');
  });
});
