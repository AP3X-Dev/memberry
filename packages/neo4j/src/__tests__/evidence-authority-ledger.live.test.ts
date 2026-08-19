import { randomUUID } from 'node:crypto';

import type { Driver, ManagedTransaction, Session } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  EvidenceAuthorityLedgerError,
  createEvidenceAuthorityCaptureFacet,
  createEvidenceAuthorityLedgerPersistence,
  createEvidenceAuthorityReviewFacet,
  type EvidenceAuthorityScopeV1,
} from '../evidence-authority-ledger.js';
import { createNeo4jDriver } from '../driver.js';
import { MIGRATIONS } from '../migrations.js';
import { initSchema } from '../schema.js';
import { createEvidenceAuthorityCapture } from '../evidence-authority-capture.js';
import { createEvidenceAuthorityAdjudication } from '../evidence-authority-adjudication.js';
import { createEvidenceAuthorityRevocation } from '../evidence-authority-revocation.js';

const LIVE_ENABLED = process.env.MEMBERRY_NEO4J_INTEGRATION === '1';
const describeLive = LIVE_ENABLED ? describe : describe.skip;
const uri = process.env.NEO4J_URI || 'bolt://localhost:7687';
const user = process.env.NEO4J_USER || 'neo4j';
const password = process.env.NEO4J_PASSWORD || 'password';
const suffix = randomUUID().toLowerCase();
const tenantId = `test-evidence-ledger-${suffix}`;
const projectScope = `project:test-evidence-ledger-${suffix}`;
const scope = (semanticId: string): EvidenceAuthorityScopeV1 => ({
  tenantId,
  projectScope,
  semanticId,
});
const semanticIds = ['semantic-primary', 'semantic-replay', 'semantic-rollback']
  .map((value) => `${value}-${suffix}`);
const driver = createNeo4jDriver(uri, user, password);

async function scalar(query: string, key: string, params: Record<string, unknown> = {}): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.run(query, params);
    return Number(result.records[0]?.get(key) ?? 0);
  } finally {
    await session.close();
  }
}

function afterCommitLossDriver(base: Driver, canary: string): Driver {
  return {
    session: () => {
      const session = base.session();
      return {
        executeWrite: async <T>(work: (tx: ManagedTransaction) => Promise<T>) => {
          await session.executeWrite(work);
          throw new Error(canary);
        },
        close: session.close.bind(session),
      };
    },
  } as unknown as Driver;
}

function switchableAfterCommitLossDriver(base: Driver, canary: string) {
  let armed = false;
  return {
    arm: () => { armed = true; },
    driver: {
      session: () => {
        const session = base.session();
        return {
          executeWrite: async <T>(work: (tx: ManagedTransaction) => Promise<T>) => {
            const result = await session.executeWrite(work);
            if (armed) {
              armed = false;
              throw new Error(canary);
            }
            return result;
          },
          close: session.close.bind(session),
        };
      },
    } as unknown as Driver,
  };
}

function corruptAppendDriver(base: Driver): Driver {
  return {
    session: () => {
      const session = base.session();
      return {
        executeWrite: <T>(work: (tx: ManagedTransaction) => Promise<T>) => session.executeWrite(async (tx) => {
          const wrapped = {
            run: async (query: string, params?: Record<string, unknown>) => {
              const result = await tx.run(query, params);
              if (!query.includes('evidence-authority:append-') || result.records.length === 0) return result;
              const original = result.records[0]!;
              return {
                ...result,
                records: [{ get: (key: string) => key === 'outbox' ? null : original.get(key) }],
              } as typeof result;
            },
          } as ManagedTransaction;
          return work(wrapped);
        }),
        close: session.close.bind(session),
      };
    },
  } as unknown as Driver;
}

async function expectSafeFailure(promise: Promise<unknown>, code: string, canary?: string): Promise<void> {
  let error: unknown;
  try { await promise; } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(EvidenceAuthorityLedgerError);
  expect(error).toMatchObject({ code });
  if (canary) expect(String(error)).not.toContain(canary);
}

