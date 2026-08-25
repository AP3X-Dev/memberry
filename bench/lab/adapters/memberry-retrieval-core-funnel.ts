// RET-007 v4 — the FUNNEL control adapter (`memberry-retrieval-core-funnel-v1`).
//
// Additive to LAB-010's memberry-retrieval-core.ts, which hands the assembler
// the ENTIRE scoped corpus regardless of the scope it asks for (failed attempt
// 1b-a: under it memory B is never absent, only mis-ranked, so a second
// retrieval pass is unmeasurable). This adapter re-implements query() with ONE
// difference: `memoryLayer.load(scope)` HONORS `scope.task` through a
// deterministic, lab-owned, BM25-only candidate-selection step bounded to a
// FIXED top-N (N = K + 2 = 12, a constant by rule — never a knob). Selection
// only; ranking stays with the production assembler.
//
// DUPLICATED PRIVATE SYMBOLS (module-private in memberry-retrieval-core.ts;
// exporting them there would mutate the pinned control blob e138ed0…):
//   MAX_MEMORY_SOURCES, MAX_MEMORY_MARKDOWN_BYTES, MAX_ID_BYTES,
//   MAX_CODE_RESULTS, MAX_CODE_SIGNATURE_CODE_UNITS, DEFAULT_MAX_TOKENS,
//   FIXTURE_ASSEMBLED_AT, TEXT_BYTES, appendOwn, FIXTURE_DRIVER,
//   FIXTURE_FEEDBACK_STORE, FIXTURE_EMBEDDING, boundedId, headingSafeId,
//   neutralizeHeadings, confidenceSuffix, memoryMarkdown, fixtureLayers.
// `fixtureVector` and `projectAssemblyResults` are public exports of the core
// file and are imported, not duplicated. Parity of every duplicated path is
// PROVEN by the differential test in
// bench/lab/__tests__/memberry-retrieval-core-funnel.test.ts (injected N >=
// corpus must reproduce memberry-retrieval-core-v1 byte for byte).
//
// Import shape: same audit as the core adapter (registered-adapters.ts) — no
// non-relative specifiers, no scorer-only paths, no Node globals.

import type {
  AdapterCapability,
  LabMemory,
  LabQueryResult,
  QueryRequest,
  QueryResponse,
} from '../contracts/adapter.js';
import { InMemoryAdapter, inRequestedScope, isCurrent, namespaceKey } from './in-memory.js';
import { fixtureVector, projectAssemblyResults } from './memberry-retrieval-core.js';
import {
  UnifiedAssembler,
  type AssemblerCodeLayer,
  type AssemblerMemoryLayer,
} from '../../../packages/retrieval/src/assembler.js';
import type { FeedbackRedisLayer } from '../../../packages/retrieval/src/feedback.js';

/** Funnel top-N: N = K + 2 = 12. Constant by rule; equals MULTIHOP_V4_FUNNEL_TOP_N (pinned by test). */
export const FUNNEL_TOP_N = 12;
/** BM25 parameters — fixed, never tuned. */
export const FUNNEL_BM25_K1 = 1.2;
export const FUNNEL_BM25_B = 0.75;

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

const TEXT_BYTES = new TextEncoder();

function appendOwn<T>(target: T[], value: T): void {
  Object.defineProperty(target, target.length, {
    value, enumerable: true, writable: true, configurable: true,
  });
}

const FIXTURE_DRIVER = {
  session: () => ({
    run: async () => ({ records: [] as unknown[] }),
    close: async () => undefined,
  }),
};

const FIXTURE_FEEDBACK_STORE: FeedbackRedisLayer = {
  async zincrby(): Promise<number> { return 0; },
  async zrevrangeWithScores(): Promise<Array<{ member: string; score: number }>> { return []; },
  async lpush(): Promise<number> { return 0; },
  async ltrim(): Promise<void> { return undefined; },
};

const FIXTURE_EMBEDDING = {
  async embed(text: string): Promise<number[]> { return fixtureVector(text); },
  async embedBatch(texts: string[]): Promise<number[][]> { return texts.map(fixtureVector); },
};

function boundedId(id: string): boolean {
  return id.length > 0 && id.length <= MAX_ID_BYTES && TEXT_BYTES.encode(id).length <= MAX_ID_BYTES;
}

function headingSafeId(id: string): boolean {
  return boundedId(id) && !/[\]\r\n]/.test(id);
}

function neutralizeHeadings(content: string): string {
  return content.replace(/^#/gm, ' #');
}

function confidenceSuffix(confidence: number | undefined): string {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return '';
  if (confidence < 0 || confidence > 1) return '';
  return ` (confidence: ${confidence.toFixed(3)})`;
}

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

/** Funnel tokenizer: lowercase, split on non-alphanumerics, keep tokens of length >= 2. */
export function funnelTokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((token) => token.length >= 2);
}

export interface FunnelSelection {
  /** Selected ids in CORPUS order (BM25 top-N unioned with the seed ids). */
  readonly selectedIds: readonly string[];
  /** BM25 score per corpus id (every id, selected or not). */
  readonly scores: ReadonlyMap<string, number>;
  /** Score of the N-th ranked memory (the emission boundary), or null when corpus <= N. */
  readonly boundaryScore: number | null;
  /** Count of memories whose score equals the boundary score (>= 1 when a boundary exists). */
  readonly tiedAtBoundary: number;
}

/**
 * Deterministic BM25 over `content` vs `task`: k1 = 1.2, b = 0.75, IDF over the
 * given corpus, ties broken by corpus order. Takes the top-N, unions the seed
 * ids (never a filter), returns the selection in corpus order.
 */
