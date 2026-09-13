import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SUPERSESSION_INVENTORY_QUERY,
  buildSupersessionInventory,
  inventorySemanticSupersession,
} from '../inventory-semantic-supersession.mjs';

function edge(successorId, predecessorId, overrides = {}) {
  return {
    successorId,
    successorTenantId: 'tenant-a',
    successorScope: 'project:alpha',
    successorTags: ['project:alpha'],
    successorValidAt: `2026-01-0${successorId.at(-1)}T00:00:00.000Z`,
    successorInvalidAt: null,
    predecessorId,
    predecessorTenantId: 'tenant-a',
    predecessorScope: 'project:alpha',
    predecessorTags: ['project:alpha'],
    predecessorValidAt: '2025-01-01T00:00:00.000Z',
    predecessorInvalidAt: null,
    supersedesValidAt: null,
    supersedesInvalidAt: null,
    ...overrides,
  };
}

test('classifies a unique same-scope chain as reconcilable using only recorded evidence', () => {
  const report = buildSupersessionInventory([
    edge('sem-3', 'sem-2'),
    edge('sem-2', 'sem-1'),
  ]);

  assert.deepEqual(report.counts, { edges: 2, components: 1, reconcilable: 1, quarantine: 0 });
  assert.equal(report.mode, 'read-only-dry-run');
  assert.equal(report.mutationPerformed, false);
  assert.equal(report.components[0].status, 'reconcilable');
  assert.deepEqual(report.components[0].reasons, []);
  assert.deepEqual(report.components[0].nodeIds, ['sem-1', 'sem-2', 'sem-3']);
  assert.deepEqual(report.components[0].edges[0].proposedChanges, [
    { target: 'predecessor.invalid_at', value: '2026-01-02T00:00:00.000Z' },
    { target: 'supersedes.valid_at', value: '2026-01-02T00:00:00.000Z' },
  ]);
});

test('quarantines cycles and conflicting successors', () => {
  const report = buildSupersessionInventory([
    edge('sem-2', 'sem-1'),
    edge('sem-3', 'sem-1'),
    edge('sem-1', 'sem-3', { successorValidAt: '2026-01-01T00:00:00.000Z' }),
  ]);

  assert.equal(report.components[0].status, 'quarantine');
  assert.deepEqual(report.components[0].reasons, ['conflicting_successors', 'cycle', 'invalid_temporal_order']);
});

test('quarantines cross-tenant, cross-scope, and ambiguous branching edges', () => {
  const report = buildSupersessionInventory([
    edge('sem-3', 'sem-2', { predecessorTenantId: 'tenant-b' }),
    edge('sem-3', 'sem-1', {
      predecessorScope: 'project:beta',
      predecessorTags: ['project:beta'],
    }),
  ]);

  assert.deepEqual(report.components[0].reasons, [
    'cross_scope',
    'cross_tenant',
    'multiple_predecessors',
  ]);
  assert.equal(report.components[0].status, 'quarantine');
});

test('uses canonical project tags for legacy scope but quarantines missing or conflicting time', () => {
  const sameLegacyScope = edge('sem-2', 'sem-1', {
    successorScope: null,
    successorTags: ['PROJECT:ALPHA'],
    predecessorScope: null,
    predecessorTags: ['project:alpha'],
  });
  assert.equal(buildSupersessionInventory([sameLegacyScope]).components[0].status, 'reconcilable');

  const ambiguousScope = edge('sem-2', 'sem-1', {
    successorScope: 'project:alpha',
    successorTags: ['project:alpha', 'project:beta'],
  });
  assert.deepEqual(buildSupersessionInventory([ambiguousScope]).components[0].reasons, [
    'ambiguous_scope',
  ]);

  const missing = edge('sem-2', 'sem-1', {
    successorValidAt: null,
    predecessorInvalidAt: null,
    supersedesValidAt: null,
  });
  assert.deepEqual(buildSupersessionInventory([missing]).components[0].reasons, [
    'missing_temporal_evidence',
  ]);

  const conflicting = edge('sem-2', 'sem-1', {
    predecessorInvalidAt: '2026-02-01T00:00:00.000Z',
  });
  assert.deepEqual(buildSupersessionInventory([conflicting]).components[0].reasons, [
    'conflicting_temporal_evidence',
  ]);
});

