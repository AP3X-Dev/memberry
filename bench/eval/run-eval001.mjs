#!/usr/bin/env node
// EVAL-001 runner.
//
// Calls the SAME production path the agent hit -- over MCP, against the live server, with the
// recorded arguments. No lab adapter, no re-ranking in bench code, no re-composition of the
// pipeline. Measuring a bench re-composition is what quality-eval.ts does and is strictly less
// honest.
//
// Usage:
//   node bench/eval/run-eval001.mjs --split dev
//   node bench/eval/run-eval001.mjs --split holdout      (aggregate output only, by design)
//   node bench/eval/run-eval001.mjs --smoke              (transport check, touches no question)
//
// Env: MEMBERRY_BASE_URL (default http://192.168.0.25:3101), MEMBERRY_API_TOKEN (required).
//
// ponytail: plain .mjs, node stdlib + fetch only. Deliberately does NOT import
// HttpMemberryTransport from bench/lab -- that is a cross-directory import bench:lab:typecheck
// does not cover, and its call() flattens content blocks to a joined string and throws on
// isError, discarding the exact branch this runner exists to separate.

import { readFileSync, writeFileSync } from 'node:fs'

const DEFAULT_BASE = 'http://192.168.0.25:3101'

/**
 * Verified live 2026-08-27. Planner rejections arrive as HTTP 200 with isError:true and a bare
 * message; there is no JSON-RPC error member and nothing throws. A runner that inspects
 * response.error sees nothing, feeds this literal string into keyword matching, and scores 0 --
 * reporting a catastrophic regression that is really a config error. This list is why the
 * runner branches on isError BEFORE it scores anything.
 */
const NON_RETRIEVAL_ERRORS = [
  'runtime_query_planner:invalid_request',
  'runtime_query_planner:resolution_failed',
  'reranker_shadow:prerequisite_unavailable',
  'reranker_served:prerequisite_unavailable',
]

/**
 * EVAL-001 spec §2.2.1, pinned. The separator is U+2014 EM DASH (bytes e2 80 94), confirmed at
 * source level at assembler.ts:651 and :1145 and against live output.
 * KNOWN LIMIT, pinned in bench/lab/eval001/render-grammar.test.ts: (?<path>[^:`]+) cannot match
 * a Windows absolute path -- the drive-letter colon terminates the group with no backtrack.
 * Irrelevant while the corpus is Linux-indexed (/workspace/memberry/...), fatal if it is not.
 */
