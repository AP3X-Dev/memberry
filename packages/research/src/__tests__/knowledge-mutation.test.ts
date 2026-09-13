import { describe, expect, it } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { CampaignStore } from '../campaign.js';
import { ExperimentStore } from '../experiment.js';

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

describe('research visibility mutation authority', () => {
  it('commits campaign changes and experiment links with tenant aggregate epochs', async () => {
    const f = fixture();
    await new CampaignStore(f.driver).setStatus('campaign', 'paused');
    await new ExperimentStore(f.driver).linkToParent('experiment', 'parent');
    expect(f.committed).toEqual(['mutation', 'epoch', 'mutation', 'epoch']);
    expect(f.epochs.every((p) => p.epochTenantId === 'default' && p.epochProjectScope === '_unscoped')).toBe(true);
    expect(f.autoCommitCalls()).toBe(0);
  });

  it('rolls back campaign visibility mutation when authority is unavailable', async () => {
    const f = fixture(true);
    await expect(new CampaignStore(f.driver).setStatus('campaign', 'paused')).rejects.toThrow('epoch unavailable');
    expect(f.committed).toEqual([]);
  });

  it('rejects tenant reassignment through the stats update shape', async () => {
    const f = fixture();
    await expect(new CampaignStore(f.driver).updateStats('campaign', { tenant_id: 'foreign' } as never))
      .rejects.toThrow('Invalid property key');
    expect(f.committed).toEqual([]);
  });
});
