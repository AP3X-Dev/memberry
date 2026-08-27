#!/usr/bin/env node
// EVAL-001B outcome probe — "did the right FILE come back, and how far down?"
//
// WHY THIS EXISTS ALONGSIDE run-eval001.mjs.
// keywordRecall@k asks whether a required term appears ANYWHERE in the top-k content. That is
// satisfiable by junk: a variable named `to` matching the word "to" in the question contains the
// token and scores a hit. This probe asks the question an agent actually cares about — is the
// file that answers me in the top 5? — and file-level ground truth is UNARGUABLE, so it needs no
// blind-authoring ceremony to be honest.
//
// Measured 2026-08-27 on the origin index: 0 of 4 answers in the top 5. The junk occupying those
// slots was single-word local variables whose names collide with ordinary English words in the
// question (`to`, `at`, `applied`, `budget`, `validated`). That is a finer-grained defect than
// the test-file contamination the roadmap named, and it is what IDX-002A and IDX-002 target.
//
// Usage: node bench/eval/run-outcome-probe.mjs [--project memberry] [--limit 10]
//
// ponytail: file-level truth only. No keyword sets, no splits, no holdout ceremony -- this is a
// diagnostic, not a gate. It complements EVAL-001; it does not replace it.

import { readFileSync } from 'node:fs'
import { createClient } from './mcp-client.mjs'

const TEST_PATH = /__tests__|\.test\.|\.spec\./

function parseArgs(argv) {
  const args = { cases: 'bench/eval/outcome-cases.jsonl', project: 'memberry', limit: 10 }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--cases') args.cases = argv[i + 1]
    if (argv[i] === '--project') args.project = argv[i + 1]
    if (argv[i] === '--limit') args.limit = Number(argv[i + 1])
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const token = process.env.MEMBERRY_API_TOKEN
if (!token) {
  console.error('OUTCOME fatal: MEMBERRY_API_TOKEN is not set')
  process.exit(2)
}

const cases = readFileSync(args.cases, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const client = createClient(process.env.MEMBERRY_BASE_URL || 'http://192.168.0.25:3101', token)
const session = await client.connect()
if (!session.codeDomainEnabled) {
  // The code tools are disabled by default; without them every case is unmeasurable rather than
  // wrong, and reporting zeros would be a fabricated collapse.
  console.error('OUTCOME fatal: code domain could not be enabled — every case would be unmeasurable')
  process.exit(2)
}

const rows = []
for (const c of cases) {
  const res = await client.callTool('berry_code_search', {
    query: c.question,
    project_name: args.project,
    limit: args.limit,
  })
  if (res.isError) {
    rows.push({ id: c.id, error: res.text.slice(0, 120) })
    continue
  }
  let items = []
  try {
    const parsed = JSON.parse(res.text)
    items = (Array.isArray(parsed) ? parsed : Object.values(parsed).flat()).filter(Boolean)
  } catch {
    rows.push({ id: c.id, error: 'unparseable response' })
    continue
  }
  const rank = items.findIndex(
    (x) =>
      String(x.file ?? '').includes(c.expectFile) ||
      (c.expectSymbol && String(x.name ?? '') === c.expectSymbol)
  )
  const top5 = items.slice(0, 5)
  rows.push({
    id: c.id,
    rank: rank < 0 ? null : rank + 1,
    testInTop5: top5.filter((x) => TEST_PATH.test(String(x.file ?? ''))).length,
    variableInTop5: top5.filter((x) => x.kind === 'variable').length,
    top5: top5.map((x) => `${x.name}(${x.kind})${TEST_PATH.test(String(x.file ?? '')) ? '[T]' : ''}`),
  })
}

const scored = rows.filter((r) => !r.error)
const at = (k) => scored.filter((r) => r.rank !== null && r.rank <= k).length
const mrr = scored.reduce((a, r) => a + (r.rank ? 1 / r.rank : 0), 0) / (scored.length || 1)
const share = (f) => scored.reduce((a, r) => a + r[f], 0) / (scored.length * 5 || 1)
const fmt = (v) => v.toFixed(4)

console.log(`OUTCOME n=${scored.length} errors=${rows.length - scored.length} project=${args.project}`)
console.log(`OUTCOME answerAt1=${fmt(at(1) / (scored.length || 1))} answerAt5=${fmt(at(5) / (scored.length || 1))} answerAt10=${fmt(at(10) / (scored.length || 1))} mrr=${fmt(mrr)}`)
console.log(`OUTCOME variableShare5=${fmt(share('variableInTop5'))} testFileShare5=${fmt(share('testInTop5'))}`)
for (const r of rows) {
  if (r.error) {
    console.log(`OUTCOME case=${r.id} ERROR=${r.error}`)
    continue
  }
  console.log(`OUTCOME case=${r.id} rank=${r.rank ?? 'MISS'} varTop5=${r.variableInTop5} testTop5=${r.testInTop5} top5=${r.top5.join(' ')}`)
}
