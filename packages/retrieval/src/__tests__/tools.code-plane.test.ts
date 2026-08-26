// packages/retrieval/src/__tests__/tools.code-plane.test.ts
// COD-010: the candidate runtime composes memory/arch only — the tool layer must
// disclose the code-plane drop on include_code=true requests, and must add
// NOTHING on the legacy path (whose status comes from the assembler).
import { readFileSync } from 'node:fs';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  createRetrievalContainer,
  registerRetrievalTools,
  type IUnifiedAssembler,
  type IRuntimeCandidateChannelService,
} from '../tools.js';
import { RETRIEVAL_TRACE_CHANNEL_ORDER } from '../trace.js';
import type { RetrievalTraceV1 } from '../trace.js';
import type { UnifiedContext } from '../types.js';

const approvedTrace = JSON.parse(readFileSync(
  new URL('./fixtures/retrieval-trace-deterministic-v2.json', import.meta.url),
  'utf8',
)) as RetrievalTraceV1;

afterEach(() => {
  vi.restoreAllMocks();
});

function emptyCtx(): UnifiedContext {
  return { task: 'q', strategy: 'ranked', sections: [], token_count: 0, assembled_at: '2026-06-07T00:00:00.000Z' };
}

function makeAssembler(context: UnifiedContext, servedRerankerEnabled = false): IUnifiedAssembler {
  return {
    servedRerankerEnabled,
    assemble: vi.fn().mockResolvedValue(context),
    assembleTraced: vi.fn().mockResolvedValue({ context, trace: approvedTrace }),
    renderMarkdown: vi.fn().mockReturnValue('# md'),
    ask: vi.fn().mockResolvedValue({ answer: 'a', cited_ids: [], evidence: [], level: 'medium' }),
    askFromContext: vi.fn().mockResolvedValue({ answer: 'a', cited_ids: [], evidence: [], level: 'medium' }),
    assembleCandidateExecution: vi.fn().mockReturnValue({ context, trace: approvedTrace }),
    assembleCandidateExecutionServed: vi.fn().mockResolvedValue({ context, trace: approvedTrace }),
  };
}

function makeServerStub() {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  const server = {
    tool: vi.fn((name: string, ...rest: unknown[]) => {
      const handler = rest[rest.length - 1] as (args: Record<string, unknown>) => Promise<unknown>;
      handlers.set(name, handler);
      return { enable: vi.fn(), disable: vi.fn() } as unknown;
    }),
  };
  return { server, handlers };
}

function candidateContainer(tenantId: string, context: UnifiedContext, servedRerankerEnabled = false) {
  const assembler = makeAssembler(context, servedRerankerEnabled);
  const resolution = Object.freeze({
    resolution: Object.freeze({ state: 'resolved', canonicalEntityIds: Object.freeze(['entity-stable']) }),
    diagnostics: Object.freeze([]),
  });
  const resolve = vi.fn().mockResolvedValue(resolution);
  const execution = Object.freeze({
    contractId: 'memberry.candidate-channel' as const,
    contractVersion: '1.0.0' as const,
    request: Object.freeze({
      contractId: 'memberry.candidate-channel' as const,
      contractVersion: '1.0.0' as const,
      tenantId, projectScope: 'project:memberry',
      resolvedEntityIds: Object.freeze(['entity-stable']),
      temporalFrame: Object.freeze({ mode: 'current' as const }),
      plannedChannels: RETRIEVAL_TRACE_CHANNEL_ORDER,
      limits: Object.freeze({ maxCandidatesPerChannel: 64, maxCandidatesAggregate: 128 }),
    }),
    candidates: Object.freeze([]),
    settlements: Object.freeze(RETRIEVAL_TRACE_CHANNEL_ORDER.map((channel) => Object.freeze({
      contractId: 'memberry.candidate-channel' as const,
      contractVersion: '1.0.0' as const,
      channel, outcome: 'safe-failure' as const, code: 'unavailable' as const,
    }))),
  });
  const candidateRuntime: IRuntimeCandidateChannelService = {
    execute: vi.fn().mockResolvedValue(execution),
  };
  return {
    assembler,
    container: createRetrievalContainer({
      assembler,
      tenantId,
      authenticated: true,
      queryPlannerEnabled: true,
      resolverFactory: () => ({ resolve }),
      candidateChannelEnabled: true,
      candidateRuntime,
    }),
  };
}

