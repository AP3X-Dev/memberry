// packages/retrieval/src/__tests__/tools.test.ts
// Tenant-isolation wiring for the retrieval tool layer: the container carries a
// tenantId and registerRetrievalTools threads it into every assemble()/ask().
import { readFileSync } from 'node:fs';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  createRetrievalContainer,
  RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENABLED,
  RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENV,
  RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_LINES,
  registerRetrievalTools,
  serializeApprovedRetrievalTrace,
  type IUnifiedAssembler,
  type IFeedbackTracker,
  type RetrievalTraceValidationRuntime,
  type RetrievalTraceValidationStage,
} from '../tools.js';
import { canonicalTraceJson } from '../trace.js';
import type { RetrievalTraceV1 } from '../trace.js';
import type { UnifiedContext } from '../types.js';

const approvedTrace = JSON.parse(readFileSync(
  new URL('./fixtures/retrieval-trace-deterministic-v2.json', import.meta.url),
  'utf8',
)) as RetrievalTraceV1;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function traceValidationRuntime(): RetrievalTraceValidationRuntime {
  const canonical = canonicalTraceJson(approvedTrace);
  return {
    inMemoryConformance: vi.fn(),
    inMemoryReplay: vi.fn(),
    canonicalization: vi.fn(() => canonical),
    exposedJsonParse: vi.fn(() => approvedTrace),
    exposedConformance: vi.fn(),
    exposedReplay: vi.fn(),
  };
}

const validationStageRuntimeKeys = {
  IN_MEMORY_CONFORMANCE: 'inMemoryConformance',
  IN_MEMORY_REPLAY: 'inMemoryReplay',
  CANONICALIZATION: 'canonicalization',
  EXPOSED_JSON_PARSE: 'exposedJsonParse',
  EXPOSED_CONFORMANCE: 'exposedConformance',
  EXPOSED_REPLAY: 'exposedReplay',
} as const satisfies Record<RetrievalTraceValidationStage, keyof RetrievalTraceValidationRuntime>;

describe('retrieval trace validation runtime diagnostics', () => {
  it.each(Object.keys(validationStageRuntimeKeys) as RetrievalTraceValidationStage[])(
    'reports only the fixed %s stage and preserves the public error',
    (stage) => {
      vi.stubEnv(RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENV, RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENABLED);
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const runtime = traceValidationRuntime();
      vi.mocked(runtime[validationStageRuntimeKeys[stage]]).mockImplementation(() => {
        throw new Error('sk_live_NEVER_REFLECT_STAGE_SECRET');
      });

      expect(() => serializeApprovedRetrievalTrace(approvedTrace, runtime))
        .toThrowError('Retrieval trace validation failed');
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_LINES[stage]);
      expect(JSON.stringify(log.mock.calls)).not.toContain('sk_live_NEVER_REFLECT_STAGE_SECRET');
    },
  );

  it.each([undefined, '', '1', 'true', 'ENABLED', 'enabled '])(
    'does not log when the diagnostic opt-in is %s',
    (flag) => {
      if (flag === undefined) vi.stubEnv(RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENV, undefined);
      else vi.stubEnv(RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENV, flag);
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const runtime = traceValidationRuntime();
      vi.mocked(runtime.inMemoryConformance).mockImplementation(() => { throw new Error('secret'); });

      expect(() => serializeApprovedRetrievalTrace(approvedTrace, runtime))
        .toThrowError('Retrieval trace validation failed');
      expect(log).not.toHaveBeenCalled();
    },
  );

  it('keeps successful bytes and logging unchanged while the opt-in is enabled', () => {
    vi.stubEnv(RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENV, RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENABLED);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(serializeApprovedRetrievalTrace(approvedTrace)).toBe(canonicalTraceJson(approvedTrace));
    expect(log).not.toHaveBeenCalled();
  });

  it('still throws the fixed public error if console.error itself throws', () => {
    vi.stubEnv(RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENV, RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENABLED);
    vi.spyOn(console, 'error').mockImplementation(() => { throw new Error('hostile stderr secret'); });
    const runtime = traceValidationRuntime();
    vi.mocked(runtime.inMemoryConformance).mockImplementation(() => { throw new Error('trace secret'); });

    expect(() => serializeApprovedRetrievalTrace(approvedTrace, runtime))
      .toThrowError('Retrieval trace validation failed');
  });
});

function emptyCtx(): UnifiedContext {
  return { task: 'q', strategy: 'ranked', sections: [], token_count: 0, assembled_at: '2026-06-07T00:00:00.000Z' };
}

function makeAssembler(): IUnifiedAssembler {
  return {
    assemble: vi.fn().mockResolvedValue(emptyCtx()),
    assembleTraced: vi.fn().mockResolvedValue({ context: emptyCtx(), trace: approvedTrace }),
    renderMarkdown: vi.fn().mockReturnValue('# md'),
    ask: vi.fn().mockResolvedValue({ answer: 'a', cited_ids: [], evidence: [], level: 'medium' }),
  };
}

function makeFeedback(): IFeedbackTracker {
  return { recordFeedback: vi.fn().mockResolvedValue(undefined) };
}

/**
 * Minimal McpServer stub: server.tool(name, desc, schema, annotations, handler)
 * captures each registered handler by tool name so we can invoke it directly.
 */
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

