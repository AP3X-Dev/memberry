// RET-009 — guards for the bounded-latency and degradation policy.
//
// A4/A5/A6 are characterization guards: they are green on unmodified master by
// design. They pin the behaviour retrieval-latency-policy.ts declares, so a change
// that contradicts a declared clause turns red. They are not a demonstration of the
// executor backstop — A1/A2/A3(ii) in candidate-channel.test.ts are.
import { describe, expect, it, vi } from 'vitest';

import { canonicalTraceJson } from '../trace.js';
import { resolveRuntimeQueryPlannerAuthorityV1 } from '../runtime-query-planner.js';
import {
  RuntimeCandidateChannelService,
  type RuntimeCandidateDriver,
} from '../runtime-candidate-channel.js';
import { UnifiedAssembler, type TracedUnifiedContext } from '../assembler.js';
import {
  buildRetrievalExplanationViewV1,
  renderRetrievalExplanationTextV1,
} from '../retrieval-explanation-view.js';
import { RETRIEVAL_LATENCY_POLICY_V1 } from '../retrieval-latency-policy.js';

const project = 'project:memberry';
const entityId = 'entity-memberry';

async function authorityReceipt() {
  return resolveRuntimeQueryPlannerAuthorityV1({
    authenticated: true,
    plannerEnabled: true,
    tenantId: 'tenant-a',
    projectName: project,
    entityScope: ['memberry'],
    resolverFactory: () => ({ resolve: async () => ({
      resolution: { state: 'resolved', canonicalEntityIds: [entityId] }, diagnostics: [],
    }) }),
  });
}

function hung(): Promise<never> {
  return new Promise<never>(() => undefined);
}

/**
 * Elapsed time on the fake clock between starting the work and its settlement.
 * Steps timer by timer rather than millisecond by millisecond, so the measurement
 * costs a handful of ticks instead of thousands. No real wall-clock is involved.
 */
async function settleElapsedMs<T>(pending: Promise<T>): Promise<{ elapsedMs: number; value: T }> {
  const startedAt = Date.now();
  let elapsedMs = -1;
  void pending.then(() => { elapsedMs = Date.now() - startedAt; });
  for (let step = 0; step < 256 && elapsedMs < 0; step += 1) {
    if (vi.getTimerCount() === 0) await vi.advanceTimersByTimeAsync(0);
    else await vi.advanceTimersToNextTimerAsync();
  }
  expect(elapsedMs).toBeGreaterThan(0);
  return { elapsedMs, value: await pending };
}

function settlementCode(
  execution: { settlements: readonly { channel: string; outcome: string; code?: string }[] },
  channel: string,
): string | undefined {
  const settlement = execution.settlements.find((item) => item.channel === channel);
  return settlement?.outcome === 'safe-failure' ? settlement.code : undefined;
}

/** Parses `events[i].field=value` lines out of a rendered explanation. */
function renderedEvents(text: string): Record<string, string>[] {
  const byIndex = new Map<number, Record<string, string>>();
  for (const line of text.split('\n')) {
    const match = /^events\[(\d+)\]\.([A-Za-z]+)=(.*)$/.exec(line);
    if (match === null) continue;
    const index = Number(match[1]);
    const record = byIndex.get(index) ?? {};
    record[match[2]!] = match[3]!;
    byIndex.set(index, record);
  }
  return [...byIndex.values()];
}

