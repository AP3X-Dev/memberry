import {describe,it,expect,vi} from 'vitest';
vi.mock('openai',()=>({default:class{embeddings={create:vi.fn()};}}));
import {OpenAIEmbedding} from '../embedding.js';
const descriptor={schemaVersion:1 as const,provider:'openai',model:'text-embedding-3-small',revision:'fixture',dimensions:2,normalization:'none' as const,preprocessingVersion:'utf8-raw-v1'};
function fixture(){const p=new OpenAIEmbedding('fake',descriptor);const create=(p as unknown as {client:{embeddings:{create:ReturnType<typeof vi.fn>}}}).client.embeddings.create;return {p,create};}
describe('provider embedding descriptor contract',()=>{
  it('sends configured model/dimensions and reorders response indices',async()=>{
    const {p,create}=fixture();create.mockResolvedValue({data:[{index:1,embedding:[0,1]},{index:0,embedding:[1,0]}]});
    expect(await p.embedBatch(['a','b'])).toEqual([[1,0],[0,1]]);
    expect(create).toHaveBeenCalledWith({model:descriptor.model,dimensions:2,encoding_format:'float',input:['a','b']});
  });
  it.each([
    [{index:0,embedding:[1,0]}],
    [{index:0,embedding:[1,0]},{index:0,embedding:[0,1]}],
    [{index:0,embedding:[1,0]},{index:2,embedding:[0,1]}],
    [{index:0,embedding:[1,0]},{index:0.5,embedding:[0,1]}],
    [{index:0,embedding:[1,0]},{index:1,embedding:[NaN,0]}],
    [{index:0,embedding:[1,0]},{index:1,embedding:[0]}],
  ])('rejects malformed response %#',async(...rows)=>{const{p,create}=fixture();create.mockResolvedValue({data:rows});await expect(p.embedBatch(['a','b'])).rejects.toThrow();});
  it('validates the single response index and dimensions',async()=>{const{p,create}=fixture();create.mockResolvedValue({data:[{index:1,embedding:[1,0]}]});await expect(p.embed('a')).rejects.toThrow('index');});
  it('makes no provider request for empty batches and validates scope first',async()=>{const{p,create}=fixture();expect(await p.embedBatch([])).toEqual([]);await expect(p.embedBatch([],{tenantId:'*',projectScope:null})).rejects.toThrow();expect(create).not.toHaveBeenCalled();});
});
