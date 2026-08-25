// RET-007 v4 D5 — legacy + served wiring of the multihop expansion (spec §4/§5/§7/§8).

import { describe, expect, it, vi } from 'vitest';

import { UnifiedAssembler } from '../assembler.js';
import type { CandidateChannelExecutionResultV1 } from '../candidate-channel.js';
import type { MultihopProbeInput } from '../multihop-expansion.js';
import { createServedRerankerProviderV1 } from '../served-reranker.js';
import type { UnifiedContext } from '../types.js';

const QUERY = 'For hive frame Alder, name its apiary shed and the endpoint beyond it.';
// Decision 2b(3): the seam passes budgetSlots = |pass-1|, and a pass-2-only item only enters the
// output when it outranks a pass-1 item (0.6/11 beats 1/(11 + rank) from rank 8 on). The pass-1
// fixture therefore carries the funnel's twelve rows rather than three, so the seam is exercised at
// the list length the lab and live arms actually hand it.
const PASS1_CORPUS: Array<[string, string]> = [
  ['mem-a', 'Hive frame Alder is warehoused at apiary shed Basalt.'],
  ...Array.from({ length: 11 }, (_, index): [string, string] =>
    [`mem-d${index}`, `Hive frame Filler${index} passed its scheduled apiary shed inspection.`]),
];
const PASS2_CORPUS: Array<[string, string]> = [
  ['mem-b', 'Freight leaving apiary shed Basalt goes to extraction room Cinder.'],
  ['mem-e', 'Basalt apiary shed endpoint ledger names Cinder as the endpoint.'],
];

function ampMarkdown(task: string, rows: Array<[string, string]>): string {
  return `# Memory Context\n\n**Task:** ${task}\n\n${rows.map(([id, content]) => `## [${id}] (confidence: 0.90)\n${content}\n`).join('')}`;
}

function ids(context: UnifiedContext): string[] {
  return context.sections.flatMap((section) => section.items.map((item) => item.id));
}

function stripTime(context: UnifiedContext): unknown {
  return { ...context, assembled_at: undefined };
}

type Scope = Parameters<NonNullable<ConstructorParameters<typeof UnifiedAssembler>[3]>['load']>[0];

/** Fake AMP layer: the pass-1 corpus when scope.queryVector is present, the pass-2 corpus when absent (C6). */
function makeLegacy(options: { preambleTask?: (scope: Scope) => string } = {}) {
  const scopes: Scope[] = [];
  const value = (scope: Scope) => {
    scopes.push(scope);
    const rows = 'queryVector' in scope ? PASS1_CORPUS : PASS2_CORPUS;
    const preamble = options.preambleTask ? options.preambleTask(scope) : scope.task;
    return { markdown: ampMarkdown(preamble, rows), tokens: 10, sources: rows.map(([id]) => id), assembled_at: '2026-08-25T00:00:00.000Z' };
  };
  const memoryLayer = {
    load: vi.fn(async (scope: Scope) => value(scope)),
    loadFreshObserved: vi.fn(async (scope: Scope) => {
      const result = value(scope);
      return {
        value: result,
        observation: {
          channels: [{ channel: 'memory.scope', outcome: 'success' }],
          candidates: result.sources.map((privateId, index) => ({
            privateId, sourceType: 'semantic', channels: [{ channel: 'memory.scope', rank: index + 1 }],
            evidence: { confidence: 0.9 }, estimatedTokens: 4,
          })),
          finalIds: result.sources,
        },
      };
    }),
  };
  const driver = { session: () => ({ run: vi.fn(async () => ({ records: [{ get: () => 0 }] })), close: vi.fn(async () => undefined) }) };
  const redis = { zincrby: vi.fn(), zrevrangeWithScores: vi.fn(async () => []), lpush: vi.fn(), ltrim: vi.fn() };
  const embedding = { available: true, embed: vi.fn(async () => [0.1, 0.2, 0.3]), embedBatch: vi.fn(async () => [[0.1, 0.2, 0.3]]) };
  const assembler = new UnifiedAssembler(driver as never, redis as never, null, memoryLayer, embedding as never);
  return { assembler, memoryLayer, scopes };
}

// project_name is set so memoryScope.tags carries a real project scope: the pass-2
// scope assertion below is only meaningful if there is a scope to preserve.
const RANKED = { strategy: 'ranked' as const, include_code: false, include_arch: false, include_memory: true, max_tokens: 8_000, project_name: 'project:multihop-fixture' };

