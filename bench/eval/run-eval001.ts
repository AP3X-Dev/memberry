#!/usr/bin/env tsx
// bench/eval/run-eval001.ts
//
// EVAL-001 — real-query retrieval evaluation against the LIVE index.
// Spec: docs/agent-runs/specs/2026-08-26-eval001-real-query-evaluation.md
//
// This runner calls the SAME production path a user hits: berry_context over MCP,
// with the scopes recorded on each question. There is no lab adapter and no
// re-ranking in bench code — a bench re-composition of the pipeline would measure
// something other than what ships (spec §5.2).
//
// It measures keywordRecall@{5,10} (§2.1) and noiseRate@{5,10} (§2.2) over the code
// items parsed out of the rendered markdown with the PINNED grammar of §2.2.1.
// The grammar is exported and pinned by __tests__/render-grammar.test.ts against both
// live render sites; if a render changes, that test goes red and the metric is
// known-invalid rather than quietly wrong.
//
// Run:  MEMBERRY_API_TOKEN=... npx tsx bench/eval/run-eval001.ts
//       ... --split=dev        (default: every non-blocked split present)

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const QUESTIONS_PATH = join(HERE, 'eval001-questions.jsonl');
const REPO_ROOT = join(HERE, '..', '..');
const DEFAULT_MCP_URL = 'http://192.168.0.25:3101/mcp';
const MCP_PROTOCOL_VERSION = '2025-03-26';
const REQUEST_TIMEOUT_MS = 60_000;

// ─── The pinned extraction grammar (spec §2.2.1) ─────────────────────────────
// Each code item renders as exactly:
//   **<name>** (<kind>) — `<file_path>:<line>`
//   `<signature>`
//   > <doc_comment first line>        ← only when a doc comment exists
// Note the EM DASH, not a hyphen. `packages/code/src/search.ts:284` renders a
// different shape for a different tool (berry_code_search) and must NOT match.
export const CODE_ITEM_GRAMMAR = /^\*\*(?<name>.+?)\*\* \((?<kind>[a-z]+)\) — `(?<path>[^:`]+):(?<line>\d+)`/;

export interface CodeItem {
  readonly name: string;
  readonly kind: string;
  readonly path: string;
  readonly line: number;
  readonly hasDocComment: boolean;
  /** The whole item block (header + signature + doc line), used for keyword matching. */
  readonly block: string;
}

/** Parse the code items out of a berry_context markdown response, in rendered order. */
export function parseCodeItems(markdown: string): CodeItem[] {
  const lines = markdown.split('\n');
  const items: CodeItem[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = CODE_ITEM_GRAMMAR.exec(lines[i]!);
    if (!match?.groups) continue;
    // renderMarkdown separates items with a blank line and an `<!-- id -->` comment,
    // so the block ends at the first blank line, comment, or next item header.
    const block = [lines[i]!];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (line.trim() === '' || line.startsWith('<!--') || CODE_ITEM_GRAMMAR.test(line)) break;
      block.push(line);
    }
    items.push({
      name: match.groups['name']!,
      kind: match.groups['kind']!,
      path: match.groups['path']!,
      line: Number(match.groups['line']),
      hasDocComment: block.some((line) => line.startsWith('> ')),
      block: block.join('\n'),
    });
  }
  return items;
}

export function isTestFileItem(path: string): boolean {
  return path.includes('__tests__') || path.includes('.test.');
}

export function isNoiseItem(item: CodeItem): boolean {
  return isTestFileItem(item.path) || (item.kind === 'variable' && !item.hasDocComment);
}

export function keywordPresent(kw: string, match: 'exact' | 'substring', haystack: string): boolean {
  if (match === 'exact') {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`).test(haystack);
  }
  return haystack.toLowerCase().includes(kw.toLowerCase());
}

// ─── Question set ────────────────────────────────────────────────────────────

interface Keyword { readonly kw: string; readonly match: 'exact' | 'substring' }

interface Question {
  readonly id: string;
  readonly split: string;
  readonly question: string;
  readonly projectScope: string;
  readonly entityScope: readonly string[];
  readonly requiredKeywords: readonly Keyword[];
  readonly forbiddenKeywords?: readonly Keyword[];
  readonly sourceOfTruth: string;
  readonly blocked?: string;
}

