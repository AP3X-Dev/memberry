import { afterEach, describe, expect, it, vi } from 'vitest';

import { UnifiedAssembler } from '../assembler.js';
import {
  RERANKER_SHADOW_MAX_ACTIVE,
  RERANKER_SHADOW_PROVIDER_IDENTITY,
  RerankerShadowCoordinatorV1,
  resolveRerankerShadowModeV1,
  type RerankerShadowObservationV1,
} from '../reranker-shadow.js';
import {
  createLocalRerankerProviderV1,
  createRerankerProviderV1,
  type RerankerCancellationV1,
  type RerankerProviderCandidateV1,
} from '../index.js';
import {
  resolveRuntimeQueryPlannerAuthorityV1,
  type RuntimeQueryPlannerResolvedReceiptV1,
} from '../runtime-query-planner.js';
import type { CandidateChannelExecutionResultV1 } from '../candidate-channel.js';

async function receipt(entityId = 'entity-a', projectScope = 'project:alpha', tenantId = 'tenant-a', asOf?: string) {
  return resolveRuntimeQueryPlannerAuthorityV1({
    authenticated: true,
    plannerEnabled: true,
    tenantId,
    projectName: projectScope,
    entityScope: ['hint'],
    ...(asOf === undefined ? {} : { asOf }),
    resolverFactory: () => ({ resolve: async () => ({
      resolution: { state: 'resolved', canonicalEntityIds: [entityId] }, diagnostics: [],
    }) }),
  });
}

function execution(count = 3, over: Partial<CandidateChannelExecutionResultV1['request']> = {}): CandidateChannelExecutionResultV1 {
  const request = {
    contractId: 'memberry.candidate-channel' as const,
    contractVersion: '1.0.0' as const,
    tenantId: 'tenant-a', projectScope: 'project:alpha', resolvedEntityIds: ['entity-a'],
    temporalFrame: { mode: 'current' as const },
    plannedChannels: ['memory.scope' as const],
    limits: { maxCandidatesPerChannel: 128, maxCandidatesAggregate: 128 },
    ...over,
  };
  return {
    contractId: request.contractId, contractVersion: request.contractVersion, request,
    candidates: Array.from({ length: count }, (_, index) => ({
      contractId: request.contractId, contractVersion: request.contractVersion,
      channel: 'memory.scope' as const, tenantId: request.tenantId,
      projectScope: request.projectScope, resolvedEntityId: request.resolvedEntityIds[0]!,
      temporalFrame: request.temporalFrame, sourceType: 'semantic' as const,
      evidenceId: `evidence-${String(index).padStart(3, '0')}`, rank: index + 1,
      score: 1 - (index / 1_000), title: `title-${index}`, content: `content-${index}`,
      provenance: { kind: 'semantic' as const, semanticId: `evidence-${String(index).padStart(3, '0')}` },
    })),
    settlements: [{
      contractId: request.contractId, contractVersion: request.contractVersion,
      channel: 'memory.scope' as const, outcome: 'success' as const, candidateCount: count,
    }],
  };
}

function assembler() {
  const session = { run: vi.fn(async () => ({ records: [] })), close: vi.fn(async () => undefined) };
  const driver = { session: vi.fn(() => session) };
  const redis = { zincrby: vi.fn(), zrevrangeWithScores: vi.fn(async () => []), lpush: vi.fn(), ltrim: vi.fn() };
  const embedding = { available: false, embed: vi.fn(), embedBatch: vi.fn() };
  return new UnifiedAssembler(driver as never, redis as never, null, null, embedding, null);
}

function work(
  sealed: RuntimeQueryPlannerResolvedReceiptV1,
  source = execution(),
  candidates = source.candidates.map((entry, index) => ({
    id: `private-${index}`, source_type: entry.sourceType, title: entry.title,
    content: entry.content, score: 0.9 - (index / 100), metadata: {},
  })),
) {
  return { receipt: sealed, execution: source, query: 'private query', candidates };
}

