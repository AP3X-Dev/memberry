#!/usr/bin/env node
// EVAL-001 question selector.
//
// Applies bench/eval/SELECTION-RULE.md to the raw mined population. Every exclusion is
// mechanical, declared in advance, and logged with its ground -- there is no judgment call
// anywhere in this file, which is the point. A silent drop would falsify the result.
//
// Emits questions with EMPTY requiredKeywords by design: SELECTION-RULE.md section 7
// requires keywords to be authored blind, after selection and before any query is run.
// The runner refuses to execute a question with no keywords, so the artifact is inert until
// that step happens.
//
// Usage: node bench/eval/select-questions.mjs [--target 20] [--in <path>] [--out <path>]

import { readFileSync, writeFileSync } from 'node:fs'

const OWN_PROJECT = /^project:(memberry|neuri|hermes-agent|ag3nt|ag3ntic)$/

/** SELECTION-RULE.md A1/E2: projects known to have no index at all. Empty under E5. */
const ZERO_COVERAGE_PROJECTS = new Set()

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'it', 'this', 'that', 'is', 'to', 'of'])

function parseArgs(argv) {
  const args = {
    in: 'bench/eval/mined-queries.jsonl',
    out: 'bench/eval/eval001-questions.jsonl',
    log: 'bench/eval/SELECTION-LOG.md',
    target: 20,
  }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--in') args.in = argv[i + 1]
    if (argv[i] === '--out') args.out = argv[i + 1]
    if (argv[i] === '--log') args.log = argv[i + 1]
    if (argv[i] === '--target') args.target = Number(argv[i + 1])
  }
  return args
}

function scopesOf(row) {
  return [...new Set(JSON.stringify(row.input ?? {}).match(/project:[a-z0-9-]+/g) ?? [])]
}

/**
 * SELECTION-RULE.md section 5.1: the planner requires entity_scope on the candidate-channel
 * path. Surfaced per question so the count is visible before anything is executed.
 */
function entityScopeOf(row) {
  const input = row.input ?? {}
  const raw = input.entity_scope ?? input.entities ?? []
  return Array.isArray(raw) ? raw.map(String) : [String(raw)]
}

const args = parseArgs(process.argv.slice(2))
const mined = readFileSync(args.in, 'utf8').trim().split('\n').map((l) => JSON.parse(l))

/**
 * SELECTION-RULE.md amendment A5, exclusion ground E6 -- THIRD-PARTY TERMS IN QUERY TEXT.
 *
 * E5 excludes by `project:` SCOPE, so an UNSCOPED query carrying third-party content slips
 * through. Found by a pre-commit leak check, not by review. memberry is a PUBLIC repo and the
 * question set is tracked, so a query's TEXT matters as much as its scope.
 *
 * Terms live in `bench/eval/.foreign-terms`, which is GITIGNORED. That is the whole point: a
 * literal denylist in this file would publish the very third-party names the rule exists to keep
 * out of a public repository. One term per line, `#` comments allowed, case-insensitive.
 *
 * If the file is absent, E6 is a no-op and says so loudly rather than silently passing.
 *
 * A FIRST ATTEMPT DERIVED THIS LIST FROM THE MINED SCOPE TAGS AND WAS WRONG: it treated every
 * non-memberry project as third-party, which swept in the owner's OWN sibling projects and cost
 * a scarce code-plane question. Foreign means "someone else's", not "not memberry".
 */
let foreignTerms = []
try {
  foreignTerms = readFileSync('bench/eval/.foreign-terms', 'utf8')
    .split('\n')
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l && !l.startsWith('#'))
} catch {
  console.warn('EVAL001-SELECT WARNING: bench/eval/.foreign-terms not found — E6 is a NO-OP this run.')
}

// ---- Exclusions, applied in declared order, every drop recorded ---------------------------

const excluded = { E1: [], E2: [], E3: [], E4: [], E5: [], E6: [] }
const seenNormalised = new Map()
const survivors = []

