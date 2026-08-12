// packages/core/src/consolidation.ts
import { nanoid } from 'nanoid';
import type {
  ConsolidationProposal,
  StreamSignal,
  SemanticNode,
  EpisodicNode,
  AMPConfig,
  FactNode,
} from './types.js';
import { SIGNAL_WEIGHTS, DEFAULT_TENANT } from './types.js';
import { extractFacts } from './extract.js';
import { readEnv } from './config/settings.js';
import type { LlmClient } from './llm.js';

// ─── Runtime validators ──────────────────────────────────────────────────────

const VALID_DECAY_CLASSES = new Set(['volatile', 'stable', 'permanent']);

/**
 * OPT-31: an existing active fact whose confidence is at/above this threshold is
 * treated as ESTABLISHED and is protected from auto-invalidation by a *lower*-
 * confidence, extraction-derived contradiction during (auto-applied)
 * consolidation. Such a contender is instead recorded as a `tentative`
 * superseding candidate — the established fact stays active — so untrusted
 * content can't silently overwrite an authoritative fact; it must be
 * corroborated (or human-approved) to win. Override via
 * MEMBERRY_FACT_PROTECT_CONFIDENCE (clamped to [0,1]; default 0.75).
 */
const DEFAULT_FACT_PROTECT_CONFIDENCE = 0.75;
function factProtectConfidence(): number {
  const raw = readEnv('MEMBERRY_FACT_PROTECT_CONFIDENCE');
  if (raw === undefined) return DEFAULT_FACT_PROTECT_CONFIDENCE;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_FACT_PROTECT_CONFIDENCE;
  return Math.min(1, Math.max(0, parsed));
}

/**
 * Validates that a Record<string, unknown> (e.g. from Redis) has all required
 * SemanticNode fields with correct types.  Returns the validated node or throws.
 */
function parseSemanticNode(raw: Record<string, unknown>, label: string): SemanticNode {
  if (typeof raw.id !== 'string' || raw.id === '') {
    throw new Error(`${label}: missing or invalid "id" (expected non-empty string)`);
  }
  if (typeof raw.content !== 'string') {
    throw new Error(`${label}: missing or invalid "content" (expected string)`);
  }
  if (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence)) {
    throw new Error(`${label}: missing or invalid "confidence" (expected finite number)`);
  }
  if (typeof raw.signal_count !== 'number' || !Number.isFinite(raw.signal_count)) {
    throw new Error(`${label}: missing or invalid "signal_count" (expected finite number)`);
  }
  if (typeof raw.created_at !== 'string') {
    throw new Error(`${label}: missing or invalid "created_at" (expected string)`);
  }
  if (typeof raw.updated_at !== 'string') {
    throw new Error(`${label}: missing or invalid "updated_at" (expected string)`);
  }
  if (typeof raw.decay_class !== 'string' || !VALID_DECAY_CLASSES.has(raw.decay_class)) {
    throw new Error(`${label}: missing or invalid "decay_class" (expected 'volatile' | 'stable' | 'permanent')`);
  }
  if (!Array.isArray(raw.tags) || !raw.tags.every((t: unknown) => typeof t === 'string')) {
    throw new Error(`${label}: missing or invalid "tags" (expected string[])`);
  }

  return {
    id: raw.id,
    content: raw.content,
    confidence: raw.confidence,
    signal_count: raw.signal_count,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    decay_class: raw.decay_class as SemanticNode['decay_class'],
    tags: raw.tags as string[],
    ...(typeof raw.tenant_id === 'string' && raw.tenant_id !== '' ? { tenant_id: raw.tenant_id } : {}),
    ...(Array.isArray(raw.embedding) ? { embedding: raw.embedding as number[] } : {}),
  };
}

/**
 * Validates a partial SemanticNode record (the "after" side of a proposal).
 * Only present keys are type-checked; the result is Partial<SemanticNode>.
 */
function parsePartialSemanticNode(raw: Record<string, unknown>, label: string): Partial<SemanticNode> {
  const result: Partial<SemanticNode> = {};

  if ('id' in raw) {
    if (typeof raw.id !== 'string' || raw.id === '') throw new Error(`${label}: invalid "id"`);
    result.id = raw.id;
  }
  if ('content' in raw) {
    if (typeof raw.content !== 'string') throw new Error(`${label}: invalid "content"`);
    result.content = raw.content;
  }
  if ('confidence' in raw) {
    if (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence))
      throw new Error(`${label}: invalid "confidence"`);
    result.confidence = raw.confidence;
  }
  if ('signal_count' in raw) {
    if (typeof raw.signal_count !== 'number' || !Number.isFinite(raw.signal_count))
      throw new Error(`${label}: invalid "signal_count"`);
    result.signal_count = raw.signal_count;
  }
  if ('created_at' in raw) {
    if (typeof raw.created_at !== 'string') throw new Error(`${label}: invalid "created_at"`);
    result.created_at = raw.created_at;
  }
  if ('updated_at' in raw) {
    if (typeof raw.updated_at !== 'string') throw new Error(`${label}: invalid "updated_at"`);
    result.updated_at = raw.updated_at;
  }
  if ('decay_class' in raw) {
    if (typeof raw.decay_class !== 'string' || !VALID_DECAY_CLASSES.has(raw.decay_class))
      throw new Error(`${label}: invalid "decay_class"`);
    result.decay_class = raw.decay_class as SemanticNode['decay_class'];
  }
  if ('tags' in raw) {
    if (!Array.isArray(raw.tags) || !raw.tags.every((t: unknown) => typeof t === 'string'))
      throw new Error(`${label}: invalid "tags"`);
    result.tags = raw.tags as string[];
  }
  if ('tenant_id' in raw) {
    if (typeof raw.tenant_id !== 'string') throw new Error(`${label}: invalid "tenant_id"`);
    result.tenant_id = raw.tenant_id;
  }

  return result;
}

