// LAB-010 — the required-CI lab adapter that scores PRODUCTION retrieval
// assembly instead of a lab-owned proxy ranker.
//
// health/ingest/feedback/stats/cleanup are inherited from InMemoryAdapter
// exactly as memberry-proxy.ts inherits them, so the only behavioural delta
// versus the proxy is query(): the scoped corpus is handed to the real
// UnifiedAssembler and the returned UnifiedContext is projected back into
// LabQueryResult. No ranking decision is made in this file.
//
// Import shape. This file is itself audited by auditAdapterDependencies
// (registered-adapters.ts:144-146); only files under packages/ are carved out of
// that scan. So `neo4j-driver`, `@memberry/core` and `@memberry/neo4j` may never
// be named here. Production types are reached by relative path *through*
// packages/ (resolveLocalModule maps .js to .ts), or declared structurally.
//
// The provider fixtures below are shaped against the assembler's own provider
// validators, which fail LOUDLY inside the assembler and are then swallowed by
// each channel's catch. A malformed fixture therefore yields an empty channel
// and a silently vacuous benchmark, which is why every bound is pinned to the
// constant it mirrors.

import type {
  AdapterCapability,
  LabMemory,
  LabQueryResult,
  QueryRequest,
  QueryResponse,
} from '../contracts/adapter.js';
import { InMemoryAdapter, inRequestedScope, isCurrent, namespaceKey } from './in-memory.js';
import {
  UnifiedAssembler,
  type AssemblerCodeLayer,
  type AssemblerMemoryLayer,
} from '../../../packages/retrieval/src/assembler.js';
import type { FeedbackRedisLayer } from '../../../packages/retrieval/src/feedback.js';
import { createServedRerankerProviderV1 } from '../../../packages/retrieval/src/served-reranker.js';

/** assembler.ts MAX_ASSEMBLER_MEMORY_SOURCES. */
const MAX_MEMORY_SOURCES = 512;
/** assembler.ts MAX_ASSEMBLER_PROVIDER_STRING_BYTES, applied to the whole markdown body. */
const MAX_MEMORY_MARKDOWN_BYTES = 65_536;
/** assembler.ts MAX_ASSEMBLER_PROVIDER_ID_BYTES. */
const MAX_ID_BYTES = 512;
/** assembler.ts MAX_ASSEMBLER_CODE_RESULTS. */
const MAX_CODE_RESULTS = 20;
/** Keeps the 20 code rows well inside MAX_ASSEMBLER_PROVIDER_AGGREGATE_STRING_BYTES. */
const MAX_CODE_SIGNATURE_CODE_UNITS = 2_048;
/** Mirrors the assembler's own default when a probe declares no token budget. */
const DEFAULT_MAX_TOKENS = 8_000;
/** Fixture persistence has no wall clock. The assembler only bounds-checks this field. */
const FIXTURE_ASSEMBLED_AT = '1970-01-01T00:00:00.000Z';
const FIXTURE_EMBEDDING_DIMENSIONS = 8;
const FIXTURE_EMBEDDING_MODULUS = 1_000_003;

const TEXT_BYTES = new TextEncoder();

function appendOwn<T>(target: T[], value: T): void {
  Object.defineProperty(target, target.length, {
    value, enumerable: true, writable: true, configurable: true,
  });
}

/**
 * Empty graph. getCollectionSize sees no `count(s)` record, so cachedCollectionSize
 * stays undefined and rrfFusion takes the branch with neither scaleRrfK nor
 * normalizeScores — the deterministic one.
 */
const FIXTURE_DRIVER = {
  session: () => ({
    run: async () => ({ records: [] as unknown[] }),
    close: async () => undefined,
  }),
};

/** Empty feedback store: getBoosts returns no learned weights, on every run. */
const FIXTURE_FEEDBACK_STORE: FeedbackRedisLayer = {
  async zincrby(): Promise<number> { return 0; },
  async zrevrangeWithScores(): Promise<Array<{ member: string; score: number }>> { return []; },
  async lpush(): Promise<number> { return 0; },
  async ltrim(): Promise<void> { return undefined; },
};

