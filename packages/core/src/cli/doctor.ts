// packages/core/src/cli/doctor.ts
//
// `memberry doctor` — diagnose a MemBerry install: a READ-ONLY status report.
// It aggregates, best-effort, what is knowable about a running server WITHOUT
// changing anything:
//   - MCP health      (GET /healthz — unauthenticated liveness)
//   - Token / auth     (GET /readyz — auth-gated: 200 ok vs 401 invalid/missing)
//   - Embedding mode    (server doesn't expose it → client-inferred from the CLI
//                        env's OPENAI_API_KEY, LABELED as such)
//   - Graph counts      (berry_query over /mcp — admin domain, read-only Cypher)
//   - Indexed projects  (berry_query — project Entity nodes)
//   - Wiki status       (GET http://<host>:3200/wiki/_index — viewer up/down)
//   - Lint              (optional: berry_lint for a project, summary only)
//   - Suggested next     (no project / unreachable / no token → a concrete command)
//
// ARCHITECTURE: like cli/project.ts, doctor is a thin AUTHENTICATED MCP CLIENT
// driving a RUNNING server over /mcp. The server-side work (graph counts, project
// list, lint) goes through MCP tools; pure liveness/readiness/wiki checks are
// direct HTTP. @memberry/core CANNOT import @memberry/wiki or @memberry/mcp (they
// depend on core — a cycle), so the lint report is rendered SERVER-SIDE by the
// berry_lint handler (which already calls formatLintReport) and we reduce it to a
// summary locally rather than importing the formatter. (See cli/mcp-client.ts.)
//
// EXIT POLICY: doctor DIAGNOSES. It exits 0 whenever it produced a report — even
// with everything down (it prints the findings + 'server unreachable' + suggests
// `memberry setup`). A non-zero exit is reserved for doctor failing to run at all
// (a thrown bug), which bubbles up to the CLI's top-level catch.

import { resolveUrl, resolveToken } from './configure.js';
import { wikiBaseUrl } from './project.js';
import {
  mcpInitialize,
  mcpCall,
  mcpEnableDomain,
  toolCallText,
  McpClientError,
  type McpSession,
} from './mcp-client.js';

type Flags = Record<string, string | boolean>;

// ─── Section result types ───────────────────────────────────────────────────────
//
// Every section is best-effort: a failing section reports `available: false` with
// a `reason`, and NEVER aborts the whole report. The aggregated `DoctorReport` is
// the single source of truth for both the human render and the --json output.

interface HealthSection {
  available: boolean;
  reason?: string;
  status?: string;
  service?: string;
  transport?: string;
  active_sessions?: number;
  registered_sessions?: number;
  auth_required?: boolean;
  uptime_ms?: number;
}

interface AuthSection {
  available: boolean;
  reason?: string;
  /** Did a token resolve from --token / MEMBERRY_API_TOKEN at all? */
  token_present: boolean;
  /** 'ok' (200 /readyz), 'unauthorized' (401), 'unknown' (couldn't check). */
  readyz: 'ok' | 'unauthorized' | 'unknown';
}

interface EmbeddingSection {
  /** Always client-inferred: the server does not expose embedding mode. */
  source: 'client-inferred';
  mode: 'openai' | 'zero-vector';
  detail: string;
}

interface GraphCountsSection {
  available: boolean;
  reason?: string;
  /** label → node count, descending by count. */
  counts: Array<{ label: string; count: number }>;
  total: number;
}

interface ProjectsSection {
  available: boolean;
  reason?: string;
  names: string[];
  count: number;
}

interface WikiSection {
  available: boolean;
  reason?: string;
  url: string;
  up: boolean;
  http_status?: number;
}

interface LintSection {
  available: boolean;
  reason?: string;
  skipped?: boolean;
  project?: string;
  summary?: string;
  total_issues?: number;
}

export interface DoctorReport {
  mcp_url: string;
  wiki_url: string;
  health: HealthSection;
  auth: AuthSection;
  embedding: EmbeddingSection;
  graph_counts: GraphCountsSection;
  projects: ProjectsSection;
  wiki: WikiSection;
  lint: LintSection;
  suggested_next: string[];
}

// ─── HTTP helpers (direct, no MCP) ──────────────────────────────────────────────

