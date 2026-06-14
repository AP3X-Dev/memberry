// packages/neo4j/src/injection-log.ts
//
// Injection telemetry: one :InjectionLog node per context injection (load /
// context / ask / hook), recording which memory ids were handed to an agent,
// in what order, with what scores. Usage labels (used / ignored / contradicted)
// are attached later by the outcome loop, which reads session transcripts.
//
// Design notes (mirrors audit.ts):
//   - append() is best-effort and must NEVER throw into the caller's path —
//     telemetry must not fail a user's load(). It logs and returns null.
//   - Records are append-only; the only mutation is the usage label, which is
//     written once when an observation arrives (markUsage).

import neo4j, { type Driver } from 'neo4j-driver';
import { nanoid } from 'nanoid';
import type { InjectionLogEntry, InjectionRecord, InjectionUsage } from '@memberry/core';

export class InjectionLogStore {
  constructor(private driver: Driver) {}

  /** Append an injection record. Best-effort: returns the id, or null on failure. */
  async append(entry: InjectionLogEntry): Promise<string | null> {
    const id = `inj-${nanoid()}`;
    const session = this.driver.session();
    try {
      await session.run(
        `CREATE (i:InjectionLog {
           id: $id, session_id: $session_id, scope: $scope, task: $task,
           source_ids: $source_ids, scores: $scores, tokens: $tokens,
           channel: $channel, tenant_id: $tenant_id,
           usage: 'unknown', injected_at: $injected_at
         })`,
        {
          id,
          session_id: entry.session_id ?? null,
          scope: entry.scope ?? null,
          task: entry.task != null ? entry.task.slice(0, 500) : null,
          source_ids: entry.source_ids,
          // Stored as floats on purpose: telemetry never does Neo4j-integer
          // arithmetic, so keeping everything FLOAT sidesteps BigInt coercion.
          scores: entry.scores ?? null,
          tokens: entry.tokens ?? null,
          channel: entry.channel ?? null,
          tenant_id: entry.tenant_id ?? null,
          injected_at: new Date().toISOString(),
        },
      );
      return id;
    } catch (err) {
      console.error('[memberry-injection] failed to append injection record (non-fatal):', err instanceof Error ? err.message : err);
      return null;
    } finally {
      await session.close();
    }
  }

  /** Attach an observed usage label to an injection. */
  async markUsage(id: string, usage: InjectionUsage, detail?: string): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        `MATCH (i:InjectionLog {id: $id})
         SET i.usage = $usage, i.usage_detail = $detail, i.usage_observed_at = $at`,
        { id, usage, detail: detail ?? null, at: new Date().toISOString() },
      );
    } finally {
      await session.close();
    }
  }

  /** Query injections, most-recent first, optionally filtered. */
  async query(opts: { session_id?: string; scope?: string; usage?: InjectionUsage; limit?: number } = {}): Promise<InjectionRecord[]> {
    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 50)), 500);
    const session = this.driver.session({ defaultAccessMode: neo4j.session.READ });
    try {
      const filters: string[] = [];
      if (opts.session_id) filters.push('i.session_id = $session_id');
      if (opts.scope) filters.push('i.scope = $scope');
      if (opts.usage) filters.push('i.usage = $usage');
      const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
      const res = await session.run(
        `MATCH (i:InjectionLog) ${where}
         RETURN i ORDER BY i.injected_at DESC LIMIT $limit`,
        { session_id: opts.session_id, scope: opts.scope, usage: opts.usage, limit: neo4j.int(limit) },
      );
      return res.records.map((r) => {
        const p = r.get('i').properties as Record<string, unknown>;
        return {
          id: String(p.id),
          session_id: p.session_id == null ? undefined : String(p.session_id),
          scope: p.scope == null ? undefined : String(p.scope),
          task: p.task == null ? undefined : String(p.task),
          source_ids: Array.isArray(p.source_ids) ? (p.source_ids as string[]) : [],
          scores: Array.isArray(p.scores) ? (p.scores as number[]) : undefined,
          tokens: p.tokens == null ? undefined : Number(p.tokens),
          channel: p.channel == null ? undefined : String(p.channel),
          tenant_id: p.tenant_id == null ? undefined : String(p.tenant_id),
          usage: (p.usage as InjectionUsage) ?? 'unknown',
          usage_detail: p.usage_detail == null ? undefined : String(p.usage_detail),
          usage_observed_at: p.usage_observed_at == null ? undefined : String(p.usage_observed_at),
          injected_at: String(p.injected_at),
        };
      });
    } finally {
      await session.close();
    }
  }
}
