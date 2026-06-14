// packages/core/src/__tests__/scope-bleed.repro.test.ts
//
// Rebuild Phase 0 — the Exhibit A repro (docs/rebuild-roadmap.md).
//
// Observed 2026-06-09: a berry_load scoped to project:amp returned mostly
// project:fugazi / project:mars-fps memories. Two mechanisms cause the bleed:
//   1. the vector channel (ScopedQuery.byVector) applies no tag/scope filter
//      at all — only tenant isolation;
//   2. the tag channel (ScopedQuery.byScope) ANY-matches the tags array, so a
//      shared domain tag like "architecture" matches nodes from any project.
//
// Contract under test: when a load carries a project:* tag, no memory that
// belongs to a different project (or to no project at all) may appear in the
// assembled context, regardless of which retrieval channel surfaced it.
// Cross-project reads remain available by omitting the project tag or passing
// the explicit wildcard "project:*".
//
// Phase 1 (structural tenancy) makes these pass.

import { describe, it, expect, vi } from 'vitest';
import { AMPService } from '../service.js';
import type { RedisLayer, Neo4jLayer } from '../service.js';
import type { AMPConfig, LoadScope, SemanticNode } from '../types.js';

function makeSemanticNode(overrides: Partial<SemanticNode> = {}): SemanticNode {
  return {
    id: 'sem-1',
    content: 'Test semantic content',
    confidence: 0.8,
    signal_count: 3,
    created_at: new Date(Date.now() - 86400000).toISOString(),
    updated_at: new Date(Date.now() - 86400000).toISOString(),
    decay_class: 'stable',
    tags: [],
    ...overrides,
  };
}

function makeConfig(): AMPConfig {
  return {
    redis: { url: 'redis://localhost:6379' },
    neo4j: { uri: 'bolt://localhost:7687', user: 'neo4j', password: 'password' },
    embedding: { provider: 'openai', apiKey: 'test-key' },
    cache: { defaultTTL: 300, contextTTL: 600, embeddingTTL: 86400 },
    consolidation: { autoApply: false, signalThreshold: 3 },
    exportPath: '/tmp/amp-export',
  };
}

function makeRedis(): RedisLayer {
  return {
    cache: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      invalidateByScope: vi.fn().mockResolvedValue(0),
      invalidateByNodeId: vi.fn().mockResolvedValue(1),
    },
    embeddings: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    },
    dedup: {
      isDuplicate: vi.fn().mockResolvedValue(false),
      markSeen: vi.fn().mockResolvedValue(undefined),
      checkAndMark: vi.fn().mockResolvedValue(false),
    },
    signals: { publish: vi.fn().mockResolvedValue('stream-id-1') },
    queue: { incrementScore: vi.fn().mockResolvedValue(1) },
  };
}

function makeNeo4j(query: Partial<Neo4jLayer['query']>): Neo4jLayer {
  return {
    episodic: {
      create: vi.fn().mockResolvedValue('ep-1'),
      linkToAgent: vi.fn().mockResolvedValue(undefined),
      linkToEntity: vi.fn().mockResolvedValue(undefined),
      linkToModel: vi.fn().mockResolvedValue(undefined),
      linkSignal: vi.fn().mockResolvedValue(undefined),
    },
    query: {
      byScope: vi.fn().mockResolvedValue([]),
      byVector: vi.fn().mockResolvedValue([]),
      ...query,
    },
  };
}

function makeEmbedding() {
  return {
    embed: vi.fn().mockResolvedValue(new Array(1536).fill(0.1)),
    embedBatch: vi.fn().mockResolvedValue([]),
  };
}

const AMP_SCOPE: LoadScope = {
  task: 'rebuild memberry retrieval',
  tags: ['project:amp', 'architecture'],
  max_tokens: 2000,
};

const inScopeNode = makeSemanticNode({
  id: 'sem-amp-1',
  content: 'MemBerry uses Neo4j for graph storage',
  tags: ['project:amp', 'architecture'],
});