export function funnelSelect(
  memories: readonly LabMemory[],
  task: string,
  topN: number,
  seedIds: readonly string[] = [],
): FunnelSelection {
  const queryTerms = [...new Set(funnelTokenize(task))];
  const documents = memories.map((memory) => funnelTokenize(memory.content));
  const corpusSize = documents.length;
  const averageLength = corpusSize === 0 ? 0 : documents.reduce((sum, tokens) => sum + tokens.length, 0) / corpusSize;
  const documentFrequency = new Map<string, number>();
  for (const tokens of documents) {
    for (const term of new Set(tokens)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const scores = new Map<string, number>();
  const ranked: Array<{ index: number; score: number }> = [];
  documents.forEach((tokens, index) => {
    let score = 0;
    for (const term of queryTerms) {
      const df = documentFrequency.get(term) ?? 0;
      if (df === 0) continue;
      let tf = 0;
      for (const token of tokens) if (token === term) tf += 1;
      if (tf === 0) continue;
      const idf = Math.log(1 + (corpusSize - df + 0.5) / (df + 0.5));
      const lengthNorm = 1 - FUNNEL_BM25_B + FUNNEL_BM25_B * (tokens.length / (averageLength || 1));
      score += idf * ((tf * (FUNNEL_BM25_K1 + 1)) / (tf + FUNNEL_BM25_K1 * lengthNorm));
    }
    scores.set(memories[index]!.id, score);
    ranked.push({ index, score });
  });
  ranked.sort((left, right) => (right.score - left.score) || (left.index - right.index));
  const boundary = corpusSize > topN ? ranked[topN - 1]!.score : null;
  const tiedAtBoundary = boundary === null ? 0 : ranked.filter((entry) => entry.score === boundary).length;
  const selected = new Set(ranked.slice(0, topN).map((entry) => memories[entry.index]!.id));
  const seeds = new Set(seedIds);
  const selectedIds = memories.filter((memory) => selected.has(memory.id) || seeds.has(memory.id)).map(({ id }) => id);
  return { selectedIds, scores, boundaryScore: boundary, tiedAtBoundary };
}

/**
 * Same partition as the core adapter (code rows vs memory markdown). The ONLY
 * behavioural delta: the memory layer honours `scope.task` (and unions
 * `scope.resolvedEntityIds`) through the bounded BM25 funnel. `scope.queryVector`
 * is ignored (fixture vectors are a positional char hash; cosine over them is
 * noise — failed attempt 1c-a).
 */
function fixtureLayers(memories: readonly LabMemory[], topN: number): {
  codeLayer: AssemblerCodeLayer;
  memoryLayer: AssemblerMemoryLayer;
} {
  const memoryRows = memories.filter((memory) => memory.kind !== 'code');
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
    memoryLayer: {
      load: async (scope) => {
        const selection = funnelSelect(memoryRows, scope.task, topN, scope.resolvedEntityIds ?? []);
        const chosen = new Set(selection.selectedIds);
        const { markdown, sources } = memoryMarkdown(memoryRows.filter((memory) => chosen.has(memory.id)));
        return { markdown, tokens: 0, sources, assembled_at: FIXTURE_ASSEMBLED_AT };
      },
    },
  };
}

/** Scores the production retrieval assembler over a BM25-funnelled fixture corpus. */
export class MemBerryRetrievalCoreFunnelAdapter extends InMemoryAdapter {
  readonly id = 'memberry-retrieval-core-funnel-v1';
  readonly displayName = 'MemBerry production retrieval core (lab funnel)';
  readonly executionMode = 'fixture' as const;
  readonly capabilities: ReadonlySet<AdapterCapability> = new Set([
    'namespaces', 'feedback', 'stats', 'cleanup', 'project-scope', 'tenant-scope', 'temporal-filtering',
  ]);
  /** Effective funnel size. The registered row constructs with no argument, so this is always 12 there. */
  readonly funnelTopN: number;

  /**
   * `testOnlyFunnelTopN` exists solely for the differential parity test
   * (N >= corpus reproduces memberry-retrieval-core-v1). It is NOT reachable
   * from the registered factory row, which passes no argument (asserted by
   * bench/lab/__tests__/memberry-retrieval-core-funnel.test.ts).
   */
  constructor(testOnlyFunnelTopN?: number) {
    super();
    if (testOnlyFunnelTopN !== undefined
      && (!Number.isInteger(testOnlyFunnelTopN) || testOnlyFunnelTopN < 1)) {
      throw new Error('funnel top-N must be a positive integer');
    }
    this.funnelTopN = testOnlyFunnelTopN ?? FUNNEL_TOP_N;
  }

  async query(request: QueryRequest): Promise<QueryResponse> {
    this.queryCount += 1;
    const scoped = (this.stores.get(namespaceKey(request.namespace)) ?? [])
      .filter((memory) => inRequestedScope(memory, request.namespace) && isCurrent(memory, request.asOf));
    const layers = fixtureLayers(scoped, this.funnelTopN);
    const assembler = new UnifiedAssembler(
      FIXTURE_DRIVER as never,
      FIXTURE_FEEDBACK_STORE,
      layers.codeLayer,
      layers.memoryLayer,
      FIXTURE_EMBEDDING,
      null,
      null,
    );
    // 'ranked', never 'auto' (see the core adapter). No tenantId is threaded, so
    // the assembler resolves its default tenant and keeps the code channel
    // enabled; tenant and project scope are enforced above by
    // namespaceKey + inRequestedScope, before the assembler sees a memory.
    const context = await assembler.assemble(request.query, {
      strategy: 'ranked',
      include_code: true,
      include_arch: false,
      include_memory: true,
      max_tokens: request.tokenBudget ?? DEFAULT_MAX_TOKENS,
    });
    const results: LabQueryResult[] = projectAssemblyResults(context.sections, request.limit);
    return { results };
  }
}
