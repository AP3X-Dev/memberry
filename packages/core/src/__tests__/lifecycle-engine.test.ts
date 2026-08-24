// packages/core/src/__tests__/lifecycle-engine.test.ts
//
// MEM-006 engine orchestration: per-scope ordering (plan → artifact → decay →
// archive → sidecar delete), dry-run writes the artifact with zero mutations,
// an artifact-write failure aborts the scope with zero mutations, scope
// filtering, protected sidecar accounting in the run output, and crash-replay
// convergence (a second run over the mutated state is a no-op).

import { describe, it, expect } from 'vitest';
import { LifecycleEngine, type LifecycleStorePort } from '../lifecycle.js';
import type { ConsolidationProposal } from '../types.js';
import { resolveLifecycleConfig, type LifecycleConfig } from '../config/lifecycle.js';

const DAY_MS = 86_400_000;
const T0 = Date.UTC(2026, 5, 1);
const iso = (ms: number): string => new Date(ms).toISOString();

interface State {
  semantics: Array<{ id: string; confidence: number; decay_class: 'volatile' | 'stable' | 'permanent'; updated_at: string; archived?: boolean; decay_proposed_at?: string }>;
  episodes: Array<{ id: string; created_at: string; archived?: boolean }>;
  sidecars: Array<{ id: string; label: 'AdmissionObservation' | 'AdmissionRoutingRecommendation'; observed_at: string; recommended_tier: string }>;
}

/** Stateful fake store recording every operation in order. */
function makeStore(state: State, scopes = [{ tenantId: 'default', scope: 'project:lab' }]) {
  const ops: string[] = [];
  const store: LifecycleStorePort = {
    async listScopes() { return scopes; },
    async findDecayCandidates(_t, _s, cooldownCutoff) {
      ops.push('findDecayCandidates');
      return state.semantics
        .filter((n) => !n.archived && n.decay_class !== 'permanent'
          && (n.decay_proposed_at === undefined || n.decay_proposed_at < cooldownCutoff))
        .map(({ id, confidence, decay_class, updated_at }) => ({ id, confidence, decay_class, updated_at }));
    },
    async stampDecayProposedAt(id, now) {
      ops.push(`stamp:${id}`);
      const node = state.semantics.find((n) => n.id === id);
      if (node) node.decay_proposed_at = now;
    },
    async planArchive(_t, _s, cutoffs) {
      ops.push('planArchive');
      return {
        semantic: state.semantics
          .filter((n) => !n.archived && n.decay_class === 'stable' && n.updated_at < cutoffs.stable)
          .map((n) => ({ ...n })),
        episodic: state.episodes
          .filter((n) => !n.archived && n.created_at < cutoffs.episodic)
          .map((n) => ({ ...n })),
      };
    },
    async setArchived(ids, archived, _now, _batch) {
      ops.push(`setArchived:${ids.join(',')}`);
      let count = 0;
      for (const list of [state.semantics, state.episodes] as Array<Array<{ id: string; archived?: boolean }>>) {
        for (const n of list) if (ids.includes(n.id)) { n.archived = archived; count += 1; }
      }
      return count;
    },
    async planSidecarDeletions(_t, _s, cutoff, budget) {
      ops.push('planSidecarDeletions');
      const plan = {} as Awaited<ReturnType<LifecycleStorePort['planSidecarDeletions']>>;
      for (const label of ['AdmissionObservation', 'AdmissionRoutingRecommendation'] as const) {
        const rows = state.sidecars
          .filter((r) => r.label === label && r.recommended_tier !== 'protected')
          .sort((a, b) => (a.observed_at < b.observed_at ? -1 : 1));
        const expired = rows.filter((r) => r.observed_at < cutoff);
        const surviving = rows.filter((r) => !expired.includes(r));
        const excess = Math.max(0, surviving.length - budget);
        const overBudget = surviving.slice(0, excess);
        plan[label] = {
          doomed: [...expired, ...overBudget].map((r) => ({ ...r })),
          expiredCount: expired.length,
          overBudgetCount: overBudget.length,
          keptCount: surviving.length - excess,
          protectedCount: state.sidecars.filter((r) => r.label === label && r.recommended_tier === 'protected').length,
        };
      }
      return plan;
    },
    async deleteSidecars(_t, _s, idsByLabel) {
      ops.push('deleteSidecars');
      const deleted = { AdmissionObservation: 0, AdmissionRoutingRecommendation: 0 };
      for (const label of ['AdmissionObservation', 'AdmissionRoutingRecommendation'] as const) {
        for (const id of idsByLabel[label] ?? []) {
          const idx = state.sidecars.findIndex((r) => r.label === label && r.id === id && r.recommended_tier !== 'protected');
          if (idx >= 0) { state.sidecars.splice(idx, 1); deleted[label] += 1; }
        }
      }
      return deleted;
    },
  };
  return { store, ops };
}