async function macrotask(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('RET-004B binding', () => {
  it('parses only exact shadow while unset and empty remain disabled', () => {
    expect(resolveRerankerShadowModeV1(undefined)).toBe('disabled');
    expect(resolveRerankerShadowModeV1('')).toBe('disabled');
    expect(resolveRerankerShadowModeV1('shadow')).toBe('shadow');
    for (const value of ['SHADOW', ' shadow', 'shadow ', '1', 'true', 'off', 'disabled']) {
      expect(() => resolveRerankerShadowModeV1(value)).toThrow('reranker_shadow:invalid_mode');
    }
  });

  it('observes the owned post-fusion/dedup max-50 list before token budgeting without changing bytes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T00:00:00.000Z'));
    const source = execution(80);
    const baseline = assembler().assembleCandidateExecution('private query', source, 1, true, true, true);
    const callback = vi.fn();
    const observed = assembler().assembleCandidateExecution('private query', source, 1, true, true, true, callback);
    expect(JSON.stringify(observed)).toBe(JSON.stringify(baseline));
    expect(callback).toHaveBeenCalledTimes(1);
    const candidates = callback.mock.calls[0]![0] as Array<{ id: string; score: number }>;
    expect(candidates).toHaveLength(50);
    expect(candidates[0]!.id).toContain('memory.scope\u00001\u0000evidence-000');
    expect(candidates.map((entry) => entry.score)).toEqual([...candidates].map((entry) => entry.score).sort((a, b) => b - a));
    expect(observed.context.sections.flatMap((section) => section.items).length).toBeLessThan(50);
  });

  it.each([0, 1, 50] as const)('hands the observer the exact owned %i-candidate fused window', (count) => {
    const source = execution(count);
    const callback = vi.fn();
    assembler().assembleCandidateExecution('private query', source, 10_000, true, true, false, callback);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]![0]).toHaveLength(count);
  });

  it('runs provider and sink only in a later macrotask and emits no authority or content identifiers', async () => {
    const events: string[] = [];
    const observations: RerankerShadowObservationV1[] = [];
    const provider = createLocalRerankerProviderV1(RERANKER_SHADOW_PROVIDER_IDENTITY,
      (_query: string, candidate: RerankerProviderCandidateV1) => { events.push('provider'); return candidate.baselineScore; });
    const coordinator = new RerankerShadowCoordinatorV1(provider, (observation) => {
      events.push('sink'); observations.push(observation);
    });
    const sealed = await receipt();
    expect(coordinator.trySchedule(() => { events.push('thunk'); return work(sealed); })).toBe(true);
    events.push('returned');
    await Promise.resolve();
    expect(events).toEqual(['returned']);
    await macrotask();
    await coordinator.shutdown();
    expect(events).toEqual(['returned', 'thunk', 'provider', 'provider', 'provider', 'sink']);
    expect(observations[0]).toEqual({
      contractId: 'memberry.reranker-shadow-observation', contractVersion: '1.0.0',
      authorityBinding: 'matched', provider: RERANKER_SHADOW_PROVIDER_IDENTITY,
      candidateCount: 3, outcome: 'reranked', orderChanged: false, movedCandidateCount: 0,
    });
    expect(Object.isFrozen(observations[0])).toBe(true);
    const bytes = JSON.stringify(observations[0]);
    for (const secret of ['tenant-a', 'project:alpha', 'entity-a', 'private query', 'title-0', 'content-0', 'private-0', 'evidence-000']) {
      expect(bytes).not.toContain(secret);
    }
  });

  it('records only categorical order movement when the shadow provider reverses the window', async () => {
    const observations: RerankerShadowObservationV1[] = [];
    const provider = createLocalRerankerProviderV1(
      RERANKER_SHADOW_PROVIDER_IDENTITY,
      (_query: string, candidate: RerankerProviderCandidateV1) => 1 - candidate.baselineScore,
    );
    const coordinator = new RerankerShadowCoordinatorV1(provider, (observation) => { observations.push(observation); });
    const sealed = await receipt();
    coordinator.trySchedule(() => work(sealed));
    await macrotask();
    await coordinator.shutdown();
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ orderChanged: true, movedCandidateCount: 2 });
    expect(JSON.stringify(observations[0])).not.toContain('private-');
  });

  it('silently rejects forged or mismatched tenant, project, entity, and time authority', async () => {
    const provider = createLocalRerankerProviderV1(RERANKER_SHADOW_PROVIDER_IDENTITY,
      (_query: string, candidate: RerankerProviderCandidateV1) => candidate.baselineScore);
    const sink = vi.fn();
    const coordinator = new RerankerShadowCoordinatorV1(provider, sink);
    const current = await receipt();
    const asOf = await receipt('entity-a', 'project:alpha', 'tenant-a', '2026-01-01T00:00:00.000Z');
    const forged = Object.freeze({ contract: 'memberry.runtime-query-planner-resolved-receipt.v1' }) as RuntimeQueryPlannerResolvedReceiptV1;
    const mismatches = [
      work(forged),
      work(current, execution(1, { tenantId: 'tenant-b' })),
      work(current, execution(1, { projectScope: 'project:beta' })),
      work(current, execution(1, { resolvedEntityIds: ['entity-b'] })),
      work(asOf, execution(1)),
    ];
    for (const item of mismatches) expect(coordinator.trySchedule(() => item)).toBe(true);
    await macrotask(); await coordinator.shutdown();
    expect(sink).not.toHaveBeenCalled();
    expect(coordinator.snapshot()).toMatchObject({ invalidSkipped: 5, completed: 0, inFlight: 0 });
  });

  it('shares one 32-slot reservation pool and slot 33 never invokes its thunk', async () => {
    vi.useFakeTimers();
    let providerCalls = 0;
    const provider = createRerankerProviderV1(RERANKER_SHADOW_PROVIDER_IDENTITY, () => {
      providerCalls += 1; return new Promise<string>(() => {});
    });
    const coordinator = new RerankerShadowCoordinatorV1(provider, () => {});
    const sealed = await receipt();
    const thunks = Array.from({ length: RERANKER_SHADOW_MAX_ACTIVE + 1 }, () => vi.fn(() => work(sealed)));
    for (const thunk of thunks) coordinator.trySchedule(thunk);
    expect(thunks.every((thunk) => thunk.mock.calls.length === 0)).toBe(true);
    await vi.advanceTimersToNextTimerAsync();
    expect(thunks.slice(0, 32).every((thunk) => thunk.mock.calls.length === 1)).toBe(true);
    expect(thunks[32]).not.toHaveBeenCalled();
    expect(providerCalls).toBe(32);
    await vi.advanceTimersByTimeAsync(250);
    await coordinator.shutdown();
    expect(coordinator.snapshot()).toMatchObject({ capacitySkipped: 1, inFlight: 0 });
  });

  it('contains timeout cancellation, rejecting and never-settling sinks, and bounds idempotent shutdown', async () => {
    let cancellation: RerankerCancellationV1 | undefined;
    const provider = createRerankerProviderV1(RERANKER_SHADOW_PROVIDER_IDENTITY, (_serialized, token) => {
      cancellation = token; return new Promise<string>(() => {});
    });
    const coordinator = new RerankerShadowCoordinatorV1(provider, () => new Promise<void>(() => {}));
    const sealed = await receipt();
    coordinator.trySchedule(() => work(sealed));
    await macrotask();
    expect(cancellation?.isCancelled()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(cancellation?.isCancelled()).toBe(true);
    const first = coordinator.shutdown();
    const second = coordinator.shutdown();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(coordinator.trySchedule(() => work(sealed))).toBe(false);
    expect(coordinator.snapshot().inFlight).toBe(0);
  });

  it('contains a rejecting sink and releases its reservation without an unhandled rejection', async () => {
    const provider = createLocalRerankerProviderV1(
      RERANKER_SHADOW_PROVIDER_IDENTITY,
      (_query: string, candidate: RerankerProviderCandidateV1) => candidate.baselineScore,
    );
    const coordinator = new RerankerShadowCoordinatorV1(provider, async () => {
      throw new Error('private sink failure');
    });
    const sealed = await receipt();
    coordinator.trySchedule(() => work(sealed));
    await macrotask();
    await coordinator.shutdown();
    expect(coordinator.snapshot()).toMatchObject({ completed: 1, reranked: 1, inFlight: 0 });
  });

  it('ignores a sink that settles only after the bounded shutdown release', async () => {
    vi.useFakeTimers();
    let settle!: () => void;
    const lateSink = new Promise<void>((resolve) => { settle = resolve; });
    const provider = createLocalRerankerProviderV1(
      RERANKER_SHADOW_PROVIDER_IDENTITY,
      (_query: string, candidate: RerankerProviderCandidateV1) => candidate.baselineScore,
    );
    const coordinator = new RerankerShadowCoordinatorV1(provider, () => lateSink);
    const sealed = await receipt();
    coordinator.trySchedule(() => work(sealed));
    await vi.advanceTimersToNextTimerAsync();
    const draining = coordinator.shutdown();
    await vi.advanceTimersByTimeAsync(1_000);
    await draining;
    const afterDrain = coordinator.snapshot();
    settle();
    await Promise.resolve();
    expect(coordinator.snapshot()).toEqual(afterDrain);
    expect(afterDrain).toMatchObject({ completed: 0, inFlight: 0 });
  });
});
