#!/usr/bin/env node
// EVAL-001 query miner.
//
// Extracts the REAL berry_* retrieval calls that connected agents issued during real work,
// from client transcripts. MemBerry does not log queries; its clients do.
//
// This produces the RAW population only. It applies NO selection and NO exclusions --
// those are governed by bench/eval/SELECTION-RULE.md and happen in a separate, logged step,
// so that what was mined and what was chosen stay independently auditable.
//
// Usage:  node bench/eval/mine-queries.mjs [--out <path>] [--roots <dir>[,<dir>...]]
//
// ponytail: plain .mjs, node stdlib only. It reads outside the repo and imports nothing
// from it, so it needs no tsx, no build, and no entry in bench:lab:typecheck.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** SELECTION-RULE.md section 3: the population is exactly these four tools. */
const RETRIEVAL_TOOLS = {
  mcp__memberry__berry_load: 'memory',
  mcp__memberry__berry_grep: 'memory',
  mcp__memberry__berry_context: 'mixed',
  mcp__memberry__berry_code_search: 'code',
}

/** Excluded by kind: writes, lifecycle, admin, and raw Cypher. Recorded, not silent. */
const NON_RETRIEVAL_TOOLS = [
  'mcp__memberry__berry_query',
  'mcp__memberry__berry_store',
  'mcp__memberry__berry_memory_insert',
  'mcp__memberry__berry_consolidate',
  'mcp__memberry__berry_ingest_codebase',
  'mcp__memberry__berry_code_index',
  'mcp__memberry__berry_tools',
  'mcp__memberry__berry_graph_report',
]

function parseArgs(argv) {
  const args = {
    out: 'bench/eval/mined-queries.jsonl',
    roots: [join(homedir(), '.claude', 'projects'), join(homedir(), '.codex', 'sessions')],
  }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') args.out = argv[i + 1]
    if (argv[i] === '--roots') args.roots = argv[i + 1].split(',').map((r) => resolve(r))
  }
  return args
}

function* walkJsonl(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return // unreadable dir is not fatal; the summary reports the file count actually seen
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walkJsonl(full)
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield full
  }
}

/**
 * The one text field a question is actually asking with, per tool. Different tools name it
 * differently, and a miner that guessed one field name would silently drop three of four.
 */
function queryTextOf(tool, input) {
  if (!input || typeof input !== 'object') return ''
  if (tool === 'mcp__memberry__berry_load') return String(input.task ?? '')
  if (tool === 'mcp__memberry__berry_grep') return String(input.pattern ?? '')
  if (tool === 'mcp__memberry__berry_context') return String(input.task ?? input.query ?? '')
  if (tool === 'mcp__memberry__berry_code_search') return String(input.query ?? '')
  return ''
}

