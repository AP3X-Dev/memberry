// RET-007 v4 D5 — served-arm per-call probe factory in the tool handlers (spec §4 pins 11/13, §8 (7)).
// Flag-ON cases only; the default-off pins live untouched in tools.test.ts.

import { describe, expect, it, vi } from 'vitest';

import type { ServedMultihopProbeV1 } from '../assembler.js';
import type { QueryPlanV1 } from '../query-plan.js';
import { readRuntimeQueryPlannerAuthorityV1 } from '../runtime-query-planner.js';
import { RETRIEVAL_TRACE_CHANNEL_ORDER } from '../trace.js';
import {
  createRetrievalContainer,
  registerRetrievalTools,
  type IRuntimeCandidateChannelService,
  type IUnifiedAssembler,
} from '../tools.js';
import type { UnifiedContext } from '../types.js';

const CTX: UnifiedContext = { task: 'q', strategy: 'ranked', sections: [], token_count: 0, assembled_at: '2026-08-25T00:00:00.000Z' };

function execution() {
  return Object.freeze({
    contractId: 'memberry.candidate-channel' as const,
    contractVersion: '1.0.0' as const,
    request: Object.freeze({
      contractId: 'memberry.candidate-channel' as const,
      contractVersion: '1.0.0' as const,
      tenantId: 'tenant-a', projectScope: 'project:memberry',
      resolvedEntityIds: Object.freeze(['entity-stable']),
      temporalFrame: Object.freeze({ mode: 'current' as const }),
      plannedChannels: RETRIEVAL_TRACE_CHANNEL_ORDER,
      limits: Object.freeze({ maxCandidatesPerChannel: 64, maxCandidatesAggregate: 128 }),
    }),
    candidates: Object.freeze([]),
    settlements: Object.freeze([]),
  });
}

function makeServerStub() {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  const server = {
    tool: vi.fn((name: string, ...rest: unknown[]) => {
      handlers.set(name, rest[rest.length - 1] as (args: Record<string, unknown>) => Promise<unknown>);
      return {};
    }),
  };
  return { server, handlers };
}

/** A served assembler whose served method drives the injected probe with a fixed bridge. */
function harness(options: { flag?: boolean; bridge?: string | null; secondResolution?: unknown } = {}) {
  const resolved = (ids: readonly string[]) => Object.freeze({
    resolution: Object.freeze({ state: 'resolved', canonicalEntityIds: Object.freeze([...ids]) }),
    diagnostics: Object.freeze([]),
  });
  const resolve = vi.fn()
    .mockResolvedValueOnce(resolved(['entity-stable']))
    .mockResolvedValueOnce(options.secondResolution ?? resolved(['entity-bridge']));
  const probeInputs: Array<{ conditionedTask: string; bridge?: string }> = [];
  const probeOutputs: unknown[] = [];
  const assembleCandidateExecutionServed = vi.fn(async (...args: unknown[]) => {
    const probe = args[6] as ServedMultihopProbeV1 | undefined;
    if (probe) {
      const input = options.bridge === null
        ? { conditionedTask: 'endpoint terms' }
        : { conditionedTask: `endpoint ${options.bridge ?? 'Basalt'}`, bridge: options.bridge ?? 'Basalt' };
      probeInputs.push(input);
      probeOutputs.push(await probe(input));
    }
    return { context: CTX };
  });
  const assembler: IUnifiedAssembler = {
    servedRerankerEnabled: true,
    assemble: vi.fn(), assembleTraced: vi.fn(), renderMarkdown: vi.fn().mockReturnValue('# md'), ask: vi.fn(),
    askFromContext: vi.fn().mockResolvedValue({ answer: 'a', cited_ids: [], evidence: [], level: 'medium' }),
    assembleCandidateExecution: vi.fn(),
    assembleCandidateExecutionServed,
  };
  const candidateRuntime: IRuntimeCandidateChannelService = { execute: vi.fn().mockResolvedValue(execution()) };
  const container = createRetrievalContainer({
    assembler, tenantId: 'tenant-a', authenticated: true, queryPlannerEnabled: true,
    resolverFactory: () => ({ resolve }), candidateChannelEnabled: true, candidateRuntime,
    multihopExpansionEnabled: options.flag ?? true,
  });
  const { server, handlers } = makeServerStub();
  registerRetrievalTools(server as never, container);
  return { handlers, resolve, candidateRuntime, assembleCandidateExecutionServed, probeInputs, probeOutputs };
}

