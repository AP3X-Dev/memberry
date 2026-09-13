#!/usr/bin/env node
// Explicit opt-in companion to the read-only inventory. Receipts live in the
// same database transaction as the repair so a lost client response is recoverable.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { buildSupersessionInventory } from './inventory-semantic-supersession.mjs';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const fail = reason => { throw new Error(`semantic_reconciliation:${reason}`); };

export const SNAPSHOT_QUERY = `
MATCH (s:Semantic)-[r:SUPERSEDES]->(p:Semantic)
WHERE $ids IS NULL OR s.id IN $ids OR p.id IN $ids
RETURN elementId(s) AS successorElementId, properties(s) AS successor,
       elementId(p) AS predecessorElementId, properties(p) AS predecessor,
       elementId(r) AS relationshipElementId, properties(r) AS relationship
ORDER BY successorElementId, predecessorElementId, relationshipElementId`;

export function snapshotRows(records) {
  return records.map(record => {
    const get = key => typeof record.get === 'function' ? record.get(key) : record[key];
    const s = get('successor'), p = get('predecessor'), r = get('relationship');
    return {
      successorElementId: get('successorElementId'), predecessorElementId: get('predecessorElementId'),
      relationshipElementId: get('relationshipElementId'),
      successorHash: digest(s), predecessorHash: digest(p), relationshipHash: digest(r),
      successorId: s.id, successorTenantId: s.tenant_id ?? null, successorScope: s.scope ?? null,
      successorTags: s.tags ?? null, successorValidAt: s.valid_at ?? null, successorInvalidAt: s.invalid_at ?? null,
      predecessorId: p.id, predecessorTenantId: p.tenant_id ?? null, predecessorScope: p.scope ?? null,
      predecessorTags: p.tags ?? null, predecessorValidAt: p.valid_at ?? null, predecessorInvalidAt: p.invalid_at ?? null,
      supersedesValidAt: r.valid_at ?? null, supersedesInvalidAt: r.invalid_at ?? null,
    };
  }).sort((a, b) => a.relationshipElementId.localeCompare(b.relationshipElementId));
}

export function buildReconciliationPlan(rows) {
  const inventory = buildSupersessionInventory(rows);
  const components = [];
  const excluded = [];
  for (const component of inventory.components) {
    if (component.status !== 'reconcilable') continue;
    // A migration demands explicit project and tenant authority, even though
    // read-only inventory can describe legacy default/unscoped records.
    if (component.edges.some(e => !/^project:[a-z0-9][a-z0-9._-]{0,127}$/.test(e.scope ?? '')
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(e.tenant ?? ''))) {
      excluded.push({ componentId: component.componentId, reason: 'explicit_project_and_tenant_required' });
      continue;
    }
    const before = rows.filter(r => component.nodeIds.includes(r.successorId));
    if (before.some(r => !r.successorTenantId || !r.predecessorTenantId)) {
      excluded.push({ componentId: component.componentId, reason: 'explicit_tenant_required' });
      continue;
    }
    const identities = new Map();
    for (const row of before) for (const side of ['successor', 'predecessor']) {
      const id = row[`${side}Id`], physical = row[`${side}ElementId`];
      if (!physical || (identities.has(id) && identities.get(id) !== physical)) fail('duplicate_node_identity');
      identities.set(id, physical);
    }
    const changes = component.edges.flatMap(edge => {
      const row = before.find(r => r.successorId === edge.successorId && r.predecessorId === edge.predecessorId);
      return edge.proposedChanges.map(change => ({
        kind: change.target === 'predecessor.invalid_at' ? 'node' : 'relationship',
        elementId: change.target === 'predecessor.invalid_at' ? row.predecessorElementId : row.relationshipElementId,
        property: change.target === 'predecessor.invalid_at' ? 'invalid_at' : 'valid_at',
        before: null, after: change.value,
      }));
    });
    if (changes.length) components.push({ nodeIds: component.nodeIds, tenant: component.edges[0].tenant,
      scope: component.edges[0].scope, before, changes });
  }
  const body = { schemaVersion: 1, components };
  return { ...body, planId: digest(body), inventory, excluded };
}

async function snapshot(tx, ids = null) {
  return snapshotRows((await tx.run(SNAPSHOT_QUERY, { ids })).records);
}

export async function planReconciliation(driver, database) {
  const session = driver.session({ defaultAccessMode: 'READ', ...(database ? { database } : {}) });
  try { return await session.executeRead(async tx => buildReconciliationPlan(await snapshot(tx))); }
  finally { await session.close(); }
}

async function lockAndCheck(tx, expected, nodeIds) {
  const result = await tx.run(`MATCH (n:Semantic) WHERE n.id IN $ids
    WITH n ORDER BY elementId(n)
    SET n.__legacy_reconciliation_lock = true REMOVE n.__legacy_reconciliation_lock
    RETURN n.id AS id, elementId(n) AS elementId`, { ids: nodeIds });
  const physical = new Map();
  for (const row of expected) {
    physical.set(row.successorId, row.successorElementId);
    physical.set(row.predecessorId, row.predecessorElementId);
  }
  if (result.records.length !== physical.size || result.records.some(r => physical.get(r.get('id')) !== r.get('elementId'))) fail('node_identity_drift');
  const lockedEdges = await tx.run(`MATCH ()-[r:SUPERSEDES]->()
    WHERE elementId(r) IN $ids WITH r ORDER BY elementId(r)
    SET r.__legacy_reconciliation_lock = true REMOVE r.__legacy_reconciliation_lock
    RETURN elementId(r) AS id`, { ids: expected.map(row => row.relationshipElementId) });
  if (lockedEdges.records.length !== expected.length) fail('relationship_identity_drift');
  if (digest(await snapshot(tx, nodeIds)) !== digest(expected)) fail('snapshot_drift');
}

