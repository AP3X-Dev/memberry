#!/usr/bin/env node
// RET-Q-002 episodic embedding qualification.
//
// Reuses the adjudicated Episodic cases in outcome-cases.jsonl and the live authorized corpus.
// It is deliberately read-only: challenger vectors live only in this process and no Neo4j
// property or index is created. The stored incumbent is compared against both sides of the
// indexing equation:
//   1. representation: content alone vs task + content
//   2. model: text-embedding-3-small vs a configurable stronger challenger
//
// Run inside an environment that already has NEO4J_URI/USER/PASSWORD and OPENAI_API_KEY, e.g.:
//   node bench/eval/qualify-episodic-embeddings.mjs

import { readFileSync } from 'node:fs'
import neo4j from 'neo4j-driver'
import OpenAI from 'openai'

const DEFAULT_CASES = 'bench/eval/outcome-cases.jsonl'
const DEFAULT_CHALLENGER = 'text-embedding-3-large'
const DEFAULT_TENANT = 'default'
const BATCH_SIZE = 48

function parseArgs(argv) {
  const args = {
    cases: DEFAULT_CASES,
    challenger: process.env.MEMBERRY_EMBEDDING_CHALLENGER_MODEL || DEFAULT_CHALLENGER,
  }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--cases') args.cases = argv[index + 1]
    if (argv[index] === '--challenger') args.challenger = argv[index + 1]
  }
  return args
}

function requireEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function projectScope(value) {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!normalized) throw new Error('episodic case has no project_name')
  return normalized.startsWith('project:') ? normalized : `project:${normalized}`
}

function entityHints(input) {
  return [...new Set((input?.entity_scope ?? []).map((value) => String(value).trim()).filter(Boolean))]
}

function taskContentDocument(episode) {
  const task = String(episode.task ?? '').trim()
  const content = String(episode.content ?? '').trim()
  return task ? `Task: ${task}\n\nMemory:\n${content}` : content
}

function cosine(left, right) {
  if (left.length !== right.length || left.length === 0) return Number.NEGATIVE_INFINITY
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  if (leftNorm === 0 || rightNorm === 0) return Number.NEGATIVE_INFINITY
  return dot / Math.sqrt(leftNorm * rightNorm)
}

async function embedBatches(client, model, texts) {
  const vectors = []
  for (let offset = 0; offset < texts.length; offset += BATCH_SIZE) {
    const input = texts.slice(offset, offset + BATCH_SIZE)
    const response = await client.embeddings.create({ model, input })
    const ordered = response.data.slice().sort((left, right) => left.index - right.index)
    if (ordered.length !== input.length) throw new Error(`${model} returned an incomplete embedding batch`)
    vectors.push(...ordered.map((item) => item.embedding))
  }
  return vectors
}

function scoreConfiguration(cases, corpusByGroup, documentVectors, queryVectors) {
  return cases.map((testCase, caseIndex) => {
    const corpus = corpusByGroup.get(testCase.group)
    const vectors = documentVectors.get(testCase.group)
    const ranked = corpus.map((episode, index) => ({
      id: episode.id,
      score: cosine(queryVectors[caseIndex], vectors[index]),
    })).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    const expected = new Set(testCase.expectEvidenceIds)
    const rankIndex = ranked.findIndex((item) => expected.has(item.id))
    return {
      id: testCase.id,
      rank: rankIndex < 0 ? null : rankIndex + 1,
      expected: testCase.expectEvidenceIds,
      top5: ranked.slice(0, 5).map((item) => item.id),
    }
  })
}

function report(name, rows) {
  const at = (limit) => rows.filter((row) => row.rank !== null && row.rank <= limit).length
  const mrr = rows.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / (rows.length || 1)
  console.log(
    `EPISODIC-QUAL config=${name} n=${rows.length} answerAt5=${(at(5) / rows.length).toFixed(4)}` +
    ` answerAt10=${(at(10) / rows.length).toFixed(4)} answerAt20=${(at(20) / rows.length).toFixed(4)}` +
    ` answerAt50=${(at(50) / rows.length).toFixed(4)} answerAt65=${(at(65) / rows.length).toFixed(4)}` +
    ` mrr=${mrr.toFixed(4)}`,
  )
  for (const row of rows) {
    console.log(`EPISODIC-QUAL config=${name} case=${row.id} rank=${row.rank ?? 'MISS'} top5=${row.top5.join(',')}`)
  }
}

