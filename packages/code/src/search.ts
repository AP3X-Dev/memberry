// packages/code/src/search.ts
// Hybrid search: vector + fulltext + graph-boosted with RRF fusion.
// Blends code symbols with semantic memories into a unified result set.

import neo4j, { type Driver } from 'neo4j-driver';
import type { CodeSearchResult, CodeContext } from './types.js';
import { isTestPath } from './types.js';
import type {
  EmbeddingProvider,
} from '@memberry/core';
import { generateLexicalVector } from './vectors.js';

type InternalRetrievalChannel = 'code.fulltext' | 'code.lexical-vector' | 'code.dense-vector' | 'code.semantic-vector';
type InternalRetrievalChannelObservation =
  | { channel: InternalRetrievalChannel; outcome: 'success' }
  | { channel: InternalRetrievalChannel; outcome: 'safe-failure'; code: 'unavailable' | 'timeout' | 'query-failed' | 'invalid-result' };
interface InternalRetrievalCandidateObservation {
  privateId: string;
  sourceType: 'symbol' | 'semantic';
  channels: Array<{ channel: InternalRetrievalChannel; rank: number; score?: number }>;
  evidence: { confidence?: number; sourceCount?: number; superseded?: boolean; invalidated?: boolean };
  estimatedTokens: number;
}
interface InternalRetrievalObservation {
  channels: InternalRetrievalChannelObservation[];
  candidates: InternalRetrievalCandidateObservation[];
  finalIds: string[];
}
interface InternallyObserved<T> { value: T; observation: InternalRetrievalObservation }
class InternalObservedSearchError extends Error {
  constructor(readonly observation: InternalRetrievalObservation, options?: { cause?: unknown }) {
    super('internal observed code search failed', options);
    this.name = 'InternalObservedSearchError';
  }
}

interface CodeContextFilters {
  language?: string;
  file_path?: string;
  kind?: string;
  /** Canonical single-scope project tag (`project:<slug>`) — see SymbolScopeOptions. */
  project_tag?: string;
}

/**
 * The shared symbol-scope filter shape used by the fulltext WHERE and the
 * vector/lexical post-filters. `project_tag` (T5/gap-11) is the PRIMARY scope:
 * a symbol matches when its stored `project_tag` equals the tag, OR (as a
 * FALLBACK for legacy un-stamped symbols) it has no stored tag and matches the
 * `file_path` substring heuristic. `project_tag` is applied BEFORE the path
 * heuristic in every channel.
 */
interface SymbolScopeOptions {
  language?: string;
  file_path?: string;
  kind?: string;
  project_tag?: string;
}

// ─── IDX-002A: kind / test-path rank prior (flagged, default OFF) ────────────

/** Process flag, read ONCE at module load. '1' = on; anything else = baseline order. */
export const KIND_RANK_FLAG = 'MEMBERRY_KIND_RANK_V1';
const KIND_RANK_V1 = process.env[KIND_RANK_FLAG] === '1';

/**
 * IDX-002B: a non-code row outranks nothing in a CODE search. `semanticVectorSearch`
 * emits `file_path: ''` and `start_line: 0`, so a memory row can never answer "where
 * is this in the code" — yet it scored 0 here and therefore sorted ABOVE every
 * `variable`. Measured on the live box 2026-08-27: 28 of 50 top-5 slots.
 *
 * Keyed on `source_type` (the channel-assigned discriminator, closed at
 * 'symbol' | 'semantic'), NOT on `kind` — `kind` is open vocabulary from the
 * parser, and a symbol whose kind happens to read 'semantic' is still code.
 *
 * 3 dominates the 0..2 code band, so the bands never interleave.
 */
const NON_CODE_PENALTY = 3;

/** 0 = keep, 1 = one strike, 2 = both, 3 = not code at all. A comparator, not a score. */
export function noisePenalty(r: CodeSearchResult): number {
  if (r.source_type === 'semantic') return NON_CODE_PENALTY;
  return (r.kind === 'variable' ? 1 : 0) + (isTestPath(r.file_path) ? 1 : 0);
}

// ─── IDX-002B: project scope actually scopes (flagged, default OFF) ──────────

/**
 * Process flag, read ONCE at module load. '1' = on; anything else = shipped behaviour.
 *
 * Two leaks, one switch, because they are the same defect on two channels:
 *   - the un-stamped-symbol fallback admits EVERY un-stamped symbol in the graph
 *     when no path hint narrows it (5,136 on the live box, none of them the
 *     scoped project's);
 *   - the semantic channel is not scoped at all.
 * Separate from KIND_RANK_V1 so either mechanism can be reverted alone.
 */
