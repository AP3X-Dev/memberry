#!/usr/bin/env node
// IDX-004 measurement — "does retrieve-wide + rerank + prior-last actually find more?"
//
// WHY THIS IS NOT A PROJECTION.
// IDX-002A had to simulate: it replayed a comparator offline over MCP results, because the flag
// is read at module load and the deployed server did not carry the code. That limitation is
// real, but it does NOT force a simulation here — it only forces two processes. This script
// constructs the actual `CodeSearch` against the live graph, with the actual injected reranker,
// and runs the real code path. One process per flag state, because a module-load flag cannot be
// toggled in-process.
//
// It is still NOT a reading from the deployed server. It measures the shipped code path against
// live data. Report it that way.
//
// Usage — run inside the gate container, from a BUILT repo:
//   MEMBERRY_CODE_RERANK_V1=0 node bench/eval/idx004-measure.mjs --out /w/off.json
//   MEMBERRY_CODE_RERANK_V1=1 node bench/eval/idx004-measure.mjs --out /w/on.json
//   node bench/eval/idx004-measure.mjs --compare /w/off.json /w/on.json

import { readFileSync, writeFileSync } from 'node:fs'

const TEST_PATH = /__tests__|\.test\.|\.spec\.|__mocks__/
const isTestPath = (p) => (p ? TEST_PATH.test(String(p).toLowerCase()) : false)

const argv = process.argv.slice(2)
const arg = (flag, fallback) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

// ── compare mode: pure arithmetic over two saved runs, no DB needed ──────────
if (argv.includes('--compare')) {
  const i = argv.indexOf('--compare')
  const off = JSON.parse(readFileSync(argv[i + 1], 'utf8'))
  const on = JSON.parse(readFileSync(argv[i + 2], 'utf8'))
  report(off, on)
  process.exit(0)
}

const LIMIT = Number(arg('--limit', '10')) || 10
const PROJECT = arg('--project', 'memberry')
const CASES = arg('--cases', 'bench/eval/outcome-cases.jsonl')
const OUT = arg('--out', null)

const { CodeSearch } = await import('../../packages/code/dist/index.js')
const { createCodeRerankerV1 } = await import('../../packages/retrieval/dist/index.js')
const neo4j = (await import('neo4j-driver')).default

// The flag lives in the module we just imported; echo what it resolved to so a run can never be
// mislabelled after the fact. A run whose label and flag disagree is worse than no run.
const FLAG_ON = process.env.MEMBERRY_CODE_RERANK_V1 === '1'

const env = {}
try {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
} catch { /* container runs on process.env */ }

const NEO4J_URI = process.env.NEO4J_URI || env.NEO4J_URI || 'bolt://localhost:7687'
const NEO4J_USER = process.env.NEO4J_USER || env.NEO4J_USER || 'neo4j'
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || env.NEO4J_PASSWORD
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || env.OPENAI_API_KEY
if (!NEO4J_PASSWORD) { console.error('IDX004 fatal: NEO4J_PASSWORD unset'); process.exit(2) }
if (!OPENAI_API_KEY) { console.error('IDX004 fatal: OPENAI_API_KEY unset — the dense channel would silently return nothing'); process.exit(2) }

const OpenAI = (await import('openai')).default
const openai = new OpenAI({ apiKey: OPENAI_API_KEY })

// Minimal EmbeddingProvider matching what CodeSearch calls. `available` must be true or the
// dense channel is skipped and we would measure a three-channel system while claiming four.
const embedding = {
  available: true,
  async embed(text) {
    const r = await openai.embeddings.create({ model: 'text-embedding-3-small', input: text })
    return r.data[0].embedding
  },
  async embedBatch(texts) {
    const r = await openai.embeddings.create({ model: 'text-embedding-3-small', input: texts })
    return r.data.map((d) => d.embedding)
  },
}

const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD))
const search = new CodeSearch(driver, embedding, createCodeRerankerV1())
const cases = readFileSync(CASES, 'utf8').trim().split('\n').map((l) => JSON.parse(l))

const results = []
for (const c of cases) {
  let rows = []
  let error = null
  try {
    // `rerank: true` is what the berry_code_search handler passes. It is REQUIRED here: the
    // mechanism is gated on the flag AND this option, so a run without it would measure the
    // shipped path twice and report a delta of zero while looking perfectly healthy.
    rows = await search.search(c.question, {
      project_tag: `project:${PROJECT}`,
      limit: LIMIT,
      include_semantics: true,
      rerank: true,
    })
  } catch (err) {
    error = String(err?.message ?? err)
  }
  const rank = rows.findIndex((r) => (
    (c.expectFile && String(r.file_path).includes(c.expectFile))
    || (c.expectSymbol && r.name === c.expectSymbol)
  ))
  results.push({
    id: c.id,
    error,
    returned: rows.length,
    rank: rank < 0 ? null : rank + 1,
    top5: rows.slice(0, 5).map((r) => ({
      name: r.name, kind: r.kind, source: r.source_type, file: r.file_path,
    })),
  })
  console.error(`  ${c.id} rank=${results.at(-1).rank ?? 'MISS'} returned=${rows.length}${error ? ` ERROR=${error}` : ''}`)
}
await driver.close()