describe('RET-007 v4 served multihop probe factory (flag on)', () => {
  it.each([
    ['berry_context', { task: 'served', strategy: 'ranked', project_name: 'project:memberry', entity_scope: ['Resolver'], max_tokens: 8_000, include_arch: true, include_memory: true }],
    ['berry_ask', { question: 'served?', reasoning_level: 'high', project_name: 'project:memberry', entity_scope: ['Resolver'] }],
  ] as const)('%s executes twice; the second receipt keeps the projectScope and carries entityScope [bridge] exactly', async (tool, args) => {
    const { handlers, resolve, candidateRuntime, probeOutputs } = harness();
    await handlers.get(tool)!(args);
    expect(candidateRuntime.execute).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(candidateRuntime.execute).mock.calls;
    const first = readRuntimeQueryPlannerAuthorityV1(calls[0]![0]);
    const second = readRuntimeQueryPlannerAuthorityV1(calls[1]![0]);
    expect(second.projectScope).toBe(first.projectScope);
    expect(second.tenantId).toBe(first.tenantId);
    expect(second.temporalFrame).toEqual(first.temporalFrame);
    expect(second.resolvedEntityId).toBe('entity-bridge');
    expect(calls[1]![1]).toEqual(calls[0]![1]);
    const secondPlan = resolve.mock.calls[1]![0] as QueryPlanV1;
    expect(secondPlan.hints.entities).toEqual(['Basalt']);
    expect(probeOutputs[0]).toMatchObject({ contractId: 'memberry.candidate-channel' });
  });

  it('the second receipt is sealed from the first, not from caller args mutated during resolution', async () => {
    const { handlers, resolve, candidateRuntime } = harness();
    const request = { task: 'served', strategy: 'ranked', project_name: 'project:memberry', entity_scope: ['Resolver'], as_of: '2026-08-16T10:20:30.000Z', max_tokens: 8_000, include_arch: true, include_memory: true };
    resolve.mockImplementation(async () => {
      request.project_name = 'project:foreign';
      request.as_of = '2027-01-01T00:00:00.000Z';
      return Object.freeze({
        resolution: Object.freeze({ state: 'resolved', canonicalEntityIds: Object.freeze(['entity-x']) }),
        diagnostics: Object.freeze([]),
      });
    });
    await handlers.get('berry_context')!(request);
    const calls = vi.mocked(candidateRuntime.execute).mock.calls;
    expect(calls).toHaveLength(2);
    expect(readRuntimeQueryPlannerAuthorityV1(calls[1]![0])).toMatchObject({
      tenantId: 'tenant-a', projectScope: 'project:memberry', temporalFrame: { mode: 'as-of', asOf: '2026-08-16T10:20:30.000Z' },
    });
  });

  it('fails closed (null, one execution) when the bridge is ambiguous or absent', async () => {
    const ambiguous = harness({
      secondResolution: Object.freeze({
        resolution: Object.freeze({ state: 'resolved', canonicalEntityIds: Object.freeze(['e1', 'e2']) }),
        diagnostics: Object.freeze([]),
      }),
    });
    await ambiguous.handlers.get('berry_context')!({ task: 'served', strategy: 'ranked', project_name: 'project:memberry', entity_scope: ['Resolver'], max_tokens: 8_000, include_arch: true, include_memory: true });
    expect(ambiguous.candidateRuntime.execute).toHaveBeenCalledTimes(1);
    expect(ambiguous.probeOutputs).toEqual([null]);

    const noBridge = harness({ bridge: null });
    await noBridge.handlers.get('berry_context')!({ task: 'served', strategy: 'ranked', project_name: 'project:memberry', entity_scope: ['Resolver'], max_tokens: 8_000, include_arch: true, include_memory: true });
    expect(noBridge.candidateRuntime.execute).toHaveBeenCalledTimes(1);
    expect(noBridge.resolve).toHaveBeenCalledTimes(1);
    expect(noBridge.probeOutputs).toEqual([null]);
  });

  it('flag off: the served method is called with exactly six arguments and no probe', async () => {
    const { handlers, assembleCandidateExecutionServed, candidateRuntime } = harness({ flag: false });
    await handlers.get('berry_context')!({ task: 'served', strategy: 'ranked', project_name: 'project:memberry', entity_scope: ['Resolver'], max_tokens: 8_000, include_arch: true, include_memory: true });
    expect(assembleCandidateExecutionServed.mock.calls[0]).toHaveLength(6);
    expect(candidateRuntime.execute).toHaveBeenCalledTimes(1);
    expect(createRetrievalContainer().multihopExpansionEnabled).toBe(false);
  });
});