export const CODE_SCOPE_FLAG = 'MEMBERRY_CODE_SCOPE_V2';
const CODE_SCOPE_V2 = process.env[CODE_SCOPE_FLAG] === '1';

// ─── IDX-004: retrieve wide, rerank, prior last (flagged + opt-in, default OFF) ─

/**
 * Process flag, read ONCE at module load. '1' = on; anything else = shipped behaviour.
 * Separate from KIND_RANK_V1 and CODE_SCOPE_V2 so it can be reverted alone.
 *
 * The flag is NECESSARY BUT NOT SUFFICIENT, and that is deliberate. `bootstrap.ts` shares ONE
 * CodeSearch instance with UnifiedAssembler, so an env-only gate would also change
 * berry_context / berry_ask / berry_code_context — a plane with no outcome instrument, and one
 * this packet puts out of scope. Callers opt in per call via `options.rerank`; only the
 * berry_code_search handler does.
 */
export const CODE_RERANK_FLAG = 'MEMBERRY_CODE_RERANK_V1';
const CODE_RERANK_V1 = process.env[CODE_RERANK_FLAG] === '1';

/**
 * The window IDX-004 retrieves into before reranking. 50 is not a guess: the headroom sweep
 * measured limit-50 recovering 7 of 10 probe answers on its own, and 9 of 10 with a widened
 * query, against 6 at the shipped default.
 *
 * NOTE the real composition of that window: `semanticVectorSearch` caps itself at
 * `Math.min(limit, 10)`, so widening does NOT widen the memory channel. A wide window is
 * <=50 symbol rows plus <=10 memory rows, not 50 of each.
 */
const WIDE_WINDOW = 50;

/** Never narrower than the caller asked for. A caller wanting 100 still gets 100. */
export function widenLimit(limit: number): number {
  return Math.max(limit, WIDE_WINDOW);
}

/**
 * Injected from the composition root. `@memberry/retrieval` depends on `@memberry/code`, so the
 * dependency can only run this direction — code declares the shape, retrieval implements it.
 *
 * Contract: returns a PERMUTATION of `rows`. An implementation that drops or invents rows is a
 * defect, and `searchStandard` defends against it by falling back to the unreranked window.
 */
export type CodeReranker = (
  query: string,
  rows: CodeSearchResult[],
) => Promise<CodeSearchResult[]>;

/** Stable sort in place. Permutation of the input window; length and ids are invariant. */
export function rankByNoise(rows: CodeSearchResult[]): CodeSearchResult[] {
  return rows.sort((a, b) => noisePenalty(a) - noisePenalty(b));
}

export class CodeSearch {
  constructor(
    private driver: Driver,
    private embedding: EmbeddingProvider,
    private reranker?: CodeReranker,
  ) {}

  /**
   * Hybrid search across Symbol nodes AND Semantic memories.
   * 1. Fulltext search on symbol names/signatures/doc_comments
   * 2. Vector search on symbol embeddings (if available)
   * 3. Vector search on semantic memories
   * 4. RRF fusion to produce a single ranked list
   */
  async search(
    query: string,
    options?: {
      language?: string;
      file_path?: string;
      kind?: string;
      project_tag?: string;
      limit?: number;
      include_semantics?: boolean;
      expandedTokens?: string[];
      as_of?: string;
      queryVector?: number[];
      /**
       * IDX-004 opt-in, required IN ADDITION to CODE_RERANK_FLAG. Only the berry_code_search
       * handler sets it; the assembler and buildContext deliberately do not, which is what keeps
       * this off the memory plane.
       */
      rerank?: boolean;
    },
  ): Promise<CodeSearchResult[]> {
    return this.searchStandard(query, options, false);
  }

  /** @internal Fresh structural observation for ranked RET-001B tracing. */
  async searchObserved(
    query: string,
    options?: {
      language?: string;
      file_path?: string;
      kind?: string;
      project_tag?: string;
      limit?: number;
      include_semantics?: boolean;
      expandedTokens?: string[];
      as_of?: string;
      queryVector?: number[];
      /**
       * IDX-004 opt-in, required IN ADDITION to CODE_RERANK_FLAG. Only the berry_code_search
       * handler sets it; the assembler and buildContext deliberately do not, which is what keeps
       * this off the memory plane.
       */
      rerank?: boolean;
    },
  ): Promise<InternallyObserved<CodeSearchResult[]>> {
    return this.searchStandard(query, options, true);
  }

