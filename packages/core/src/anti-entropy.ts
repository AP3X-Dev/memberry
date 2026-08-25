// packages/core/src/anti-entropy.ts
//
// MEM-007 AntiEntropyEngine: nightly graph/stream/queue/publication drift pass,
// run by `memberry lifecycle` AFTER LifecycleEngine.run behind the
// MEMBERRY_LIFECYCLE_ANTIENTROPY sub-flag. Repair is re-link/reclaim/GC ONLY:
// the only writes are a REFERENCES relationship MERGE (graph orphan re-link)
// and XGROUP DELCONSUMER on empty-PEL idle consumer names. It never deletes or
// mutates memory content, never touches sidecars, and never creates Entity
// roots. Everything else is verification + reporting attributed to the
// existing healer (spec §0 narrowings).
//
// A separate engine, not a LifecycleEngine phase: LifecycleEngine iterates
// (tenant, scope) pairs over a graph-only store; this pass iterates project
// roots and Redis structures and needs both stores.

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeArtifactSync } from './lifecycle.js';
import type { AntiEntropyConfig, LifecycleConfig } from './config/lifecycle.js';

/** The consolidation consumer group on amp:signals (consolidation.ts). */
const SIGNALS_GROUP = 'consolidation';
/** Publication version keys (shapes owned by the MCP bootstrap). */
const WIKI_DIRTY_KEY = 'memberry:wiki:generation:dirty';
const WIKI_PUBLISHED_KEY = 'memberry:wiki:generation:published';

// ─── Ports (implemented by LifecycleStore / SignalStream / EpisodicBuffer /
//     ConsolidationQueue / ExtractionQueue / the raw Redis client) ──────────

export interface AntiEntropyGraphPort {
  listProjectRoots(): Promise<string[]>;
  deriveProjectTag(projectName: string): Promise<string | null>;
  linkOrphanEpisodics(
    projectName: string, canonTag: string, batchRows: number,
  ): Promise<{ linked: number; ids: string[] }>;
}

export interface AntiEntropyStreamsPort {
  groupHealth(group: string): Promise<{
    pelCount: number;
    oldestIdleMs: number;
    consumers: Array<{ name: string; pending: number; idleMs: number }>;
  }>;
  removeIdleConsumers(group: string, minIdleMs: number): Promise<string[]>;
  bufferLength(): Promise<number>;
}

export interface AntiEntropyQueuePort {
  size(): Promise<number>;
  peek(count: number): Promise<Array<{ member: string; score: number }>>;
}

export interface AntiEntropyExtractionPort {
  stats(): Promise<{ pending: number; inflight: number; deadLettered: number }>;
}

export interface AntiEntropyKvPort {
  mget(...keys: string[]): Promise<(string | null)[]>;
}

export interface AntiEntropyEngineDeps {
  graph: AntiEntropyGraphPort;
  streams: AntiEntropyStreamsPort;
  queue: AntiEntropyQueuePort;
  extraction: AntiEntropyExtractionPort;
  kv: AntiEntropyKvPort;
  config: AntiEntropyConfig;
  /** Reused MEM-006 knobs: same dry-run, same batch bound, same artifact root. */
  lifecycle: Pick<LifecycleConfig, 'dryRun' | 'batchRows' | 'exportDir'>;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** Injectable artifact writer for tests (default: fsync-before-return). */
  writeArtifact?: (filePath: string, json: string) => void;
}

// ─── Run result / artifact sections ─────────────────────────────────────────

export interface AntiEntropyProjectResult {
  project: string;
  canon_tag: string | null;
  task_tag: string | null;
  linked: number;
  linked_ids: string[];
  skipped_reason: 'ambiguous_tag' | 'tag_conflict' | null;
}

export interface AntiEntropyRunResult {
  run_id: string;
  started_at: string;
  dry_run: boolean;
  artifact_path: string;
  graph_orphans: { projects: AntiEntropyProjectResult[] };
  signals: {
    group: string;
    pel_count: number;
    oldest_idle_ms: number;
    consumers: number;
    consumers_removed: string[];
  };
  extraction: { pending: number; inflight: number; dead_lettered: number };
  episodic_buffer: { length: number };
  queue: { size: number; top: Array<{ member: string; score: number }> };
  publication: { dirty: number; published: number; drift: boolean; note?: string };
  failures: Array<{ class: string; error: string }>;
}

