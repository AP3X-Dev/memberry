// packages/core/src/lifecycle.ts
//
// MEM-006 LifecycleEngine: per-(tenant, scope) orchestration of the scheduled
// lifecycle pass — plan (read-only), export-before-mutate artifact, review-gated
// decay proposals, reversible archive, and sidecar retention deletion, in that
// order. Decay proposals are ONLY emitted here; application stays behind the
// existing review/apply path (consolidation.ts) and is never automated.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConsolidationProposal } from './types.js';
import { stableId } from './consolidation.js';
import { attachAdvisorV1 } from './advisor.js';
import {
  DECAY_HALF_LIVES_DAYS,
  HEBBIAN_HALF_LIFE_FACTORS,
  HEBBIAN_RECENCY_WINDOW_DAYS,
  type HebbianConfig,
  type LifecycleConfig,
} from './config/lifecycle.js';

const DAY_MS = 86_400_000;
/** A decay proposal is emitted only when the drop is material. */
const MATERIAL_DROP = 0.05;
/** MEM-006H: per-(tenant, scope) cap on emitted reclass proposals per run
 *  (frozen constant, not config — the decay-cap precedent, one notch lower). */
const MAX_RECLASS_PROPOSALS_PER_SCOPE = 10;
/** One-step promotion ladder; permanent is terminal, demotion is not built. */
const RECLASS_STEP = Object.freeze({ volatile: 'stable', stable: 'permanent' } as const);

// ─── Ports (implemented by @memberry/neo4j LifecycleStore and @memberry/redis ProposalStore) ──

export interface LifecycleScopeRef { tenantId: string; scope: string }

export interface LifecycleSidecarLabelPlan {
  doomed: Array<Record<string, unknown>>;
  expiredCount: number;
  overBudgetCount: number;
  keptCount: number;
  protectedCount: number;
}

export interface LifecycleStorePort {
  listScopes(): Promise<LifecycleScopeRef[]>;
  planSidecarDeletions(
    tenantId: string, projectScope: string, cutoffIso: string, budget: number,
  ): Promise<Record<'AdmissionObservation' | 'AdmissionRoutingRecommendation', LifecycleSidecarLabelPlan>>;
  deleteSidecars(
    tenantId: string, projectScope: string,
    idsByLabel: Partial<Record<'AdmissionObservation' | 'AdmissionRoutingRecommendation', string[]>>,
    batchRows: number,
  ): Promise<Record<'AdmissionObservation' | 'AdmissionRoutingRecommendation', number>>;
  planArchive(
    tenantId: string, scope: string,
    cutoffs: { volatile: string; stable: string; episodic: string },
    pendingIds: string[],
    // MEM-006H: optional trailing options (existing port fakes compile unedited).
    options?: { hebbian?: { accessCutoffIso: string } },
  ): Promise<{
    episodic: Array<Record<string, unknown>>; semantic: Array<Record<string, unknown>>;
    /** Rows the hebbian access guard excluded from the plan (options present only). */
    accessGuarded?: number;
  }>;
  setArchived(ids: string[], archived: boolean, now: string, batchRows: number): Promise<number>;
  findDecayCandidates(tenantId: string, scope: string, cooldownCutoffIso: string): Promise<Array<{
    id: string; confidence: number; decay_class: 'volatile' | 'stable' | 'permanent'; updated_at: string;
    // MEM-006H optional usage columns — absent means never accessed.
    last_accessed?: string | null; access_count?: number | null; reclass_proposed_at?: string | null;
  }>>;
  stampDecayProposedAt(id: string, now: string): Promise<void>;
  /** MEM-006H reclass-cooldown stamp — optional so existing fakes compile unedited. */
  stampReclassProposedAt?(id: string, now: string): Promise<void>;
}

export interface LifecycleProposalsPort {
  save(proposal: ConsolidationProposal): Promise<void>;
  get(id: string): Promise<ConsolidationProposal | null>;
  listPending(): Promise<string[]>;
}

// ─── Pure decay computation (MEM-006H seam) ─────────────────────────────────

export interface DecayInput {
  confidence: number;
  decay_class: 'volatile' | 'stable' | 'permanent';
  updated_at: string;
}

/** MEM-006H usage snapshot for one node. Absent last_accessed = never accessed. */
export interface UsageInput {
  last_accessed?: string | null;
  access_count?: number | null;
}

