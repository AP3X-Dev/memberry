import { describe, expect, it } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { SymbolStore } from '../symbol-store.js';
import { ImportResolver } from '../resolver.js';

function fixture(failEpoch = false) {
  const committed: string[] = [];
  const epochs: Array<Record<string, unknown>> = [];
  let autoCommitCalls = 0;
  const session = {
    run: async () => { autoCommitCalls++; throw new Error('unexpected autocommit'); },
    close: async () => {},
    executeWrite: async (work: (tx: unknown) => Promise<unknown>) => {
      const pending: string[] = [];
      const result = await work({ run: async (query: string, parameters: Record<string, unknown>) => {
        if (query.includes('AS knowledgeEpoch')) {
          epochs.push(parameters);
          if (failEpoch) throw new Error('epoch unavailable');
          pending.push('epoch');
          return { records: [{ get: () => '1' }] };
        }
        pending.push('mutation');
        return { records: [{ get: () => 1 }] };
      } });
      committed.push(...pending);
      return result;
    },
  };
  return {
    driver: { session: () => session } as unknown as Driver,
    committed, epochs, autoCommitCalls: () => autoCommitCalls,
  };
}

describe('code visibility mutation authority', () => {
  it('commits Symbol update and deletion with the default tenant aggregate', async () => {
    const f = fixture();
    const store = new SymbolStore(f.driver);
    await store.update('symbol-1', { signature: 'updated()' });
    await store.delete('symbol-1');
    await store.deleteByFile('/synthetic/file.ts');
    expect(f.committed).toEqual(['mutation', 'epoch', 'mutation', 'epoch', 'mutation', 'epoch']);
    expect(f.epochs).toHaveLength(3);
    expect(f.epochs.every((p) => p.epochTenantId === 'default' && p.epochProjectScope === '_unscoped')).toBe(true);
    expect(f.autoCommitCalls()).toBe(0);
  });

  it('rolls back a symbol mutation when its epoch cannot advance', async () => {
    const f = fixture(true);
    await expect(new SymbolStore(f.driver).delete('symbol-1')).rejects.toThrow('epoch unavailable');
    expect(f.committed).toEqual([]);
    expect(f.autoCommitCalls()).toBe(0);
  });

  it('commits graph expansion links and their epoch in the same transaction', async () => {
    const f = fixture();
    const resolver = new ImportResolver(f.driver);
    await resolver.linkSymbolsToEntity('/synthetic/file.ts');
    await resolver.linkAllSymbolsToEntities();
    expect(f.committed).toEqual(['mutation', 'epoch', 'mutation', 'epoch']);
    expect(f.autoCommitCalls()).toBe(0);
  });
});
