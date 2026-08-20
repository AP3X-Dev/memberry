// RET-008 — tenant-scoped learned routing and feedback, proved through the
// production assembler rather than the FeedbackTracker in isolation.
//
// The existing isolation tests in feedback.test.ts call FeedbackTracker
// directly, so nothing pinned the hop that actually runs in production:
// assembleRankedInternal resolves the tenant and hands it to getBoosts, whose
// key namespacing is what keeps one tenant's learned weights out of another
// tenant's ranking. Every case below drives a real UnifiedAssembler with a
// recording fake store, so the tenant travels the whole way from the caller's
// options to the Redis key.
//
// Bindings that apply to every case here:
//   - strategy is always 'ranked': 'auto' can classify a GRAPH intent and route
//     to deterministic assembly, which never reaches the feedback lookup.
//   - resolvedEntityIds is never passed: the stable-ID lane short-circuits the
//     boost lookup to undefined and would make every claim below vacuous.
//   - order/score comparisons first assert the compared list is non-empty and
//     carries at least two distinct results. The memory markdown below has to
//     parse; a malformed fake throws inside the memory channel and is swallowed
//     by that channel's catch, leaving an empty fused list and no error.
//   - the task string carries no symbol-type hint word ('function', 'class',
//     'method', 'symbol', ...). Such a word makes inferSourceTypeBoost return a
//     symbol preference that is merged into the boosts AFTER the lookup, so the
//     cold-start emission would be 1.25 rather than 1.

import { describe, expect, it } from 'vitest';

import {
  UnifiedAssembler,
  type AssemblerCodeLayer,
  type AssemblerMemoryLayer,
} from '../assembler.js';
import { FeedbackTracker, type FeedbackRedisLayer } from '../feedback.js';
import type { UnifiedContext } from '../types.js';

// No symbol-type hint token, and no token that occurs in any fake result text,
// so the lexical text boost is exactly 0 for every candidate and cannot mask or
// manufacture a reorder.
const TASK = 'quorbix telluvane vessik';

// The entity planted in mem-2's body. Feedback recording extracts capitalized
// words from the signal query, so this is what lands in the boost set.
const PLANTED_ENTITY = 'Zephyrite';

const ASSEMBLED_AT = '2026-08-18T00:00:00.000Z';

const LEGACY_ENTITY_KEY = 'amp:feedback:entity_boost';
const LEGACY_SOURCE_KEY = 'amp:feedback:source_boost';
const ACME_ENTITY_KEY = 'amp:feedback:acme:entity_boost';
const ACME_SOURCE_KEY = 'amp:feedback:acme:source_boost';
const NAMESPACED_BOOST_KEY = /^amp:feedback:[^:]+:(?:entity|source)_boost$/;

// Two memory sections in one markdown body. parseMemoryMarkdown is strict: the
// text must start at index 0 with a '## ' heading, every heading must be the
// bracket form '## [id]', ids must be unique, and the parsed ids must equal
// `sources` exactly in order and length. Only `content` is controllable — the
// parsed title is the literal '[id]' — so the planted entity lives in the body
// of the second section, which is also where the substring guard inside the
// fusion boost loop has to find it.
const MEMORY_MARKDOWN = [
  '## [mem-1]',
  'orbital ledger note one',
  '## [mem-2]',
  `orbital ledger note two about ${PLANTED_ENTITY}`,
  '',
].join('\n');
const MEMORY_SOURCES = ['mem-1', 'mem-2'];

const MEMORY_VALUE = {
  markdown: MEMORY_MARKDOWN,
  tokens: 10,
  sources: MEMORY_SOURCES,
  assembled_at: ASSEMBLED_AT,
};

type RecordingStore = FeedbackRedisLayer & { reads: string[]; writes: string[] };

function makeStore(mode: 'available' | 'rejecting' = 'available'): RecordingStore {
  const sets = new Map<string, Map<string, number>>();
  const reads: string[] = [];
  const writes: string[] = [];
  return {
    reads,
    writes,
    async zincrby(key: string, increment: number, member: string): Promise<number> {
      writes.push(key);
      const set = sets.get(key) ?? new Map<string, number>();
      const next = (set.get(member) ?? 0) + increment;
      set.set(member, next);
      sets.set(key, set);
      return next;
    },
    async zrevrangeWithScores(
      key: string, start: number, stop: number,
    ): Promise<Array<{ member: string; score: number }>> {
      reads.push(key);
      if (mode === 'rejecting') throw new Error('feedback_store_unavailable');
      const entries = [...(sets.get(key) ?? new Map<string, number>())]
        .sort((a, b) => b[1] - a[1])
        .map(([member, score]) => ({ member, score }));
      return entries.slice(start, stop + 1);
    },
    async lpush(key: string): Promise<number> {
      writes.push(key);
      return 1;
    },
    async ltrim(): Promise<void> {
      return undefined;
    },
  };
}

