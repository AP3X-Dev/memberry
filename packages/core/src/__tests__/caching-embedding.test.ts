import { describe, it, expect, vi } from 'vitest';
import { CachingEmbeddingProvider, type EmbeddingCachePort } from '../caching-embedding.js';
import type { EmbeddingProvider, EmbeddingDescriptor, EmbeddingCacheAddress } from '../types.js';
const scope = { tenantId: 'tenant-a', projectScope: 'project:a' };
const descriptor: EmbeddingDescriptor = { schemaVersion:1,provider:'fixture',model:'a',revision:'r1',dimensions:2,normalization:'none',preprocessingVersion:'raw-v1' };
function fixture(d: EmbeddingDescriptor = descriptor) {
  const values = new Map<string, number[]>();
  const get = vi.fn(async (a: EmbeddingCacheAddress) => values.get(JSON.stringify(a)) ?? null);
  const set = vi.fn(async (a: EmbeddingCacheAddress,v:number[]) => { values.set(JSON.stringify(a),v); });
  const cache: EmbeddingCachePort = {get,set};
  const embed = vi.fn(async (t:string) => [t.length,1]);
  const embedBatch = vi.fn(async (ts:string[]) => ts.map(t => [t.length,1]));
  const inner: EmbeddingProvider = {descriptor:d,available:true,embed,embedBatch};
  return { values,get,set,cache,inner,embed,embedBatch,provider:new CachingEmbeddingProvider(inner,cache) };
}
describe('scoped descriptor-qualified embedding cache', () => {
  it('serves a repeated scoped call from cache', async () => {
    const f=fixture();
    expect(await f.provider.embed('hello',scope)).toEqual(await f.provider.embed('hello',scope));
    expect(f.embed).toHaveBeenCalledTimes(1); expect(f.set).toHaveBeenCalledTimes(1);
  });
  it('preserves mixed hit/miss and duplicate input order',async()=>{
    const f=fixture(); await f.provider.embed('a',scope);
    expect(await f.provider.embedBatch(['bb','a','ccc','bb'],scope)).toEqual([[2,1],[1,1],[3,1],[2,1]]);
    expect(f.embedBatch).toHaveBeenCalledWith(['bb','ccc','bb'],scope);
    f.embedBatch.mockClear();
    await f.provider.embedBatch(['a','bb'],scope); expect(f.embedBatch).not.toHaveBeenCalled();
  });
  it('isolates tenants, projects, explicit unscoped calls and descriptor identities',async()=>{
    const f=fixture(); await f.provider.embed('same',scope);
    await f.provider.embed('same',{...scope,tenantId:'b'});
    await f.provider.embed('same',{...scope,projectScope:'project:b'});
    await f.provider.embed('same',{...scope,projectScope:null});
    for(const change of [{model:'b'},{revision:'r2'},{preprocessingVersion:'raw-v2'}]){
      const p=new CachingEmbeddingProvider({...f.inner,descriptor:{...descriptor,...change}},f.cache);
      await p.embed('same',scope);
    }
    expect(f.set).toHaveBeenCalledTimes(7); expect(f.values.size).toBe(7);
  });
  it('bypasses cache when scope or provider descriptor is absent',async()=>{
    const f=fixture(); await f.provider.embed('x'); await f.provider.embedBatch(['x']);
    const legacy=new CachingEmbeddingProvider({embed:f.embed,embedBatch:f.embedBatch},f.cache);
    await legacy.embed('x',scope); await legacy.embedBatch(['x'],scope);
    expect(f.get).not.toHaveBeenCalled(); expect(f.set).not.toHaveBeenCalled();
  });
  it('preserves disabled-provider behavior without caching fake vectors',async()=>{
    const f=fixture();const p=new CachingEmbeddingProvider({...f.inner,available:false},f.cache);
    expect(p.available).toBe(false); await p.embed('x',scope); await p.embedBatch(['x'],scope);
    expect(f.get).not.toHaveBeenCalled();expect(f.set).not.toHaveBeenCalled();
  });
  it('validates explicit request even for empty batches and bypass providers',async()=>{
    const f=fixture();
    await expect(f.provider.embedBatch([],{tenantId:'*',projectScope:null})).rejects.toThrow();
    expect(await f.provider.embedBatch([],scope)).toEqual([]);
    expect(f.get).not.toHaveBeenCalled();expect(f.embedBatch).not.toHaveBeenCalled();
  });
  it('rejects mutable inner provider identity',async()=>{
    const f=fixture(); Object.defineProperty(f.inner,'descriptor',{value:{...descriptor,model:'changed'}});
    await expect(f.provider.embed('x',scope)).rejects.toThrow('provider_changed');
    expect(f.get).not.toHaveBeenCalled();
  });
  it('treats corrupt hits as misses and tolerates cache outages',async()=>{
    const f=fixture();f.get.mockResolvedValueOnce([NaN,0]);
    expect(await f.provider.embed('x',scope)).toEqual([1,1]);
    f.get.mockRejectedValueOnce(new Error('untrusted text'));
    f.set.mockRejectedValueOnce(new Error('untrusted text'));
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    try{expect(await f.provider.embed('secret input',scope)).toEqual([12,1]);expect(JSON.stringify(log.mock.calls)).not.toContain('untrusted');expect(JSON.stringify(log.mock.calls)).not.toContain('secret input');}finally{log.mockRestore();}
  });
  it.each([[[1,0]],[[1,0],[NaN,0]],[[1,0],[1]],[[1,0],[1,0],[1,0]]])('publishes no partial malformed batch %#',async vectors=>{
    const f=fixture();f.embedBatch.mockResolvedValueOnce(vectors);
    await expect(f.provider.embedBatch(['a','b'],scope)).rejects.toThrow();expect(f.set).not.toHaveBeenCalled();
  });
  it('validates fetched output even when cache is bypassed',async()=>{
    const f=fixture();f.embed.mockResolvedValueOnce([Infinity,0]);
    await expect(f.provider.embed('x')).rejects.toThrow('nonfinite');
    expect(f.set).not.toHaveBeenCalled();
  });
});