describe('legacy arm (assembleRankedInternal)', () => {
  it('flag-off: single load, no pass 2, and flag-on-but-not-fired is byte-identical to flag-off', async () => {
    const off = makeLegacy();
    const offContext = await off.assembler.assemble(QUERY, RANKED);
    expect(off.memoryLayer.load).toHaveBeenCalledTimes(1);
    expect([...ids(offContext)].sort()).toEqual(PASS1_CORPUS.map(([id]) => id).sort());
    expect(ids(offContext)).not.toContain('mem-b');

    const on = makeLegacy();
    on.assembler.enableMultihopExpansionV1({ policy: 'evidence-bridge' });
    const comparison = 'Is Alder warehoused at Basalt?';
    const onContext = await on.assembler.assemble(comparison, RANKED);
    const offAgain = await makeLegacy().assembler.assemble(comparison, RANKED);
    expect(on.memoryLayer.load).toHaveBeenCalledTimes(1);
    expect(stripTime(onContext)).toEqual(stripTime(offAgain));
  });

  it('C6 + C5: pass-2 scope omits queryVector and its markdown is normalized with the CONDITIONED task; mem-b reaches fusion', async () => {
    const { assembler, memoryLayer, scopes } = makeLegacy();
    assembler.enableMultihopExpansionV1({ policy: 'evidence-bridge' });
    const context = await assembler.assemble(QUERY, RANKED);
    // pass 1 + one probe per bridge (n <= 3: Basalt, Hive, Filler0), concurrently.
    expect(memoryLayer.load).toHaveBeenCalledTimes(4);
    expect('queryVector' in scopes[0]!).toBe(true);
    for (const scope of scopes.slice(1)) {
      expect('queryVector' in scope).toBe(false);
      expect(scope.task).not.toBe(QUERY);
      expect(scope.tenantId).toBe(scopes[0]!.tenantId);
      // The project scope travels with the tenant: dropping `tags` would widen pass 2
      // beyond the project the caller asked for.
      expect(scope.tags).toEqual(scopes[0]!.tags);
    }
    expect(scopes[1]!.task.split(' ')).toContain('Basalt');
    expect(ids(context)).toContain('mem-b');
    expect(ids(context)).toContain('mem-a');
    // Replace, never append: twelve pass-1 slots in, twelve out.
    expect(ids(context)).toHaveLength(PASS1_CORPUS.length);
  });

  it('C5 bite: a pass-2 preamble carrying the ORIGINAL task cannot be normalized and fails closed to pass 1', async () => {
    const { assembler, memoryLayer } = makeLegacy({ preambleTask: (scope) => ('queryVector' in scope ? scope.task : QUERY) });
    assembler.enableMultihopExpansionV1({ policy: 'evidence-bridge' });
    const context = await assembler.assemble(QUERY, RANKED);
    expect(memoryLayer.load).toHaveBeenCalledTimes(4);
    expect(ids(context)).toEqual(expect.arrayContaining(['mem-a', 'mem-d0', 'mem-d1']));
    expect(ids(context)).not.toContain('mem-b');
  });

  it('C7: the stable-ID lane is single pass and byte-identical to flag-off', async () => {
    const stable = { ...RANKED, resolvedEntityIds: ['entity-a'] };
    const off = makeLegacy();
    const offContext = await off.assembler.assemble(QUERY, stable);
    const on = makeLegacy();
    on.assembler.enableMultihopExpansionV1({ policy: 'evidence-bridge' });
    const onContext = await on.assembler.assemble(QUERY, stable);
    expect(on.memoryLayer.load).toHaveBeenCalledTimes(1);
    expect(off.memoryLayer.load).toHaveBeenCalledTimes(1);
    expect(stripTime(onContext)).toEqual(stripTime(offContext));
  });

  it('traced: pass-2 ids extend the memory observation — complete trace, no candidate-output-gap, no accounting conflict', async () => {
    const { assembler, memoryLayer } = makeLegacy();
    assembler.enableMultihopExpansionV1({ policy: 'evidence-bridge' });
    const { context, trace } = await assembler.assembleTraced(QUERY, RANKED);
    expect(memoryLayer.loadFreshObserved).toHaveBeenCalledTimes(4);
    expect(memoryLayer.load).not.toHaveBeenCalled();
    expect(ids(context)).toContain('mem-b');
    expect(trace.incompleteReasons).toEqual([]);
    expect(trace.complete).toBe(true);
    // Ten surviving pass-1 candidates + the two pass-2 extras: no candidate-output-gap.
    expect(trace.candidates).toHaveLength(PASS1_CORPUS.length);
    expect(trace.events.filter((event) => event.kind === 'channel-attempt')).toHaveLength(1);
    expect(trace.events.filter((event) => event.kind === 'channel-terminal')).toHaveLength(1);
  });

  it('fails closed to pass 1 when the pass-2 load throws', async () => {
    const { assembler, memoryLayer } = makeLegacy();
    memoryLayer.load.mockImplementationOnce(async (scope: Scope) => ({
      markdown: ampMarkdown(scope.task, PASS1_CORPUS), tokens: 10, sources: PASS1_CORPUS.map(([id]) => id), assembled_at: 'x',
    })).mockImplementationOnce(async () => { throw new Error('pass-2 boom'); });
    assembler.enableMultihopExpansionV1({ policy: 'evidence-bridge' });
    const context = await assembler.assemble(QUERY, RANKED);
    expect(ids(context)).toEqual(expect.arrayContaining(['mem-a', 'mem-d0', 'mem-d1']));
    expect(ids(context)).not.toContain('mem-b');
  });
});

