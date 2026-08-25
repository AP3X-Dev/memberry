// packages/core/src/__tests__/advisor-wiring.test.ts
//
// MEM-008 gate wiring: proposals that fall through to the review queue are
// saved WITH an advisor recommendation (consolidation.ts save site); auto-
// applied proposals are applied exactly as before and never saved with advice;
// review() returns the stored advisor field verbatim. The auto-apply hatches
// themselves (consolidation.ts:440-452) stay byte-untouched — these tests pin
// behavior on both sides of that unchanged branch.

import { describe, it, expect, vi } from 'vitest';
import { ConsolidationEngine } from '../consolidation.js';
import type { ConsolidationRedisLayer, ConsolidationNeo4jLayer } from '../consolidation.js';
import type { AMPConfig, SemanticNode, StreamSignal, ConsolidationProposal } from '../types.js';

function makeConfig(autoApply = false): AMPConfig {
  return {
    redis: { url: 'redis://localhost:6379' },
    neo4j: { uri: 'bolt://localhost:7687', user: 'neo4j', password: 'password' },
    embedding: { provider: 'openai', apiKey: 'test-key' },
    cache: { defaultTTL: 300, contextTTL: 600, embeddingTTL: 86400 },
    consolidation: { autoApply, signalThreshold: 3 },
    exportPath: '/tmp/amp-export',
  };
}

function makeSemanticNode(id = 'sem-1'): SemanticNode {
  return {
    id,
    content: 'Semantic knowledge about the task',
    confidence: 0.9,
    signal_count: 2,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    decay_class: 'stable',
    tags: ['test'],
  };
}

function makeStreamSignal(targetId: string, type: StreamSignal['type']): StreamSignal {
  return {
    type,
    target_id: targetId,
    detail: 'Test signal detail',
    source_session: 'sess-1',
    agent_id: 'agent-1',
    timestamp: new Date().toISOString(),
  };
}

/** In-memory proposal store so review() can read back what the gate saved. */
function makeProposalStore() {
  const stored = new Map<string, ConsolidationProposal>();
  return {
    stored,
    port: {
      save: vi.fn(async (p: ConsolidationProposal) => { stored.set(p.id, p); }),
      get: vi.fn(async (id: string) => stored.get(id) ?? null),
      listPending: vi.fn(async () => [...stored.keys()]),
      remove: vi.fn(async (id: string) => { stored.delete(id); }),
    },
  };
}

function makeRedis(
  signals: StreamSignal[],
  proposals: ReturnType<typeof makeProposalStore>['port'],
): ConsolidationRedisLayer {
  return {
    lock: {
      acquire: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(true),
    },
    signals: { consume: vi.fn().mockResolvedValue(signals) },
    queue: { popHighest: vi.fn().mockResolvedValue(null) },
    proposals,
    cache: { invalidateByNodeId: vi.fn().mockResolvedValue(1) },
  };
}

function makeNeo4j(node: SemanticNode): ConsolidationNeo4jLayer {
  return {
    semantic: {
      getById: vi.fn().mockResolvedValue(node),
      updateConfidence: vi.fn().mockResolvedValue(undefined),
      supersede: vi.fn().mockResolvedValue('new-sem-id'),
    },
  };
}

describe('MEM-008 gate wiring (consolidation review-queue save site)', () => {
  it('queues a contradiction-driven supersede WITH an advisor recommendation', async () => {
    const node = makeSemanticNode('sem-target');
    const signals = [
      makeStreamSignal('sem-target', 'contradiction'),
      makeStreamSignal('sem-target', 'correction'),
      makeStreamSignal('sem-target', 'correction'),
    ];
    const { port, stored } = makeProposalStore();
    const engine = new ConsolidationEngine(makeRedis(signals, port), makeNeo4j(node), makeConfig(false));

    const result = await engine.run('test-scope');

    expect(result.applied).toHaveLength(0);
    expect(port.save).toHaveBeenCalledTimes(1);
    const saved = [...stored.values()][0];
    expect(saved.type).toBe('supersede');
    expect(saved.advisor).toBeDefined();
    expect(saved.advisor?.contract).toBe('advisor/v1');
    expect(saved.advisor?.band).toBe('high');
    expect(saved.advisor?.reasons).toContain('base_supersede');
  });

  it('C1 mainline: single-correction supersede (0.9→0.8) carries confidence_drop_minor', async () => {
    // One correction signal (weight 5.0 >= threshold 3) → newConfidence 0.9 - 0.1.
    // Float subtraction yields 0.09999999999999998; the permille comparison must
    // still emit confidence_drop_minor.
    const node = makeSemanticNode('sem-single');
    const { port, stored } = makeProposalStore();
    const engine = new ConsolidationEngine(
      makeRedis([makeStreamSignal('sem-single', 'correction')], port),
      makeNeo4j(node),
      makeConfig(false),
    );

    await engine.run('test-scope');

    const saved = [...stored.values()][0];
    expect(saved.type).toBe('supersede');
    expect((saved.after as { confidence?: number }).confidence).toBeCloseTo(0.8, 10);
    expect(saved.advisor?.reasons).toContain('confidence_drop_minor');
  });

  it('auto-applied reinforcement is applied exactly as before and never saved with advice', async () => {
    const node = makeSemanticNode('sem-auto-reinforce');
    const signals = [
      makeStreamSignal(node.id, 'reinforcement'),
      makeStreamSignal(node.id, 'reinforcement'),
      makeStreamSignal(node.id, 'reinforcement'),
    ];
    const { port } = makeProposalStore();
    const neo4j = makeNeo4j(node);
    const engine = new ConsolidationEngine(makeRedis(signals, port), neo4j, makeConfig(true));

    const result = await engine.run('auto-scope');

    // Pre-change control expectation: the reinforce proposal is applied, not queued.
    expect(result.proposals[0]?.type).toBe('reinforce');
    expect(result.applied).toEqual([result.proposals[0]?.id]);
    expect(neo4j.semantic.updateConfidence).toHaveBeenCalledOnce();
    expect(port.save).not.toHaveBeenCalled();
  });

  it('review() returns the queued advisor field verbatim', async () => {
    const node = makeSemanticNode('sem-review');
    const signals = [
      makeStreamSignal('sem-review', 'correction'),
      makeStreamSignal('sem-review', 'correction'),
      makeStreamSignal('sem-review', 'correction'),
    ];
    const { port, stored } = makeProposalStore();
    const engine = new ConsolidationEngine(makeRedis(signals, port), makeNeo4j(node), makeConfig(false));

    await engine.run('test-scope');
    const saved = [...stored.values()][0];

    const reviewed = await engine.review(saved.id);
    expect(reviewed.advisor).toEqual(saved.advisor);
    expect((reviewed.advisor as { contract?: string }).contract).toBe('advisor/v1');
  });
});