// ─── Dependency interfaces ────────────────────────────────────────────────────

export interface ConsolidationRedisLayer {
  lock: {
    acquire(scope: string, holder: string, ttlSeconds?: number): Promise<boolean>;
    release(scope: string, holder: string): Promise<boolean>;
  };
  signals: {
    consume(
      group: string,
      consumer: string,
      count: number,
      startId?: string,
    ): Promise<StreamSignal[]>;
  };
  queue: {
    popHighest(): Promise<{ member: string; score: number } | null>;
  };
  proposals: {
    save(proposal: ConsolidationProposal): Promise<void>;
    get(id: string): Promise<ConsolidationProposal | null>;
    listPending(): Promise<string[]>;
    remove(id: string): Promise<void>;
  };
  cache: {
    invalidateByNodeId(nodeId: string): Promise<number>;
  };
}

export interface ConsolidationFactLayer {
  create(fact: import('./types.js').FactNode): Promise<string>;
  findBySubjectPredicate(subject: string, predicate: string): Promise<import('./types.js').FactNode[]>;
  invalidate(id: string, invalidAt: string, supersededById?: string): Promise<void>;
  dispute(id: string): Promise<void>;
}

export interface ConsolidationNeo4jLayer {
  semantic: {
    getById(id: string): Promise<SemanticNode | null>;
    /** OPT-54: batch-fetch many Semantic nodes in one round-trip. Optional —
     *  _generateProposals falls back to per-id getById when absent. Returns one
     *  entry per FOUND id (missing ids omitted). */
    getByIds?(ids: string[]): Promise<SemanticNode[]>;
    updateConfidence(id: string, confidence: number): Promise<void>;
    supersede(oldId: string, newNode: SemanticNode): Promise<string>;
    /**
     * Promote an episodic memory into a new Semantic node.
     * `tenantId` (optional, defaults to the node's tenant_id, then DEFAULT_TENANT)
     * stamps the new Semantic so a non-default tenant can retrieve its own
     * consolidated knowledge. Optional for backward compatibility — layers that
     * don't implement it simply have no promote path.
     */
    promoteFromEpisodic?(
      episodicId: string,
      newNode: SemanticNode,
      tenantId?: string,
    ): Promise<string>;
  };
  /**
   * Optional episodic accessor. When present, the engine reads source episodes'
   * `tenant_id` to determine which tenant a promoted Semantic node belongs to.
   * Optional for backward compatibility — without it, promoted semantics fall
   * back to DEFAULT_TENANT.
   */
  episodic?: {
    getById(id: string): Promise<EpisodicNode | null>;
    /**
     * Episodes eligible for promotion: in-scope, embedded, and not already the
     * source of a PROMOTED_FROM edge. Optional — without it the engine emits no
     * promote proposals and behaves exactly as the signal-only engine did.
     */
    findPromotable?(
      scope: string | undefined,
      limit: number,
      tenantId?: string,
    ): Promise<EpisodicNode[]>;
    /** OPT-45: batched tenant_id projection for many episodes in ONE query
     *  (optional — _deriveTenantFromEpisodes falls back to per-id getById when
     *  absent). One entry per FOUND episode (its tenant_id, null when unset);
     *  missing episodes are omitted, matching the per-id loop's "doesn't
     *  contribute" behavior. */
    getTenantsByIds?(ids: string[]): Promise<Array<string | null>>;
  };
  fact?: ConsolidationFactLayer;
}

// ─── Result types ─────────────────────────────────────────────────────────────

export interface RunResult {
  skipped: boolean;
  reason?: string;
  proposals: ConsolidationProposal[];
  applied: string[];
}

// ─── ConsolidationEngine ──────────────────────────────────────────────────────

export class ConsolidationEngine {
  private readonly lockHolder: string;

  /**
   * @param llm Optional chat client used to synthesize a clustered set of
   *   episodes into one durable Semantic claim. Without it (or with a
   *   NullLlmClient), the promote path is inert and the engine falls back to
   *   signal-driven proposals only.
   */
  constructor(
    private redis: ConsolidationRedisLayer,
    private neo4j: ConsolidationNeo4jLayer,
    private config: AMPConfig,
    private llm?: LlmClient,
  ) {
    this.lockHolder = `consolidation-engine-${nanoid(8)}`;
  }

