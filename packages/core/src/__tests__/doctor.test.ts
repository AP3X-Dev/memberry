// packages/core/src/__tests__/doctor.test.ts
//
// Unit tests for `memberry doctor` — a READ-ONLY diagnostic report. The transport
// is MOCKED (global fetch): there is no live server. We assert:
//   - pure helpers: serverBaseUrl, inferEmbedding, parseQueryRows,
//     lintSummaryFromReport, suggestNext
//   - buildReport aggregates every section from the right data source (direct
//     HTTP for /healthz, /readyz, wiki; berry_query for graph counts + projects;
//     client-inferred embedding)
//   - --json emits ONE structured object keyed by section
//   - graceful degradation: with the server unreachable it reports unreachable +
//     suggests `memberry setup`, exits 0, and does NOT throw
//   - the suggested-next logic: no projects → `project setup`; no token → token warning

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  serverBaseUrl,
  inferEmbedding,
  parseQueryRows,
  lintSummaryFromReport,
  suggestNext,
  buildReport,
  renderReport,
  runDoctor,
  type DoctorReport,
} from '../cli/doctor.js';

// ─── Mock-fetch harness ─────────────────────────────────────────────────────────

const SESSION_ID = 'sess-doc-1';

const GRAPH_ROWS = [
  { label: 'Semantic', cnt: 42 },
  { label: 'Entity', cnt: 17 },
  { label: 'Episodic', cnt: 9 },
];

const PROJECT_ROWS = [{ name: 'alpha' }, { name: 'beta' }];

function healthzBody() {
  return {
    status: 'ok',
    service: 'memberry-mcp',
    transport: 'sse',
    active_sessions: 2,
    registered_sessions: 3,
    auth_required: true,
    uptime_ms: 123_456,
  };
}

/** A full lint report exactly as the server's berry_lint handler renders it. */
function lintReportText() {
  return [
    '[ISSUES] orphan_pages (1)',
    '  [WARN] Entity "X" has no semantic knowledge about it',
    '    Suggestion: Add claims',
    '[PASS] broken_links',
    '',
    'Ran 2 checks: 1 passed, 1 with issues (1 total issues)',
    'Total issues: 1',
  ].join('\n');
}

/**
 * fetch mock emulating the MCP handshake + /healthz + /readyz + wiki + tools/call.
 * Options drive degradation: `unreachable` rejects every call (server down);
 * `authFail` 401s the handshake + /readyz; `noProjects`/`noGraph` empty those
 * queries; `wikiDown` 503s the wiki viewer.
 */
function makeFetchMock(opts: {
  unreachable?: boolean;
  authFail?: boolean;
  noProjects?: boolean;
  noGraph?: boolean;
  wikiDown?: boolean;
} = {}) {
  const calls: Array<{ url: string; method?: string; headers: Record<string, string>; body: any }> = [];
  const fn = vi.fn(async (url: string, init?: any): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method: init?.method, headers, body });

    if (opts.unreachable) throw new TypeError('fetch failed');

    // Direct HTTP endpoints.
    if (url.endsWith('/healthz')) {
      return new Response(JSON.stringify(healthzBody()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/readyz')) {
      if (opts.authFail) return new Response('unauthorized', { status: 401 });
      return new Response(JSON.stringify({ status: 'ready' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/wiki/_index')) {
      return new Response(opts.wikiDown ? 'down' : '<html>', { status: opts.wikiDown ? 503 : 200 });
    }

    // MCP /mcp handshake + tools/call.
    const method = body?.method as string | undefined;
    if (method === 'initialize') {
      if (opts.authFail) return new Response('unauthorized', { status: 401 });
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } }),
        { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': SESSION_ID } },
      );
    }
    if (method === 'notifications/initialized') {
      return new Response(null, { status: 202 });
    }
    if (method === 'tools/call') {
      const toolName = body.params?.name as string;
      const args = body.params?.arguments ?? {};
      let resultText: string;
      if (toolName === 'berry_tools') {
        resultText = JSON.stringify({ ok: true, action: 'enabled', domain: args.domain });
      } else if (toolName === 'berry_query') {
        const q = String(args.query ?? '');
        if (q.includes("type:'project'")) {
          resultText = JSON.stringify(opts.noProjects ? [] : PROJECT_ROWS, null, 2);
        } else {
          resultText = JSON.stringify(opts.noGraph ? [] : GRAPH_ROWS, null, 2);
        }
      } else if (toolName === 'berry_lint') {
        resultText = lintReportText();
      } else {
        resultText = 'ok';
      }
      const env = { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: resultText }] } };
      return new Response(JSON.stringify(env), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return { fn, calls };
}

