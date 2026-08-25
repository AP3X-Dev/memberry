// packages/neo4j/src/lifecycle.ts
//
// MEM-006 LifecycleStore: all graph reads/writes for the scheduled
// `memberry lifecycle` pass — scope discovery, sidecar retention
// (plan + budgeted hard delete of the write-only admission sidecars),
// archive-candidate planning under the closed P1-P6 protection table, the
// reversible archived flag, decay-candidate reads, and the decay_proposed_at
// cooldown stamp. Memory nodes are NEVER hard-deleted here; only sidecar rows
// are, and never protected-tier ones.
//
// Batched mutations clone the tenant-admin precedent:
// CALL { WITH n ... } IN TRANSACTIONS OF <n> ROWS (implicit transaction via
// session.run — IN TRANSACTIONS is rejected inside executeWrite).

import { type Driver } from 'neo4j-driver';
import { DEFAULT_TENANT } from '@memberry/core';

/** The two write-only admission sidecar labels subject to retention. */
export const SIDECAR_LABELS = ['AdmissionObservation', 'AdmissionRoutingRecommendation'] as const;
export type SidecarLabel = (typeof SIDECAR_LABELS)[number];

export interface LifecycleScope {
  tenantId: string;
  scope: string;
}

export interface SidecarLabelPlan {
  /** Full property maps of the rows the pass will delete (artifact rows). */
  doomed: Array<Record<string, unknown>>;
  /** Rows past max-age (subset of doomed). */
  expiredCount: number;
  /** Rows deleted oldest-first to get back under budget (subset of doomed). */
  overBudgetCount: number;
  /** Non-protected rows that survive this pass. */
  keptCount: number;
  /** Protected-tier rows — exempt from deletion, they accumulate (run-log output). */
  protectedCount: number;
}

export type SidecarPlan = Record<SidecarLabel, SidecarLabelPlan>;

export interface ArchivePlan {
  episodic: Array<Record<string, unknown>>;
  semantic: Array<Record<string, unknown>>;
}

export interface DecayCandidate {
  id: string;
  confidence: number;
  decay_class: 'volatile' | 'stable' | 'permanent';
  updated_at: string;
}

function assertBatchRows(batchRows: number): number {
  // batchRows is interpolated into the IN TRANSACTIONS clause (Cypher cannot
  // parameterize it) — accept only a plain bounded integer.
  if (!Number.isSafeInteger(batchRows) || batchRows < 1 || batchRows > 100_000) {
    throw new Error(`lifecycle_store:invalid_batch_rows`);
  }
  return batchRows;
}

export class LifecycleStore {
  constructor(private driver: Driver) {}

