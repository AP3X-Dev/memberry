// packages/core/src/__tests__/hebbian-reclass.test.ts
//
// MEM-006H 'reclass' promotion proposals (lifecycle-decay harness style):
//  - U4 candidates earn a one-step review-gated proposal (volatile→stable,
//    stable→permanent; permanent never targeted);
//  - the advisor scores EVERY reclass proposal exactly 250/low with reasons
//    ['base_reclass'] — the §2.5 literal carries only decay_class on
//    before/after, so no structural modifier can ever fire on it;
//  - cap 10 per (tenant, scope), highest access_count first;
//  - pending-scan dedupe + reclass_proposed_at cooldown suppress re-emission;
//  - emission NEVER applies (even alongside an autoApply-enabled
//    consolidation config); an approved decision applies once through the
//    idempotency ledger and never touches updated_at.

import { describe, it, expect } from 'vitest';
import { LifecycleEngine, type LifecycleStorePort } from '../lifecycle.js';
import { ConsolidationEngine, stableId } from '../consolidation.js';
import type { ConsolidationProposal, AMPConfig } from '../types.js';
import { resolveLifecycleConfig, type LifecycleConfig } from '../config/lifecycle.js';

const DAY_MS = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
function iso(ms: number): string { return new Date(ms).toISOString(); }

interface FakeNode {
  id: string;
  confidence: number;
  decay_class: 'volatile' | 'stable' | 'permanent';
  updated_at: string;
  last_accessed?: string;
  access_count?: number;
  memory_type?: string;
  reinforced?: boolean;
  archived?: boolean;
  decay_proposed_at?: string;
  reclass_proposed_at?: string;
  applied_keys: string[];
}

class FakeProposals {
  private byId = new Map<string, ConsolidationProposal>();
  async save(p: ConsolidationProposal): Promise<void> { this.byId.set(p.id, p); }
  async get(id: string): Promise<ConsolidationProposal | null> { return this.byId.get(id) ?? null; }
  async listPending(): Promise<string[]> { return [...this.byId.keys()]; }
  async remove(id: string): Promise<void> { this.byId.delete(id); }
}

class FakeGraph implements LifecycleStorePort {
  constructor(public nodes: FakeNode[], private clock: () => number) {}

  async listScopes() { return [{ tenantId: 'default', scope: 'project:lab' }]; }
  async findDecayCandidates(_tenant: string, _scope: string, cooldownCutoffIso: string) {
    return this.nodes
      .filter((n) => n.memory_type !== 'decision'
        && n.decay_class !== 'permanent'
        && !n.reinforced
        && !n.archived
        && (n.decay_proposed_at === undefined || n.decay_proposed_at < cooldownCutoffIso))
      .map((n) => ({
        id: n.id, confidence: n.confidence, decay_class: n.decay_class, updated_at: n.updated_at,
        last_accessed: n.last_accessed ?? null,
        access_count: n.access_count ?? null,
        reclass_proposed_at: n.reclass_proposed_at ?? null,
      }));
  }
  async stampDecayProposedAt(id: string, now: string): Promise<void> {
    const node = this.nodes.find((n) => n.id === id);
    if (node) node.decay_proposed_at = now;
  }
  async stampReclassProposedAt(id: string, now: string): Promise<void> {
    const node = this.nodes.find((n) => n.id === id);
    if (node) node.reclass_proposed_at = now; // single property; updated_at untouched
  }
  async planSidecarDeletions() {
    const empty = { doomed: [], expiredCount: 0, overBudgetCount: 0, keptCount: 0, protectedCount: 0 };
    return { AdmissionObservation: { ...empty }, AdmissionRoutingRecommendation: { ...empty } };
  }
  async deleteSidecars() { return { AdmissionObservation: 0, AdmissionRoutingRecommendation: 0 }; }
  async planArchive() { return { episodic: [], semantic: [] }; }
  async setArchived() { return 0; }