export class AntiEntropyEngine {
  private graph: AntiEntropyGraphPort;
  private streams: AntiEntropyStreamsPort;
  private queue: AntiEntropyQueuePort;
  private extraction: AntiEntropyExtractionPort;
  private kv: AntiEntropyKvPort;
  private config: AntiEntropyConfig;
  private lifecycle: Pick<LifecycleConfig, 'dryRun' | 'batchRows' | 'exportDir'>;
  private clock: () => Date;
  private artifactWriter: (filePath: string, json: string) => void;

  constructor(deps: AntiEntropyEngineDeps) {
    // Construction gate, not just a run gate: when the sub-flag is disabled
    // the engine must not even exist, so MEM-006 behavior is untouched by
    // definition (the CLI checks the flag before constructing; this throw
    // pins the invariant against any future caller).
    if (deps.config.mode !== 'live') {
      throw new Error('anti_entropy:not_live');
    }
    this.graph = deps.graph;
    this.streams = deps.streams;
    this.queue = deps.queue;
    this.extraction = deps.extraction;
    this.kv = deps.kv;
    this.config = deps.config;
    this.lifecycle = deps.lifecycle;
    this.clock = deps.now ?? ((): Date => new Date());
    this.artifactWriter = deps.writeArtifact ?? writeArtifactSync;
  }