  // ─── run ──────────────────────────────────────────────────────────────────

  async run(scope: string): Promise<RunResult> {
    // 1. Acquire distributed lock
    const acquired = await this.redis.lock.acquire(scope, this.lockHolder);
    if (!acquired) {
      return { skipped: true, reason: 'lock_held', proposals: [], applied: [] };
    }

    try {
      // 2. Consume signals from stream
      const signals = await this.redis.signals.consume(
        'consolidation',
        this.lockHolder,
        100,
      );

      // 3. Pop queue entries (up to 20)
      const queueEntries: Array<{ member: string; score: number }> = [];
      for (let i = 0; i < 20; i++) {
        const entry = await this.redis.queue.popHighest();
        if (!entry) break;
        queueEntries.push(entry);
      }

      // 4. Generate proposals from signal clusters, then from unpromoted
      // episodes. The two are independent: signals adjust EXISTING semantics,
      // promotion mints new ones. Only the signal path existed before, so a
      // graph with no semantics to signal against could never grow any.
      const proposals = await this._generateProposals(scope, signals, queueEntries);
      proposals.push(...(await this._generatePromoteProposals(scope)));

      // 5. Apply or store for review
      const applied: string[] = [];
      if (this.config.consolidation.autoApply) {
        for (const proposal of proposals) {
          const ok = await this._applyProposal(proposal);
          if (ok) applied.push(proposal.id);
        }
      } else {
        // Store for manual review
        for (const proposal of proposals) {
          await this.redis.proposals.save(proposal);
        }
      }

      return { skipped: false, proposals, applied };
    } finally {
      await this.redis.lock.release(scope, this.lockHolder);
    }
  }

  // ─── review ───────────────────────────────────────────────────────────────

  async review(proposalId: string): Promise<Record<string, unknown>> {
    const proposal = await this.redis.proposals.get(proposalId);
    if (!proposal) throw new Error(`Proposal ${proposalId} not found`);
    return proposal as unknown as Record<string, unknown>;
  }

  // ─── apply ───────────────────────────────────────────────────────────────

  async apply(proposalId: string, decision: 'approve' | 'reject'): Promise<{ applied: boolean }> {
    const proposal = await this.redis.proposals.get(proposalId);
    if (!proposal) throw new Error(`Proposal ${proposalId} not found`);

    if (decision === 'reject') {
      await this.redis.proposals.remove(proposalId);
      return { applied: false };
    }

    // approve: execute the proposal
    const ok = await this._applyProposal(proposal);
    await this.redis.proposals.remove(proposalId);
    return { applied: ok };
  }

  // ─── reviewProposal (deprecated — use review + apply) ────────────────────

  async reviewProposal(id: string, decision: 'approve' | 'reject'): Promise<void> {
    const result = await this.apply(id, decision);
    if (decision === 'approve' && !result.applied) {
      throw new Error(`Failed to apply proposal ${id}`);
    }
  }

  // ─── status ───────────────────────────────────────────────────────────────

  async status(): Promise<{ pending: string[] }> {
    const pending = await this.redis.proposals.listPending();
    return { pending };
  }

  // ─── Private: generate proposals ─────────────────────────────────────────

