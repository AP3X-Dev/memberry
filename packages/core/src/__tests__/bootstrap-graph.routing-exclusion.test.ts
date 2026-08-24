import { describe, expect, it, vi } from 'vitest';
import type { Driver } from 'neo4j-driver';

import { BootstrapGraphService } from '../bootstrap-graph.js';

describe('BootstrapGraphService routing sidecar isolation (MEM-003)', () => {
  it('appends the RECOMMENDS_FOR exclusion while keeping the pinned OBSERVES literal byte-intact', async () => {
    const values: Record<string, unknown> = {
      bootstrapped: true,
      entityCount: 2,
      agentCount: 3,
      semCount: 5,
      epCount: 7,
      relCount: 11,
    };
    const run = vi.fn(async (_query: string, _params?: Record<string, unknown>) => ({
      records: [{ get: (key: string) => values[key] }],
    }));
    const driver = {
      session: vi.fn(() => ({ run, close: vi.fn(async () => undefined) })),
    } as unknown as Driver;

    await expect(new BootstrapGraphService(driver).status('memberry')).resolves.toEqual({
      bootstrapped: true,
      entities: 2,
      agents: 3,
      semantics: 5,
      episodics: 7,
      relationships: 11,
    });
    expect(run).toHaveBeenCalledOnce();
    const query = run.mock.calls[0]![0] as string;
    expect(query).toContain("WHERE type(r) <> 'OBSERVES'");
    expect(query).toContain("AND type(r) <> 'RECOMMENDS_FOR'");
    expect(query).toContain("WHERE type(r) <> 'OBSERVES' AND type(r) <> 'RECOMMENDS_FOR'");
  });
});
