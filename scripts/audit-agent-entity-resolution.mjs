#!/usr/bin/env node

// Read-only audit of the Entity names advertised to coding agents in project
// guidance. The report mirrors the resolver's tenant/project containment
// boundary but never creates, links, renames, or archives graph data.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const DEFAULT_CONFIG = 'AGENTS.md'
const DEFAULT_TENANT = 'default'
const MAX_DEPTH = 64

function parseArgs(argv) {
  const args = {
    config: DEFAULT_CONFIG,
    tenant: DEFAULT_TENANT,
    projectScope: undefined,
    projectId: undefined,
    database: undefined,
    json: false,
    failOnDrift: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--config') args.config = argv[++index]
    else if (arg === '--tenant') args.tenant = argv[++index]
    else if (arg === '--project-scope') args.projectScope = argv[++index]
    else if (arg === '--project-id') args.projectId = argv[++index]
    else if (arg === '--database') args.database = argv[++index]
    else if (arg === '--json') args.json = true
    else if (arg === '--fail-on-drift') args.failOnDrift = true
    else if (arg === '--help') {
      console.log('Usage: node scripts/audit-agent-entity-resolution.mjs [--config AGENTS.md] [--tenant default] [--project-scope project:name] [--project-id id] [--database name] [--json] [--fail-on-drift]')
      process.exit(0)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  return args
}

function sectionLines(markdown, heading) {
  const lines = markdown.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === `${heading}:`)
  if (start < 0) return []
  const values = []
  for (const line of lines.slice(start + 1)) {
    if (/^[A-Za-z][A-Za-z ]+:\s*$/.test(line.trim())) break
    const match = /^\s*-\s+(.+?)\s*$/.exec(line)
    if (match) values.push(match[1])
  }
  return values
}

function parseProjectConfig(file) {
  const markdown = readFileSync(file, 'utf8')
  const scope = /^Project Tag:\s*(project:[a-z0-9][a-z0-9._-]*)\s*$/m.exec(markdown)?.[1]
  const entities = sectionLines(markdown, 'Entities')
  const canonical = sectionLines(markdown, 'Canonical Entity IDs')
    .map((line) => /^([^:]+):\s*(\S+)\s*$/.exec(line))
    .filter(Boolean)
    .map((match) => ({ label: match[1].trim(), id: match[2] }))
  if (!scope) throw new Error('agent_entity_audit:missing_project_scope')
  if (entities.length === 0) throw new Error('agent_entity_audit:missing_entities')
  if (canonical.length === 0) throw new Error('agent_entity_audit:missing_project_id')
  return { scope, entities: [...new Set(entities)], projectId: canonical[0].id }
}

function envFile(path) {
  try {
    return Object.fromEntries(readFileSync(path, 'utf8').split(/\r?\n/).flatMap((line) => {
      const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
      if (!match) return []
      const value = match[2].replace(/^(['"])(.*)\1$/, '$2')
      return [[match[1], value]]
    }))
  } catch {
    return {}
  }
}

const PROJECT_QUERY = `
MATCH (root:Entity {id: $projectId, type: 'project'})
RETURN root.id AS id,
       root.name AS name,
       root.scope AS scope,
       toLower(root.name) = substring($projectScope, 8) AS scopeMatches,
       root.tenant_id = $tenantId
         OR (root.tenant_id IS NULL AND $tenantId = $defaultTenant) AS tenantOwned`

const GLOBAL_QUERY = `
UNWIND $entityHints AS hint
OPTIONAL MATCH (candidate:Entity)
WHERE (candidate.tenant_id IS NULL OR candidate.tenant_id = $tenantId)
  AND (toLower(candidate.name) = toLower(hint)
    OR any(alias IN coalesce(candidate.aliases, []) WHERE toLower(alias) = toLower(hint)))
RETURN hint, collect(DISTINCT candidate.id) AS candidateIds
ORDER BY hint`

const REACHABLE_QUERY = `
UNWIND $entityHints AS hint
MATCH authorizedPath = (root:Entity {id: $projectId, type: 'project'})-[:CONTAINS*0..${MAX_DEPTH}]->(candidate:Entity)
WHERE (root.tenant_id = $tenantId
    OR (root.tenant_id IS NULL AND $tenantId = $defaultTenant))
  AND all(scopedNode IN nodes(authorizedPath) WHERE
    (scopedNode.tenant_id IS NULL OR scopedNode.tenant_id = $tenantId)
    AND (scopedNode.type <> 'project' OR scopedNode.id = $projectId))
  AND (toLower(candidate.name) = toLower(hint)
    OR any(alias IN coalesce(candidate.aliases, []) WHERE toLower(alias) = toLower(hint)))
WITH hint, candidate, count(authorizedPath) AS pathCount
RETURN hint, candidate.id AS candidateId, pathCount
ORDER BY hint, candidateId`

function integer(value) {
  return neo4j.isInt(value) ? value.toNumber() : Number(value)
}

async function audit(driver, options) {
  const session = driver.session({
    defaultAccessMode: neo4j.session.READ,
    ...(options.database ? { database: options.database } : {}),
  })
  try {
    return await session.executeRead(async (tx) => {
      const parameters = {
        projectId: options.projectId,
        projectScope: options.projectScope,
        entityHints: options.entities,
        tenantId: options.tenant,
        defaultTenant: DEFAULT_TENANT,
      }
      const projectResult = await tx.run(PROJECT_QUERY, parameters, { timeout: 10_000 })
      if (projectResult.records.length !== 1) throw new Error('agent_entity_audit:project_root_not_unique')
      const root = projectResult.records[0]
      if (root.get('tenantOwned') !== true) throw new Error('agent_entity_audit:project_root_denied')
      if (root.get('scopeMatches') !== true) throw new Error('agent_entity_audit:project_scope_id_mismatch')

      const globalResult = await tx.run(GLOBAL_QUERY, parameters, { timeout: 10_000 })
      const reachableResult = await tx.run(REACHABLE_QUERY, parameters, { timeout: 10_000 })
      const globalByHint = new Map(globalResult.records.map((record) => [
        record.get('hint'),
        record.get('candidateIds').filter((id) => typeof id === 'string'),
      ]))
      const reachableByHint = new Map()
      for (const record of reachableResult.records) {
        const hint = record.get('hint')
        const rows = reachableByHint.get(hint) ?? []
        rows.push({ id: record.get('candidateId'), pathCount: integer(record.get('pathCount')) })
        reachableByHint.set(hint, rows)
      }

      const entities = options.entities.map((name) => {
        const globalIds = globalByHint.get(name) ?? []
        const reachable = reachableByHint.get(name) ?? []
        let status
        if (reachable.length === 0) status = globalIds.length === 0 ? 'missing' : 'uncontained'
        else if (reachable.length !== 1 || reachable.some((row) => row.pathCount !== 1)) status = 'ambiguous'
        else status = 'resolvable'
        return {
          name,
          status,
          global_matches: globalIds.length,
          authorized_matches: reachable.length,
          authorized_paths: reachable.reduce((sum, row) => sum + row.pathCount, 0),
        }
      })
      const counts = Object.fromEntries(['resolvable', 'missing', 'uncontained', 'ambiguous']
        .map((status) => [status, entities.filter((entity) => entity.status === status).length]))
      return {
        schema_version: 1,
        mode: 'read-only',
        config: options.config,
        tenant: options.tenant,
        project: {
          id: root.get('id'),
          name: root.get('name'),
          configured_scope: options.projectScope,
          stored_scope: root.get('scope') ?? null,
        },
        counts: { total: entities.length, ...counts },
        entities,
      }
    })
  } finally {
    await session.close()
  }
}

function printTable(report) {
  console.log(`AGENT-ENTITY-AUDIT mode=${report.mode} project=${report.project.id} tenant=${report.tenant}`)
  console.log(`AGENT-ENTITY-AUDIT total=${report.counts.total} resolvable=${report.counts.resolvable} missing=${report.counts.missing} uncontained=${report.counts.uncontained} ambiguous=${report.counts.ambiguous}`)
  console.table(report.entities)
}

const args = parseArgs(process.argv.slice(2))
const configPath = resolve(args.config)
const config = parseProjectConfig(configPath)
const env = envFile(resolve('.env'))
const uri = process.env.NEO4J_URI || env.NEO4J_URI || 'bolt://localhost:7687'
const user = process.env.NEO4J_USER || env.NEO4J_USER || 'neo4j'
const password = process.env.NEO4J_PASSWORD ?? env.NEO4J_PASSWORD ?? ''
if (!password) throw new Error('agent_entity_audit:missing_neo4j_password')

const { default: neo4j } = await import('neo4j-driver')
const driver = neo4j.driver(uri, neo4j.auth.basic(user, password))
try {
  const report = await audit(driver, {
    config: args.config,
    tenant: args.tenant,
    projectScope: args.projectScope ?? config.scope,
    projectId: args.projectId ?? config.projectId,
    database: args.database,
    entities: config.entities,
  })
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else printTable(report)
  if (args.failOnDrift && report.counts.resolvable !== report.counts.total) process.exitCode = 2
} finally {
  await driver.close()
}
