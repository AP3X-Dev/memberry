import { describe, expect, it, vi } from 'vitest';
import { AMPService } from '../service.js';
import type {
  Neo4jLayer,
  RedisLayer,
  SemanticEligibilityEvaluation,
} from '../service.js';
import type { AMPConfig, EpisodicNode, FactNode, SemanticNode } from '../types.js';

const semantic = (id: string, content = id): SemanticNode => ({
  id,
  content,
  confidence: 0.9,
  signal_count: 3,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  decay_class: 'stable',
  tags: ['project:test'],
  scope: 'project:test',
  tenant_id: 'tenant-a',
});

const episodic = (id: string): EpisodicNode & { score: number } => ({
  id,
  session_id: 'session-1',
  agent_id: 'agent-1',
  task: 'current task',
  content: `episode ${id}`,
  created_at: '2026-01-01T00:00:00.000Z',
  tags: ['project:test'],
  scope: 'project:test',
  tenant_id: 'tenant-a',
  score: 0.8,
});

const fact = (id: string): FactNode => ({
  id,
  subject: 'memberry',
  predicate: 'uses',
  object: 'neo4j',
  confidence: 0.9,
  status: 'active',
  inference_type: 'deductive',
  valid_at: '2026-01-01T00:00:00.000Z',
  invalid_at: null,
  source_episode_ids: [],
  supersedes_fact_id: null,
  scope: 'project:test',
  tenant_id: 'tenant-a',
  tags: [],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
});

function redis(): RedisLayer {
  return {
    cache: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      invalidateByScope: vi.fn().mockResolvedValue(0),
      invalidateByNodeId: vi.fn().mockResolvedValue(0),
    },
    embeddings: { get: vi.fn(), set: vi.fn() },
    dedup: {
      isDuplicate: vi.fn(), markSeen: vi.fn(), checkAndMark: vi.fn(), unmark: vi.fn(),
    },
    signals: { publish: vi.fn() },
    queue: { incrementScore: vi.fn() },
  };
}

function config(): AMPConfig {
  return {
    redis: { url: 'redis://localhost:6379' },
    neo4j: { uri: 'bolt://localhost:7687', user: 'neo4j', password: 'test' },
    embedding: { provider: 'openai', apiKey: 'test' },
    cache: { defaultTTL: 300, contextTTL: 600, embeddingTTL: 86400 },
    consolidation: { autoApply: false, signalThreshold: 3 },
    exportPath: '/tmp/memberry-test',
  };
}

function neo4j(
  evaluateActiveEligibility?: (read: {
    semanticIds: readonly string[];
    tenantId?: string;
    projectScope?: string;
    asOf?: string;
  }) => Promise<readonly SemanticEligibilityEvaluation[]>,
): Neo4jLayer {
  return {
    episodic: {
      create: vi.fn(), linkToAgent: vi.fn(), linkToEntity: vi.fn(),
      linkToModel: vi.fn(), linkSignal: vi.fn(),
    },
    query: {
      byScope: vi.fn().mockResolvedValue([semantic('obsolete', 'obsolete **memberry** policy')]),
      byVector: vi.fn().mockResolvedValue([{ ...semantic('current', 'current policy'), score: 0.2 }]),
      byVectorEpisodic: vi.fn().mockResolvedValue([episodic('episode-1')]),
      expandByGraph: vi.fn().mockResolvedValue([semantic('expanded', 'expanded policy')]),
      ...(evaluateActiveEligibility ? { evaluateActiveEligibility } : {}),
    },
    fact: {
      getActive: vi.fn().mockResolvedValue([fact('fact-1')]),
      create: vi.fn(), findBySubjectPredicate: vi.fn(), invalidate: vi.fn(),
    },
  };
}

const embedding = {
  available: true,
  embed: vi.fn().mockResolvedValue([0.1]),
  embedBatch: vi.fn().mockResolvedValue([]),
};

describe('AMPService final semantic eligibility gate', () => {
  it('batch-filters every semantic channel after graph expansion and before ranking', async () => {
    const evaluate = vi.fn().mockResolvedValue([
      { id: 'obsolete', status: 'ineligible' },
      { id: 'current', status: 'eligible' },
      { id: 'expanded', status: 'unknown' },
    ] satisfies SemanticEligibilityEvaluation[]);
    const service = new AMPService(redis(), neo4j(evaluate), embedding, config());

    const result = await service.load({
      task: 'current policy', entities: ['memberry'], tags: ['project:test'],
      tenantId: 'tenant-a', max_tokens: 2000,
    });

    expect(evaluate).toHaveBeenCalledOnce();
    expect(evaluate).toHaveBeenCalledWith({
      semanticIds: expect.arrayContaining(['obsolete', 'current', 'expanded']),
      tenantId: 'tenant-a', projectScope: 'project:test', asOf: undefined,
    });
    expect(result.sources).toContain('current');
    expect(result.sources).not.toContain('obsolete');
    expect(result.sources).not.toContain('expanded');
  });

  it.each([
    ['unavailable', undefined],
    ['failed', vi.fn().mockRejectedValue(new Error('authority unavailable'))],
  ])('excludes semantics when the evaluator is %s while preserving other lanes', async (_name, evaluate) => {
    const service = new AMPService(redis(), neo4j(evaluate), embedding, config());

    const result = await service.load({
      task: 'current policy', entities: ['memberry'], tags: ['project:test'],
      tenantId: 'tenant-a', max_tokens: 2000,
    });

    expect(result.sources).not.toContain('obsolete');
    expect(result.sources).not.toContain('current');
    expect(result.sources).not.toContain('expanded');
    expect(result.sources).toContain('episode-1');
    expect(result.sources).toContain('fact-1');
  });

  it('uses the requested historical frame instead of bypassing eligibility', async () => {
    const evaluate = vi.fn().mockResolvedValue([
      { id: 'obsolete', status: 'eligible' },
      { id: 'current', status: 'ineligible' },
      { id: 'expanded', status: 'unknown' },
    ] satisfies SemanticEligibilityEvaluation[]);
    const service = new AMPService(redis(), neo4j(evaluate), embedding, config());

    const result = await service.load({
      task: 'policy history', entities: ['memberry'], tags: ['project:test'],
      tenantId: 'tenant-a', temporal: { time_mode: 'historical', as_of: '2026-01-15T00:00:00.000Z' },
      max_tokens: 2000,
    });

    expect(evaluate).toHaveBeenCalledWith({
      semanticIds: expect.arrayContaining(['obsolete', 'current', 'expanded']),
      tenantId: 'tenant-a',
      projectScope: 'project:test',
      asOf: '2026-01-15T00:00:00.000Z',
    });
    expect(result.sources).toContain('obsolete');
    expect(result.sources).not.toContain('current');
    expect(result.sources).not.toContain('expanded');
    expect(result.markdown).toContain(
      '> Historical memory frame: 2026-01-15T00:00:00.000Z (valid_at inclusive, invalid_at exclusive).',
    );
  });
});