const run = { flagOn: FLAG_ON, limit: LIMIT, project: PROJECT, results, metrics: metrics(results) }
if (OUT) { writeFileSync(OUT, JSON.stringify(run, null, 2)); console.error(`wrote ${OUT}`) }
console.log(JSON.stringify(run.metrics, null, 2))

function metrics(rs) {
  const n = rs.length
  const ranks = rs.map((r) => r.rank)
  const at = (k) => ranks.filter((r) => r !== null && r <= k).length / n
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length
  return {
    n,
    answerAt1: at(1),
    answerAt5: at(5),
    answerAt10: at(10),
    found: ranks.filter((r) => r !== null).length,
    mrr: mean(ranks.map((r) => (r ? 1 / r : 0))),
    variableShare5: mean(rs.map((r) => r.top5.filter((x) => x.kind === 'variable').length / 5)),
    testFileShare5: mean(rs.map((r) => r.top5.filter((x) => isTestPath(x.file)).length / 5)),
    nonCodeShare5: mean(rs.map((r) => r.top5.filter((x) => x.source === 'semantic').length / 5)),
    errors: rs.filter((r) => r.error).length,
  }
}

function report(off, on) {
  // Guard against comparing a run to itself, or against a mislabelled pair. Two runs that agree
  // on flagOn are not a before/after and reporting them as one would be a fabricated delta.
  if (off.flagOn === on.flagOn) {
    console.error(`IDX004 fatal: both runs report flagOn=${off.flagOn}. Not a before/after pair.`)
    process.exit(2)
  }
  // The mechanism is gated on the flag AND an explicit option. If either is missing, both runs
  // exercise the shipped path and every delta is 0.0% — which reads as "no improvement" when the
  // truth is "nothing was measured". A byte-identical top-5 across all cases is the signature.
  const identical = off.results.every((o) => {
    const n = on.results.find((r) => r.id === o.id)
    return n && JSON.stringify(o.top5) === JSON.stringify(n.top5) && o.rank === n.rank
  })
  if (identical) {
    console.error(
      'IDX004 fatal: every case returned an IDENTICAL top-5 and rank in both runs. The mechanism '
      + 'did not engage — check that the ON run had BOTH MEMBERRY_CODE_RERANK_V1=1 and rerank:true. '
      + 'Refusing to report a delta that would read as "no effect" rather than "not measured".',
    )
    process.exit(2)
  }
  const pct = (v) => `${(v * 100).toFixed(1)}%`
  const rows = [
    ['answerAt1', 'rank-1', pct], ['answerAt5', 'top-5', pct], ['answerAt10', 'top-10', pct],
    ['mrr', 'MRR', pct], ['found', 'answers found', (v) => `${v}/${off.metrics.n}`],
    ['variableShare5', 'variable share@5', pct], ['testFileShare5', 'test-file share@5', pct],
    ['nonCodeShare5', 'non-code share@5', pct],
  ]
  console.log(`\nIDX-004 — real code path against the live graph (NOT the deployed server)`)
  console.log(`n=${off.metrics.n}  limit=${off.limit}  project=${off.project}\n`)
  console.log('metric              flag OFF     flag ON      delta')
  for (const [key, label, fmt] of rows) {
    const a = off.metrics[key], b = on.metrics[key]
    const d = typeof a === 'number' ? (b - a) : 0
    const sign = d > 0 ? '+' : ''
    console.log(
      `${label.padEnd(20)}${String(fmt(a)).padEnd(13)}${String(fmt(b)).padEnd(13)}`
      + `${sign}${key === 'found' ? d : pct(d)}`,
    )
  }
  console.log('\nper-case rank (OFF -> ON):')
  for (const o of off.results) {
    const n2 = on.results.find((r) => r.id === o.id)
    const a = o.rank ?? 'MISS', b = n2?.rank ?? 'MISS'
    const verdict = a === b ? '' : b === 'MISS' ? 'LOST' : a === 'MISS' ? 'FOUND' : b < a ? 'better' : 'worse'
    console.log(`  ${o.id}  ${String(a).padStart(4)} -> ${String(b).padStart(4)}  ${verdict}`)
  }
  const errs = off.metrics.errors + on.metrics.errors
  if (errs > 0) console.log(`\nWARNING: ${errs} case(s) errored. Metrics above count an errored case as a MISS.`)
}