  async updateConfidence(id: string, confidence: number, applicationKey?: string): Promise<void> {
    const node = this.nodes.find((n) => n.id === id);
    if (!node) return;
    if (applicationKey !== undefined && node.applied_keys.includes(applicationKey)) return;
    node.confidence = confidence;
    node.updated_at = iso(this.clock());
    if (applicationKey !== undefined) node.applied_keys.push(applicationKey);
  }
  // semantic.ts updateDecayClass semantics: shared idempotency ledger, and the
  // class change deliberately does NOT reset updated_at (the decay anchor).
  async updateDecayClass(id: string, decayClass: FakeNode['decay_class'], applicationKey?: string): Promise<void> {
    const node = this.nodes.find((n) => n.id === id);
    if (!node) return;
    if (applicationKey !== undefined && node.applied_keys.includes(applicationKey)) return;
    node.decay_class = decayClass;
    if (applicationKey !== undefined) node.applied_keys.push(applicationKey);
  }
}

function makeHarness(nodes: FakeNode[], overrides: Partial<LifecycleConfig> = {}, autoApply = false) {
  let nowMs = T0;
  const clock = () => nowMs;
  const config = { ...resolveLifecycleConfig('./ignored'), ...overrides };
  const graph = new FakeGraph(nodes, clock);
  const proposals = new FakeProposals();
  const artifacts: Array<{ path: string; json: string }> = [];
  const engine = new LifecycleEngine({
    store: graph,
    proposals,
    config,
    hebbian: { mode: 'live' },
    now: () => new Date(nowMs),
    writeArtifact: (p, json) => { artifacts.push({ path: p, json }); },
  });
  const consolidation = new ConsolidationEngine(
    {
      lock: { acquire: async () => true, release: async () => true },
      signals: { consume: async () => [] },
      queue: {},
      proposals,
      cache: { invalidateByNodeId: async () => 0 },
    },
    { semantic: graph } as never,
    { consolidation: { autoApply, signalThreshold: 3 } } as unknown as AMPConfig,
  );
  return {
    graph, proposals, engine, consolidation, artifacts,
    advanceDays(days: number) { nowMs += days * DAY_MS; },
  };
}

/** A heavily-used (U4) node: accessed yesterday, access_count >= 10. Anchored
 *  one day ago so no decay proposal muddies the pending set in these tests. */
function u4(id: string, decay_class: FakeNode['decay_class'], accessCount = 12, extra: Partial<FakeNode> = {}): FakeNode {
  return {
    id, confidence: 0.9, decay_class,
    updated_at: iso(T0 - DAY_MS),
    last_accessed: iso(T0 - DAY_MS),
    access_count: accessCount,
    applied_keys: [],
    ...extra,
  };
}

