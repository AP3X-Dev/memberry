import assert from 'node:assert/strict';
import test from 'node:test';
import { SNAPSHOT_QUERY, snapshotRows, buildReconciliationPlan, applyReconciliation } from '../reconcile-semantic-supersession.mjs';

const record = object => ({ get: key => object[key] });
function fixture() {
  return [{ successorElementId: 'n2', predecessorElementId: 'n1', relationshipElementId: 'r1',
    successor: { id: 'new', tenant_id: 't1', scope: 'project:alpha', valid_at: '2026-01-02T00:00:00.000Z' },
    predecessor: { id: 'old', tenant_id: 't1', scope: 'project:alpha', valid_at: '2026-01-01T00:00:00.000Z' },
    relationship: {} }];
}
function database(initial = fixture()) {
  let state = { rows: structuredClone(initial), receipt: null, epoch: 0 };
  let closed = 0, commits = 0;
  const queries = [];
  let failEpoch = false, constraints = true;
  const driver = { session: () => ({ close: async () => { closed++; },
    executeWrite: async work => {
      const next = structuredClone(state);
      const tx = { run: async (query, params) => {
        queries.push(query);
        const rows = next.rows;
        if (query.startsWith('SHOW CONSTRAINTS')) return { records: constraints ? [
          ['SemanticReconciliation', ['id']], ['Semantic', ['id']], ['KnowledgeEpoch', ['tenant_id', 'project_scope']],
        ].map(([label, properties]) => record({ labelsOrTypes: [label], properties, type: 'UNIQUENESS' })) : [] };
        if (query.includes('MERGE (receipt:')) return { records: [record({ payload: next.receipt })] };
        if (query === SNAPSHOT_QUERY) return { records: rows.map(record) };
        if (query.includes('SET r.__legacy_reconciliation_lock')) return { records: rows.map(r => record({ id: r.relationshipElementId })) };
        if (query.includes('SET n.__legacy_reconciliation_lock')) return { records: [
          record({ id: 'new', elementId: 'n2' }), record({ id: 'old', elementId: 'n1' }),
        ] };
        if (query.includes('SET target.')) {
          const relationship = query.includes('[target:SUPERSEDES]');
          const target = relationship ? rows[0].relationship : rows[0].predecessor;
          const property = relationship ? 'valid_at' : 'invalid_at';
          if (params.value === null) { assert.equal(target[property], params.expected); delete target[property]; }
          else { assert.equal(target[property] ?? null, null); target[property] = params.value; }
          return { records: [record({ id: params.elementId })] };
        }
        if (query.includes('MERGE (epoch:')) {
          if (failEpoch) throw Error('injected epoch failure');
          return { records: [record({ value: String(++next.epoch) })] };
        }
        if (query.includes('SET receipt.payload')) { next.receipt = params.payload; return { records: [] }; }
        throw Error(`unexpected query: ${query}`);
      } };
      const result = await work(tx);
      state = next; commits++; return result;
    },
  }) };
  return { driver, queries, state: () => state, counts: () => ({ closed, commits }),
    drift: () => { state.rows[0].successor.content = 'changed'; },
    failEpoch: () => { failEpoch = true; }, noConstraints: () => { constraints = false; } };
}

test('plan binds full source fingerprints, exact temporal evidence and only null repairs', () => {
  const plan = buildReconciliationPlan(snapshotRows(fixture()));
  assert.equal(plan.components.length, 1);
  assert.deepEqual(plan.components[0].changes.map(c => [c.property, c.before, c.after]), [
    ['invalid_at', null, '2026-01-02T00:00:00.000Z'], ['valid_at', null, '2026-01-02T00:00:00.000Z'],
  ]);
  const changed = fixture(); changed[0].successor.content = 'different';
  assert.notEqual(buildReconciliationPlan(snapshotRows(changed)).planId, plan.planId);
});

test('apply and rollback transact fields, both epochs and durable receipt; replay is idempotent', async () => {
  const db = database(), plan = buildReconciliationPlan(snapshotRows(fixture()));
  const applied = await applyReconciliation(db.driver, plan);
  assert.equal(applied.status, 'applied'); assert.equal(db.state().epoch, 2);
  assert.equal(db.state().rows[0].predecessor.invalid_at, plan.components[0].changes[0].after);
  assert.deepEqual(await applyReconciliation(db.driver, plan), applied);
  assert.equal(db.state().epoch, 2);
  const rolled = await applyReconciliation(db.driver, plan, { rollback: true });
  assert.equal(rolled.status, 'rolled-back'); assert.equal(db.state().epoch, 4);
  assert.deepEqual(db.state().rows, fixture());
  assert.deepEqual(await applyReconciliation(db.driver, plan, { rollback: true }), rolled);
  await assert.rejects(applyReconciliation(db.driver, plan), /already_rolled_back/);
  assert.equal(db.counts().closed, 5);
  assert.ok(db.queries.findIndex(q => q.includes('__legacy_reconciliation_lock')) < db.queries.findIndex(q => q.includes('SET target.')));
});

test('apply refuses post-plan drift and rollback refuses post-apply drift without epoch or temporal writes', async () => {
  const plan = buildReconciliationPlan(snapshotRows(fixture()));
  const before = database(); before.drift();
  await assert.rejects(applyReconciliation(before.driver, plan), /snapshot_drift/);
  assert.equal(before.state().epoch, 0); assert.equal(before.counts().commits, 0);
  const after = database(); await applyReconciliation(after.driver, plan); after.drift();
  await assert.rejects(applyReconciliation(after.driver, plan, { rollback: true }), /snapshot_drift/);
  assert.equal(after.state().epoch, 2); assert.equal(after.counts().commits, 1);
});

test('epoch failure rolls back temporal changes and receipt; missing constraints fail closed', async () => {
  const plan = buildReconciliationPlan(snapshotRows(fixture()));
  const db = database(); db.failEpoch();
  await assert.rejects(applyReconciliation(db.driver, plan), /injected epoch failure/);
  assert.deepEqual(db.state().rows, fixture()); assert.equal(db.state().receipt, null);
  const missing = database(); missing.noConstraints();
  await assert.rejects(applyReconciliation(missing.driver, plan), /required_unique_constraints_missing/);
  assert.equal(missing.counts().commits, 0);
});

test('tampered plans and rollback without a receipt fail before mutation', async () => {
  const plan = buildReconciliationPlan(snapshotRows(fixture()));
  const tampered = structuredClone(plan); tampered.components[0].changes[0].after = '2099-01-01T00:00:00.000Z';
  const db = database();
  await assert.rejects(applyReconciliation(db.driver, tampered), /invalid_plan/);
  await assert.rejects(applyReconciliation(db.driver, plan, { rollback: true }), /receipt_missing/);
  assert.equal(db.state().epoch, 0);
});

test('quarantined, missing tenant and unscoped chains never produce writes', () => {
  for (const modify of [
    row => { row.successor.tenant_id = 'other'; },
    row => { delete row.successor.tenant_id; delete row.predecessor.tenant_id; },
    row => { delete row.successor.scope; delete row.predecessor.scope; },
    row => { delete row.successor.valid_at; },
  ]) {
    const rows = fixture(); modify(rows[0]);
    assert.equal(buildReconciliationPlan(snapshotRows(rows)).components.length, 0);
  }
});