async function mutate(tx, change, rollback) {
  const node = change.kind === 'node';
  if (!(node && change.property === 'invalid_at') && !(!node && change.kind === 'relationship' && change.property === 'valid_at')) fail('invalid_change');
  const result = await tx.run(`MATCH ${node ? '(target:Semantic)' : '()-[target:SUPERSEDES]->()'}
    WHERE elementId(target) = $elementId
      AND ${rollback ? `target.${change.property} = $expected` : `target.${change.property} IS NULL`}
    SET target.${change.property} = $value RETURN elementId(target) AS id`, {
    elementId: change.elementId, expected: change.after, value: rollback ? null : change.after,
  });
  if (result.records.length !== 1) fail('conditional_write_failed');
}

async function bump(tx, tenant, scope) {
  for (const project of [scope, '_unscoped']) {
    const result = await tx.run(`MERGE (epoch:KnowledgeEpoch {tenant_id: $tenant, project_scope: $project})
      ON CREATE SET epoch.value = 0 SET epoch.value = epoch.value + 1
      RETURN toString(epoch.value) AS value`, { tenant, project });
    if (result.records.length !== 1 || !/^[1-9][0-9]*$/.test(result.records[0].get('value'))) fail('epoch_authority_invalid');
  }
}

export async function applyReconciliation(driver, plan, { database, rollback = false } = {}) {
  // Recompute proposals from captured evidence. Caller-supplied patch targets
  // or values cannot turn a dry-run artifact into an arbitrary graph write.
  const rebuilt = buildReconciliationPlan(plan.components.flatMap(c => c.before));
  if (rebuilt.planId !== plan.planId || digest(rebuilt.components) !== digest(plan.components)) fail('invalid_plan');
  const session = driver.session({ defaultAccessMode: 'WRITE', ...(database ? { database } : {}) });
  try {
    return await session.executeWrite(async tx => {
      // Schema is installed separately by an operator; never silently add DDL.
      const constraints = await tx.run('SHOW CONSTRAINTS YIELD labelsOrTypes, properties, type RETURN labelsOrTypes, properties, type');
      const unique = (label, props) => constraints.records.some(r => r.get('type').includes('UNIQUENESS')
        && r.get('labelsOrTypes').includes(label) && digest([...r.get('properties')].sort()) === digest([...props].sort()));
      if (!unique('SemanticReconciliation', ['id']) || !unique('Semantic', ['id'])
        || !unique('KnowledgeEpoch', ['tenant_id', 'project_scope'])) fail('required_unique_constraints_missing');
      const ledger = await tx.run(`MERGE (receipt:SemanticReconciliation {id: $id})
        SET receipt.__lock = true REMOVE receipt.__lock
        RETURN receipt.payload AS payload`, { id: plan.planId });
      if (ledger.records.length !== 1) fail('receipt_identity_invalid');
      const previous = ledger.records[0].get('payload');
      const receipt = previous ? JSON.parse(previous) : null;
      if (rollback && !receipt) fail('receipt_missing');
      if (receipt && receipt.planId !== plan.planId) fail('receipt_plan_mismatch');
      if (receipt && ((!rollback && receipt.status === 'applied') || (rollback && receipt.status === 'rolled-back'))) return receipt;
      if (receipt && !rollback) fail('already_rolled_back');
      // Lock and validate all components before the first temporal mutation.
      for (let i = 0; i < plan.components.length; i++) {
        const c = plan.components[i];
        await lockAndCheck(tx, rollback ? receipt.after[i] : c.before, c.nodeIds);
      }
      for (const c of plan.components) {
        for (const change of c.changes) await mutate(tx, change, rollback);
        await bump(tx, c.tenant, c.scope);
      }
      const after = [];
      for (const c of plan.components) after.push(await snapshot(tx, c.nodeIds));
      const output = { schemaVersion: 1, planId: plan.planId, status: rollback ? 'rolled-back' : 'applied',
        // Operational timestamp only; never used as historical semantic evidence.
        recordedAt: new Date().toISOString(), after, changes: plan.components.reduce((n, c) => n + c.changes.length, 0) };
      await tx.run('MATCH (receipt:SemanticReconciliation {id: $id}) SET receipt.payload = $payload',
        { id: plan.planId, payload: JSON.stringify(output) });
      return output;
    }, { timeout: 30_000 });
  } finally { await session.close(); }
}

async function main() {
  const [mode, artifact, output] = process.argv.slice(2);
  if (!['--plan', '--apply', '--rollback'].includes(mode) || !artifact || (mode !== '--plan' && !output)) {
    throw new Error('Usage: node scripts/reconcile-semantic-supersession.mjs --plan plan.json | --apply plan.json receipt.json | --rollback plan.json receipt.json; explicit NEO4J_URI/USER/PASSWORD required');
  }
  for (const name of ['NEO4J_URI', 'NEO4J_USER', 'NEO4J_PASSWORD']) if (!process.env[name]) fail(`missing_${name}`);
  const { default: neo4j } = await import('neo4j-driver');
  const driver = neo4j.driver(process.env.NEO4J_URI, neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD));
  try {
    const result = mode === '--plan' ? await planReconciliation(driver, process.env.NEO4J_DATABASE)
      : await applyReconciliation(driver, JSON.parse(await readFile(artifact, 'utf8')),
        { database: process.env.NEO4J_DATABASE, rollback: mode === '--rollback' });
    await writeFile(mode === '--plan' ? artifact : output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  } finally { await driver.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
});