  private async _generateProposals(
    scope: string,
    signals: StreamSignal[],
    queueEntries: Array<{ member: string; score: number }>,
  ): Promise<ConsolidationProposal[]> {
    const proposals: ConsolidationProposal[] = [];

    // Cluster signals by target_id
    const clusters = new Map<string, { signals: StreamSignal[]; totalWeight: number }>();
    for (const signal of signals) {
      const existing = clusters.get(signal.target_id) ?? { signals: [], totalWeight: 0 };
      existing.signals.push(signal);
      existing.totalWeight += SIGNAL_WEIGHTS[signal.type] ?? 1;
      clusters.set(signal.target_id, existing);
    }

    // Also factor in queue entries (high score = needs consolidation): boost an
    // existing cluster's weight, or remember a queue-only member (score above
    // threshold) as a decay candidate. (No fetch yet — OPT-54 batches below.)
    const queueOnlyCandidates: Array<{ member: string; score: number }> = [];
    for (const entry of queueEntries) {
      const existing = clusters.get(entry.member);
      if (existing) {
        // Already have signal data — boost score
        existing.totalWeight += entry.score;
      } else if (entry.score >= this.config.consolidation.signalThreshold) {
        queueOnlyCandidates.push(entry);
      }
    }

    // Signal clusters that meet threshold (evaluated AFTER queue-weight boosts).
    const clustersToProcess = [...clusters.entries()].filter(
      ([, cluster]) => cluster.totalWeight >= this.config.consolidation.signalThreshold,
    );

    // OPT-54: fetch every needed Semantic node in ONE round-trip instead of N
    // sequential getById calls. Queue-only candidates and cluster targets are
    // disjoint (queue-only = not in clusters). Missing ids are simply omitted —
    // the proposal loops below skip them exactly as the original `if (!node)` did.
    // Optional getByIds with a per-id getById fallback (mocks/layers without it).
    const neededIds = [
      ...queueOnlyCandidates.map((c) => c.member),
      ...clustersToProcess.map(([id]) => id),
    ];
    const nodeById = new Map<string, SemanticNode>();
    if (neededIds.length > 0) {
      const semantic = this.neo4j.semantic;
      if (semantic.getByIds) {
        for (const n of await semantic.getByIds(neededIds)) nodeById.set(n.id, n);
      } else {
        for (const id of neededIds) {
          const n = await semantic.getById(id);
          if (n) nodeById.set(n.id, n);
        }
      }
    }

    // Queue-only decay proposals (preserve original order: before cluster proposals).
    for (const { member, score } of queueOnlyCandidates) {
      const node = nodeById.get(member);
      if (node) proposals.push(buildDecayProposal(scope, node, score));
    }

    // Generate proposals from signal clusters that meet threshold (clusters Map order).
    for (const [targetId, cluster] of clustersToProcess) {
      const node = nodeById.get(targetId);
      if (!node) continue;

      const contradictions = cluster.signals.filter((s) => s.type === 'contradiction');
      const corrections = cluster.signals.filter((s) => s.type === 'correction');

      if (contradictions.length > 0 || corrections.length > 0) {
        // Propose supersede with adjusted confidence
        const newConfidence = Math.max(0, node.confidence - 0.1 * (corrections.length + contradictions.length));
        proposals.push(buildSupersedePropsal(scope, node, newConfidence, cluster.totalWeight));
      } else {
        // Reinforce — the knowledge held true, so RAISE confidence (gently, with
        // diminishing returns toward 1.0). Previously this incorrectly called
        // buildDecayProposal, which DECAYED confidence by 5% — so repeatedly-confirmed
        // (i.e. most-validated) memories lost confidence every cycle, backwards for a
        // memory layer.
        proposals.push(buildReinforceProposal(scope, node, cluster.totalWeight));
      }
    }

    return proposals;
  }

  // ─── Private: generate promote proposals ──────────────────────────────────

  /**
   * Mint `promote` proposals from episodes that have never been consolidated.
   *
   * Pipeline: fetch unpromoted in-scope episodes -> cluster by embedding
   * similarity -> keep clusters at/above minClusterSize -> synthesize each into
   * one durable claim via the LLM -> propose.
   *
   * Returns [] (never throws) when the promote path can't run: no episodic
   * accessor, no findPromotable, no LLM, too few candidates, or a synthesis
   * failure. Consolidation's other proposals must not be lost to a promote-side
   * error.
   */
  private async _generatePromoteProposals(scope: string): Promise<ConsolidationProposal[]> {
    const accessor = this.neo4j.episodic;
    if (!accessor?.findPromotable) return [];
    if (!this.llm?.available) return [];

    const cfg = promoteConfig(this.config);
    if (cfg.maxPerRun <= 0) return [];

    // 'global' is the adapter's stand-in for "no scope given" — don't filter on it.
    const scopeFilter = scope && scope !== 'global' ? scope : undefined;

    let candidates: EpisodicNode[];
    try {
      candidates = await accessor.findPromotable(scopeFilter, cfg.maxCandidates);
    } catch (err: unknown) {
      console.error(
        '[consolidation] findPromotable failed; skipping promote pass:',
        err instanceof Error ? err.message : err,
      );
      return [];
    }
    if (candidates.length < cfg.minClusterSize) return [];

    // A cluster whose members span projects must not become one semantic — its
    // tags/scope would merge two projects' knowledge. Only reachable on an
    // unscoped ("global") run, where candidates aren't pre-filtered.
    const clusters = clusterByEmbedding(candidates, cfg.similarityThreshold, cfg.minClusterSize)
      .filter((c) => {
        const scopes = new Set(c.map((e) => e.scope ?? ''));
        if (scopes.size === 1) return true;
        console.error(
          `[consolidation] promote: dropped a ${c.length}-episode cluster spanning ${scopes.size} project scopes`,
        );
        return false;
      });
    if (clusters.length === 0) return [];

    // Largest clusters first — the most-corroborated knowledge is promoted while
    // the per-run budget lasts. A skipped cluster is reconsidered next run (its
    // episodes stay unpromoted), so the budget defers work, never drops it.
    const ranked = [...clusters].sort((a, b) => b.length - a.length);
    const selected = ranked.slice(0, cfg.maxPerRun);
    if (ranked.length > selected.length) {
      console.error(
        `[consolidation] promote: ${ranked.length} clusters qualified, promoting ${selected.length} this run ` +
          `(maxPerRun=${cfg.maxPerRun}); the rest remain unpromoted and are reconsidered next run.`,
      );
    }

    const proposals: ConsolidationProposal[] = [];
    for (const cluster of selected) {
      const synthesized = await this._synthesizeCluster(cluster);
      if (!synthesized) continue;
      proposals.push(buildPromoteProposal(scope, cluster, synthesized, clusterTags(cluster)));
    }
    return proposals;
  }

