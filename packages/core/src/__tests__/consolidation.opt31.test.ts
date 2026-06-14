// packages/core/src/__tests__/consolidation.opt31.test.ts
//
// OPT-31: gate extraction-driven fact INVALIDATION during (auto-applied)
// consolidation behind a confidence gate. When consolidation extracts a fact
// from (potentially untrusted) content that contradicts an EXISTING active fact
// (same subject+predicate, different object), it used to ALWAYS invalidate the
// existing fact and replace it with the extracted one. That let injected content
// silently overwrite an authoritative fact. Now an ESTABLISHED fact (confidence
// >= MEMBERRY_FACT_PROTECT_CONFIDENCE, default 0.75) is only auto-invalidated by
// a contender at least as confident; otherwise the contender is held `tentative`
// and the established fact stays active.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// extractFacts must be mocked: the consolidation fact path calls it with the
// real apiKey, which would otherwise hit OpenAI.
vi.mock('../extract.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../extract.js')>();
  return { ...actual, extractFacts: vi.fn() };
});

import { ConsolidationEngine } from '../consolidation.js';
import type { ConsolidationRedisLayer, ConsolidationNeo4jLayer } from '../consolidation.js';
import type { AMPConfig, ConsolidationProposal, FactNode, SemanticNode } from '../types.js';
import { extractFacts } from '../extract.js';

const mockExtractFacts = vi.mocked(extractFacts);

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

function makeSemanticNode(id = 'sem-old', confidence = 0.8): SemanticNode {
  return {
    id,
    content: 'auth-module uses bcrypt',
    confidence,
    signal_count: 2,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    decay_class: 'stable',
    tags: ['test'],
  };
}

