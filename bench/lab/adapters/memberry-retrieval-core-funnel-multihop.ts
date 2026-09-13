// RET-007 v4 CANDIDATE adapters — the funnel control with the multihop
// expansion enabled BY CONSTRUCTION (never by env), one class per
// pre-registered policy:
//   memberry-retrieval-core-funnel-multihop-evidence-bridge-v1  (P1, shippable)
//   memberry-retrieval-core-funnel-multihop-fact-lexical-v1     (P4', dev control; deleted at D6)
//
// Same partition, same BM25 funnel (N = 12), same production assembler as
// memberry-retrieval-core-funnel.ts. The ONLY delta: the assembler's
// RET-007 v4 legacy-arm expansion is on, with the lab budget
// (MULTIHOP_LAB_BUDGET_MS = Infinity) and NO clock, so no timing path is
// reachable. The probe is the assembler's own: `memoryLayer.load({...scope,
// task: conditionedTask})` — i.e. this funnel, conditioned on the bridge.
//
// DUPLICATED PRIVATE SYMBOLS (module-private in memberry-retrieval-core-funnel.ts,
// whose blob d4cdc03… is pinned by the qualified instrument and may not be
// edited): MAX_MEMORY_SOURCES, MAX_MEMORY_MARKDOWN_BYTES, MAX_ID_BYTES,
// MAX_CODE_RESULTS, MAX_CODE_SIGNATURE_CODE_UNITS, DEFAULT_MAX_TOKENS,
// FIXTURE_ASSEMBLED_AT, TEXT_BYTES, appendOwn, FIXTURE_DRIVER,
// FIXTURE_FEEDBACK_STORE, FIXTURE_EMBEDDING, boundedId, headingSafeId,
// neutralizeHeadings, confidenceSuffix, memoryMarkdown, fixtureLayers.
// `funnelSelect`, `FUNNEL_TOP_N`, `fixtureVector`, `projectAssemblyResults`
// are public exports and are imported. Parity of the duplicated path is
// proven by bench/lab/__tests__/memberry-retrieval-core-funnel-multihop.test.ts
// (a comparison query, where the gate never fires, reproduces the control
// byte for byte).
//
// The classes extend InMemoryAdapter rather than the funnel class because the
// funnel's `readonly id` is an inferred string literal that a subclass cannot
// re-declare (TS2416); behaviour is otherwise the funnel's.

import type {
  AdapterCapability,
  LabMemory,
  LabQueryResult,
  QueryRequest,
  QueryResponse,
} from '../contracts/adapter.js';
import { InMemoryAdapter, inRequestedScope, isCurrent, namespaceKey } from './in-memory.js';
import { fixtureVector, projectAssemblyResults, fixtureSemanticAuthority } from './memberry-retrieval-core.js';
import { FUNNEL_TOP_N, funnelSelect } from './memberry-retrieval-core-funnel.js';
import {
  UnifiedAssembler,
  type AssemblerCodeLayer,
  type AssemblerMemoryLayer,
} from '../../../packages/retrieval/src/assembler.js';
import type { FeedbackRedisLayer } from '../../../packages/retrieval/src/feedback.js';
import {
  MULTIHOP_LAB_BUDGET_MS,
  type MultihopBridgeDerivation,
} from '../../../packages/retrieval/src/multihop-expansion.js';

const MAX_MEMORY_SOURCES = 512;
const MAX_MEMORY_MARKDOWN_BYTES = 65_536;
const MAX_ID_BYTES = 512;
const MAX_CODE_RESULTS = 20;
const MAX_CODE_SIGNATURE_CODE_UNITS = 2_048;
const DEFAULT_MAX_TOKENS = 8_000;
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

/** Funnel control + multihop expansion fixed to one policy by construction. */
/**
 * The one place the calib gate-precision key is built. The adapter records under it
 * and the dev-evaluation harness looks up under it, so a separator that differs
 * between them silently turns every lookup into `undefined`. Exported so the
 * harness and the tests cannot re-derive it independently and drift apart.
 */
export function calibGateKey(project: string, query: string): string {
  return `${project} ${query}`;
}

abstract class MemBerryRetrievalCoreFunnelMultihopAdapter extends InMemoryAdapter {
  readonly executionMode = 'fixture' as const;
  readonly capabilities: ReadonlySet<AdapterCapability> = new Set([
    'namespaces', 'feedback', 'stats', 'cleanup', 'project-scope', 'tenant-scope', 'temporal-filtering',
  ]);
  /** Always the instrument constant 12 (no injection point). */
  readonly funnelTopN = FUNNEL_TOP_N;
  /** Per-query gate outcome keyed by `${project} ${query}` — diagnostic only (calib gate precision). */
  readonly firings = new Map<string, boolean>();

  /**
   * `testOnlyClock` exists solely for the lab-determinism pin (an always-timeout
   * clock must leave output identical because the lab budget is Infinity). The
   * registered factory rows construct with no argument.
   */
  protected constructor(readonly policy: MultihopBridgeDerivation, private readonly testOnlyClock?: () => number) {
    super();
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
      fixtureSemanticAuthority(scoped, request),
    );
    const key = calibGateKey(request.namespace.project, request.query);
    // Gate diagnostic: the funnel is called once for pass 1 and once per probe.
    let loads = 0;
    const load = layers.memoryLayer.load;
    layers.memoryLayer.load = async (scope) => { loads += 1; return load(scope); };
    assembler.enableMultihopExpansionV1({
      policy: this.policy,
      budgetMs: MULTIHOP_LAB_BUDGET_MS,
      ...(this.testOnlyClock ? { clock: this.testOnlyClock } : {}),
    });
    const context = await assembler.assemble(request.query, {
      strategy: 'ranked',
      include_code: true,
      include_arch: false,
      include_memory: true,
      max_tokens: request.tokenBudget ?? DEFAULT_MAX_TOKENS,
    });
    this.firings.set(key, loads > 1);
    const results: LabQueryResult[] = projectAssemblyResults(context.sections, request.limit);
    return { results };
  }
}

export class MemBerryRetrievalCoreFunnelMultihopEvidenceBridgeAdapter extends MemBerryRetrievalCoreFunnelMultihopAdapter {
  readonly id = 'memberry-retrieval-core-funnel-multihop-evidence-bridge-v1';
  readonly displayName = 'MemBerry production retrieval core (lab funnel + multihop evidence-bridge)';
  constructor(testOnlyClock?: () => number) { super('evidence-bridge', testOnlyClock); }
}

export class MemBerryRetrievalCoreFunnelMultihopFactLexicalAdapter extends MemBerryRetrievalCoreFunnelMultihopAdapter {
  readonly id = 'memberry-retrieval-core-funnel-multihop-fact-lexical-v1';
  readonly displayName = 'MemBerry production retrieval core (lab funnel + multihop fact-lexical)';
  constructor(testOnlyClock?: () => number) { super('fact-lexical', testOnlyClock); }
}