describe('RET-009 A4 declared hop bounds match the constants actually in force', () => {
  it('composes the non-fact hop out of the query and close bounds the runner enforces', async () => {
    vi.useFakeTimers();
    try {
      // Query hangs: query bound, then rollback and session close in the finally.
      const queryHangs = new RuntimeCandidateChannelService({
        session: vi.fn(() => ({
          run: vi.fn(),
          beginTransaction: () => ({ run: () => hung(), commit: vi.fn(), rollback: () => hung() }),
          close: () => hung(),
        })),
      } as unknown as RuntimeCandidateDriver);
      const queryHung = await settleElapsedMs(queryHangs.execute(
        await authorityReceipt(),
        { includeArchitecture: true, includeMemory: false },
      ));

      // Commit hangs: commit bound, then rollback and session close in the finally.
      const commitHangs = new RuntimeCandidateChannelService({
        session: vi.fn(() => ({
          run: vi.fn(),
          beginTransaction: () => ({
            run: async () => ({ records: [] }),
            commit: () => hung(),
            rollback: () => hung(),
          }),
          close: () => hung(),
        })),
      } as unknown as RuntimeCandidateDriver);
      const commitHung = await settleElapsedMs(commitHangs.execute(
        await authorityReceipt(),
        { includeArchitecture: true, includeMemory: false },
      ));

      // Three close-bounded legs on the commit path, two on the query path.
      const closeMs = commitHung.elapsedMs / 3;
      const queryMs = queryHung.elapsedMs - 2 * closeMs;
      expect(RETRIEVAL_LATENCY_POLICY_V1.runtimeCandidateChannelNonFact.boundMs)
        .toBe(queryMs + 3 * closeMs);
      expect(settlementCode(queryHung.value, 'arch.entity'))
        .toBe(RETRIEVAL_LATENCY_POLICY_V1.runtimeCandidateChannelNonFact.faultSettlement);
      expect(settlementCode(commitHung.value, 'arch.entity'))
        .toBe(RETRIEVAL_LATENCY_POLICY_V1.runtimeCandidateChannelNonFact.faultSettlement);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds the fact hop to the two FactStore deadlines that compose serially', async () => {
    vi.useFakeTimers();
    try {
      // memory.fact is the only hop with no bounded() wrapper of its own: FactStore's
      // batch wall deadline and its batch close deadline compose one after the other.
      const service = new RuntimeCandidateChannelService({
        session: vi.fn(() => ({
          run: () => hung(),
          beginTransaction: () => ({ run: () => hung(), commit: vi.fn(), rollback: () => hung() }),
          close: () => hung(),
        })),
      } as unknown as RuntimeCandidateDriver);
      const factHung = await settleElapsedMs(service.execute(
        await authorityReceipt(),
        { includeArchitecture: false, includeMemory: true },
      ));

      // Every other memory hop is bounded below the fact hop, so the execution's own
      // settle time is the fact hop's bound.
      expect(factHung.elapsedMs).toBe(RETRIEVAL_LATENCY_POLICY_V1.runtimeCandidateChannelFact.boundMs);
      expect(settlementCode(factHung.value, 'memory.fact'))
        .toBe(RETRIEVAL_LATENCY_POLICY_V1.runtimeCandidateChannelFact.faultSettlement);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('RET-009 A5 degradation reaches a rendered explanation', () => {
  it('names the degraded channel on the channel-terminal path and keeps the trace valid', async () => {
    const service = new RuntimeCandidateChannelService({
      session: vi.fn(() => ({
        run: vi.fn(),
        beginTransaction: () => ({
          run: async () => ({ records: [] }),
          commit: async () => undefined,
          rollback: async () => undefined,
        }),
        close: async () => undefined,
      })),
    } as unknown as RuntimeCandidateDriver);
    const execution = await service.execute(
      await authorityReceipt(),
      { includeArchitecture: true, includeMemory: false },
    );
    expect(settlementCode(execution, 'memory.scope'))
      .toBe(RETRIEVAL_LATENCY_POLICY_V1.degradedChannel.faultSettlement);

    const assembler = Object.create(UnifiedAssembler.prototype) as UnifiedAssembler;
    const assembled = assembler.assembleCandidateExecution(
      'task', execution, 8_000, true, false, true,
    ) as TracedUnifiedContext;
    const trace = assembled.trace;
    expect(() => JSON.parse(canonicalTraceJson(trace))).not.toThrow();

    const events = renderedEvents(renderRetrievalExplanationTextV1(
      buildRetrievalExplanationViewV1(trace),
    ));
    expect(events).toContainEqual(expect.objectContaining({
      kind: RETRIEVAL_LATENCY_POLICY_V1.degradedChannel.disclosedAs,
      channel: 'memory.scope',
      outcome: 'safe-failure',
      code: RETRIEVAL_LATENCY_POLICY_V1.degradedChannel.faultSettlement,
    }));
    // The sibling that could serve is still reported on its own merits.
    expect(events).toContainEqual(expect.objectContaining({
      kind: RETRIEVAL_LATENCY_POLICY_V1.degradedChannel.disclosedAs,
      channel: 'arch.entity',
      outcome: 'success',
    }));
  });
});

describe('RET-009 A6 collection size is unbounded and fail-open, as declared', () => {
  interface CollectionSizeSeam {
    driver: unknown;
    cachedCollectionSize: number | undefined;
    collectionSizeCachedAt: number;
    getCollectionSize(): Promise<number | undefined>;
  }

  // Object.create installs no instance fields, so every field getCollectionSize
  // reads has to be set here — driver above all, or this.driver.session() throws a
  // TypeError that the fail-open catch swallows and the case tests nothing.
  function seam(rejecting: boolean, cached: number | undefined, cachedAt: number) {
    const run = vi.fn(async () => {
      if (rejecting) throw new Error('collection-size-down');
      return { records: [] };
    });
    const close = vi.fn(async () => undefined);
    const assembler = Object.create(UnifiedAssembler.prototype) as unknown as CollectionSizeSeam;
    assembler.driver = { session: () => ({ run, close }) };
    assembler.cachedCollectionSize = cached;
    assembler.collectionSizeCachedAt = cachedAt;
    return { assembler, run, close };
  }

  it('declares the hop unbounded and fail-open', () => {
    expect(RETRIEVAL_LATENCY_POLICY_V1.collectionSize.boundMs).toBeNull();
    expect(RETRIEVAL_LATENCY_POLICY_V1.collectionSize.faultSettlement).toBe('stale-or-undefined');
  });

  it('serves the previously cached value when the session rejects', async () => {
    const { assembler, run } = seam(true, 41, 0);
    await expect(assembler.getCollectionSize()).resolves.toBe(41);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('serves undefined when the session rejects and nothing was ever cached', async () => {
    const { assembler, run } = seam(true, undefined, 0);
    await expect(assembler.getCollectionSize()).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('serves a value inside the TTL from cache without querying at all', async () => {
    const { assembler, run } = seam(false, 7, Date.now());
    await expect(assembler.getCollectionSize()).resolves.toBe(7);
    expect(run).not.toHaveBeenCalled();
  });
});
