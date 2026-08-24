// packages/core/src/__tests__/lifecycle-decay.test.ts
//
// MEM-006 decay producer: formula/floor/materiality, the per-scope cap,
// pending-target dedupe, protected skip, the rejection cooldown, and the P1
// regression — two successive decay approvals on one node must BOTH move
// confidence, proving the event-carrying proposal id is never a repeated
// updateConfidence application key. Application goes through the EXISTING
// ConsolidationEngine.apply path (shape compatibility with the decay branch).

import { describe, it, expect } from 'vitest';
import { computeDecay, LifecycleEngine, type LifecycleStorePort } from '../lifecycle.js';
import { ConsolidationEngine, stableId } from '../consolidation.js';
import type { ConsolidationProposal, AMPConfig } from '../types.js';
import { resolveLifecycleConfig, type LifecycleConfig } from '../config/lifecycle.js';

const DAY_MS = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

interface FakeNode {
  id: string;
  confidence: number;
  decay_class: 'volatile' | 'stable' | 'permanent';
  updated_at: string;
  memory_type?: string;
  reinforced?: boolean;
  archived?: boolean;
  decay_proposed_at?: string;
  applied_keys: string[];
}

function iso(ms: number): string { return new Date(ms).toISOString(); }

class FakeProposals {
  private byId = new Map<string, ConsolidationProposal>();
  async save(p: ConsolidationProposal): Promise<void> { this.byId.set(p.id, p); }
  async get(id: string): Promise<ConsolidationProposal | null> { return this.byId.get(id) ?? null; }
  async listPending(): Promise<string[]> { return [...this.byId.keys()]; }
  async remove(id: string): Promise<void> { this.byId.delete(id); }
}

/** In-memory Semantic graph implementing the store port's decay surface plus
 *  the exact updateConfidence idempotency-ledger semantics of semantic.ts. */
class FakeGraph implements LifecycleStorePort {
  constructor(public nodes: FakeNode[], private clock: () => number, private cooldownDays: number) {}

  async listScopes() { return [{ tenantId: 'default', scope: 'project:lab' }]; }
  async findDecayCandidates(_tenant: string, _scope: string, cooldownCutoffIso: string) {
    return this.nodes
      .filter((n) => n.memory_type !== 'decision'
        && n.decay_class !== 'permanent'
        && !n.reinforced
        && !n.archived
        && (n.decay_proposed_at === undefined || n.decay_proposed_at < cooldownCutoffIso))
      .map((n) => ({ id: n.id, confidence: n.confidence, decay_class: n.decay_class, updated_at: n.updated_at }));
  }
  async stampDecayProposedAt(id: string, now: string): Promise<void> {
    const node = this.nodes.find((n) => n.id === id);
    if (node) node.decay_proposed_at = now; // single property; updated_at untouched
  }
  async planSidecarDeletions() {
    const empty = { doomed: [], expiredCount: 0, overBudgetCount: 0, keptCount: 0, protectedCount: 0 };
    return { AdmissionObservation: { ...empty }, AdmissionRoutingRecommendation: { ...empty } };
  }
  async deleteSidecars() { return { AdmissionObservation: 0, AdmissionRoutingRecommendation: 0 }; }
  async planArchive() { return { episodic: [], semantic: [] }; }
  async setArchived() { return 0; }

  // semantic.ts updateConfidence semantics: a repeated application key silently skips.
  async updateConfidence(id: string, confidence: number, applicationKey?: string): Promise<void> {
    const node = this.nodes.find((n) => n.id === id);
    if (!node) return;
    if (applicationKey !== undefined && node.applied_keys.includes(applicationKey)) return;
    node.confidence = confidence;
    node.updated_at = iso(this.clock());
    if (applicationKey !== undefined) node.applied_keys.push(applicationKey);
  }
}

function makeConfig(overrides: Partial<LifecycleConfig> = {}): LifecycleConfig {
  return { ...resolveLifecycleConfig('./ignored'), ...overrides };
}

