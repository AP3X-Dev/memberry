#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_TENANT = 'default';

export const SUPERSESSION_INVENTORY_QUERY = `
MATCH (successor:Semantic)-[supersedes:SUPERSEDES]->(predecessor:Semantic)
RETURN successor.id AS successorId,
       successor.tenant_id AS successorTenantId,
       successor.scope AS successorScope,
       successor.tags AS successorTags,
       successor.valid_at AS successorValidAt,
       successor.invalid_at AS successorInvalidAt,
       predecessor.id AS predecessorId,
       predecessor.tenant_id AS predecessorTenantId,
       predecessor.scope AS predecessorScope,
       predecessor.tags AS predecessorTags,
       predecessor.valid_at AS predecessorValidAt,
       predecessor.invalid_at AS predecessorInvalidAt,
       supersedes.valid_at AS supersedesValidAt,
       supersedes.invalid_at AS supersedesInvalidAt
ORDER BY successorId, predecessorId`;

function canonicalScope(scope, tags) {
  const explicit = typeof scope === 'string' ? scope.trim().toLowerCase() : null;
  const projectTags = [...new Set((Array.isArray(tags) ? tags : [])
    .filter((value) => typeof value === 'string' && /^project:/i.test(value))
    .map((value) => value.toLowerCase()))].sort();
  const ambiguous = explicit === '' || explicit === 'project:' || explicit?.includes('*')
    || projectTags.some((tag) => tag === 'project:' || tag.includes('*')) || projectTags.length > 1
    || (explicit !== null && projectTags.some((tag) => tag !== explicit));
  return { identity: explicit || projectTags[0] || null, ambiguous };
}

function timestamp(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    || Number.isNaN(Date.parse(value))) return 'malformed';
  const normalized = new Date(value).toISOString();
  // Date.parse accepts impossible calendar days by rolling into the next month.
  if (normalized.slice(0, 19) !== value.slice(0, 19)) return 'malformed';
  return normalized;
}

function requiredId(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`semantic_supersession_inventory:invalid_${field}`);
  }
  return value;
}

function normalizeRow(row) {
  const successorId = requiredId(row.successorId, 'successor_id');
  const predecessorId = requiredId(row.predecessorId, 'predecessor_id');
  const successorScope = canonicalScope(row.successorScope, row.successorTags);
  const predecessorScope = canonicalScope(row.predecessorScope, row.predecessorTags);
  return {
    successor: {
      id: successorId,
      tenant: typeof row.successorTenantId === 'string' ? row.successorTenantId : DEFAULT_TENANT,
      scope: successorScope.identity,
      scopeAmbiguous: successorScope.ambiguous,
      validAt: timestamp(row.successorValidAt),
      invalidAt: timestamp(row.successorInvalidAt),
    },
    predecessor: {
      id: predecessorId,
      tenant: typeof row.predecessorTenantId === 'string' ? row.predecessorTenantId : DEFAULT_TENANT,
      scope: predecessorScope.identity,
      scopeAmbiguous: predecessorScope.ambiguous,
      validAt: timestamp(row.predecessorValidAt),
      invalidAt: timestamp(row.predecessorInvalidAt),
    },
    relationship: {
      validAt: timestamp(row.supersedesValidAt),
      invalidAt: timestamp(row.supersedesInvalidAt),
    },
  };
}

function hasCycle(edges, nodeIds) {
  const indegree = new Map(nodeIds.map((id) => [id, 0]));
  const outgoing = new Map(nodeIds.map((id) => [id, []]));
  for (const edge of edges) {
    outgoing.get(edge.successor.id).push(edge.predecessor.id);
    indegree.set(edge.predecessor.id, indegree.get(edge.predecessor.id) + 1);
  }
  const ready = [...nodeIds].filter((id) => indegree.get(id) === 0).sort();
  let visited = 0;
  while (ready.length > 0) {
    const id = ready.shift();
    visited += 1;
    for (const target of outgoing.get(id).sort()) {
      const next = indegree.get(target) - 1;
      indegree.set(target, next);
      if (next === 0) {
        ready.push(target);
        ready.sort();
      }
    }
  }
  return visited !== nodeIds.length;
}