// ─── Pure-helper unit tests ─────────────────────────────────────────────────────

describe('doctor: serverBaseUrl', () => {
  it('strips the /mcp path to the origin', () => {
    expect(serverBaseUrl('http://lan-host:3101/mcp')).toBe('http://lan-host:3101');
    expect(serverBaseUrl('http://localhost:3101/mcp')).toBe('http://localhost:3101');
  });
  it('falls back to a path-stripped value on a bad URL', () => {
    expect(serverBaseUrl('not a url/mcp')).toBe('not a url');
  });
});

describe('doctor: inferEmbedding', () => {
  it('reports openai when OPENAI_API_KEY is set (client-inferred)', () => {
    const e = inferEmbedding({ OPENAI_API_KEY: 'sk-xxx' } as any);
    expect(e.mode).toBe('openai');
    expect(e.source).toBe('client-inferred');
  });
  it('reports zero-vector when the key is absent/blank', () => {
    expect(inferEmbedding({} as any).mode).toBe('zero-vector');
    expect(inferEmbedding({ OPENAI_API_KEY: '  ' } as any).mode).toBe('zero-vector');
  });
});

describe('doctor: parseQueryRows', () => {
  it('parses a JSON array of rows', () => {
    expect(parseQueryRows(JSON.stringify(GRAPH_ROWS))).toEqual(GRAPH_ROWS);
  });
  it('returns [] on non-array / unparseable text', () => {
    expect(parseQueryRows('not json')).toEqual([]);
    expect(parseQueryRows('{"a":1}')).toEqual([]);
  });
});

describe('doctor: lintSummaryFromReport', () => {
  it('extracts the summary line + total issues from a full report', () => {
    const { summary, total_issues } = lintSummaryFromReport(lintReportText());
    expect(summary).toBe('Ran 2 checks: 1 passed, 1 with issues (1 total issues)');
    expect(total_issues).toBe(1);
  });
  it('returns undefineds when the lines are absent', () => {
    expect(lintSummaryFromReport('nothing here')).toEqual({ summary: undefined, total_issues: undefined });
  });
});

describe('doctor: suggestNext', () => {
  const base: Omit<DoctorReport, 'suggested_next'> = {
    mcp_url: 'http://localhost:3101/mcp',
    wiki_url: 'http://localhost:3200',
    health: { available: true, status: 'ok' },
    auth: { available: true, token_present: true, readyz: 'ok' },
    embedding: { source: 'client-inferred', mode: 'zero-vector', detail: '' },
    graph_counts: { available: true, counts: [], total: 0 },
    projects: { available: true, names: ['alpha'], count: 1 },
    wiki: { available: true, url: 'x', up: true },
    lint: { available: true, skipped: true },
  };

  it('suggests `memberry setup` when health is down', () => {
    const s = suggestNext({ ...base, health: { available: false, reason: 'x' } });
    expect(s.join('\n')).toMatch(/memberry setup/);
  });
  it('warns about the token when none resolved', () => {
    const s = suggestNext({ ...base, auth: { available: true, token_present: false, readyz: 'unauthorized' } });
    expect(s.join('\n')).toMatch(/MEMBERRY_API_TOKEN/);
  });
  it('suggests `project setup` when reachable but zero projects', () => {
    const s = suggestNext({ ...base, projects: { available: true, names: [], count: 0 } });
    expect(s.join('\n')).toMatch(/project setup <path>/);
  });
  it('says nothing to do when everything is healthy', () => {
    expect(suggestNext(base).join('\n')).toMatch(/nothing to do/i);
  });
});

// ─── buildReport / runDoctor integration (mocked fetch) ──────────────────────────