/** SELECTION-RULE.md section 4 E1: normalised text is what duplicate-detection compares. */
function normalise(text) {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Stable id derived from content, so re-mining the same transcripts reproduces the same ids
 * and the split assignment in SELECTION-RULE.md section 6 stays byte-reproducible.
 */
function queryId(tool, input) {
  const digest = createHash('sha256')
    .update(`${tool}\u0000${JSON.stringify(input ?? null)}`)
    .digest('hex')
  return `q-${digest.slice(0, 12)}`
}

/**
 * Parse only data literals from a Codex wrapper script. Codex records MCP calls made through the
 * orchestration `exec` tool as JavaScript such as `tools.mcp__...({task:"..."})`. Evaluating a
 * transcript is unsafe, so this deliberately accepts only objects/arrays/strings/numbers/
 * booleans/null and rejects identifiers, spreads, templates, getters, and function calls.
 */
class StaticLiteralParser {
  constructor(source, start = 0) { this.source = source; this.index = start }

  skip() {
    while (this.index < this.source.length) {
      if (/\s/.test(this.source[this.index])) { this.index += 1; continue }
      if (this.source.startsWith('//', this.index)) {
        const end = this.source.indexOf('\n', this.index + 2)
        this.index = end < 0 ? this.source.length : end + 1
        continue
      }
      if (this.source.startsWith('/*', this.index)) {
        const end = this.source.indexOf('*/', this.index + 2)
        if (end < 0) throw new Error('unterminated comment')
        this.index = end + 2
        continue
      }
      break
    }
  }

  value() {
    this.skip()
    const char = this.source[this.index]
    if (char === '{') return this.object()
    if (char === '[') return this.array()
    if (char === '"' || char === "'") return this.string()
    const tail = this.source.slice(this.index)
    for (const [word, value] of [['true', true], ['false', false], ['null', null]]) {
      if (tail.startsWith(word) && !/[A-Za-z0-9_$]/.test(tail[word.length] ?? '')) {
        this.index += word.length
        return value
      }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(tail)?.[0]
    if (number) { this.index += number.length; return Number(number) }
    throw new Error('dynamic value')
  }

  string() {
    const quote = this.source[this.index++]
    let result = ''
    while (this.index < this.source.length) {
      const char = this.source[this.index++]
      if (char === quote) return result
      if (char !== '\\') { result += char; continue }
      if (this.index >= this.source.length) throw new Error('unterminated escape')
      const escaped = this.source[this.index++]
      const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' }
      if (escaped in simple) result += simple[escaped]
      else if (escaped === 'u') {
        const hex = this.source.slice(this.index, this.index + 4)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('invalid unicode escape')
        result += String.fromCharCode(Number.parseInt(hex, 16)); this.index += 4
      } else if (escaped === 'x') {
        const hex = this.source.slice(this.index, this.index + 2)
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new Error('invalid hex escape')
        result += String.fromCharCode(Number.parseInt(hex, 16)); this.index += 2
      } else result += escaped
    }
    throw new Error('unterminated string')
  }

  key() {
    this.skip()
    if (this.source[this.index] === '"' || this.source[this.index] === "'") return this.string()
    const key = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(this.source.slice(this.index))?.[0]
    if (!key) throw new Error('dynamic key')
    this.index += key.length
    return key
  }

  object() {
    const result = {}
    this.index += 1
    this.skip()
    if (this.source[this.index] === '}') { this.index += 1; return result }
    while (this.index < this.source.length) {
      const key = this.key()
      this.skip()
      if (this.source[this.index++] !== ':') throw new Error('missing colon')
      result[key] = this.value()
      this.skip()
      const next = this.source[this.index++]
      if (next === '}') return result
      if (next !== ',') throw new Error('missing comma')
      this.skip()
      if (this.source[this.index] === '}') { this.index += 1; return result }
    }
    throw new Error('unterminated object')
  }

  array() {
    const result = []
    this.index += 1
    this.skip()
    if (this.source[this.index] === ']') { this.index += 1; return result }
    while (this.index < this.source.length) {
      result.push(this.value())
      this.skip()
      const next = this.source[this.index++]
      if (next === ']') return result
      if (next !== ',') throw new Error('missing comma')
      this.skip()
      if (this.source[this.index] === ']') { this.index += 1; return result }
    }
    throw new Error('unterminated array')
  }
}

function parseArgument(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function wrappedCalls(script) {
  if (typeof script !== 'string') return { calls: [], dynamic: 0 }
  const calls = []
  let dynamic = 0
  const pattern = /tools\.(mcp__memberry__berry_[A-Za-z0-9_]+)\s*\(/g
  for (const match of script.matchAll(pattern)) {
    const parser = new StaticLiteralParser(script, match.index + match[0].length)
    try {
      const input = parser.value()
      parser.skip()
      if (script[parser.index] !== ')' || !input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('non-literal call')
      }
      calls.push({ name: match[1], input })
    } catch {
      dynamic += 1
    }
  }
  return { calls, dynamic }
}

function callsOf(record) {
  const claude = record?.message?.content
  if (Array.isArray(claude)) {
    return {
      calls: claude.filter((block) => block?.type === 'tool_use' && typeof block.name === 'string')
        .map((block) => ({ name: block.name, input: block.input ?? null })),
      dynamic: 0,
    }
  }
  if (record?.type !== 'response_item') return { calls: [], dynamic: 0 }
  const payload = record.payload
  if (!payload || !['function_call', 'custom_tool_call'].includes(payload.type)) return { calls: [], dynamic: 0 }
  if (payload.name === 'exec') return wrappedCalls(payload.input)
  if (typeof payload.name !== 'string') return { calls: [], dynamic: 0 }
  const input = parseArgument(payload.arguments ?? payload.input)
  return input ? { calls: [{ name: payload.name, input }], dynamic: 0 } : { calls: [], dynamic: 1 }
}

function mine(roots) {
  const rows = []
  const nonRetrievalCounts = Object.fromEntries(NON_RETRIEVAL_TOOLS.map((t) => [t, 0]))
  let filesSeen = 0
  let filesUnreadable = 0
  let linesTotal = 0
  let linesUnparseable = 0
  let callsDynamic = 0

  for (const root of roots) {
    for (const file of walkJsonl(root)) {
      filesSeen += 1
      let codexSessionId = null
      let codexCwd = null
      let codexGitBranch = null
      let raw
      try {
        raw = readFileSync(file, 'utf8')
      } catch {
        filesUnreadable += 1
        continue
      }
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        linesTotal += 1
        let record
        try {
          record = JSON.parse(line)
        } catch {
          linesUnparseable += 1
          continue // truncated tail lines are normal in live transcripts
        }
        if (record?.type === 'session_meta' && record.payload && typeof record.payload === 'object') {
          codexSessionId = record.payload.id ?? record.payload.session_id ?? codexSessionId
          codexCwd = record.payload.cwd ?? codexCwd
          codexGitBranch = record.payload.git?.branch ?? codexGitBranch
        }
        if (record?.type === 'turn_context' && record.payload && typeof record.payload === 'object') {
          codexCwd = record.payload.cwd ?? codexCwd
        }
        const extracted = callsOf(record)
        callsDynamic += extracted.dynamic
        for (const block of extracted.calls) {
          if (block.name in nonRetrievalCounts) nonRetrievalCounts[block.name] += 1
          const plane = RETRIEVAL_TOOLS[block.name]
          if (!plane) continue
          const text = queryTextOf(block.name, block.input)
          rows.push({
            queryId: queryId(block.name, block.input),
            tool: block.name,
            plane,
            queryText: text,
            normalisedText: normalise(text),
            input: block.input ?? null,
            timestamp: record.timestamp ?? null,
            sessionId: record.sessionId ?? codexSessionId,
            gitBranch: record.gitBranch ?? codexGitBranch,
            cwd: record.cwd ?? codexCwd,
            transcript: file,
          })
        }
      }
    }
  }

  // Deterministic order: timestamp ascending is the tiebreak SELECTION-RULE.md section 5.2
  // relies on everywhere, so the mined file must already carry it.
  rows.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)) || a.queryId.localeCompare(b.queryId))
  return { rows, nonRetrievalCounts, filesSeen, filesUnreadable, linesTotal, linesUnparseable, callsDynamic }
}