function makeHarness(nodes: FakeNode[], overrides: Partial<LifecycleConfig> = {}) {
  let nowMs = T0;
  const clock = () => nowMs;
  const config = makeConfig(overrides);
  const graph = new FakeGraph(nodes, clock, config.decayCooldownDays);
  const proposals = new FakeProposals();
  const artifacts: string[] = [];
  const engine = new LifecycleEngine({
    store: graph,
    proposals,
    config,
    now: () => new Date(nowMs),
    writeArtifact: (p) => { artifacts.push(p); },
  });
  const consolidation = new ConsolidationEngine(
    {
      lock: { acquire: async () => true, release: async () => true },
      signals: { consume: async () => [] },
      queue: {},
      proposals,
      cache: { invalidateByNodeId: async () => 0 },
    },
    { semantic: graph as unknown as { getById(id: string): Promise<null>; updateConfidence(id: string, c: number, k?: string): Promise<void>; supersede(): Promise<string> } } as never,
    { consolidation: { autoApply: false, signalThreshold: 3 } } as unknown as AMPConfig,
  );
  return {
    graph, proposals, engine, consolidation, artifacts,
    advanceDays(days: number) { nowMs += days * DAY_MS; },
    get nowMs() { return nowMs; },
  };
}

function node(id: string, confidence: number, agedDays: number, extra: Partial<FakeNode> = {}): FakeNode {
  return {
    id, confidence,
    decay_class: 'stable',
    updated_at: iso(T0 - agedDays * DAY_MS),
    applied_keys: [],
    ...extra,
  };
}

describe('computeDecay (pure)', () => {
  const config = { decayConfidenceFloor: 0.1 };

  it('applies the half-life formula: one stable half-life halves confidence (round2)', () => {
    const result = computeDecay(
      { confidence: 0.9, decay_class: 'stable', updated_at: iso(T0 - 90 * DAY_MS) }, T0, config,
    );
    expect(result).toEqual({ proposedConfidence: 0.45, drop: expect.closeTo(0.45, 10) });
  });

  it('uses the per-class half-life (volatile decays 14d, permanent handled upstream)', () => {
    const volatile = computeDecay(
      { confidence: 0.8, decay_class: 'volatile', updated_at: iso(T0 - 14 * DAY_MS) }, T0, config,
    );
    expect(volatile?.proposedConfidence).toBe(0.4);
  });

  it('floors the proposal at the configured confidence floor', () => {
    const result = computeDecay(
      { confidence: 0.5, decay_class: 'volatile', updated_at: iso(T0 - 1000 * DAY_MS) }, T0, config,
    );
    expect(result?.proposedConfidence).toBe(0.1);
  });

  it('emits nothing when the drop is immaterial or the node is at/below the floor', () => {
    // ~5 days of a 90d half-life: drop < 0.05.
    expect(computeDecay({ confidence: 0.9, decay_class: 'stable', updated_at: iso(T0 - 5 * DAY_MS) }, T0, config)).toBeNull();
    // Already at the floor.
    expect(computeDecay({ confidence: 0.1, decay_class: 'stable', updated_at: iso(T0 - 500 * DAY_MS) }, T0, config)).toBeNull();
    // Floored proposal with an immaterial distance from confidence.
    expect(computeDecay({ confidence: 0.12, decay_class: 'stable', updated_at: iso(T0 - 500 * DAY_MS) }, T0, config)).toBeNull();
    // Unusable / future timestamps.
    expect(computeDecay({ confidence: 0.9, decay_class: 'stable', updated_at: 'not-a-date' }, T0, config)).toBeNull();
    expect(computeDecay({ confidence: 0.9, decay_class: 'stable', updated_at: iso(T0 + DAY_MS) }, T0, config)).toBeNull();
  });
});