describe('reclass emission', () => {
  it('emits a one-step, advisor-annotated, review-gated proposal for a U4 volatile node', async () => {
    const h = makeHarness([u4('sem-1', 'volatile')]);
    const result = await h.engine.run();
    expect(result.scopes[0].reclass_proposals_emitted).toBe(1);

    const pending = await h.proposals.listPending();
    const proposal = (await h.proposals.get(
      pending.find((id) => id === stableId('reclass', ['project:lab', 'sem-1', 'volatile', 'stable']))!,
    ))!;
    expect(proposal).toMatchObject({
      type: 'reclass',
      scope: 'project:lab',
      affected_ids: ['sem-1'],
      before: { decay_class: 'volatile' },
      after: { decay_class: 'stable' },
      score: 12,
    });
    // The §2.5 literal carries ONLY decay_class — every reclass scores the
    // constant base row, forever.
    expect(proposal.advisor).toMatchObject({
      risk_permille: 250,
      band: 'low',
      calibration: 'structural-only',
    });
    expect(proposal.advisor?.reasons).toEqual(['base_reclass']);
    // Review-gated: emission never touched the node's class.
    expect(h.graph.nodes[0].decay_class).toBe('volatile');
    // Artifact carries the plan in the additive hebbian section.
    const artifact = JSON.parse(h.artifacts[0].json);
    expect(artifact.hebbian.reclass_proposals).toHaveLength(1);
    expect(artifact.hebbian.reclass_proposals[0]).toMatchObject({ target: 'sem-1', from: 'volatile', to: 'stable' });
  });

  it('promotes stable→permanent one step; permanent is terminal and never targeted', async () => {
    const h = makeHarness([u4('sem-stable', 'stable'), u4('sem-perm', 'permanent')]);
    const result = await h.engine.run();
    expect(result.scopes[0].reclass_proposals_emitted).toBe(1);
    const [id] = await h.proposals.listPending();
    const proposal = (await h.proposals.get(id))!;
    expect(proposal.affected_ids).toEqual(['sem-stable']);
    expect(proposal.after).toEqual({ decay_class: 'permanent' });
  });

  it('does not target nodes below U4 (recent-but-light or never-accessed)', async () => {
    const h = makeHarness([
      u4('sem-light', 'volatile', 2),
      { ...u4('sem-never', 'volatile'), last_accessed: undefined, access_count: undefined },
    ]);
    const result = await h.engine.run();
    expect(result.scopes[0].reclass_proposals_emitted).toBe(0);
  });

  it('caps at 10 per (tenant, scope), highest access_count first', async () => {
    const nodes = Array.from({ length: 12 }, (_, i) => u4(`sem-${i}`, 'volatile', 10 + i));
    const h = makeHarness(nodes);
    const result = await h.engine.run();
    expect(result.scopes[0].reclass_proposals_emitted).toBe(10);
    const pending = await Promise.all((await h.proposals.listPending()).map((id) => h.proposals.get(id)));
    const targets = pending.filter((p) => p!.type === 'reclass').map((p) => p!.affected_ids[0]).sort();
    // sem-2..sem-11 carry the 10 highest counts (12..21); sem-0/sem-1 miss the cap.
    expect(targets).toEqual(Array.from({ length: 10 }, (_, i) => `sem-${i + 2}`).sort());
  });

  it('pending-scan dedupe: an open reclass proposal for the target suppresses re-emission', async () => {
    const h = makeHarness([u4('sem-1', 'volatile')]);
    await h.proposals.save({
      id: 'pre-existing-reclass', type: 'reclass', scope: 'project:lab', affected_ids: ['sem-1'],
      before: { decay_class: 'volatile' }, after: { decay_class: 'stable' }, score: 11, created_at: iso(T0 - DAY_MS),
    });
    const result = await h.engine.run();
    expect(result.scopes[0].reclass_proposals_emitted).toBe(0);
  });

  it('after a rejection, the reclass_proposed_at cooldown suppresses re-minting, then expires', async () => {
    const h = makeHarness([u4('sem-1', 'volatile')]);
    await h.engine.run();
    const [firstId] = await h.proposals.listPending();
    await h.consolidation.apply(firstId, 'reject');
    expect(await h.proposals.listPending()).toHaveLength(0);
    expect(h.graph.nodes[0].reclass_proposed_at).toBeDefined();

    h.advanceDays(1); // inside the 30d cooldown — keep the node U4-recent
    h.graph.nodes[0].last_accessed = iso(T0);
    const during = await h.engine.run();
    expect(during.scopes[0].reclass_proposals_emitted).toBe(0);

    h.advanceDays(31); // past the cooldown
    h.graph.nodes[0].last_accessed = iso(T0 + 31 * DAY_MS);
    const after = await h.engine.run();
    expect(after.scopes[0].reclass_proposals_emitted).toBe(1);
  });
});

describe('reclass application (review-gated only)', () => {
  it('is never auto-applied: even with autoApply enabled, emission leaves the proposal pending', async () => {
    const h = makeHarness([u4('sem-1', 'volatile')], {}, /* autoApply */ true);
    await h.engine.run();
    expect(await h.proposals.listPending()).toHaveLength(1);
    expect(h.graph.nodes[0].decay_class).toBe('volatile');
  });

  it('an approved decision applies once through the idempotency ledger and never moves updated_at', async () => {
    const h = makeHarness([u4('sem-1', 'volatile')]);
    const target = h.graph.nodes[0];
    const anchorBefore = target.updated_at;

    await h.engine.run();
    const [id] = await h.proposals.listPending();
    const first = await h.consolidation.apply(id, 'approve');
    expect(first.applied).toBe(true);
    expect(target.decay_class).toBe('stable');
    expect(target.updated_at).toBe(anchorBefore); // class change must not reset the decay anchor
    expect(target.applied_keys).toEqual([id]);

    // Replay the same approved proposal: the ledger makes it a no-op.
    await h.proposals.save((await h.proposals.get(id)) ?? {
      id, type: 'reclass', scope: 'project:lab', affected_ids: ['sem-1'],
      before: { decay_class: 'volatile' }, after: { decay_class: 'stable' }, score: 12, created_at: iso(T0),
    });
    const second = await h.consolidation.apply(id, 'approve');
    expect(second.applied).toBe(true); // apply reports success…
    expect(target.applied_keys).toEqual([id]); // …but the ledger blocked a second write
    expect(target.decay_class).toBe('stable');
  });
});