  /**
   * Distinct (tenant_id, scope) pairs across Episodic + Semantic memory. The
   * coalesce(tenant_id, default) idiom mirrors SemanticStore.existingIds so
   * legacy null-tenant rows group under the default tenant.
   */
  async listScopes(): Promise<LifecycleScope[]> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `MATCH (m)
         WHERE (m:Episodic OR m:Semantic) AND m.scope IS NOT NULL
         RETURN DISTINCT coalesce(m.tenant_id, $defaultTenant) AS tenant, m.scope AS scope
         ORDER BY tenant, scope`,
        { defaultTenant: DEFAULT_TENANT },
      );
      return result.records.map((r) => ({
        tenantId: r.get('tenant') as string,
        scope: r.get('scope') as string,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Read-only retention plan for one (tenant, scope) group. Per label:
   * every non-protected row older than `cutoffIso` is doomed; then, if the
   * surviving non-protected count still exceeds `budget`, the oldest survivors
   * are doomed down to the budget. Protected-tier rows are excluded from BOTH
   * the doomed set and the budget accounting (they neither get deleted nor
   * crowd out deletable rows) and are returned as a count for the run log.
   * observed_at is an app-written ISO-8601 string on both labels, so
   * lexicographic comparison against an ISO cutoff is sound.
   */
  async planSidecarDeletions(
    tenantId: string,
    projectScope: string,
    cutoffIso: string,
    budget: number,
  ): Promise<SidecarPlan> {
    const session = this.driver.session();
    const plan = {} as SidecarPlan;
    try {
      for (const label of SIDECAR_LABELS) {
        const rowsResult = await session.run(
          `MATCH (x:${label} {tenant_id: $tenantId, project_scope: $projectScope})
           WHERE x.recommended_tier <> 'protected'
           RETURN properties(x) AS props
           ORDER BY x.observed_at ASC, x.id ASC`,
          { tenantId, projectScope },
        );
        const rows = rowsResult.records.map((r) => r.get('props') as Record<string, unknown>);
        const protectedResult = await session.run(
          `MATCH (x:${label} {tenant_id: $tenantId, project_scope: $projectScope})
           WHERE x.recommended_tier = 'protected'
           RETURN count(x) AS c`,
          { tenantId, projectScope },
        );
        const protectedCount = toInt(protectedResult.records[0]?.get('c') ?? 0);

        const expired = rows.filter((r) => typeof r.observed_at === 'string' && (r.observed_at as string) < cutoffIso);
        const surviving = rows.filter((r) => !expired.includes(r));
        // Oldest-first trim down to budget; `surviving` is already ASC by observed_at.
        const excess = Math.max(0, surviving.length - budget);
        const overBudget = surviving.slice(0, excess);
        plan[label] = {
          doomed: [...expired, ...overBudget],
          expiredCount: expired.length,
          overBudgetCount: overBudget.length,
          keptCount: surviving.length - excess,
          protectedCount,
        };
      }
      return plan;
    } finally {
      await session.close();
    }
  }

  /**
   * Hard-delete planned sidecar rows by id. The WHERE re-asserts tenant, scope,
   * AND the protected-tier exemption even though the plan already excluded
   * protected rows — a row promoted to protected between plan and delete (or a
   * stale plan replay) must still survive. DETACH DELETE severs
   * OBSERVES/RECOMMENDS_FOR. Returns deleted counts per label.
   */
  async deleteSidecars(
    tenantId: string,
    projectScope: string,
    idsByLabel: Partial<Record<SidecarLabel, string[]>>,
    batchRows: number,
  ): Promise<Record<SidecarLabel, number>> {
    const rows = assertBatchRows(batchRows);
    const deleted = { AdmissionObservation: 0, AdmissionRoutingRecommendation: 0 } as Record<SidecarLabel, number>;
    const session = this.driver.session();
    try {
      for (const label of SIDECAR_LABELS) {
        const ids = idsByLabel[label] ?? [];
        if (ids.length === 0) continue;
        const result = await session.run(
          `MATCH (x:${label} {tenant_id: $tenantId, project_scope: $projectScope})
           WHERE x.id IN $ids AND x.recommended_tier <> 'protected'
           CALL { WITH x DETACH DELETE x } IN TRANSACTIONS OF ${rows} ROWS
           RETURN count(x) AS c`,
          { tenantId, projectScope, ids },
        );
        deleted[label] = toInt(result.records[0]?.get('c') ?? 0);
      }
      return deleted;
    } finally {
      await session.close();
    }
  }

  /**
   * Read-only archive plan for one (tenant, scope) group under the closed
   * protection table (§2.5): a node is planned only when NONE of P1-P6 hold,
   * it is unreferenced, and it is past half_life x multiplier.
   *
   * Anchors: Semantic updated_at (reset by every confidence application, so it
   * measures time since last reinforcement); Episodic created_at (episodes have
   * no updated_at). Episodes carry no decay_class, so the stable half-life
   * applies (conservative vs volatile).
   *
   * `pendingIds` = P6: ids appearing in affected_ids of any pending proposal.
   * Embeddings are projected out (repo convention: they never leave the graph
   * on a read wire; archive rollback is a boolean flip, not a re-insert).
   */
  async planArchive(
    tenantId: string,
    scope: string,
    cutoffs: { volatile: string; stable: string; episodic: string },
    pendingIds: string[],
  ): Promise<ArchivePlan> {
    const session = this.driver.session();
    try {
      const semanticResult = await session.run(
        `MATCH (s:Semantic)
         WHERE coalesce(s.tenant_id, $defaultTenant) = $tenantId
           AND s.scope = $scope
           AND coalesce(s.archived, false) = false
           AND coalesce(s.memory_type, '') <> 'decision'
           AND s.decay_class <> 'permanent'
           // P2 is deliberately conservative: the EXISTS does not filter the
           // edge's invalid_at — an invalidated reinforcement still protects.
           AND NOT EXISTS { MATCH (:Episodic)-[:REINFORCES]->(s) }
           AND NOT s.id IN $pendingIds
           AND ((s.decay_class = 'volatile' AND s.updated_at < $volatileCutoff)
             OR (s.decay_class = 'stable' AND s.updated_at < $stableCutoff))
         RETURN s { .*, embedding: null } AS props
         ORDER BY s.updated_at ASC, s.id ASC`,
        {
          tenantId, scope, pendingIds,
          defaultTenant: DEFAULT_TENANT,
          volatileCutoff: cutoffs.volatile,
          stableCutoff: cutoffs.stable,
        },
      );
      const episodicResult = await session.run(
        `MATCH (e:Episodic)
         WHERE coalesce(e.tenant_id, $defaultTenant) = $tenantId
           AND e.scope = $scope
           AND coalesce(e.archived, false) = false
           AND coalesce(e.memory_type, '') <> 'decision'
           AND coalesce(e.outcome, '') <> 'approved'
           // P5: a protected-tier sidecar recommendation shields the episode.
           AND NOT EXISTS { MATCH (:AdmissionObservation {recommended_tier: 'protected'})-[:OBSERVES]->(e) }
           AND NOT EXISTS { MATCH (:AdmissionRoutingRecommendation {recommended_tier: 'protected'})-[:RECOMMENDS_FOR]->(e) }
           AND NOT e.id IN $pendingIds
           AND NOT EXISTS { MATCH (:Semantic)-[:PROMOTED_FROM]->(e) }
           AND NOT EXISTS { MATCH ()-[:CORRECTS|REINFORCES|CONTRADICTS]->(e) }
           AND e.created_at < $episodicCutoff
         RETURN e { .*, embedding: null } AS props
         ORDER BY e.created_at ASC, e.id ASC`,
        {
          tenantId, scope, pendingIds,
          defaultTenant: DEFAULT_TENANT,
          episodicCutoff: cutoffs.episodic,
        },
      );
      return {
        semantic: semanticResult.records.map((r) => r.get('props') as Record<string, unknown>),
        episodic: episodicResult.records.map((r) => r.get('props') as Record<string, unknown>),
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Reversible archive flip on Episodic/Semantic nodes by id. Idempotent
   * (SET archived = true twice is a no-op) and batched. Deliberately does NOT
   * touch updated_at — bumping it would reset the decay/archive clock.
   */
  async setArchived(ids: string[], archived: boolean, now: string, batchRows: number): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = assertBatchRows(batchRows);
    const session = this.driver.session();
    try {
      const result = await session.run(
        `MATCH (n)
         WHERE (n:Episodic OR n:Semantic) AND n.id IN $ids
         CALL { WITH n
           SET n.archived = $archived,
               n.archived_at = CASE WHEN $archived THEN $now ELSE n.archived_at END
         } IN TRANSACTIONS OF ${rows} ROWS
         RETURN count(n) AS c`,
        { ids, archived, now },
      );
      return toInt(result.records[0]?.get('c') ?? 0);
    } finally {
      await session.close();
    }
  }

  /**
   * Semantic decay candidates for one (tenant, scope) group: non-archived,
   * non-protected (P1 decision, P2 reinforcement edge, P3 permanent class),
   * outside the re-emission cooldown. P6 (pending proposals) is applied by the
   * engine against the live pending set.
   */
  async findDecayCandidates(
    tenantId: string,
    scope: string,
    cooldownCutoffIso: string,
  ): Promise<DecayCandidate[]> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `MATCH (s:Semantic)
         WHERE coalesce(s.tenant_id, $defaultTenant) = $tenantId
           AND s.scope = $scope
           AND coalesce(s.archived, false) = false
           AND coalesce(s.memory_type, '') <> 'decision'
           AND s.decay_class <> 'permanent'
           // Conservative on purpose: no invalid_at filter — an invalidated
           // reinforcement edge still protects the target from decay proposals.
           AND NOT EXISTS { MATCH (:Episodic)-[:REINFORCES]->(s) }
           AND (s.decay_proposed_at IS NULL OR s.decay_proposed_at < $cooldownCutoff)
         RETURN s.id AS id, s.confidence AS confidence,
                s.decay_class AS decay_class, s.updated_at AS updated_at
         ORDER BY s.updated_at ASC, s.id ASC`,
        { tenantId, scope, defaultTenant: DEFAULT_TENANT, cooldownCutoff: cooldownCutoffIso },
      );
      return result.records.map((r) => ({
        id: r.get('id') as string,
        confidence: r.get('confidence') as number,
        decay_class: r.get('decay_class') as DecayCandidate['decay_class'],
        updated_at: r.get('updated_at') as string,
      }));
    } finally {
      await session.close();
    }
  }

  // ─── MEM-007 anti-entropy: episodic → project REFERENCES re-link ──────────
  //
  // Bootstrap heals orphans once at bootstrap time (bootstrap-graph.ts step 5)
  // and never again; this is the recurring, bounded, idempotent version of the
  // SAME healed predicate. It never creates Entity roots and never touches
  // memory content — the only write is a REFERENCES relationship MERGE.

  /**
   * Existing bootstrapped project roots. The repair MATCHes these — it never
   * MERGEs one (bootstrap owns Entity creation).
   */
  async listProjectRoots(): Promise<string[]> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `MATCH (proj:Entity {type: 'project'})
         RETURN proj.name AS name
         ORDER BY name`,
      );
      return result.records.map((r) => r.get('name') as string);
    } finally {
      await session.close();
    }
  }

  /**
   * Derive a project's canonical scope tag defensively — the project Entity
   * stores name/type/description but NOT its tag (project_tag is bootstrap
   * input only). Primary, self-grounding: the dominant non-null ep.scope among
   * episodes ALREADY linked to the root (bootstrap's own step-5 linking seeded
   * these). Fallback: `project:` + lowercased name, accepted only if at least
   * one Episodic carries that scope or tag (never invents a tag for a project
   * whose tag differs from its name). Neither => null; the engine skips the
   * project and reports it rather than guessing (mis-linking is worse than
   * waiting for an operator).
   */
  async deriveProjectTag(projectName: string): Promise<string | null> {
    const session = this.driver.session();
    try {
      const linked = await session.run(
        `MATCH (ep:Episodic)-[:REFERENCES]->(:Entity {name: $projectName, type: 'project'})
         WHERE ep.scope IS NOT NULL
         RETURN ep.scope AS scope, count(*) AS c
         ORDER BY c DESC, scope ASC
         LIMIT 1`,
        { projectName },
      );
      const dominant = linked.records[0]?.get('scope') as string | undefined;
      if (dominant) return dominant;

      const candidate = `project:${projectName.toLowerCase()}`;
      const grounded = await session.run(
        `MATCH (ep:Episodic)
         WHERE ep.scope = $candidate OR $candidate IN ep.tags
         RETURN count(ep) AS c`,
        { candidate },
      );
      return toInt(grounded.records[0]?.get('c') ?? 0) > 0 ? candidate : null;
    } finally {
      await session.close();
    }
  }

  /**
   * Re-link orphaned episodics to an EXISTING project root. The ownership
   * predicate reuses bootstrap-graph.ts step 5 byte-for-byte in structure:
   * structured scope/tags equality first, then the BRACKETED legacy task token
   * `[project:<name>]` — the brackets are what killed the gap-13/T7 substring
   * aliasing ('foo' bootstrap linked 'project:foobar' episodes on a bare
   * CONTAINS). Two deliberate changes from bootstrap: MERGE instead of CREATE
   * (idempotent under a concurrent bootstrap re-run) and a batch LIMIT so one
   * run is bounded and repeated runs converge. The NOT guard and the project
   * MATCH both name type:'project' so a same-named non-project Entity neither
   * satisfies the guard (permanently excluding an episode) nor receives edges.
   */
  async linkOrphanEpisodics(
    projectName: string,
    canonTag: string,
    batchRows: number,
  ): Promise<{ linked: number; ids: string[] }> {
    const batch = assertBatchRows(batchRows);
    const taskTag = `[project:${projectName}]`;
    const session = this.driver.session();
    try {
      const result = await session.run(
        `MATCH (ep:Episodic)
         WHERE (ep.scope = $canonTag OR $canonTag IN ep.tags OR ep.task CONTAINS $taskTag)
           AND NOT (ep)-[:REFERENCES]->(:Entity {name: $projectName, type: 'project'})
         WITH ep LIMIT toInteger($batch)
         MATCH (proj:Entity {name: $projectName, type: 'project'})
         MERGE (ep)-[:REFERENCES]->(proj)
         RETURN count(ep) AS linked, collect(ep.id) AS ids`,
        { canonTag, taskTag, projectName, batch },
      );
      const rec = result.records[0];
      return {
        linked: toInt(rec?.get('linked') ?? 0),
        ids: (rec?.get('ids') as string[] | undefined) ?? [],
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Emission-time cooldown stamp. A single-property SET that never touches
   * updated_at (updated_at is the decay anchor; stamping must not reset it).
   * Non-destructive bookkeeping — exempt from export-before-mutate.
   */
  async stampDecayProposedAt(id: string, now: string): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        'MATCH (s:Semantic {id: $id}) SET s.decay_proposed_at = $now',
        { id, now },
      );
    } finally {
      await session.close();
    }
  }
}

function toInt(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && 'toNumber' in value) {
    return (value as { toNumber(): number }).toNumber();
  }
  return Number(value);
}
