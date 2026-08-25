// packages/core/src/__tests__/anti-entropy-engine.test.ts
//
// MEM-007 AntiEntropyEngine invariants (stateful fake ports, lifecycle-engine
// harness style):
//  - sub-flag disabled => the engine is not even constructible (MEM-006
//    behavior untouched by construction);
//  - artifact written (fsync path) BEFORE any repair; write failure aborts
//    with zero mutations; dry-run writes the plan and repairs nothing;
//  - every repair action lands in the final artifact (linked_ids,
//    consumers_removed);
//  - queue stall + publication drift are REPORT-only (no destructive call);
//  - tag ambiguity/conflict skips projects instead of guessing;
//  - a failing drift class logs-and-continues into `failures`.

import { describe, it, expect, vi } from 'vitest';
import { AntiEntropyEngine, type AntiEntropyEngineDeps } from '../anti-entropy.js';

function makeDeps() {
  const ops: string[] = [];
  const artifacts: Array<{ filePath: string; json: string }> = [];

  const graph = {
    listProjectRoots: vi.fn(async () => ['foo']),
    deriveProjectTag: vi.fn(async (_name: string) => 'project:foo'),
    linkOrphanEpisodics: vi.fn(async (name: string) => {
      ops.push(`link:${name}`);
      return { linked: 2, ids: ['ep-1', 'ep-2'] };
    }),
  };
  const streams = {
    groupHealth: vi.fn(async () => ({
      pelCount: 1,
      oldestIdleMs: 5000,
      consumers: [
        { name: 'dead-1', pending: 0, idleMs: 900_000_000 },
        { name: 'holder', pending: 1, idleMs: 900_000_000 },
      ],
    })),
    removeIdleConsumers: vi.fn(async () => {
      ops.push('gc');
      return ['dead-1'];
    }),
    bufferLength: vi.fn(async () => 4),
  };
  // Destructive members exist on the fake but NOT on the port type — spies
  // prove the report-only contract.
  const queue = {
    size: vi.fn(async () => 1),
    peek: vi.fn(async (_count: number) => [{ member: 'project:lab', score: 4 }]),
    popHighest: vi.fn(),
    remove: vi.fn(),
  };
  const extraction = { stats: vi.fn(async () => ({ pending: 0, inflight: 0, deadLettered: 2 })) };
  const kv = { mget: vi.fn(async (..._keys: string[]) => ['7', '5'] as (string | null)[]) };

  const deps: AntiEntropyEngineDeps = {
    graph,
    streams,
    queue,
    extraction,
    kv,
    config: { mode: 'live', consumerGcIdleMs: 1000 },
    lifecycle: { dryRun: false, batchRows: 500, exportDir: '/tmp/memberry-test' },
    now: () => new Date(Date.UTC(2026, 7, 25)),
    writeArtifact: vi.fn((filePath: string, json: string) => {
      ops.push('writeArtifact');
      artifacts.push({ filePath, json });
    }),
  };
  return { deps, ops, artifacts, graph, streams, queue, extraction, kv };
}

describe('AntiEntropyEngine construction gate', () => {
  it('cannot be constructed when the sub-flag is disabled (MEM-006 behavior untouched)', () => {
    const { deps } = makeDeps();
    expect(() => new AntiEntropyEngine({ ...deps, config: { mode: 'disabled', consumerGcIdleMs: 1000 } }))
      .toThrow(/not_live/);
  });
});

describe('AntiEntropyEngine.run — artifact ordering and audit trail', () => {
  it('writes the artifact before ANY repair and records every repair action in the final artifact', async () => {
    const { deps, ops, artifacts, graph, streams } = makeDeps();
    const result = await new AntiEntropyEngine(deps).run();

    // Ordering: first artifact write strictly precedes every repair.
    const firstWrite = ops.indexOf('writeArtifact');
    expect(firstWrite).toBeGreaterThanOrEqual(0);
    expect(firstWrite).toBeLessThan(ops.indexOf('link:foo'));
    expect(firstWrite).toBeLessThan(ops.indexOf('gc'));

    // Audit trail: the FINAL artifact carries the actual repair actions.
    const finalArtifact = JSON.parse(artifacts[artifacts.length - 1].json);
    expect(finalArtifact.graph_orphans.projects[0]).toMatchObject({
      project: 'foo',
      canon_tag: 'project:foo',
      task_tag: '[project:foo]',
      linked: 2,
      linked_ids: ['ep-1', 'ep-2'],
      skipped_reason: null,
    });
    expect(finalArtifact.signals.consumers_removed).toEqual(['dead-1']);
    expect(artifacts[0].filePath).toContain('anti-entropy');

    // Repairs used the configured bounds and the consolidation group.
    expect(graph.linkOrphanEpisodics).toHaveBeenCalledWith('foo', 'project:foo', 500);
    expect(streams.removeIdleConsumers).toHaveBeenCalledWith('consolidation', 1000);

    // Result mirrors the artifact.
    expect(result.dry_run).toBe(false);
    expect(result.graph_orphans.projects[0].linked_ids).toEqual(['ep-1', 'ep-2']);
    expect(result.signals).toMatchObject({ group: 'consolidation', pel_count: 1, consumers: 2, consumers_removed: ['dead-1'] });
    expect(result.extraction).toEqual({ pending: 0, inflight: 0, dead_lettered: 2 });
    expect(result.episodic_buffer).toEqual({ length: 4 });
    expect(result.failures).toEqual([]);
  });

  it('dry-run writes the plan artifact once and performs ZERO repairs', async () => {
    const { deps, artifacts, graph, streams } = makeDeps();
    const result = await new AntiEntropyEngine(deps).run({ dryRun: true });

    expect(result.dry_run).toBe(true);
    expect(artifacts).toHaveLength(1);
    expect(JSON.parse(artifacts[0].json).dry_run).toBe(true);
    expect(graph.linkOrphanEpisodics).not.toHaveBeenCalled();
    expect(streams.removeIdleConsumers).not.toHaveBeenCalled();
  });

  it('honors the config dry-run flag exactly like the option', async () => {
    const { deps, graph } = makeDeps();
    deps.lifecycle = { ...deps.lifecycle, dryRun: true };
    const result = await new AntiEntropyEngine(deps).run();
    expect(result.dry_run).toBe(true);
    expect(graph.linkOrphanEpisodics).not.toHaveBeenCalled();
  });

  it('an artifact-write failure aborts the pass with zero mutations', async () => {
    const { deps, graph, streams } = makeDeps();
    deps.writeArtifact = vi.fn(() => { throw new Error('disk full'); });
    await expect(new AntiEntropyEngine(deps).run()).rejects.toThrow('disk full');
    expect(graph.linkOrphanEpisodics).not.toHaveBeenCalled();
    expect(streams.removeIdleConsumers).not.toHaveBeenCalled();
  });
});