function summarise(result) {
  const byTool = {}
  const byPlane = {}
  const byProject = {}
  const seenNormalised = new Set()
  let duplicates = 0

  for (const row of result.rows) {
    byTool[row.tool] = (byTool[row.tool] ?? 0) + 1
    byPlane[row.plane] = (byPlane[row.plane] ?? 0) + 1
    if (seenNormalised.has(row.normalisedText)) duplicates += 1
    else seenNormalised.add(row.normalisedText)
    const scopes = JSON.stringify(row.input ?? {}).match(/project:[a-z0-9-]+/g) ?? ['(unscoped)']
    for (const scope of new Set(scopes)) byProject[scope] = (byProject[scope] ?? 0) + 1
  }
  return { byTool, byPlane, byProject, duplicates }
}

const args = parseArgs(process.argv.slice(2))
const result = mine(args.roots)
const summary = summarise(result)

writeFileSync(args.out, result.rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

// Greppable output lines, matching the house convention the lab harnesses use.
console.log(`EVAL001-MINE files=${result.filesSeen} unreadable=${result.filesUnreadable} lines=${result.linesTotal} unparseable=${result.linesUnparseable}`)
console.log(`EVAL001-MINE population=${result.rows.length} duplicates=${summary.duplicates} dynamic=${result.callsDynamic} out=${args.out}`)
for (const [tool, n] of Object.entries(summary.byTool).sort((a, b) => b[1] - a[1])) {
  console.log(`EVAL001-MINE tool=${tool.replace('mcp__memberry__', '')} n=${n}`)
}
for (const [plane, n] of Object.entries(summary.byPlane).sort((a, b) => b[1] - a[1])) {
  console.log(`EVAL001-MINE plane=${plane} n=${n}`)
}
for (const [project, n] of Object.entries(summary.byProject).sort((a, b) => b[1] - a[1])) {
  console.log(`EVAL001-MINE scope=${project} n=${n}`)
}
for (const [tool, n] of Object.entries(result.nonRetrievalCounts)) {
  if (n > 0) console.log(`EVAL001-MINE excluded-by-kind tool=${tool.replace('mcp__memberry__', '')} n=${n}`)
}