const CANDIDATE_ARGS = { task: 'safe', project_name: 'project:memberry', entity_scope: ['Resolver'] };

describe('COD-010 candidate-path code-plane disclosure', () => {
  // COD-010b split of the original single pin (spec §Tests, "Existing-test contract edit"):
  // the UNSERVED/shadow arm keeps the synthetic candidate-channel status, while the SERVED
  // arm must hand the assembler's REAL status through untouched. No assertion is loosened.
  it('unserved arm: passes unsupported candidate-channel into renderMarkdown for the default tenant', async () => {
    const context = emptyCtx();
    const { assembler, container } = candidateContainer('default', context);
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, container);

    const result = await handlers.get('berry_context')!({ ...CANDIDATE_ARGS, include_code: true });

    expect(assembler.assembleCandidateExecutionServed).not.toHaveBeenCalled();
    expect(assembler.renderMarkdown).toHaveBeenCalledTimes(1);
    expect(assembler.renderMarkdown).toHaveBeenCalledWith({
      ...context,
      code_plane: { outcome: 'unsupported', reason: 'candidate-channel' },
    });
    expect(result).toEqual({ content: [{ type: 'text', text: '# md' }] });
  });

  it('served arm: renderMarkdown receives the assembler\'s real code_plane unmodified', async () => {
    // The exact object the served assembler returns — the tool layer owns none of it.
    const context: UnifiedContext = {
      ...emptyCtx(),
      code_plane: { outcome: 'served', results: 2, candidates: 20 },
    };
    const { assembler, container } = candidateContainer('default', context, true);
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, container);

    const result = await handlers.get('berry_context')!({ ...CANDIDATE_ARGS, include_code: true });

    expect(assembler.assembleCandidateExecutionServed).toHaveBeenCalledTimes(1);
    expect(assembler.renderMarkdown).toHaveBeenCalledTimes(1);
    const rendered = vi.mocked(assembler.renderMarkdown).mock.calls[0]![0];
    expect(rendered).toBe(context);
    expect(rendered.code_plane).toEqual({ outcome: 'served', results: 2, candidates: 20 });
    expect(result).toEqual({ content: [{ type: 'text', text: '# md' }] });
  });

  it('passes unsupported tenant-scope into renderMarkdown for a named tenant', async () => {
    const context = emptyCtx();
    const { assembler, container } = candidateContainer('tenant-a', context);
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, container);

    await handlers.get('berry_context')!({ ...CANDIDATE_ARGS, include_code: true });

    expect(assembler.renderMarkdown).toHaveBeenCalledWith({
      ...context,
      code_plane: { outcome: 'unsupported', reason: 'tenant-scope' },
    });
  });

  it('passes the context through unmodified when include_code is false (same object, no code_plane)', async () => {
    const context = emptyCtx();
    const { assembler, container } = candidateContainer('tenant-a', context);
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, container);

    await handlers.get('berry_context')!({ ...CANDIDATE_ARGS, include_code: false });

    expect(assembler.renderMarkdown).toHaveBeenCalledTimes(1);
    const rendered = vi.mocked(assembler.renderMarkdown).mock.calls[0]![0];
    expect(rendered).toBe(context);
    expect(rendered).not.toHaveProperty('code_plane');
  });

  it('adds nothing at the tool layer on the legacy path (exact :185-shape result)', async () => {
    const assembler = makeAssembler(emptyCtx());
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, createRetrievalContainer({ assembler }));

    const result = await handlers.get('berry_context')!({
      task: 'find auth', strategy: 'ranked', include_code: true,
    });

    expect(assembler.assemble).toHaveBeenCalledTimes(1);
    expect(assembler.renderMarkdown).toHaveBeenCalledTimes(1);
    // The legacy branch passes the assembled context straight through — its
    // code_plane comes from the assembler, never from the tool layer.
    expect(vi.mocked(assembler.renderMarkdown).mock.calls[0]![0])
      .toBe(await vi.mocked(assembler.assemble).mock.results[0]!.value);
    expect(result).toEqual({ content: [{ type: 'text', text: '# md' }] });
  });
});