function edgeTemporalEvidence(edge) {
  const named = [
    ['successor.valid_at', edge.successor.validAt],
    ['predecessor.invalid_at', edge.predecessor.invalidAt],
    ['supersedes.valid_at', edge.relationship.validAt],
  ];
  const malformed = named.filter(([, value]) => value === 'malformed').map(([source]) => source);
  const available = named.filter(([, value]) => typeof value === 'string' && value !== 'malformed');
  const values = [...new Set(available.map(([, value]) => value))].sort();
  return {
    sources: available.map(([source, value]) => ({ source, value })),
    malformed,
    cutoff: values.length === 1 ? values[0] : null,
    conflicting: values.length > 1,
  };
}

function componentReport(edges) {
  const nodeIds = [...new Set(edges.flatMap((edge) => [edge.successor.id, edge.predecessor.id]))].sort();
  const reasons = new Set();
  const successorCounts = new Map();
  const predecessorCounts = new Map();

  for (const edge of edges) {
    predecessorCounts.set(edge.successor.id, (predecessorCounts.get(edge.successor.id) ?? 0) + 1);
    successorCounts.set(edge.predecessor.id, (successorCounts.get(edge.predecessor.id) ?? 0) + 1);
    if (edge.successor.tenant !== edge.predecessor.tenant) reasons.add('cross_tenant');
    if (edge.successor.scopeAmbiguous || edge.predecessor.scopeAmbiguous) reasons.add('ambiguous_scope');
    if (edge.successor.scope !== edge.predecessor.scope) reasons.add('cross_scope');
    if (edge.successor.invalidAt === 'malformed' || edge.predecessor.validAt === 'malformed'
      || edge.relationship.invalidAt === 'malformed') reasons.add('malformed_temporal_evidence');
    const temporal = edgeTemporalEvidence(edge);
    if (temporal.malformed.length > 0) reasons.add('malformed_temporal_evidence');
    if (temporal.sources.length === 0) reasons.add('missing_temporal_evidence');
    if (temporal.conflicting) reasons.add('conflicting_temporal_evidence');
    if (temporal.cutoff && edge.predecessor.validAt
      && edge.predecessor.validAt !== 'malformed'
      && edge.predecessor.validAt >= temporal.cutoff) reasons.add('invalid_temporal_order');
    if (temporal.cutoff && [edge.successor.invalidAt, edge.relationship.invalidAt]
      .some(value => value && value !== 'malformed' && value <= temporal.cutoff)) {
      reasons.add('invalid_temporal_order');
    }
    if (edge.successor.validAt && edge.successor.invalidAt
      && edge.successor.validAt !== 'malformed' && edge.successor.invalidAt !== 'malformed'
      && edge.successor.validAt >= edge.successor.invalidAt) reasons.add('invalid_temporal_order');
  }
  // Missing node dates may still have evidence on the neighbouring edge.
  // Check inferred boundaries across the complete chain before proposing repairs.
  const cutoffs = new Map(edges.map(edge => [edge.successor.id, edgeTemporalEvidence(edge).cutoff]));
  for (const edge of edges) {
    const start = cutoffs.get(edge.predecessor.id), end = edgeTemporalEvidence(edge).cutoff;
    if (start && end && start >= end) reasons.add('invalid_temporal_order');
  }
  if ([...successorCounts.values()].some((count) => count > 1)) reasons.add('conflicting_successors');
  if ([...predecessorCounts.values()].some((count) => count > 1)) reasons.add('multiple_predecessors');
  if (hasCycle(edges, nodeIds)) reasons.add('cycle');

  const edgeReports = edges
    .map((edge) => {
      const temporal = edgeTemporalEvidence(edge);
      return {
        successorId: edge.successor.id,
        predecessorId: edge.predecessor.id,
        tenant: edge.successor.tenant === edge.predecessor.tenant ? edge.successor.tenant : null,
        scope: edge.successor.scope === edge.predecessor.scope ? edge.successor.scope : null,
        temporalEvidence: temporal.sources,
        malformedTemporalSources: temporal.malformed,
        cutoff: temporal.cutoff,
        proposedChanges: temporal.cutoff === null ? [] : [
          ...(edge.predecessor.invalidAt === null
            ? [{ target: 'predecessor.invalid_at', value: temporal.cutoff }]
            : []),
          ...(edge.relationship.validAt === null
            ? [{ target: 'supersedes.valid_at', value: temporal.cutoff }]
            : []),
        ],
      };
    })
    .sort((a, b) => a.successorId.localeCompare(b.successorId)
      || a.predecessorId.localeCompare(b.predecessorId));

  const sortedReasons = [...reasons].sort();
  return {
    componentId: nodeIds[0],
    status: sortedReasons.length === 0 ? 'reconcilable' : 'quarantine',
    reasons: sortedReasons,
    nodeIds,
    edges: edgeReports,
  };
}