function execution(rows: Array<[string, string]>): CandidateChannelExecutionResultV1 {
  return Object.freeze({
    contractId: 'memberry.candidate-channel' as const,
    contractVersion: '1.0.0' as const,
    request: Object.freeze({
      contractId: 'memberry.candidate-channel' as const,
      contractVersion: '1.0.0' as const,
      tenantId: 'default', projectScope: 'project:memberry',
      resolvedEntityIds: Object.freeze(['entity-a']),
      temporalFrame: Object.freeze({ mode: 'current' as const }),
      plannedChannels: Object.freeze(['memory.scope'] as const) as never,
      limits: Object.freeze({ maxCandidatesPerChannel: 64, maxCandidatesAggregate: 128 }),
    }),
    candidates: Object.freeze(rows.map(([evidenceId, content], index) => Object.freeze({
      contractId: 'memberry.candidate-channel' as const,
      contractVersion: '1.0.0' as const,
      channel: 'memory.scope' as const,
      tenantId: 'default', projectScope: 'project:memberry', resolvedEntityId: 'entity-a',
      temporalFrame: Object.freeze({ mode: 'current' as const }),
      // 0.05 per rank keeps a twelve-row pass-1 execution strictly positive and strictly ordered.
      sourceType: 'semantic' as const, evidenceId, rank: index + 1, score: 0.9 - index * 0.05,
      title: evidenceId, content,
      provenance: Object.freeze({ kind: 'semantic' as const, semanticId: evidenceId }),
    }))),
    settlements: Object.freeze([Object.freeze({
      contractId: 'memberry.candidate-channel' as const,
      contractVersion: '1.0.0' as const,
      channel: 'memory.scope' as const, outcome: 'success' as const,
    })]),
  });
}

const SERVED_PASS1_ROWS: Array<[string, string]> = [
  ['ev-a', 'Hive frame Alder is warehoused at apiary shed Basalt.'],
  ...Array.from({ length: 11 }, (_, index): [string, string] =>
    [`ev-d${index}`, `Hive frame Filler${index} passed its scheduled apiary shed inspection.`]),
];
const SERVED_PASS1 = execution(SERVED_PASS1_ROWS);
const SERVED_PASS2 = execution([
  ['ev-a', 'Hive frame Alder is warehoused at apiary shed Basalt.'],
  ['ev-b', 'Freight leaving apiary shed Basalt goes to extraction room Cinder.'],
  // Decision 2c re-record of the FIXTURE (was 'Basalt apiary shed endpoint ledger names Cinder as
  // the endpoint.'): the pass-2 rank is no longer the probe's RETURN position, it is BM25-lite
  // against the conditionedTask. The old wording carried 'Basalt' and 'endpoint' twice and would
  // have taken rank 0, so the pin below would have measured the SIBLING reaching the context
  // instead of the gold hop. Reworded to a plausible sibling that matches q but not the
  // conditioned task, restoring the intended rank order (ev-b above ev-e).
  ['ev-e', 'Apiary shed ledger lists a loading dock roster.'],
]);