for (const row of mined) {
  if (!row.input || typeof row.input !== 'object') {
    excluded.E3.push(row.queryId)
    continue
  }
  const text = row.normalisedText ?? ''
  if (!text || (text.split(' ').length === 1 && STOPWORDS.has(text))) {
    excluded.E4.push(row.queryId)
    continue
  }
  const scopes = scopesOf(row)
  if (scopes.length > 0 && !scopes.every((s) => OWN_PROJECT.test(s))) {
    excluded.E5.push(row.queryId)
    continue
  }
  if (scopes.some((s) => ZERO_COVERAGE_PROJECTS.has(s))) {
    excluded.E2.push(row.queryId)
    continue
  }
  // E6: foreign content in the query TEXT, regardless of scope. Catches unscoped queries E5 misses.
  const haystack = JSON.stringify(row.input ?? {}).toLowerCase()
  if (foreignTerms.some((term) => haystack.includes(term))) {
    excluded.E6.push(row.queryId)
    continue
  }
  if (seenNormalised.has(text)) {
    excluded.E1.push(row.queryId) // mined file is timestamp-ascending, so first seen is earliest
    continue
  }
  seenNormalised.set(text, row.queryId)
  survivors.push({ ...row, scopes })
}

// ---- Stratified fill, section 5.2 ---------------------------------------------------------

const byPlane = (plane) => survivors.filter((r) => r.plane === plane)
const codeAndMixed = [...byPlane('code'), ...byPlane('mixed')].sort((a, b) =>
  String(a.timestamp).localeCompare(String(b.timestamp))
)

const memoryByProject = new Map()
for (const row of byPlane('memory')) {
  const key = row.scopes[0] ?? '(unscoped)'
  if (!memoryByProject.has(key)) memoryByProject.set(key, [])
  memoryByProject.get(key).push(row)
}
for (const list of memoryByProject.values()) {
  list.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
}
// Round-robin across projects ordered by descending population, earliest-first within each.
const projectOrder = [...memoryByProject.entries()].sort((a, b) => b[1].length - a[1].length).map((e) => e[0])
const memoryFill = []
for (let round = 0; ; round += 1) {
  let added = false
  for (const project of projectOrder) {
    const list = memoryByProject.get(project)
    if (round < list.length) {
      memoryFill.push(list[round])
      added = true
    }
  }
  if (!added) break
}

const selected = [...codeAndMixed]
let truncatedCodeAndMixed = 0
if (selected.length > 25) {
  truncatedCodeAndMixed = selected.length - 25
  selected.length = 25
}
for (const row of memoryFill) {
  if (selected.length >= args.target) break
  selected.push(row)
}

// ---- Split assignment, section 6 as amended by A2 ------------------------------------------
//
// Order by round-robin ACROSS strata, then apply one global 3-dev / 2-holdout cycle.
// Cycling per-stratum (the original A0 rule) is degenerate at this set size: most strata
// never reach position 4, so holdout collapses. Round-robin ordering spreads holdout across
// planes and projects; the global cycle makes the 60/40 ratio exact.

// Stratify by PLANE only -- the metrics differ by plane, projects do not change what is
// measured -- and walk strata in the fixed order code -> mixed -> memory with a single
// cursor that never resets. The order is a priori: the code plane carries the primary
// diagnosed defect and is the only plane noiseRate applies to, so it takes the head of the
// cycle to guarantee it lands in BOTH splits. The non-resetting cursor makes the global
// 60/40 exact instead of rounding away inside every small stratum.

const PLANE_ORDER = ['code', 'mixed', 'memory']
const assignmentOrder = PLANE_ORDER.flatMap((plane) =>
  selected
    .filter((r) => r.plane === plane)
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
)
assignmentOrder.forEach((row, position) => {
  row.split = position % 5 < 3 ? 'dev' : 'holdout'
})

// ---- Emit ---------------------------------------------------------------------------------

const questions = selected.map((row, index) => ({
  id: `eval001-${row.split === 'dev' ? 'd' : 'h'}-${String(index + 1).padStart(2, '0')}`,
  split: row.split,
  plane: row.plane,
  tool: row.tool.replace('mcp__memberry__', ''),
  question: row.queryText,
  projectScope: row.scopes[0] ?? null,
  entityScope: entityScopeOf(row),
  requiredKeywords: [], // SELECTION-RULE.md section 7 -- authored blind, in a separate step
  forbiddenKeywords: [],
  sourceOfTruth: '', // mandatory before the runner will execute this question
  addedBecause: `mined from real ${row.tool.replace('mcp__memberry__', '')} call ${row.queryId} at ${row.timestamp}`,
  provenance: { queryId: row.queryId, timestamp: row.timestamp, sessionId: row.sessionId, originalInput: row.input },
}))