/** §5.1: refuses the whole run if any question is unsourced or has no keywords. */
export function loadQuestions(raw: string): Question[] {
  const questions = raw.split('\n').filter((line) => line.trim() !== '')
    .map((line, index) => {
      try { return JSON.parse(line) as Question; }
      catch { throw new Error(`EVAL001: question line ${index + 1} is not valid JSON`); }
    });
  for (const q of questions) {
    if (typeof q.sourceOfTruth !== 'string' || q.sourceOfTruth.trim() === '') {
      throw new Error(`EVAL001: question ${q.id} has no sourceOfTruth; a guessed keyword is not evidence`);
    }
    if (!Array.isArray(q.requiredKeywords) || q.requiredKeywords.length === 0) {
      throw new Error(`EVAL001: question ${q.id} has no requiredKeywords`);
    }
    if (q.split === 'blocked' && (typeof q.blocked !== 'string' || q.blocked.trim() === '')) {
      throw new Error(`EVAL001: question ${q.id} is split=blocked without a blocked reason`);
    }
  }
  return questions;
}

// ─── MCP transport ───────────────────────────────────────────────────────────

type JsonRecord = Record<string, unknown>;

function parseEnvelope(contentType: string, raw: string): JsonRecord | undefined {
  if (!raw.trim()) return undefined;
  let json = raw;
  if (contentType.toLowerCase().includes('text/event-stream')) {
    const events = raw.split(/\r?\n\r?\n/).flatMap((event) => {
      const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart()).join('\n').trim();
      return data ? [data] : [];
    });
    if (events.length !== 1) throw new Error('EVAL001: malformed MCP event stream');
    json = events[0]!;
  }
  return JSON.parse(json) as JsonRecord;
}

class McpClient {
  private sessionId: string | undefined;
  private nextId = 1;

  constructor(private readonly url: string, private readonly token: string) {}

  private async request(body: JsonRecord, withSession = true): Promise<JsonRecord | undefined> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    if (withSession && this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
      headers['mcp-protocol-version'] = MCP_PROTOCOL_VERSION;
    }
    const response = await fetch(this.url, {
      method: 'POST', headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`EVAL001: MCP HTTP ${response.status}: ${raw.slice(0, 512)}`);
    const session = response.headers.get('mcp-session-id');
    if (session) this.sessionId = session;
    return parseEnvelope(response.headers.get('content-type') ?? '', raw);
  }

  private async initialize(): Promise<void> {
    if (this.sessionId) return;
    await this.request({
      jsonrpc: '2.0', id: this.nextId++, method: 'initialize', params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'memberry-eval001', version: '1.0.0' },
      },
    }, false);
    if (!this.sessionId) throw new Error('EVAL001: MCP initialize returned no session');
    await this.request({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  /** Returns the raw tool result, or the JSON-RPC error, as a JSON string for inspection. */
  async callTool(name: string, args: JsonRecord): Promise<{ ok: boolean; payload: string }> {
    await this.initialize();
    const envelope = await this.request({
      jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name, arguments: args },
    });
    if (!envelope) throw new Error('EVAL001: empty MCP tool response');
    if (envelope['error'] !== undefined) return { ok: false, payload: JSON.stringify(envelope['error']) };
    const result = envelope['result'] as JsonRecord | undefined;
    if (!result) throw new Error('EVAL001: MCP tool response carried neither result nor error');
    const text = Array.isArray(result['content'])
      ? result['content'].filter((block): block is { type: 'text'; text: string } =>
        typeof block === 'object' && block !== null && (block as JsonRecord)['type'] === 'text'
        && typeof (block as JsonRecord)['text'] === 'string')
        .map((block) => block.text).join('\n')
      : '';
    return { ok: result['isError'] !== true, payload: text };
  }
}

// ─── §5.1 The planner trap ───────────────────────────────────────────────────
// invalid_request and resolution_failed are CONFIG errors, not retrieval failures.
// A runner that scored them zero would report a catastrophic regression that is
// really a missing/unresolvable entity_scope. They are reported separately and
// excluded from every metric.
const PLANNER_ERROR = /runtime_query_planner:(invalid_request|resolution_failed)/;

