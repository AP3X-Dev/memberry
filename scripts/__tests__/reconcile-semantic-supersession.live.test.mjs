import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  SNAPSHOT_QUERY, snapshotRows, buildReconciliationPlan, planReconciliation, applyReconciliation,
} from '../reconcile-semantic-supersession.mjs';

const mode = process.env.MEMBERRY_PR01_LIVE;
if (mode !== undefined && mode !== 'required') throw new Error('MEMBERRY_PR01_LIVE must be exactly "required" when set');

test('required disposable Neo4j legacy reconciliation', { skip: mode !== 'required', timeout: 120_000 }, async t => {
  for (const name of ['NEO4J_URI', 'NEO4J_USER', 'NEO4J_PASSWORD']) {
    assert.ok(process.env[name], `required reconciliation fixture needs explicit ${name}`);
  }
  const { default: neo4j } = await import('neo4j-driver');
  const driver = neo4j.driver(process.env.NEO4J_URI, neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD), {
    maxTransactionRetryTime: 5_000, connectionTimeout: 5_000,
  });
  const database = process.env.NEO4J_DATABASE;
  const prefix = `reconcile-live-${randomUUID()}`;
  const receiptIds = new Set();
  let connected = false;
  const start = '2026-01-01T00:00:00.000Z', cutoff = '2026-01-02T00:00:00.000Z';
  async function run(query, params = {}) {
    const session = driver.session(database ? { database } : {});
    try { return await session.run(query, params); } finally { await session.close(); }
  }
  async function seed(suffix, overrides = {}) {
    const tenant = `${prefix}-${suffix}`;
    const ids = [`${tenant}-old`, `${tenant}-new`];
    await run(`CREATE (old:Semantic {id: $oldId, tenant_id: $tenant, scope: 'project:alpha', valid_at: $start})
      CREATE (new:Semantic {id: $newId, tenant_id: $tenant, scope: 'project:alpha', valid_at: $cutoff})
      SET new += $overrides CREATE (new)-[:SUPERSEDES]->(old)`,
    { oldId: ids[0], newId: ids[1], tenant, start, cutoff, overrides });
    return { tenant, ids };
  }
  async function planFor(fixture) {
    const result = await run(SNAPSHOT_QUERY, { ids: fixture.ids });
    const plan = buildReconciliationPlan(snapshotRows(result.records));
    if (plan.components.length) receiptIds.add(plan.planId);
    return plan;
  }
  async function epochs(tenant) {
    const result = await run(`MATCH (epoch:KnowledgeEpoch {tenant_id: $tenant})
      RETURN epoch.project_scope AS scope, toString(epoch.value) AS value ORDER BY scope`, { tenant });
    return Object.fromEntries(result.records.map(r => [r.get('scope'), r.get('value')]));
  }
  async function dates(fixture) {
    const result = await run(`MATCH (new:Semantic {id: $newId})-[r:SUPERSEDES]->(old:Semantic {id: $oldId})
      RETURN old.invalid_at AS invalidAt, r.valid_at AS validAt,
        old.__legacy_reconciliation_lock AS nodeLock, r.__legacy_reconciliation_lock AS edgeLock`,
    { oldId: fixture.ids[0], newId: fixture.ids[1] });
    return result.records[0].toObject();
  }
  try {
    await driver.verifyConnectivity(); connected = true;
    await run('CREATE CONSTRAINT reconciliation_live_semantic_id IF NOT EXISTS FOR (s:Semantic) REQUIRE s.id IS UNIQUE');
    await run('CREATE CONSTRAINT reconciliation_live_receipt_id IF NOT EXISTS FOR (r:SemanticReconciliation) REQUIRE r.id IS UNIQUE');
    await run('CREATE CONSTRAINT reconciliation_live_epoch_scope IF NOT EXISTS FOR (e:KnowledgeEpoch) REQUIRE (e.tenant_id, e.project_scope) IS UNIQUE');

    await t.test('dry-run, concurrent idempotent apply, exact epochs, conditional rollback and replay', async () => {
      const fixture = await seed('happy');
      const readOnly = await planReconciliation(driver, database);
      assert.ok(readOnly.components.some(c => c.nodeIds.includes(fixture.ids[0])));
      assert.deepEqual(await dates(fixture), { invalidAt: null, validAt: null, nodeLock: null, edgeLock: null });
      assert.deepEqual(await epochs(fixture.tenant), {});
      const plan = await planFor(fixture);
      const [first, second] = await Promise.all([
        applyReconciliation(driver, plan, { database }), applyReconciliation(driver, plan, { database }),
      ]);
      assert.deepEqual(first, second); assert.equal(first.status, 'applied');
      assert.deepEqual(await epochs(fixture.tenant), { _unscoped: '1', 'project:alpha': '1' });
      assert.deepEqual(await dates(fixture), { invalidAt: cutoff, validAt: cutoff, nodeLock: null, edgeLock: null });
      assert.equal((await planFor(fixture)).components.length, 0);
      const rollback = await applyReconciliation(driver, plan, { database, rollback: true });
      assert.equal(rollback.status, 'rolled-back');
      assert.deepEqual(await dates(fixture), { invalidAt: null, validAt: null, nodeLock: null, edgeLock: null });
      assert.deepEqual(await epochs(fixture.tenant), { _unscoped: '2', 'project:alpha': '2' });
      assert.deepEqual(await applyReconciliation(driver, plan, { database, rollback: true }), rollback);
      await assert.rejects(applyReconciliation(driver, plan, { database }), /already_rolled_back/);
    });

    await t.test('post-plan property and topology drift abort before repairs or epoch increments', async () => {
      const property = await seed('property'); const propertyPlan = await planFor(property);
      await run('MATCH (s:Semantic {id: $id}) SET s.content = "intervening write"', { id: property.ids[0] });
      await assert.rejects(applyReconciliation(driver, propertyPlan, { database }), /snapshot_drift/);
      assert.deepEqual(await epochs(property.tenant), {});
      assert.equal((await dates(property)).invalidAt, null);
      const topology = await seed('topology'); const topologyPlan = await planFor(topology);
      await run(`MATCH (old:Semantic {id: $id})
        CREATE (other:Semantic {id: $otherId, tenant_id: $tenant, scope: 'project:alpha', valid_at: $cutoff})
        CREATE (other)-[:SUPERSEDES]->(old)`,
      { id: topology.ids[0], otherId: `${topology.tenant}-third`, tenant: topology.tenant, cutoff });
      await assert.rejects(applyReconciliation(driver, topologyPlan, { database }), /snapshot_drift/);
      assert.deepEqual(await epochs(topology.tenant), {});
      const ledger = await run('MATCH (r:SemanticReconciliation) WHERE r.id IN $ids RETURN count(r) AS count',
        { ids: [propertyPlan.planId, topologyPlan.planId] });
      assert.equal(ledger.records[0].get('count').toNumber(), 0);
    });

    await t.test('rollback refuses subsequent relationship drift and preserves committed receipt/epochs', async () => {
      const fixture = await seed('rollback-drift'); const plan = await planFor(fixture);
      const applied = await applyReconciliation(driver, plan, { database });
      await run('MATCH (:Semantic {id: $id})-[r:SUPERSEDES]->() SET r.note = "intervening write"', { id: fixture.ids[1] });
      await assert.rejects(applyReconciliation(driver, plan, { database, rollback: true }), /snapshot_drift/);
      assert.deepEqual(await epochs(fixture.tenant), { _unscoped: '1', 'project:alpha': '1' });
      assert.equal((await dates(fixture)).invalidAt, cutoff);
      const ledger = await run('MATCH (r:SemanticReconciliation {id: $id}) RETURN r.payload AS payload', { id: plan.planId });
      assert.deepEqual(JSON.parse(ledger.records[0].get('payload')), applied);
    });

    await t.test('epoch authority failure rolls back temporal writes and the receipt atomically', async () => {
      const fixture = await seed('epoch-failure'); const plan = await planFor(fixture);
      await run(`CREATE (:KnowledgeEpoch {tenant_id: $tenant, project_scope: 'project:alpha', value: 'invalid'})`,
        { tenant: fixture.tenant });
      await assert.rejects(applyReconciliation(driver, plan, { database }));
      assert.deepEqual(await dates(fixture), { invalidAt: null, validAt: null, nodeLock: null, edgeLock: null });
      assert.deepEqual(await epochs(fixture.tenant), { 'project:alpha': 'invalid' });
      const ledger = await run('MATCH (r:SemanticReconciliation {id: $id}) RETURN count(r) AS count', { id: plan.planId });
      assert.equal(ledger.records[0].get('count').toNumber(), 0);
    });

    await t.test('real cross-scope, missing-evidence and cycle graphs are quarantined', async () => {
      for (const [suffix, overrides, reason] of [
        ['cross-scope', { scope: 'project:foreign' }, 'cross_scope'],
        ['missing-time', { valid_at: null }, 'missing_temporal_evidence'],
      ]) {
        const fixture = await seed(suffix, overrides); const plan = await planFor(fixture);
        assert.equal(plan.components.length, 0); assert.ok(plan.inventory.components[0].reasons.includes(reason));
        assert.deepEqual(await epochs(fixture.tenant), {});
      }
      const cycle = await seed('cycle');
      await run('MATCH (old:Semantic {id: $oldId}), (new:Semantic {id: $newId}) CREATE (old)-[:SUPERSEDES]->(new)',
        { oldId: cycle.ids[0], newId: cycle.ids[1] });
      const plan = await planFor(cycle);
      assert.equal(plan.components.length, 0); assert.ok(plan.inventory.components[0].reasons.includes('cycle'));
    });
  } finally {
    try {
      if (connected) {
        await run('MATCH (s:Semantic) WHERE s.tenant_id STARTS WITH $prefix DETACH DELETE s', { prefix });
        await run('MATCH (e:KnowledgeEpoch) WHERE e.tenant_id STARTS WITH $prefix DELETE e', { prefix });
        await run('MATCH (r:SemanticReconciliation) WHERE r.id IN $ids DELETE r', { ids: [...receiptIds] });
      }
    } finally { await driver.close(); }
  }
});