function makeDriver() {
  return {
    session: () => ({
      run: async () => ({ records: [] }),
      close: async () => undefined,
    }),
  };
}

const EMBEDDING = { embed: async () => [0], embedBatch: async () => [] };

const MEMORY_LAYER: AssemblerMemoryLayer = {
  load: async () => MEMORY_VALUE,
  loadFreshObserved: async () => ({
    value: MEMORY_VALUE,
    observation: {
      channels: [{ channel: 'memory.scope', outcome: 'success' }],
      candidates: [
        {
          privateId: 'mem-1', sourceType: 'semantic',
          channels: [{ channel: 'memory.scope', rank: 1 }], evidence: {}, estimatedTokens: 8,
        },
        {
          privateId: 'mem-2', sourceType: 'semantic',
          channels: [{ channel: 'memory.scope', rank: 2 }], evidence: {}, estimatedTokens: 12,
        },
      ],
      finalIds: ['mem-1', 'mem-2'],
    },
  }),
};

function makeAssembler(
  store: RecordingStore,
  memoryLayer: AssemblerMemoryLayer | null = MEMORY_LAYER,
  codeLayer: AssemblerCodeLayer | null = null,
): UnifiedAssembler {
  return new UnifiedAssembler(makeDriver() as never, store, codeLayer, memoryLayer, EMBEDDING);
}

const RANKED = { strategy: 'ranked' as const, include_arch: false };

function recordUsefulFeedback(store: RecordingStore, tenantId?: string): Promise<void> {
  return new FeedbackTracker(store).recordFeedback({
    query: PLANTED_ENTITY,
    result_id: 'mem-2',
    source_type: 'semantic',
    was_useful: true,
    session_id: 'session-ret008',
    timestamp: ASSEMBLED_AT,
  }, tenantId);
}

/**
 * Non-emptiness gate for every order/score comparison below. A silently
 * unparsed memory fake yields an empty fused list, which would make every
 * equality assertion pass while proving nothing — so this runs before each
 * comparison, not once per file. Item order is read inside the single
 * 'Knowledge' section: memory results are all stamped 'semantic', so they land
 * in exactly one section and the reorder is visible only within it.
 */
function knowledgeItemIds(context: UnifiedContext): string[] {
  const knowledge = context.sections.filter((section) => section.heading === 'Knowledge');
  expect(knowledge).toHaveLength(1);
  const ids = knowledge[0]!.items.map((item) => item.id);
  expect(ids.length).toBeGreaterThanOrEqual(2);
  expect(new Set(ids).size).toBe(ids.length);
  return ids;
}