  private async searchStandard(
    query: string,
    options: Parameters<CodeSearch['search']>[1] | undefined,
    observed: false,
  ): Promise<CodeSearchResult[]>;
  private async searchStandard(
    query: string,
    options: Parameters<CodeSearch['search']>[1] | undefined,
    observed: true,
  ): Promise<InternallyObserved<CodeSearchResult[]>>;
  private async searchStandard(
    query: string,
    options: {
      language?: string;
      file_path?: string;
      kind?: string;
      project_tag?: string;
      limit?: number;
      include_semantics?: boolean;
      expandedTokens?: string[];
      as_of?: string;
      queryVector?: number[];
      /**
       * IDX-004 opt-in, required IN ADDITION to CODE_RERANK_FLAG. Only the berry_code_search
       * handler sets it; the assembler and buildContext deliberately do not, which is what keeps
       * this off the memory plane.
       */
      rerank?: boolean;
    } | undefined,
    observed: boolean,
  ): Promise<CodeSearchResult[] | InternallyObserved<CodeSearchResult[]>> {
    const limit = options?.limit ?? 20;
    // IDX-004. BOTH conditions required — see CODE_RERANK_FLAG for why the flag alone must not
    // be enough. Computed ONCE so the widen, the rerank, the prior and the truncate cannot drift
    // apart into a configuration nobody measured.
    const rerankThisCall = CODE_RERANK_V1 && options?.rerank === true;
    // Retrieve wide: the channels themselves open up, because widening only the fusion window
    // would fuse the same narrow candidate lists and change nothing.
    const retrieveLimit = rerankThisCall ? widenLimit(limit) : limit;
    const includeSemantics = options?.include_semantics ?? true;
    const channelOutcomes = observed
      ? new Map<InternalRetrievalChannel, InternalRetrievalChannelObservation>()
      : undefined;
    const settle = observed
      ? (entry: InternalRetrievalChannelObservation): void => { channelOutcomes!.set(entry.channel, entry); }
      : undefined;

    // OPT-49: embed the query ONCE and share the vector across the two dense
    // channels (symbol + semantic), which each used to embed it separately. The
    // promise is created here (before the fan-out) so the embed still overlaps
    // fulltext/lexical; both dense channels await this SAME promise instead of
    // issuing a second embed. Deterministic embed → byte-identical query vector.
    //
    // Shared query embedding: when the unified assembler already embedded the task
    // (options.queryVector), reuse it instead of embedding a third time here.
    const queryVectorPromise: Promise<number[] | null> =
      options?.queryVector !== undefined
        ? Promise.resolve(options.queryVector)
        : this.embedding.available === false ? Promise.resolve(null) : this.embedding.embed(query);

    // 4-way parallel: fulltext + dense vector + lexical vector + semantic
    const fulltextPromise = this.fulltextSearch(options?.expandedTokens?.join(' ') ?? query, retrieveLimit, options);
    const observedFulltextPromise = observed
      ? fulltextPromise.then(
          (value) => { settle!({ channel: 'code.fulltext', outcome: 'success' }); return value; },
          (error) => { settle!({ channel: 'code.fulltext', outcome: 'safe-failure', code: 'query-failed' }); throw error; },
        )
      : fulltextPromise;
    const searches = [
      observedFulltextPromise,
      observed
        ? this.vectorSearch(query, retrieveLimit, options, queryVectorPromise, settle)
        : this.vectorSearch(query, retrieveLimit, options, queryVectorPromise),
      observed
        ? this.lexicalVectorSearch(query, retrieveLimit, options, settle)
        : this.lexicalVectorSearch(query, retrieveLimit, options),
      includeSemantics
        ? observed
          ? this.semanticVectorSearch(query, retrieveLimit, options?.as_of, options?.project_tag, queryVectorPromise, settle)
          : this.semanticVectorSearch(query, retrieveLimit, options?.as_of, options?.project_tag, queryVectorPromise)
        : Promise.resolve([]),
    ] as const;
    let fulltextResults: CodeSearchResult[];
    let vectorResults: CodeSearchResult[];
    let lexicalResults: CodeSearchResult[];
    let semanticResults: CodeSearchResult[];
    if (observed) {
      const settled = await Promise.allSettled(searches);
      const rejected = settled.find((entry) => entry.status === 'rejected');
      if (rejected?.status === 'rejected') {
        throw new InternalObservedSearchError({
          channels: [...channelOutcomes!.values()], candidates: [], finalIds: [],
        }, { cause: rejected.reason });
      }
      [fulltextResults, vectorResults, lexicalResults, semanticResults] = settled.map(
        (entry) => (entry as PromiseFulfilledResult<CodeSearchResult[]>).value,
      ) as [CodeSearchResult[], CodeSearchResult[], CodeSearchResult[], CodeSearchResult[]];
    } else {
      [fulltextResults, vectorResults, lexicalResults, semanticResults] = await Promise.all(searches);
    }

    // RRF fusion across all result lists (source_type already set per list)
    const allLists: CodeSearchResult[][] = [fulltextResults, lexicalResults, vectorResults, semanticResults];
    const fused = rrfFusion(allLists, retrieveLimit);

    // IDX-002A: rank prior, behind KIND_RANK_FLAG (default OFF = baseline order).
    // Within the window rrfFusion already returned, `variable` symbols and test-path
    // symbols sort last. Stable sort => a permutation of that window, never a filter.
    //
    // IDX-004 ORDER IS LOAD-BEARING, and all three steps hang off the SAME boolean:
    //   - rerank FIRST. The served reranker is effectively 100% BM25F — it never reads
    //     source_type, and rrfFusion has already overwritten each row's score with an RRF score
    //     of ~0.016..0.065, so the 0.15 baseline term contributes ~0.003. Run it after the prior
    //     and it erases everything IDX-002A and IDX-002B established.
    //   - prior SECOND, and `rerankThisCall` is in the condition on purpose: with
    //     CODE_RERANK_V1=1 and KIND_RANK_V1 at its shipped default OFF, this would otherwise be
    //     fuse-wide -> rerank -> truncate with NO prior. That is worse than baseline — the
    //     reranker's coverage and phrase terms favour memory prose over a short signature when
    //     the query is an English question, so IDX-002B reopens, widened.
    //   - truncate LAST. Cutting before the prior strands a code row the prior could have
    //     promoted from reranked position 25 into the returned window.
    let final = fused;
    if (rerankThisCall && this.reranker) {
      try {
        const reranked = await this.reranker(query, fused);
        // Permutation contract. A reranker that loses or invents rows is ignored outright
        // rather than allowed to silently shrink a result set.
        if (Array.isArray(reranked) && reranked.length === fused.length) final = reranked;
      } catch {
        // A reranker failure degrades to the fused order. Never an error, never empty.
        final = fused;
      }
    }
    // Aliasing note: on the non-reranked path `final` IS `fused`, so this sorts that array in
    // place; on the reranked path it is a new array. Harmless only because `fused` is never
    // read again below this point — every downstream use is `final`.
    if (KIND_RANK_V1 || rerankThisCall) rankByNoise(final);
    if (rerankThisCall) final = final.slice(0, limit);

    if (!observed) return final;

    const observation: InternalRetrievalObservation = { channels: [], candidates: [], finalIds: [] };
    {
      const channels = [
        'code.fulltext', 'code.lexical-vector', 'code.dense-vector', 'code.semantic-vector',
      ] as const;
      observation.channels = channels.flatMap((channel) => {
        const entry = channelOutcomes!.get(channel);
        return entry ? [entry] : [];
      });
      const channelLists = [
        ['code.fulltext', fulltextResults],
        ['code.lexical-vector', lexicalResults],
        ['code.dense-vector', vectorResults],
        ['code.semantic-vector', semanticResults],
      ] as const;
      const candidates = new Map<string, InternalRetrievalCandidateObservation>();
      for (const [channel, results] of channelLists) {
        results.forEach((result, index) => {
          const candidate = candidates.get(result.id) ?? {
            privateId: result.id,
            sourceType: result.source_type,
            channels: [],
            evidence: {},
            estimatedTokens: Math.ceil((result.signature.length + result.doc_comment.length + 50) / 4),
          };
          candidate.channels.push({ channel, rank: index + 1, score: result.score });
          candidates.set(result.id, candidate);
        });
      }
      observation.candidates = [...candidates.values()];
      // IDX-004: `final`, not `fused` — finalIds must describe what was RETURNED (prior-sorted
      // and truncated), while `candidates` above legitimately holds the wider set considered.
      observation.finalIds = final.map((result) => result.id);
    }
    return { value: final, observation };
  }