class FakeProposals {
  saved: ConsolidationProposal[] = [];
  async save(p: ConsolidationProposal): Promise<void> { this.saved.push(p); }
  async get(id: string): Promise<ConsolidationProposal | null> { return this.saved.find((p) => p.id === id) ?? null; }
  async listPending(): Promise<string[]> { return this.saved.map((p) => p.id); }
}

function seedState(): State {
  return {
    semantics: [
      { id: 'sem-old', confidence: 0.8, decay_class: 'stable', updated_at: iso(T0 - 200 * DAY_MS) },
      { id: 'sem-fresh', confidence: 0.9, decay_class: 'stable', updated_at: iso(T0 - 5 * DAY_MS) },
    ],
    episodes: [
      { id: 'ep-old', created_at: iso(T0 - 300 * DAY_MS) },
      { id: 'ep-fresh', created_at: iso(T0 - 10 * DAY_MS) },
    ],
    sidecars: [
      { id: 'obs-ancient', label: 'AdmissionObservation', observed_at: iso(T0 - 400 * DAY_MS), recommended_tier: 'candidate' },
      { id: 'obs-protected', label: 'AdmissionObservation', observed_at: iso(T0 - 400 * DAY_MS), recommended_tier: 'protected' },
      { id: 'rec-ancient', label: 'AdmissionRoutingRecommendation', observed_at: iso(T0 - 400 * DAY_MS), recommended_tier: 'candidate' },
    ],
  };
}

function makeEngine(state: State, overrides: Partial<LifecycleConfig> = {}, options: {
  failArtifact?: boolean;
  scopes?: Array<{ tenantId: string; scope: string }>;
} = {}) {
  const { store, ops } = makeStore(state, options.scopes);
  const proposals = new FakeProposals();
  const artifacts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const engine = new LifecycleEngine({
    store,
    proposals,
    config: { ...resolveLifecycleConfig('./export-root'), ...overrides },
    now: () => new Date(T0),
    writeArtifact: (p, json) => {
      ops.push('writeArtifact');
      if (options.failArtifact) throw new Error('disk full');
      artifacts.push({ path: p, body: JSON.parse(json) as Record<string, unknown> });
    },
  });
  return { engine, ops, proposals, artifacts };
}

