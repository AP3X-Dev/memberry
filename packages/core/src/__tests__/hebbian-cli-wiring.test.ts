// packages/core/src/__tests__/hebbian-cli-wiring.test.ts
//
// MEM-006H flag-off equivalence at the LifecycleEngine surface: with the
// hebbian dep absent OR disabled, scope artifacts and run results are
// byte-identical to the MEM-006 status quo (no usage passed to computeDecay,
// no archive options, no reclass phase, no new keys). With the dep live, the
// ONLY differences are additive: the artifact `hebbian` section and the
// result's `reclass_proposals_emitted` counter.

import { describe, it, expect } from 'vitest';
import { LifecycleEngine, type LifecycleStorePort, type LifecycleEngineDeps } from '../lifecycle.js';
import type { ConsolidationProposal } from '../types.js';
import { resolveLifecycleConfig } from '../config/lifecycle.js';

const DAY_MS = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
function iso(ms: number): string { return new Date(ms).toISOString(); }

/** Stale-access (U1) nodes: identical decay numbers with or without the flag,
 *  so live-vs-control diffs isolate the additive surface. */
function makeStore(planArchiveCalls: unknown[][] = []): LifecycleStorePort {
  return {
    async listScopes() { return [{ tenantId: 'default', scope: 'project:lab' }]; },
    async findDecayCandidates() {
      return [{
        id: 'sem-1', confidence: 0.9, decay_class: 'stable' as const,
        updated_at: iso(T0 - 90 * DAY_MS),
        last_accessed: iso(T0 - 200 * DAY_MS), access_count: 4,
      }];
    },
    async stampDecayProposedAt() { /* noop */ },
    async planSidecarDeletions() {
      const empty = { doomed: [], expiredCount: 0, overBudgetCount: 0, keptCount: 0, protectedCount: 0 };
      return { AdmissionObservation: { ...empty }, AdmissionRoutingRecommendation: { ...empty } };
    },
    async deleteSidecars() { return { AdmissionObservation: 0, AdmissionRoutingRecommendation: 0 }; },
    async planArchive(...args: unknown[]) { planArchiveCalls.push(args); return { episodic: [], semantic: [] }; },
    async setArchived() { return 0; },
  } as LifecycleStorePort;
}

function makeProposals() {
  const byId = new Map<string, ConsolidationProposal>();
  return {
    byId,
    async save(p: ConsolidationProposal) { byId.set(p.id, p); },
    async get(id: string) { return byId.get(id) ?? null; },
    async listPending() { return [...byId.keys()]; },
  };
}

async function runOnce(hebbian: LifecycleEngineDeps['hebbian'] | 'absent') {
  const planArchiveCalls: unknown[][] = [];
  const artifacts: string[] = [];
  const proposals = makeProposals();
  const engine = new LifecycleEngine({
    store: makeStore(planArchiveCalls),
    proposals,
    config: resolveLifecycleConfig('./ignored'),
    ...(hebbian === 'absent' ? {} : { hebbian }),
    now: () => new Date(T0),
    writeArtifact: (_p, json) => { artifacts.push(json); },
  });
  const result = await engine.run();
  return { result, artifacts, planArchiveCalls, proposals };
}

/** Neutralize the per-run randomUUID so byte-comparisons pin everything else. */
function normalize(json: string): string {
  return json.replace(/lifecycle-[0-9a-f-]+/g, 'lifecycle-RUN');
}

describe('LifecycleEngine flag-off equivalence', () => {
  it('hebbian disabled is byte-identical to no hebbian dep at all (artifact + result)', async () => {
    const control = await runOnce('absent');
    const disabled = await runOnce({ mode: 'disabled' });
    expect(disabled.artifacts.map(normalize)).toEqual(control.artifacts.map(normalize));
    expect(disabled.result.scopes).toEqual(control.result.scopes);
    expect(JSON.parse(control.artifacts[0])).not.toHaveProperty('hebbian');
    expect(control.result.scopes[0]).not.toHaveProperty('reclass_proposals_emitted');
    // No archive options leak through when disabled.
    expect(control.planArchiveCalls[0][4] ?? undefined).toBeUndefined();
    expect(disabled.planArchiveCalls[0][4] ?? undefined).toBeUndefined();
  });

  it('hebbian live adds ONLY additive keys (existing artifact keys and numbers byte-identical)', async () => {
    const control = await runOnce('absent');
    const live = await runOnce({ mode: 'live' });

    const controlArtifact = JSON.parse(normalize(control.artifacts[0]));
    const liveArtifact = JSON.parse(normalize(live.artifacts[0]));
    const { hebbian: hebbianSection, ...liveRest } = liveArtifact;
    // U1 candidates: same decay numbers → everything but the additive section matches.
    expect(liveRest).toEqual(controlArtifact);
    expect(hebbianSection).toMatchObject({ mode: 'live' });
    expect(hebbianSection.decay_bands).toEqual({
      U0_never_accessed: 0, U1_stale_access: 1, U2_recent_low: 0, U3_recent_habitual: 0, U4_recent_heavy: 0,
    });
    expect(hebbianSection.reclass_proposals).toEqual([]);

    const { reclass_proposals_emitted, ...liveScope } = live.result.scopes[0] as Record<string, unknown>;
    expect(reclass_proposals_emitted).toBe(0);
    expect(liveScope).toEqual(control.result.scopes[0]);

    // Live passes the archive access-cutoff option; control passes none.
    expect(live.planArchiveCalls[0][4]).toMatchObject({
      hebbian: { accessCutoffIso: iso(T0 - 90 * DAY_MS) },
    });
  });
});
