// packages/core/src/hebbian.ts
//
// MEM-006H HebbianEngine: drains the per-tenant retrieval-feedback ring
// (amp:feedback[:<tenant>]:log) on the `memberry lifecycle` timer, BEFORE
// LifecycleEngine.run, behind the MEMBERRY_LIFECYCLE_HEBBIAN sub-flag, and
// applies batched usage updates (last_accessed / access_count) to the graph.
// The hot retrieval path is untouched: the ring is the buffer, this timer is
// the only write moment. Drain is destructive-by-design — the ring's LIST has
// no reader anywhere in the repo (ranking reads only the boost ZSETs), and
// RPOP consumes from the tail while the writer lpushes the head, so drain and
// writer never contend over the same list end.
//
// A separate engine mirroring AntiEntropyEngine's shape (construction gate,
// artifact-first, log-and-continue failures) so no LifecycleStorePort fake in
// any existing test needs edits.

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeArtifactSync, type LifecycleScopeRef } from './lifecycle.js';
import type { HebbianConfig, LifecycleConfig } from './config/lifecycle.js';
import { DEFAULT_TENANT } from './types.js';

/** Per-tenant bound on one nightly drain — a spammed ring stays bounded. */
export const HEBBIAN_DRAIN_CAP_RECORDS = 50_000;

/** The berry_feedback source_type vocabulary (retrieval feedback.ts). */
const FEEDBACK_SOURCE_TYPES = new Set(['semantic', 'episodic', 'symbol', 'arch_entity', 'aspect', 'fact']);
/** Only memory nodes carry usage properties. */
const MEMORY_SOURCE_TYPES = new Set(['semantic', 'episodic']);
const MAX_RESULT_ID_CODE_UNITS = 500;

/** Ring key builder — mirrors retrieval feedback.ts feedbackLogKey (the
 *  default tenant keeps the legacy un-namespaced key). */
function feedbackLogKey(tenant: string): string {
  return tenant === DEFAULT_TENANT ? 'amp:feedback:log' : `amp:feedback:${tenant}:log`;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed';
}

// ─── Ports (implemented by the raw Redis client and @memberry/neo4j LifecycleStore) ──

export interface HebbianRingPort {
  /** RPOP key count — [] when empty (ioredis supports rpop(key, count) natively). */
  rpopBatch(key: string, count: number): Promise<string[]>;
  /** LLEN key — dry-run reporting only (a dry run must not consume the ring). */
  llen(key: string): Promise<number>;
}

export interface HebbianUsageRow {
  id: string;
  /** Count of useful entries (was_useful:false touches recency only). */
  inc: number;
  /** Max clamped-to-now timestamp across all entries for this id. */
  ts: string;
}

export interface HebbianGraphPort {
  listScopes(): Promise<LifecycleScopeRef[]>;
  applyUsage(
    tenantId: string, rows: HebbianUsageRow[], batchRows: number,
  ): Promise<{ applied: Array<{ id: string; scope: string | null }> }>;
}

export interface HebbianEngineDeps {
  ring: HebbianRingPort;
  graph: HebbianGraphPort;
  config: HebbianConfig;
  /** Reused MEM-006 knobs: same dry-run, same batch bound, same artifact root. */
  lifecycle: Pick<LifecycleConfig, 'dryRun' | 'batchRows' | 'exportDir'>;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** Injectable artifact writer for tests (default: fsync-before-return). */
  writeArtifact?: (filePath: string, json: string) => void;
}

export interface HebbianTenantResult {
  tenant_id: string;
  ring_key: string;
  /** null when nothing was drained (nothing to persist) and on dry runs. */
  artifact_path: string | null;
  /** Dry-run only: LLEN of the ring; null on a live drain. */
  ring_length: number | null;
  drained: number;
  malformed: number;
  non_memory_source: number;
  unmatched: number;
  applied: number;
}

export interface HebbianRunResult {
  run_id: string;
  started_at: string;
  dry_run: boolean;
  tenants: HebbianTenantResult[];
  failures: Array<{ tenant_id: string; error: string }>;
}

export class HebbianEngine {
  private ring: HebbianRingPort;
  private graph: HebbianGraphPort;
  private lifecycle: Pick<LifecycleConfig, 'dryRun' | 'batchRows' | 'exportDir'>;
  private clock: () => Date;
  private artifactWriter: (filePath: string, json: string) => void;

  constructor(deps: HebbianEngineDeps) {
    // Construction gate, not just a run gate (AntiEntropyEngine precedent):
    // disabled sub-flag => the engine must not even exist.
    if (deps.config.mode !== 'live') {
      throw new Error('hebbian:not_live');
    }
    this.ring = deps.ring;
    this.graph = deps.graph;
    this.lifecycle = deps.lifecycle;
    this.clock = deps.now ?? ((): Date => new Date());
    this.artifactWriter = deps.writeArtifact ?? writeArtifactSync;
  }