export function plannerErrorCode(payload: string): string | undefined {
  return PLANNER_ERROR.exec(payload)?.[1];
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

interface QuestionResult {
  readonly id: string;
  readonly split: string;
  readonly recall: Record<5 | 10, number>;
  readonly missing: Record<5 | 10, string[]>;
  readonly noise: Record<5 | 10, number>;
  readonly forbiddenHits: string[];
}

export function scoreQuestion(q: Question, items: readonly CodeItem[]): QuestionResult {
  const recall = {} as Record<5 | 10, number>;
  const missing = {} as Record<5 | 10, string[]>;
  const noise = {} as Record<5 | 10, number>;
  for (const k of [5, 10] as const) {
    const topK = items.slice(0, k);
    const haystack = topK.map((item) => item.block).join('\n');
    const absent = q.requiredKeywords.filter((entry) => !keywordPresent(entry.kw, entry.match, haystack));
    recall[k] = (q.requiredKeywords.length - absent.length) / q.requiredKeywords.length;
    missing[k] = absent.map((entry) => entry.kw);
    // Denominator is k, per spec §2.2 — a short result is not a clean one.
    noise[k] = topK.filter(isNoiseItem).length / k;
  }
  const top10 = items.slice(0, 10).map((item) => item.block).join('\n');
  return {
    id: q.id,
    split: q.split,
    recall,
    missing,
    noise,
    forbiddenHits: (q.forbiddenKeywords ?? [])
      .filter((entry) => keywordPresent(entry.kw, entry.match, top10)).map((entry) => entry.kw),
  };
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function gitSha(): string {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const token = process.env['MEMBERRY_API_TOKEN']?.trim();
  if (!token) throw new Error('EVAL001: MEMBERRY_API_TOKEN is required to call the live MCP endpoint');
  const url = process.env['EVAL001_MCP_URL']?.trim() || DEFAULT_MCP_URL;
  const splitFilter = process.argv.find((arg) => arg.startsWith('--split='))?.slice('--split='.length);
  const questions = loadQuestions(readFileSync(QUESTIONS_PATH, 'utf8'));
  const client = new McpClient(url, token);

  // §5.1 flag dependency: the error separation below only fires while the candidate
  // channel is on, so the flag state is recorded with every result. A change to it
  // invalidates cross-run comparison until a fresh baseline is taken. The server is
  // remote, so this is the DECLARED state — set EVAL001_CANDIDATE_CHANNEL to what the
  // server actually runs.
  const flagState = process.env['EVAL001_CANDIDATE_CHANNEL']?.trim()
    ?? process.env['MEMBERRY_CANDIDATE_CHANNEL_V1']?.trim() ?? 'undeclared';
  console.log(`EVAL001 run gitSha=${gitSha()} at=${new Date().toISOString()} mcp=${url} candidateChannelV1=${flagState}`);

  const results: QuestionResult[] = [];
  for (const q of questions) {
    if (q.split === 'blocked') {
      console.log(`EVAL001 skipped=${q.id} reason=${q.blocked}`);
      continue;
    }
    if (splitFilter !== undefined && q.split !== splitFilter) continue;
    const call = await client.callTool('berry_context', {
      task: q.question,
      strategy: 'ranked',
      include_code: true,
      include_memory: true,
      max_tokens: 8000,
      entity_scope: [...q.entityScope],
      project_name: q.projectScope,
    });
    const planner = plannerErrorCode(call.payload);
    if (planner !== undefined) {
      // NOT a retrieval failure. Loud, separate, excluded from every metric.
      console.log(`EVAL001 planner-error=${q.id} code=${planner}`);
      continue;
    }
    if (!call.ok) throw new Error(`EVAL001: berry_context failed on ${q.id}: ${call.payload.slice(0, 512)}`);
    results.push(scoreQuestion(q, parseCodeItems(call.payload)));
  }

  for (const split of [...new Set(results.map((result) => result.split))].sort()) {
    const inSplit = results.filter((result) => result.split === split);
    console.log(`EVAL001 split=${split} n=${inSplit.length}`
      + ` keywordRecall5=${mean(inSplit.map((r) => r.recall[5])).toFixed(4)}`
      + ` keywordRecall10=${mean(inSplit.map((r) => r.recall[10])).toFixed(4)}`);
    console.log(`EVAL001 split=${split}`
      + ` noiseRate5=${mean(inSplit.map((r) => r.noise[5])).toFixed(4)}`
      + ` noiseRate10=${mean(inSplit.map((r) => r.noise[10])).toFixed(4)}`);
    // §3.2 custody: per-question lines for dev only. Holdout is aggregate-only.
    if (split !== 'dev') continue;
    for (const result of inSplit) {
      console.log(`EVAL001 split=${split} question=${result.id}`
        + ` keywordRecall5=${result.recall[5].toFixed(4)}`
        + ` missing=${result.missing[5].join(',') || 'none'}`);
    }
  }
  // §2.3 forbidden keywords are a regression flag. Naming the question is a
  // per-question disclosure, so outside dev it is reported as a count only.
  for (const result of results.filter((entry) => entry.forbiddenHits.length > 0)) {
    if (result.split === 'dev') {
      console.log(`EVAL001 regression=${result.id} forbidden=${result.forbiddenHits.join(',')}`);
    }
  }
  for (const split of [...new Set(results.map((result) => result.split))].sort()) {
    if (split === 'dev') continue;
    const flagged = results.filter((r) => r.split === split && r.forbiddenHits.length > 0).length;
    if (flagged > 0) console.log(`EVAL001 split=${split} regressions=${flagged}`);
  }
}

// Run as CLI only when invoked directly (not when imported by the grammar pin test).
if (process.argv[1]?.endsWith('run-eval001.ts')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