test('quarantines malformed timestamps instead of repairing from them', () => {
  const report = buildSupersessionInventory([edge('sem-2', 'sem-1', {
    successorValidAt: 'not-a-time',
    predecessorInvalidAt: null,
    supersedesValidAt: null,
  })]);
  assert.deepEqual(report.components[0].reasons, [
    'malformed_temporal_evidence',
    'missing_temporal_evidence',
  ]);
  assert.equal(report.components[0].edges[0].cutoff, null);
  assert.deepEqual(report.components[0].edges[0].proposedChanges, []);
});

test('is deterministic for shuffled input and rejects duplicate relationships', () => {
  const rows = [edge('sem-4', 'sem-3'), edge('sem-2', 'sem-1')];
  assert.equal(
    JSON.stringify(buildSupersessionInventory(rows)),
    JSON.stringify(buildSupersessionInventory([...rows].reverse())),
  );
  assert.throws(
    () => buildSupersessionInventory([rows[0], rows[0]]),
    /semantic_supersession_inventory:duplicate_edge/,
  );
});

test('normalizes equivalent instants but rejects impossible calendar dates and reversed intervals', () => {
  const equivalent = edge('sem-2', 'sem-1', {
    supersedesValidAt: '2026-01-02T00:00:00Z',
  });
  assert.equal(buildSupersessionInventory([equivalent]).components[0].status, 'reconcilable');
  for (const overrides of [
    { successorValidAt: '2026-02-30T00:00:00.000Z' },
    { predecessorValidAt: '2026-01-03T00:00:00.000Z' },
    { successorInvalidAt: '2026-01-01T00:00:00.000Z' },
  ]) {
    assert.equal(buildSupersessionInventory([edge('sem-2', 'sem-1', overrides)])
      .components[0].status, 'quarantine');
  }
});

test('quarantines wildcard or empty project identities', () => {
  for (const scope of ['project:*', 'project:']) {
    const report = buildSupersessionInventory([edge('sem-2', 'sem-1', {
      successorScope: scope, successorTags: [scope],
      predecessorScope: scope, predecessorTags: [scope],
    })]);
    assert.ok(report.components[0].reasons.includes('ambiguous_scope'));
  }
});

test('quarantines expired edge cutoffs and reversed inferred chain intervals', () => {
  const expired = edge('sem-2', 'sem-1', { supersedesInvalidAt: '2026-01-01T00:00:00.000Z' });
  assert.ok(buildSupersessionInventory([expired]).components[0].reasons.includes('invalid_temporal_order'));
  const report = buildSupersessionInventory([
    edge('sem-3', 'sem-2', { successorValidAt: '2026-01-02T00:00:00.000Z', predecessorValidAt: null }),
    edge('sem-2', 'sem-1', { successorValidAt: null, supersedesValidAt: '2026-01-03T00:00:00.000Z' }),
  ]);
  assert.ok(report.components[0].reasons.includes('invalid_temporal_order'));
});

test('database inventory uses one bounded read transaction and closes the session', async () => {
  const row = edge('sem-2', 'sem-1');
  const tx = {
    run: async (query, params, config) => {
      assert.equal(query, SUPERSESSION_INVENTORY_QUERY);
      assert.deepEqual(params, {});
      assert.deepEqual(config, { timeout: 15_000 });
      return { records: [{ get: (key) => row[key] }] };
    },
  };
  let sessionOptions;
  let closed = false;
  const driver = {
    session(options) {
      sessionOptions = options;
      return {
        executeRead: (work) => work(tx),
        close: async () => { closed = true; },
      };
    },
  };

  const report = await inventorySemanticSupersession(driver, 'neo4j');
  assert.deepEqual(sessionOptions, { defaultAccessMode: 'READ', database: 'neo4j' });
  assert.equal(report.counts.reconcilable, 1);
  assert.equal(closed, true);
});