export type UsageBand = keyof typeof HEBBIAN_HALF_LIFE_FACTORS;

/**
 * Closed band selection: no last_accessed → U0 (sinks first); older than the
 * 90d window → U1 (classic behavior); within the window, access_count picks
 * U2/U3/U4. An unparseable last_accessed is fail-neutral (U1) — bad data must
 * never decay a memory FASTER than the classic formula.
 */
export function usageBand(usage: UsageInput, nowMs: number): UsageBand {
  const last = usage.last_accessed;
  if (last === undefined || last === null) return 'U0_never_accessed';
  const lastMs = Date.parse(last);
  if (!Number.isFinite(lastMs)) return 'U1_stale_access';
  if (lastMs < nowMs - HEBBIAN_RECENCY_WINDOW_DAYS * DAY_MS) return 'U1_stale_access';
  const count = typeof usage.access_count === 'number' && Number.isFinite(usage.access_count)
    ? usage.access_count : 0;
  if (count >= 10) return 'U4_recent_heavy';
  if (count >= 3) return 'U3_recent_habitual';
  return 'U2_recent_low';
}

/**
 * Real half-life decay: proposed = round2(confidence x 0.5^(elapsed/half_life)),
 * floored at the configured confidence floor. Returns null when no material
 * proposal should be emitted (small drop, already at/below the floor, or an
 * unusable timestamp). Pure — node, now, and config only, no I/O.
 *
 * MEM-006H landed the reserved `usage` parameter: when present, the EFFECTIVE
 * half-life is DECAY_HALF_LIVES_DAYS[class] x HEBBIAN_HALF_LIFE_FACTORS[band].
 * With `usage` undefined the factor branch is never taken — the result is
 * bit-identical to the MEM-006 implementation (§2.6.1, pinned by
 * hebbian-decay.test.ts).
 */
export function computeDecay(
  node: DecayInput,
  nowMs: number,
  config: Pick<LifecycleConfig, 'decayConfidenceFloor'>,
  usage?: UsageInput,
): { proposedConfidence: number; drop: number } | null {
  const anchorMs = Date.parse(node.updated_at);
  if (!Number.isFinite(anchorMs)) return null;
  const elapsedDays = (nowMs - anchorMs) / DAY_MS;
  if (!(elapsedDays > 0)) return null;
  const baseHalfLife = DECAY_HALF_LIVES_DAYS[node.decay_class];
  if (!baseHalfLife) return null;
  const halfLife = usage === undefined
    ? baseHalfLife
    : baseHalfLife * HEBBIAN_HALF_LIFE_FACTORS[usageBand(usage, nowMs)];
  const floor = config.decayConfidenceFloor;
  if (!(node.confidence > floor)) return null;
  const raw = node.confidence * Math.pow(0.5, elapsedDays / halfLife);
  const proposed = Math.max(floor, Math.round(raw * 100) / 100);
  const drop = node.confidence - proposed;
  if (drop < MATERIAL_DROP) return null;
  return { proposedConfidence: proposed, drop };
}

// ─── Run results ────────────────────────────────────────────────────────────

export interface LifecycleScopeResult {
  tenant_id: string;
  scope: string;
  dry_run: boolean;
  artifact_path: string;
  decay_proposals_emitted: number;
  decay_proposals_skipped_pending: number;
  archived_episodic: number;
  archived_semantic: number;
  sidecar_deleted: { admission_observation: number; admission_routing_recommendation: number };
  /** Protected-tier sidecar rows are exempt and accumulate — surfaced per run. */
  sidecar_protected: { admission_observation: number; admission_routing_recommendation: number };
  /** MEM-006H: present only when the hebbian sub-flag is live (results stay
   *  byte-identical when it is off). */
  reclass_proposals_emitted?: number;
}

export interface LifecycleRunResult {
  run_id: string;
  started_at: string;
  dry_run: boolean;
  scopes: LifecycleScopeResult[];
  failures: Array<{ tenant_id: string; scope: string; error: string }>;
}

export interface LifecycleEngineDeps {
  store: LifecycleStorePort;
  proposals: LifecycleProposalsPort;
  config: LifecycleConfig;
  /**
   * MEM-006H sub-flag. Absent or disabled ⇒ computeDecay is called without
   * usage, planArchive without options, and no reclass phase runs — the
   * MEM-006 behavior byte-for-byte (pinned by hebbian-cli-wiring.test.ts).
   */
  hebbian?: HebbianConfig;
  /** Injectable clock for tests. */
  now?: () => Date;
  /**
   * Injectable artifact writer for tests. The default writes then fsyncs the
   * fd before returning — the pass mutates nothing until the artifact is
   * durably on disk, and a failed write aborts the scope with zero mutations.
   */
  writeArtifact?: (filePath: string, json: string) => void;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed';
}