/**
 * Strip the `/mcp` (or any) path off the MCP URL to get the server ORIGIN that
 * /healthz and /readyz live on. Falls back to the raw URL on a parse failure so a
 * best-effort GET can still be attempted (and fail into a reason).
 */
export function serverBaseUrl(mcpUrl: string): string {
  try {
    const u = new URL(mcpUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return mcpUrl.replace(/\/mcp\/?$/, '');
  }
}

/** GET a JSON endpoint with an optional bearer token. Never throws — returns a tag. */
async function getJson(
  url: string,
  token?: string,
): Promise<{ ok: boolean; status: number; body?: unknown; error?: string }> {
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, { method: 'GET', headers });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Section builders (each best-effort, never throws) ──────────────────────────

/** MCP health via the unauthenticated GET /healthz liveness endpoint. */
async function checkHealth(baseUrl: string): Promise<HealthSection> {
  const res = await getJson(`${baseUrl}/healthz`);
  if (!res.ok || typeof res.body !== 'object' || res.body === null) {
    return {
      available: false,
      reason: res.error ?? `GET /healthz returned HTTP ${res.status}`,
    };
  }
  const b = res.body as Record<string, unknown>;
  return {
    available: true,
    status: typeof b.status === 'string' ? b.status : undefined,
    service: typeof b.service === 'string' ? b.service : undefined,
    transport: typeof b.transport === 'string' ? b.transport : undefined,
    active_sessions: typeof b.active_sessions === 'number' ? b.active_sessions : undefined,
    registered_sessions: typeof b.registered_sessions === 'number' ? b.registered_sessions : undefined,
    auth_required: typeof b.auth_required === 'boolean' ? b.auth_required : undefined,
    uptime_ms: typeof b.uptime_ms === 'number' ? b.uptime_ms : undefined,
  };
}

/**
 * Token / auth via the auth-gated GET /readyz: 200 means the presented token is
 * accepted; 401 means invalid or missing. If no token resolved we don't bother
 * the server (the auth answer is already "no token to present").
 */
async function checkAuth(baseUrl: string, token: string | undefined): Promise<AuthSection> {
  const tokenPresent = Boolean(token);
  if (!tokenPresent) {
    return { available: true, token_present: false, readyz: 'unauthorized' };
  }
  const res = await getJson(`${baseUrl}/readyz`, token);
  if (res.error !== undefined || res.status === 0) {
    return {
      available: false,
      reason: res.error ?? 'could not reach /readyz',
      token_present: true,
      readyz: 'unknown',
    };
  }
  if (res.status === 401 || res.status === 403) {
    return { available: true, token_present: true, readyz: 'unauthorized' };
  }
  if (res.ok) {
    return { available: true, token_present: true, readyz: 'ok' };
  }
  return {
    available: false,
    reason: `GET /readyz returned HTTP ${res.status}`,
    token_present: true,
    readyz: 'unknown',
  };
}

/**
 * Embedding mode. The server does NOT expose this over /healthz or /readyz, so
 * the only honest signal from the CLI is whether OPENAI_API_KEY is set in THIS
 * process's env — which mirrors how the server itself decides (see
 * config/status.ts). LABELED client-inferred so the caller knows it describes the
 * CLI's environment, which may differ from the server's.
 */
export function inferEmbedding(env: NodeJS.ProcessEnv = process.env): EmbeddingSection {
  const hasKey = (env['OPENAI_API_KEY'] ?? '').trim() !== '';
  return {
    source: 'client-inferred',
    mode: hasKey ? 'openai' : 'zero-vector',
    detail: hasKey
      ? 'OPENAI_API_KEY present in CLI env → OpenAI embeddings (server may differ; not exposed by the server)'
      : 'OPENAI_API_KEY absent in CLI env → lexical-only / zero-vector (server may differ; not exposed by the server)',
  };
}

/**
 * Parse the JSON rows berry_query returns. The handler returns
 * `textContent(JSON.stringify(rows, null, 2))`, so the tool text IS a JSON array.
 * Returns [] on anything unparseable (best-effort).
 */
export function parseQueryRows(text: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

/** Coerce a Neo4j count (may arrive as a number or a {low,high}/toNumber int). */
function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object') {
    const o = v as { toNumber?: () => number; low?: number };
    if (typeof o.toNumber === 'function') return o.toNumber();
    if (typeof o.low === 'number') return o.low;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Graph counts via berry_query: label → count over all nodes, descending. */
async function checkGraphCounts(session: McpSession): Promise<GraphCountsSection> {
  try {
    const result = await mcpCall(session, 'berry_query', {
      query: 'MATCH (n) RETURN labels(n)[0] AS label, count(n) AS cnt ORDER BY cnt DESC',
      limit: 100,
    });
    const rows = parseQueryRows(toolCallText(result));
    const counts = rows
      .map((r) => ({ label: String(r.label ?? '(unlabeled)'), count: toNumber(r.cnt) }))
      .filter((c) => c.count > 0);
    const total = counts.reduce((sum, c) => sum + c.count, 0);
    return { available: true, counts, total };
  } catch (err) {
    return {
      available: false,
      reason: err instanceof Error ? err.message : String(err),
      counts: [],
      total: 0,
    };
  }
}

/** Indexed projects via berry_query: project-type Entity nodes by name. */
async function checkProjects(session: McpSession): Promise<ProjectsSection> {
  try {
    const result = await mcpCall(session, 'berry_query', {
      query: "MATCH (e:Entity {type:'project'}) RETURN e.name AS name ORDER BY name",
      limit: 100,
    });
    const rows = parseQueryRows(toolCallText(result));
    const names = rows
      .map((r) => (typeof r.name === 'string' ? r.name : String(r.name ?? '')))
      .filter(Boolean);
    return { available: true, names, count: names.length };
  } catch (err) {
    return {
      available: false,
      reason: err instanceof Error ? err.message : String(err),
      names: [],
      count: 0,
    };
  }
}

/** Wiki viewer status via GET <host>:3200/wiki/_index. */
async function checkWiki(wikiUrl: string): Promise<WikiSection> {
  const target = `${wikiUrl}/wiki/_index`;
  try {
    const res = await fetch(target, { method: 'GET' });
    return { available: true, url: target, up: res.ok, http_status: res.status };
  } catch (err) {
    return {
      available: false,
      reason: err instanceof Error ? err.message : String(err),
      url: target,
      up: false,
    };
  }
}

/**
 * Reduce the server-rendered berry_lint report to its summary lines. The handler
 * returns `formatLintReport(result)` (full detail); its tail is always the
 * one-line `summary` followed by `Total issues: N` — which is exactly what
 * `formatLintReport(result, { summaryOnly: true })` would have produced. We
 * extract those two lines here instead of importing @memberry/wiki (a dependency
 * cycle core forbids — see the module header).
 */
export function lintSummaryFromReport(report: string): { summary?: string; total_issues?: number } {
  const lines = report.split('\n').map((l) => l.trimEnd());
  let total_issues: number | undefined;
  let summary: string | undefined;
  for (const line of lines) {
    const m = /^Total issues:\s*(\d+)/.exec(line);
    if (m) total_issues = Number(m[1]);
    else if (/^Ran \d+ checks?:/.test(line)) summary = line;
  }
  return { summary, total_issues };
}

/**
 * Lint a project (best-effort, optional). Only runs when a project exists AND the
 * wiki/graph is reachable enough to have produced a session. Skips with a note
 * otherwise. Renders summary only.
 */
async function checkLint(
  session: McpSession,
  projects: ProjectsSection,
  wiki: WikiSection,
): Promise<LintSection> {
  if (projects.count === 0) {
    return { available: true, skipped: true, reason: 'no indexed project to lint' };
  }
  if (!wiki.up) {
    return { available: true, skipped: true, reason: 'wiki viewer unreachable — skipping lint' };
  }
  const project = projects.names[0];
  try {
    await mcpEnableDomain(session, 'wiki');
    const result = await mcpCall(session, 'berry_lint', { project_tag: `project:${project}` });
    const { summary, total_issues } = lintSummaryFromReport(toolCallText(result));
    return { available: true, project, summary, total_issues };
  } catch (err) {
    return {
      available: false,
      reason: err instanceof Error ? err.message : String(err),
      project,
    };
  }
}

/** Decide concrete next-command suggestions from the assembled sections. */
export function suggestNext(report: Omit<DoctorReport, 'suggested_next'>): string[] {
  const out: string[] = [];

  // Unreachable / down server → stand up the stack.
  if (!report.health.available) {
    out.push('Server unreachable — run `memberry setup` to stand up the stack.');
  }

  // No token resolved → warn (separate from health: the server may be up).
  if (!report.auth.token_present) {
    out.push('No API token — set MEMBERRY_API_TOKEN (or pass --token) so authenticated checks can run.');
  } else if (report.auth.readyz === 'unauthorized') {
    out.push('Token rejected by /readyz — check MEMBERRY_API_TOKEN matches the server.');
  }

  // Reachable server but no indexed project → set one up.
  if (report.health.available && report.projects.available && report.projects.count === 0) {
    out.push('No indexed project — run `memberry project setup <path> --project-name <name>`.');
  }

  if (out.length === 0) {
    out.push('All checks passed — nothing to do.');
  }
  return out;
}

// ─── Aggregation ────────────────────────────────────────────────────────────────

/**
 * Build the full doctor report. Each section is best-effort and isolated, so one
 * failure (e.g. the server is down) degrades only that section — the rest still
 * report. Returns the aggregated object; rendering/exit is the caller's job.
 */
export async function buildReport(flags: Flags): Promise<DoctorReport> {
  const mcpUrl = resolveUrl(flags);
  const token = resolveToken(flags);
  const baseUrl = serverBaseUrl(mcpUrl);
  const wikiUrl = wikiBaseUrl(mcpUrl);

  // Direct-HTTP sections (no MCP session needed) — run together.
  const [health, auth, wiki] = await Promise.all([
    checkHealth(baseUrl),
    checkAuth(baseUrl, token),
    checkWiki(wikiUrl),
  ]);
  const embedding = inferEmbedding();

  // MCP-client sections need a session. If we can't open one (no token /
  // unreachable / auth fail), mark the graph-derived sections unavailable with the
  // reason and skip lint — never throw.
  let graph_counts: GraphCountsSection;
  let projects: ProjectsSection;
  let lint: LintSection;

  let session: McpSession | undefined;
  let sessionReason: string | undefined;
  if (!token) {
    sessionReason = 'no API token resolved (pass --token or set MEMBERRY_API_TOKEN)';
  } else {
    try {
      session = await mcpInitialize(mcpUrl, token);
      await mcpEnableDomain(session, 'admin');
    } catch (err) {
      session = undefined;
      sessionReason =
        err instanceof McpClientError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
    }
  }

  if (session) {
    [graph_counts, projects] = await Promise.all([
      checkGraphCounts(session),
      checkProjects(session),
    ]);
    lint = await checkLint(session, projects, wiki);
  } else {
    graph_counts = { available: false, reason: sessionReason, counts: [], total: 0 };
    projects = { available: false, reason: sessionReason, names: [], count: 0 };
    lint = { available: true, skipped: true, reason: 'no MCP session — skipping lint' };
  }

  const partial: Omit<DoctorReport, 'suggested_next'> = {
    mcp_url: mcpUrl,
    wiki_url: wikiUrl,
    health,
    auth,
    embedding,
    graph_counts,
    projects,
    wiki,
    lint,
  };

  return { ...partial, suggested_next: suggestNext(partial) };
}

// ─── Rendering ──────────────────────────────────────────────────────────────────

function ok(b: boolean): string {
  return b ? 'OK' : 'DOWN';
}

/** Render the aggregated report as a human-readable status report. */
export function renderReport(report: DoctorReport): string {
  const L: string[] = [];
  L.push('MemBerry Doctor');
  L.push(`  MCP URL:  ${report.mcp_url}`);
  L.push(`  Wiki URL: ${report.wiki_url}`);
  L.push('');

  // MCP health
  const h = report.health;
  if (h.available) {
    L.push(`[${ok(h.status === 'ok')}] MCP health (GET /healthz)`);
    L.push(`     service=${h.service ?? '?'} transport=${h.transport ?? '?'} status=${h.status ?? '?'}`);
    L.push(
      `     sessions: ${h.active_sessions ?? 0} active / ${h.registered_sessions ?? 0} registered` +
        `   auth_required=${h.auth_required ?? '?'}` +
        (h.uptime_ms !== undefined ? `   uptime=${Math.round(h.uptime_ms / 1000)}s` : ''),
    );
  } else {
    L.push('[DOWN] MCP health (GET /healthz) — unavailable');
    L.push(`     reason: ${h.reason ?? 'unknown'}`);
  }
  L.push('');

  // Token / auth
  const a = report.auth;
  if (!a.token_present) {
    L.push('[WARN] Token / auth — no token resolved (set MEMBERRY_API_TOKEN or pass --token)');
  } else if (a.readyz === 'ok') {
    L.push('[OK]   Token / auth (GET /readyz) — token accepted (200)');
  } else if (a.readyz === 'unauthorized') {
    L.push('[DOWN] Token / auth (GET /readyz) — invalid/missing token (401)');
  } else {
    L.push('[DOWN] Token / auth (GET /readyz) — could not verify');
    if (a.reason) L.push(`     reason: ${a.reason}`);
  }
  L.push('');

  // Embedding mode (client-inferred)
  const e = report.embedding;
  L.push(`[INFO] Embedding mode: ${e.mode}  (${e.source})`);
  L.push(`     ${e.detail}`);
  L.push('');

  // Graph counts
  const g = report.graph_counts;
  if (g.available) {
    L.push(`[OK]   Graph counts (berry_query) — ${g.total} node(s) total`);
    if (g.counts.length === 0) {
      L.push('     (graph is empty)');
    } else {
      for (const c of g.counts) L.push(`     ${c.label.padEnd(14)} ${c.count}`);
    }
  } else {
    L.push('[DOWN] Graph counts (berry_query) — unavailable');
    L.push(`     reason: ${g.reason ?? 'unknown'}`);
  }
  L.push('');

  // Indexed projects
  const p = report.projects;
  if (p.available) {
    L.push(`[${ok(p.count > 0)}] Indexed projects (berry_query) — ${p.count} found`);
    for (const name of p.names) L.push(`     - ${name}`);
  } else {
    L.push('[DOWN] Indexed projects (berry_query) — unavailable');
    L.push(`     reason: ${p.reason ?? 'unknown'}`);
  }
  L.push('');

  // Wiki status
  const w = report.wiki;
  if (w.available) {
    L.push(`[${ok(w.up)}] Wiki viewer (GET ${w.url}) — ${w.up ? 'up' : `HTTP ${w.http_status}`}`);
  } else {
    L.push(`[DOWN] Wiki viewer (GET ${w.url}) — unreachable`);
    L.push(`     reason: ${w.reason ?? 'unknown'}`);
  }
  L.push('');

  // Lint (optional)
  const lt = report.lint;
  if (lt.skipped) {
    L.push(`[SKIP] Lint — ${lt.reason ?? 'skipped'}`);
  } else if (lt.available) {
    L.push(`[OK]   Lint (berry_lint, project:${lt.project}) — summary`);
    if (lt.summary) L.push(`     ${lt.summary}`);
    L.push(`     Total issues: ${lt.total_issues ?? 0}`);
  } else {
    L.push('[DOWN] Lint (berry_lint) — unavailable');
    L.push(`     reason: ${lt.reason ?? 'unknown'}`);
  }
  L.push('');

  // Suggested next
  L.push('Suggested next:');
  for (const s of report.suggested_next) L.push(`  • ${s}`);

  return L.join('\n');
}

function printDoctorUsage(): void {
  console.log('Usage: memberry doctor [options]');
  console.log('');
  console.log('Diagnose a running MemBerry install (read-only status report).');
  console.log('Checks: MCP /healthz, token /readyz, embedding mode, graph counts,');
  console.log('indexed projects, wiki viewer, and (optionally) a lint summary.');
  console.log('');
  console.log('Options:');
  console.log('  --url URL    MCP URL (else $MEMBERRY_MCP_URL, else http://$MEMBERRY_PUBLIC_HOST:$MCP_PORT/mcp)');
  console.log('  --token TOK  bearer token (else $MEMBERRY_API_TOKEN)');
  console.log('  --json       emit the aggregated status as one JSON object');
  console.log('  --help       show this message');
}

/**
 * Entry. `flags` are the parsed `--name [value]` options. doctor DIAGNOSES, so it
 * always exits 0 once it produced a report (even with everything down) — the only
 * non-zero path is an unexpected throw, which the CLI's top-level catch handles.
 */
export async function runDoctor(flags: Flags): Promise<void> {
  if (flags['help'] === true) {
    printDoctorUsage();
    return;
  }

  const report = await buildReport(flags);

  if (flags['json'] === true) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(renderReport(report));
}
