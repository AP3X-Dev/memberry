// packages/core/src/__tests__/project-setup.test.ts
//
// Unit tests for the `memberry project setup` MCP-client path. The transport is
// MOCKED (global fetch) — there is no live server here; the live end-to-end run
// happens at the final gate. We assert:
//   - the JSON-RPC client helper: handshake order, SSE parsing, error surfacing
//   - runProject('setup', ...): the full call sequence (initialize →
//     notifications/initialized → berry_tools enable admin → berry_ingest_codebase
//     with the right args → [--with-wiki] enable wiki → berry_compile), the printed
//     summary, and graceful failure on a tool error / missing path / missing token.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parseJsonRpcBody,
  mcpInitialize,
  mcpCall,
  McpClientError,
} from '../cli/mcp-client.js';
import { parseSummaryField, wikiBaseUrl, runProject } from '../cli/project.js';

// ─── Mock-fetch harness ───────────────────────────────────────────────────────

interface RecordedCall {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: any;
}

const SESSION_ID = 'sess-abc-123';

/** Build the ingest summary markdown the real berry_ingest_codebase returns. */
function ingestSummaryText(): string {
  return [
    '## Codebase Ingestion Complete\n',
    '**Project:** my-proj (project:my-proj)',
    '**Domain:** software',
    '**Languages:** typescript, javascript',
    '**Source files found:** 120',
    '**Files indexed:** 118',
    '**Files skipped:** 2',
    '**Symbols created:** 540',
    '**Symbols updated:** 12',
    '**Code relationships:** 880',
    '**Entities bootstrapped:** 9 (7 new, 2 existing)',
    '**Semantic seeds:** 15',
    '**Memory blocks seeded:** 2',
    '**Modules:** core, mcp, wiki',
    '**Entry points:** packages/core/src/cli.ts',
  ].join('\n');
}

/**
 * A fetch mock that emulates the MCP server handshake + tools/call. Records every
 * call. `opts.sse` makes tool results come back as text/event-stream. `opts.failTool`
 * makes that tool name return a JSON-RPC error. `opts.unreachable` rejects every call.
 */
function makeFetchMock(opts: {
  sse?: boolean;
  failTool?: string;
  unreachable?: boolean;
  authFail?: boolean;
} = {}) {
  const calls: RecordedCall[] = [];
  const fn = vi.fn(async (url: string, init?: any): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method: init?.method, headers, body });

    if (opts.unreachable) {
      throw new TypeError('fetch failed');
    }

    // Wiki viewer refresh endpoint (different path, not /mcp).
    if (url.endsWith('/api/refresh')) {
      return new Response(JSON.stringify({ ok: true, files: 5 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    const method = body?.method as string | undefined;

    if (method === 'initialize') {
      if (opts.authFail) {
        return new Response('unauthorized', { status: 401 });
      }
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', serverInfo: { name: 'memberry-mcp' } } }),
        { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': SESSION_ID } },
      );
    }

    if (method === 'notifications/initialized') {
      return new Response(null, { status: 202 });
    }

    if (method === 'tools/call') {
      const toolName = body.params?.name as string;
      const args = body.params?.arguments ?? {};

      // Simulated tool-level JSON-RPC error.
      if (opts.failTool && toolName === opts.failTool) {
        const env = { jsonrpc: '2.0', id: body.id, error: { code: -32000, message: `tool ${toolName} blew up` } };
        return jsonRpcResponse(env, opts.sse);
      }

      let resultText: string;
      if (toolName === 'berry_tools') {
        resultText = JSON.stringify({ ok: true, action: 'enabled', domain: args.domain });
      } else if (toolName === 'berry_ingest_codebase') {
        resultText = ingestSummaryText();
      } else if (toolName === 'berry_compile') {
        resultText = JSON.stringify({ projects_compiled: 1, articles_compiled: 9 }, null, 2);
      } else {
        resultText = 'ok';
      }

      const env = { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: resultText }] } };
      return jsonRpcResponse(env, opts.sse);
    }

    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });

  return { fn, calls };
}