describe('AntiEntropyEngine.run — report-only drift classes', () => {
  it('reports the lingering consolidation-queue member without any destructive call', async () => {
    const { deps, queue } = makeDeps();
    const result = await new AntiEntropyEngine(deps).run();
    expect(result.queue).toEqual({ size: 1, top: [{ member: 'project:lab', score: 4 }] });
    expect(queue.popHighest).not.toHaveBeenCalled();
    expect(queue.remove).not.toHaveBeenCalled();
  });

  it('flags publication drift when dirty > published and reads the two version keys', async () => {
    const { deps, kv } = makeDeps();
    const result = await new AntiEntropyEngine(deps).run();
    expect(result.publication).toEqual({ dirty: 7, published: 5, drift: true });
    expect(kv.mget).toHaveBeenCalledWith(
      'memberry:wiki:generation:dirty',
      'memberry:wiki:generation:published',
    );
  });

  it('reports no drift when versions are equal', async () => {
    const { deps } = makeDeps();
    deps.kv = { mget: vi.fn(async () => ['7', '7'] as (string | null)[]) };
    const result = await new AntiEntropyEngine(deps).run();
    expect(result.publication).toEqual({ dirty: 7, published: 7, drift: false });
  });

  it('reports absent publication state as no_publication_state, never drift', async () => {
    const { deps } = makeDeps();
    deps.kv = { mget: vi.fn(async () => [null, null] as (string | null)[]) };
    const result = await new AntiEntropyEngine(deps).run();
    expect(result.publication).toEqual({ dirty: 0, published: 0, drift: false, note: 'no_publication_state' });
  });
});

describe('AntiEntropyEngine.run — tag derivation safety', () => {
  it('skips a project with an underivable tag (ambiguous_tag) instead of guessing', async () => {
    const { deps, graph } = makeDeps();
    graph.deriveProjectTag.mockResolvedValue(null);
    const result = await new AntiEntropyEngine(deps).run();
    expect(result.graph_orphans.projects[0]).toMatchObject({
      project: 'foo', canon_tag: null, linked: 0, skipped_reason: 'ambiguous_tag',
    });
    expect(graph.linkOrphanEpisodics).not.toHaveBeenCalled();
  });

  it('skips BOTH projects when two roots derive the same tag (tag_conflict)', async () => {
    const { deps, graph } = makeDeps();
    graph.listProjectRoots.mockResolvedValue(['foo', 'foo-legacy']);
    graph.deriveProjectTag.mockResolvedValue('project:foo');
    const result = await new AntiEntropyEngine(deps).run();
    expect(result.graph_orphans.projects.map((p) => p.skipped_reason)).toEqual(['tag_conflict', 'tag_conflict']);
    expect(graph.linkOrphanEpisodics).not.toHaveBeenCalled();
  });
});

describe('AntiEntropyEngine.run — per-class failure isolation', () => {
  it('a failing drift class lands in failures while the others still run', async () => {
    const { deps, streams } = makeDeps();
    deps.graph = {
      listProjectRoots: vi.fn(async () => { throw new Error('neo4j down'); }),
      deriveProjectTag: vi.fn(),
      linkOrphanEpisodics: vi.fn(),
    };
    const result = await new AntiEntropyEngine(deps).run();
    expect(result.failures).toEqual([{ class: 'graph_orphans', error: 'neo4j down' }]);
    expect(result.graph_orphans.projects).toEqual([]);
    // Other classes still reported and repaired.
    expect(result.signals.consumers_removed).toEqual(['dead-1']);
    expect(streams.removeIdleConsumers).toHaveBeenCalledOnce();
    expect(result.queue.size).toBe(1);
  });
});