async function ticks(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

describe('RET-008 tenant-scoped feedback through the assembler', () => {
  it('A1 reads a named tenant own boost namespace and never the legacy one', async () => {
    const store = makeStore();
    await makeAssembler(store).assemble(TASK, { ...RANKED, tenantId: 'acme' });

    // Presence AND absence: absence alone would also hold if the boost lookup
    // never ran at all, which is the failure this case exists to exclude.
    expect(store.reads).toEqual(expect.arrayContaining([ACME_ENTITY_KEY, ACME_SOURCE_KEY]));
    expect(store.reads).not.toContain(LEGACY_ENTITY_KEY);
    expect(store.reads).not.toContain(LEGACY_SOURCE_KEY);
  });

  it('A2 leaves one tenant ranking untouched by another tenant feedback', async () => {
    const store = makeStore();
    const assembler = makeAssembler(store);

    const baseline = await assembler.assemble(TASK, { ...RANKED, tenantId: 'acme' });
    const baselineIds = knowledgeItemIds(baseline);

    await recordUsefulFeedback(store, 'beta');

    const afterOtherTenant = await assembler.assemble(TASK, { ...RANKED, tenantId: 'acme' });
    expect(knowledgeItemIds(afterOtherTenant)).toEqual(baselineIds);
    expect(afterOtherTenant.sections).toEqual(baseline.sections);

    // The entity boost is applied through a substring guard against result text.
    // Without this, a leaked boost would multiply nothing and the leak would be
    // invisible: the entity boosted for `beta` has to occur in text `acme` gets
    // back, so a shared namespace would visibly reorder the pair above.
    const acmeText = afterOtherTenant.sections
      .flatMap((section) => section.items.map((item) => `${item.id} ${item.content}`))
      .join('\n');
    expect(acmeText).toContain(PLANTED_ENTITY);
  });

  it('A3 keeps the default tenant on legacy keys and out of a named tenant ranking', async () => {
    const store = makeStore();
    const assembler = makeAssembler(store);

    await assembler.assemble(TASK, RANKED);
    // Deliberate cold-start preservation: the default (single-tenant / legacy)
    // tenant keeps the original un-namespaced keys so existing boost data is not
    // orphaned. Namespacing it would break this.
    expect(store.reads).toEqual(expect.arrayContaining([LEGACY_ENTITY_KEY, LEGACY_SOURCE_KEY]));
    expect(store.reads.filter((key) => NAMESPACED_BOOST_KEY.test(key))).toEqual([]);

    // The remaining isolation direction: default -> named.
    const namedBaseline = await assembler.assemble(TASK, { ...RANKED, tenantId: 'acme' });
    const namedBaselineIds = knowledgeItemIds(namedBaseline);
    await recordUsefulFeedback(store);
    const namedAfterDefault = await assembler.assemble(TASK, { ...RANKED, tenantId: 'acme' });
    expect(knowledgeItemIds(namedAfterDefault)).toEqual(namedBaselineIds);
    expect(namedAfterDefault.sections).toEqual(namedBaseline.sections);
  });

  it('A4(i) lets a tenant own entity boosts reorder its results', async () => {
    const coldStore = makeStore();
    const cold = await makeAssembler(coldStore).assemble(TASK, { ...RANKED, tenantId: 'acme' });
    expect(knowledgeItemIds(cold)).toEqual(['mem-1', 'mem-2']);

    const boostedStore = makeStore();
    await recordUsefulFeedback(boostedStore, 'acme');
    const boosted = await makeAssembler(boostedStore).assemble(TASK, { ...RANKED, tenantId: 'acme' });

    // mem-2 is the only result whose text carries the boosted entity, so the
    // entity multiplication — and nothing else — is what lifts it past mem-1.
    // A source-type boost applies to both results equally and cannot do this.
    expect(knowledgeItemIds(boosted)).toEqual(['mem-2', 'mem-1']);
  });

  it('A4(ii) emits a feedback multiplier of exactly 1 on both cold-start routes', async () => {
    const empty = await makeAssembler(makeStore())
      .assembleTraced(TASK, { ...RANKED, tenantId: 'acme' });
    const rejecting = await makeAssembler(makeStore('rejecting'))
      .assembleTraced(TASK, { ...RANKED, tenantId: 'acme' });

    const emptyIds = knowledgeItemIds(empty.context);
    expect(knowledgeItemIds(rejecting.context)).toEqual(emptyIds);
    expect(rejecting.context.sections).toEqual(empty.context.sections);

    // Positive emission, not merely "no boost applied": an empty store still
    // yields a truthy boost object (the source-type keys are pre-populated with
    // zeros), while a failing lookup yields undefined — two different branches
    // of the fusion boost step, both of which must report exactly 1. Read from
    // the trace because the fusion observer is undefined on the ordinary path.
    for (const traced of [empty, rejecting]) {
      const multipliers = traced.trace.events.flatMap((event) => (
        event.kind === 'candidate-score' && event.name === 'feedback-multiplier'
          ? [{ ref: event.ref, value: event.value }]
          : []
      ));
      expect(multipliers).toHaveLength(emptyIds.length);
      expect(new Set(multipliers.map((entry) => entry.ref)).size).toBe(emptyIds.length);
      expect(multipliers.map((entry) => entry.value)).toEqual(multipliers.map(() => 1));
    }
  });

  it('A4(iii) returns identical cold-start output across repeated runs', async () => {
    // Two channels whose settlement order is swapped between the two runs. The
    // assembler collects channels in one frozen order after they all settle, so
    // the output must not move; reading them in settlement order instead would
    // break the tie between the first memory result and the code result the
    // other way round on the second run.
    const codeResult = {
      id: 'code-1',
      source_type: 'symbol',
      name: 'orbium',
      kind: 'const',
      file_path: 'src/a.ts',
      start_line: 1,
      signature: 'const orbium',
      doc_comment: '',
      score: 0.5,
    };
    let memoryCalls = 0;
    let codeCalls = 0;
    const memoryLayer: AssemblerMemoryLayer = {
      load: async () => {
        await ticks(memoryCalls++ === 0 ? 0 : 24);
        return MEMORY_VALUE;
      },
    };
    const codeLayer: AssemblerCodeLayer = {
      search: async () => {
        await ticks(codeCalls++ === 0 ? 24 : 0);
        return [codeResult];
      },
    };

    const assembler = makeAssembler(makeStore(), memoryLayer, codeLayer);
    const first = await assembler.assemble(TASK, RANKED);
    const second = await assembler.assemble(TASK, RANKED);

    const firstIds = first.sections.flatMap((section) => section.items.map((item) => item.id));
    const secondIds = second.sections.flatMap((section) => section.items.map((item) => item.id));
    expect(new Set(firstIds).size).toBe(firstIds.length);
    expect(firstIds).toEqual(expect.arrayContaining(['mem-1', 'code-1']));
    expect(secondIds).toEqual(firstIds);
    expect(second.sections).toEqual(first.sections);
  });
});
