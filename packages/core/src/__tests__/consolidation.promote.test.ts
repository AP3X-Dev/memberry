// packages/core/src/__tests__/consolidation.promote.test.ts
//
// Covers the episodic->semantic promote path, which was unreachable: the engine
// only ever generated proposals from Redis signal clusters, so a graph could
// accumulate any number of episodes and never grow a single Semantic node.
import { describe, it, expect, vi } from 'vitest';
import { ConsolidationEngine, clusterByEmbedding } from '../consolidation.js';
import type { AMPConfig, EpisodicNode } from '../types.js';

// ─── fixtures ────────────────────────────────────────────────────────────────

/** Unit vector in the plane, `deg` degrees off the x-axis — cosine(a,b) is the
 *  cosine of the angle between them, so similarity is exactly controllable. */
function vecAt(deg: number): number[] {
  const rad = (deg * Math.PI) / 180;
  return [Math.cos(rad), Math.sin(rad)];
}

function ep(id: string, embedding: number[], overrides: Partial<EpisodicNode> = {}): EpisodicNode {
  return {
    id,
    session_id: 'sess-1',
    agent_id: 'agent-1',
    task: `task ${id}`,
    content: `content ${id}`,
    created_at: '2026-08-12T00:00:00.000Z',
    embedding,
    scope: 'project:test',
    tags: ['project:test'],
    ...overrides,
  };
}

const CONFIG: AMPConfig = {
  redis: { url: 'redis://localhost:6379' },
  neo4j: { uri: 'bolt://localhost:7687', user: 'neo4j', password: '' },
  embedding: { provider: 'openai', apiKey: 'test-key' },
  cache: { defaultTTL: 300, contextTTL: 300, embeddingTTL: 86400 },
  consolidation: {
    autoApply: false,
    signalThreshold: 3,
    promote: { minClusterSize: 3, similarityThreshold: 0.9, maxPerRun: 3, maxCandidates: 200 },
  },
  exportPath: '/tmp',
};

