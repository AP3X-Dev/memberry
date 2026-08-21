// packages/retrieval/src/__tests__/retrieval-explanation-wiring.test.ts
// UI-001B: berry_context wires the retrieval explanation view to the trace it
// just returned, so an operator can reproduce why evidence was selected.
// Harness copied from tools.test.ts (which is carried unchanged).
import { readFileSync } from 'node:fs';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  createRetrievalContainer,
  registerRetrievalTools,
  type IUnifiedAssembler,
  type IRuntimeCandidateChannelService,
} from '../tools.js';
import { canonicalTraceJson, RETRIEVAL_TRACE_CHANNEL_ORDER } from '../trace.js';
import type { RetrievalTraceV1 } from '../trace.js';
import type { UnifiedContext } from '../types.js';
import { UnifiedAssembler } from '../assembler.js';
import {
  buildRetrievalExplanationViewV1,
  renderRetrievalExplanationTextV1,
  RetrievalExplanationViewContractError,
  RETRIEVAL_EXPLANATION_VIEW_CONTRACT_ID,
  RETRIEVAL_EXPLANATION_VIEW_CONTRACT_VERSION,
  RETRIEVAL_EXPLANATION_TEXT_MAX_UTF8_BYTES,
} from '../retrieval-explanation-view.js';

const approvedTrace = JSON.parse(readFileSync(
  new URL('./fixtures/retrieval-trace-deterministic-v2.json', import.meta.url),
  'utf8',
)) as RetrievalTraceV1;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type ToolResult = { content: Array<{ type: string; text: string }> };

function emptyCtx(): UnifiedContext {
  return { task: 'q', strategy: 'ranked', sections: [], token_count: 0, assembled_at: '2026-06-07T00:00:00.000Z' };
}

function makeAssembler(): IUnifiedAssembler {
  return {
    assemble: vi.fn().mockResolvedValue(emptyCtx()),
    assembleTraced: vi.fn().mockResolvedValue({ context: emptyCtx(), trace: approvedTrace }),
    renderMarkdown: vi.fn().mockReturnValue('# md'),
    ask: vi.fn().mockResolvedValue({ answer: 'a', cited_ids: [], evidence: [], level: 'medium' }),
    askFromContext: vi.fn().mockResolvedValue({ answer: 'a', cited_ids: [], evidence: [], level: 'medium' }),
    assembleCandidateExecution: vi.fn().mockReturnValue({ context: emptyCtx(), trace: approvedTrace }),
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

// legacy path (tools.ts:514)
describe('UI-001B explain wiring - legacy path', () => {
  function legacy() {
    const assembler = makeAssembler();
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, createRetrievalContainer({ assembler }));
    const call = (args: Record<string, unknown>) => handlers.get('berry_context')!({
      task: 'find auth', strategy: 'ranked', ...args,
    }) as Promise<ToolResult>;
    return { assembler, call };
  }

  it('A1 include_trace + explain returns exactly three blocks with a non-empty third', async () => {
    const { call } = legacy();
    const result = await call({ include_trace: true, explain: true });
    expect(result.content).toHaveLength(3);
    expect(result.content[2]!.type).toBe('text');
    expect(result.content[2]!.text.length).toBeGreaterThan(0);
  });

  it('A2 block three explains the exact trace serialized into block two', async () => {
    const { call } = legacy();
    const result = await call({ include_trace: true, explain: true });
    expect(result.content).toHaveLength(3);
    const traceFromBlockTwo: unknown = JSON.parse(result.content[1]!.text);
    expect(result.content[2]!.text)
      .toBe(renderRetrievalExplanationTextV1(buildRetrievalExplanationViewV1(traceFromBlockTwo)));
  });

  it('A3 include_trace without explain keeps the pre-packet two-block bytes', async () => {
    const explicit = await legacy().call({ include_trace: true, explain: false });
    expect(explicit.content).toEqual([
      { type: 'text', text: '# md' },
      { type: 'text', text: canonicalTraceJson(approvedTrace) },
    ]);
    const omitted = await legacy().call({ include_trace: true });
    expect(omitted.content).toEqual(explicit.content);
  });

  it('A4 explain without include_trace returns one block and allocates no trace', async () => {
    const { assembler, call } = legacy();
    const result = await call({ include_trace: false, explain: true });
    expect(assembler.assembleTraced).not.toHaveBeenCalled();
    expect(assembler.assemble).toHaveBeenCalledTimes(1);
    expect(result.content).toEqual([{ type: 'text', text: '# md' }]);
  });

  it('A6 the rendered explanation carries the replay receipt', async () => {
    const { call } = legacy();
    const result = await call({ include_trace: true, explain: true });
    expect(result.content).toHaveLength(3);
    expect(result.content[2]!.text).toMatch(/(^|\n)replayReceipt\.replayStateDigest=/);
  });
});

// candidate-channel path (tools.ts:476)
describe('UI-001B explain wiring - candidate-channel path', () => {
  function candidate() {
    const assembler = makeAssembler();
    const resolve = vi.fn().mockResolvedValue(Object.freeze({
      resolution: Object.freeze({ state: 'resolved', canonicalEntityIds: Object.freeze(['entity-stable']) }),
      diagnostics: Object.freeze([]),
    }));
    const execution = Object.freeze({
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
      settlements: Object.freeze(RETRIEVAL_TRACE_CHANNEL_ORDER.map((channel) => Object.freeze({
        contractId: 'memberry.candidate-channel' as const,
        contractVersion: '1.0.0' as const,
        channel, outcome: 'safe-failure' as const, code: 'unavailable' as const,
      }))),
    });
    const candidateRuntime: IRuntimeCandidateChannelService = {
      execute: vi.fn().mockResolvedValue(execution),
    };
    const candidateAssembler = Object.create(UnifiedAssembler.prototype) as UnifiedAssembler;
    vi.mocked(assembler.assembleCandidateExecution!).mockImplementation((...args) => (
      candidateAssembler.assembleCandidateExecution(...args)
    ));
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, createRetrievalContainer({
      assembler,
      tenantId: 'tenant-a',
      authenticated: true,
      queryPlannerEnabled: true,
      resolverFactory: () => ({ resolve }),
      candidateChannelEnabled: true,
      candidateRuntime,
    }));
    const call = (args: Record<string, unknown>) => handlers.get('berry_context')!({
      task: 'safe', strategy: 'ranked', project_name: 'project:memberry', entity_scope: ['Resolver'],
      include_arch: true, include_memory: true, include_code: true, max_tokens: 8_000, ...args,
    }) as Promise<ToolResult>;
    return { assembler, candidateRuntime, call };
  }

  it('A1 include_trace + explain returns exactly three blocks with a non-empty third', async () => {
    const { call } = candidate();
    const result = await call({ include_trace: true, explain: true });
    expect(result.content).toHaveLength(3);
    expect(result.content[2]!.type).toBe('text');
    expect(result.content[2]!.text.length).toBeGreaterThan(0);
  });

  it('A2 block three explains the exact trace serialized into block two', async () => {
    const { call } = candidate();
    const result = await call({ include_trace: true, explain: true });
    expect(result.content).toHaveLength(3);
    const traceFromBlockTwo: unknown = JSON.parse(result.content[1]!.text);
    expect(result.content[2]!.text)
      .toBe(renderRetrievalExplanationTextV1(buildRetrievalExplanationViewV1(traceFromBlockTwo)));
  });

  it('A3 include_trace without explain keeps the pre-packet two-block bytes', async () => {
    const explicit = await candidate().call({ include_trace: true, explain: false });
    expect(explicit.content).toHaveLength(2);
    expect(explicit.content[0]).toEqual({ type: 'text', text: '# md' });
    const trace = JSON.parse(explicit.content[1]!.text) as RetrievalTraceV1;
    expect(trace.requestShape.plannedChannels).toEqual(RETRIEVAL_TRACE_CHANNEL_ORDER);
    expect(trace.complete).toBe(true);
    const omitted = await candidate().call({ include_trace: true });
    expect(omitted.content).toEqual(explicit.content);
  });

  it('A4 explain without include_trace returns one block and allocates no trace', async () => {
    const { assembler, call } = candidate();
    const result = await call({ include_trace: false, explain: true });
    expect(assembler.assembleCandidateExecution).toHaveBeenCalledWith(
      'safe', expect.anything(), 8_000, true, true, false,
    );
    expect(assembler.assembleTraced).not.toHaveBeenCalled();
    expect(result.content).toEqual([{ type: 'text', text: '# md' }]);
  });

  it('A6 the rendered explanation carries the replay receipt', async () => {
    const { call } = candidate();
    const result = await call({ include_trace: true, explain: true });
    expect(result.content).toHaveLength(3);
    expect(result.content[2]!.text).toMatch(/(^|\n)replayReceipt\.replayStateDigest=/);
  });
});

