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