  /**
   * One drain pass over every tenant that owns graph nodes (plus the default
   * tenant). A throw in one tenant logs and continues; callers exit non-zero
   * when `failures` is non-empty. Dry runs report LLEN and consume nothing.
   */
  async run(options: { dryRun?: boolean } = {}): Promise<HebbianRunResult> {
    const now = this.clock();
    const nowIso = now.toISOString();
    const dryRun = options.dryRun === true || this.lifecycle.dryRun;
    const result: HebbianRunResult = {
      run_id: `hebbian-${randomUUID()}`,
      started_at: nowIso,
      dry_run: dryRun,
      tenants: [],
      failures: [],
    };

    // A ring for a tenant with no graph presence is left alone (its records
    // could not match any node); the default tenant is always drained.
    const tenants = new Set<string>([DEFAULT_TENANT]);
    for (const scopeRef of await this.graph.listScopes()) tenants.add(scopeRef.tenantId);

    for (const tenant of [...tenants].sort()) {
      try {
        result.tenants.push(await this.drainTenant(tenant, now.getTime(), nowIso, dryRun, result.run_id));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[hebbian] tenant ${tenant} drain failed: ${message}`);
        result.failures.push({ tenant_id: tenant, error: message });
      }
    }
    return result;
  }

  private async drainTenant(
    tenant: string,
    nowMs: number,
    nowIso: string,
    dryRun: boolean,
    runId: string,
  ): Promise<HebbianTenantResult> {
    const key = feedbackLogKey(tenant);
    const tenantResult: HebbianTenantResult = {
      tenant_id: tenant,
      ring_key: key,
      artifact_path: null,
      ring_length: null,
      drained: 0,
      malformed: 0,
      non_memory_source: 0,
      unmatched: 0,
      applied: 0,
    };
    if (dryRun) {
      tenantResult.ring_length = await this.ring.llen(key);
      return tenantResult;
    }

    // ── 1. Destructive tail-drain (each entry consumed exactly once) ─────
    const rowsById = new Map<string, { inc: number; ts: string }>();
    while (tenantResult.drained < HEBBIAN_DRAIN_CAP_RECORDS) {
      const batch = await this.ring.rpopBatch(
        key, Math.min(this.lifecycle.batchRows, HEBBIAN_DRAIN_CAP_RECORDS - tenantResult.drained),
      );
      if (batch.length === 0) break;
      tenantResult.drained += batch.length;
      for (const raw of batch) this.ingest(raw, nowMs, rowsById, tenantResult);
    }
    if (tenantResult.drained === 0) return tenantResult;

    const rows: HebbianUsageRow[] = [...rowsById]
      .map(([id, r]) => ({ id, inc: r.inc, ts: r.ts }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));

    // ── 2. Artifact BEFORE any graph write (fsync; also the sole durable
    // copy of the drained records — a post-artifact crash is replayable) ──
    const artifactPath = path.join(
      this.lifecycle.exportDir, 'lifecycle',
      `${nowIso.replace(/[:.]/g, '-')}-hebbian-${slug(tenant)}.json`,
    );
    tenantResult.artifact_path = artifactPath;
    let appliedRows: Array<{ id: string; scope: string | null; inc: number; last_accessed: string }> =
      rows.map((r) => ({ id: r.id, scope: null, inc: r.inc, last_accessed: r.ts }));
    const writeArtifact = (): void => {
      this.artifactWriter(artifactPath, `${JSON.stringify({
        version: 1,
        run_id: runId,
        tenant_id: tenant,
        started_at: nowIso,
        dry_run: false,
        drained: tenantResult.drained,
        malformed: tenantResult.malformed,
        non_memory_source: tenantResult.non_memory_source,
        unmatched: tenantResult.unmatched,
        applied: appliedRows,
        replay_note: 're-apply via applyUsage rows above; increments are not idempotent (heuristic counter)',
      }, null, 2)}\n`);
    };
    writeArtifact();

    // ── 3. Batched graph write, then the audit-trail rewrite ─────────────
    if (rows.length > 0) {
      const { applied } = await this.graph.applyUsage(tenant, rows, this.lifecycle.batchRows);
      // Matched = the UNION of both labels' hits: a Semantic hit must not
      // count as unmatched just because the Episodic pass missed it.
      const matched = new Set(applied.map((a) => a.id));
      const scopeById = new Map(applied.map((a) => [a.id, a.scope]));
      tenantResult.applied = matched.size;
      tenantResult.unmatched = rows.filter((r) => !matched.has(r.id)).length;
      appliedRows = rows
        .filter((r) => matched.has(r.id))
        .map((r) => ({ id: r.id, scope: scopeById.get(r.id) ?? null, inc: r.inc, last_accessed: r.ts }));
      writeArtifact();
    }
    return tenantResult;
  }

  /** §2.3 record mapping: validate, clamp, aggregate; count the rest. */
  private ingest(
    raw: string,
    nowMs: number,
    rowsById: Map<string, { inc: number; ts: string }>,
    counters: { malformed: number; non_memory_source: number },
  ): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      counters.malformed += 1;
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      counters.malformed += 1;
      return;
    }
    const record = parsed as Record<string, unknown>;
    const resultId = record.result_id;
    const sourceType = record.source_type;
    const tsMs = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
    if (
      typeof resultId !== 'string' || resultId.length === 0 || resultId.length > MAX_RESULT_ID_CODE_UNITS
      || typeof sourceType !== 'string' || !FEEDBACK_SOURCE_TYPES.has(sourceType)
      || typeof record.was_useful !== 'boolean'
      || !Number.isFinite(tsMs)
    ) {
      counters.malformed += 1;
      return;
    }
    if (!MEMORY_SOURCE_TYPES.has(sourceType)) {
      counters.non_memory_source += 1;
      return;
    }
    // Clamp to now: a forged future timestamp must not grant years of decay
    // protection via a far-future last_accessed.
    const ts = new Date(Math.min(tsMs, nowMs)).toISOString();
    const inc = record.was_useful ? 1 : 0;
    const existing = rowsById.get(resultId);
    if (!existing) {
      rowsById.set(resultId, { inc, ts });
    } else {
      existing.inc += inc;
      if (ts > existing.ts) existing.ts = ts;
    }
  }
}
