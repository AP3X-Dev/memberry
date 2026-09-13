import { describe, expect, it } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { ArchEntityStore } from '../entity-store.js';
import { StructuralRelationStore } from '../relation-store.js';
import { AspectStore } from '../aspect-store.js';

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

describe('architecture visibility mutation authority', () => {
  it('commits entity properties and structural mutations with the tenant aggregate', async () => {
    const f = fixture();
    await new ArchEntityStore(f.driver).setArchProperties('synthetic', { responsibility: 'current' });
    const relations = new StructuralRelationStore(f.driver);
    await relations.create('from', 'to', 'USES');
    await relations.remove('from', 'to', 'USES');
    const aspects = new AspectStore(f.driver);
    await aspects.applyTo('aspect', 'entity');
    await aspects.removeFrom('aspect', 'entity');
    expect(f.committed).toEqual(Array.from({ length: 5 }, () => ['mutation', 'epoch']).flat());
    expect(f.epochs.every((p) => p.epochTenantId === 'default' && p.epochProjectScope === '_unscoped')).toBe(true);
    expect(f.autoCommitCalls()).toBe(0);
  });

  it('rolls back relationship invalidation when its epoch fails', async () => {
    const f = fixture(true);
    await expect(new StructuralRelationStore(f.driver).remove('from', 'to', 'USES')).rejects.toThrow('epoch unavailable');
    expect(f.committed).toEqual([]);
  });
});