  /**
   * One anti-entropy pass: read/plan every drift class → write the artifact
   * (fsync; dry-run stops here; a failed write aborts with zero mutations) →
   * repair (each action individually idempotent) → rewrite the artifact with
   * the actual actions (the audit trail). A failing drift class logs and
   * continues; callers exit non-zero when `failures` is non-empty.
   */
  async run(options: { dryRun?: boolean } = {}): Promise<AntiEntropyRunResult> {
    const now = this.clock();
    const nowIso = now.toISOString();
    const dryRun = options.dryRun === true || this.lifecycle.dryRun;
    const failures: AntiEntropyRunResult['failures'] = [];
    const fail = (cls: string, err: unknown): void => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[anti-entropy] ${cls} failed: ${message}`);
      failures.push({ class: cls, error: message });
    };

    // ── 1. Plan (read-only, per drift class, log-and-continue) ───────────
    const projects: AntiEntropyProjectResult[] = [];
    try {
      const roots = await this.graph.listProjectRoots();
      const tags = new Map<string, string | null>();
      for (const root of roots) tags.set(root, await this.graph.deriveProjectTag(root));
      // A tag claimed by two roots is contested: linking on it risks
      // cross-project edges, so BOTH are skipped and reported.
      const tagOwners = new Map<string, number>();
      for (const tag of tags.values()) {
        if (tag) tagOwners.set(tag, (tagOwners.get(tag) ?? 0) + 1);
      }
      for (const root of roots) {
        const tag = tags.get(root) ?? null;
        const skipped: AntiEntropyProjectResult['skipped_reason'] =
          tag === null ? 'ambiguous_tag' : (tagOwners.get(tag) ?? 0) > 1 ? 'tag_conflict' : null;
        projects.push({
          project: root,
          canon_tag: tag,
          task_tag: tag === null ? null : `[project:${root}]`,
          linked: 0,
          linked_ids: [],
          skipped_reason: skipped,
        });
      }
    } catch (err) {
      fail('graph_orphans', err);
    }

    let signalsHealth = { pelCount: 0, oldestIdleMs: 0, consumers: [] as Array<{ name: string; pending: number; idleMs: number }> };
    try {
      signalsHealth = await this.streams.groupHealth(SIGNALS_GROUP);
    } catch (err) {
      fail('signals', err);
    }

    let extractionStats = { pending: 0, inflight: 0, deadLettered: 0 };
    try {
      extractionStats = await this.extraction.stats();
    } catch (err) {
      fail('extraction', err);
    }

    let bufferLength = 0;
    try {
      bufferLength = await this.streams.bufferLength();
    } catch (err) {
      fail('episodic_buffer', err);
    }

    // Report only (spec §0.3): the ZSET is advisory bookkeeping. Consolidation
    // never chooses a mutation from untyped queue scores and its scheduling is
    // graph-derived — pinned BEHAVIORALLY by consolidation.test.ts:656
    // (popHighest never called on the mutation path) and
    // consolidation-gds.test.ts:558/:594/:660. zrem stays consolidation's
    // durable-work acknowledgment; nothing is removed here, and an age
    // heuristic is impossible anyway (the ZSET stores no timestamps).
    let queueReport: AntiEntropyRunResult['queue'] = { size: 0, top: [] };
    try {
      queueReport = { size: await this.queue.size(), top: await this.queue.peek(10) };
    } catch (err) {
      fail('queue', err);
    }

    // Verify + report only (spec §0.4): the coordinator self-heals publication
    // while the MCP process is up; `drift: true` here means the one
    // un-self-healed case (MCP down or crash-looping) — an operator signal.
    let publication: AntiEntropyRunResult['publication'] = { dirty: 0, published: 0, drift: false };
    try {
      const [dirtyRaw, publishedRaw] = await this.kv.mget(WIKI_DIRTY_KEY, WIKI_PUBLISHED_KEY);
      if (dirtyRaw === null && publishedRaw === null) {
        publication = { dirty: 0, published: 0, drift: false, note: 'no_publication_state' };
      } else {
        const dirty = Number(dirtyRaw ?? 0);
        const published = Number(publishedRaw ?? 0);
        publication = { dirty, published, drift: dirty > published };
      }
    } catch (err) {
      fail('publication', err);
    }

    // ── 2. Artifact before ANY mutation (fsync; failure aborts the pass) ─
    const artifactPath = path.join(
      this.lifecycle.exportDir, 'anti-entropy',
      `${nowIso.replace(/[:.]/g, '-')}.json`,
    );
    const result: AntiEntropyRunResult = {
      run_id: `antientropy-${randomUUID()}`,
      started_at: nowIso,
      dry_run: dryRun,
      artifact_path: artifactPath,
      graph_orphans: { projects },
      signals: {
        group: SIGNALS_GROUP,
        pel_count: signalsHealth.pelCount,
        oldest_idle_ms: signalsHealth.oldestIdleMs,
        consumers: signalsHealth.consumers.length,
        consumers_removed: [],
      },
      extraction: {
        pending: extractionStats.pending,
        inflight: extractionStats.inflight,
        dead_lettered: extractionStats.deadLettered,
      },
      episodic_buffer: { length: bufferLength },
      queue: queueReport,
      publication,
      failures,
    };
    const writeArtifact = (): void => {
      this.artifactWriter(artifactPath, `${JSON.stringify(artifactBody(result), null, 2)}\n`);
    };
    writeArtifact();
    if (dryRun) return result;

    // ── 3. Repair (idempotent; each action recorded for the audit trail) ─
    try {
      for (const project of projects) {
        if (project.skipped_reason !== null || project.canon_tag === null) continue;
        const linked = await this.graph.linkOrphanEpisodics(
          project.project, project.canon_tag, this.lifecycle.batchRows,
        );
        project.linked = linked.linked;
        project.linked_ids = linked.ids;
      }
    } catch (err) {
      fail('graph_orphans', err);
    }

    try {
      result.signals.consumers_removed = await this.streams.removeIdleConsumers(
        SIGNALS_GROUP, this.config.consumerGcIdleMs,
      );
    } catch (err) {
      fail('signals', err);
    }

    // ── 4. Final artifact rewrite: every repair action on disk ───────────
    try {
      writeArtifact();
    } catch (err) {
      fail('artifact', err);
    }
    return result;
  }
}

/** Artifact body: the run result under the MEM-006 artifact header shape. */
function artifactBody(result: AntiEntropyRunResult): Record<string, unknown> {
  return {
    version: 1,
    run_id: result.run_id,
    started_at: result.started_at,
    dry_run: result.dry_run,
    graph_orphans: result.graph_orphans,
    signals: result.signals,
    extraction: result.extraction,
    episodic_buffer: result.episodic_buffer,
    queue: result.queue,
    publication: result.publication,
    failures: result.failures,
  };
}