function makeServed() {
  return new UnifiedAssembler(
    {} as never,
    { zincrby: vi.fn(), zrevrangeWithScores: vi.fn(), lpush: vi.fn(), ltrim: vi.fn() },
    null, null, { embed: vi.fn(), embedBatch: vi.fn() }, null, createServedRerankerProviderV1(),
  );
}

describe('served arm (assembleCandidateExecutionServed)', () => {
  it('flag-off identity: no probe and a fail-closed probe (ambiguous bridge => null) give the same output as before', async () => {
    const assembler = makeServed();
    const baseline = await assembler.assembleCandidateExecutionServed(QUERY, SERVED_PASS1, 8_000, false, true, true);
    const closed = await assembler.assembleCandidateExecutionServed(QUERY, SERVED_PASS1, 8_000, false, true, true, async () => null);
    expect(stripTime(closed.context)).toEqual(stripTime(baseline.context));
    expect(closed.trace).toEqual(baseline.trace);
    expect(ids(baseline.context)).toEqual(expect.arrayContaining(['ev-a', 'ev-d0', 'ev-d1']));
  });

  it('write-back: a firing probe replaces the memory.scope list; pass-2 evidence reaches the final context with registered ids', async () => {
    const inputs: MultihopProbeInput[] = [];
    const served = await makeServed().assembleCandidateExecutionServed(
      QUERY, SERVED_PASS1, 8_000, false, true, true,
      async (input) => { inputs.push(input); return SERVED_PASS2; },
    );
    // One second receipt per bridge (n <= 3), each a bare name — never the conditioned task.
    expect(inputs.length).toBeLessThanOrEqual(3);
    expect(inputs[0]!.bridge).toBe('Basalt');
    for (const input of inputs) expect(input.bridge).toMatch(/^[A-Z][A-Za-z0-9]*$/);
    const finalIds = ids(served.context);
    expect(finalIds).toContain('ev-b');
    // Concatenated pass-2 arithmetic: ev-a rank 0, ev-b rank 1, ev-e rank 2 => 0.6/13 = 0.0461 <
    // pass-1 rank 10's 1/21 = 0.0476, so ev-e never takes a slot.
    expect(finalIds).not.toContain('ev-e');
    expect(finalIds.filter((id) => id === 'ev-a')).toHaveLength(1);
    expect(finalIds).toHaveLength(SERVED_PASS1_ROWS.length);
    for (const item of served.context.sections.flatMap((section) => section.items)) {
      expect(item.metadata.evidenceId).toBe(item.id);
    }
    expect(served.trace!.complete).toBe(true);
    expect(served.trace!.incompleteReasons).toEqual([]);
    // Eleven surviving pass-1 candidates + the one admitted pass-2 extra (ev-b): no output gap.
    expect(served.trace!.candidates).toHaveLength(SERVED_PASS1_ROWS.length);
    expect(served.trace!.events.filter((event) => event.kind === 'channel-attempt')).toHaveLength(1);
    expect(served.trace!.events.filter((event) => event.kind === 'channel-terminal')).toHaveLength(1);
    expect(JSON.stringify(served.trace)).not.toContain('ev-b');
  });

  it('fact-lexical never reaches the served resolver: the probe sees no bridge and must return null', async () => {
    const assembler = makeServed();
    assembler.enableMultihopExpansionV1({ policy: 'fact-lexical' });
    const inputs: MultihopProbeInput[] = [];
    const served = await assembler.assembleCandidateExecutionServed(
      QUERY, SERVED_PASS1, 8_000, false, true, false,
      async (input) => { inputs.push(input); return input.bridge ? SERVED_PASS2 : null; },
    );
    expect(inputs[0]!.bridge).toBeUndefined();
    expect(ids(served.context)).not.toContain('ev-b');
  });

  it('fails closed when the probe throws', async () => {
    const assembler = makeServed();
    const baseline = await assembler.assembleCandidateExecutionServed(QUERY, SERVED_PASS1, 8_000, false, true, false);
    const thrown = await assembler.assembleCandidateExecutionServed(
      QUERY, SERVED_PASS1, 8_000, false, true, false, async () => { throw new Error('resolver down'); },
    );
    expect(stripTime(thrown.context)).toEqual(stripTime(baseline.context));
  });
});
