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
  const args = { out: 'bench/eval/mined-queries.jsonl', roots: [join(homedir(), '.claude', 'projects')] }
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

function mine(roots) {
  const rows = []
  const nonRetrievalCounts = Object.fromEntries(NON_RETRIEVAL_TOOLS.map((t) => [t, 0]))
  let filesSeen = 0
  let filesUnreadable = 0
  let linesTotal = 0
  let linesUnparseable = 0

  for (const root of roots) {
    for (const file of walkJsonl(root)) {
      filesSeen += 1
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
        const content = record?.message?.content
        if (!Array.isArray(content)) continue
        for (const block of content) {
          if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue
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
            sessionId: record.sessionId ?? null,
            gitBranch: record.gitBranch ?? null,
            cwd: record.cwd ?? null,
            transcript: file,
          })
        }
      }
    }
  }

  // Deterministic order: timestamp ascending is the tiebreak SELECTION-RULE.md section 5.2
  // relies on everywhere, so the mined file must already carry it.
  rows.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)) || a.queryId.localeCompare(b.queryId))
  return { rows, nonRetrievalCounts, filesSeen, filesUnreadable, linesTotal, linesUnparseable }
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
console.log(`EVAL001-MINE population=${result.rows.length} duplicates=${summary.duplicates} out=${args.out}`)
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