/** Return a JSON-RPC envelope as either an application/json or text/event-stream body. */
function jsonRpcResponse(env: unknown, sse?: boolean): Response {
  if (sse) {
    return new Response(`event: message\ndata: ${JSON.stringify(env)}\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }
  return new Response(JSON.stringify(env), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Pull the tools/call records (in order) and the tool names called. */
function toolCallNames(calls: RecordedCall[]): string[] {
  return calls
    .filter((c) => c.body?.method === 'tools/call')
    .map((c) => c.body.params.name as string);
}

// ─── Helper-level unit tests ───────────────────────────────────────────────────

describe('mcp-client: parseJsonRpcBody', () => {
  it('parses a plain application/json envelope', () => {
    const env = { jsonrpc: '2.0', id: 1, result: { ok: true } };
    expect(parseJsonRpcBody('application/json', JSON.stringify(env))).toEqual(env);
  });

  it('parses the JSON-RPC result out of an SSE data: line', () => {
    const env = { jsonrpc: '2.0', id: 2, result: { hi: 'there' } };
    const body = `event: message\ndata: ${JSON.stringify(env)}\n\n`;
    expect(parseJsonRpcBody('text/event-stream', body)).toEqual(env);
  });

  it('parses an SSE payload split across multiple data: lines', () => {
    const env = { jsonrpc: '2.0', id: 3, result: { a: 1, b: 2 } };
    const json = JSON.stringify(env, null, 2);
    const body = json.split('\n').map((l) => `data: ${l}`).join('\n') + '\n\n';
    expect(parseJsonRpcBody('text/event-stream', body)).toEqual(env);
  });

  it('throws McpClientError on an empty body', () => {
    expect(() => parseJsonRpcBody('application/json', '   ')).toThrow(McpClientError);
  });

  it('throws McpClientError on unparseable JSON', () => {
    expect(() => parseJsonRpcBody('application/json', 'not json')).toThrow(McpClientError);
  });
});

describe('project: parseSummaryField', () => {
  it('extracts bolded **Key:** value lines', () => {
    const text = ingestSummaryText();
    expect(parseSummaryField(text, 'Files indexed')).toBe('118');
    expect(parseSummaryField(text, 'Symbols created')).toBe('540');
    expect(parseSummaryField(text, 'Entities bootstrapped')).toBe('9 (7 new, 2 existing)');
    expect(parseSummaryField(text, 'Modules')).toBe('core, mcp, wiki');
  });

  it('returns undefined for an absent label', () => {
    expect(parseSummaryField(ingestSummaryText(), 'Nope')).toBeUndefined();
  });
});

describe('project: wikiBaseUrl', () => {
  it('derives the :3200 viewer URL from the MCP URL host', () => {
    expect(wikiBaseUrl('http://lan-host:3101/mcp')).toBe('http://lan-host:3200');
    expect(wikiBaseUrl('http://localhost:3101/mcp')).toBe('http://localhost:3200');
  });

  it('falls back to localhost:3200 on a bad URL', () => {
    expect(wikiBaseUrl('not a url')).toBe('http://localhost:3200');
  });
});

// ─── Transport-level handshake tests (mocked fetch) ─────────────────────────────

describe('mcp-client: handshake (mocked transport)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('initialize → notifications/initialized in order, capturing the session id', async () => {
    const { fn, calls } = makeFetchMock();
    globalThis.fetch = fn as any;

    const session = await mcpInitialize('http://localhost:3101/mcp', 'tok');
    expect(session.sessionId).toBe(SESSION_ID);
    expect(session.protocolVersion).toBe('2025-03-26');

    expect(calls[0].body.method).toBe('initialize');
    expect(calls[0].body.params.protocolVersion).toBe('2025-03-26');
    expect(calls[0].headers.Authorization).toBe('Bearer tok');
    expect(calls[0].headers.Accept).toContain('text/event-stream');

    expect(calls[1].body.method).toBe('notifications/initialized');
    // Follow-up carries the bound session + protocol headers.
    expect(calls[1].headers['mcp-session-id']).toBe(SESSION_ID);
    expect(calls[1].headers['mcp-protocol-version']).toBe('2025-03-26');
  });

  it('surfaces a 401 as an auth McpClientError', async () => {
    const { fn } = makeFetchMock({ authFail: true });
    globalThis.fetch = fn as any;
    await expect(mcpInitialize('http://localhost:3101/mcp', 'bad')).rejects.toBeInstanceOf(McpClientError);
  });

  it('surfaces an unreachable server as McpClientError', async () => {
    const { fn } = makeFetchMock({ unreachable: true });
    globalThis.fetch = fn as any;
    await expect(mcpInitialize('http://localhost:3101/mcp', 'tok')).rejects.toThrow(/could not reach/i);
  });

  it('mcpCall surfaces a JSON-RPC tool error (parsing SSE)', async () => {
    const { fn } = makeFetchMock({ sse: true, failTool: 'berry_ingest_codebase' });
    globalThis.fetch = fn as any;
    const session = await mcpInitialize('http://localhost:3101/mcp', 'tok');
    await expect(mcpCall(session, 'berry_ingest_codebase', { path: '/x' })).rejects.toBeInstanceOf(McpClientError);
  });
});

// ─── runProject('setup', ...) integration (mocked fetch) ────────────────────────

describe('runProject setup (mocked transport)', () => {
  const originalFetch = globalThis.fetch;
  const ENV = { ...process.env };
  let logs: string[];
  let errs: string[];
  let logSpy: any;
  let errSpy: any;

  beforeEach(() => {
    logs = [];
    errs = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { logs.push(a.join(' ')); });
    errSpy = vi.spyOn(console, 'error').mockImplementation((...a: any[]) => { errs.push(a.join(' ')); });
    process.exitCode = 0;
    // Deterministic resolution: explicit token via env (configure's resolveToken).
    process.env.MEMBERRY_API_TOKEN = 'tok-env';
    delete process.env.MEMBERRY_MCP_URL;
    delete process.env.MEMBERRY_PUBLIC_HOST;
    delete process.env.MCP_PORT;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = 0;
    for (const k of ['MEMBERRY_API_TOKEN', 'MEMBERRY_MCP_URL', 'MEMBERRY_PUBLIC_HOST', 'MCP_PORT']) {
      if (ENV[k] === undefined) delete process.env[k]; else process.env[k] = ENV[k]!;
    }
    vi.restoreAllMocks();
  });

  it('runs initialize → enable admin → berry_ingest_codebase (no wiki) with the right args + summary', async () => {
    const { fn, calls } = makeFetchMock();
    globalThis.fetch = fn as any;

    await runProject(['setup', '/workspace/my-proj'], { 'project-name': 'my-proj', 'project-tag': 'project:my-proj' });

    expect(process.exitCode).toBe(0);

    // Sequence: initialize, notifications/initialized, then tool calls in order.
    expect(calls[0].body.method).toBe('initialize');
    expect(calls[1].body.method).toBe('notifications/initialized');

    const tools = toolCallNames(calls);
    expect(tools).toEqual(['berry_tools', 'berry_ingest_codebase']);

    // berry_tools enabled the admin domain.
    const enableCall = calls.find((c) => c.body?.params?.name === 'berry_tools')!;
    expect(enableCall.body.params.arguments).toEqual({ action: 'enable', domain: 'admin' });

    // berry_ingest_codebase got the right args (path + name + tag).
    const ingestCall = calls.find((c) => c.body?.params?.name === 'berry_ingest_codebase')!;
    expect(ingestCall.body.params.arguments).toEqual({
      path: '/workspace/my-proj',
      project_name: 'my-proj',
      project_tag: 'project:my-proj',
    });

    // Summary echoes the parsed counts + the MCP URL.
    const out = logs.join('\n');
    expect(out).toContain('MemBerry project setup complete.');
    expect(out).toContain('my-proj');
    expect(out).toContain('118'); // files indexed
    expect(out).toContain('540'); // symbols created
    expect(out).toContain('core, mcp, wiki'); // modules
    expect(out).toContain('http://localhost:3101/mcp');
    // No wiki line without --with-wiki.
    expect(out).not.toContain('/wiki/_index');
  });

  it('with --with-wiki also enables wiki, compiles, refreshes, and prints the wiki URL', async () => {
    const { fn, calls } = makeFetchMock();
    globalThis.fetch = fn as any;

    await runProject(['setup', '/workspace/my-proj'], { 'project-name': 'my-proj', 'project-tag': 'project:my-proj', 'with-wiki': true });

    expect(process.exitCode).toBe(0);

    const tools = toolCallNames(calls);
    expect(tools).toEqual(['berry_tools', 'berry_ingest_codebase', 'berry_tools', 'berry_compile']);

    // The two berry_tools enables target admin then wiki, in that order.
    const enables = calls.filter((c) => c.body?.params?.name === 'berry_tools').map((c) => c.body.params.arguments.domain);
    expect(enables).toEqual(['admin', 'wiki']);

    // berry_compile got the project_tag.
    const compileCall = calls.find((c) => c.body?.params?.name === 'berry_compile')!;
    expect(compileCall.body.params.arguments).toEqual({ project_tag: 'project:my-proj' });

    // Best-effort viewer refresh hit /api/refresh.
    expect(calls.some((c) => c.url.endsWith('/api/refresh'))).toBe(true);

    const out = logs.join('\n');
    expect(out).toContain('http://localhost:3200/wiki/_index');
  });

  it('omits project_tag from berry_compile when only --project-name is given (derives it)', async () => {
    const { fn, calls } = makeFetchMock();
    globalThis.fetch = fn as any;

    await runProject(['setup', '/workspace/my-proj'], { 'project-name': 'my-proj', 'with-wiki': true });

    const compileCall = calls.find((c) => c.body?.params?.name === 'berry_compile')!;
    expect(compileCall.body.params.arguments).toEqual({ project_tag: 'project:my-proj' });
  });

  it('fails cleanly (exit 1, no crash) on a tool error from berry_ingest_codebase', async () => {
    const { fn } = makeFetchMock({ failTool: 'berry_ingest_codebase' });
    globalThis.fetch = fn as any;

    await runProject(['setup', '/workspace/my-proj'], { 'project-name': 'my-proj' });

    expect(process.exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/project setup:/);
    expect(errs.join('\n')).toMatch(/blew up/);
  });

  it('errors clearly when <path> is missing (exit 1)', async () => {
    const { fn, calls } = makeFetchMock();
    globalThis.fetch = fn as any;

    await runProject(['setup'], { 'project-name': 'my-proj' });

    expect(process.exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/missing <path>/);
    // Never opened a transport.
    expect(calls.length).toBe(0);
  });

  it('errors clearly when no token resolves (exit 1)', async () => {
    delete process.env.MEMBERRY_API_TOKEN;
    const { fn, calls } = makeFetchMock();
    globalThis.fetch = fn as any;

    await runProject(['setup', '/workspace/my-proj'], { 'project-name': 'my-proj' });

    expect(process.exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/no API token resolved/);
    expect(calls.length).toBe(0);
  });

  it('surfaces an unreachable server cleanly (exit 1)', async () => {
    const { fn } = makeFetchMock({ unreachable: true });
    globalThis.fetch = fn as any;

    await runProject(['setup', '/workspace/my-proj'], { 'project-name': 'my-proj' });

    expect(process.exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/could not reach/i);
  });

  it('parses an SSE tool response in the full flow (no crash, exit 0)', async () => {
    const { fn } = makeFetchMock({ sse: true });
    globalThis.fetch = fn as any;

    await runProject(['setup', '/workspace/my-proj'], { 'project-name': 'my-proj', 'project-tag': 'project:my-proj' });

    expect(process.exitCode).toBe(0);
    expect(logs.join('\n')).toContain('118');
  });
});