describe('LifecycleEngine decay emission', () => {
  it('emits review-gated proposals in the existing ConsolidationProposal shape', async () => {
    const h = makeHarness([node('sem-1', 0.9, 90)]);
    const result = await h.engine.run();
    expect(result.scopes[0].decay_proposals_emitted).toBe(1);
    const pending = await h.proposals.listPending();
    expect(pending).toHaveLength(1);
    const proposal = (await h.proposals.get(pending[0]))!;
    expect(proposal).toMatchObject({
      type: 'decay',
      scope: 'project:lab',
      affected_ids: ['sem-1'],
      before: { confidence: 0.9 },
      after: { confidence: 0.45 },
    });
    expect(proposal.id).toBe(stableId('decay', ['project:lab', 'sem-1', iso(T0 - 90 * DAY_MS)]));
  });

  it('caps emissions per scope, largest drop first', async () => {
    const nodes = Array.from({ length: 8 }, (_, i) => node(`sem-${i}`, 0.5 + i * 0.05, 90 + i * 10));
    const h = makeHarness(nodes, { maxDecayProposalsPerScope: 3 });
    const result = await h.engine.run();
    expect(result.scopes[0].decay_proposals_emitted).toBe(3);
    const pending = await Promise.all((await h.proposals.listPending()).map((id) => h.proposals.get(id)));
    const drops = pending.map((p) => (p!.before.confidence as number) - (p!.after.confidence as number));
    const allDrops = nodes
      .map((n) => computeDecay(n, h.nowMs, { decayConfidenceFloor: 0.1 })!)
      .map((d) => d.drop)
      .sort((a, b) => b - a);
    expect(drops.sort((a, b) => b - a).map((d) => Math.round(d * 100))).toEqual(
      allDrops.slice(0, 3).map((d) => Math.round(d * 100)),
    );
  });

  it('dedupes by pending target scan, not id equality (older-anchor proposal still suppresses)', async () => {
    const h = makeHarness([node('sem-1', 0.9, 90)]);
    // Pre-saved pending decay proposal minted from an OLDER updated_at → different id.
    await h.proposals.save({
      id: stableId('decay', ['project:lab', 'sem-1', iso(T0 - 400 * DAY_MS)]),
      type: 'decay', scope: 'project:lab', affected_ids: ['sem-1'],
      before: { confidence: 0.95 }, after: { confidence: 0.5 }, score: 0.45, created_at: iso(T0 - 30 * DAY_MS),
    });
    const result = await h.engine.run();
    expect(result.scopes[0].decay_proposals_emitted).toBe(0);
    expect(result.scopes[0].decay_proposals_skipped_pending).toBe(1);
    expect(await h.proposals.listPending()).toHaveLength(1);
  });

  it('never targets protected memory (decision / reinforced / permanent-class)', async () => {
    const h = makeHarness([
      node('sem-decision', 0.9, 200, { memory_type: 'decision' }),
      node('sem-reinforced', 0.9, 200, { reinforced: true }),
      node('sem-permanent', 0.9, 400, { decay_class: 'permanent' }),
      node('sem-plain', 0.9, 200),
    ]);
    await h.engine.run();
    const pending = await Promise.all((await h.proposals.listPending()).map((id) => h.proposals.get(id)));
    expect(pending.map((p) => p!.affected_ids[0])).toEqual(['sem-plain']);
  });

  it('after a rejection, does not re-emit within the cooldown, then re-emits after it', async () => {
    const h = makeHarness([node('sem-1', 0.9, 90)]);
    await h.engine.run();
    const [firstId] = await h.proposals.listPending();
    // Reject removes the proposal entirely (consolidation apply reject path).
    await h.consolidation.apply(firstId, 'reject');
    expect(await h.proposals.listPending()).toHaveLength(0);

    h.advanceDays(1); // inside the 30d cooldown
    const during = await h.engine.run();
    expect(during.scopes[0].decay_proposals_emitted).toBe(0);

    h.advanceDays(31); // past the cooldown
    const after = await h.engine.run();
    expect(after.scopes[0].decay_proposals_emitted).toBe(1);
  });

  it('P1 regression: two successive approvals both move confidence (id is a fresh application key each event)', async () => {
    const h = makeHarness([node('sem-1', 0.9, 90)]);
    const target = h.graph.nodes[0];

    // Event 1: emit and approve through the EXISTING apply path.
    await h.engine.run();
    const [firstId] = await h.proposals.listPending();
    const first = await h.consolidation.apply(firstId, 'approve');
    expect(first.applied).toBe(true);
    expect(target.confidence).toBe(0.45);
    expect(target.applied_keys).toEqual([firstId]);

    // Age the node one more stable half-life past the cooldown, then event 2.
    h.advanceDays(90);
    await h.engine.run();
    const [secondId] = await h.proposals.listPending();
    expect(secondId).not.toBe(firstId); // anchor timestamp changed → new event id
    const second = await h.consolidation.apply(secondId, 'approve');
    expect(second.applied).toBe(true);
    // Confidence must move BOTH times — a repeated key would silently no-op here.
    expect(target.confidence).toBeCloseTo(0.23, 2); // round2(0.45 x 0.5^(90/90))
    expect(target.applied_keys).toEqual([firstId, secondId]);
  });
});