/** Deterministic hash vector. No network, no model: same text, same vector, always. */
export function fixtureVector(text: string): number[] {
  // Array.from uses own-property creation for every index. That keeps hostile
  // inherited numeric setters from observing or substituting fixture evidence.
  const vector = Array.from({ length: FIXTURE_EMBEDDING_DIMENSIONS }, () => 0);
  for (let index = 0; index < text.length; index += 1) {
    const slot = index % FIXTURE_EMBEDDING_DIMENSIONS;
    vector[slot] = (vector[slot]! * 31 + text.charCodeAt(index)) % FIXTURE_EMBEDDING_MODULUS;
  }
  return vector.map((value) => value / FIXTURE_EMBEDDING_MODULUS);
}

const FIXTURE_EMBEDDING = {
  async embed(text: string): Promise<number[]> { return fixtureVector(text); },
  async embedBatch(texts: string[]): Promise<number[][]> { return texts.map(fixtureVector); },
};

function boundedId(id: string): boolean {
  return id.length > 0 && id.length <= MAX_ID_BYTES && TEXT_BYTES.encode(id).length <= MAX_ID_BYTES;
}

/** parseMemoryMarkdown reads the id out of `## [id]`, so these bytes must not appear in one. */
function headingSafeId(id: string): boolean {
  return boundedId(id) && !/[\]\r\n]/.test(id);
}

/**
 * A corpus line that begins with `#` would be read as a new `##` heading and break
 * the ids-equal-sources invariant parseMemoryMarkdown enforces. One leading space
 * removes it from the heading grammar and changes nothing else about the text.
 */