describe('project scope enforcement (Exhibit A bleed repro)', () => {
  it('excludes cross-project nodes surfaced by the vector channel', async () => {
    const foreign = makeSemanticNode({
      id: 'sem-fugazi-vec',
      content: 'Original Fallow pipeline parses with oxc_parser',
      tags: ['project:fugazi', 'architecture'],
    });
    const neo4j = makeNeo4j({
      byScope: vi.fn().mockResolvedValue([inScopeNode]),
      byVector: vi.fn().mockResolvedValue([{ ...foreign, score: 0.93 }]),
    });
    const service = new AMPService(makeRedis(), neo4j, makeEmbedding(), makeConfig());

    const result = await service.load(AMP_SCOPE);

    expect(result.sources).toContain('sem-amp-1');
    expect(result.sources).not.toContain('sem-fugazi-vec');
    expect(result.markdown).not.toContain('sem-fugazi-vec');
  });

  it('excludes cross-project nodes that share a domain tag (ANY-match bleed)', async () => {
    // Simulates what the current byScope Cypher returns: ANY(t IN $tags ...)
    // matches "architecture" on a mars-fps node even though the load asked
    // for project:amp.
    const foreign = makeSemanticNode({
      id: 'sem-marsfps-tag',
      content: 'mars-fps is a single HTML file game',
      tags: ['project:mars-fps', 'architecture'],
    });
    const neo4j = makeNeo4j({
      byScope: vi.fn().mockResolvedValue([inScopeNode, foreign]),
    });
    const service = new AMPService(makeRedis(), neo4j, makeEmbedding(), makeConfig());

    const result = await service.load(AMP_SCOPE);

    expect(result.sources).toContain('sem-amp-1');
    expect(result.sources).not.toContain('sem-marsfps-tag');
    expect(result.markdown).not.toContain('sem-marsfps-tag');
  });

  it('excludes project-unaffiliated nodes from project-scoped loads', async () => {
    // Precision posture: a node with no project marker at all is not
    // presumed relevant to every project. It stays reachable via loads that
    // omit the project tag (deliberate cross-project queries).
    const unaffiliated = makeSemanticNode({
      id: 'sem-global-1',
      content: 'Some legacy note with no project affiliation',
      tags: ['architecture'],
    });
    const neo4j = makeNeo4j({
      byVector: vi.fn().mockResolvedValue([{ ...unaffiliated, score: 0.88 }]),
    });
    const service = new AMPService(makeRedis(), neo4j, makeEmbedding(), makeConfig());

    const result = await service.load(AMP_SCOPE);

    expect(result.sources).not.toContain('sem-global-1');
  });

  it('keeps cross-project retrieval available without a project tag', async () => {
    const fugazi = makeSemanticNode({
      id: 'sem-fugazi-1',
      content: 'Fallow plugin schema',
      tags: ['project:fugazi', 'architecture'],
    });
    const neo4j = makeNeo4j({
      byScope: vi.fn().mockResolvedValue([inScopeNode, fugazi]),
    });
    const service = new AMPService(makeRedis(), neo4j, makeEmbedding(), makeConfig());

    const result = await service.load({
      task: 'survey all architecture knowledge',
      tags: ['architecture'],
      max_tokens: 2000,
    });

    expect(result.sources).toContain('sem-amp-1');
    expect(result.sources).toContain('sem-fugazi-1');
  });

  it('treats the explicit wildcard project:* as a deliberate cross-scope read', async () => {
    const fugazi = makeSemanticNode({
      id: 'sem-fugazi-2',
      content: 'Fallow hidden dir allowlist',
      tags: ['project:fugazi', 'config'],
    });
    const neo4j = makeNeo4j({
      byScope: vi.fn().mockResolvedValue([fugazi]),
    });
    const service = new AMPService(makeRedis(), neo4j, makeEmbedding(), makeConfig());

    const result = await service.load({
      task: 'cross-project sweep',
      tags: ['project:*'],
      max_tokens: 2000,
    });

    expect(result.sources).toContain('sem-fugazi-2');
  });
});
