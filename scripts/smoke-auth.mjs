#!/usr/bin/env node
//
// Authenticated end-to-end smoke test (gap 6).
//
// This is SEPARATE from scripts/smoke.mjs (which is a BUILD smoke: it checks the
// compiled dist/ entries exist and does a best-effort UNauthenticated /healthz).
// This script proves the RUNTIME contract against a live, authenticated server:
//
//   1. GET /readyz with Bearer            → 200 (token auth works)
//   2. POST /mcp initialize               → 200; capture mcp-session-id +
//                                            protocolVersion; serverInfo.name ===
//                                            'memberry-mcp'
//   3. POST /mcp notifications/initialized → 202
//   4. POST /mcp tools/list               → 200; contains berry_load / berry_store
//                                            / berry_tools
//   5. POST /mcp tools/call berry_tools   → enable the "wiki" domain, then re-list
//      {action:'enable',domain:'wiki'}      on the SAME session and assert a wiki
//                                            tool (berry_compile) now appears —
//                                            proving dynamic domain enable changes
//                                            the live tool set.
//   6. GET <host>:3200/wiki/_index        → best-effort wiki probe.
//
// SKIP CLEANLY (print a message, EXIT 0) when:
//   - no MEMBERRY_API_TOKEN is set, OR
//   - the server is unreachable (ECONNREFUSED / connect timeout).
// This MUST NOT fail when no server is running — it is wired into setup/CI as a
// best-effort step.
//
// EXIT NON-ZERO only when the server is reachable but answers wrong.
//
// Raw JSON-RPC is driven over Node 18+ global fetch (NOT a typed MCP client) so
// the domain-enable re-list works regardless of any client tools/list_changed
// handling. The /mcp response body may be text/event-stream — we parse the
// JSON-RPC object out of the `data:` line (and also handle plain application/json).

const TOKEN =
  process.env.MEMBERRY_API_TOKEN ||
  process.env.AMP_API_TOKEN ||
  '';

const HOST = process.env.MEMBERRY_PUBLIC_HOST || '127.0.0.1';
const PORT = process.env.MCP_PORT || process.env.PORT || '3101';
const BASE = `http://${HOST}:${PORT}`;
const WIKI_PORT = process.env.MEMBERRY_WIKI_PORT || '3200';
const WIKI_BASE = `http://${HOST}:${WIKI_PORT}`;
const REQUIRE_WIKI =
  (process.env.MEMBERRY_SMOKE_REQUIRE_WIKI || '').toLowerCase() === 'true';

// Short connect timeout so an absent server skips fast instead of hanging.
const CONNECT_TIMEOUT_MS = Number.parseInt(
  process.env.MEMBERRY_SMOKE_TIMEOUT_MS || '2000',
  10,
);

const PROTOCOL_VERSION = '2025-03-26';

const pass = [];
const fail = [];

/** True for the errors a not-running server raises (so we skip, not fail). */
function isUnreachable(err) {
  const code = err?.cause?.code || err?.code || '';
  if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN'
  ) {
    return true;
  }
  // AbortController-driven connect timeout surfaces as an AbortError.
  if (err?.name === 'AbortError') return true;
  return false;
}