describe('registerRetrievalTools — tenant threading', () => {
  it('createRetrievalContainer defaults tenantId to the default tenant', () => {
    expect(createRetrievalContainer().tenantId).toBe('default');
    expect(createRetrievalContainer({ tenantId: 'acme' }).tenantId).toBe('acme');
  });

  it('berry_context passes the container tenantId into assemble()', async () => {
    const assembler = makeAssembler();
    const { server, handlers } = makeServerStub();
    const container = createRetrievalContainer({ assembler, feedbackTracker: makeFeedback(), tenantId: 'acme' });

    registerRetrievalTools(server as never, container);
    await handlers.get('berry_context')!({ task: 'find auth', strategy: 'auto' });

    expect(assembler.assemble).toHaveBeenCalledWith(
      'find auth',
      expect.objectContaining({ tenantId: 'acme' }),
    );
  });

  it.each([undefined, false])('berry_context include_trace=%s preserves the ordinary single-call single-block path', async (includeTrace) => {
    const assembler = makeAssembler();
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, createRetrievalContainer({ assembler }));

    const args = { task: 'find auth', strategy: 'ranked', ...(includeTrace === undefined ? {} : { include_trace: includeTrace }) };
    const result = await handlers.get('berry_context')!(args) as { content: Array<{ type: string; text: string }> };

    expect(assembler.assemble).toHaveBeenCalledTimes(1);
    expect(assembler.assembleTraced).not.toHaveBeenCalled();
    expect(assembler.renderMarkdown).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ content: [{ type: 'text', text: '# md' }] });
  });

  it('berry_context include_trace=true returns unchanged markdown then canonical approved trace JSON', async () => {
    const assembler = makeAssembler();
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, createRetrievalContainer({ assembler }));

    const result = await handlers.get('berry_context')!({
      task: 'find auth', strategy: 'deterministic', include_trace: true,
    }) as { content: Array<{ type: string; text: string }> };

    expect(assembler.assemble).not.toHaveBeenCalled();
    expect(assembler.assembleTraced).toHaveBeenCalledWith(
      'find auth',
      expect.objectContaining({ strategy: 'deterministic', tenantId: 'default' }),
    );
    expect(result.content).toEqual([
      { type: 'text', text: '# md' },
      { type: 'text', text: canonicalTraceJson(approvedTrace) },
    ]);
  });

  it('berry_context include_trace=true preserves forced-ranked isolation for named tenants', async () => {
    const assembler = makeAssembler();
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, createRetrievalContainer({ assembler, tenantId: 'acme' }));

    await handlers.get('berry_context')!({ task: 'what depends on auth', strategy: 'deterministic', include_trace: true });

    expect(assembler.assembleTraced).toHaveBeenCalledWith(
      'what depends on auth',
      expect.objectContaining({ strategy: 'ranked', tenantId: 'acme' }),
    );
  });

  it('fails trace exposure closed with a value-free error', async () => {
    const assembler = makeAssembler();
    const credential = 'sk_live_NEVER_ECHO_THIS';
    vi.mocked(assembler.assembleTraced).mockResolvedValue({
      context: emptyCtx(),
      trace: { ...approvedTrace, credential } as unknown as RetrievalTraceV1,
    });
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, createRetrievalContainer({ assembler }));

    let message = '';
    try {
      await handlers.get('berry_context')!({ task: 'find auth', strategy: 'ranked', include_trace: true });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('Retrieval trace validation failed');
    expect(message).not.toContain(credential);
  });

  it('berry_ask passes the container tenantId into ask()', async () => {
    const assembler = makeAssembler();
    const { server, handlers } = makeServerStub();
    const container = createRetrievalContainer({ assembler, feedbackTracker: makeFeedback(), tenantId: 'acme' });

    registerRetrievalTools(server as never, container);
    await handlers.get('berry_ask')!({ question: 'does X use Y?', reasoning_level: 'medium' });

    expect(assembler.ask).toHaveBeenCalledWith(
      'does X use Y?',
      expect.objectContaining({ tenantId: 'acme' }),
    );
  });

  it('defaults to the default tenant when none is supplied to the container', async () => {
    const assembler = makeAssembler();
    const { server, handlers } = makeServerStub();
    const container = createRetrievalContainer({ assembler, feedbackTracker: makeFeedback() });

    registerRetrievalTools(server as never, container);
    await handlers.get('berry_context')!({ task: 't', strategy: 'auto' });

    expect(assembler.assemble).toHaveBeenCalledWith(
      't',
      expect.objectContaining({ tenantId: 'default' }),
    );
  });

  it('berry_feedback threads the container tenantId into recordFeedback()', async () => {
    const feedbackTracker = makeFeedback();
    const { server, handlers } = makeServerStub();
    const container = createRetrievalContainer({ assembler: makeAssembler(), feedbackTracker, tenantId: 'acme' });

    registerRetrievalTools(server as never, container);
    await handlers.get('berry_feedback')!({
      result_id: 'sem-1',
      was_useful: true,
      session_id: 'sess-1',
      query: 'auth flow',
      source_type: 'semantic',
    });

    // Second positional arg is the resolved tenant — pins that the feedback
    // write is tenant-scoped, not process-global.
    expect(feedbackTracker.recordFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ result_id: 'sem-1', was_useful: true }),
      'acme',
    );
  });
});