// A7 root exports
describe('UI-001B explanation view root exports', () => {
  it('A7 resolves every explanation-view symbol from the package root', async () => {
    const root = await import('../index.js') as Record<string, unknown>;
    expect(root.buildRetrievalExplanationViewV1).toBe(buildRetrievalExplanationViewV1);
    expect(root.renderRetrievalExplanationTextV1).toBe(renderRetrievalExplanationTextV1);
    expect(root.RetrievalExplanationViewContractError).toBe(RetrievalExplanationViewContractError);
    expect(root.RETRIEVAL_EXPLANATION_VIEW_CONTRACT_ID).toBe(RETRIEVAL_EXPLANATION_VIEW_CONTRACT_ID);
    expect(root.RETRIEVAL_EXPLANATION_VIEW_CONTRACT_VERSION).toBe(RETRIEVAL_EXPLANATION_VIEW_CONTRACT_VERSION);
    expect(root.RETRIEVAL_EXPLANATION_TEXT_MAX_UTF8_BYTES).toBe(RETRIEVAL_EXPLANATION_TEXT_MAX_UTF8_BYTES);
  });

  it('keeps RET-010 construction and application surfaces narrow after serving wiring', async () => {
    const root = await import('../index.js') as Record<string, unknown>;
    expect(root.SERVED_RERANKER_PROVIDER_IDENTITY).toEqual({
      providerId: 'memberry.local.lexical',
      modelId: 'bm25f-query-v1',
      calibrationId: 'fixed-blend-v1',
      locality: 'local',
    });
    expect(typeof root.createServedRerankerProviderV1).toBe('function');
    expect(root.applyServedRerankerV1).toBeUndefined();
    expect(root.parseSerializedRerankerProviderRequestV1).toBeUndefined();
    expect(root.serializeRerankerProviderResponseV1).toBeUndefined();

    const assemblerSource = readFileSync(new URL('../assembler.ts', import.meta.url), 'utf8');
    const toolsSource = readFileSync(new URL('../tools.ts', import.meta.url), 'utf8');
    expect(assemblerSource).not.toMatch(/\bcreateServedRerankerProviderV1\b/);
    expect(assemblerSource.match(/\bapplyServedRerankerV1\s*\(/g)).toHaveLength(1);
    expect(assemblerSource).toContain("servedAttempt ? 'ranked-v2' : 'ranked-v1'");
    expect(toolsSource).not.toMatch(/\bcreateServedRerankerProviderV1\b/);
    expect(toolsSource).not.toMatch(/\bapplyServedRerankerV1\b/);
  });
});