function makeExistingFact(confidence: number): FactNode {
  return {
    id: 'fact-existing',
    subject: 'auth-module',
    predicate: 'uses',
    object: 'bcrypt',
    entity_id: null,
    source_episode_ids: ['ep-1'],
    valid_at: new Date().toISOString(),
    invalid_at: null,
    confidence,
    status: 'active',
    inference_type: 'inductive',
    supersedes_fact_id: null,
    scope: 'project',
    tags: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/** A contradicting extracted fact: same subject+predicate, DIFFERENT object. */
function contradictingInput(confidence: number) {
  return {
    subject: 'auth-module',
    predicate: 'uses',
    object: 'plaintext', // attacker's claim
    confidence,
    source_episode_ids: ['ep-evil'],
    scope: 'project',
    tags: [],
  };
}

function makeFactLayer(existing: FactNode[]) {
  return {
    create: vi.fn().mockResolvedValue('fact-new'),
    findBySubjectPredicate: vi.fn().mockResolvedValue(existing),
    invalidate: vi.fn().mockResolvedValue(undefined),
    dispute: vi.fn().mockResolvedValue(undefined),
  };
}

function makeRedis(proposal: ConsolidationProposal): ConsolidationRedisLayer {
  return {
    lock: { acquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(true) },
    signals: { consume: vi.fn().mockResolvedValue([]) },
    queue: { popHighest: vi.fn().mockResolvedValue(null) },
    proposals: {
      save: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(proposal),
      listPending: vi.fn().mockResolvedValue([proposal.id]),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    cache: { invalidateByNodeId: vi.fn().mockResolvedValue(1) },
  } as unknown as ConsolidationRedisLayer;
}

function makeNeo4j(factLayer: ReturnType<typeof makeFactLayer>, node: SemanticNode): ConsolidationNeo4jLayer {
  return {
    semantic: {
      getById: vi.fn().mockResolvedValue(node),
      updateConfidence: vi.fn().mockResolvedValue(undefined),
      supersede: vi.fn().mockResolvedValue('new-sem-id'),
    },
    fact: factLayer,
  } as unknown as ConsolidationNeo4jLayer;
}

/** Build a supersede proposal whose after-confidence is NOT lower than before
 *  (so the separate _disputeRelatedFacts path is not triggered — we isolate the
 *  _extractAndStoreFacts invalidation gate). */
function supersedeProposal(node: SemanticNode): ConsolidationProposal {
  return {
    id: 'prop-1',
    type: 'supersede',
    scope: 'test',
    affected_ids: ['sem-old'],
    before: { ...node } as Record<string, unknown>,
    after: { ...node, content: 'auth-module uses plaintext', confidence: node.confidence } as Record<string, unknown>,
    score: 15,
    created_at: new Date().toISOString(),
  };
}

async function applyWith(existingConfidence: number, contenderConfidence: number) {
  const node = makeSemanticNode('sem-old', 0.8);
  const factLayer = makeFactLayer([makeExistingFact(existingConfidence)]);
  mockExtractFacts.mockResolvedValue([contradictingInput(contenderConfidence)] as never);
  const engine = new ConsolidationEngine(makeRedis(supersedeProposal(node)), makeNeo4j(factLayer, node), makeConfig());
  await engine.apply('prop-1', 'approve');
  return factLayer;
}

describe('OPT-31: consolidation fact-invalidation confidence gate', () => {
  beforeEach(() => {
    mockExtractFacts.mockReset();
    delete process.env.MEMBERRY_FACT_PROTECT_CONFIDENCE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MEMBERRY_FACT_PROTECT_CONFIDENCE;
  });

  it('does NOT auto-invalidate an established fact (0.9) from a lower-confidence (0.5) extraction — holds it tentative', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const factLayer = await applyWith(0.9, 0.5);

    expect(factLayer.invalidate).not.toHaveBeenCalled(); // established fact protected
    expect(factLayer.create).toHaveBeenCalledOnce();
    const created = factLayer.create.mock.calls[0][0] as FactNode;
    expect(created.status).toBe('tentative'); // contender held for review
    expect(created.object).toBe('plaintext');
    expect(created.supersedes_fact_id).toBe('fact-existing'); // linkage kept
  });

  it('STILL auto-supersedes a non-established fact (0.5) — preserves prior behavior', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const factLayer = await applyWith(0.5, 0.5);

    expect(factLayer.invalidate).toHaveBeenCalledOnce();
    expect(factLayer.invalidate.mock.calls[0][0]).toBe('fact-existing');
    expect(factLayer.create).toHaveBeenCalledOnce();
    const created = factLayer.create.mock.calls[0][0] as FactNode;
    expect(created.status).toBe('active');
  });

  it('auto-supersedes an established fact when the contender is AT LEAST as confident (0.8 vs 0.9)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const factLayer = await applyWith(0.8, 0.9);

    expect(factLayer.invalidate).toHaveBeenCalledOnce();
    const created = factLayer.create.mock.calls[0][0] as FactNode;
    expect(created.status).toBe('active');
  });

  it('a same-object extraction reinforces (no invalidate, no create)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const node = makeSemanticNode('sem-old', 0.8);
    const factLayer = makeFactLayer([makeExistingFact(0.9)]);
    // contender with the SAME object as the existing fact
    mockExtractFacts.mockResolvedValue([
      { ...contradictingInput(0.5), object: 'bcrypt' },
    ] as never);
    const engine = new ConsolidationEngine(makeRedis(supersedeProposal(node)), makeNeo4j(factLayer, node), makeConfig());
    await engine.apply('prop-1', 'approve');

    expect(factLayer.invalidate).not.toHaveBeenCalled();
    expect(factLayer.create).not.toHaveBeenCalled();
  });

  it('respects MEMBERRY_FACT_PROTECT_CONFIDENCE override (raising it past 0.9 unprotects the 0.9 fact)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.MEMBERRY_FACT_PROTECT_CONFIDENCE = '0.95';
    const factLayer = await applyWith(0.9, 0.5); // 0.9 < 0.95 → no longer established

    expect(factLayer.invalidate).toHaveBeenCalledOnce(); // now auto-superseded
    const created = factLayer.create.mock.calls[0][0] as FactNode;
    expect(created.status).toBe('active');
  });
});