  /**
   * Condense one cluster of episodes into a single durable claim. Returns null
   * when the model declines (empty content), the response doesn't parse, or the
   * call fails — a bad synthesis must not become a proposal.
   */
  private async _synthesizeCluster(
    cluster: EpisodicNode[],
  ): Promise<{ content: string; confidence: number; decay_class: SemanticNode['decay_class'] } | null> {
    const llm = this.llm;
    if (!llm) return null;

    // Cap per-episode text so one long episode can't crowd the others out of
    // the prompt — every member must be represented for a claim to generalize.
    const rendered = cluster
      .map((e, i) => `[${i + 1}] task: ${e.task}\n${e.content.slice(0, 1200)}`)
      .join('\n\n');

    let raw: string;
    try {
      raw = await llm.chat(
        [
          { role: 'system', content: PROMOTE_SYNTHESIS_PROMPT },
          { role: 'user', content: rendered.slice(0, 12000) },
        ],
        { model: llm.modelFor('synthesis'), jsonMode: true, maxTokens: 600 },
      );
    } catch (err: unknown) {
      console.error(
        '[consolidation] promote synthesis failed:',
        err instanceof Error ? err.message : err,
      );
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error('[consolidation] promote synthesis returned non-JSON; skipping cluster');
      return null;
    }

    const obj = parsed as Record<string, unknown>;
    const content = typeof obj.content === 'string' ? obj.content.trim() : '';
    if (content === '') return null;

    const rawConfidence = typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)
      ? obj.confidence
      : 0.5;
    const decayClass =
      typeof obj.decay_class === 'string' && VALID_DECAY_CLASSES.has(obj.decay_class)
        ? (obj.decay_class as SemanticNode['decay_class'])
        : 'stable';