export function buildSupersessionInventory(rawRows) {
  if (!Array.isArray(rawRows)) throw new Error('semantic_supersession_inventory:invalid_rows');
  const edges = rawRows.map(normalizeRow).sort((a, b) =>
    a.successor.id.localeCompare(b.successor.id) || a.predecessor.id.localeCompare(b.predecessor.id));
  const duplicate = edges.find((edge, index) => index > 0
    && edge.successor.id === edges[index - 1].successor.id
    && edge.predecessor.id === edges[index - 1].predecessor.id);
  if (duplicate) throw new Error('semantic_supersession_inventory:duplicate_edge');

  const adjacent = new Map();
  for (const edge of edges) {
    for (const id of [edge.successor.id, edge.predecessor.id]) {
      if (!adjacent.has(id)) adjacent.set(id, new Set());
    }
    adjacent.get(edge.successor.id).add(edge.predecessor.id);
    adjacent.get(edge.predecessor.id).add(edge.successor.id);
  }

  const components = [];
  const visited = new Set();
  for (const start of [...adjacent.keys()].sort()) {
    if (visited.has(start)) continue;
    const pending = [start];
    const ids = new Set();
    while (pending.length > 0) {
      const id = pending.shift();
      if (visited.has(id)) continue;
      visited.add(id);
      ids.add(id);
      pending.push(...[...adjacent.get(id)].sort());
    }
    components.push(componentReport(edges.filter((edge) =>
      ids.has(edge.successor.id) && ids.has(edge.predecessor.id))));
  }
  components.sort((a, b) => a.componentId.localeCompare(b.componentId));

  const reconcilable = components.filter((component) => component.status === 'reconcilable').length;
  return {
    schemaVersion: 1,
    mode: 'read-only-dry-run',
    mutationPerformed: false,
    counts: {
      edges: edges.length,
      components: components.length,
      reconcilable,
      quarantine: components.length - reconcilable,
    },
    components,
  };
}

function recordObject(record) {
  return Object.fromEntries([
    'successorId', 'successorTenantId', 'successorScope', 'successorTags',
    'successorValidAt', 'successorInvalidAt', 'predecessorId', 'predecessorTenantId',
    'predecessorScope', 'predecessorTags', 'predecessorValidAt', 'predecessorInvalidAt',
    'supersedesValidAt', 'supersedesInvalidAt',
  ].map((key) => [key, record.get(key)]));
}

export async function inventorySemanticSupersession(driver, database) {
  const session = driver.session({
    defaultAccessMode: 'READ',
    ...(database ? { database } : {}),
  });
  try {
    const result = await session.executeRead((tx) =>
      tx.run(SUPERSESSION_INVENTORY_QUERY, {}, { timeout: 15_000 }));
    return buildSupersessionInventory(result.records.map(recordObject));
  } finally {
    await session.close();
  }
}

function parseArgs(argv) {
  const options = { database: undefined, output: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--database') options.database = argv[++index];
    else if (arg === '--output') options.output = argv[++index];
    else if (arg === '--dry-run') continue;
    else if (arg === '--help') {
      return { help: true };
    } else {
      throw new Error(`semantic_supersession_inventory:unknown_argument:${arg}`);
    }
  }
  return options;
}

async function envFile(path) {
  try {
    return Object.fromEntries((await readFile(path, 'utf8')).split(/\r?\n/).flatMap((line) => {
      const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      return match ? [[match[1], match[2].replace(/^(['"])(.*)\1$/, '$2')]] : [];
    }));
  } catch {
    return {};
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/inventory-semantic-supersession.mjs [--dry-run] [--database name] [--output report.json]');
    return;
  }
  const fileEnv = await envFile(resolve('.env'));
  const uri = process.env.NEO4J_URI || fileEnv.NEO4J_URI || 'bolt://localhost:7687';
  const user = process.env.NEO4J_USER || fileEnv.NEO4J_USER || 'neo4j';
  const password = process.env.NEO4J_PASSWORD ?? fileEnv.NEO4J_PASSWORD ?? '';
  if (!password) throw new Error('semantic_supersession_inventory:missing_neo4j_password');

  const { default: neo4j } = await import('neo4j-driver');
  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  try {
    const report = await inventorySemanticSupersession(driver, options.database);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output) await writeFile(resolve(options.output), serialized, { encoding: 'utf8', flag: 'wx' });
    else process.stdout.write(serialized);
  } finally {
    await driver.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