const args = parseArgs(process.argv.slice(2))
const allCases = readFileSync(args.cases, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line))
const cases = allCases.filter((testCase) => testCase.plane === 'episodic' && testCase.adjudication !== 'invalid').map((testCase) => {
  const input = testCase.input ?? {}
  const hints = entityHints(input)
  if (hints.length === 0) throw new Error(`episodic case ${testCase.id} has no entity_scope`)
  const scope = projectScope(input.project_name)
  return {
    ...testCase,
    expectEvidenceIds: testCase.expectEvidenceIds ?? [testCase.expectEvidenceId],
    group: JSON.stringify([scope, hints.slice().sort()]),
    scope,
    hints,
  }
})
if (cases.length === 0) throw new Error('no episodic cases found')

const driver = neo4j.driver(
  requireEnv('NEO4J_URI'),
  neo4j.auth.basic(requireEnv('NEO4J_USER'), requireEnv('NEO4J_PASSWORD')),
)
const openai = new OpenAI({ apiKey: requireEnv('OPENAI_API_KEY') })

try {
  const corpusByGroup = new Map()
  for (const testCase of cases) {
    if (corpusByGroup.has(testCase.group)) continue
    const session = driver.session({ defaultAccessMode: neo4j.session.READ })
    try {
      const result = await session.run(
        `MATCH (ep:Episodic)-[reference:REFERENCES]->(entity:Entity)
         WHERE (ep.tenant_id = $tenant OR (ep.tenant_id IS NULL AND $tenant = $defaultTenant))
           AND (ep.scope = $scope OR $scope IN coalesce(ep.tags, []))
           AND coalesce(ep.archived, false) = false
           AND reference.invalid_at IS NULL
           AND (entity.id IN $hints OR toLower(entity.name) IN $lowerHints)
           AND ep.embedding IS NOT NULL
           AND coalesce(ep.content, '') <> ''
         RETURN DISTINCT ep.id AS id, ep.task AS task, ep.content AS content, ep.embedding AS embedding
         ORDER BY id`,
        {
          tenant: DEFAULT_TENANT,
          defaultTenant: DEFAULT_TENANT,
          scope: testCase.scope,
          hints: testCase.hints,
          lowerHints: testCase.hints.map((hint) => hint.toLowerCase()),
        },
      )
      const corpus = result.records.map((record) => ({
        id: record.get('id'),
        task: record.get('task'),
        content: record.get('content'),
        embedding: record.get('embedding'),
      }))
      if (corpus.length === 0) throw new Error(`authorized corpus is empty for ${testCase.group}`)
      corpusByGroup.set(testCase.group, corpus)
      console.log(`EPISODIC-QUAL corpus=${testCase.group} n=${corpus.length}`)
    } finally {
      await session.close()
    }
  }

  const smallQueryVectors = await embedBatches(openai, 'text-embedding-3-small', cases.map((item) => item.question))
  const incumbentVectors = new Map([...corpusByGroup].map(([group, corpus]) => [
    group,
    corpus.map((episode) => episode.embedding),
  ]))
  report('small-content-v1-stored', scoreConfiguration(cases, corpusByGroup, incumbentVectors, smallQueryVectors))

  const configurations = [
    { name: 'small-task-content-v2', model: 'text-embedding-3-small', document: taskContentDocument, queries: smallQueryVectors },
    { name: 'challenger-content-v1', model: args.challenger, document: (episode) => episode.content },
    { name: 'challenger-task-content-v2', model: args.challenger, document: taskContentDocument },
  ]
  for (const configuration of configurations) {
    const queryVectors = configuration.queries ?? await embedBatches(
      openai,
      configuration.model,
      cases.map((item) => item.question),
    )
    const documentVectors = new Map()
    for (const [group, corpus] of corpusByGroup) {
      documentVectors.set(
        group,
        await embedBatches(openai, configuration.model, corpus.map(configuration.document)),
      )
    }
    report(configuration.name, scoreConfiguration(cases, corpusByGroup, documentVectors, queryVectors))
  }
} finally {
  await driver.close()
}
