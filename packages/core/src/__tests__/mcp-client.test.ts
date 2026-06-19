// packages/core/src/__tests__/mcp-client.test.ts
//
// Focused unit tests for the non-2xx error path of the MCP client (OPT-5). The
// server answers HTTP failures (404 after a long ingest, 400, 413, …) with a
// descriptive JSON-RPC error envelope; the client must surface that message
// instead of discarding it behind a bare "server responded HTTP <status>".
//
// Transport is MOCKED (global fetch) — no live server here.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mcpInitialize, mcpCall, McpClientError, type McpSession } from '../cli/mcp-client.js';

const SESSION_ID = 'sess-err-1';

/** A 200 initialize response so we can establish a session before a failing tools/call. */
function initOk(id: number): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-03-26' } }),
    { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': SESSION_ID } },
  );
}

describe('mcp-client: non-2xx surfaces the server JSON-RPC error message (OPT-5)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('mcpInitialize appends the JSON-RPC error.message from a 404 body', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'Session not found' } }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      ),
    ) as any;

    const err = await mcpInitialize('http://localhost:3101/mcp', 'tok').catch((e) => e);
    expect(err).toBeInstanceOf(McpClientError);
    expect((err as Error).message).toContain('HTTP 404');
    expect((err as Error).message).toContain('Session not found');
  });

  it('mcpCall appends the JSON-RPC error.message from a 404 body', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async (_url: string, init?: any) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      n++;
      if (body?.method === 'initialize') return initOk(body.id);
      if (body?.method === 'notifications/initialized') return new Response(null, { status: 202 });
      // tools/call → 404 with a descriptive envelope (e.g. session expired mid-ingest).
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: body?.id, error: { message: 'Session not found' } }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }) as any;

    const session = await mcpInitialize('http://localhost:3101/mcp', 'tok');
    const err = await mcpCall(session, 'berry_ingest_codebase', { path: '/x' }).catch((e) => e);
    expect(err).toBeInstanceOf(McpClientError);
    expect((err as Error).message).toContain('Session not found');
    expect(n).toBeGreaterThan(0);
  });

  it('falls back to the bare status string when the error body is not JSON-RPC', async () => {
    const session: McpSession = {
      url: 'http://localhost:3101/mcp',
      token: 'tok',
      sessionId: SESSION_ID,
      protocolVersion: '2025-03-26',
    };
    globalThis.fetch = vi.fn(async () =>
      new Response('Payload Too Large', { status: 413, headers: { 'content-type': 'text/plain' } }),
    ) as any;

    const err = await mcpCall(session, 'berry_store', {}).catch((e) => e);
    expect(err).toBeInstanceOf(McpClientError);
    expect((err as Error).message).toContain('HTTP 413');
  });

  it('still uses the explicit auth message on 401/403 (not the generic path)', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('unauthorized', { status: 401 }),
    ) as any;

    const err = await mcpInitialize('http://localhost:3101/mcp', 'bad').catch((e) => e);
    expect(err).toBeInstanceOf(McpClientError);
    expect((err as Error).message).toMatch(/authentication failed/i);
  });
});
