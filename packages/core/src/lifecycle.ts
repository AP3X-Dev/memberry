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
import { DECAY_HALF_LIVES_DAYS, type LifecycleConfig } from './config/lifecycle.js';

const DAY_MS = 86_400_000;
/** A decay proposal is emitted only when the drop is material. */
const MATERIAL_DROP = 0.05;

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
  ): Promise<{ episodic: Array<Record<string, unknown>>; semantic: Array<Record<string, unknown>> }>;
  setArchived(ids: string[], archived: boolean, now: string, batchRows: number): Promise<number>;
  findDecayCandidates(tenantId: string, scope: string, cooldownCutoffIso: string): Promise<Array<{
    id: string; confidence: number; decay_class: 'volatile' | 'stable' | 'permanent'; updated_at: string;
  }>>;
  stampDecayProposedAt(id: string, now: string): Promise<void>;
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

/**
 * Real half-life decay: proposed = round2(confidence x 0.5^(elapsed/half_life)),
 * floored at the configured confidence floor. Returns null when no material
 * proposal should be emitted (small drop, already at/below the floor, or an
 * unusable timestamp). Pure — node, now, and config only, no I/O — so the
 * MEM-006H usage-recency modifier can land as one added parameter without
 * touching emission, dedupe, or apply.
 */
export function computeDecay(
  node: DecayInput,
  nowMs: number,
  config: Pick<LifecycleConfig, 'decayConfidenceFloor'>,
): { proposedConfidence: number; drop: number } | null {
  const anchorMs = Date.parse(node.updated_at);
  if (!Number.isFinite(anchorMs)) return null;
  const elapsedDays = (nowMs - anchorMs) / DAY_MS;
  if (!(elapsedDays > 0)) return null;
  const halfLife = DECAY_HALF_LIVES_DAYS[node.decay_class];
  if (!halfLife) return null;
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

function writeArtifactSync(filePath: string, json: string): void {
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
  private clock: () => Date;
  private artifactWriter: (filePath: string, json: string) => void;

  constructor(deps: LifecycleEngineDeps) {
    this.store = deps.store;
    this.proposals = deps.proposals;
    this.config = deps.config;
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
    const pendingIds = new Set<string>();
    const pendingDecayTargets = new Set<string>();
    for (const proposalId of await this.proposals.listPending()) {
      const proposal = await this.proposals.get(proposalId);
      if (!proposal) continue;
      for (const id of proposal.affected_ids) {
        pendingIds.add(id);
        if (proposal.type === 'decay') pendingDecayTargets.add(id);
      }
    }

    const cooldownCutoff = isoMinusDays(nowMs, cfg.decayCooldownDays);
    const candidates = await this.store.findDecayCandidates(tenantId, scope, cooldownCutoff);
    let skippedPending = 0;
    const decayPlan: Array<{ id: string; updated_at: string; before: number; after: number; drop: number }> = [];
    for (const candidate of candidates) {
      if (pendingDecayTargets.has(candidate.id)) { skippedPending += 1; continue; }
      const computed = computeDecay(candidate, nowMs, cfg);
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

    const multiplier = cfg.archiveHalfLifeMultiplier;
    const archivePlan = await this.store.planArchive(tenantId, scope, {
      volatile: isoMinusDays(nowMs, DECAY_HALF_LIVES_DAYS.volatile * multiplier),
      stable: isoMinusDays(nowMs, DECAY_HALF_LIVES_DAYS.stable * multiplier),
      // Episodes carry no decay_class: the stable half-life applies.
      episodic: isoMinusDays(nowMs, DECAY_HALF_LIVES_DAYS.stable * multiplier),
    }, [...pendingIds]);

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
      await this.proposals.save(proposal);
      await this.store.stampDecayProposedAt(d.id, nowIso);
      scopeResult.decay_proposals_emitted += 1;
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