const ITEM_GRAMMAR = /^\*\*(?<name>.+?)\*\* \((?<kind>[a-z]+)\) — `(?<path>[^:`]+):(?<line>\d+)`/

const TEST_PATH = /__tests__|\.test\.|\.spec\./

function parseArgs(argv) {
  const args = {
    questions: 'bench/eval/eval001-questions.jsonl',
    out: 'bench/eval/last-run.json',
    split: 'dev',
    smoke: false,
    base: process.env.MEMBERRY_BASE_URL || DEFAULT_BASE,
  }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--questions') args.questions = argv[i + 1]
    if (argv[i] === '--out') args.out = argv[i + 1]
    if (argv[i] === '--split') args.split = argv[i + 1]
    if (argv[i] === '--smoke') args.smoke = true
    if (argv[i] === '--base') args.base = argv[i + 1]
  }
  return args
}

// ---- MCP client, ~40 lines, no dependency -------------------------------------------------

function createClient(base, token) {
  let sessionId = null
  async function rpc(method, params) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    }
    if (sessionId) headers['mcp-session-id'] = sessionId
    const res = await fetch(new URL('/mcp', base), {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    const sid = res.headers.get('mcp-session-id')
    if (sid) sessionId = sid
    const text = await res.text()
    if (!text.trim()) return { _status: res.status, _empty: true }
    // Responses are SSE-framed; the payload is the line beginning "data: ".
    const dataLine = text.split('\n').find((l) => l.startsWith('data: '))
    try {
      return JSON.parse(dataLine ? dataLine.slice(6) : text)
    } catch {
      return { _status: res.status, _unparseable: text.slice(0, 400) }
    }
  }
  async function callTool(name, args) {
    const res = await rpc('tools/call', { name, arguments: args })
    const result = res?.result
    const text = (result?.content ?? []).map((c) => c?.text ?? '').join('\n')
    return { isError: result?.isError === true, text, raw: res }
  }
  return {
    async connect() {
      await rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'eval001-runner', version: '1' },
      })
      await rpc('notifications/initialized', {})
      if (!sessionId) throw new Error('EVAL001 fatal: no mcp-session-id returned by initialize')

      // Progressive disclosure: the code tools are DISABLED by default. Without this, every
      // berry_code_search question returns `MCP error -32602: Tool berry_code_search disabled`
      // as isError -- and the whole code plane, the one the primary defect lives in, silently
      // becomes unmeasurable. Enabling here is what a real agent does, not a test fixture.
      //
      // Two traps, both verified live 2026-08-27:
      //   - the parameter is `domain`, NOT `tier`
      //   - passing the wrong parameter returns isError:FALSE with the failure buried in a JSON
      //     body ({"error":"domain parameter required for enable action"}), so the isError
      //     branch alone does not catch it. Parse the body.
      const enable = await callTool('berry_tools', { action: 'enable', domain: 'code' })
      let enabled = false
      try {
        enabled = JSON.parse(enable.text)?.ok === true
      } catch {
        enabled = false
      }
      const listed = await rpc('tools/list', {})
      const codeTools = (listed?.result?.tools ?? []).map((t) => t.name).filter((n) => n.includes('code'))
      return { codeDomainEnabled: enabled, codeToolsVisible: codeTools.length }
    },
    callTool,
  }
}

// ---- Response parsing ---------------------------------------------------------------------

/**
 * Item blocks are delimited by an HTML comment carrying the id and path:
 *   <!-- sym-XXXX — /workspace/memberry/packages/retrieval/src/assembler.ts -->
 *   **name** (kind) — `/path:line`
 *   `signature`
 *   > doc first line          (only when doc_comment is truthy)
 * Parse by that delimiter rather than by fixed line offsets: the doc line is conditional, so it
 * is not reliably the third line of an item.
 */
function parseMarkdownItems(text) {
  const blocks = text.split(/(?=<!--\s)/g).filter((b) => b.trim().startsWith('<!--'))
  const items = []
  let grammarMisses = 0
  for (const block of blocks) {
    const commentPath = block.match(/<!--[^—]*—\s*(?<path>[^>]+?)\s*-->/)?.groups?.path ?? null
    const boldLine = block.split('\n').find((l) => l.startsWith('**'))
    const m = boldLine ? boldLine.match(ITEM_GRAMMAR) : null
    if (boldLine && !m) grammarMisses += 1 // metric is known-invalid, not quietly wrong
    items.push({
      name: m?.groups?.name ?? null,
      kind: m?.groups?.kind ?? null,
      path: m?.groups?.path ?? commentPath,
      line: m?.groups?.line ? Number(m.groups.line) : null,
      hasDoc: /^> /m.test(block),
      text: block,
      grammarMatched: Boolean(m),
    })
  }
  return { items, grammarMisses }
}

/**
 * berry_code_search returns a JSON array, no markdown at all. Real shape verified live
 * 2026-08-27: {name, kind, source, file, signature, doc, score}. NOTE `file` carries
 * "path:line" in ONE field -- splitting it is required, and reading it as a bare path would
 * make every test-file check compare against a string ending in ':392'.
 */
function parseJsonItems(text) {
  try {
    const parsed = JSON.parse(text)
    const rows = Array.isArray(parsed) ? parsed : Object.values(parsed).flat()
    return {
      items: rows.filter((r) => r && typeof r === 'object').map((r) => {
        const combined = String(r.file ?? r.file_path ?? '')
        const m = combined.match(/^(?<path>.*):(?<line>\d+)$/)
        return {
          name: r.name ?? null,
          kind: r.kind ?? null,
          path: m?.groups?.path ?? (combined || null),
          line: m?.groups?.line ? Number(m.groups.line) : (r.start_line ?? null),
          hasDoc: Boolean(r.doc ?? r.doc_comment),
          text: JSON.stringify(r),
          grammarMatched: true, // structured; no grammar involved
        }
      }),
      grammarMisses: 0,
    }
  } catch {
    return { items: [], grammarMisses: 0 }
  }
}

/**
 * berry_load returns memory blocks, NOT code items and NOT <!-- --> delimited:
 *   ## [QTGjRm7saDLAmfluTrmac] (confidence: 1.00, score: 0.547)
 *   **Tags:** ...
 * Verified live 2026-08-27. These carry no path and no SymbolKind, so testFileRate is
 * correctly null for them -- they are the memory plane.
 */
function parseMemoryBlocks(text) {
  const blocks = text.split(/(?=^## \[)/m).filter((b) => /^## \[/.test(b))
  return {
    items: blocks.map((b) => ({
      name: b.match(/^## \[(?<id>[^\]]+)\]/)?.groups?.id ?? null,
      kind: 'memory',
      path: null,
      line: null,
      hasDoc: false,
      text: b,
      grammarMatched: true,
    })),
    grammarMisses: 0,
  }
}

/**
 * berry_grep returns bulleted hits under ### Semantic / ### Episodic headings:
 *   - **[semantic-decision-7a98f148...]** (confidence: 0.9)
 * Verified live 2026-08-27.
 */
function parseGrepBullets(text) {
  const bullets = text.split('\n').filter((l) => /^-\s+\*\*\[/.test(l))
  return {
    items: bullets.map((l) => ({
      name: l.match(/\*\*\[(?<id>[^\]]+)\]\*\*/)?.groups?.id ?? null,
      kind: 'memory',
      path: null,
      line: null,
      hasDoc: false,
      text: l,
      grammarMatched: true,
    })),
    grammarMisses: 0,
  }
}

/**
 * Four confirmed response shapes, one per tool. Tried in the order most specific first; each
 * returns zero items when it does not apply, so a shape change degrades to 'whole-text' and is
 * REPORTED rather than silently mis-segmented.
 */
function parseResponse(tool, text) {
  if (tool === 'berry_code_search') {
    const json = parseJsonItems(text)
    if (json.items.length > 0) return { ...json, segmentation: 'json' }
  }
  const md = parseMarkdownItems(text)
  if (md.items.length > 0) return { ...md, segmentation: 'markdown-blocks' }
  const mem = parseMemoryBlocks(text)
  if (mem.items.length > 0) return { ...mem, segmentation: 'memory-blocks' }
  const grep = parseGrepBullets(text)
  if (grep.items.length > 0) return { ...grep, segmentation: 'grep-bullets' }
  // No per-item segmentation available. @k is not meaningful; recorded so it is visible rather
  // than silently reported as if it were.
  return { items: [], grammarMisses: 0, segmentation: 'whole-text' }
}

// ---- Metrics --------------------------------------------------------------------------------

function matchesKeyword(haystack, kw) {
  if (kw.match === 'exact') {
    const escaped = kw.kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`\\b${escaped}\\b`).test(haystack)
  }
  return haystack.toLowerCase().includes(kw.kw.toLowerCase())
}

function score(question, parsed, fullText, k) {
  const scope =
    parsed.segmentation === 'whole-text'
      ? fullText
      : parsed.items.slice(0, k).map((i) => i.text).join('\n')
  const found = question.requiredKeywords.filter((kw) => matchesKeyword(scope, kw))
  const missing = question.requiredKeywords.filter((kw) => !matchesKeyword(scope, kw)).map((kw) => kw.kw)
  const topK = parsed.items.slice(0, k)
  const forbidden = (question.forbiddenKeywords ?? []).filter((kw) =>
    matchesKeyword(scope, { kw, match: 'substring' })
  )
  return {
    keywordRecall: question.requiredKeywords.length ? found.length / question.requiredKeywords.length : null,
    missing,
    forbiddenPresent: forbidden,
    // NOTE: this is testFileRate, NOT the spec's noiseRate. The spec's bare-variable clause was
    // measured unsound on 2026-08-27 and is deliberately not implemented -- see BASELINE.md.
    testFileRate: topK.length ? topK.filter((i) => i.path && TEST_PATH.test(i.path)).length / topK.length : null,
    kinds: topK.reduce((acc, i) => ({ ...acc, [i.kind ?? 'unknown']: (acc[i.kind ?? 'unknown'] ?? 0) + 1 }), {}),
  }
}

function mean(values) {
  const nums = values.filter((v) => typeof v === 'number')
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null
}

const fmt = (v) => (typeof v === 'number' ? v.toFixed(4) : 'n/a')

// ---- Main -----------------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2))
const token = process.env.MEMBERRY_API_TOKEN
if (!token) {
  console.error('EVAL001 fatal: MEMBERRY_API_TOKEN is not set')
  process.exit(2)
}

const client = createClient(args.base, token)
const session = await client.connect()
console.log(`EVAL001 session codeDomainEnabled=${session.codeDomainEnabled} codeToolsVisible=${session.codeToolsVisible}`)

if (args.smoke) {
  // Transport check against a query that is NOT in the question set, so running it cannot
  // contaminate blind keyword authoring (SELECTION-RULE.md §7).
  const ok = await client.callTool('berry_context', {
    task: 'How does the unified assembler compose the code plane and fuse ranked results?',
    project_name: 'project:memberry',
    entity_scope: ['MemBerry'],
    include_code: true,
    include_memory: true,
    max_tokens: 1500,
  })
  const parsed = parseResponse('berry_context', ok.text)
  const bad = await client.callTool('berry_context', { task: 'x', project_name: 'project:memberry' })
  console.log(`EVAL001-SMOKE connected=true isError=${ok.isError} items=${parsed.items.length} grammarMisses=${parsed.grammarMisses} segmentation=${parsed.segmentation}`)
  console.log(`EVAL001-SMOKE header=${JSON.stringify(ok.text.split('\n').find((l) => l.includes('**Code:**')) ?? null)}`)
  console.log(`EVAL001-SMOKE errorBranch isError=${bad.isError} text=${JSON.stringify(bad.text.slice(0, 80))}`)
  process.exit(bad.isError && !ok.isError && parsed.grammarMisses === 0 ? 0 : 1)
}

const all = readFileSync(args.questions, 'utf8').trim().split('\n').map((l) => JSON.parse(l))

// Spec §5 item 1: refuse to run on unauthored questions. A question whose keywords were guessed
// is not evidence, and an empty keyword list would silently contribute a null to every mean.
const unauthored = all.filter((q) => !q.sourceOfTruth || (q.requiredKeywords ?? []).length === 0)
if (unauthored.length > 0) {
  console.error(`EVAL001 fatal: ${unauthored.length} question(s) lack sourceOfTruth or requiredKeywords: ${unauthored.map((q) => q.id).join(', ')}`)
  console.error('EVAL001 keywords must be authored blind per bench/eval/SELECTION-RULE.md §7 before any run.')
  process.exit(2)
}

const questions = all.filter((q) => q.split === args.split)
const results = []
const nonRetrieval = []

for (const q of questions) {
  const input = { ...q.provenance.originalInput }
  // Replay through the tool that ACTUALLY issued the query, with its original arguments.
  // Converting a berry_load call into a berry_context call would fabricate traffic nobody sent
  // and would trip the planner's entity_scope requirement on questions that never faced it.
  const call = await client.callTool(`mcp__memberry__${q.tool}`.replace('mcp__memberry__', ''), input)

  if (call.isError) {
    const known = NON_RETRIEVAL_ERRORS.find((e) => call.text.includes(e))
    nonRetrieval.push({ id: q.id, tool: q.tool, error: known ?? call.text.slice(0, 120), classified: Boolean(known) })
    continue // NEVER scored as zero -- a config rejection is not a retrieval failure
  }

  const parsed = parseResponse(q.tool, call.text)
  const codeHeader = call.text.split('\n').find((l) => l.includes('**Code:**')) ?? null
  if (codeHeader && /unavailable/.test(codeHeader)) {
    nonRetrieval.push({ id: q.id, tool: q.tool, error: `code-plane ${codeHeader.trim()}`, classified: true })
    continue // a silent-zero mode that returns a clean 200; indistinguishable from real zero recall
  }

  results.push({
    id: q.id,
    tool: q.tool,
    plane: q.plane,
    segmentation: parsed.segmentation,
    grammarMisses: parsed.grammarMisses,
    itemCount: parsed.items.length,
    strategyHeader: call.text.split('\n').find((l) => l.includes('**Strategy:**'))?.trim() ?? null,
    codeHeader: codeHeader?.trim() ?? null,
    at5: score(q, parsed, call.text, 5),
    at10: score(q, parsed, call.text, 10),
  })
}

const agg = {
  split: args.split,
  n: results.length,
  keywordRecall5: mean(results.map((r) => r.at5.keywordRecall)),
  keywordRecall10: mean(results.map((r) => r.at10.keywordRecall)),
  testFileRate5: mean(results.map((r) => r.at5.testFileRate)),
  testFileRate10: mean(results.map((r) => r.at10.testFileRate)),
  grammarMisses: results.reduce((a, r) => a + r.grammarMisses, 0),
  nonRetrieval: nonRetrieval.length,
}

console.log(`EVAL001 split=${agg.split} n=${agg.n} keywordRecall5=${fmt(agg.keywordRecall5)} keywordRecall10=${fmt(agg.keywordRecall10)}`)
console.log(`EVAL001 split=${agg.split} testFileRate5=${fmt(agg.testFileRate5)} testFileRate10=${fmt(agg.testFileRate10)}`)
console.log(`EVAL001 split=${agg.split} grammarMisses=${agg.grammarMisses} nonRetrieval=${agg.nonRetrieval} flags=QUERY_PLANNER_V1,CANDIDATE_CHANNEL_V1,RERANKER_V1`)
for (const nr of nonRetrieval) {
  console.log(`EVAL001 NON-RETRIEVAL question=${nr.id} tool=${nr.tool} classified=${nr.classified} error=${nr.error}`)
}
// Per-question detail is emitted for dev ONLY -- holdout stays aggregate, per spec §3.2.1.
if (args.split === 'dev') {
  for (const r of results) {
    console.log(`EVAL001 split=dev question=${r.id} keywordRecall5=${fmt(r.at5.keywordRecall)} testFileRate5=${fmt(r.at5.testFileRate)} missing=${r.at5.missing.join('|') || '-'}`)
  }
}

writeFileSync(
  args.out,
  JSON.stringify({ aggregate: agg, nonRetrieval, results: args.split === 'dev' ? results : '(withheld: holdout is aggregate-only)' }, null, 2),
  'utf8'
)
console.log(`EVAL001 out=${args.out}`)