writeFileSync(args.out, questions.map((q) => JSON.stringify(q)).join('\n') + '\n', 'utf8')

const noEntityScope = questions.filter((q) => q.entityScope.length === 0)
const counts = {
  mined: mined.length,
  survivors: survivors.length,
  selected: selected.length,
  dev: selected.filter((r) => r.split === 'dev').length,
  holdout: selected.filter((r) => r.split === 'holdout').length,
}

const log = `# EVAL-001 — selection log

Generated by \`node bench/eval/select-questions.mjs\` under
[\`SELECTION-RULE.md\`](SELECTION-RULE.md). Regenerating from the same mined population must
reproduce this file exactly; if it does not, the selection was not mechanical.

**No query has been executed at the time of selection.** Keywords are empty by design
(§7, blind authoring).

## Population and exclusions

| stage | n |
|---|---|
| mined population | ${counts.mined} |
| E1 duplicate (kept earliest) | ${excluded.E1.length} |
| E2 unanswerable by construction | ${excluded.E2.length} |
| E3 malformed | ${excluded.E3.length} |
| E4 degenerate | ${excluded.E4.length} |
| E5 foreign-client scope (amendment A1) | ${excluded.E5.length} |
| E6 foreign content in query text (amendment A5) | ${excluded.E6.length} |
| **surviving pool** | **${counts.survivors}** |
| **selected** | **${counts.selected}** |

Pool by plane: ${['code', 'mixed', 'memory'].map((p) => `${p} ${byPlane(p).length}`).join(', ')}.
${truncatedCodeAndMixed > 0 ? `\n**${truncatedCodeAndMixed} code/mixed queries truncated at the 25 cap**, earliest-first per §5.2.\n` : ''}
## Selected set

| split | n |
|---|---|
| dev | ${counts.dev} |
| holdout | ${counts.holdout} |

By plane: ${['code', 'mixed', 'memory'].map((p) => `${p} ${selected.filter((r) => r.plane === p).length}`).join(', ')}.

## OPEN ISSUE — entity_scope coverage

Spec §5.1: under \`MEMBERRY_CANDIDATE_CHANNEL_V1=1\` the planner **requires** \`entity_scope\`;
omitting it returns \`invalid_request\`, which is not a retrieval failure and must never be
scored as zero.

**${noEntityScope.length} of ${counts.selected} selected questions carry no entity scope**, because the
agent that issued them did not pass one.

This is a real fork and it is recorded rather than silently patched:

- Supplying an entity scope the original call did not have **changes the query**, so it is no
  longer the real traffic that justifies this whole approach.
- Scoring \`invalid_request\` as zero would fabricate a catastrophic regression.
- Dropping them shrinks the set and biases it toward entity-scoped callers.

Questions with no entity scope: ${noEntityScope.map((q) => q.id).join(', ') || '(none)'}

## Exclusion ledger

Query ids are content hashes of the original call, stable across re-mining.

${Object.entries(excluded)
  .filter(([, ids]) => ids.length > 0)
  .map(([ground, ids]) => `- **${ground}** (${ids.length}): ${ids.join(', ')}`)
  .join('\n')}
`

writeFileSync(args.log, log, 'utf8')

console.log(`EVAL001-SELECT mined=${counts.mined} pool=${counts.survivors} selected=${counts.selected} dev=${counts.dev} holdout=${counts.holdout}`)
for (const [ground, ids] of Object.entries(excluded)) {
  console.log(`EVAL001-SELECT excluded=${ground} n=${ids.length}`)
}
for (const plane of ['code', 'mixed', 'memory']) {
  console.log(`EVAL001-SELECT plane=${plane} pool=${byPlane(plane).length} selected=${selected.filter((r) => r.plane === plane).length}`)
}
console.log(`EVAL001-SELECT no-entity-scope=${noEntityScope.length}/${counts.selected}`)
console.log(`EVAL001-SELECT out=${args.out} log=${args.log}`)