function neutralizeHeadings(content: string): string {
  return content.replace(/^#/gm, ' #');
}

/** The optional `(confidence: n)` suffix parseMemoryMarkdown accepts, or nothing. */
function confidenceSuffix(confidence: number | undefined): string {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return '';
  if (confidence < 0 || confidence > 1) return '';
  return ` (confidence: ${confidence.toFixed(3)})`;
}

/**
 * Corpus order in, corpus order out. This layer stands in for persistence only —
 * every relevance decision is left to the assembler, which is the subject under
 * evaluation. Truncation is by the assembler's own provider bounds.
 */
function memoryMarkdown(memories: readonly LabMemory[]): { markdown: string; sources: string[] } {
  const sections: string[] = [];
  const sources: string[] = [];
  let bytes = 0;
  for (const memory of memories) {
    if (sources.length >= MAX_MEMORY_SOURCES) break;
    if (!headingSafeId(memory.id)) continue;
    const section = `## [${memory.id}]${confidenceSuffix(memory.confidence)}\n${neutralizeHeadings(memory.content)}\n`;
    const size = TEXT_BYTES.encode(section).length;
    if (bytes + size > MAX_MEMORY_MARKDOWN_BYTES) break;
    bytes += size;
    appendOwn(sections, section);
    appendOwn(sources, memory.id);
  }
  return { markdown: sections.join(''), sources };
}

/**
 * The corpus is partitioned by kind rather than mirrored into both channels: an id
 * that appeared in both lists would be merged by rrfFusion into one entry whose
 * source_type depends on which body happened to be longer.
 */
function fixtureLayers(memories: readonly LabMemory[]): {
  codeLayer: AssemblerCodeLayer;
  memoryLayer: AssemblerMemoryLayer;
} {
  const { markdown, sources } = memoryMarkdown(memories.filter((memory) => memory.kind !== 'code'));
  const codeRows = memories
    .filter((memory) => memory.kind === 'code' && boundedId(memory.id))
    .slice(0, MAX_CODE_RESULTS)
    .map((memory, rank) => ({
      id: memory.id,
      source_type: 'symbol',
      name: memory.id,
      kind: 'code',
      file_path: memory.id,
      start_line: 0,
      signature: memory.content.slice(0, MAX_CODE_SIGNATURE_CODE_UNITS),
      doc_comment: '',
      score: 1 / (rank + 1),
    }));
  return {
    codeLayer: { search: async () => codeRows },
    // `tokens` is only bounds-checked against the requested budget by
    // snapshotAssemblerMemoryResult; reporting 0 can never trip that ceiling.
    memoryLayer: {
      load: async () => ({ markdown, tokens: 0, sources, assembled_at: FIXTURE_ASSEMBLED_AT }),
    },
  };
}

/** Preserve the assembler's post-budget presentation order exactly. */
export function projectAssemblyResults(
  sections: readonly { items: readonly { id: string; score: number }[] }[],
  limit: number,
): LabQueryResult[] {
  return sections
    .flatMap((section) => section.items)
    .map((item) => ({ id: item.id, score: item.score }))
    .slice(0, limit);
}

/** Scores the production retrieval assembler over a fixture-persisted corpus. */
export class MemBerryRetrievalCoreAdapter extends InMemoryAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly executionMode = 'fixture' as const;
  readonly capabilities: ReadonlySet<AdapterCapability> = new Set([
    'namespaces', 'feedback', 'stats', 'cleanup', 'project-scope', 'tenant-scope', 'temporal-filtering',
  ]);

  constructor(private readonly rerankerMode: 'legacy' | 'disabled' | 'served' = 'legacy') {
    super();
    this.id = rerankerMode === 'disabled'
      ? 'memberry-retrieval-core-disabled-v1'
      : rerankerMode === 'served'
        ? 'memberry-retrieval-core-served-v1'
        : 'memberry-retrieval-core-v1';
    this.displayName = rerankerMode === 'served'
      ? 'MemBerry production retrieval core (served reranker)'
      : rerankerMode === 'disabled'
        ? 'MemBerry production retrieval core (reranker disabled)'
        : 'MemBerry production retrieval core';
  }

  async query(request: QueryRequest): Promise<QueryResponse> {
    this.queryCount += 1;
    const scoped = (this.stores.get(namespaceKey(request.namespace)) ?? [])
      .filter((memory) => inRequestedScope(memory, request.namespace) && isCurrent(memory, request.asOf));
    const layers = fixtureLayers(scoped);
    // A fresh assembler per query: no collection-size cache, no boost cache and no
    // other state survives a call, so two identical calls cannot diverge.
    const assembler = new UnifiedAssembler(
      // Structural stub. `Driver` lives in neo4j-driver, a specifier this file may
      // not name; the cast is the same one the production assembler tests use.
      FIXTURE_DRIVER as never,
      FIXTURE_FEEDBACK_STORE,
      layers.codeLayer,
      layers.memoryLayer,
      FIXTURE_EMBEDDING,
      null,
      this.rerankerMode === 'served' ? createServedRerankerProviderV1() : null,
    );
    // 'ranked', never 'auto': 'auto' would route through classifyIntent, whose
    // decision depends on this fixture embedding provider and can select GRAPH,
    // which reads the empty stub driver and returns nothing.
    //
    // No tenantId is threaded, so the assembler resolves its default tenant and
    // keeps the code channel enabled. Tenant and project scope are enforced above
    // by namespaceKey + inRequestedScope, before the assembler sees a memory.
    const context = await assembler.assemble(request.query, {
      strategy: 'ranked',
      include_code: true,
      include_arch: false,
      include_memory: true,
      max_tokens: request.tokenBudget ?? DEFAULT_MAX_TOKENS,
      ...(this.rerankerMode === 'disabled' ? { servedRerankerDisabled: true as const } : {}),
    });
    // Only id and score cross this boundary. context.assembled_at is wall clock,
    // and nothing derived from it may enter a lab result.
    //
    // The returned section/item sequence is the production presentation and
    // budget decision. Re-sorting here would create a lab-only ranking path.
    return { results: projectAssemblyResults(context.sections, request.limit) };
  }
}