    return {
      content,
      // Clamp: a model-supplied confidence is untrusted input, and a >1 value
      // would make the new semantic un-decayable.
      confidence: Math.min(1, Math.max(0, rawConfidence)),
      decay_class: decayClass,
    };
  }

  // ─── Private: apply proposal ──────────────────────────────────────────────

  private async _applyProposal(proposal: ConsolidationProposal): Promise<boolean> {
    try {
      if (proposal.type === 'promote') {
        return await this._applyPromoteProposal(proposal);
      } else if (proposal.type === 'supersede') {
        const before = parseSemanticNode(proposal.before, 'proposal.before');
        const after = parsePartialSemanticNode(proposal.after, 'proposal.after');

        const newNode: SemanticNode = {
          id: nanoid(),
          content: after.content ?? before.content,
          confidence: after.confidence ?? before.confidence,
          signal_count: (before.signal_count ?? 0) + 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          decay_class: after.decay_class ?? before.decay_class,
          tags: after.tags ?? before.tags ?? [],
          // Carry the tenant forward: the superseding node belongs to the same
          // tenant as the node it replaces (after-side wins if it specifies one).
          tenant_id: after.tenant_id ?? before.tenant_id ?? DEFAULT_TENANT,
        };

        await this.neo4j.semantic.supersede(before.id, newNode);
        await this.redis.cache.invalidateByNodeId(before.id);
        await this.redis.cache.invalidateByNodeId(newNode.id);

        // Fact extraction: optionally extract facts from superseded content
        await this._extractAndStoreFacts(newNode.content, newNode.id, proposal.affected_ids);

        // Dispute related active facts when this is a contradiction-driven supersede
        if (this.neo4j.fact) {
          const lowerConfidence = (after.confidence ?? before.confidence) < before.confidence;
          if (lowerConfidence) {
            await this._disputeRelatedFacts(before.content);
          }
        }
      } else if (proposal.type === 'decay' || proposal.type === 'reinforce') {
        // Both are confidence adjustments applied via updateConfidence; they differ
        // only in direction (decay lowers, reinforce raises).
        const targetId = proposal.affected_ids[0];
        if (targetId) {
          const after = proposal.after as { confidence?: number };
          if (typeof after.confidence === 'number') {
            await this.neo4j.semantic.updateConfidence(targetId, after.confidence);
            await this.redis.cache.invalidateByNodeId(targetId);
          }
        }
      }
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[consolidation] _applyProposal failed for proposal ${proposal.id} (type=${proposal.type}): ${message}`,
      );
      return false;
    }
  }

  // ─── Private: apply promote proposal ───────────────────────────────────────

  /**
   * Promote source episodic memory into a new Semantic node.
   *
   * The new Semantic's tenant is derived from the SOURCE episodes
   * (`proposal.affected_ids`, which for a promote proposal are episodic IDs).
   * Consolidation runs per scope, so all source episodes should share one
   * tenant; we use their common tenant, and fall back to DEFAULT_TENANT when no
   * episodic accessor is wired, episodes carry no tenant, or tenants are mixed.
   */
  private async _applyPromoteProposal(proposal: ConsolidationProposal): Promise<boolean> {
    if (!this.neo4j.semantic.promoteFromEpisodic) {
      console.error(
        `[consolidation] _applyPromoteProposal: layer has no promoteFromEpisodic; skipping ${proposal.id}`,
      );
      return false;
    }

    const after = parsePartialSemanticNode(proposal.after, 'proposal.after');
    const sourceEpisodeIds = proposal.affected_ids;
    const tenantId = await this._deriveTenantFromEpisodes(sourceEpisodeIds, after.tenant_id);

    const now = new Date().toISOString();
    const newNode: SemanticNode = {
      id: after.id ?? nanoid(),
      content: after.content ?? '',
      confidence: after.confidence ?? 0.5,
      signal_count: after.signal_count ?? 1,
      created_at: after.created_at ?? now,
      updated_at: after.updated_at ?? now,
      decay_class: after.decay_class ?? 'stable',
      tags: after.tags ?? [],
      tenant_id: tenantId,
    };

    // Promote against the first source episode (PROMOTED_FROM provenance edge).
    const anchorEpisodeId = sourceEpisodeIds[0];
    if (!anchorEpisodeId) {
      console.error(
        `[consolidation] _applyPromoteProposal: proposal ${proposal.id} has no source episodes`,
      );
      return false;
    }

    const newId = await this.neo4j.semantic.promoteFromEpisodic(anchorEpisodeId, newNode, tenantId);
    await this.redis.cache.invalidateByNodeId(newId);

    // Extract facts from the promoted content for traceability.
    await this._extractAndStoreFacts(newNode.content, newId, sourceEpisodeIds);

    return true;
  }

  /**
   * Determine the tenant for a set of source episodes.
   *
   * Precedence: an explicit `preferred` tenant (e.g. from the proposal's after
   * side) wins; otherwise the episodes' common tenant; otherwise DEFAULT_TENANT.
   * A mix of distinct tenants (which shouldn't happen — consolidation is
   * per-scope) also falls back to DEFAULT_TENANT rather than leaking across
   * tenants.
   */
  private async _deriveTenantFromEpisodes(
    episodeIds: string[],
    preferred?: string,
  ): Promise<string> {
    if (typeof preferred === 'string' && preferred !== '') return preferred;

    const accessor = this.neo4j.episodic;
    if (!accessor || episodeIds.length === 0) return DEFAULT_TENANT;

    const tenants = new Set<string>();
    if (accessor.getTenantsByIds) {
      // OPT-45: one batched tenant_id projection instead of one getById per id.
      // Same contribution semantics: a found episode adds (tenant_id ?? DEFAULT);
      // a missing episode yields no row (doesn't contribute).
      try {
        for (const t of await accessor.getTenantsByIds(episodeIds)) {
          tenants.add(t ?? DEFAULT_TENANT);
        }
      } catch {
        // Non-critical: a failed batch read contributes nothing (→ DEFAULT below).
      }
    } else {
      for (const id of episodeIds) {
        try {
          const ep = await accessor.getById(id);
          if (ep) tenants.add(ep.tenant_id ?? DEFAULT_TENANT);
        } catch {
          // Non-critical: a missing/unreadable episode just doesn't contribute.
        }
      }
    }

    if (tenants.size === 1) return [...tenants][0]!;
    // No episodes resolved, or a mix of tenants — default rather than leak.
    return DEFAULT_TENANT;
  }

  // ─── Private: fact extraction ──────────────────────────────────────────────

  private async _extractAndStoreFacts(
    content: string,
    semanticId: string,
    sourceEpisodeIds: string[] = [],
  ): Promise<void> {
    const factLayer = this.neo4j.fact;
    const apiKey = this.config.embedding.apiKey;
    if (!factLayer || !apiKey) return;

    try {
      const inputs = await extractFacts(content, apiKey, this.config.models?.extraction);
      if (inputs.length === 0) return;

      const now = new Date().toISOString();
      for (const input of inputs) {
        // Use proposal's affected_ids as source episodes for traceability
        const episodeIds = sourceEpisodeIds.length > 0
          ? sourceEpisodeIds
          : input.source_episode_ids;

        // Check for existing active fact with same subject+predicate
        const existing = await factLayer.findBySubjectPredicate(
          input.subject,
          input.predicate,
        );

        if (existing.length > 0) {
          const current = existing[0]!;
          if (current.object === input.object) {
            // Same fact — skip (reinforce by doing nothing; confidence is maintained)
            continue;
          }
          // Different object — a contradiction. Auto-invalidating an ESTABLISHED
          // fact from extraction-derived (potentially untrusted) content would
          // let injected input silently overwrite an authoritative fact (OPT-31).
          // Gate it: an established fact (confidence >= protect threshold) is only
          // auto-invalidated by a contender at least as confident; otherwise the
          // contender is held as `tentative` (the established fact stays active)
          // for corroboration / human review.
          const newConfidence = input.confidence ?? 0.5;
          const protect = factProtectConfidence();
          const autoInvalidate =
            current.confidence < protect || newConfidence >= current.confidence;

          const newFactId = `fact-${nanoid(12)}`;
          const newFact: FactNode = {
            id: newFactId,
            subject: input.subject,
            predicate: input.predicate,
            object: input.object,
            entity_id: null,
            source_episode_ids: episodeIds,
            valid_at: now,
            invalid_at: null,
            confidence: newConfidence,
            status: autoInvalidate ? 'active' : 'tentative',
            inference_type: 'inductive',
            supersedes_fact_id: current.id,
            scope: input.scope ?? 'project',
            tags: input.tags ?? [],
            created_at: now,
            updated_at: now,
          };

          if (autoInvalidate) {
            await factLayer.invalidate(current.id, now, newFactId);
            await factLayer.create(newFact);
          } else {
            // Hold the contradiction: established fact stays active; record the
            // contender as tentative (supersedes link kept for traceability).
            // Predicate is OPT-04-validated snake_case, so it is log-safe;
            // subject/object are NOT logged (untrusted, may carry newlines).
            await factLayer.create(newFact);
            console.error(
              `[consolidation] held extraction-derived contradiction (predicate ` +
              `"${input.predicate}") as tentative: existing confidence ` +
              `${current.confidence} >= protect ${protect}, contender ` +
              `${newConfidence}; existing fact left active for review.`,
            );
          }
        } else {
          // New fact
          const newFact: FactNode = {
            id: `fact-${nanoid(12)}`,
            subject: input.subject,
            predicate: input.predicate,
            object: input.object,
            entity_id: null,
            source_episode_ids: episodeIds,
            valid_at: now,
            invalid_at: null,
            confidence: input.confidence ?? 0.5,
            status: 'tentative',
            inference_type: 'inductive',
            supersedes_fact_id: null,
            scope: input.scope ?? 'project',
            tags: input.tags ?? [],
            created_at: now,
            updated_at: now,
          };
          await factLayer.create(newFact);
        }
      }
    } catch (err) {
      // Non-critical: fact extraction failure should not block consolidation
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[consolidation] fact extraction failed (non-critical): ${message}`);
    }
  }

  private async _disputeRelatedFacts(semanticContent: string): Promise<void> {
    const factLayer = this.neo4j.fact;
    const apiKey = this.config.embedding.apiKey;
    if (!factLayer || !apiKey) return;

    try {
      // Extract facts from the old (now-contradicted) content to find what to dispute
      const oldFacts = await extractFacts(semanticContent, apiKey, this.config.models?.extraction);
      for (const oldFact of oldFacts) {
        const matching = await factLayer.findBySubjectPredicate(
          oldFact.subject,
          oldFact.predicate,
        );
        for (const active of matching) {
          if (active.object === oldFact.object) {
            await factLayer.dispute(active.id);
          }
        }
      }
    } catch (err: unknown) {
      // Non-critical: dispute failure should not block consolidation
    }
  }
}

