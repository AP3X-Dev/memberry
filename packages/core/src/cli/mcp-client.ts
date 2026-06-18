// packages/core/src/cli/mcp-client.ts
//
// A minimal authenticated MCP client for the CLI. The full scan→bootstrap→index→
// bridge→seed pipeline (`berry_ingest_codebase`) and wiki build (`berry_compile`)
// live in @memberry/mcp / @memberry/wiki, which depend on @memberry/core — so core
// CANNOT import them (dependency cycle). Instead, the CLI talks to a RUNNING
// server over its streamable-HTTP `/mcp` endpoint and lets the server do the work
// on its mounted workspace. This module is the thin transport for that.
//
// It implements exactly the handshake the server expects (see
// packages/mcp/src/server.ts and its server.test.ts):
//   1. POST `initialize` (protocolVersion '2025-03-26') → capture the
//      `mcp-session-id` response header + negotiated protocol version.
//   2. POST `notifications/initialized` with the session headers (expect 202).
//   3. POST `tools/call` for each tool, carrying the session + protocol headers.
//
// Responses may come back as `application/json` OR `text/event-stream` (SSE); both
// carry a single JSON-RPC envelope, so we parse the result out of either shape.
//
// Factored so follow-up CLI commands (T14/T15) can reuse the same client.

/** A connected MCP session: the handshake is done, follow-up calls can be made. */
export interface McpSession {
  url: string;
  token: string;
  sessionId: string;
  protocolVersion: string;
}

/** The MCP protocol version this client negotiates with. */
export const MCP_PROTOCOL_VERSION = '2025-03-26';

/** Thrown for any transport/protocol/tool failure so callers can surface cleanly. */
export class McpClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpClientError';
  }
}

/**
 * Parse a JSON-RPC envelope out of an MCP HTTP response body. The server may
 * answer with `application/json` (the body IS the envelope) or `text/event-stream`
 * (the envelope rides in a `data:` line). Handles both; throws McpClientError on
 * anything unparseable.
 */
export function parseJsonRpcBody(contentType: string | null, body: string): unknown {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('text/event-stream')) {
    // Concatenate every `data:` line (SSE allows the payload to span lines), then
    // parse. We take the first complete JSON object found across data lines.
    const dataLines: string[] = [];
    for (const raw of body.split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
    const joined = dataLines.join('\n').trim();
    if (!joined) {
      throw new McpClientError('SSE response carried no data line to parse.');
    }
    try {
      return JSON.parse(joined);
    } catch {
      throw new McpClientError(`Could not parse JSON-RPC from SSE data: ${joined.slice(0, 200)}`);
    }
  }
  // Default: treat the body as a JSON envelope.
  const trimmed = body.trim();
  if (!trimmed) {
    throw new McpClientError('Empty response body where a JSON-RPC envelope was expected.');
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new McpClientError(`Could not parse JSON-RPC response: ${trimmed.slice(0, 200)}`);
  }
}

interface JsonRpcEnvelope {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/** Extract `result` from a JSON-RPC envelope, surfacing a JSON-RPC `error` cleanly. */
function unwrapResult(envelope: unknown, ctx: string): unknown {
  const env = envelope as JsonRpcEnvelope;
  if (env && typeof env === 'object' && env.error) {
    const code = env.error.code != null ? ` (code ${env.error.code})` : '';
    throw new McpClientError(`${ctx}: server returned JSON-RPC error${code}: ${env.error.message ?? 'unknown error'}`);
  }
  if (!env || typeof env !== 'object' || !('result' in env)) {
    throw new McpClientError(`${ctx}: response carried no result.`);
  }
  return env.result;
}

const ACCEPT = 'application/json, text/event-stream';

/** Base headers for every /mcp POST: bearer auth + dual accept + json content. */
function baseHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: ACCEPT,
    'Content-Type': 'application/json',
  };
}

/** Wrap fetch so connection refusals/DNS failures surface as a clear McpClientError. */
async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  ctx: string,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new McpClientError(`${ctx}: could not reach MCP server at ${url} — ${msg}`);
  }
  return res;
}

/**
 * Run the MCP handshake against `url` with the bearer `token` and return a live
 * session. POSTs `initialize` (capturing the `mcp-session-id` header + negotiated
 * protocol version), then `notifications/initialized` (which the server answers
 * with 202). Throws McpClientError on auth failure, unreachable server, or a
 * malformed handshake.
 */
export async function mcpInitialize(url: string, token: string): Promise<McpSession> {
  const initRes = await post(
    url,
    baseHeaders(token),
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'memberry-cli', version: '0.0.0' },
      },
    },
    'initialize',
  );

  if (initRes.status === 401 || initRes.status === 403) {
    throw new McpClientError(
      `initialize: authentication failed (HTTP ${initRes.status}). Check --token / MEMBERRY_API_TOKEN.`,
    );
  }
  if (!initRes.ok) {
    throw new McpClientError(`initialize: server responded HTTP ${initRes.status}.`);
  }

  const sessionId = initRes.headers.get('mcp-session-id');
  if (!sessionId) {
    throw new McpClientError('initialize: server did not return an mcp-session-id header.');
  }

  const initBody = parseJsonRpcBody(initRes.headers.get('content-type'), await initRes.text());
  const result = unwrapResult(initBody, 'initialize') as { protocolVersion?: string };
  const protocolVersion = result?.protocolVersion ?? MCP_PROTOCOL_VERSION;

  const session: McpSession = { url, token, sessionId, protocolVersion };

  // notifications/initialized — no id (it is a notification); server replies 202.
  const ackRes = await post(
    url,
    sessionHeaders(session),
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    'notifications/initialized',
  );
  if (ackRes.status !== 202 && !ackRes.ok) {
    throw new McpClientError(
      `notifications/initialized: server responded HTTP ${ackRes.status} (expected 202).`,
    );
  }

  return session;
}

/** Headers for a follow-up call: base + the bound session id and protocol version. */
function sessionHeaders(session: McpSession): Record<string, string> {
  return {
    ...baseHeaders(session.token),
    'mcp-session-id': session.sessionId,
    'mcp-protocol-version': session.protocolVersion,
  };
}

/** The `content` array shape a tools/call result carries. */
export interface ToolCallResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

/**
 * Call an MCP tool over an established session and return its `result`. Surfaces
 * a JSON-RPC error, a tool-level `isError`, or a transport failure as a clear
 * McpClientError.
 */
export async function mcpCall(
  session: McpSession,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const res = await post(
    session.url,
    sessionHeaders(session),
    {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    },
    `tools/call ${toolName}`,
  );
  if (!res.ok) {
    throw new McpClientError(`tools/call ${toolName}: server responded HTTP ${res.status}.`);
  }
  const envelope = parseJsonRpcBody(res.headers.get('content-type'), await res.text());
  const result = unwrapResult(envelope, `tools/call ${toolName}`) as ToolCallResult;
  if (result?.isError) {
    throw new McpClientError(`tools/call ${toolName}: tool reported an error — ${toolCallText(result)}`);
  }
  return result;
}

/** Concatenate the text blocks of a tool result into a single string. */
export function toolCallText(result: ToolCallResult): string {
  return (result.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n');
}

/** Enable a Tier-2 tool domain via the always-on berry_tools gateway. */
export async function mcpEnableDomain(session: McpSession, domain: string): Promise<void> {
  await mcpCall(session, 'berry_tools', { action: 'enable', domain });
}