function isoMinusDays(nowMs: number, days: number): string {
  return new Date(nowMs - days * DAY_MS).toISOString();
}

/** Exported for the MEM-007 anti-entropy artifact (same fsync-before-return writer, not duplicated). */
export function writeArtifactSync(filePath: string, json: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, 'w');
  try {
    fs.writeSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export class LifecycleEngine {
  private store: LifecycleStorePort;
  private proposals: LifecycleProposalsPort;
  private config: LifecycleConfig;
  private hebbian?: HebbianConfig;
  private clock: () => Date;
  private artifactWriter: (filePath: string, json: string) => void;

  constructor(deps: LifecycleEngineDeps) {
    this.store = deps.store;
    this.proposals = deps.proposals;
    this.config = deps.config;
    this.hebbian = deps.hebbian;
    this.clock = deps.now ?? ((): Date => new Date());
    this.artifactWriter = deps.writeArtifact ?? writeArtifactSync;
  }

  /**
   * Run one lifecycle pass. `scope` restricts to one scope string (all tenants
   * carrying it); `dryRun` (or the config flag) plans + writes the artifact and
   * mutates nothing. A throw in one scope logs and continues; callers exit
   * non-zero when `failures` is non-empty.
   */
  async run(options: { scope?: string; dryRun?: boolean } = {}): Promise<LifecycleRunResult> {
    const startedAt = this.clock().toISOString();
    const runId = `lifecycle-${randomUUID()}`;
    const dryRun = options.dryRun === true || this.config.dryRun;
    const wanted = options.scope?.toLowerCase();
    const scopes = (await this.store.listScopes())
      .filter((s) => wanted === undefined || s.scope.toLowerCase() === wanted);

    const result: LifecycleRunResult = { run_id: runId, started_at: startedAt, dry_run: dryRun, scopes: [], failures: [] };
    for (const scopeRef of scopes) {
      try {
        result.scopes.push(await this.runScope(runId, scopeRef, dryRun));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[lifecycle] scope ${scopeRef.scope} (tenant ${scopeRef.tenantId}) failed: ${message}`);
        result.failures.push({ tenant_id: scopeRef.tenantId, scope: scopeRef.scope, error: message });
      }
    }
    return result;
  }

  private async runScope(
    runId: string,
    scopeRef: LifecycleScopeRef,
    dryRun: boolean,
  ): Promise<LifecycleScopeResult> {
    const cfg = this.config;
    const now = this.clock();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const { tenantId, scope } = scopeRef;

    // ── 1. Plan (read-only) ──────────────────────────────────────────────
    // P6: node ids referenced by any pending proposal are protected; pending
    // decay proposals additionally dedupe by target (not id equality — an open
    // proposal minted from an older updated_at must still suppress re-emission).
    const hebbianLive = this.hebbian?.mode === 'live';
    const pendingIds = new Set<string>();
    const pendingDecayTargets = new Set<string>();
    const pendingReclassTargets = new Set<string>();
    for (const proposalId of await this.proposals.listPending()) {
      const proposal = await this.proposals.get(proposalId);
      if (!proposal) continue;
      for (const id of proposal.affected_ids) {
        pendingIds.add(id);
        if (proposal.type === 'decay') pendingDecayTargets.add(id);
        if (proposal.type === 'reclass') pendingReclassTargets.add(id);
      }
    }

    const cooldownCutoff = isoMinusDays(nowMs, cfg.decayCooldownDays);
    const candidates = await this.store.findDecayCandidates(tenantId, scope, cooldownCutoff);
    let skippedPending = 0;
    const decayPlan: Array<{ id: string; updated_at: string; before: number; after: number; drop: number }> = [];
    for (const candidate of candidates) {
      if (pendingDecayTargets.has(candidate.id)) { skippedPending += 1; continue; }
      const computed = computeDecay(candidate, nowMs, cfg, hebbianLive ? candidate : undefined);
      if (!computed) continue;
      decayPlan.push({
        id: candidate.id,
        updated_at: candidate.updated_at,
        before: candidate.confidence,
        after: computed.proposedConfidence,
        drop: computed.drop,
      });
    }
    // Largest drop first; per-(tenant, scope) cap so a first pass over an old
    // corpus cannot flood the review queue.
    decayPlan.sort((a, b) => b.drop - a.drop || (a.id < b.id ? -1 : 1));
    const cappedDecay = decayPlan.slice(0, cfg.maxDecayProposalsPerScope);

    // MEM-006H reclass plan: U4 candidates whose class is one step below the
    // ladder top, outside the reclass cooldown and with no pending reclass.
    const bandCounts = {
      U0_never_accessed: 0, U1_stale_access: 0, U2_recent_low: 0, U3_recent_habitual: 0, U4_recent_heavy: 0,
    };
    const reclassPlan: Array<{ id: string; from: 'volatile' | 'stable'; to: 'stable' | 'permanent'; accessCount: number }> = [];
    if (hebbianLive) {
      for (const candidate of candidates) {
        const band = usageBand(candidate, nowMs);
        bandCounts[band] += 1;
        if (band !== 'U4_recent_heavy') continue;
        const to = candidate.decay_class === 'permanent' ? undefined : RECLASS_STEP[candidate.decay_class];
        if (!to) continue;
        if (pendingReclassTargets.has(candidate.id)) continue;
        if (typeof candidate.reclass_proposed_at === 'string' && candidate.reclass_proposed_at >= cooldownCutoff) continue;
        reclassPlan.push({
          id: candidate.id,
          from: candidate.decay_class as 'volatile' | 'stable',
          to,
          accessCount: typeof candidate.access_count === 'number' ? candidate.access_count : 0,
        });
      }
      reclassPlan.sort((a, b) => b.accessCount - a.accessCount || (a.id < b.id ? -1 : 1));
    }
    const cappedReclass = reclassPlan.slice(0, MAX_RECLASS_PROPOSALS_PER_SCOPE);

    const multiplier = cfg.archiveHalfLifeMultiplier;
    const archivePlan = await this.store.planArchive(tenantId, scope, {
      volatile: isoMinusDays(nowMs, DECAY_HALF_LIVES_DAYS.volatile * multiplier),
      stable: isoMinusDays(nowMs, DECAY_HALF_LIVES_DAYS.stable * multiplier),
      // Episodes carry no decay_class: the stable half-life applies.
      episodic: isoMinusDays(nowMs, DECAY_HALF_LIVES_DAYS.stable * multiplier),
    }, [...pendingIds],
    // Cutoff TIMES are unchanged — the access guard only ever narrows the plan.
    hebbianLive ? { hebbian: { accessCutoffIso: isoMinusDays(nowMs, HEBBIAN_RECENCY_WINDOW_DAYS) } } : undefined);

    const sidecarCutoff = isoMinusDays(nowMs, cfg.sidecarMaxAgeDays);
    const sidecarPlan = await this.store.planSidecarDeletions(tenantId, scope, sidecarCutoff, cfg.sidecarBudget);

    // ── 2. Export-before-mutate artifact (fsync before any write) ────────
    const artifactPath = path.join(
      cfg.exportDir, 'lifecycle',
      `${nowIso.replace(/[:.]/g, '-')}-${slug(tenantId)}-${slug(scope)}.json`,
    );
    const artifact = {
      version: 1,
      run_id: runId,
      tenant_id: tenantId,
      scope,
      started_at: nowIso,
      dry_run: dryRun,
      // Restore paths: `archived` is a reversible boolean (memberry lifecycle
      // unarchive --id <id>); sidecar rows are restorable by re-inserting the
      // recorded property maps below (no restore tool — write-never-read rows).
      config: { ...cfg },
      archive: { episodic: archivePlan.episodic, semantic: archivePlan.semantic },
      sidecar_delete: {
        admission_observation: sidecarPlan.AdmissionObservation.doomed,
        admission_routing_recommendation: sidecarPlan.AdmissionRoutingRecommendation.doomed,
      },
      decay_proposals: cappedDecay.map((d) => ({
        id: stableId('decay', [scope, d.id, d.updated_at]),
        target: d.id,
        before_confidence: d.before,
        after_confidence: d.after,
      })),
      // MEM-006H: additive section only when live — existing keys stay
      // byte-identical with the sub-flag off (artifact version stays 1).
      ...(hebbianLive ? {
        hebbian: {
          mode: 'live',
          decay_bands: bandCounts,
          archive_access_guarded: archivePlan.accessGuarded ?? 0,
          reclass_proposals: cappedReclass.map((r) => ({
            id: stableId('reclass', [scope, r.id, r.from, r.to]),
            target: r.id,
            from: r.from,
            to: r.to,
            access_count: r.accessCount,
          })),
        },
      } : {}),
    };
    // A failed artifact write aborts the scope pass with zero mutations.
    this.artifactWriter(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);

    const scopeResult: LifecycleScopeResult = {
      tenant_id: tenantId,
      scope,
      dry_run: dryRun,
      artifact_path: artifactPath,
      decay_proposals_emitted: 0,
      decay_proposals_skipped_pending: skippedPending,
      archived_episodic: 0,
      archived_semantic: 0,
      sidecar_deleted: { admission_observation: 0, admission_routing_recommendation: 0 },
      sidecar_protected: {
        admission_observation: sidecarPlan.AdmissionObservation.protectedCount,
        admission_routing_recommendation: sidecarPlan.AdmissionRoutingRecommendation.protectedCount,
      },
      ...(hebbianLive ? { reclass_proposals_emitted: 0 } : {}),
    };
    if (dryRun) return scopeResult;

    // ── 3. Decay proposals (emit, review-gated; never applied here) ──────
    for (const d of cappedDecay) {
      // Event-carrying id: the anchor timestamp makes each decay event a
      // distinct updateConfidence application key, so approving a second decay
      // for the same node can never be swallowed by the idempotency ledger.
      const proposal: ConsolidationProposal = {
        id: stableId('decay', [scope, d.id, d.updated_at]),
        type: 'decay',
        scope,
        affected_ids: [d.id],
        before: { confidence: d.before },
        after: { confidence: d.after },
        score: d.drop,
        created_at: nowIso,
      };
      // Order per node: pending-scan (above) → save → stamp; a crash between
      // save and stamp is covered by the pending-scan on the next run.
      await this.proposals.save(attachAdvisorV1(proposal));
      await this.store.stampDecayProposedAt(d.id, nowIso);
      scopeResult.decay_proposals_emitted += 1;
    }

    // ── 3b. MEM-006H reclass proposals (review-gated by construction: the
    // consolidation auto-apply hatches name only 'reinforce'/'promote') ──
    for (const r of cappedReclass) {
      // The literal carries ONLY decay_class on before/after, so the advisor
      // scores the constant base row for every reclass proposal.
      const proposal: ConsolidationProposal = {
        id: stableId('reclass', [scope, r.id, r.from, r.to]),
        type: 'reclass',
        scope,
        affected_ids: [r.id],
        before: { decay_class: r.from },
        after: { decay_class: r.to },
        score: r.accessCount,
        created_at: nowIso,
      };
      await this.proposals.save(attachAdvisorV1(proposal));
      await this.store.stampReclassProposedAt?.(r.id, nowIso);
      scopeResult.reclass_proposals_emitted = (scopeResult.reclass_proposals_emitted ?? 0) + 1;
    }

    // ── 4. Archive (reversible, idempotent, batched) ─────────────────────
    const episodicIds = archivePlan.episodic.map((n) => n.id as string).filter(Boolean);
    const semanticIds = archivePlan.semantic.map((n) => n.id as string).filter(Boolean);
    if (episodicIds.length > 0) {
      scopeResult.archived_episodic = await this.store.setArchived(episodicIds, true, nowIso, cfg.batchRows);
    }
    if (semanticIds.length > 0) {
      scopeResult.archived_semantic = await this.store.setArchived(semanticIds, true, nowIso, cfg.batchRows);
    }

    // ── 5. Sidecar retention deletion (rows are on disk in the artifact) ─
    const deleted = await this.store.deleteSidecars(tenantId, scope, {
      AdmissionObservation: sidecarPlan.AdmissionObservation.doomed.map((r) => r.id as string).filter(Boolean),
      AdmissionRoutingRecommendation: sidecarPlan.AdmissionRoutingRecommendation.doomed.map((r) => r.id as string).filter(Boolean),
    }, cfg.batchRows);
    scopeResult.sidecar_deleted = {
      admission_observation: deleted.AdmissionObservation,
      admission_routing_recommendation: deleted.AdmissionRoutingRecommendation,
    };
    return scopeResult;
  }
}