/** Redis layer with no signals and no queue entries — isolates the promote path. */
function emptyRedis() {
  return {
    lock: { acquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
    signals: { consume: vi.fn().mockResolvedValue([]) },
    queue: { popHighest: vi.fn().mockResolvedValue(null) },
    proposals: {
      save: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      listPending: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    cache: { invalidateByNodeId: vi.fn().mockResolvedValue(0) },
  };
}

function llmReturning(payload: unknown) {
  return {
    available: true as const,
    modelFor: () => 'gpt-4o',
    chat: vi.fn().mockResolvedValue(JSON.stringify(payload)),
  };
}

// ─── clusterByEmbedding ──────────────────────────────────────────────────────

describe('clusterByEmbedding', () => {
  it('groups similar episodes and drops clusters below minSize', () => {
    const episodes = [
      ep('a', vecAt(0)),
      ep('b', vecAt(5)),
      ep('c', vecAt(10)),
      ep('lonely', vecAt(90)), // orthogonal — its own cluster of 1
    ];

    const clusters = clusterByEmbedding(episodes, 0.9, 3);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.map((e) => e.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('ignores episodes with no embedding rather than clustering them together', () => {
    const episodes = [
      ep('a', vecAt(0)),
      ep('b', vecAt(2)),
      ep('no-vec-1', []),
      ep('no-vec-2', []),
      ep('no-vec-3', []),
    ];

    expect(clusterByEmbedding(episodes, 0.9, 3)).toHaveLength(0);
  });

  it('returns nothing when every episode is dissimilar', () => {
    const episodes = [ep('a', vecAt(0)), ep('b', vecAt(60)), ep('c', vecAt(120))];
    expect(clusterByEmbedding(episodes, 0.9, 2)).toHaveLength(0);
  });
});

// ─── promote proposals ───────────────────────────────────────────────────────

describe('ConsolidationEngine promote path', () => {
  const promotable = [ep('e1', vecAt(0)), ep('e2', vecAt(3)), ep('e3', vecAt(6))];

  function neo4jWith(findPromotable: unknown) {
    return {
      semantic: {
        getById: vi.fn().mockResolvedValue(null),
        getByIds: vi.fn().mockResolvedValue([]),
        updateConfidence: vi.fn(),
        supersede: vi.fn(),
        promoteFromEpisodic: vi.fn().mockResolvedValue('sem-new'),
      },
      episodic: { getById: vi.fn().mockResolvedValue(null), findPromotable },
    };
  }

  it('proposes a promote from a qualifying cluster of episodes', async () => {
    const neo4j = neo4jWith(vi.fn().mockResolvedValue(promotable));
    const llm = llmReturning({ content: 'The engine owns validation.', confidence: 0.8, decay_class: 'stable' });
    const engine = new ConsolidationEngine(emptyRedis() as never, neo4j as never, CONFIG, llm as never);

    const result = await engine.run('project:test');

    expect(result.proposals).toHaveLength(1);
    const p = result.proposals[0]!;
    expect(p.type).toBe('promote');
    // affected_ids must be the SOURCE EPISODE ids — _applyPromoteProposal anchors
    // PROMOTED_FROM on the first and derives the tenant from all of them.
    expect(p.affected_ids.sort()).toEqual(['e1', 'e2', 'e3']);
    expect(p.after.content).toBe('The engine owns validation.');
    expect(p.after.confidence).toBe(0.8);
    expect(p.after.tags).toEqual(['project:test']);
  });

  it('clamps an out-of-range model confidence into [0,1]', async () => {
    const neo4j = neo4jWith(vi.fn().mockResolvedValue(promotable));
    const llm = llmReturning({ content: 'A claim.', confidence: 4.2, decay_class: 'stable' });
    const engine = new ConsolidationEngine(emptyRedis() as never, neo4j as never, CONFIG, llm as never);

    const result = await engine.run('project:test');

    expect(result.proposals[0]!.after.confidence).toBe(1);
  });

  it('proposes nothing when the model declines with empty content', async () => {
    const neo4j = neo4jWith(vi.fn().mockResolvedValue(promotable));
    const llm = llmReturning({ content: '   ', confidence: 0.9, decay_class: 'stable' });
    const engine = new ConsolidationEngine(emptyRedis() as never, neo4j as never, CONFIG, llm as never);

    expect((await engine.run('project:test')).proposals).toHaveLength(0);
  });

  it('drops a cluster whose episodes span more than one project scope', async () => {
    const mixed = [
      ep('m1', vecAt(0), { scope: 'project:a', tags: ['project:a'] }),
      ep('m2', vecAt(2), { scope: 'project:b', tags: ['project:b'] }),
      ep('m3', vecAt(4), { scope: 'project:a', tags: ['project:a'] }),
    ];
    const neo4j = neo4jWith(vi.fn().mockResolvedValue(mixed));
    const llm = llmReturning({ content: 'Should never be proposed.', confidence: 0.9, decay_class: 'stable' });
    const engine = new ConsolidationEngine(emptyRedis() as never, neo4j as never, CONFIG, llm as never);

    expect((await engine.run('global')).proposals).toHaveLength(0);
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('is inert without an LLM (no synthesis possible)', async () => {
    const findPromotable = vi.fn().mockResolvedValue(promotable);
    const engine = new ConsolidationEngine(emptyRedis() as never, neo4jWith(findPromotable) as never, CONFIG);

    expect((await engine.run('project:test')).proposals).toHaveLength(0);
    expect(findPromotable).not.toHaveBeenCalled();
  });

  it('is inert on a layer without findPromotable (backward compatibility)', async () => {
    const neo4j = neo4jWith(undefined);
    const llm = llmReturning({ content: 'x', confidence: 0.5, decay_class: 'stable' });
    const engine = new ConsolidationEngine(emptyRedis() as never, neo4j as never, CONFIG, llm as never);

    expect((await engine.run('project:test')).proposals).toHaveLength(0);
  });

  it('survives a findPromotable failure without losing the run', async () => {
    const neo4j = neo4jWith(vi.fn().mockRejectedValue(new Error('neo4j down')));
    const llm = llmReturning({ content: 'x', confidence: 0.5, decay_class: 'stable' });
    const engine = new ConsolidationEngine(emptyRedis() as never, neo4j as never, CONFIG, llm as never);

    const result = await engine.run('project:test');
    expect(result.skipped).toBe(false);
    expect(result.proposals).toHaveLength(0);
  });

  it('does not filter by scope on an unscoped ("global") run', async () => {
    const findPromotable = vi.fn().mockResolvedValue(promotable);
    const llm = llmReturning({ content: 'A claim.', confidence: 0.7, decay_class: 'stable' });
    const engine = new ConsolidationEngine(emptyRedis() as never, neo4jWith(findPromotable) as never, CONFIG, llm as never);

    await engine.run('global');

    expect(findPromotable).toHaveBeenCalledWith(undefined, 200);
  });
});