describeLive('EvidenceAuthorityLedger live Neo4j gate', () => {
  beforeAll(async () => {
    await driver.getServerInfo();
    const session = driver.session();
    try {
      for (const semanticId of semanticIds) {
        await session.run(
          `CREATE (s:Semantic {
             id: $semanticId, tenant_id: $tenantId, scope: $projectScope,
             content: 'disposable synthetic fixture', confidence: 1.0,
             signal_count: 0, created_at: datetime(), updated_at: datetime(),
             decay_class: 'stable', tags: [$projectScope]
           })`,
          { semanticId, tenantId, projectScope },
        );
      }
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    if (LIVE_ENABLED) {
      const session = driver.session();
      try {
        await session.run(
          `MATCH (n)
           WHERE n.tenant_id = $tenantId
              OR n.project_scope = $projectScope
              OR n.semantic_id IN $semanticIds
              OR n.scope = $projectScope
              OR n.id IN $semanticIds
           DETACH DELETE n`,
          { tenantId, projectScope, semanticIds },
        );
        const residue = await session.run(
          `MATCH (n)
           WHERE n.tenant_id = $tenantId
              OR n.project_scope = $projectScope
              OR n.semantic_id IN $semanticIds
              OR n.scope = $projectScope
              OR n.id IN $semanticIds
           RETURN count(n) AS count`,
          { tenantId, projectScope, semanticIds },
        );
        expect(Number(residue.records[0]?.get('count') ?? -1)).toBe(0);
      } finally {
        await session.close();
      }
    }
    await driver.close().catch(() => undefined);
  });

  it('applies 0008 twice, proves init parity objects, and performs no legacy backfill', async () => {
    const migration = MIGRATIONS.find((item) => item.id === '0008-evidence-authority-ledger-v1');
    expect(migration).toBeDefined();
    const before = await scalar('MATCH (n:EvidenceAuthorityCoverage) RETURN count(n) AS count', 'count');
    await migration!.up(driver);
    await migration!.up(driver);
    await initSchema(driver);
    expect(await scalar('MATCH (n:EvidenceAuthorityCoverage) RETURN count(n) AS count', 'count')).toBe(before);

    const session = driver.session();
    try {
      const constraints = await session.run(
        `SHOW CONSTRAINTS YIELD name
         WHERE name STARTS WITH 'evidence_authority_'
         RETURN collect(name) AS names`,
      );
      expect((constraints.records[0]!.get('names') as string[]).sort()).toEqual([
        'evidence_authority_case_id',
        'evidence_authority_coverage_id',
        'evidence_authority_event_id',
        'evidence_authority_ledger_id',
        'evidence_authority_outbox_id',
      ]);
      const indexes = await session.run(
        `SHOW INDEXES YIELD name, owningConstraint
         WHERE name STARTS WITH 'evidence_authority_' AND owningConstraint IS NULL
         RETURN collect(name) AS names`,
      );
      expect((indexes.records[0]!.get('names') as string[]).sort()).toEqual([
        'evidence_authority_case_identity',
        'evidence_authority_case_scope',
        'evidence_authority_coverage_scope',
        'evidence_authority_event_scope',
        'evidence_authority_event_target',
        'evidence_authority_ledger_scope',
        'evidence_authority_outbox_event',
        'evidence_authority_outbox_scope',
      ]);
    } finally {
      await session.close();
    }
  });

  it('proves concurrency, lifecycle, exact replay, atomic rollback, isolation, and cleanup', async () => {
    const primary = scope(semanticIds[0]!);
    const store = createEvidenceAuthorityLedgerPersistence(driver);
    const capture = createEvidenceAuthorityCaptureFacet(store, primary);
    const review = createEvidenceAuthorityReviewFacet(store, primary);
    const beforeUnauthorized = await scalar(
      'MATCH (n:EvidenceAuthorityEvent {tenant_id: $tenantId}) RETURN count(n) AS count',
      'count',
      { tenantId },
    );
    await expect(store.openCoverage(Object.freeze({}), primary, { operationId: 'unauthorized-open' }))
      .rejects.toMatchObject({ code: 'invalid_facet' });
    expect(await scalar(
      'MATCH (n:EvidenceAuthorityEvent {tenant_id: $tenantId}) RETURN count(n) AS count',
      'count',
      { tenantId },
    )).toBe(beforeUnauthorized);
    const [first, concurrent] = await Promise.all([
      store.openCoverage(capture, primary, { operationId: 'coverage-open' }),
      store.openCoverage(capture, primary, { operationId: 'coverage-open' }),
    ]);
    expect(concurrent.receipt).toEqual(first.receipt);
    expect(await scalar(
      'MATCH (e:EvidenceAuthorityEvent {tenant_id: $tenantId, semantic_id: $semanticId}) RETURN count(e) AS count',
      'count',
      primary,
    )).toBe(1);

    const [caseOneAttempt, caseTwoAttempt] = await Promise.allSettled([
      store.openCase(capture, first.facet, primary, { caseId: 'case-1', operationId: 'case-1-open' }),
      store.openCase(capture, first.facet, primary, { caseId: 'case-2', operationId: 'case-2-open' }),
    ]);
    expect(caseOneAttempt.status).toBe('fulfilled');
    expect(caseTwoAttempt.status).toBe('fulfilled');
    const caseOne = (caseOneAttempt as PromiseFulfilledResult<Awaited<ReturnType<typeof store.openCase>>>).value;
    const caseTwo = (caseTwoAttempt as PromiseFulfilledResult<Awaited<ReturnType<typeof store.openCase>>>).value;
    expect(caseOne.receipt.sequence).not.toBe(caseTwo.receipt.sequence);
    const caseThree = await store.openCase(
      capture,
      first.facet,
      primary,
      { caseId: 'case-3', operationId: 'case-3-open' },
    );
    const conflicting = await Promise.allSettled([
      store.rejectCase(review, caseThree.facet, primary, { operationId: 'case-3-decision' }),
      store.beginResolution(review, caseThree.facet, primary, { operationId: 'case-3-decision' }),
    ]);
    expect(conflicting.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const conflictFailure = conflicting.find((item) => item.status === 'rejected') as PromiseRejectedResult;
    expect(conflictFailure.reason).toMatchObject({ code: 'operation_conflict' });
    await store.rejectCase(review, caseOne.facet, primary, { operationId: 'case-1-reject' });
    await store.beginResolution(review, caseTwo.facet, primary, { operationId: 'case-2-resolving' });
    await store.resolveCase(review, caseTwo.facet, primary, { operationId: 'case-2-resolved' });

    const resolvingLoss = switchableAfterCommitLossDriver(driver, `resolving-loss-${suffix}`);
    const resolvingStore = createEvidenceAuthorityLedgerPersistence(resolvingLoss.driver);
    const resolvingCapture = createEvidenceAuthorityCaptureFacet(resolvingStore, primary);
    const resolvingReview = createEvidenceAuthorityReviewFacet(resolvingStore, primary);
    const resolvingCoverage = await resolvingStore.openCoverage(
      resolvingCapture,
      primary,
      { operationId: 'coverage-open' },
    );
    const resolvingCase = await resolvingStore.openCase(
      resolvingCapture,
      resolvingCoverage.facet,
      primary,
      { caseId: 'case-resolving-loss', operationId: 'case-resolving-loss-open' },
    );
    resolvingLoss.arm();
    await expectSafeFailure(
      resolvingStore.beginResolution(
        resolvingReview,
        resolvingCase.facet,
        primary,
        { operationId: 'case-resolving-loss-start' },
      ),
      'storage_unavailable',
      `resolving-loss-${suffix}`,
    );
    await expect(resolvingStore.beginResolution(
      resolvingReview,
      resolvingCase.facet,
      primary,
      { operationId: 'case-resolving-loss-start' },
    )).resolves.toMatchObject({ state: 'resolving' });
    expect(await scalar(
      'MATCH (c:EvidenceAuthorityCase {tenant_id: $tenantId, semantic_id: $semanticId}) RETURN count(c) AS count',
      'count',
      primary,
    )).toBe(4);

    const eventCount = await scalar(
      'MATCH (e:EvidenceAuthorityEvent {tenant_id: $tenantId}) RETURN count(e) AS count',
      'count',
      { tenantId },
    );
    expect(await scalar(
      'MATCH (o:EvidenceAuthorityOutbox {tenant_id: $tenantId}) RETURN count(o) AS count',
      'count',
      { tenantId },
    )).toBe(eventCount);
    expect(await scalar(
      `MATCH (e:EvidenceAuthorityEvent {tenant_id: $tenantId})
       WHERE NOT (e)-[:EMITTED]->(:EvidenceAuthorityOutbox)
       RETURN count(e) AS count`,
      'count',
      { tenantId },
    )).toBe(0);

    let direct: Session = driver.session();
    try {
      await direct.run(
        `MATCH (coverage:EvidenceAuthorityCoverage {semantic_id: $semanticId})-
               [scopeLink:COVERS]->(semantic:Semantic {id: $semanticId})
         DELETE scopeLink`,
        primary,
      );
    } finally {
      await direct.close();
    }
    try {
      await expect(store.openCoverage(capture, primary, { operationId: 'coverage-open' }))
        .rejects.toMatchObject({ code: 'existing_state_mismatch' });
    } finally {
      direct = driver.session();
      try {
        await direct.run(
          `MATCH (coverage:EvidenceAuthorityCoverage {semantic_id: $semanticId}),
                 (semantic:Semantic {id: $semanticId})
           CREATE (coverage)-[:COVERS]->(semantic)`,
          primary,
        );
      } finally {
        await direct.close();
      }
    }

    direct = driver.session();
    try {
      await direct.run(
        `MATCH (caseNode:EvidenceAuthorityCase {case_id: 'case-1'})-
               [coverageLink:FOR_COVERAGE]->(:EvidenceAuthorityCoverage)
         WHERE caseNode.tenant_id = $tenantId
         DELETE coverageLink`,
        { tenantId },
      );
    } finally {
      await direct.close();
    }
    try {
      await expect(store.openCase(
        capture,
        first.facet,
        primary,
        { caseId: 'case-1', operationId: 'case-1-open' },
      )).rejects.toMatchObject({ code: 'existing_state_mismatch' });
    } finally {
      direct = driver.session();
      try {
        await direct.run(
          `MATCH (caseNode:EvidenceAuthorityCase {case_id: 'case-1'}),
                 (coverage:EvidenceAuthorityCoverage {semantic_id: $semanticId})
           WHERE caseNode.tenant_id = $tenantId AND coverage.tenant_id = $tenantId
           CREATE (caseNode)-[:FOR_COVERAGE]->(coverage)`,
          primary,
        );
      } finally {
        await direct.close();
      }
    }

    const balancedExtraId = `balanced-extra-${suffix}`;
    let removedOutboxProperties: Record<string, unknown>;
    direct = driver.session();
    try {
      const corruption = await direct.run(
        `MATCH (first:EvidenceAuthorityEvent {operation_id: 'case-1-open'})-
               [:EMITTED]->(firstOutbox:EvidenceAuthorityOutbox),
               (second:EvidenceAuthorityEvent {operation_id: 'case-2-open'})-
               [secondEmit:EMITTED]->(secondOutbox:EvidenceAuthorityOutbox)
         WHERE first.tenant_id = $tenantId AND second.tenant_id = $tenantId
         WITH first, firstOutbox, second, secondEmit, secondOutbox,
              properties(secondOutbox) AS removed
         CREATE (extra:EvidenceAuthorityOutbox {
           id: $balancedExtraId,
           event_id: firstOutbox.event_id,
           tenant_id: firstOutbox.tenant_id,
           project_scope: firstOutbox.project_scope,
           semantic_id: firstOutbox.semantic_id,
           case_id: firstOutbox.case_id,
           kind: firstOutbox.kind,
           action: firstOutbox.action,
           state: firstOutbox.state,
           sequence: firstOutbox.sequence,
           recorded_at: firstOutbox.recorded_at
         })
         CREATE (first)-[:EMITTED]->(extra)
         DELETE secondEmit, secondOutbox
         RETURN removed`,
        { tenantId, balancedExtraId },
      );
      removedOutboxProperties = corruption.records[0]!.get('removed') as Record<string, unknown>;
    } finally {
      await direct.close();
    }
    try {
      await expect(store.openCoverage(capture, primary, { operationId: 'coverage-open' }))
        .rejects.toMatchObject({ code: 'existing_state_mismatch' });
    } finally {
      direct = driver.session();
      try {
        await direct.run(
          `MATCH (first:EvidenceAuthorityEvent {operation_id: 'case-1-open'})-
                 [extraEmit:EMITTED]->(extra:EvidenceAuthorityOutbox {id: $balancedExtraId}),
                 (second:EvidenceAuthorityEvent {operation_id: 'case-2-open'})
           WHERE first.tenant_id = $tenantId AND second.tenant_id = $tenantId
           DELETE extraEmit, extra
           CREATE (restored:EvidenceAuthorityOutbox)
           SET restored = $removed
           CREATE (second)-[:EMITTED]->(restored)`,
          { tenantId, balancedExtraId, removed: removedOutboxProperties! },
        );
      } finally {
        await direct.close();
      }
    }

    const missingRequiredProperties = [
      ['event', 'id'],
      ['event', 'tenant_id'],
      ['event', 'project_scope'],
      ['event', 'operation_id'],
      ['outbox', 'id'],
      ['outbox', 'event_id'],
      ['outbox', 'tenant_id'],
      ['outbox', 'project_scope'],
      ['outbox', 'recorded_at'],
    ] as const;
    for (const [nodeKind, property] of missingRequiredProperties) {
      const nodeMatch = nodeKind === 'event'
        ? `(ledger)-[:HAS_EVENT]->(node)-[:FOR_COVERAGE]->
             (:EvidenceAuthorityCoverage {semantic_id: $semanticId})`
        : `(ledger)-[:HAS_EVENT]->(event)-[:FOR_COVERAGE]->
             (:EvidenceAuthorityCoverage {semantic_id: $semanticId}),
           (event)-[:EMITTED]->(node)`;
      let original: unknown;
      direct = driver.session();
      try {
        const removed = await direct.run(
          `MATCH (ledger:EvidenceAuthorityLedger {semantic_id: $semanticId})
           MATCH ${nodeMatch}
           WITH node, node.${property} AS original
           REMOVE node.${property}
           RETURN original
           LIMIT 1`,
          primary,
        );
        original = removed.records[0]!.get('original');
      } finally {
        await direct.close();
      }
      try {
        await expect(store.openCoverage(capture, primary, { operationId: 'coverage-open' }))
          .rejects.toMatchObject({ code: 'existing_state_mismatch' });
      } finally {
        direct = driver.session();
        try {
          await direct.run(
            `MATCH (ledger:EvidenceAuthorityLedger {semantic_id: $semanticId})
             MATCH ${nodeMatch}
             SET node.${property} = $original`,
            { ...primary, original },
          );
        } finally {
          await direct.close();
        }
      }
    }

    const replayScope = scope(semanticIds[1]!);
    const replayCapture = createEvidenceAuthorityCaptureFacet(store, replayScope);
    const lostCanary = `lost-response-${suffix}`;
    await expectSafeFailure(
      (() => {
        const lossy = createEvidenceAuthorityLedgerPersistence(afterCommitLossDriver(driver, lostCanary));
        return lossy.openCoverage(
          createEvidenceAuthorityCaptureFacet(lossy, replayScope),
          replayScope,
          { operationId: 'coverage-open' },
        );
      })(),
      'storage_unavailable',
      lostCanary,
    );
    const recovered = await store.openCoverage(replayCapture, replayScope, { operationId: 'coverage-open' });
    expect(recovered.receipt.sequence).toBeGreaterThan(0);
    expect(await scalar(
      'MATCH (e:EvidenceAuthorityEvent {tenant_id: $tenantId, semantic_id: $semanticId}) RETURN count(e) AS count',
      'count',
      replayScope,
    )).toBe(1);

    direct = driver.session();
    try {
      await direct.run(
        `MATCH (ledger:EvidenceAuthorityLedger)-[:HAS_COVERAGE]->
               (:EvidenceAuthorityCoverage)-[:COVERS]->(:Semantic {id: $semanticId})
         SET ledger.tenant_id = 'tenant-poison'`,
        replayScope,
      );
    } finally {
      await direct.close();
    }
    try {
      await expect(store.openCoverage(replayCapture, replayScope, { operationId: 'coverage-open' }))
        .rejects.toMatchObject({ code: 'existing_state_mismatch' });
    } finally {
      direct = driver.session();
      try {
        await direct.run(
          `MATCH (ledger:EvidenceAuthorityLedger)-[:HAS_COVERAGE]->
                 (:EvidenceAuthorityCoverage)-[:COVERS]->(:Semantic {id: $semanticId})
           SET ledger.tenant_id = $tenantId`,
          replayScope,
        );
      } finally {
        await direct.close();
      }
    }

    const rollbackScope = scope(semanticIds[2]!);
    const beforeRollback = await scalar(
      'MATCH (e:EvidenceAuthorityEvent {tenant_id: $tenantId}) RETURN count(e) AS count',
      'count',
      { tenantId },
    );
    await expectSafeFailure(
      (() => {
        const corrupt = createEvidenceAuthorityLedgerPersistence(corruptAppendDriver(driver));
        return corrupt.openCoverage(
          createEvidenceAuthorityCaptureFacet(corrupt, rollbackScope),
          rollbackScope,
          { operationId: 'coverage-open' },
        );
      })(),
      'write_incomplete',
    );
    expect(await scalar(
      'MATCH (e:EvidenceAuthorityEvent {tenant_id: $tenantId}) RETURN count(e) AS count',
      'count',
      { tenantId },
    )).toBe(beforeRollback);
    expect(await scalar(
      'MATCH (c:EvidenceAuthorityCoverage {tenant_id: $tenantId, semantic_id: $semanticId}) RETURN count(c) AS count',
      'count',
      rollbackScope,
    )).toBe(0);

    await expect(store.openCoverage(capture,
      { ...primary, tenantId: `${tenantId}-wrong` },
      { operationId: 'wrong-tenant' },
    )).rejects.toMatchObject({ code: 'facet_scope_mismatch' });
    await expect(store.openCoverage(capture,
      { ...primary, projectScope: `${projectScope}-wrong` },
      { operationId: 'wrong-project' },
    )).rejects.toMatchObject({ code: 'facet_scope_mismatch' });

    await store.revokeCoverage(review, first.facet, primary, { operationId: 'coverage-revoke' });
    await expect(store.openCase(
      capture,
      first.facet,
      primary,
      { caseId: 'case-after-revoke', operationId: 'late-case' },
    )).rejects.toMatchObject({ code: 'facet_revoked' });

    let revokeSequence: unknown;
    let resolvedSequence: unknown;
    direct = driver.session();
    try {
      const swapped = await direct.run(
        `MATCH (revoke:EvidenceAuthorityEvent {operation_id: 'coverage-revoke'})-
               [:EMITTED]->(revokeOutbox:EvidenceAuthorityOutbox),
               (resolved:EvidenceAuthorityEvent {operation_id: 'case-2-resolved'})-
               [:EMITTED]->(resolvedOutbox:EvidenceAuthorityOutbox)
         WHERE revoke.tenant_id = $tenantId AND resolved.tenant_id = $tenantId
         WITH revoke, revokeOutbox, resolved, resolvedOutbox,
              revoke.sequence AS revokeSequence,
              resolved.sequence AS resolvedSequence
         SET revoke.sequence = resolvedSequence,
             revokeOutbox.sequence = resolvedSequence,
             resolved.sequence = revokeSequence,
             resolvedOutbox.sequence = revokeSequence
         RETURN revokeSequence, resolvedSequence`,
        { tenantId },
      );
      revokeSequence = swapped.records[0]!.get('revokeSequence');
      resolvedSequence = swapped.records[0]!.get('resolvedSequence');
    } finally {
      await direct.close();
    }
    try {
      await expect(store.openCoverage(capture, primary, { operationId: 'coverage-open' }))
        .rejects.toMatchObject({ code: 'existing_state_mismatch' });
    } finally {
      direct = driver.session();
      try {
        await direct.run(
          `MATCH (revoke:EvidenceAuthorityEvent {operation_id: 'coverage-revoke'})-
                 [:EMITTED]->(revokeOutbox:EvidenceAuthorityOutbox),
                 (resolved:EvidenceAuthorityEvent {operation_id: 'case-2-resolved'})-
                 [:EMITTED]->(resolvedOutbox:EvidenceAuthorityOutbox)
           WHERE revoke.tenant_id = $tenantId AND resolved.tenant_id = $tenantId
           SET revoke.sequence = $revokeSequence,
               revokeOutbox.sequence = $revokeSequence,
               resolved.sequence = $resolvedSequence,
               resolvedOutbox.sequence = $resolvedSequence`,
          { tenantId, revokeSequence, resolvedSequence },
        );
      } finally {
        await direct.close();
      }
    }

    direct = driver.session();
    try {
      await direct.run(
        `MATCH (event:EvidenceAuthorityEvent {operation_id: 'coverage-revoke'})-
               [:EMITTED]->(outbox:EvidenceAuthorityOutbox)
         WHERE event.tenant_id = $tenantId
         SET event.action = 'opened', event.state = 'open',
             outbox.action = 'opened', outbox.state = 'open'`,
        { tenantId },
      );
    } finally {
      await direct.close();
    }
    try {
      await expect(store.openCoverage(capture, primary, { operationId: 'coverage-open' }))
        .rejects.toMatchObject({ code: 'existing_state_mismatch' });
    } finally {
      direct = driver.session();
      try {
        await direct.run(
          `MATCH (event:EvidenceAuthorityEvent {operation_id: 'coverage-revoke'})-
                 [:EMITTED]->(outbox:EvidenceAuthorityOutbox)
           WHERE event.tenant_id = $tenantId
           SET event.action = 'revoked', event.state = 'revoked',
               outbox.action = 'revoked', outbox.state = 'revoked'`,
          { tenantId },
        );
      } finally {
        await direct.close();
      }
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// RET-005B-AUTH-001B2: additive captureCase live gate. The B1 suite above is
// frozen; this block owns its own driver, fixtures, and full cleanup.
// ---------------------------------------------------------------------------

describeLive('EvidenceAuthorityLedger captureCase live Neo4j gate (RET-005B-AUTH-001B2)', () => {
  const captureDriver = createNeo4jDriver(uri, user, password);
  const captureSuffix = randomUUID().toLowerCase();
  const captureTenantId = `test-evidence-capture-${captureSuffix}`;
  const captureProjectScope = `project:test-evidence-capture-${captureSuffix}`;
  const captureSemanticIds = [
    'semantic-capture-primary',
    'semantic-capture-history',
    'semantic-capture-rollback',
    'semantic-capture-module',
  ].map((value) => `${value}-${captureSuffix}`);
  const captureEpisodeId = `episode-capture-${captureSuffix}`;
  const captureScope = (semanticId: string): EvidenceAuthorityScopeV1 => ({
    tenantId: captureTenantId,
    projectScope: captureProjectScope,
    semanticId,
  });

  async function captureScalar(
    query: string,
    key: string,
    params: Record<string, unknown> = {},
  ): Promise<number> {
    const session = captureDriver.session();
    try {
      const result = await session.run(query, params);
      return Number(result.records[0]?.get(key) ?? 0);
    } finally {
      await session.close();
    }
  }

  async function ledgerCounts(semanticId: string) {
    const params = { tenantId: captureTenantId, semanticId };
    return {
      events: await captureScalar(
        'MATCH (n:EvidenceAuthorityEvent {tenant_id: $tenantId, semantic_id: $semanticId}) RETURN count(n) AS count',
        'count',
        params,
      ),
      outboxes: await captureScalar(
        'MATCH (n:EvidenceAuthorityOutbox {tenant_id: $tenantId, semantic_id: $semanticId}) RETURN count(n) AS count',
        'count',
        params,
      ),
      coverage: await captureScalar(
        'MATCH (n:EvidenceAuthorityCoverage {tenant_id: $tenantId, semantic_id: $semanticId}) RETURN count(n) AS count',
        'count',
        params,
      ),
      cases: await captureScalar(
        'MATCH (n:EvidenceAuthorityCase {tenant_id: $tenantId, semantic_id: $semanticId}) RETURN count(n) AS count',
        'count',
        params,
      ),
    };
  }

  function corruptCaptureAppendDriver(base: Driver): Driver {
    return {
      session: () => {
        const session = base.session();
        return {
          executeWrite: <T>(work: (tx: ManagedTransaction) => Promise<T>) => session.executeWrite(async (tx) => {
            const wrapped = {
              run: async (query: string, params?: Record<string, unknown>) => {
                const result = await tx.run(query, params);
                if (!query.includes('evidence-authority:append-capture-coverage-case')
                  || result.records.length === 0) {
                  return result;
                }
                const original = result.records[0]!;
                return {
                  ...result,
                  records: [{ get: (key: string) => key === 'caseOutbox' ? null : original.get(key) }],
                } as typeof result;
              },
            } as ManagedTransaction;
            return work(wrapped);
          }),
          close: session.close.bind(session),
        };
      },
    } as unknown as Driver;
  }

  beforeAll(async () => {
    await captureDriver.getServerInfo();
    const migration = MIGRATIONS.find((item) => item.id === '0008-evidence-authority-ledger-v1');
    expect(migration).toBeDefined();
    await migration!.up(captureDriver);
    await initSchema(captureDriver);
    const session = captureDriver.session();
    try {
      for (const semanticId of captureSemanticIds) {
        await session.run(
          `CREATE (s:Semantic {
             id: $semanticId, tenant_id: $tenantId, scope: $projectScope,
             content: 'disposable synthetic capture fixture', confidence: 1.0,
             signal_count: 0, created_at: datetime(), updated_at: datetime(),
             decay_class: 'stable', tags: [$projectScope]
           })`,
          { semanticId, tenantId: captureTenantId, projectScope: captureProjectScope },
        );
      }
      await session.run(
        `MATCH (s:Semantic {id: $semanticId, tenant_id: $tenantId})
         CREATE (e:Episodic {
           id: $episodeId, tenant_id: $tenantId, scope: $projectScope,
           content: 'disposable synthetic pre-ledger signal', created_at: datetime()
         })
         CREATE (e)-[:CONTRADICTS {detail: 'disposable synthetic detail', valid_at: datetime()}]->(s)`,
        {
          semanticId: captureSemanticIds[1],
          tenantId: captureTenantId,
          projectScope: captureProjectScope,
          episodeId: captureEpisodeId,
        },
      );
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    if (LIVE_ENABLED) {
      const session = captureDriver.session();
      try {
        await session.run(
          `MATCH (n)
           WHERE n.tenant_id = $tenantId
              OR n.project_scope = $projectScope
              OR n.semantic_id IN $semanticIds
              OR n.scope = $projectScope
              OR n.id IN $nodeIds
           DETACH DELETE n`,
          {
            tenantId: captureTenantId,
            projectScope: captureProjectScope,
            semanticIds: captureSemanticIds,
            nodeIds: [...captureSemanticIds, captureEpisodeId],
          },
        );
        const residue = await session.run(
          `MATCH (n)
           WHERE n.tenant_id = $tenantId
              OR n.project_scope = $projectScope
              OR n.semantic_id IN $semanticIds
              OR n.scope = $projectScope
              OR n.id IN $nodeIds
           RETURN count(n) AS count`,
          {
            tenantId: captureTenantId,
            projectScope: captureProjectScope,
            semanticIds: captureSemanticIds,
            nodeIds: [...captureSemanticIds, captureEpisodeId],
          },
        );
        expect(Number(residue.records[0]?.get('count') ?? -1)).toBe(0);
      } finally {
        await session.close();
      }
    }
    await captureDriver.close().catch(() => undefined);
  });

  it('proves atomic combined capture, replay, precondition, rollback, isolation, and revocation', async () => {
    const primary = captureScope(captureSemanticIds[0]!);
    const store = createEvidenceAuthorityLedgerPersistence(captureDriver);
    const captureFacet = createEvidenceAuthorityCaptureFacet(store, primary);
    const firstOperation = {
      caseId: 'capture-case-live-1',
      coverageOperationId: 'capture-op-coverage-live-1',
      caseOperationId: 'capture-op-case-live-1',
    };

    // Concurrency on one Semantic: both attempts converge on one stored pair.
    const [first, concurrent] = await Promise.all([
      store.captureCase(captureFacet, primary, firstOperation),
      store.captureCase(captureFacet, primary, firstOperation),
    ]);
    expect(first.coverageReceipt).toMatchObject({
      kind: 'coverage', action: 'opened', state: 'open', sequence: 1,
    });
    expect(first.caseReceipt).toMatchObject({
      kind: 'case', action: 'case_opened', state: 'pending', sequence: 2,
    });
    expect(concurrent.coverageReceipt).toEqual(first.coverageReceipt);
    expect(concurrent.caseReceipt).toEqual(first.caseReceipt);
    expect(await ledgerCounts(primary.semanticId)).toEqual({
      events: 2, outboxes: 2, coverage: 1, cases: 1,
    });
    expect(await captureScalar(
      `MATCH (e:EvidenceAuthorityEvent {tenant_id: $tenantId, semantic_id: $semanticId})
       WHERE NOT (e)-[:EMITTED]->(:EvidenceAuthorityOutbox)
       RETURN count(e) AS count`,
      'count',
      { tenantId: captureTenantId, semanticId: primary.semanticId },
    )).toBe(0);

    // Idempotent replay of the exact pair.
    const replay = await store.captureCase(captureFacet, primary, firstOperation);
    expect(replay.coverageReceipt).toEqual(first.coverageReceipt);
    expect(replay.caseReceipt).toEqual(first.caseReceipt);
    expect(await ledgerCounts(primary.semanticId)).toEqual({
      events: 2, outboxes: 2, coverage: 1, cases: 1,
    });

    // Second capture on open coverage appends the case alone.
    const second = await store.captureCase(captureFacet, primary, {
      caseId: 'capture-case-live-2',
      coverageOperationId: 'capture-op-coverage-live-2',
      caseOperationId: 'capture-op-case-live-2',
    });
    expect(second.coverageReceipt).toBeNull();
    expect(second.caseReceipt).toMatchObject({ state: 'pending', sequence: 3 });
    expect(await ledgerCounts(primary.semanticId)).toEqual({
      events: 3, outboxes: 3, coverage: 1, cases: 2,
    });

    // Pre-existing raw CONTRADICTS history fails closed with zero residue.
    const history = captureScope(captureSemanticIds[1]!);
    const historyFacet = createEvidenceAuthorityCaptureFacet(store, history);
    await expect(store.captureCase(historyFacet, history, firstOperation))
      .rejects.toMatchObject({ code: 'invalid_transition' });
    expect(await ledgerCounts(history.semanticId)).toEqual({
      events: 0, outboxes: 0, coverage: 0, cases: 0,
    });

    // Induced mid-transaction failure rolls back everything: no bare coverage.
    const rollback = captureScope(captureSemanticIds[2]!);
    const corrupt = createEvidenceAuthorityLedgerPersistence(corruptCaptureAppendDriver(captureDriver));
    await expect(corrupt.captureCase(
      createEvidenceAuthorityCaptureFacet(corrupt, rollback),
      rollback,
      firstOperation,
    )).rejects.toMatchObject({ code: 'write_incomplete' });
    expect(await ledgerCounts(rollback.semanticId)).toEqual({
      events: 0, outboxes: 0, coverage: 0, cases: 0,
    });

    // Isolation: the facet is sealed to its exact scope, and a scope that does
    // not match the stored node exactly captures nothing.
    await expect(store.captureCase(captureFacet, history, firstOperation))
      .rejects.toMatchObject({ code: 'facet_scope_mismatch' });
    await expect(store.captureCase(
      captureFacet,
      { ...primary, tenantId: `${captureTenantId}-wrong` },
      firstOperation,
    )).rejects.toMatchObject({ code: 'facet_scope_mismatch' });
    const foreignScope = {
      tenantId: captureTenantId,
      projectScope: `${captureProjectScope}-wrong`,
      semanticId: rollback.semanticId,
    };
    const foreignFacet = createEvidenceAuthorityCaptureFacet(store, foreignScope);
    await expect(store.captureCase(foreignFacet, foreignScope, firstOperation))
      .rejects.toMatchObject({ code: 'semantic_not_found' });
    expect(await ledgerCounts(rollback.semanticId)).toEqual({
      events: 0, outboxes: 0, coverage: 0, cases: 0,
    });

    // Revoked coverage refuses further capture.
    const review = createEvidenceAuthorityReviewFacet(store, rollback);
    const rollbackFacet = createEvidenceAuthorityCaptureFacet(store, rollback);
    const opened = await store.openCoverage(rollbackFacet, rollback, { operationId: 'coverage-open' });
    await store.revokeCoverage(review, opened.facet, rollback, { operationId: 'coverage-revoke' });
    await expect(store.captureCase(rollbackFacet, rollback, {
      caseId: 'capture-case-live-late',
      coverageOperationId: 'capture-op-coverage-live-late',
      caseOperationId: 'capture-op-case-live-late',
    })).rejects.toMatchObject({ code: 'facet_revoked' });
    expect(await ledgerCounts(rollback.semanticId)).toEqual({
      events: 2, outboxes: 2, coverage: 1, cases: 0,
    });
  }, 120_000);

  it('captures end to end through the unwired capture module with digested identity', async () => {
    const moduleSemanticId = captureSemanticIds[3]!;
    const capture = createEvidenceAuthorityCapture(captureDriver);
    const request = {
      tenantId: captureTenantId,
      projectScope: captureProjectScope,
      semanticId: moduleSemanticId,
      signalKind: 'contradiction' as const,
      sourceEpisodeId: `_ep-${captureSuffix}`,
    };
    const result = await capture.capture(request);
    expect(result.outcome).toBe('captured');
    expect(result.outcome === 'captured' && result.receipt).toMatchObject({
      kind: 'case', action: 'case_opened', state: 'pending', sequence: 2,
    });
    expect(await ledgerCounts(moduleSemanticId)).toEqual({
      events: 2, outboxes: 2, coverage: 1, cases: 1,
    });
    expect(await captureScalar(
      `MATCH (n)
       WHERE n.tenant_id = $tenantId AND n.semantic_id = $semanticId
         AND (n:EvidenceAuthorityEvent OR n:EvidenceAuthorityCase OR n:EvidenceAuthorityOutbox)
         AND (n.id CONTAINS $episodeId OR n.case_id CONTAINS $episodeId OR n.operation_id CONTAINS $episodeId)
       RETURN count(n) AS count`,
      'count',
      {
        tenantId: captureTenantId,
        semanticId: moduleSemanticId,
        episodeId: request.sourceEpisodeId,
      },
    )).toBe(0);

    const replay = await capture.capture(request);
    expect(replay).toEqual(result);
    expect(await ledgerCounts(moduleSemanticId)).toEqual({
      events: 2, outboxes: 2, coverage: 1, cases: 1,
    });

    const uncaptured = await capture.capture({ ...request, projectScope: null });
    expect(uncaptured).toEqual({
      contractVersion: 'memberry.evidence-authority-capture/1.0.0',
      outcome: 'uncaptured',
      code: 'uncaptured',
    });
  }, 120_000);
});

// ---------------------------------------------------------------------------
// RET-005B-AUTH-001B3A: additive adjudicateCase live gate. The B1 and B2
// suites above are frozen; this block owns its own driver, fixtures, and full
// cleanup, and proves the end-to-end state B2 could mint but never transition.
// ---------------------------------------------------------------------------

describeLive('EvidenceAuthorityLedger adjudicateCase live Neo4j gate (RET-005B-AUTH-001B3A)', () => {
  const adjudicationDriver = createNeo4jDriver(uri, user, password);
  const adjudicationSuffix = randomUUID().toLowerCase();
  const adjudicationTenantId = `test-evidence-adjudication-${adjudicationSuffix}`;
  const adjudicationProjectScope = `project:test-evidence-adjudication-${adjudicationSuffix}`;
  const adjudicationSemanticIds = [
    'semantic-adjudication-reject',
    'semantic-adjudication-resolve',
    'semantic-adjudication-module',
  ].map((value) => `${value}-${adjudicationSuffix}`);
  const adjudicationScope = (semanticId: string): EvidenceAuthorityScopeV1 => ({
    tenantId: adjudicationTenantId,
    projectScope: adjudicationProjectScope,
    semanticId,
  });

  async function adjudicationScalar(
    query: string,
    key: string,
    params: Record<string, unknown> = {},
  ): Promise<number> {
    const session = adjudicationDriver.session();
    try {
      const result = await session.run(query, params);
      return Number(result.records[0]?.get(key) ?? 0);
    } finally {
      await session.close();
    }
  }

  async function adjudicationLedgerCounts(semanticId: string) {
    const params = { tenantId: adjudicationTenantId, semanticId };
    return {
      events: await adjudicationScalar(
        'MATCH (n:EvidenceAuthorityEvent {tenant_id: $tenantId, semantic_id: $semanticId}) RETURN count(n) AS count',
        'count',
        params,
      ),
      outboxes: await adjudicationScalar(
        'MATCH (n:EvidenceAuthorityOutbox {tenant_id: $tenantId, semantic_id: $semanticId}) RETURN count(n) AS count',
        'count',
        params,
      ),
      coverage: await adjudicationScalar(
        'MATCH (n:EvidenceAuthorityCoverage {tenant_id: $tenantId, semantic_id: $semanticId}) RETURN count(n) AS count',
        'count',
        params,
      ),
      cases: await adjudicationScalar(
        'MATCH (n:EvidenceAuthorityCase {tenant_id: $tenantId, semantic_id: $semanticId}) RETURN count(n) AS count',
        'count',
        params,
      ),
    };
  }

  beforeAll(async () => {
    await adjudicationDriver.getServerInfo();
    const migration = MIGRATIONS.find((item) => item.id === '0008-evidence-authority-ledger-v1');
    expect(migration).toBeDefined();
    await migration!.up(adjudicationDriver);
    await initSchema(adjudicationDriver);
    const session = adjudicationDriver.session();
    try {
      for (const semanticId of adjudicationSemanticIds) {
        await session.run(
          `CREATE (s:Semantic {
             id: $semanticId, tenant_id: $tenantId, scope: $projectScope,
             content: 'disposable synthetic adjudication fixture', confidence: 1.0,
             signal_count: 0, created_at: datetime(), updated_at: datetime(),
             decay_class: 'stable', tags: [$projectScope]
           })`,
          {
            semanticId,
            tenantId: adjudicationTenantId,
            projectScope: adjudicationProjectScope,
          },
        );
      }
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    if (LIVE_ENABLED) {
      const session = adjudicationDriver.session();
      try {
        await session.run(
          `MATCH (n)
           WHERE n.tenant_id = $tenantId
              OR n.project_scope = $projectScope
              OR n.semantic_id IN $semanticIds
              OR n.scope = $projectScope
              OR n.id IN $semanticIds
           DETACH DELETE n`,
          {
            tenantId: adjudicationTenantId,
            projectScope: adjudicationProjectScope,
            semanticIds: adjudicationSemanticIds,
          },
        );
        const residue = await session.run(
          `MATCH (n)
           WHERE n.tenant_id = $tenantId
              OR n.project_scope = $projectScope
              OR n.semantic_id IN $semanticIds
              OR n.scope = $projectScope
              OR n.id IN $semanticIds
           RETURN count(n) AS count`,
          {
            tenantId: adjudicationTenantId,
            projectScope: adjudicationProjectScope,
            semanticIds: adjudicationSemanticIds,
          },
        );
        expect(Number(residue.records[0]?.get('count') ?? -1)).toBe(0);
      } finally {
        await session.close();
      }
    }
    await adjudicationDriver.close().catch(() => undefined);
  });

  it('adjudicates capture-created cases end to end: reject, then resolving -> resolved, with the audit passing on every subsequent operation', async () => {
    const store = createEvidenceAuthorityLedgerPersistence(adjudicationDriver);

    // Reject path: the state B2 could mint but never transition.
    const rejectScope = adjudicationScope(adjudicationSemanticIds[0]!);
    const rejectCapture = createEvidenceAuthorityCaptureFacet(store, rejectScope);
    const rejectReview = createEvidenceAuthorityReviewFacet(store, rejectScope);
    const captured = await store.captureCase(rejectCapture, rejectScope, {
      caseId: 'adjudication-case-live-1',
      coverageOperationId: 'adjudication-op-coverage-live-1',
      caseOperationId: 'adjudication-op-case-live-1',
    });
    expect(captured.caseReceipt).toMatchObject({
      kind: 'case', action: 'case_opened', state: 'pending', sequence: 2,
    });
    const rejected = await store.adjudicateCase(rejectReview, rejectScope, {
      caseId: 'adjudication-case-live-1',
      operationId: 'adjudication-op-reject-live-1',
      action: 'rejected',
    });
    expect(rejected).toMatchObject({
      kind: 'case', action: 'rejected', state: 'rejected', sequence: 3,
    });
    expect(await adjudicationLedgerCounts(rejectScope.semanticId)).toEqual({
      events: 3, outboxes: 3, coverage: 1, cases: 1,
    });
    // Every subsequent operation re-audits the full history under exact-key
    // equality; a passing replay proves the adjudicated history is valid.
    const rejectedReplay = await store.adjudicateCase(rejectReview, rejectScope, {
      caseId: 'adjudication-case-live-1',
      operationId: 'adjudication-op-reject-live-1',
      action: 'rejected',
    });
    expect(rejectedReplay).toEqual(rejected);
    expect(await adjudicationLedgerCounts(rejectScope.semanticId)).toEqual({
      events: 3, outboxes: 3, coverage: 1, cases: 1,
    });

    // Resolution path: two independently idempotent steps.
    const resolveScope = adjudicationScope(adjudicationSemanticIds[1]!);
    const resolveCapture = createEvidenceAuthorityCaptureFacet(store, resolveScope);
    const resolveReview = createEvidenceAuthorityReviewFacet(store, resolveScope);
    await store.captureCase(resolveCapture, resolveScope, {
      caseId: 'adjudication-case-live-2',
      coverageOperationId: 'adjudication-op-coverage-live-2',
      caseOperationId: 'adjudication-op-case-live-2',
    });
    const resolving = await store.adjudicateCase(resolveReview, resolveScope, {
      caseId: 'adjudication-case-live-2',
      operationId: 'adjudication-op-resolving-live-2',
      action: 'resolution_started',
    });
    expect(resolving).toMatchObject({
      kind: 'case', action: 'resolution_started', state: 'resolving', sequence: 3,
    });
    const resolved = await store.adjudicateCase(resolveReview, resolveScope, {
      caseId: 'adjudication-case-live-2',
      operationId: 'adjudication-op-resolved-live-2',
      action: 'resolved',
    });
    expect(resolved).toMatchObject({
      kind: 'case', action: 'resolved', state: 'resolved', sequence: 4,
    });
    expect(await adjudicationLedgerCounts(resolveScope.semanticId)).toEqual({
      events: 4, outboxes: 4, coverage: 1, cases: 1,
    });

    // Wrong-state and cross-scope refusals leave zero residue.
    await expect(store.adjudicateCase(resolveReview, resolveScope, {
      caseId: 'adjudication-case-live-2',
      operationId: 'adjudication-op-late-live-2',
      action: 'rejected',
    })).rejects.toMatchObject({ code: 'invalid_transition' });
    await expect(store.adjudicateCase(rejectReview, resolveScope, {
      caseId: 'adjudication-case-live-2',
      operationId: 'adjudication-op-cross-live-2',
      action: 'rejected',
    })).rejects.toMatchObject({ code: 'facet_scope_mismatch' });
    expect(await adjudicationLedgerCounts(resolveScope.semanticId)).toEqual({
      events: 4, outboxes: 4, coverage: 1, cases: 1,
    });
  }, 120_000);

  it('adjudicates through the unwired module with per-construction idempotency, cross-construction refusal, and zero residue', async () => {
    const moduleSemanticId = adjudicationSemanticIds[2]!;
    const moduleScope = adjudicationScope(moduleSemanticId);
    const store = createEvidenceAuthorityLedgerPersistence(adjudicationDriver);
    const captureFacet = createEvidenceAuthorityCaptureFacet(store, moduleScope);
    await store.captureCase(captureFacet, moduleScope, {
      caseId: 'adjudication-case-live-module',
      coverageOperationId: 'adjudication-op-coverage-live-module',
      caseOperationId: 'adjudication-op-case-live-module',
    });

    const alpha = createEvidenceAuthorityAdjudication(adjudicationDriver, {
      tenantId: adjudicationTenantId,
      projectScope: adjudicationProjectScope,
      principalId: 'principal-live-alpha',
    });
    const request = {
      semanticId: moduleSemanticId,
      caseId: 'adjudication-case-live-module',
      decision: 'reject' as const,
    };
    const first = await alpha.adjudicate(request);
    expect(first.outcome).toBe('adjudicated');
    expect(first.outcome === 'adjudicated' && first.receipt).toMatchObject({
      kind: 'case', action: 'rejected', state: 'rejected', sequence: 3,
    });
    expect(await adjudicationLedgerCounts(moduleSemanticId)).toEqual({
      events: 3, outboxes: 3, coverage: 1, cases: 1,
    });

    const replay = await alpha.adjudicate(request);
    expect(replay).toEqual(first);
    expect(await adjudicationLedgerCounts(moduleSemanticId)).toEqual({
      events: 3, outboxes: 3, coverage: 1, cases: 1,
    });

    const beta = createEvidenceAuthorityAdjudication(adjudicationDriver, {
      tenantId: adjudicationTenantId,
      projectScope: adjudicationProjectScope,
      principalId: 'principal-live-beta',
    });
    const forged = await beta.adjudicate(request);
    expect(forged).toEqual({
      contractVersion: 'memberry.evidence-authority-adjudication/1.0.0',
      outcome: 'unadjudicated',
      code: 'unadjudicated',
    });
    expect(await adjudicationLedgerCounts(moduleSemanticId)).toEqual({
      events: 3, outboxes: 3, coverage: 1, cases: 1,
    });

    // Durable anonymity: no stored value records or permits recovery of the
    // construction-bound label.
    expect(await adjudicationScalar(
      `MATCH (n)
       WHERE n.tenant_id = $tenantId AND n.semantic_id = $semanticId
         AND (n.id CONTAINS $label OR n.operation_id CONTAINS $label OR n.case_id CONTAINS $label)
       RETURN count(n) AS count`,
      'count',
      {
        tenantId: adjudicationTenantId,
        semanticId: moduleSemanticId,
        label: 'principal-live-alpha',
      },
    )).toBe(0);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// RET-005B-AUTH-001B3B1: additive coverage revocation live gate. The B1, B2,
// and B3A suites above are frozen; this block owns its own driver, fixtures,
// and full cleanup, and proves the terminal boundary the revocation verb
// creates: once revoked, capture and adjudication refuse value-free forever.
// ---------------------------------------------------------------------------

describeLive('EvidenceAuthorityLedger coverage revocation live Neo4j gate (RET-005B-AUTH-001B3B1)', () => {
  const revocationDriver = createNeo4jDriver(uri, user, password);
  const revocationSuffix = randomUUID().toLowerCase();
  const revocationTenantId = `test-evidence-revocation-${revocationSuffix}`;
  const revocationProjectScope = `project:test-evidence-revocation-${revocationSuffix}`;
  const revocationSemanticIds = [
    'semantic-revocation-terminal',
    'semantic-revocation-freeze',
    'semantic-revocation-replay',
  ].map((value) => `${value}-${revocationSuffix}`);
  const revocationScope = (semanticId: string): EvidenceAuthorityScopeV1 => ({
    tenantId: revocationTenantId,
    projectScope: revocationProjectScope,
    semanticId,
  });

  async function revocationScalar(
    query: string,
    key: string,
    params: Record<string, unknown> = {},
  ): Promise<number> {
    const session = revocationDriver.session();
    try {
      const result = await session.run(query, params);
      return Number(result.records[0]?.get(key) ?? 0);
    } finally {
      await session.close();
    }
  }

  async function revocationLedgerCounts(semanticId: string) {
    const params = { tenantId: revocationTenantId, semanticId };
    return {
      events: await revocationScalar(
        'MATCH (n:EvidenceAuthorityEvent {tenant_id: $tenantId, semantic_id: $semanticId}) RETURN count(n) AS count',
        'count',
        params,
      ),
      outboxes: await revocationScalar(
        'MATCH (n:EvidenceAuthorityOutbox {tenant_id: $tenantId, semantic_id: $semanticId}) RETURN count(n) AS count',
        'count',
        params,
      ),
      coverage: await revocationScalar(
        'MATCH (n:EvidenceAuthorityCoverage {tenant_id: $tenantId, semantic_id: $semanticId}) RETURN count(n) AS count',
        'count',
        params,
      ),
      cases: await revocationScalar(
        'MATCH (n:EvidenceAuthorityCase {tenant_id: $tenantId, semantic_id: $semanticId}) RETURN count(n) AS count',
        'count',
        params,
      ),
    };
  }

  beforeAll(async () => {
    await revocationDriver.getServerInfo();
    const migration = MIGRATIONS.find((item) => item.id === '0008-evidence-authority-ledger-v1');
    expect(migration).toBeDefined();
    await migration!.up(revocationDriver);
    await initSchema(revocationDriver);
    const session = revocationDriver.session();
    try {
      for (const semanticId of revocationSemanticIds) {
        await session.run(
          `CREATE (s:Semantic {
             id: $semanticId, tenant_id: $tenantId, scope: $projectScope,
             content: 'disposable synthetic revocation fixture', confidence: 1.0,
             signal_count: 0, created_at: datetime(), updated_at: datetime(),
             decay_class: 'stable', tags: [$projectScope]
           })`,
          {
            semanticId,
            tenantId: revocationTenantId,
            projectScope: revocationProjectScope,
          },
        );
      }
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    if (LIVE_ENABLED) {
      const session = revocationDriver.session();
      try {
        await session.run(
          `MATCH (n)
           WHERE n.tenant_id = $tenantId
              OR n.project_scope = $projectScope
              OR n.semantic_id IN $semanticIds
              OR n.scope = $projectScope
              OR n.id IN $semanticIds
           DETACH DELETE n`,
          {
            tenantId: revocationTenantId,
            projectScope: revocationProjectScope,
            semanticIds: revocationSemanticIds,
          },
        );
        const residue = await session.run(
          `MATCH (n)
           WHERE n.tenant_id = $tenantId
              OR n.project_scope = $projectScope
              OR n.semantic_id IN $semanticIds
              OR n.scope = $projectScope
              OR n.id IN $semanticIds
           RETURN count(n) AS count`,
          {
            tenantId: revocationTenantId,
            projectScope: revocationProjectScope,
            semanticIds: revocationSemanticIds,
          },
        );
        expect(Number(residue.records[0]?.get('count') ?? -1)).toBe(0);
      } finally {
        await session.close();
      }
    }
    await revocationDriver.close().catch(() => undefined);
  });

  it('proves the terminal boundary end to end: capture, revoke through the unwired module, then capture and adjudication refuse value-free with zero writes and a passing audit', async () => {
    const semanticId = revocationSemanticIds[0]!;
    const primary = revocationScope(semanticId);
    const store = createEvidenceAuthorityLedgerPersistence(revocationDriver);
    const captureFacet = createEvidenceAuthorityCaptureFacet(store, primary);
    const captured = await store.captureCase(captureFacet, primary, {
      caseId: 'revocation-case-live-terminal',
      coverageOperationId: 'revocation-op-coverage-live-terminal',
      caseOperationId: 'revocation-op-case-live-terminal',
    });
    expect(captured.caseReceipt).toMatchObject({
      kind: 'case', action: 'case_opened', state: 'pending', sequence: 2,
    });
    expect(await revocationLedgerCounts(semanticId)).toEqual({
      events: 2, outboxes: 2, coverage: 1, cases: 1,
    });

    const revocation = createEvidenceAuthorityRevocation(revocationDriver, {
      tenantId: revocationTenantId,
      projectScope: revocationProjectScope,
      principalId: 'principal-live-rev-alpha',
    });
    const revoked = await revocation.revoke({ semanticId });
    expect(revoked.outcome).toBe('revoked');
    expect(revoked.outcome === 'revoked' && revoked.receipt).toMatchObject({
      kind: 'coverage', action: 'revoked', state: 'revoked', sequence: 3,
    });
    expect(await revocationLedgerCounts(semanticId)).toEqual({
      events: 3, outboxes: 3, coverage: 1, cases: 1,
    });

    // Capture against the revoked coverage is terminal: UNCAPTURED, not thrown.
    const capture = createEvidenceAuthorityCapture(revocationDriver);
    const late = await capture.capture({
      tenantId: revocationTenantId,
      projectScope: revocationProjectScope,
      semanticId,
      signalKind: 'contradiction' as const,
      sourceEpisodeId: `_ep-rev-late-${revocationSuffix}`,
    });
    expect(late).toEqual({
      contractVersion: 'memberry.evidence-authority-capture/1.0.0',
      outcome: 'uncaptured',
      code: 'uncaptured',
    });
    expect(await revocationLedgerCounts(semanticId)).toEqual({
      events: 3, outboxes: 3, coverage: 1, cases: 1,
    });

    // Adjudication of the frozen case is terminal: UNADJUDICATED, not thrown.
    const adjudication = createEvidenceAuthorityAdjudication(revocationDriver, {
      tenantId: revocationTenantId,
      projectScope: revocationProjectScope,
      principalId: 'principal-live-rev-alpha',
    });
    const unadjudicated = await adjudication.adjudicate({
      semanticId,
      caseId: 'revocation-case-live-terminal',
      decision: 'reject' as const,
    });
    expect(unadjudicated).toEqual({
      contractVersion: 'memberry.evidence-authority-adjudication/1.0.0',
      outcome: 'unadjudicated',
      code: 'unadjudicated',
    });
    expect(await revocationLedgerCounts(semanticId)).toEqual({
      events: 3, outboxes: 3, coverage: 1, cases: 1,
    });

    // The full-history audit still passes after every refusal: an exact
    // same-principal replay re-runs lock/audit/replay and returns the stored
    // receipt without appending.
    const replay = await revocation.revoke({ semanticId });
    expect(replay).toEqual(revoked);
    expect(await revocationLedgerCounts(semanticId)).toEqual({
      events: 3, outboxes: 3, coverage: 1, cases: 1,
    });
  }, 120_000);

  it('accepts revocation over an open case and freezes it permanently, with later transitions refused and the audit passing', async () => {
    const semanticId = revocationSemanticIds[1]!;
    const primary = revocationScope(semanticId);
    const store = createEvidenceAuthorityLedgerPersistence(revocationDriver);
    const captureFacet = createEvidenceAuthorityCaptureFacet(store, primary);
    const review = createEvidenceAuthorityReviewFacet(store, primary);
    await store.captureCase(captureFacet, primary, {
      caseId: 'revocation-case-live-frozen',
      coverageOperationId: 'revocation-op-coverage-live-frozen',
      caseOperationId: 'revocation-op-case-live-frozen',
    });

    const revocation = createEvidenceAuthorityRevocation(revocationDriver, {
      tenantId: revocationTenantId,
      projectScope: revocationProjectScope,
      principalId: 'principal-live-rev-alpha',
    });
    const revoked = await revocation.revoke({ semanticId });
    expect(revoked.outcome).toBe('revoked');
    expect(revoked.outcome === 'revoked' && revoked.receipt).toMatchObject({
      kind: 'coverage', action: 'revoked', state: 'revoked', sequence: 3,
    });

    // The ledger boundary refuses the frozen case content-free with zero writes.
    await expect(store.adjudicateCase(review, primary, {
      caseId: 'revocation-case-live-frozen',
      operationId: 'revocation-op-late-adjudication',
      action: 'rejected',
    })).rejects.toMatchObject({ code: 'facet_revoked' });
    expect(await revocationLedgerCounts(semanticId)).toEqual({
      events: 3, outboxes: 3, coverage: 1, cases: 1,
    });

    // The case history is frozen at exactly its opening event, forever pending.
    expect(await revocationScalar(
      `MATCH (e:EvidenceAuthorityEvent {tenant_id: $tenantId, semantic_id: $semanticId, case_id: $caseId})
       RETURN count(e) AS count`,
      'count',
      {
        tenantId: revocationTenantId,
        semanticId,
        caseId: 'revocation-case-live-frozen',
      },
    )).toBe(1);

    // A passing exact replay proves the frozen history remains audit-valid.
    const replay = await revocation.revoke({ semanticId });
    expect(replay).toEqual(revoked);
    expect(await revocationLedgerCounts(semanticId)).toEqual({
      events: 3, outboxes: 3, coverage: 1, cases: 1,
    });
  }, 120_000);

  it('replays same-principal revocation, refuses cross-principal replay-as-forgery, and stores nothing attributable', async () => {
    const semanticId = revocationSemanticIds[2]!;
    const primary = revocationScope(semanticId);
    const store = createEvidenceAuthorityLedgerPersistence(revocationDriver);
    const captureFacet = createEvidenceAuthorityCaptureFacet(store, primary);
    await store.captureCase(captureFacet, primary, {
      caseId: 'revocation-case-live-replay',
      coverageOperationId: 'revocation-op-coverage-live-replay',
      caseOperationId: 'revocation-op-case-live-replay',
    });

    const alpha = createEvidenceAuthorityRevocation(revocationDriver, {
      tenantId: revocationTenantId,
      projectScope: revocationProjectScope,
      principalId: 'principal-live-rev-alpha',
    });
    const first = await alpha.revoke({ semanticId });
    expect(first.outcome).toBe('revoked');
    expect(await revocationLedgerCounts(semanticId)).toEqual({
      events: 3, outboxes: 3, coverage: 1, cases: 1,
    });

    const replay = await alpha.revoke({ semanticId });
    expect(replay).toEqual(first);
    expect(await revocationLedgerCounts(semanticId)).toEqual({
      events: 3, outboxes: 3, coverage: 1, cases: 1,
    });

    const beta = createEvidenceAuthorityRevocation(revocationDriver, {
      tenantId: revocationTenantId,
      projectScope: revocationProjectScope,
      principalId: 'principal-live-rev-beta',
    });
    const forged = await beta.revoke({ semanticId });
    expect(forged).toEqual({
      contractVersion: 'memberry.evidence-authority-revocation/1.0.0',
      outcome: 'unrevoked',
      code: 'unrevoked',
    });
    expect(await revocationLedgerCounts(semanticId)).toEqual({
      events: 3, outboxes: 3, coverage: 1, cases: 1,
    });

    // Durable anonymity: no stored value records or permits recovery of the
    // construction-bound label.
    expect(await revocationScalar(
      `MATCH (n)
       WHERE n.tenant_id = $tenantId AND n.semantic_id = $semanticId
         AND (n.id CONTAINS $label OR n.operation_id CONTAINS $label OR n.case_id CONTAINS $label)
       RETURN count(n) AS count`,
      'count',
      {
        tenantId: revocationTenantId,
        semanticId,
        label: 'principal-live-rev-alpha',
      },
    )).toBe(0);
  }, 120_000);
});

describeLive('EvidenceAuthorityRead live Neo4j gate (RET-005B-AUTH-001B3B2)', () => {
  const readDriver = createNeo4jDriver(uri, user, password);
  const readSuffix = randomUUID().toLowerCase();
  const readTenantId = `test-evidence-read-${readSuffix}`;
  const readProjectScope = `project:test-evidence-read-${readSuffix}`;
  const readSemanticIds = [
    'semantic-read-listing',
    'semantic-read-revoked',
    'semantic-read-pull',
    'semantic-read-uncovered',
    'semantic-read-missing',
  ].map((value) => `${value}-${readSuffix}`);
  const readScope = (semanticId: string): EvidenceAuthorityScopeV1 => ({
    tenantId: readTenantId,
    projectScope: readProjectScope,
    semanticId,
  });
  const READ_CONTRACT_VERSION = 'memberry.evidence-authority-read/1.0.0';
  const EMPTY_READ_LISTING = Object.freeze({
    contractVersion: READ_CONTRACT_VERSION,
    coverageState: 'none',
    cases: {},
    truncated: false,
    observedVersion: 0,
  });
  const EMPTY_READ_PAGE = Object.freeze({
    contractVersion: READ_CONTRACT_VERSION,
    rows: [],
    observedVersion: 0,
  });
  let createEvidenceAuthorityRead:
    typeof import('../evidence-authority-read.js')['createEvidenceAuthorityRead'];
  let liveCreateHash: typeof import('node:crypto')['createHash'];

  const readLiveDigest = (kind: string, ...values: string[]): string => {
    const input = JSON.stringify(['memberry-evidence-authority-ledger-v1', kind, ...values]);
    return `evidence-authority:${kind}:sha256:${liveCreateHash('sha256').update(input).digest('hex')}`;
  };

  async function readScalar(
    query: string,
    key: string,
    params: Record<string, unknown> = {},
  ): Promise<number> {
    const session = readDriver.session();
    try {
      const result = await session.run(query, params);
      return Number(result.records[0]?.get(key) ?? 0);
    } finally {
      await session.close();
    }
  }

  async function readTenantCounts() {
    const params = { tenantId: readTenantId };
    const count = (label: string) => readScalar(
      `MATCH (n:${label} {tenant_id: $tenantId}) RETURN count(n) AS count`,
      'count',
      params,
    );
    return {
      ledgers: await count('EvidenceAuthorityLedger'),
      events: await count('EvidenceAuthorityEvent'),
      outboxes: await count('EvidenceAuthorityOutbox'),
      coverage: await count('EvidenceAuthorityCoverage'),
      cases: await count('EvidenceAuthorityCase'),
    };
  }

  async function readLedgerVersion(semanticId: string): Promise<number> {
    return readScalar(
      `MATCH (l:EvidenceAuthorityLedger {tenant_id: $tenantId, semantic_id: $semanticId})
       RETURN l.version AS version`,
      'version',
      { tenantId: readTenantId, semanticId },
    );
  }

  beforeAll(async () => {
    ({ createEvidenceAuthorityRead } = await import('../evidence-authority-read.js'));
    ({ createHash: liveCreateHash } = await import('node:crypto'));
    await readDriver.getServerInfo();
    const migration = MIGRATIONS.find((item) => item.id === '0008-evidence-authority-ledger-v1');
    expect(migration).toBeDefined();
    await migration!.up(readDriver);
    await initSchema(readDriver);
    const session = readDriver.session();
    try {
      // The 'semantic-read-missing' id deliberately gets NO Semantic node and
      // no ledger: it is the entirely-absent arm.
      for (const semanticId of readSemanticIds.slice(0, 4)) {
        await session.run(
          `CREATE (s:Semantic {
             id: $semanticId, tenant_id: $tenantId, scope: $projectScope,
             content: 'disposable synthetic read fixture', confidence: 1.0,
             signal_count: 0, created_at: datetime(), updated_at: datetime(),
             decay_class: 'stable', tags: [$projectScope]
           })`,
          {
            semanticId,
            tenantId: readTenantId,
            projectScope: readProjectScope,
          },
        );
      }
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    if (LIVE_ENABLED) {
      const session = readDriver.session();
      try {
        await session.run(
          `MATCH (n)
           WHERE n.tenant_id = $tenantId
              OR n.project_scope = $projectScope
              OR n.semantic_id IN $semanticIds
              OR n.scope = $projectScope
              OR n.id IN $semanticIds
           DETACH DELETE n`,
          {
            tenantId: readTenantId,
            projectScope: readProjectScope,
            semanticIds: readSemanticIds,
          },
        );
        const residue = await session.run(
          `MATCH (n)
           WHERE n.tenant_id = $tenantId
              OR n.project_scope = $projectScope
              OR n.semantic_id IN $semanticIds
              OR n.scope = $projectScope
              OR n.id IN $semanticIds
           RETURN count(n) AS count`,
          {
            tenantId: readTenantId,
            projectScope: readProjectScope,
            semanticIds: readSemanticIds,
          },
        );
        expect(Number(residue.records[0]?.get('count') ?? -1)).toBe(0);
      } finally {
        await session.close();
      }
    }
    await readDriver.close().catch(() => undefined);
  });

  it('lists the live case map exactly, with the real ledger version (K22)', async () => {
    const semanticId = readSemanticIds[0]!;
    const primary = readScope(semanticId);
    const store = createEvidenceAuthorityLedgerPersistence(readDriver);
    const captureFacet = createEvidenceAuthorityCaptureFacet(store, primary);
    const review = createEvidenceAuthorityReviewFacet(store, primary);
    await store.captureCase(captureFacet, primary, {
      caseId: 'read-case-alpha',
      coverageOperationId: 'read-op-coverage-listing',
      caseOperationId: 'read-op-case-alpha-open',
    });
    // Exact replays return the stored receipts plus the coverage/case facets
    // without appending: the facet-recovery path the write suite proves.
    const coverage = await store.openCoverage(captureFacet, primary, {
      operationId: 'read-op-coverage-listing',
    });
    const caseAlpha = await store.openCase(captureFacet, coverage.facet, primary, {
      caseId: 'read-case-alpha',
      operationId: 'read-op-case-alpha-open',
    });
    const caseBeta = await store.openCase(captureFacet, coverage.facet, primary, {
      caseId: 'read-case-beta',
      operationId: 'read-op-case-beta-open',
    });
    await store.beginResolution(review, caseAlpha.facet, primary, {
      operationId: 'read-op-case-alpha-start',
    });
    await store.resolveCase(review, caseAlpha.facet, primary, {
      operationId: 'read-op-case-alpha-done',
    });
    await store.rejectCase(review, caseBeta.facet, primary, {
      operationId: 'read-op-case-beta-reject',
    });

    const read = createEvidenceAuthorityRead(readDriver, primary);
    const listing = await read.listCases();
    expect(listing.coverageState).toBe('open');
    expect({ ...listing.cases }).toEqual({
      'read-case-alpha': 'resolved',
      'read-case-beta': 'rejected',
    });
    expect(listing.truncated).toBe(false);
    expect(listing.observedVersion).toBe(await readLedgerVersion(semanticId));
    expect(listing.observedVersion).toBe(6);
  }, 120_000);

  it('shows revocation with frozen case states, and EMPTY_LISTING for uncovered and absent (K23)', async () => {
    const semanticId = readSemanticIds[1]!;
    const primary = readScope(semanticId);
    const store = createEvidenceAuthorityLedgerPersistence(readDriver);
    const captureFacet = createEvidenceAuthorityCaptureFacet(store, primary);
    await store.captureCase(captureFacet, primary, {
      caseId: 'read-case-frozen',
      coverageOperationId: 'read-op-coverage-revoked',
      caseOperationId: 'read-op-case-frozen-open',
    });
    const revocation = createEvidenceAuthorityRevocation(readDriver, {
      tenantId: readTenantId,
      projectScope: readProjectScope,
      principalId: 'principal-live-read-alpha',
    });
    const revoked = await revocation.revoke({ semanticId });
    expect(revoked.outcome).toBe('revoked');

    const read = createEvidenceAuthorityRead(readDriver, primary);
    const listing = await read.listCases();
    expect(listing.coverageState).toBe('revoked');
    expect({ ...listing.cases }).toEqual({ 'read-case-frozen': 'pending' });
    expect(listing.truncated).toBe(false);
    expect(listing.observedVersion).toBe(3);

    const uncovered = createEvidenceAuthorityRead(readDriver, readScope(readSemanticIds[3]!));
    expect(await uncovered.listCases()).toEqual(EMPTY_READ_LISTING);
    const absent = createEvidenceAuthorityRead(readDriver, readScope(readSemanticIds[4]!));
    expect(await absent.listCases()).toEqual(EMPTY_READ_LISTING);
  }, 120_000);

  it('drains the live outbox in cursor pages, digest chain recomputed, replay identical (K24)', async () => {
    const semanticId = readSemanticIds[2]!;
    const primary = readScope(semanticId);
    const store = createEvidenceAuthorityLedgerPersistence(readDriver);
    const captureFacet = createEvidenceAuthorityCaptureFacet(store, primary);
    const review = createEvidenceAuthorityReviewFacet(store, primary);
    await store.captureCase(captureFacet, primary, {
      caseId: 'read-case-pull-a',
      coverageOperationId: 'read-op-coverage-pull',
      caseOperationId: 'read-op-case-pull-a-open',
    });
    const coverage = await store.openCoverage(captureFacet, primary, {
      operationId: 'read-op-coverage-pull',
    });
    const caseA = await store.openCase(captureFacet, coverage.facet, primary, {
      caseId: 'read-case-pull-a',
      operationId: 'read-op-case-pull-a-open',
    });
    await store.openCase(captureFacet, coverage.facet, primary, {
      caseId: 'read-case-pull-b',
      operationId: 'read-op-case-pull-b-open',
    });
    await store.beginResolution(review, caseA.facet, primary, {
      operationId: 'read-op-case-pull-a-start',
    });
    await store.resolveCase(review, caseA.facet, primary, {
      operationId: 'read-op-case-pull-a-done',
    });

    const read = createEvidenceAuthorityRead(readDriver, primary);
    const pulled: Array<{
      id: string; eventId: string; sequence: number; caseId: string | null;
      kind: string; action: string; state: string; recordedAt: string;
    }> = [];
    let cursor = 0;
    for (;;) {
      const page = await read.pullOutbox({ afterSequence: cursor, limit: 2 });
      expect(page.observedVersion).toBe(5);
      if (page.rows.length === 0) break;
      expect(page.rows.length).toBeLessThanOrEqual(2);
      pulled.push(...page.rows);
      cursor = page.rows[page.rows.length - 1]!.sequence;
    }
    expect(pulled.map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5]);

    const session = readDriver.session();
    try {
      const result = await session.run(
        `MATCH (ledger:EvidenceAuthorityLedger {tenant_id: $tenantId, semantic_id: $semanticId})
               -[:HAS_EVENT]->(event:EvidenceAuthorityEvent)-[:EMITTED]->(outbox:EvidenceAuthorityOutbox)
         RETURN properties(event) AS event, properties(outbox) AS outbox
         ORDER BY event.sequence ASC`,
        { tenantId: readTenantId, semanticId },
      );
      expect(result.records).toHaveLength(pulled.length);
      result.records.forEach((record, index) => {
        const event = record.get('event') as Record<string, unknown>;
        const outbox = record.get('outbox') as Record<string, unknown>;
        const row = pulled[index]!;
        const expectedEventId = readLiveDigest(
          'event', readTenantId, readProjectScope, semanticId, String(event.operation_id),
        );
        const expectedOutboxId = readLiveDigest('outbox', expectedEventId);
        expect(event.id).toBe(expectedEventId);
        expect(row.eventId).toBe(expectedEventId);
        expect(outbox.id).toBe(expectedOutboxId);
        expect(row.id).toBe(expectedOutboxId);
        expect(outbox.event_id).toBe(expectedEventId);
        expect(row.sequence).toBe(Number(event.sequence));
        expect(row.sequence).toBe(Number(outbox.sequence));
        expect(row.kind).toBe(event.kind);
        expect(row.action).toBe(event.action);
        expect(row.state).toBe(event.state);
        expect(row.recordedAt).toBe(event.recorded_at);
        expect(row.caseId).toBe(event.case_id === '' ? null : event.case_id);
      });
    } finally {
      await session.close();
    }

    const firstPage = await read.pullOutbox({ afterSequence: 0, limit: 2 });
    const replayPage = await read.pullOutbox({ afterSequence: 0, limit: 2 });
    expect(replayPage).toEqual(firstPage);
    expect(replayPage.rows.map((row) => row.sequence)).toEqual([1, 2]);
  }, 120_000);

  it('proves zero writes: counts and versions identical after a full listing and drain, and no ledger minted for an absent scope (K25, F11)', async () => {
    const semanticId = readSemanticIds[2]!;
    const before = await readTenantCounts();
    const versionBefore = await readLedgerVersion(semanticId);

    const read = createEvidenceAuthorityRead(readDriver, readScope(semanticId));
    await read.listCases();
    let cursor = 0;
    for (;;) {
      const page = await read.pullOutbox({ afterSequence: cursor, limit: 2 });
      if (page.rows.length === 0) break;
      cursor = page.rows[page.rows.length - 1]!.sequence;
    }

    const ghostSemanticId = readSemanticIds[4]!;
    const ghost = createEvidenceAuthorityRead(readDriver, readScope(ghostSemanticId));
    expect(await ghost.listCases()).toEqual(EMPTY_READ_LISTING);
    expect(await ghost.pullOutbox({ afterSequence: 0 })).toEqual(EMPTY_READ_PAGE);
    expect(await readScalar(
      `MATCH (l:EvidenceAuthorityLedger {tenant_id: $tenantId, semantic_id: $semanticId})
       RETURN count(l) AS count`,
      'count',
      { tenantId: readTenantId, semanticId: ghostSemanticId },
    )).toBe(0);

    expect(await readTenantCounts()).toEqual(before);
    expect(await readLedgerVersion(semanticId)).toBe(versionBefore);
  }, 120_000);

  it('succeeds end to end in READ access mode: no statement requires write capability (K26)', async () => {
    const modes: unknown[] = [];
    const modeDriver = {
      session: (config?: { defaultAccessMode?: unknown }) => {
        modes.push(config?.defaultAccessMode);
        return readDriver.session(config as never);
      },
    } as unknown as Driver;
    const read = createEvidenceAuthorityRead(modeDriver, readScope(readSemanticIds[0]!));
    const listing = await read.listCases();
    expect(listing.coverageState).toBe('open');
    const page = await read.pullOutbox({ afterSequence: 0 });
    expect(page.rows.length).toBeGreaterThan(0);
    expect(modes).toHaveLength(2);
    expect(modes.every((mode) => mode === 'READ')).toBe(true);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// RET-005B-AUTH-001B4: additive clearance derivation live gate. Every suite
// above is frozen; this block owns its own driver, fixtures, and full
// cleanup, and proves what no fake can: the capture digest hand copy against
// real ledger bytes, the record-time invariant against real datetime()
// output, the zero-edge collect semantic, and the read-only posture.
// ---------------------------------------------------------------------------

describeLive('EvidenceAuthorityClearance live Neo4j gate (RET-005B-AUTH-001B4)', () => {
  const clearanceDriver = createNeo4jDriver(uri, user, password);
  const clearanceSuffix = randomUUID().toLowerCase();
  const clearanceTenantId = `test-evidence-clearance-${clearanceSuffix}`;
  const clearanceProjectScope = `project:test-evidence-clearance-${clearanceSuffix}`;
  const clearanceSemanticIds = [
    'semantic-clearance-clear',
    'semantic-clearance-truncated',
    'semantic-clearance-readonly',
    'semantic-clearance-zeroedge',
    'semantic-clearance-absent',
  ].map((value) => `${value}-${clearanceSuffix}`);
  const clearanceEpisodeId = `ep-clearance-${clearanceSuffix}`;
  const clearanceScopeOf = (semanticId: string): EvidenceAuthorityScopeV1 => ({
    tenantId: clearanceTenantId,
    projectScope: clearanceProjectScope,
    semanticId,
  });
  let createEvidenceAuthorityClearance:
    typeof import('../evidence-authority-clearance.js')['createEvidenceAuthorityClearance'];
  let clearanceCreateHash: typeof import('node:crypto')['createHash'];
  let liveNeo4j: typeof import('neo4j-driver')['default'];

  // Test-local hand copy of the capture case digest; never imported from the
  // module under test.
  const clearanceCaseId = (semanticId: string, sourceEpisodeId: string, signalKind: string): string => {
    const input = JSON.stringify([
      'memberry-evidence-authority-capture-v1', 'case',
      clearanceTenantId, clearanceProjectScope, semanticId,
      sourceEpisodeId, signalKind,
    ]);
    return `capture-case-${clearanceCreateHash('sha256').update(input).digest('hex')}`;
  };

  async function clearanceScalar(
    query: string,
    key: string,
    params: Record<string, unknown> = {},
  ): Promise<number> {
    const session = clearanceDriver.session();
    try {
      const result = await session.run(query, params);
      return Number(result.records[0]?.get(key) ?? 0);
    } finally {
      await session.close();
    }
  }

  async function clearanceString(
    query: string,
    key: string,
    params: Record<string, unknown> = {},
  ): Promise<string> {
    const session = clearanceDriver.session();
    try {
      const result = await session.run(query, params);
      return String(result.records[0]?.get(key) ?? '');
    } finally {
      await session.close();
    }
  }

  async function clearanceTenantCounts() {
    const params = { tenantId: clearanceTenantId };
    const count = (label: string) => clearanceScalar(
      `MATCH (n:${label} {tenant_id: $tenantId}) RETURN count(n) AS count`,
      'count',
      params,
    );
    return {
      ledgers: await count('EvidenceAuthorityLedger'),
      events: await count('EvidenceAuthorityEvent'),
      outboxes: await count('EvidenceAuthorityOutbox'),
      coverage: await count('EvidenceAuthorityCoverage'),
      cases: await count('EvidenceAuthorityCase'),
    };
  }

  async function clearanceLedgerVersion(semanticId: string): Promise<number> {
    return clearanceScalar(
      `MATCH (l:EvidenceAuthorityLedger {tenant_id: $tenantId, semantic_id: $semanticId})
       RETURN l.version AS version`,
      'version',
      { tenantId: clearanceTenantId, semanticId },
    );
  }

  beforeAll(async () => {
    ({ createEvidenceAuthorityClearance } = await import('../evidence-authority-clearance.js'));
    ({ createHash: clearanceCreateHash } = await import('node:crypto'));
    ({ default: liveNeo4j } = await import('neo4j-driver'));
    await clearanceDriver.getServerInfo();
    const migration = MIGRATIONS.find((item) => item.id === '0008-evidence-authority-ledger-v1');
    expect(migration).toBeDefined();
    await migration!.up(clearanceDriver);
    await initSchema(clearanceDriver);
    const session = clearanceDriver.session();
    try {
      // The 'semantic-clearance-absent' id deliberately gets NO Semantic node
      // and no ledger: it is the entirely-absent arm of the zero-writes test.
      for (const semanticId of clearanceSemanticIds.slice(0, 4)) {
        await session.run(
          `CREATE (s:Semantic {
             id: $semanticId, tenant_id: $tenantId, scope: $projectScope,
             content: 'disposable synthetic clearance fixture', confidence: 1.0,
             signal_count: 0, created_at: datetime(), updated_at: datetime(),
             decay_class: 'stable', tags: [$projectScope]
           })`,
          {
            semanticId,
            tenantId: clearanceTenantId,
            projectScope: clearanceProjectScope,
          },
        );
      }
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    if (LIVE_ENABLED) {
      const session = clearanceDriver.session();
      try {
        await session.run(
          `MATCH (n)
           WHERE n.tenant_id = $tenantId
              OR n.project_scope = $projectScope
              OR n.semantic_id IN $semanticIds
              OR n.scope = $projectScope
              OR n.id IN $nodeIds
           DETACH DELETE n`,
          {
            tenantId: clearanceTenantId,
            projectScope: clearanceProjectScope,
            semanticIds: clearanceSemanticIds,
            nodeIds: [...clearanceSemanticIds, clearanceEpisodeId],
          },
        );
        const residue = await session.run(
          `MATCH (n)
           WHERE n.tenant_id = $tenantId
              OR n.project_scope = $projectScope
              OR n.semantic_id IN $semanticIds
              OR n.scope = $projectScope
              OR n.id IN $nodeIds
           RETURN count(n) AS count`,
          {
            tenantId: clearanceTenantId,
            projectScope: clearanceProjectScope,
            semanticIds: clearanceSemanticIds,
            nodeIds: [...clearanceSemanticIds, clearanceEpisodeId],
          },
        );
        expect(Number(residue.records[0]?.get('count') ?? -1)).toBe(0);
      } finally {
        await session.close();
      }
    }
    await clearanceDriver.close().catch(() => undefined);
  });

  it('derives a live end-to-end clear: capture first, edge second, adjudicate to rejected (J27, E1.7)', async () => {
    const semanticId = clearanceSemanticIds[0]!;
    // Capture FIRST: on a healthy ledger no other order is reachable, because
    // capture refuses unless the raw signal count is zero.
    const capture = createEvidenceAuthorityCapture(clearanceDriver);
    const captured = await capture.capture({
      tenantId: clearanceTenantId,
      projectScope: clearanceProjectScope,
      semanticId,
      signalKind: 'contradiction' as const,
      sourceEpisodeId: clearanceEpisodeId,
    });
    expect(captured.outcome).toBe('captured');
    // Edge SECOND, with the producer's app-clock string valid time.
    const appValidAt = new Date().toISOString();
    const session = clearanceDriver.session();
    try {
      await session.run(
        `MATCH (s:Semantic {id: $semanticId, tenant_id: $tenantId})
         CREATE (e:Episodic {
           id: $episodeId, tenant_id: $tenantId, scope: $projectScope,
           content: 'disposable synthetic clearance signal', created_at: datetime()
         })
         CREATE (e)-[:CONTRADICTS {valid_at: $validAt}]->(s)`,
        {
          semanticId,
          tenantId: clearanceTenantId,
          projectScope: clearanceProjectScope,
          episodeId: clearanceEpisodeId,
          validAt: appValidAt,
        },
      );
    } finally {
      await session.close();
    }
    // Record both real timestamps for the cross-clock note: server-clock
    // coverage record time vs app-clock edge valid time.
    const serverRecordedAt = await clearanceString(
      `MATCH (e:EvidenceAuthorityEvent {tenant_id: $tenantId, semantic_id: $semanticId, kind: 'coverage', action: 'opened'})
       RETURN e.recorded_at AS recordedAt`,
      'recordedAt',
      { tenantId: clearanceTenantId, semanticId },
    );
    console.info(`[auth001b4 cross-clock] coverage recorded_at=${serverRecordedAt} edge valid_at=${appValidAt}`);
    // Adjudicate the digested case to rejected.
    const adjudication = createEvidenceAuthorityAdjudication(clearanceDriver, {
      tenantId: clearanceTenantId,
      projectScope: clearanceProjectScope,
      principalId: 'principal-live-clearance-alpha',
    });
    const adjudicated = await adjudication.adjudicate({
      semanticId,
      caseId: clearanceCaseId(semanticId, clearanceEpisodeId, 'contradiction'),
      decision: 'reject' as const,
    });
    expect(adjudicated.outcome).toBe('adjudicated');
    // The decisive derivation: digest hand copy, argument order, prefix,
    // canonical-instant predicate against real datetime() bytes, and the
    // record-time invariant all agree with the ledger or this is red.
    const clearanceSurface = createEvidenceAuthorityClearance(
      clearanceDriver,
      clearanceScopeOf(semanticId),
    );
    const result = await clearanceSurface.deriveClearance({ mode: 'current' });
    expect(result).toEqual({
      contractVersion: 'memberry.evidence-authority-clearance/1.0.0',
      outcome: 'clear',
      observedVersion: await clearanceLedgerVersion(semanticId),
    });
    expect(result.outcome === 'clear' && result.observedVersion).toBe(3);
  }, 120_000);

  it('flips to a coverage gap on live revocation with the case states frozen (J28)', async () => {
    const semanticId = clearanceSemanticIds[0]!;
    const caseId = clearanceCaseId(semanticId, clearanceEpisodeId, 'contradiction');
    const caseEventsBefore = await clearanceScalar(
      `MATCH (e:EvidenceAuthorityEvent {tenant_id: $tenantId, semantic_id: $semanticId, case_id: $caseId})
       RETURN count(e) AS count`,
      'count',
      { tenantId: clearanceTenantId, semanticId, caseId },
    );
    const revocation = createEvidenceAuthorityRevocation(clearanceDriver, {
      tenantId: clearanceTenantId,
      projectScope: clearanceProjectScope,
      principalId: 'principal-live-clearance-alpha',
    });
    const revoked = await revocation.revoke({ semanticId });
    expect(revoked.outcome).toBe('revoked');
    const clearanceSurface = createEvidenceAuthorityClearance(
      clearanceDriver,
      clearanceScopeOf(semanticId),
    );
    expect(await clearanceSurface.deriveClearance({ mode: 'current' })).toEqual({
      contractVersion: 'memberry.evidence-authority-clearance/1.0.0',
      outcome: 'unsupported',
      code: 'clearance-coverage-gap',
    });
    // The rejected case history is frozen: revocation appended no case event.
    expect(await clearanceScalar(
      `MATCH (e:EvidenceAuthorityEvent {tenant_id: $tenantId, semantic_id: $semanticId, case_id: $caseId})
       RETURN count(e) AS count`,
      'count',
      { tenantId: clearanceTenantId, semanticId, caseId },
    )).toBe(caseEventsBefore);
  }, 120_000);

  it('refuses a live truncated listing with at least one case pending (J30, F2)', async () => {
    const semanticId = clearanceSemanticIds[1]!;
    const primary = clearanceScopeOf(semanticId);
    const store = createEvidenceAuthorityLedgerPersistence(clearanceDriver);
    const captureFacet = createEvidenceAuthorityCaptureFacet(store, primary);
    await store.captureCase(captureFacet, primary, {
      caseId: 'clearance-trunc-case-000',
      coverageOperationId: 'clearance-op-coverage-trunc',
      caseOperationId: 'clearance-op-case-trunc-000',
    });
    const coverage = await store.openCoverage(captureFacet, primary, {
      operationId: 'clearance-op-coverage-trunc',
    });
    for (let index = 1; index <= 200; index += 1) {
      const suffixed = String(index).padStart(3, '0');
      await store.openCase(captureFacet, coverage.facet, primary, {
        caseId: `clearance-trunc-case-${suffixed}`,
        operationId: `clearance-op-case-trunc-${suffixed}`,
      });
    }
    // 201 distinct cases, all pending: the listing truncates, and truncation
    // refuses before any case state can be weighed.
    expect(await clearanceScalar(
      `MATCH (c:EvidenceAuthorityCase {tenant_id: $tenantId, semantic_id: $semanticId})
       RETURN count(c) AS count`,
      'count',
      { tenantId: clearanceTenantId, semanticId },
    )).toBe(201);
    const pendingEvents = await clearanceScalar(
      `MATCH (e:EvidenceAuthorityEvent {tenant_id: $tenantId, semantic_id: $semanticId, kind: 'case', state: 'pending'})
       RETURN count(e) AS count`,
      'count',
      { tenantId: clearanceTenantId, semanticId },
    );
    expect(pendingEvents).toBeGreaterThanOrEqual(1);
    const clearanceSurface = createEvidenceAuthorityClearance(clearanceDriver, primary);
    expect(await clearanceSurface.deriveClearance({ mode: 'current' })).toEqual({
      contractVersion: 'memberry.evidence-authority-clearance/1.0.0',
      outcome: 'unsupported',
      code: 'clearance-coverage-gap',
    });
  }, 300_000);

  it('writes nothing: identical counts and version, no ledger minted for an absent scope, full run in READ mode (J31)', async () => {
    const semanticId = clearanceSemanticIds[2]!;
    // A clear-capable zero-edge ledger: capture, adjudicate to rejected.
    const capture = createEvidenceAuthorityCapture(clearanceDriver);
    const readonlyEpisodeId = `ep-clearance-readonly-${clearanceSuffix}`;
    expect((await capture.capture({
      tenantId: clearanceTenantId,
      projectScope: clearanceProjectScope,
      semanticId,
      signalKind: 'contradiction' as const,
      sourceEpisodeId: readonlyEpisodeId,
    })).outcome).toBe('captured');
    const adjudication = createEvidenceAuthorityAdjudication(clearanceDriver, {
      tenantId: clearanceTenantId,
      projectScope: clearanceProjectScope,
      principalId: 'principal-live-clearance-alpha',
    });
    expect((await adjudication.adjudicate({
      semanticId,
      caseId: clearanceCaseId(semanticId, readonlyEpisodeId, 'contradiction'),
      decision: 'reject' as const,
    })).outcome).toBe('adjudicated');

    const before = await clearanceTenantCounts();
    const versionBefore = await clearanceLedgerVersion(semanticId);

    // Every session the derivation opens must ask for READ access.
    const modes: unknown[] = [];
    const modeDriver = {
      session: (config?: { defaultAccessMode?: unknown }) => {
        modes.push(config?.defaultAccessMode);
        return clearanceDriver.session(config as never);
      },
    } as unknown as Driver;
    const clearanceSurface = createEvidenceAuthorityClearance(modeDriver, clearanceScopeOf(semanticId));
    const result = await clearanceSurface.deriveClearance({ mode: 'current' });
    expect(result).toEqual({
      contractVersion: 'memberry.evidence-authority-clearance/1.0.0',
      outcome: 'clear',
      observedVersion: versionBefore,
    });
    expect(modes).toHaveLength(3);
    expect(modes.every((mode) => mode === 'READ')).toBe(true);

    // A derivation against a Semantic with no ledger mints no ledger node.
    const ghostSemanticId = clearanceSemanticIds[4]!;
    const ghost = createEvidenceAuthorityClearance(clearanceDriver, clearanceScopeOf(ghostSemanticId));
    expect(await ghost.deriveClearance({ mode: 'current' })).toEqual({
      contractVersion: 'memberry.evidence-authority-clearance/1.0.0',
      outcome: 'unsupported',
      code: 'clearance-coverage-gap',
    });
    expect(await clearanceScalar(
      `MATCH (l:EvidenceAuthorityLedger {tenant_id: $tenantId, semantic_id: $semanticId})
       RETURN count(l) AS count`,
      'count',
      { tenantId: clearanceTenantId, semanticId: ghostSemanticId },
    )).toBe(0);

    expect(await clearanceTenantCounts()).toEqual(before);
    expect(await clearanceLedgerVersion(semanticId)).toBe(versionBefore);
  }, 120_000);

  it('proves the zero-edge collect semantic live: empty edges, driver-Integer zero count, clear (J32, E1.6)', async () => {
    const semanticId = clearanceSemanticIds[3]!;
    const capture = createEvidenceAuthorityCapture(clearanceDriver);
    const zeroEdgeEpisodeId = `ep-clearance-zeroedge-${clearanceSuffix}`;
    expect((await capture.capture({
      tenantId: clearanceTenantId,
      projectScope: clearanceProjectScope,
      semanticId,
      signalKind: 'contradiction' as const,
      sourceEpisodeId: zeroEdgeEpisodeId,
    })).outcome).toBe('captured');
    const adjudication = createEvidenceAuthorityAdjudication(clearanceDriver, {
      tenantId: clearanceTenantId,
      projectScope: clearanceProjectScope,
      principalId: 'principal-live-clearance-alpha',
    });
    expect((await adjudication.adjudicate({
      semanticId,
      caseId: clearanceCaseId(semanticId, zeroEdgeEpisodeId, 'contradiction'),
      decision: 'reject' as const,
    })).outcome).toBe('adjudicated');

    // Observe the raw edge statement's real server response on the way
    // through: collect must skip the null row, and count must arrive as a
    // driver Integer of zero. No client-side filtering exists to save it.
    const observed: Array<{ rawCount: unknown; edges: unknown }> = [];
    const observingDriver = {
      session: (config?: unknown) => {
        const session = clearanceDriver.session(config as never);
        return {
          executeRead: <T>(work: (tx: ManagedTransaction) => Promise<T>) => session.executeRead(
            async (tx) => work({
              run: async (query: string, params?: Record<string, unknown>) => {
                const result = await tx.run(query, params);
                if (query.includes('evidence-authority:clearance-raw-edges') && result.records.length === 1) {
                  observed.push({
                    rawCount: result.records[0]!.get('rawCount'),
                    edges: result.records[0]!.get('edges'),
                  });
                }
                return result;
              },
            } as ManagedTransaction),
          ),
          close: session.close.bind(session),
        } as unknown as Session;
      },
    } as unknown as Driver;
    const clearanceSurface = createEvidenceAuthorityClearance(observingDriver, clearanceScopeOf(semanticId));
    const result = await clearanceSurface.deriveClearance({ mode: 'current' });
    expect(result).toEqual({
      contractVersion: 'memberry.evidence-authority-clearance/1.0.0',
      outcome: 'clear',
      observedVersion: await clearanceLedgerVersion(semanticId),
    });
    expect(observed).toHaveLength(1);
    expect(liveNeo4j.isInt(observed[0]!.rawCount as object)).toBe(true);
    expect((observed[0]!.rawCount as { toNumber(): number }).toNumber()).toBe(0);
    expect(observed[0]!.edges).toEqual([]);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// RET-005B-AUTH-001B5: additive fact-state observation and composition live
// gate. Every suite above is frozen; this block owns its own driver, tenant,
// fixtures, and full cleanup, and proves what no fake can: the real dispute
// and invalidate write paths against the derived axes, the real SUPERSEDES_FACT
// edge arriving as a driver Integer, cross-tenant disclosure zero on a real
// graph, and the whole composition surviving the sealed parser end to end.
// ---------------------------------------------------------------------------

describeLive('EvidenceSourceFactState + composition live Neo4j gate (RET-005B-AUTH-001B5)', () => {
  const factStateDriver = createNeo4jDriver(uri, user, password);
  const factStateSuffix = randomUUID().toLowerCase();
  const factStateTenantId = `test-evidence-fact-state-${factStateSuffix}`;
  const factStateForeignTenantId = `test-evidence-fact-foreign-${factStateSuffix}`;
  const factStateProjectScope = `project:test-evidence-fact-state-${factStateSuffix}`;
  const factStateEntityId = `entity-fact-state-${factStateSuffix}`;
  const factStateOtherEntityId = `entity-fact-other-${factStateSuffix}`;
  const factStateId = (label: string): string => `fact-${label}-${factStateSuffix}`;
  const factStateIds = [
    'live-active', 'live-invalidated', 'live-disputed', 'live-superseding',
    'live-foreign-tenant', 'live-foreign-entity', 'compose-active',
    'compose-disputed', 'compose-invalidated', 'compose-superseding',
  ].map(factStateId);
  const factStateScope = Object.freeze({
    tenantId: factStateTenantId,
    projectScope: factStateProjectScope,
    resolvedEntityId: factStateEntityId,
  });
  const PAST_VALID_AT = '2026-01-01T00:00:00.000Z';
  const PAST_INVALID_AT = '2026-02-01T00:00:00.000Z';

  let createEvidenceSourceFactState:
    typeof import('../evidence-source-fact-state.js')['createEvidenceSourceFactState'];
  let createEvidenceEligibilityComposition:
    typeof import('../../../core/src/evidence-eligibility-composition.js')['createEvidenceEligibilityComposition'];
  let parseEvidenceEligibilityAuthorityResultV1:
    typeof import('../../../core/src/evidence-eligibility-authority.js')['parseEvidenceEligibilityAuthorityResultV1'];
  let LiveFactStore: typeof import('../fact.js')['FactStore'];

  async function factStateScalar(
    query: string,
    key: string,
    params: Record<string, unknown> = {},
  ): Promise<number> {
    const session = factStateDriver.session();
    try {
      const result = await session.run(query, params);
      return Number(result.records[0]?.get(key) ?? 0);
    } finally {
      await session.close();
    }
  }

  async function createLiveFact(input: {
    id: string;
    tenantId: string;
    entityId: string;
    status: string;
    validAt: string;
    invalidAt: string | null;
  }): Promise<void> {
    const session = factStateDriver.session();
    try {
      await session.run(
        `CREATE (f:Fact {
           id: $id, subject: 'disposable synthetic subject',
           predicate: 'is', object: 'disposable synthetic object',
           entity_id: $entityId, tenant_id: $tenantId, scope: 'project',
           source_episode_ids: [], valid_at: $validAt, invalid_at: $invalidAt,
           confidence: 1.0, status: $status, inference_type: 'deductive',
           tags: [$projectScope], created_at: $validAt, updated_at: $validAt
         })`,
        {
          id: input.id,
          entityId: input.entityId,
          tenantId: input.tenantId,
          status: input.status,
          validAt: input.validAt,
          invalidAt: input.invalidAt,
          projectScope: factStateProjectScope,
        },
      );
    } finally {
      await session.close();
    }
  }

  async function factStateTenantCounts() {
    const nodes = await factStateScalar(
      'MATCH (n) WHERE n.tenant_id IN $tenantIds RETURN count(n) AS count',
      'count',
      { tenantIds: [factStateTenantId, factStateForeignTenantId] },
    );
    const edges = await factStateScalar(
      `MATCH (a:Fact)-[r:SUPERSEDES_FACT]->(b:Fact)
       WHERE a.tenant_id IN $tenantIds OR b.tenant_id IN $tenantIds
       RETURN count(r) AS count`,
      'count',
      { tenantIds: [factStateTenantId, factStateForeignTenantId] },
    );
    return { nodes, edges };
  }

  function observedEntries(result: unknown): Array<Record<string, unknown>> {
    expect((result as { outcome: string }).outcome).toBe('observed');
    return (result as { entries: Array<Record<string, unknown>> }).entries;
  }

  beforeAll(async () => {
    ({ createEvidenceSourceFactState } = await import('../evidence-source-fact-state.js'));
    ({ createEvidenceEligibilityComposition } = await import(
      '../../../core/src/evidence-eligibility-composition.js'
    ));
    ({ parseEvidenceEligibilityAuthorityResultV1 } = await import(
      '../../../core/src/evidence-eligibility-authority.js'
    ));
    ({ FactStore: LiveFactStore } = await import('../fact.js'));
    await factStateDriver.getServerInfo();
    await initSchema(factStateDriver);
    for (const label of [
      'live-active', 'live-disputed', 'live-invalidated', 'live-superseding',
      'compose-active', 'compose-disputed', 'compose-invalidated', 'compose-superseding',
    ]) {
      await createLiveFact({
        id: factStateId(label),
        tenantId: factStateTenantId,
        entityId: factStateEntityId,
        status: 'active',
        validAt: PAST_VALID_AT,
        invalidAt: null,
      });
    }
    // The disclosure fixtures: same id shape, foreign tenant and foreign
    // entity, deliberately reachable by an unscoped read and by nothing else.
    await createLiveFact({
      id: factStateId('live-foreign-tenant'),
      tenantId: factStateForeignTenantId,
      entityId: factStateEntityId,
      status: 'active',
      validAt: PAST_VALID_AT,
      invalidAt: null,
    });
    await createLiveFact({
      id: factStateId('live-foreign-entity'),
      tenantId: factStateTenantId,
      entityId: factStateOtherEntityId,
      status: 'active',
      validAt: PAST_VALID_AT,
      invalidAt: null,
    });
  });

  afterAll(async () => {
    if (LIVE_ENABLED) {
      const session = factStateDriver.session();
      try {
        await session.run(
          `MATCH (n)
           WHERE n.tenant_id IN $tenantIds
              OR n.entity_id IN $entityIds
              OR n.id IN $nodeIds
           DETACH DELETE n`,
          {
            tenantIds: [factStateTenantId, factStateForeignTenantId],
            entityIds: [factStateEntityId, factStateOtherEntityId],
            nodeIds: factStateIds,
          },
        );
        const residue = await session.run(
          `MATCH (n)
           WHERE n.tenant_id IN $tenantIds
              OR n.entity_id IN $entityIds
              OR n.id IN $nodeIds
           RETURN count(n) AS count`,
          {
            tenantIds: [factStateTenantId, factStateForeignTenantId],
            entityIds: [factStateEntityId, factStateOtherEntityId],
            nodeIds: factStateIds,
          },
        );
        expect(Number(residue.records[0]?.get('count') ?? -1)).toBe(0);
      } finally {
        await session.close();
      }
    }
    await factStateDriver.close().catch(() => undefined);
  });

  it('observes a live active fact in valid time under the bound scope (T27)', async () => {
    const surface = createEvidenceSourceFactState(factStateDriver, factStateScope);
    const result = await surface.observeFactState({
      mode: 'current',
      evidenceIds: [factStateId('live-active')],
    });
    expect(observedEntries(result)).toEqual([{
      evidenceId: factStateId('live-active'),
      status: 'active',
      withinValidTime: true,
      superseded: false,
    }]);
  }, 120_000);

  it('reads the real invalidate write path, edge and driver Integer included (T28)', async () => {
    const store = new LiveFactStore(factStateDriver);
    await store.invalidate(
      factStateId('live-invalidated'),
      PAST_INVALID_AT,
      factStateId('live-superseding'),
    );
    const surface = createEvidenceSourceFactState(factStateDriver, factStateScope);
    const result = await surface.observeFactState({
      mode: 'current',
      evidenceIds: [factStateId('live-invalidated')],
    });
    expect(observedEntries(result)).toEqual([{
      evidenceId: factStateId('live-invalidated'),
      status: 'invalidated',
      withinValidTime: false,
      superseded: true,
    }]);
    expect(await factStateScalar(
      `MATCH (:Fact {id: $newId})-[r:SUPERSEDES_FACT]->(:Fact {id: $oldId})
       RETURN count(r) AS count`,
      'count',
      { newId: factStateId('live-superseding'), oldId: factStateId('live-invalidated') },
    )).toBe(1);
  }, 120_000);

  it('reads the real dispute write path: contested but still lifecycle-live (T29)', async () => {
    const store = new LiveFactStore(factStateDriver);
    await store.dispute(factStateId('live-disputed'));
    // The pairing the contract demands is derived from the write path, not
    // arranged: dispute() writes status and updated_at, and never a valid-time
    // bound, so the record stays in frame while its content is contested.
    expect(await factStateScalar(
      `MATCH (f:Fact {id: $id}) WHERE f.invalid_at IS NULL RETURN count(f) AS count`,
      'count',
      { id: factStateId('live-disputed') },
    )).toBe(1);
    const surface = createEvidenceSourceFactState(factStateDriver, factStateScope);
    const result = await surface.observeFactState({
      mode: 'current',
      evidenceIds: [factStateId('live-disputed')],
    });
    expect(observedEntries(result)).toEqual([{
      evidenceId: factStateId('live-disputed'),
      status: 'disputed',
      withinValidTime: true,
      superseded: false,
    }]);
  }, 120_000);

  it('discloses nothing across a tenant or an entity boundary (T30)', async () => {
    const surface = createEvidenceSourceFactState(factStateDriver, factStateScope);
    for (const id of [factStateId('live-foreign-tenant'), factStateId('live-foreign-entity')]) {
      // The node exists and an unscoped read would find it; this surface
      // cannot see it, and the refusal names nothing about it.
      expect(await factStateScalar(
        'MATCH (f:Fact {id: $id}) RETURN count(f) AS count',
        'count',
        { id },
      )).toBe(1);
      expect(await surface.observeFactState({ mode: 'current', evidenceIds: [id] })).toEqual({
        contractVersion: 'memberry.evidence-source-fact-state/1.0.0',
        outcome: 'unsupported',
        code: 'fact-state-candidate-missing',
      });
    }
    // A batch mixing a visible and an invisible candidate refuses whole.
    expect(await surface.observeFactState({
      mode: 'current',
      evidenceIds: [factStateId('live-active'), factStateId('live-foreign-tenant')],
    })).toEqual({
      contractVersion: 'memberry.evidence-source-fact-state/1.0.0',
      outcome: 'unsupported',
      code: 'fact-state-candidate-missing',
    });
  }, 120_000);

  it('writes nothing, mints no ledger event, and opens a READ session (T31)', async () => {
    const before = await factStateTenantCounts();
    const configs: unknown[] = [];
    const observingDriver = {
      session: (config?: unknown) => {
        configs.push(config);
        return factStateDriver.session(config as never);
      },
    } as unknown as Driver;
    const surface = createEvidenceSourceFactState(observingDriver, factStateScope);
    const result = await surface.observeFactState({
      mode: 'current',
      evidenceIds: [factStateId('live-active'), factStateId('live-disputed')],
    });
    expect(observedEntries(result)).toHaveLength(2);
    expect(configs).toEqual([{ defaultAccessMode: 'READ' }]);
    expect(await factStateTenantCounts()).toEqual(before);
    expect(await factStateScalar(
      `MATCH (n:EvidenceAuthorityEvent) WHERE n.tenant_id IN $tenantIds RETURN count(n) AS count`,
      'count',
      { tenantIds: [factStateTenantId, factStateForeignTenantId] },
    )).toBe(0);
  }, 120_000);

  it('composes three live facts into a contract-canonical supported result (T32)', async () => {
    const store = new LiveFactStore(factStateDriver);
    await store.dispute(factStateId('compose-disputed'));
    await store.invalidate(
      factStateId('compose-invalidated'),
      PAST_INVALID_AT,
      factStateId('compose-superseding'),
    );
    const composition = createEvidenceEligibilityComposition(
      createEvidenceSourceFactState(factStateDriver, factStateScope),
    );
    const request = {
      contractId: 'memberry.evidence-eligibility-authority',
      contractVersion: '1.0.0',
      tenantId: factStateTenantId,
      projectScope: factStateProjectScope,
      resolvedEntityId: factStateEntityId,
      temporalFrame: { mode: 'current' },
      recordTime: { mode: 'current' },
      candidates: [
        { ref: 'c001', sourceType: 'fact', evidenceId: factStateId('compose-active') },
        { ref: 'c002', sourceType: 'fact', evidenceId: factStateId('compose-disputed') },
        { ref: 'c003', sourceType: 'fact', evidenceId: factStateId('compose-invalidated') },
      ],
    };
    const result = await composition.composeAuthorityResult(request);
    expect((result as { outcome: string }).outcome).toBe('supported');
    const receipts = (result as { receipts: Array<Record<string, unknown>> }).receipts;
    expect(receipts).toHaveLength(3);
    expect(receipts.map((receipt) => receipt.ref)).toEqual(['c001', 'c002', 'c003']);
    expect(receipts.map((receipt) => ({
      lifecycle: receipt.lifecycle,
      temporal: receipt.temporal,
      supersession: receipt.supersession,
      contradiction: receipt.contradiction,
    }))).toEqual([
      { lifecycle: 'active', temporal: 'in-frame', supersession: 'clear', contradiction: 'clear' },
      { lifecycle: 'active', temporal: 'in-frame', supersession: 'clear', contradiction: 'withheld' },
      { lifecycle: 'inactive', temporal: 'out-of-frame', supersession: 'superseded', contradiction: 'clear' },
    ]);
    for (const receipt of receipts) {
      expect(receipt.provenance).toEqual({
        policy: 'fact-current-source-owned-v1',
        ref: 'memberry.evidence-source-fact-state/1.0.0',
      });
    }
    // The decisive assertion: the module's own output survives the sealed
    // parser unchanged, so every hand copy and every axis derivation above is
    // proven against the contract rather than against a fixture.
    expect(parseEvidenceEligibilityAuthorityResultV1(result, request)).toEqual(result);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// RET-005B-AUTH-001B6P: semantic lifecycle producer live gate. Every suite
// above is frozen; this block owns its own driver, tenant, fixtures and full
// cleanup, and proves the two things no mock can: that valid_at actually
// PERSISTS on a real server through a create/getById round-trip, and that the
// ON CREATE fencing holds against a replay whose recomputed value WOULD differ.
// (A before/after comparison on an unchanged source set proves nothing: site
// 3's value is replay-stable, so a wrongly-placed trailing SET would recompute
// the identical value and pass. Mutating a source episode's created_at between
// the two promotions is what makes the arm bite.)
// ---------------------------------------------------------------------------

describeLive('SemanticStore lifecycle stamping live Neo4j gate (RET-005B-AUTH-001B6P)', () => {
  const lifecycleDriver = createNeo4jDriver(uri, user, password);
  const lifecycleSuffix = randomUUID().toLowerCase();
  const lifecycleTenantId = `test-semantic-lifecycle-${lifecycleSuffix}`;
  const lifecycleProjectScope = `project:test-semantic-lifecycle-${lifecycleSuffix}`;
  const createdSemanticId = `semantic-lifecycle-created-${lifecycleSuffix}`;
  const promotedSemanticId = `semantic-lifecycle-promoted-${lifecycleSuffix}`;
  const lifecycleEpisodeIds = ['ep-lifecycle-early', 'ep-lifecycle-late']
    .map((value) => `${value}-${lifecycleSuffix}`);
  const lifecycleNodeIds = [createdSemanticId, promotedSemanticId, ...lifecycleEpisodeIds];
  let SemanticStoreCtor: typeof import('../semantic.js')['SemanticStore'];

  beforeAll(async () => {
    ({ SemanticStore: SemanticStoreCtor } = await import('../semantic.js'));
    await lifecycleDriver.getServerInfo();
  });

  afterAll(async () => {
    if (LIVE_ENABLED) {
      const session = lifecycleDriver.session();
      try {
        await session.run(
          `MATCH (n)
           WHERE n.tenant_id = $tenantId OR n.scope = $projectScope OR n.id IN $nodeIds
           DETACH DELETE n`,
          { tenantId: lifecycleTenantId, projectScope: lifecycleProjectScope, nodeIds: lifecycleNodeIds },
        );
        const residue = await session.run(
          `MATCH (n)
           WHERE n.tenant_id = $tenantId OR n.scope = $projectScope OR n.id IN $nodeIds
           RETURN count(n) AS count`,
          { tenantId: lifecycleTenantId, projectScope: lifecycleProjectScope, nodeIds: lifecycleNodeIds },
        );
        expect(Number(residue.records[0]?.get('count') ?? -1)).toBe(0);
      } finally {
        await session.close();
      }
    }
    await lifecycleDriver.close().catch(() => {});
  });

  it('L1: create persists valid_at equal to the caller created_at and leaves invalid_at absent', async () => {
    const createdAt = '2026-04-01T09:00:00.000Z';
    const store = new SemanticStoreCtor(lifecycleDriver);

    await store.create({
      id: createdSemanticId,
      content: 'live lifecycle create fixture',
      confidence: 0.8,
      signal_count: 1,
      created_at: createdAt,
      updated_at: createdAt,
      decay_class: 'stable',
      tags: [lifecycleProjectScope],
      tenant_id: lifecycleTenantId,
    });

    const fetched = await store.getById(createdSemanticId);
    expect(fetched?.valid_at).toBe(createdAt);
    expect(fetched?.invalid_at).toBeUndefined();
  }, 120_000);

  it('L2: a promote REPLAY does not re-stamp valid_at even when the recomputed value would differ', async () => {
    const early = '2026-04-02T09:00:00.000Z';
    const late = '2026-04-02T10:00:00.000Z';
    const later = '2026-04-02T23:00:00.000Z';
    const store = new SemanticStoreCtor(lifecycleDriver);

    const session = lifecycleDriver.session();
    try {
      await session.run(
        `CREATE (a:Episodic {
           id: $earlyId, tenant_id: $tenantId, scope: $projectScope,
           session_id: 'lifecycle-session', agent_id: 'lifecycle-agent',
           task: 'lifecycle-task', content: 'earlier source', created_at: $early
         })
         CREATE (b:Episodic {
           id: $lateId, tenant_id: $tenantId, scope: $projectScope,
           session_id: 'lifecycle-session', agent_id: 'lifecycle-agent',
           task: 'lifecycle-task', content: 'later source', created_at: $late
         })`,
        {
          earlyId: lifecycleEpisodeIds[0],
          lateId: lifecycleEpisodeIds[1],
          tenantId: lifecycleTenantId,
          projectScope: lifecycleProjectScope,
          early,
          late,
        },
      );
    } finally {
      await session.close();
    }

    const node = {
      id: promotedSemanticId,
      content: 'live lifecycle promote fixture',
      confidence: 0.8,
      signal_count: 2,
      created_at: '2026-04-02T12:00:00.000Z',
      updated_at: '2026-04-02T12:00:00.000Z',
      decay_class: 'stable' as const,
      tags: [lifecycleProjectScope],
      tenant_id: lifecycleTenantId,
    };

    await store.promoteFromEpisodic(lifecycleEpisodeIds, node, lifecycleTenantId);
    const afterFirst = await store.getById(promotedSemanticId);
    // The LATEST source instant, not the earliest and not the node's created_at.
    expect(afterFirst?.valid_at).toBe(late);

    // Move a source instant forward, so an ON-CREATE-only stamp and a wrongly
    // placed trailing SET now disagree.
    const mutate = lifecycleDriver.session();
    try {
      await mutate.run(
        'MATCH (ep:Episodic {id: $id}) SET ep.created_at = $later',
        { id: lifecycleEpisodeIds[1], later },
      );
    } finally {
      await mutate.close();
    }

    // Same provenance ids, so the exact-provenance replay still succeeds.
    await store.promoteFromEpisodic(lifecycleEpisodeIds, node, lifecycleTenantId);
    const afterReplay = await store.getById(promotedSemanticId);
    expect(afterReplay?.valid_at).toBe(late);
    expect(afterReplay?.valid_at).not.toBe(later);
    expect(afterReplay?.invalid_at).toBeUndefined();
  }, 120_000);
});
