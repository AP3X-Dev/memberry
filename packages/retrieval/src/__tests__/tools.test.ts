// packages/retrieval/src/__tests__/tools.test.ts
// Tenant-isolation wiring for the retrieval tool layer: the container carries a
// tenantId and registerRetrievalTools threads it into every assemble()/ask().
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import {
  createRetrievalContainer,
  registerRetrievalTools,
  type IUnifiedAssembler,
  type IFeedbackTracker,
} from '../tools.js';
import { canonicalTraceJson } from '../trace.js';
import type { RetrievalTraceV1 } from '../trace.js';
import type { UnifiedContext } from '../types.js';

const approvedTrace = JSON.parse(readFileSync(
  new URL('./fixtures/retrieval-trace-deterministic-v2.json', import.meta.url),
  'utf8',
)) as RetrievalTraceV1;

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