  /**
   * Build code-aware context for a task.
   * Returns relevant symbols + semantic memories, token-budgeted.
   */
  async buildContext(
    task: string,
    maxTokens = 6000,
    as_of?: string,
    filters?: CodeContextFilters,
  ): Promise<CodeContext> {
    const results = await this.search(task, { limit: 30, include_semantics: true, as_of, ...filters });

    const symbols: CodeSearchResult[] = [];
    const semantics: Array<{ id: string; content: string; confidence: number }> = [];
    let tokenCount = 0;

    for (const result of results) {
      const estimatedTokens = Math.ceil((result.signature.length + result.doc_comment.length + 50) / 4);
      if (tokenCount + estimatedTokens > maxTokens) continue;

      if (result.source_type === 'symbol') {
        symbols.push(result);
      } else {
        semantics.push({
          id: result.id,
          content: result.doc_comment || result.signature,
          confidence: result.score,
        });
      }
      tokenCount += estimatedTokens;
    }

    return { task, symbols, semantic_memories: semantics, token_count: tokenCount };
  }

  /**
   * Render code context as markdown.
   */
  renderContextMarkdown(ctx: CodeContext): string {
    const lines: string[] = [];
    lines.push(`# Code Context`);
    lines.push(`**Task:** ${ctx.task}`);
    lines.push('');

    if (ctx.symbols.length > 0) {
      lines.push('## Relevant Symbols');
      lines.push('');
      for (const s of ctx.symbols) {
        lines.push(`### ${s.name} (${s.kind}) — ${s.file_path}:${s.start_line}`);
        lines.push(`\`${s.signature}\``);
        if (s.doc_comment) lines.push(`> ${s.doc_comment.split('\n')[0]}`);
        lines.push('');
      }
    }

    if (ctx.semantic_memories.length > 0) {
      lines.push('## Related Knowledge');
      lines.push('');
      for (const m of ctx.semantic_memories) {
        lines.push(`- [${m.confidence.toFixed(2)}] ${m.content}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // ─── Private search strategies ──────────────────────────────────────────

  private async fulltextSearch(
    query: string,
    limit: number,
    options?: SymbolScopeOptions,
  ): Promise<CodeSearchResult[]> {
    const session = this.driver.session();
    try {
      // Escape special Lucene characters for fulltext search
      const escaped = query
        .replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, '\\$&')
        .replace(/\b(AND|OR|NOT|TO)\b/g, '"$1"');

      const filters: string[] = [];
      const params: Record<string, unknown> = {
        query: `${escaped}*`,
        limit: neo4j.int(limit),
      };

      if (options?.language) {
        filters.push('s.language = $language');
        params.language = options.language;
      }
      // Project scope FIRST (T5/gap-11): the stored canonical tag is the primary
      // filter; the file_path substring heuristic applies only as a FALLBACK for
      // symbols with no stored project_tag. When no tag is supplied, the prior
      // file_path-only behavior is preserved.
      const scope = buildSymbolScopeCypher('s', options?.project_tag, options?.file_path);
      if (scope.clause) {
        filters.push(scope.clause);
        Object.assign(params, scope.params);
      }
      if (options?.kind) {
        filters.push('s.kind = $kind');
        params.kind = options.kind;
      }

      const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

      const result = await session.run(
        `CALL db.index.fulltext.queryNodes('symbol_search', $query)
         YIELD node AS s, score
         ${whereClause}
         RETURN s, score
         ORDER BY score DESC
         LIMIT $limit`,
        params,
      );

      return result.records.map((r) => {
        const props = r.get('s').properties as Record<string, unknown>;
        return {
          id: props.id as string,
          source_type: 'symbol' as const,
          name: props.name as string,
          kind: props.kind as string,
          language: (props.language as string) ?? '',
          file_path: props.file_path as string,
          start_line: toNum(props.start_line),
          signature: (props.signature as string) ?? '',
          doc_comment: (props.doc_comment as string) ?? '',
          score: r.get('score') as number,
        };
      });
    } finally {
      await session.close();
    }
  }

  private async vectorSearch(
    query: string,
    limit: number,
    options?: SymbolScopeOptions,
    queryVectorPromise?: Promise<number[] | null>,
    observe?: (entry: InternalRetrievalChannelObservation) => void,
  ): Promise<CodeSearchResult[]> {
    // No usable embeddings → skip dense vector search; fulltext + deterministic
    // lexical-vector search still run and carry the fused result.
    if (this.embedding.available === false) {
      observe?.({ channel: 'code.dense-vector', outcome: 'safe-failure', code: 'unavailable' });
      return [];
    }
    try {
      // OPT-49: reuse the query vector search() embedded once; fall back to
      // embedding here for any direct caller that didn't pass one.
      const queryEmbedding = queryVectorPromise ? await queryVectorPromise : await this.embedding.embed(query);
      if (!queryEmbedding) return [];
      const candidateLimit = candidateLimitForPostFilters(limit, options);
      const session = this.driver.session();
      try {
        const result = await session.run(
          `CALL db.index.vector.queryNodes('symbol_embedding', $limit, $embedding)
           YIELD node AS s, score
           RETURN s, score`,
          { limit: neo4j.int(candidateLimit), embedding: queryEmbedding },
        );

        let results = result.records.map((r) => {
          const props = r.get('s').properties as Record<string, unknown>;
          return {
            id: props.id as string,
            source_type: 'symbol' as const,
            name: props.name as string,
            kind: props.kind as string,
            language: (props.language as string) ?? '',
            file_path: props.file_path as string,
            start_line: toNum(props.start_line),
            signature: (props.signature as string) ?? '',
            doc_comment: (props.doc_comment as string) ?? '',
            score: r.get('score') as number,
            project_tag: (props.project_tag as string) || undefined,
          };
        });

        // Project scope FIRST (T5/gap-11): filter by the stored canonical tag
        // BEFORE the file_path path heuristic. The path substring is a FALLBACK
        // for symbols with no stored project_tag.
        results = applyScopePostFilter(results, options);
        // Remaining post-filters (language matches the symbol's language property, not file extension)
        if (options?.language) results = results.filter((r) => r.language === options.language);
        if (options?.kind) results = results.filter((r) => r.kind === options.kind);

        const value = results.slice(0, limit).map(stripScratch);
        observe?.({ channel: 'code.dense-vector', outcome: 'success' });
        return value;
      } finally {
        await session.close();
      }
    } catch (err) {
      if (observe) console.error('[memberry-code] Symbol vector search failed [query-failed]');
      else console.error('[memberry-code] Symbol vector search failed (falling back to fulltext):', err instanceof Error ? err.message : err);
      observe?.({ channel: 'code.dense-vector', outcome: 'safe-failure', code: 'query-failed' });
      return [];
    }
  }

  private async lexicalVectorSearch(
    query: string,
    limit: number,
    options?: SymbolScopeOptions,
    observe?: (entry: InternalRetrievalChannelObservation) => void,
  ): Promise<CodeSearchResult[]> {
    try {
      const lexVec = generateLexicalVector(query);
      const candidateLimit = candidateLimitForPostFilters(limit, options);
      const session = this.driver.session();
      try {
        const result = await session.run(
          `CALL db.index.vector.queryNodes('symbol_lexical', $limit, $vector)
           YIELD node AS s, score
           RETURN s, score`,
          { limit: neo4j.int(candidateLimit), vector: lexVec },
        );

        let results = result.records.map((r) => {
          const props = r.get('s').properties as Record<string, unknown>;
          return {
            id: props.id as string,
            source_type: 'symbol' as const,
            name: props.name as string,
            kind: props.kind as string,
            language: (props.language as string) ?? '',
            file_path: props.file_path as string,
            start_line: toNum(props.start_line),
            signature: (props.signature as string) ?? '',
            doc_comment: (props.doc_comment as string) ?? '',
            score: r.get('score') as number,
            project_tag: (props.project_tag as string) || undefined,
          };
        });

        // Project scope FIRST (T5/gap-11), then the remaining post-filters.
        results = applyScopePostFilter(results, options);
        if (options?.language) results = results.filter((r) => r.language === options.language);
        if (options?.kind) results = results.filter((r) => r.kind === options.kind);

        const value = results.slice(0, limit).map(stripScratch);
        observe?.({ channel: 'code.lexical-vector', outcome: 'success' });
        return value;
      } finally {
        await session.close();
      }
    } catch (err) {
      if (observe) console.error('[memberry-code] Lexical vector search failed [query-failed]');
      else console.error('[memberry-code] Lexical vector search failed:', err instanceof Error ? err.message : err);
      observe?.({ channel: 'code.lexical-vector', outcome: 'safe-failure', code: 'query-failed' });
      return [];
    }
  }

  private async semanticVectorSearch(
    query: string,
    limit: number,
    asOf?: string,
    projectTag?: string,
    queryVectorPromise?: Promise<number[] | null>,
    observe?: (entry: InternalRetrievalChannelObservation) => void,
  ): Promise<CodeSearchResult[]> {
    if (this.embedding.available === false) {
      observe?.({ channel: 'code.semantic-vector', outcome: 'safe-failure', code: 'unavailable' });
      return [];
    }
    try {
      // OPT-49: reuse the query vector search() embedded once (shared with the
      // symbol dense channel); fall back to embedding for direct callers.
      const queryEmbedding = queryVectorPromise ? await queryVectorPromise : await this.embedding.embed(query);
      if (!queryEmbedding) return [];
      const semanticLimit = Math.min(limit, 10);
      // IDX-002B: the memory channel was the ONLY channel with no project scope —
      // a search scoped to one project drew memories from every project in the
      // graph (on the live box, 101 of 192 project-tagged memories were the
      // scoped project's; the rest were other people's). Filtering happens after
      // the vector index returns, so overfetch for it exactly as as_of does.
      const scopeTag = CODE_SCOPE_V2 ? projectTag?.trim() : undefined;
      const candidateLimit = candidateLimitForTemporalFilter(
        semanticLimit,
        Boolean(asOf) || Boolean(scopeTag),
      );
      const session = this.driver.session();
      try {
        // When as_of is provided, post-filter semantic nodes to those created before the cutoff
        const conditions: string[] = [];
        if (asOf) conditions.push('s.created_at <= $asOf');
        if (scopeTag) conditions.push('$project_tag IN s.tags');
        const temporalFilter = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const result = await session.run(
          `CALL db.index.vector.queryNodes('semantic_embedding', $limit, $embedding)
           YIELD node AS s, score
           ${temporalFilter}
           RETURN s, score`,
          {
            limit: neo4j.int(candidateLimit),
            embedding: queryEmbedding,
            ...(asOf ? { asOf } : {}),
            ...(scopeTag ? { project_tag: scopeTag } : {}),
          },
        );

        const value = result.records.map((r) => {
          const props = r.get('s').properties as Record<string, unknown>;
          return {
            id: props.id as string,
            source_type: 'semantic' as const,
            name: `[Semantic] ${(props.id as string).slice(0, 12)}`,
            kind: 'semantic',
            file_path: '',
            start_line: 0,
            signature: (props.content as string) ?? '',
            doc_comment: '',
            score: (r.get('score') as number) * 0.8, // Slightly discount semantics vs code matches
          };
        }).slice(0, semanticLimit);
        observe?.({ channel: 'code.semantic-vector', outcome: 'success' });
        return value;
      } finally {
        await session.close();
      }
    } catch (err) {
      if (observe) console.error('[memberry-code] Semantic vector search failed [query-failed]');
      else console.error('[memberry-code] Semantic vector search failed:', err instanceof Error ? err.message : err);
      observe?.({ channel: 'code.semantic-vector', outcome: 'safe-failure', code: 'query-failed' });
      return [];
    }
  }
}

// ─── Reciprocal Rank Fusion (generic) ─────────────────────────────────────────
// Same algorithm as @memberry/retrieval's rrfFusion but operates on any
// { id: string; score: number } type. The retrieval version adds dynamic k,
// normalization, feedback boosts, and MMR — this is the lightweight path for
// direct berry_code_search calls.

function rrfFusion<T extends { id: string; score: number }>(
  rankedLists: T[][],
  limit: number,
  k = 60,
): T[] {
  const scores = new Map<string, { result: T; score: number }>();

  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const result = list[rank];
      const existing = scores.get(result.id);
      const rrfScore = 1 / (k + rank + 1);

      if (existing) {
        existing.score += rrfScore;
        if (result.score > existing.result.score) {
          existing.result = result;
        }
      } else {
        scores.set(result.id, { result, score: rrfScore });
      }
    }
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => ({ ...entry.result, score: entry.score }));
}

function toNum(val: unknown): number {
  if (typeof val === 'number') return val;
  if (val != null && typeof val === 'object' && 'toNumber' in val) {
    return (val as { toNumber: () => number }).toNumber();
  }
  return 0;
}

function candidateLimitForPostFilters(
  limit: number,
  options?: SymbolScopeOptions,
): number {
  if (!options?.language && !options?.file_path && !options?.kind && !options?.project_tag) return limit;
  return boundedOverfetchLimit(limit);
}

// ─── Project-scope filtering (T5/gap-11) ──────────────────────────────────────
//
// A canonical single-scope `project_tag` is the PRIMARY scope filter. A symbol
// matches a scope when its stored project_tag equals the tag, OR — as a FALLBACK
// for legacy symbols indexed before scoping (no stored tag) — it has no stored
// tag and (if a file_path hint is present) matches the path substring. The tag
// check is always applied BEFORE the path heuristic.

/**
 * Build the project-scope WHERE fragment for a Cypher symbol alias. Mirrors the
 * symbol-store helper so the fulltext channel scopes identically to findSymbols.
 */
function buildSymbolScopeCypher(
  alias: string,
  projectTag: string | undefined,
  filePath: string | undefined,
): { clause: string; params: Record<string, unknown> } {
  const tag = projectTag?.trim();
  const fp = filePath?.trim();

  if (tag) {
    const params: Record<string, unknown> = { project_tag: tag };
    if (fp) {
      params.file_path = fp;
      return {
        clause: `(${alias}.project_tag = $project_tag OR (${alias}.project_tag IS NULL AND toLower(${alias}.file_path) CONTAINS toLower($file_path)))`,
        params,
      };
    }
    // IDX-002B: with no path hint an un-stamped symbol carries NO evidence of
    // belonging to this project, so the legacy fallback admits the whole graph.
    // Under V2 the tag must match; the path-hinted fallback above is untouched.
    return {
      clause: CODE_SCOPE_V2
        ? `${alias}.project_tag = $project_tag`
        : `(${alias}.project_tag = $project_tag OR ${alias}.project_tag IS NULL)`,
      params,
    };
  }

  if (fp) {
    return {
      clause: `toLower(${alias}.file_path) CONTAINS toLower($file_path)`,
      params: { file_path: fp },
    };
  }

  return { clause: '', params: {} };
}

/** The scratch fields a candidate carries through scope filtering (dropped before return). */
interface ScopeScratch {
  project_tag?: string;
  file_path: string;
}

/**
 * Apply the project scope as the FIRST post-filter on vector/lexical candidates,
 * BEFORE the file_path path heuristic. Matches buildSymbolScopeCypher semantics:
 * tag-equality first, path-substring only as a fallback for un-stamped symbols.
 * When no project_tag is supplied, preserves the prior file_path-only behavior.
 * Generic over the element type so the caller's literal `source_type` survives.
 */
function applyScopePostFilter<T extends ScopeScratch>(
  results: T[],
  options?: SymbolScopeOptions,
): T[] {
  const tag = options?.project_tag?.trim();
  const fp = options?.file_path?.trim();

  if (tag) {
    return results.filter((r) => {
      if (r.project_tag === tag) return true; // PRIMARY: stored canonical tag
      if (r.project_tag) return false;         // stamped for a different project
      // FALLBACK: legacy un-stamped symbol — admit, narrowed by path hint if given.
      // IDX-002B mirrors buildSymbolScopeCypher exactly: an un-stamped row with no
      // path evidence is rejected under V2. The two must agree or the vector path
      // re-admits what the fulltext WHERE just excluded.
      if (fp) return includesCaseInsensitive(r.file_path, fp);
      return !CODE_SCOPE_V2;
    });
  }

  if (fp) return results.filter((r) => includesCaseInsensitive(r.file_path, fp));
  return results;
}

/**
 * @internal IDX-002B B12/B13 assert the post-filter and the Cypher agree under
 * both flag states. Exported (not re-implemented in the test) so the assertion
 * binds to the shipped predicate rather than a copy of it.
 */
export const applyScopePostFilterForTest = applyScopePostFilter;

/** Drop the scratch `project_tag` field so the public CodeSearchResult shape is unchanged. */
function stripScratch<T extends { project_tag?: string }>(r: T): Omit<T, 'project_tag'> {
  const { project_tag: _omit, ...rest } = r;
  return rest;
}

function candidateLimitForTemporalFilter(limit: number, hasTemporalFilter: boolean): number {
  if (!hasTemporalFilter) return limit;
  return boundedOverfetchLimit(limit);
}

function boundedOverfetchLimit(limit: number): number {
  return Math.min(Math.max(limit * 5, 50), 200);
}

function includesCaseInsensitive(value: string, search: string): boolean {
  return value.toLowerCase().includes(search.toLowerCase());
}
