#!/usr/bin/env node
// MEM-1 — what actually occupies the memory plane's delivered slots?
//
// WHY THIS EXISTS. Code search is ~13% of measured call volume. The memory plane —
// berry_load, berry_context, berry_ask — is the other ~87%, and nothing measures whether it
// returns the right thing (RESEARCH-LEDGER.md RL-006). Five ledger entries are parked behind
// "revisit when RL-006 lands" because they cannot be RANKED without a number.
//
// WHY IT NEEDS NO GROUND TRUTH. Two purpose-built instruments have died before producing a
// number, both killed by the same thing: hand-authored relevance labels over a corpus that
// mutates underneath them. This probe asks a strictly structural question instead — of the slots
// the system actually delivered, what KIND were they, and how confident was each? There is no
// expected answer, so a surprising result can never be confused with "the corpus changed".
//
// WHAT IT MEASURES, AND WHAT IT DOES NOT. AMPService.loadFreshObserved already returns a
// structured observation carrying per-candidate sourceType, evidence.confidence, per-channel
// rank, and finalIds in delivered order. The instrument was already built; only this runner was
// missing. It reads that object directly — no markdown parsing, no MCP transport, no LLM.
//
//   * DENOMINATOR. "Delivered slots" means finalIds, which is facts + memories ONLY. MemoryBlock
//     ids never enter it even though blocks are rendered into the markdown, so blocks are
//     reported UNMEASURABLE by this probe, never as zero.
//   * FRESH ASSEMBLY, NOT PRODUCTION. loadFreshObserved passes cacheResult:false, so these
//     shares describe a cold assembly. A cache-hitting user may receive something else.
//   * NOT A BASELINE. bench/eval/BASELINE.md §2.7 voided the EVAL-001 origin. This is a §8
//     sibling probe. Its number must never be quoted beside those figures.
//
// Usage — in the gate container, from a BUILT repo, on the node:22 arm (see NODE ARM below):
//   node bench/eval/memory-occupancy-probe.mjs --dry-run
//   node bench/eval/memory-occupancy-probe.mjs --out /w/occupancy.json
//
// MODULE RESOLUTION. `@memberry/core` is unresolvable by plain node on every version — its
// exports map points at ./src/index.ts, which imports ./types.js, a file that exists only as
// types.ts. `_memberry-core-hooks.mjs` aliases that one specifier to the built dist equivalents;
// see that file for why a shim rather than dist/index.js. If it ever stops working this exits 3
// with a named message rather than crashing obscurely.

import { readFileSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'

register(new URL('./_memberry-core-hooks.mjs', import.meta.url))

const EXIT_BAD_ENV = 2
const EXIT_UNRESOLVABLE = 3

const argv = process.argv.slice(2)
const arg = (flag, fallback) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const DRY_RUN = argv.includes('--dry-run')
const OUT = arg('--out', null)
const TENANT = arg('--tenant', undefined)

// ── corpus ──────────────────────────────────────────────────────────────────
// The 10 committed non-holdout berry_load rows. The sealed holdout is never opened, and neither
// is bench/eval/mined-queries.jsonl — it is gitignored because it carries third-party client
// names and this repo is public.
const CORPUS_FILES = ['bench/eval/eval001-questions.jsonl', 'bench/eval/eval001-pending.jsonl']

function loadCorpus() {
  const cases = []
  for (const file of CORPUS_FILES) {
    let raw
    try { raw = readFileSync(file, 'utf8') } catch { continue }
    for (const line of raw.trim().split('\n')) {
      if (!line.trim()) continue
      const row = JSON.parse(line)
      if (!String(row.tool || '').includes('berry_load')) continue
      if (row.split === 'holdout') continue            // sealed — never replayed
      const input = row.provenance?.originalInput
      if (!input?.task) continue                        // no replayable input
      cases.push({ id: row.id, file, split: row.split, input })
    }
  }
  return cases
}

const cases = loadCorpus()

if (DRY_RUN) {
  console.log(`OCCUPANCY dry-run n=${cases.length}`)
  for (const c of cases) console.log(`  ${c.id}  split=${c.split}  from=${c.file}`)
  console.log('OCCUPANCY holdout rows excluded; mined-queries.jsonl never opened')
  process.exit(0)
}

// ── environment ─────────────────────────────────────────────────────────────
const env = {}
try {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
} catch { /* the container runs on process.env */ }

// Trim every value. A CRLF .env sourced through a shell leaves a trailing carriage return on
// each variable. `fetch` tolerates it in a header but the OpenAI SDK throws APIConnectionError ("Connection
// error."), which reads as a network outage and is not one. The repo already learned this once —
// see e0ccbb3, "Trim env values in the backfill scripts".
const pick = (...vals) => {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim().replace(/^["']|["']$/g, '')
  return undefined
}
const NEO4J_URI = pick(process.env.NEO4J_URI, env.NEO4J_URI) || 'bolt://localhost:7687'
const NEO4J_USER = pick(process.env.NEO4J_USER, env.NEO4J_USER) || 'neo4j'
const NEO4J_PASSWORD = pick(process.env.NEO4J_PASSWORD, env.NEO4J_PASSWORD)
const OPENAI_API_KEY = pick(process.env.OPENAI_API_KEY, env.OPENAI_API_KEY)

if (!NEO4J_PASSWORD) {
  console.error('OCCUPANCY fatal: NEO4J_PASSWORD unset')
  process.exit(EXIT_BAD_ENV)
}
// A run without a key is WORSE than no run: service.ts:1284-1291 makes both vector channels
// return [] as a declared 'safe-failure', so the probe would report confident shares for a
// system that never executed vector recall at all.
if (!OPENAI_API_KEY) {
  console.error('OCCUPANCY fatal: embedding unavailable — OPENAI_API_KEY unset, and both vector channels degrade silently without it')
  process.exit(EXIT_BAD_ENV)
}

// ── module resolution ───────────────────────────────────────────────────────
let AMPService, ScopedQuery, FactStore, neo4jDriver
try {
  ;({ AMPService } = await import('../../packages/core/dist/service.js'))
  // Submodules, not the barrel: dist/index.js re-exports schema.js and friends, which pull in
  // more of @memberry/core than the shim covers. query.js needs only readEnv + DEFAULT_TENANT;
  // fact.js needs nothing from core at all.
  ;({ ScopedQuery } = await import('../../packages/neo4j/dist/query.js'))
  ;({ FactStore } = await import('../../packages/neo4j/dist/fact.js'))
  neo4jDriver = (await import('neo4j-driver')).default
} catch (err) {
  console.error('OCCUPANCY fatal: workspace packages did not resolve.')
  console.error(`  ${err?.code ?? ''} ${err?.message ?? err}`)
  console.error('  Needs a completed `npm ci && npm run build`, and _memberry-core-hooks.mjs must')
  console.error('  be alongside this file — @memberry/core is not resolvable without it.')
  process.exit(EXIT_UNRESOLVABLE)
}

// Raw fetch, not the openai SDK. On node 22.23 with openai 4.104 every embeddings call fails
// with "Premature close" while the identical request over fetch succeeds — verified three for
// three. The SDK buys nothing here, so this drops the dependency rather than pinning around it.
async function embedFetch(input) {
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input }),
  })
  if (!r.ok) throw new Error(`embeddings HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const j = await r.json()
  return j.data.map((d) => d.embedding)
}
const embedding = {
  available: true,
  async embed(text) { return (await embedFetch(text))[0] },
  async embedBatch(texts) { return embedFetch(texts) },
}
if (embedding.available !== true) {
  console.error('OCCUPANCY fatal: embedding unavailable')
  process.exit(EXIT_BAD_ENV)
}

// ── layers ──────────────────────────────────────────────────────────────────
// Redis is stubbed in-process. The read path only needs the embedding cache to be coherent
// within a run; the context cache is deliberately inert because loadFreshObserved is a cold
// assembly by construction (cacheResult:false) and a warm cache would defeat the measurement.
const embCache = new Map()
const redis = {
  cache: {
    async get() { return null },
    async set() {},
    async invalidateByScope() { return 0 },
    async invalidateByNodeId() { return 0 },
  },
  embeddings: {
    async get(content) { return embCache.get(content) ?? null },
    async set(content, vec) { embCache.set(content, vec) },
  },
  dedup: {
    async isDuplicate() { return false },
    async markSeen() {},
    async checkAndMark() { return false },
    async unmark() {},
  },
  signals: { async publish() { return 'probe-noop' } },
  queue: { async incrementScore() { return 0 } },
}

const driver = neo4jDriver.driver(NEO4J_URI, neo4jDriver.auth.basic(NEO4J_USER, NEO4J_PASSWORD))
const query = new ScopedQuery(driver)
const fact = new FactStore(driver)

// Write paths are never exercised by this probe; episodic.* exists only to satisfy the layer
// shape. If any of these is ever called, the run is doing something it must not.
const forbidden = (name) => async () => { throw new Error(`OCCUPANCY invariant: write path ${name} called on a read-only probe`) }
const neo4j = {
  episodic: {
    create: forbidden('episodic.create'),
    linkToAgent: forbidden('episodic.linkToAgent'),
    linkToEntity: forbidden('episodic.linkToEntity'),
    linkToModel: forbidden('episodic.linkToModel'),
    linkSignal: forbidden('episodic.linkSignal'),
  },
  query,
  fact,
}

const config = {
  redis: { url: '' },
  neo4j: { uri: NEO4J_URI, user: NEO4J_USER, password: NEO4J_PASSWORD },
  embedding: { provider: 'openai', apiKey: OPENAI_API_KEY },
  cache: { defaultTTL: 0, contextTTL: 0, embeddingTTL: 0 },
  consolidation: { autoApply: false, signalThreshold: 3 },
  exportPath: '',
  readonly: true,
}

const amp = new AMPService(redis, neo4j, embedding, config)

// ── run ─────────────────────────────────────────────────────────────────────
const median = (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const runs = []
for (const c of cases) {
  // Replay as TASK TEXT. Passing resolvedEntityIds instead would make the episodic channel
  // return [] by design (service.ts:1284-1291) and every slot would come back semantic or fact —
  // a 0% episodic reading that means nothing.
  // Forward EVERY scope field the original call carried. An earlier version passed only task,
  // tags and max_tokens, which silently dropped `entities` on the two cases that had it — and
  // `entities` is what gates the fact fetch (service.ts:408-416), so those runs reported zero
  // facts for a channel the probe itself had disabled. Replay fidelity is the whole point.
  // `resolvedEntityIds` is deliberately NOT forwarded: it is an internal lane that disables the
  // episodic channel by design (service.ts:1284-1291). No mined row carries it.
  const scope = {
    task: c.input.task,
    ...(c.input.entities ? { entities: c.input.entities } : {}),
    ...(c.input.tags ? { tags: c.input.tags } : {}),
    ...(c.input.max_tokens ? { max_tokens: c.input.max_tokens } : {}),
    ...(c.input.temporal ? { temporal: c.input.temporal } : {}),
    ...(c.input.session_id ? { session_id: c.input.session_id } : {}),
    ...(TENANT ? { tenantId: TENANT } : {}),
  }

  try {
    const { observation } = await amp.loadFreshObserved(scope)
    const byId = new Map(observation.candidates.map((k) => [k.privateId, k]))
    const slots = observation.finalIds.map((id, i) => {
      const k = byId.get(id)
      return {
        rank: i + 1,
        sourceType: k?.sourceType ?? 'unknown',
        confidence: k?.evidence?.confidence ?? null,
        channels: k?.channels?.map((ch) => ch.channel) ?? [],
      }
    })
    const episodicChannel = observation.channels.find((ch) => ch.channel === 'memory.episodic-vector')
    runs.push({
      id: c.id,
      slots,
      channels: observation.channels,
      // The distinction MEM-3's gate depends on: "no episodes ranked" is a finding;
      // "the episodic channel never ran" is a broken measurement wearing the same number.
      episodicChannelOutcome: episodicChannel
        ? (episodicChannel.outcome === 'success' ? 'success' : `safe-failure:${episodicChannel.code}`)
        : 'absent',
      factCandidates: observation.candidates.filter((k) => k.sourceType === 'fact').length,
      factDelivered: slots.filter((s) => s.sourceType === 'fact').length,
    })
  } catch (err) {
    runs.push({ id: c.id, error: String(err?.message ?? err), slots: [], channels: [], episodicChannelOutcome: 'error' })
  }
}

// ── report ──────────────────────────────────────────────────────────────────
const allSlots = runs.flatMap((r) => r.slots)
const share = (t) => (allSlots.length ? allSlots.filter((s) => s.sourceType === t).length / allSlots.length : 0)
const confOf = (t) => median(allSlots.filter((s) => s.sourceType === t && typeof s.confidence === 'number').map((s) => s.confidence))

// RL-010 head-to-head: where both kinds were delivered, did the raw episode outrank the
// consolidated semantic? That is the question the confidence:1.0 literal actually poses.
const headToHead = runs
  .filter((r) => r.slots.some((s) => s.sourceType === 'episodic') && r.slots.some((s) => s.sourceType === 'semantic'))
  .map((r) => ({
    id: r.id,
    bestEpisodic: Math.min(...r.slots.filter((s) => s.sourceType === 'episodic').map((s) => s.rank)),
    bestSemantic: Math.min(...r.slots.filter((s) => s.sourceType === 'semantic').map((s) => s.rank)),
  }))

const channelTally = runs.reduce((acc, r) => {
  acc[r.episodicChannelOutcome] = (acc[r.episodicChannelOutcome] ?? 0) + 1
  return acc
}, {})

const pct = (x) => `${(x * 100).toFixed(1)}%`
console.log(`OCCUPANCY n=${runs.length} slots=${allSlots.length} semantic=${pct(share('semantic'))} episodic=${pct(share('episodic'))} fact=${pct(share('fact'))}`)
console.log(`OCCUPANCY medianConfidence semantic=${confOf('semantic') ?? 'n/a'} episodic=${confOf('episodic') ?? 'n/a'} fact=${confOf('fact') ?? 'n/a'}`)
console.log(`OCCUPANCY factCandidates=${runs.reduce((a, r) => a + (r.factCandidates ?? 0), 0)} factDelivered=${runs.reduce((a, r) => a + (r.factDelivered ?? 0), 0)}`)
console.log(`OCCUPANCY episodicChannel=${Object.entries(channelTally).map(([k, v]) => `${k}:${v}`).join(',')}`)
console.log(`OCCUPANCY headToHead=${headToHead.length} episodeAhead=${headToHead.filter((h) => h.bestEpisodic < h.bestSemantic).length}`)
console.log('OCCUPANCY denominator=finalIds(facts+memories); MemoryBlocks UNMEASURABLE (never enter finalIds), not zero')
console.log('OCCUPANCY note=fresh assembly, cacheResult:false — not what a cache-hitting caller receives')

if (OUT) {
  writeFileSync(OUT, JSON.stringify({
    n: runs.length,
    slots: allSlots.length,
    shares: { semantic: share('semantic'), episodic: share('episodic'), fact: share('fact') },
    medianConfidence: { semantic: confOf('semantic'), episodic: confOf('episodic'), fact: confOf('fact') },
    episodicChannel: channelTally,
    headToHead,
    blocks: 'UNMEASURABLE — block ids never enter finalIds',
    cache: 'bypassed (cacheResult:false)',
    runs,
  }, null, 2))
  console.log(`OCCUPANCY wrote ${OUT}`)
}

await driver.close()