/** fetch() with an AbortController connect/read timeout. Returns the Response. */
async function fetchTimed(url, init = {}, timeoutMs = CONNECT_TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse a JSON-RPC object from a /mcp response whose body may be either
 * application/json or text/event-stream. For SSE, the JSON-RPC object rides in
 * the `data:` line(s) of an event; we concatenate the data payload and JSON.parse
 * it. For plain JSON we parse the whole body. Returns the parsed object (or
 * undefined for an empty body, e.g. a 202 notification ack).
 */
async function parseRpcBody(res) {
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  const text = await res.text();
  if (!text.trim()) return undefined;

  if (ct.includes('text/event-stream')) {
    // SSE frames: lines beginning with "data:" carry the payload. A single
    // JSON-RPC message may be split across multiple data: lines — concatenate
    // them, then parse the first complete JSON object.
    const dataLines = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    const payload = dataLines.join('\n').trim();
    if (!payload) return undefined;
    return JSON.parse(payload);
  }

  // Plain application/json (the server sets enableJsonResponse, so this is the
  // common path).
  return JSON.parse(text);
}

const MCP_HEADERS_BASE = {
  authorization: `Bearer ${TOKEN}`,
  accept: 'application/json, text/event-stream',
  'content-type': 'application/json',
};

/** POST a JSON-RPC envelope to /mcp with the given (optional) session headers. */
async function mcpPost(body, sessionHeaders = {}) {
  return fetchTimed(`${BASE}/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS_BASE, ...sessionHeaders },
    body: JSON.stringify(body),
  });
}

/** Pull the tool-name array out of a tools/list JSON-RPC result. */
function toolNamesFrom(rpc) {
  const tools = rpc?.result?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.map((t) => t?.name).filter((n) => typeof n === 'string');
}

function summarize() {
  console.log('\n=== MemBerry authenticated smoke test ===');
  for (const p of pass) console.log(`  PASS  ${p}`);
  for (const f of fail) console.log(`  FAIL  ${f}`);
  console.log('=========================================');
}

async function main() {
  // ── Clean skip: no token configured ──────────────────────────────────────
  if (!TOKEN) {
    console.log(
      '[smoke-auth] No MEMBERRY_API_TOKEN set — skipping authenticated smoke test (clean skip).',
    );
    process.exit(0);
  }

  // ── Reachability probe: GET /healthz (unauthenticated, always served). ────
  // ECONNREFUSED / timeout here means "no server running" → clean skip.
  try {
    const health = await fetchTimed(`${BASE}/healthz`);
    health.body?.cancel?.().catch(() => {});
    // A reachable server that answers /healthz with non-200 is a real problem.
    if (health.status !== 200) {
      fail.push(`/healthz: expected 200, got ${health.status} at ${BASE}`);
    }
  } catch (err) {
    if (isUnreachable(err)) {
      console.log(
        `[smoke-auth] No MCP server reachable at ${BASE} (${err?.cause?.code || err?.code || err?.name || err?.message}) — skipping (clean skip).`,
      );
      process.exit(0);
    }
    throw err;
  }

  // From here the server IS reachable: any wrong answer is a hard FAIL.

  // ── 1. GET /readyz with Bearer → 200 (token auth works). ─────────────────
  try {
    const ready = await fetchTimed(`${BASE}/readyz`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    ready.body?.cancel?.().catch(() => {});
    if (ready.status === 200) {
      pass.push('/readyz with Bearer → 200 (token accepted)');
    } else if (ready.status === 401) {
      fail.push('/readyz → 401 (MEMBERRY_API_TOKEN does not match the server token)');
    } else {
      fail.push(`/readyz with Bearer → expected 200, got ${ready.status}`);
    }
  } catch (err) {
    fail.push(`/readyz request errored: ${err?.message || err}`);
  }

  // ── 2. POST /mcp initialize → 200; capture session id + protocolVersion. ──
  let sessionId = '';
  let protocolVersion = PROTOCOL_VERSION;
  let initialized = false;
  try {
    const init = await mcpPost({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'memberry-smoke-auth', version: '0.0.0' },
      },
    });
    if (init.status !== 200) {
      const body = await init.text().catch(() => '');
      fail.push(`/mcp initialize → expected 200, got ${init.status}${body ? ` (${body.slice(0, 120)})` : ''}`);
    } else {
      sessionId = init.headers.get('mcp-session-id') || '';
      const rpc = await parseRpcBody(init);
      const name = rpc?.result?.serverInfo?.name;
      protocolVersion = rpc?.result?.protocolVersion || PROTOCOL_VERSION;
      if (!sessionId) {
        fail.push('/mcp initialize → 200 but no mcp-session-id response header');
      } else if (name !== 'memberry-mcp') {
        fail.push(`/mcp initialize → serverInfo.name expected 'memberry-mcp', got '${name}'`);
      } else {
        initialized = true;
        pass.push(`/mcp initialize → 200 (serverInfo.name='memberry-mcp', session captured)`);
      }
    }
  } catch (err) {
    fail.push(`/mcp initialize errored: ${err?.message || err}`);
  }

  // Session-scoped headers for every post-init call.
  const sessionHeaders = {
    'mcp-session-id': sessionId,
    'mcp-protocol-version': protocolVersion,
  };

  // ── 3. POST /mcp notifications/initialized (session) → 202. ───────────────
  if (initialized) {
    try {
      const note = await mcpPost(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        sessionHeaders,
      );
      note.body?.cancel?.().catch(() => {});
      if (note.status === 202) {
        pass.push('/mcp notifications/initialized → 202');
      } else {
        fail.push(`/mcp notifications/initialized → expected 202, got ${note.status}`);
      }
    } catch (err) {
      fail.push(`/mcp notifications/initialized errored: ${err?.message || err}`);
    }
  }

  // ── 4. POST /mcp tools/list (session) → 200; core berry_* present. ────────
  if (initialized) {
    try {
      const list = await mcpPost(
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        sessionHeaders,
      );
      if (list.status !== 200) {
        fail.push(`/mcp tools/list → expected 200, got ${list.status}`);
      } else {
        const rpc = await parseRpcBody(list);
        const names = toolNamesFrom(rpc);
        const required = ['berry_load', 'berry_store', 'berry_tools'];
        const missing = required.filter((n) => !names.includes(n));
        if (missing.length > 0) {
          fail.push(`/mcp tools/list → missing core tool(s): ${missing.join(', ')} (saw ${names.length} tools)`);
        } else {
          pass.push(`/mcp tools/list → 200 with berry_load, berry_store, berry_tools (${names.length} tools)`);
        }
      }
    } catch (err) {
      fail.push(`/mcp tools/list errored: ${err?.message || err}`);
    }
  }

  // ── 5. Dynamic domain enable: berry_tools enable wiki, then re-list. ──────
  if (initialized) {
    try {
      const call = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'berry_tools',
            arguments: { action: 'enable', domain: 'wiki' },
          },
        },
        sessionHeaders,
      );
      if (call.status !== 200) {
        fail.push(`/mcp tools/call berry_tools(enable wiki) → expected 200, got ${call.status}`);
      } else {
        const rpc = await parseRpcBody(call);
        // The tool result rides in result.content[0].text as a JSON string:
        // {"ok":true,"action":"enabled","domain":"wiki"}. An isError result or a
        // missing ok flag is a failure.
        const textPart = rpc?.result?.content?.[0]?.text;
        let okFlag = false;
        try {
          okFlag = textPart ? JSON.parse(textPart)?.ok === true : false;
        } catch {
          okFlag = false;
        }
        if (rpc?.result?.isError || !okFlag) {
          fail.push(`/mcp tools/call berry_tools(enable wiki) → did not return ok:true (got ${textPart ?? '<no content>'})`);
        } else {
          pass.push('/mcp tools/call berry_tools(enable wiki) → ok:true');

          // Re-list on the SAME session — a wiki tool must now appear.
          const relist = await mcpPost(
            { jsonrpc: '2.0', id: 4, method: 'tools/list' },
            sessionHeaders,
          );
          if (relist.status !== 200) {
            fail.push(`/mcp tools/list (after enable) → expected 200, got ${relist.status}`);
          } else {
            const rpc2 = await parseRpcBody(relist);
            const names2 = toolNamesFrom(rpc2);
            if (names2.includes('berry_compile')) {
              pass.push('dynamic domain enable: berry_compile appeared after enabling "wiki" domain');
            } else {
              fail.push(`dynamic domain enable: berry_compile NOT in tools/list after enabling "wiki" (saw ${names2.length} tools)`);
            }
          }
        }
      }
    } catch (err) {
      fail.push(`/mcp tools/call berry_tools errored: ${err?.message || err}`);
    }
  }

  // ── 6. Wiki probe (best-effort unless MEMBERRY_SMOKE_REQUIRE_WIKI). ───────
  try {
    const wiki = await fetchTimed(`${WIKI_BASE}/wiki/_index`, { redirect: 'manual' });
    wiki.body?.cancel?.().catch(() => {});
    if (wiki.status === 200 || wiki.status === 302) {
      pass.push(`wiki probe: ${WIKI_BASE}/wiki/_index → ${wiki.status}`);
    } else if (REQUIRE_WIKI) {
      fail.push(`wiki probe: expected 200/302, got ${wiki.status} at ${WIKI_BASE}/wiki/_index`);
    } else {
      console.log(`[smoke-auth] wiki probe: ${WIKI_BASE}/wiki/_index → ${wiki.status} (not required — reporting only).`);
    }
  } catch (err) {
    if (REQUIRE_WIKI) {
      fail.push(`wiki probe: required but unreachable at ${WIKI_BASE} (${err?.cause?.code || err?.code || err?.name || err?.message})`);
    } else {
      console.log(`[smoke-auth] wiki probe: ${WIKI_BASE} unreachable (${err?.cause?.code || err?.code || err?.name || err?.message}) — not required, skipping.`);
    }
  }

  // ── Verdict ──────────────────────────────────────────────────────────────
  summarize();
  if (fail.length > 0) {
    console.log(`\nFAIL — ${fail.length} check(s) failed, ${pass.length} passed.\n`);
    process.exit(1);
  }
  console.log(`\nPASS — ${pass.length} check(s) passed.\n`);
  process.exit(0);
}

main().catch((err) => {
  // An unexpected (non-reachability) error after we've committed to running:
  // treat as a real failure so CI surfaces it, but print clearly.
  console.error('[smoke-auth] Unexpected error:', err?.stack || err?.message || err);
  process.exit(1);
});
