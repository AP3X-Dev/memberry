#!/usr/bin/env node
// IDX-002B companion probe — "how much of a code search is actually this project's code?"
//
// run-outcome-probe.mjs answers "is the right FILE in the top 5". This answers the
// other half: what is OCCUPYING the top 5. They are different failures — an answer
// can be absent because ranking buried it (this probe sees that) or because the
// retriever never returned it at all (it does not, and no ranking change fixes it).
//
// Usage: node bench/eval/scope-probe.mjs [--project memberry] [--limit 10]
//
// ponytail: reuses outcome-cases.jsonl rather than inventing a second question set.

import { readFileSync } from 'node:fs'
import { createClient } from './mcp-client.mjs'

const args = { project: 'memberry', limit: 10, cases: 'bench/eval/outcome-cases.jsonl' }
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--project') args.project = process.argv[i + 1]
  if (process.argv[i] === '--limit') args.limit = Number(process.argv[i + 1])
}

const token = process.env.MEMBERRY_API_TOKEN
if (!token) { console.error('SCOPE fatal: MEMBERRY_API_TOKEN is not set'); process.exit(2) }

const cases = readFileSync(args.cases, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const client = createClient(process.env.MEMBERRY_BASE_URL || 'http://192.168.0.25:3101', token)
const session = await client.connect()
if (!session.codeDomainEnabled) {
  console.error('SCOPE fatal: code domain could not be enabled')
  process.exit(2)
}

// A path that belongs to THIS checkout of the scoped project. Anything else in a
// scoped result is either another project or a stale index generation of this one.
const ownPath = (p) => typeof p === 'string' && p.startsWith('/workspace/')

let slots = 0, memory = 0, foreign = 0, own = 0
const perCase = []

for (const c of cases) {
  const res = await client.callTool('berry_code_search', {
    query: c.question, project_name: args.project, limit: args.limit,
  })
  if (res.isError) { perCase.push(`${c.id} ERROR`); continue }
  let items = []
  try {
    const parsed = JSON.parse(res.text)
    items = (Array.isArray(parsed) ? parsed : Object.values(parsed).flat()).filter(Boolean)
  } catch { perCase.push(`${c.id} UNPARSEABLE`); continue }

  const top5 = items.slice(0, 5)
  const m = top5.filter((r) => r.kind === 'semantic' || r.source === 'semantic').length
  const f = top5.filter((r) => r.source !== 'semantic' && r.kind !== 'semantic' && !ownPath(String(r.file ?? '').split(':')[0])).length
  slots += top5.length; memory += m; foreign += f; own += top5.length - m - f
  perCase.push(`${c.id} memory=${m} foreign=${f} own=${top5.length - m - f}`)
}

const pct = (n) => `${((100 * n) / slots).toFixed(1)}%`
console.log(`SCOPE n=${cases.length} project=${args.project} limit=${args.limit} slots=${slots}`)
console.log(`SCOPE memoryRows=${memory} (${pct(memory)})  foreignOrStale=${foreign} (${pct(foreign)})  ownCode=${own} (${pct(own)})`)
for (const line of perCase) console.log(`SCOPE ${line}`)
