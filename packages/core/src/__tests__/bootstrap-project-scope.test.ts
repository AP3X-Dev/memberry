import { describe, expect, it, vi } from 'vitest';
import { BootstrapGraphService, type BootstrapInput } from '@memberry/core';

function input(overrides: Partial<BootstrapInput> = {}): BootstrapInput {
  return {
    project_name: 'DealerBot3.0',
    project_tag: 'project:dealerbot',
    description: 'DealerBot project',
    domain: 'agent-memory',
    entities: [],
    semantic_seeds: [],
    agents: [],
    ...overrides,
  };
}

function record(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] };
}

describe('BootstrapGraphService project authority mapping', () => {
  it('persists the declared canonical project scope while promoting the display-name Entity', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ records: [record({
        id: 'ent-YOX6g9puSeht',
        isNew: false,
        storedProjectScope: 'project:dealerbot',
      })] })
      .mockResolvedValueOnce({ records: [record({ linked: 0 })] });
    const close = vi.fn().mockResolvedValue(undefined);
    const driver = { session: () => ({ run, close }) } as never;

    await expect(new BootstrapGraphService(driver).bootstrap(input())).resolves.toMatchObject({
      project_entity_id: 'ent-YOX6g9puSeht',
      entities_existing: 1,
    });

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]![0]).toContain('e.project_scope = $projectScope');
    expect(run.mock.calls[0]![1]).toMatchObject({
      name: 'DealerBot3.0',
      type: 'project',
      projectScope: 'project:dealerbot',
    });
    expect(run.mock.calls[1]![1]).toMatchObject({ canonTag: 'project:dealerbot' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed project tags before touching Neo4j', async () => {
    const session = vi.fn();
    const driver = { session } as never;

    await expect(new BootstrapGraphService(driver).bootstrap(input({
      project_tag: 'project:dealerbot/foreign',
    }))).rejects.toThrow('bootstrap: project_tag must be a canonical project scope');
    expect(session).not.toHaveBeenCalled();
  });

  it('rejects an oversized canonical-looking project tag before touching Neo4j', async () => {
    const session = vi.fn();
    const driver = { session } as never;

    await expect(new BootstrapGraphService(driver).bootstrap(input({
      project_tag: `project:${'a'.repeat(129)}`,
    }))).rejects.toThrow('bootstrap: project_tag must be a canonical project scope');
    expect(session).not.toHaveBeenCalled();
  });

  it('fails closed instead of overwriting an existing canonical project scope', async () => {
    const run = vi.fn().mockResolvedValueOnce({ records: [record({
      id: 'ent-YOX6g9puSeht',
      isNew: false,
      storedProjectScope: 'project:other',
    })] });
    const close = vi.fn().mockResolvedValue(undefined);
    const driver = { session: () => ({ run, close }) } as never;

    await expect(new BootstrapGraphService(driver).bootstrap(input()))
      .rejects.toThrow('bootstrap: project scope conflicts with existing project authority');
    expect(run).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