// ─── Promote: configuration ───────────────────────────────────────────────────

/**
 * Promote-pass knobs, with env overrides. Defaults are deliberately
 * conservative: 3 episodes must agree before their shared knowledge is durable
 * enough to propose, and at most 3 promotions are proposed per run so a first
 * pass over a large backlog can be reviewed rather than dumped.
 */
const PROMOTE_DEFAULTS = {
  minClusterSize: 3,
  similarityThreshold: 0.82,
  maxPerRun: 3,
  maxCandidates: 200,
} as const;

function numFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = readEnv(name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function promoteConfig(config: AMPConfig): {
  minClusterSize: number;
  similarityThreshold: number;
  maxPerRun: number;
  maxCandidates: number;
} {
  const c = config.consolidation.promote;
  return {
    minClusterSize: Math.round(
      c?.minClusterSize ?? numFromEnv('MEMBERRY_PROMOTE_MIN_CLUSTER', PROMOTE_DEFAULTS.minClusterSize, 2, 50),
    ),
    similarityThreshold:
      c?.similarityThreshold ??
      numFromEnv('MEMBERRY_PROMOTE_SIMILARITY', PROMOTE_DEFAULTS.similarityThreshold, 0, 1),
    maxPerRun: Math.round(
      c?.maxPerRun ?? numFromEnv('MEMBERRY_PROMOTE_MAX_PER_RUN', PROMOTE_DEFAULTS.maxPerRun, 0, 50),
    ),
    maxCandidates: Math.round(
      c?.maxCandidates ?? numFromEnv('MEMBERRY_PROMOTE_MAX_CANDIDATES', PROMOTE_DEFAULTS.maxCandidates, 10, 2000),
    ),
  };
}

/** Union of the cluster's tags (deduped, project tags lowercased) — the source
 *  episodes' tags are what make the promoted semantic retrievable by scope. */
function clusterTags(cluster: EpisodicNode[]): string[] {
  const tags = new Set<string>();
  for (const ep of cluster) {
    for (const t of ep.tags ?? []) {
      tags.add(/^project:/i.test(t) ? t.toLowerCase() : t);
    }
  }
  return [...tags];
}

// ─── Promote: clustering helpers ──────────────────────────────────────────────

/** Cosine similarity of two equal-length vectors. Returns 0 for degenerate input. */
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Greedy single-pass clustering: each episode joins the first cluster whose
 * SEED it is at least `threshold` similar to, else it seeds a new cluster.
 * Deterministic given a fixed input order (episodes arrive newest-first), which
 * keeps a re-run over the same graph state reproducible.
 *
 * Greedy (not k-means / HDBSCAN) on purpose: the candidate set is capped in the
 * hundreds and only clusters at/above `minSize` survive, so the cost of a
 * slightly suboptimal partition is a missed promotion this cycle, not a wrong
 * one — and the next run reconsiders every still-unpromoted episode.
 */
export function clusterByEmbedding(
  episodes: EpisodicNode[],
  threshold: number,
  minSize: number,
): EpisodicNode[][] {
  const clusters: Array<{ seed: number[]; members: EpisodicNode[] }> = [];

  for (const ep of episodes) {
    const vec = ep.embedding;
    if (!vec || vec.length === 0) continue;
    const hit = clusters.find((c) => cosine(c.seed, vec) >= threshold);
    if (hit) hit.members.push(ep);
    else clusters.push({ seed: vec, members: [ep] });
  }

  return clusters.filter((c) => c.members.length >= minSize).map((c) => c.members);
}

// ─── Promote: synthesis prompt ────────────────────────────────────────────────

const PROMOTE_SYNTHESIS_PROMPT = `You are a memory consolidation system. You are given several related episodic memories from one project — raw session snapshots of what happened.

Write the single durable piece of knowledge they share: the principle, convention, decision, or architectural fact that stays true after these particular sessions are forgotten.

Rules:
- State it as a standalone claim. It must make sense to someone who never sees the source episodes.
- Generalize across the episodes; do not summarize them one by one and do not narrate the sessions ("the agent did X").
- Include the concrete specifics that make the knowledge usable (names, paths, versions, thresholds).
- Omit anything only true of one session (timestamps, one-off errors, transient state).
- If the episodes share no durable knowledge, return an empty string for "content".

Respond with JSON only:
{"content": "...", "confidence": 0.0-1.0, "decay_class": "volatile" | "stable" | "permanent"}

confidence: how strongly the episodes support the claim. decay_class: "volatile" for knowledge that changes often (current task state), "stable" for conventions and architecture, "permanent" for immutable facts.`;

// ─── Proposal builders ────────────────────────────────────────────────────────

function buildPromoteProposal(
  scope: string,
  cluster: EpisodicNode[],
  synthesized: { content: string; confidence: number; decay_class: SemanticNode['decay_class'] },
  tags: string[],
): ConsolidationProposal {
  const now = new Date().toISOString();
  return {
    id: nanoid(),
    type: 'promote',
    scope,
    // Source EPISODE ids — _applyPromoteProposal anchors PROMOTED_FROM on the
    // first and derives the new semantic's tenant from all of them.
    affected_ids: cluster.map((e) => e.id),
    before: {},
    after: {
      id: nanoid(),
      content: synthesized.content,
      confidence: synthesized.confidence,
      signal_count: cluster.length,
      created_at: now,
      updated_at: now,
      decay_class: synthesized.decay_class,
      tags,
    } as Record<string, unknown>,
    score: cluster.length,
    created_at: now,
  };
}

function buildSupersedePropsal(
  scope: string,
  node: SemanticNode,
  newConfidence: number,
  score: number,
): ConsolidationProposal {
  return {
    id: nanoid(),
    type: 'supersede',
    scope,
    affected_ids: [node.id],
    before: { ...node } as Record<string, unknown>,
    after: {
      ...node,
      confidence: newConfidence,
      updated_at: new Date().toISOString(),
    } as Record<string, unknown>,
    score,
    created_at: new Date().toISOString(),
  };
}

function buildDecayProposal(
  scope: string,
  node: SemanticNode,
  score: number,
): ConsolidationProposal {
  const decayedConfidence = Math.max(0, node.confidence * 0.95);
  return {
    id: nanoid(),
    type: 'decay',
    scope,
    affected_ids: [node.id],
    before: { ...node } as Record<string, unknown>,
    after: {
      confidence: decayedConfidence,
    } as Record<string, unknown>,
    score,
    created_at: new Date().toISOString(),
  };
}

// Gentle confidence gain on reinforcement: move a small fraction toward 1.0, so
// confidence rises with diminishing returns and is bounded at 1.0 (can never exceed it).
const REINFORCE_FACTOR = 0.05;

function buildReinforceProposal(
  scope: string,
  node: SemanticNode,
  score: number,
): ConsolidationProposal {
  const reinforcedConfidence = Math.min(1, node.confidence + (1 - node.confidence) * REINFORCE_FACTOR);
  return {
    id: nanoid(),
    type: 'reinforce',
    scope,
    affected_ids: [node.id],
    before: { ...node } as Record<string, unknown>,
    after: {
      confidence: reinforcedConfidence,
    } as Record<string, unknown>,
    score,
    created_at: new Date().toISOString(),
  };
}