describe('LifecycleEngine orchestration', () => {
  it('runs plan → artifact → decay → archive → sidecar delete, in order, with exact counts', async () => {
    const state = seedState();
    const { engine, ops, proposals, artifacts } = makeEngine(state);
    const result = await engine.run();

    expect(result.failures).toEqual([]);
    const scope = result.scopes[0];
    expect(scope.decay_proposals_emitted).toBe(1); // sem-old only
    expect(scope.archived_semantic).toBe(1);
    expect(scope.archived_episodic).toBe(1);
    expect(scope.sidecar_deleted).toEqual({ admission_observation: 1, admission_routing_recommendation: 1 });
    expect(scope.sidecar_protected).toEqual({ admission_observation: 1, admission_routing_recommendation: 0 });

    // The artifact lands BEFORE any mutation; mutations follow the fixed order.
    const artifactIdx = ops.indexOf('writeArtifact');
    const firstMutation = ops.findIndex((o) => o.startsWith('stamp:') || o.startsWith('setArchived') || o === 'deleteSidecars');
    expect(artifactIdx).toBeGreaterThanOrEqual(0);
    expect(artifactIdx).toBeLessThan(firstMutation);
    expect(ops.indexOf('deleteSidecars')).toBeGreaterThan(ops.findIndex((o) => o.startsWith('setArchived')));

    // Mutated state: archived flags set, sidecars gone (protected survives).
    expect(state.semantics.find((n) => n.id === 'sem-old')?.archived).toBe(true);
    expect(state.episodes.find((n) => n.id === 'ep-old')?.archived).toBe(true);
    expect(state.sidecars.map((r) => r.id)).toEqual(['obs-protected']);

    // Artifact carries every doomed row + proposal, plus config and identity.
    const body = artifacts[0].body;
    expect(body.version).toBe(1);
    expect(body.tenant_id).toBe('default');
    expect(body.scope).toBe('project:lab');
    expect((body.archive as { semantic: unknown[] }).semantic).toHaveLength(1);
    expect((body.sidecar_delete as { admission_observation: unknown[] }).admission_observation.map((r: { id?: unknown }) => r.id)).toEqual(['obs-ancient']);
    expect((body.decay_proposals as Array<{ target: string }>)[0].target).toBe('sem-old');
    expect(proposals.saved).toHaveLength(1);
    expect(artifacts[0].path.replace(/\\/g, '/')).toContain('export-root/lifecycle/');
  });

  it('dry-run writes the artifact and mutates nothing', async () => {
    const state = seedState();
    const before = JSON.parse(JSON.stringify(state));
    const { engine, ops, proposals, artifacts } = makeEngine(state);
    const result = await engine.run({ dryRun: true });

    expect(result.dry_run).toBe(true);
    expect(artifacts).toHaveLength(1);
    expect((artifacts[0].body as { dry_run?: boolean }).dry_run).toBe(true);
    expect(proposals.saved).toEqual([]);
    expect(state).toEqual(before);
    expect(ops.filter((o) => o.startsWith('stamp:') || o.startsWith('setArchived') || o === 'deleteSidecars')).toEqual([]);
  });

  it('an artifact-write failure aborts the scope with zero mutations', async () => {
    const state = seedState();
    const before = JSON.parse(JSON.stringify(state));
    const { engine, ops, proposals } = makeEngine(state, {}, { failArtifact: true });
    const result = await engine.run();

    expect(result.scopes).toEqual([]);
    expect(result.failures).toEqual([{ tenant_id: 'default', scope: 'project:lab', error: 'disk full' }]);
    expect(proposals.saved).toEqual([]);
    expect(state).toEqual(before);
    expect(ops.filter((o) => o.startsWith('stamp:') || o.startsWith('setArchived') || o === 'deleteSidecars')).toEqual([]);
  });

  it('--scope restricts the pass to matching (tenant, scope) pairs', async () => {
    const state = seedState();
    const { engine, artifacts } = makeEngine(state, {}, {
      scopes: [
        { tenantId: 'default', scope: 'project:lab' },
        { tenantId: 'default', scope: 'project:other' },
        { tenantId: 'tenant-b', scope: 'project:lab' },
      ],
    });
    const result = await engine.run({ scope: 'project:LAB' });
    // Case-insensitive match; both tenants carrying the scope are processed.
    expect(result.scopes.map((s) => `${s.tenant_id}/${s.scope}`)).toEqual([
      'default/project:lab', 'tenant-b/project:lab',
    ]);
    expect(artifacts).toHaveLength(2);
  });

  it('crash-replay converges: a second run over the mutated state is a no-op', async () => {
    const state = seedState();
    const { engine } = makeEngine(state);
    await engine.run();
    const after = JSON.parse(JSON.stringify(state));

    const second = await engine.run();
    expect(second.failures).toEqual([]);
    const scope = second.scopes[0];
    expect(scope.decay_proposals_emitted).toBe(0); // cooldown stamp holds
    expect(scope.archived_semantic).toBe(0); // already archived → not re-planned
    expect(scope.archived_episodic).toBe(0);
    expect(scope.sidecar_deleted).toEqual({ admission_observation: 0, admission_routing_recommendation: 0 });
    expect(state).toEqual(after);
  });
});