describe('doctor: buildReport + runDoctor (mocked transport)', () => {
  const originalFetch = globalThis.fetch;
  const ENV = { ...process.env };
  let logs: string[];
  let logSpy: any;

  beforeEach(() => {
    logs = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { logs.push(a.join(' ')); });
    process.exitCode = 0;
    process.env.MEMBERRY_API_TOKEN = 'tok-env';
    delete process.env.MEMBERRY_MCP_URL;
    delete process.env.MEMBERRY_PUBLIC_HOST;
    delete process.env.MCP_PORT;
    delete process.env.OPENAI_API_KEY;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    logSpy.mockRestore();
    process.exitCode = 0;
    for (const k of ['MEMBERRY_API_TOKEN', 'MEMBERRY_MCP_URL', 'MEMBERRY_PUBLIC_HOST', 'MCP_PORT', 'OPENAI_API_KEY']) {
      if (ENV[k] === undefined) delete process.env[k]; else process.env[k] = ENV[k]!;
    }
    vi.restoreAllMocks();
  });

  it('aggregates every section from its proper data source (healthy server)', async () => {
    const { fn, calls } = makeFetchMock();
    globalThis.fetch = fn as any;

    const report = await buildReport({});

    // MCP health ← direct GET /healthz
    expect(report.health.available).toBe(true);
    expect(report.health.service).toBe('memberry-mcp');
    expect(report.health.transport).toBe('sse');
    expect(report.health.active_sessions).toBe(2);
    expect(report.health.auth_required).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/healthz'))).toBe(true);

    // Token / auth ← direct GET /readyz (200)
    expect(report.auth.token_present).toBe(true);
    expect(report.auth.readyz).toBe('ok');
    expect(calls.some((c) => c.url.endsWith('/readyz'))).toBe(true);

    // Embedding ← client-inferred (no OPENAI_API_KEY in this test env)
    expect(report.embedding.source).toBe('client-inferred');
    expect(report.embedding.mode).toBe('zero-vector');

    // Graph counts ← berry_query (parsed label→count)
    expect(report.graph_counts.available).toBe(true);
    expect(report.graph_counts.total).toBe(42 + 17 + 9);
    expect(report.graph_counts.counts[0]).toEqual({ label: 'Semantic', count: 42 });

    // Indexed projects ← berry_query
    expect(report.projects.available).toBe(true);
    expect(report.projects.names).toEqual(['alpha', 'beta']);

    // Wiki ← direct GET :3200/wiki/_index
    expect(report.wiki.available).toBe(true);
    expect(report.wiki.up).toBe(true);
    expect(report.wiki.url).toBe('http://localhost:3200/wiki/_index');

    // Lint ← berry_lint (summary only) for the first project
    expect(report.lint.available).toBe(true);
    expect(report.lint.skipped).toBeFalsy();
    expect(report.lint.project).toBe('alpha');
    expect(report.lint.total_issues).toBe(1);

    // berry_query went through the admin domain (berry_tools enable admin first).
    const enables = calls
      .filter((c) => c.body?.params?.name === 'berry_tools')
      .map((c) => c.body.params.arguments.domain);
    expect(enables).toContain('admin');

    // The graph-count query is the all-nodes label aggregation.
    const queries = calls
      .filter((c) => c.body?.params?.name === 'berry_query')
      .map((c) => c.body.params.arguments.query as string);
    expect(queries.some((q) => /MATCH \(n\) RETURN labels\(n\)/.test(q))).toBe(true);
    expect(queries.some((q) => q.includes("type:'project'"))).toBe(true);

    // Healthy + projects present → nothing to do.
    expect(report.suggested_next.join('\n')).toMatch(/nothing to do/i);
  });

  it('--json emits ONE structured object keyed by section, exit 0', async () => {
    const { fn } = makeFetchMock();
    globalThis.fetch = fn as any;

    await runDoctor({ json: true });

    expect(process.exitCode).toBe(0);
    const parsed = JSON.parse(logs.join('\n'));
    // Every section is a top-level key.
    for (const key of [
      'mcp_url', 'wiki_url', 'health', 'auth', 'embedding',
      'graph_counts', 'projects', 'wiki', 'lint', 'suggested_next',
    ]) {
      expect(parsed).toHaveProperty(key);
    }
    expect(parsed.health.service).toBe('memberry-mcp');
    expect(parsed.projects.names).toEqual(['alpha', 'beta']);
    expect(Array.isArray(parsed.suggested_next)).toBe(true);
  });

  it('degrades gracefully when the server is unreachable: reports DOWN, suggests setup, exits 0, no throw', async () => {
    const { fn } = makeFetchMock({ unreachable: true });
    globalThis.fetch = fn as any;

    // Must not throw.
    await expect(runDoctor({})).resolves.toBeUndefined();
    expect(process.exitCode).toBe(0);

    const out = logs.join('\n');
    expect(out).toMatch(/MCP health.*unavailable/s);
    expect(out).toMatch(/Wiki viewer.*unreachable/s);
    expect(out).toMatch(/Graph counts.*unavailable/s);
    expect(out).toMatch(/memberry setup/);
  });

  it('reports the unreachable report shape via buildReport (sections marked unavailable)', async () => {
    const { fn } = makeFetchMock({ unreachable: true });
    globalThis.fetch = fn as any;

    const report = await buildReport({});
    expect(report.health.available).toBe(false);
    expect(report.wiki.available).toBe(false);
    expect(report.graph_counts.available).toBe(false);
    expect(report.projects.available).toBe(false);
    expect(report.suggested_next.join('\n')).toMatch(/memberry setup/);
  });

  it('suggests `project setup` when the server is up but has no indexed projects', async () => {
    const { fn } = makeFetchMock({ noProjects: true });
    globalThis.fetch = fn as any;

    const report = await buildReport({});
    expect(report.health.available).toBe(true);
    expect(report.projects.available).toBe(true);
    expect(report.projects.count).toBe(0);
    expect(report.suggested_next.join('\n')).toMatch(/project setup <path>/);
    // Lint is skipped (no project to lint).
    expect(report.lint.skipped).toBe(true);
  });

  it('warns about the token and skips MCP sections when no token resolves (still exit 0)', async () => {
    delete process.env.MEMBERRY_API_TOKEN;
    const { fn, calls } = makeFetchMock();
    globalThis.fetch = fn as any;

    const report = await buildReport({});

    // No token → /readyz not even attempted; auth marked unauthorized.
    expect(report.auth.token_present).toBe(false);
    expect(calls.some((c) => c.url.endsWith('/readyz'))).toBe(false);
    // MCP-derived sections unavailable (no session without a token).
    expect(report.graph_counts.available).toBe(false);
    expect(report.projects.available).toBe(false);
    // But /healthz (unauthenticated) still ran.
    expect(report.health.available).toBe(true);
    expect(report.suggested_next.join('\n')).toMatch(/MEMBERRY_API_TOKEN/);

    // runDoctor still exits 0.
    await runDoctor({});
    expect(process.exitCode).toBe(0);
  });

  it('marks auth unauthorized and skips graph sections on a 401 handshake (exit 0)', async () => {
    const { fn } = makeFetchMock({ authFail: true });
    globalThis.fetch = fn as any;

    const report = await buildReport({});
    expect(report.auth.readyz).toBe('unauthorized');
    // The MCP handshake 401s → graph sections unavailable, but no throw.
    expect(report.graph_counts.available).toBe(false);
    // /healthz is unauthenticated so it still reports.
    expect(report.health.available).toBe(true);

    await expect(runDoctor({})).resolves.toBeUndefined();
    expect(process.exitCode).toBe(0);
  });

  it('renderReport produces a human report containing the section headers', async () => {
    const { fn } = makeFetchMock();
    globalThis.fetch = fn as any;
    const report = await buildReport({});
    const text = renderReport(report);
    expect(text).toContain('MCP health');
    expect(text).toContain('Token / auth');
    expect(text).toContain('Embedding mode');
    expect(text).toContain('Graph counts');
    expect(text).toContain('Indexed projects');
    expect(text).toContain('Wiki viewer');
    expect(text).toContain('Suggested next');
  });
});
