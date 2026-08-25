// packages/core/src/__tests__/advisor-lifecycle.test.ts
//
// MEM-008 lifecycle wiring: decay proposals never traverse the consolidation
// gate — LifecycleEngine saves them directly — so the advisor must be attached
// at that save site too, or the packet's own live-evidence class (nightly
// decay) would carry no recommendation. Dry-run still saves nothing.

import { describe, it, expect } from 'vitest';
import { LifecycleEngine, type LifecycleStorePort } from '../lifecycle.js';
import type { ConsolidationProposal } from '../types.js';
import { resolveLifecycleConfig } from '../config/lifecycle.js';

const DAY_MS = 86_400_000;
const T0 = Date.UTC(2026, 5, 1);
const iso = (ms: number): string => new Date(ms).toISOString();

class FakeProposals {
  saved: ConsolidationProposal[] = [];
  async save(p: ConsolidationProposal): Promise<void> { this.saved.push(p); }
  async get(id: string): Promise<ConsolidationProposal | null> { return this.saved.find((p) => p.id === id) ?? null; }
  async listPending(): Promise<string[]> { return this.saved.map((p) => p.id); }
}

/** Minimal store: one stale semantic, nothing to archive or delete. */
function makeStore(): LifecycleStorePort {
  const emptyPlan = { doomed: [], expiredCount: 0, overBudgetCount: 0, keptCount: 0, protectedCount: 0 };
  return {
    async listScopes() { return [{ tenantId: 'default', scope: 'project:lab' }]; },
    async findDecayCandidates() {
      // stable half-life 90d, 200d elapsed: 0.8 x 0.5^(200/90) ≈ 0.17 (round2).
      return [{ id: 'sem-old', confidence: 0.8, decay_class: 'stable' as const, updated_at: iso(T0 - 200 * DAY_MS) }];
    },
    async stampDecayProposedAt() {},
    async planArchive() { return { episodic: [], semantic: [] }; },
    async setArchived() { return 0; },
    async planSidecarDeletions() {
      return { AdmissionObservation: { ...emptyPlan }, AdmissionRoutingRecommendation: { ...emptyPlan } };
    },
    async deleteSidecars() { return { AdmissionObservation: 0, AdmissionRoutingRecommendation: 0 }; },
  };
}

function makeEngine() {
  const proposals = new FakeProposals();
  const engine = new LifecycleEngine({
    store: makeStore(),
    proposals,
    config: resolveLifecycleConfig('./export-root'),
    now: () => new Date(T0),
    writeArtifact: () => {},
  });
  return { engine, proposals };
}

describe('MEM-008 lifecycle wiring (decay proposal save site)', () => {
  it('emits the decay proposal WITH advisor: base_decay plus drop-derived reasons', async () => {
    const { engine, proposals } = makeEngine();
    const result = await engine.run();

    expect(result.failures).toEqual([]);
    expect(proposals.saved).toHaveLength(1);
    const saved = proposals.saved[0];
    expect(saved.type).toBe('decay');
    expect(saved.before).toEqual({ confidence: 0.8 });
    expect(saved.after).toEqual({ confidence: 0.17 });

    // drop = 630‰ (major) and resulting confidence 0.17 < 0.5:
    // 400 base + 200 + 100 = 700 → high.
    expect(saved.advisor).toEqual({
      contract: 'advisor/v1',
      risk_permille: 700,
      band: 'high',
      reasons: ['base_decay', 'confidence_drop_major', 'low_confidence_result'],
      calibration: 'structural-only',
    });
  });

  it('dry-run still saves nothing (unchanged)', async () => {
    const { engine, proposals } = makeEngine();
    const result = await engine.run({ dryRun: true });

    expect(result.dry_run).toBe(true);
    expect(proposals.saved).toEqual([]);
  });
});
