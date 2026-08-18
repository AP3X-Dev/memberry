import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Driver } from 'neo4j-driver';
import { describe, expect, it, vi } from 'vitest';

import {
  EVIDENCE_AUTHORITY_LEDGER_VERSION,
  EvidenceAuthorityLedgerError,
  createEvidenceAuthorityCaptureFacet,
  createEvidenceAuthorityLedgerPersistence,
  createEvidenceAuthorityReviewFacet,
  type EvidenceAuthorityCaseFacetV1,
  type EvidenceAuthorityCoverageFacetV1,
  type EvidenceAuthorityScopeV1,
} from '../evidence-authority-ledger.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SCOPE: EvidenceAuthorityScopeV1 = Object.freeze({
  tenantId: 'tenant-acme',
  projectScope: 'project:memberry',
  semanticId: 'semantic-001',
});
const OTHER_SCOPE: EvidenceAuthorityScopeV1 = Object.freeze({
  ...SCOPE,
  semanticId: 'semantic-002',
});
const OTHER_TENANT_SCOPE: EvidenceAuthorityScopeV1 = Object.freeze({
  ...SCOPE,
  tenantId: 'tenant-other',
});
const OTHER_PROJECT_SCOPE: EvidenceAuthorityScopeV1 = Object.freeze({
  ...SCOPE,
  projectScope: 'project:other',
});
const RECORDED_AT = '2026-08-18T12:00:00.000Z';
const SECRET_CANARY = ['sk', 'ledger', 'must-not-leak-1234567890'].join('_');

function record(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] };
}

interface StoredEvent {
  event: Record<string, unknown>;
  outbox: Record<string, unknown>;
  target: Record<string, unknown>;
}

function makeDriver(options: {
  semanticIds?: string[];
  corruptAppend?: boolean;
  temporalObjects?: boolean;
  poisonedLedger?: boolean;
  replayOrphanAfterWrite?: boolean;
  replayDuplicateAfterWrite?: boolean;
  foreignCoverageEventAfterWrite?: boolean;
  duplicateCoverageLinkAfterWrite?: boolean;
  highSequenceAfterWrite?: boolean;
  executeWriteError?: boolean;
  closeError?: boolean;
  hostileInteger?: boolean;
  balancedOutboxCorruptionAfterWrite?: boolean;
  nullHistoricalFieldAfterWrite?: 'event-operation-id' | 'outbox-id' | 'outbox-recorded-at';
  impossibleHistoryAfterWrite?: 'coverage' | 'case';
  wrongAppendSequence?: boolean;
  orphanTargetChainAfterWrite?: 'coverage' | 'case';
  crossHistoryAfterWrite?: 'case-before-open' | 'case-after-revoke';
} = {}) {
  const semanticIds = new Set(options.semanticIds ?? [SCOPE.semanticId, OTHER_SCOPE.semanticId]);
  const events = new Map<string, StoredEvent>();
  const coverage = new Map<string, { properties: Record<string, unknown>; state: string }>();
  const cases = new Map<string, { properties: Record<string, unknown>; state: string }>();
  let sequence = 0;
  const queries: string[] = [];

  const run = vi.fn(async (query: string, params: Record<string, unknown> = {}) => {
    queries.push(query);
    if (query.includes('evidence-authority:lock')) {
      if (!semanticIds.has(String(params.semanticId))) return { records: [] };
      return { records: [record({
        ledger: {
          id: params.ledgerId,
          tenant_id: options.poisonedLedger ? 'tenant-poison' : params.tenantId,
          project_scope: params.projectScope,
          semantic_id: params.semanticId,
          version: options.hostileInteger ? { toNumber: () => sequence } : sequence,
          locked: true,
        },
      })] };
    }
    if (query.includes('evidence-authority:ledger-event-audit')) {
      const stored = [...events.values()];
      return { records: stored.map((item, index) => {
        const event = { ...item.event };
        const outbox = { ...item.outbox };
        if (options.crossHistoryAfterWrite === 'case-before-open'
          && stored.some((candidate) => candidate.event.kind === 'case')) {
          if (event.kind === 'coverage') event.sequence = 2;
          if (event.kind === 'case') event.sequence = 1;
          outbox.sequence = event.sequence;
        }
        if (options.crossHistoryAfterWrite === 'case-after-revoke'
          && stored.some((candidate) => candidate.event.action === 'revoked')) {
          if (event.kind === 'case') event.sequence = 3;
          if (event.action === 'revoked') event.sequence = 2;
          outbox.sequence = event.sequence;
        }
        if (options.highSequenceAfterWrite && index === stored.length - 1) {
          event.sequence = sequence + 1;
          outbox.sequence = sequence + 1;
        }
        if (options.nullHistoricalFieldAfterWrite === 'event-operation-id' && index === 0) {
          event.operation_id = null;
        }
        if (options.nullHistoricalFieldAfterWrite === 'outbox-id' && index === 0) {
          outbox.id = null;
        }
        if (options.nullHistoricalFieldAfterWrite === 'outbox-recorded-at' && index === 0) {
          outbox.recorded_at = null;
        }
        if (options.impossibleHistoryAfterWrite === 'coverage'
          && event.kind === 'coverage' && index === stored.length - 1) {
          event.action = 'opened';
          event.state = 'open';
          outbox.action = 'opened';
          outbox.state = 'open';
        }
        if (options.impossibleHistoryAfterWrite === 'case'
          && event.kind === 'case' && event.action === 'resolution_started') {
          event.action = 'resolved';
          event.state = 'resolved';
          outbox.action = 'resolved';
          outbox.state = 'resolved';
        }
        const balanced = options.balancedOutboxCorruptionAfterWrite && stored.length > 1;
        const orphaned = options.orphanTargetChainAfterWrite === event.kind;
        return record({
          event,
          eventLabels: ['EvidenceAuthorityEvent'],
          ownerCount: 1,
          emitCount: balanced ? (index === 0 ? 2 : index === 1 ? 0 : 1) : 1,
          outboxCount: balanced ? (index === 0 ? 2 : index === 1 ? 0 : 1) : 1,
          incomingCount: 1,
          outbox,
          outboxLabels: ['EvidenceAuthorityOutbox'],
          targetCount: 1,
          targetType: event.kind === 'coverage' ? 'FOR_COVERAGE' : 'FOR_CASE',
          targetLabels: [event.kind === 'coverage'
            ? 'EvidenceAuthorityCoverage'
            : 'EvidenceAuthorityCase'],
          target: item.target,
          targetOwnerCount: orphaned ? 0 : 1,
          expectedTargetOwnerCount: orphaned ? 0 : 1,
          targetScopeCount: orphaned ? 0 : 1,
          exactTargetScopeCount: orphaned ? 0 : 1,
          caseSemanticScopeCount: event.kind === 'case' && !orphaned ? 1 : 0,
          exactCaseSemanticScopeCount: event.kind === 'case' && !orphaned ? 1 : 0,
        });
      }) };
    }
    if (query.includes('evidence-authority:replay')) {
      const stored = events.get(String(params.eventId));
      const count = stored === undefined ? 0 : 1;
      return { records: [record({
        ...(stored ?? { event: null, outbox: null, target: null }),
        anyEventCount: count,
        anyOutboxCount: count,
        expectedOwnerCount: stored !== undefined && options.replayOrphanAfterWrite ? 0 : count,
        expectedEmitCount: count,
        expectedTargetCount: count,
        allOwnerCount: stored !== undefined && options.replayDuplicateAfterWrite ? 2 : count,
        allEmitCount: count,
        allTargetCount: count,
        allIncomingCount: count,
      })] };
    }
    if (query.includes('evidence-authority:coverage-topology')) {
      const current = coverage.get(String(params.coverageId));
      const eventCount = [...events.values()].filter((item) => item.event.kind === 'coverage').length;
      return { records: [record({
        target: current?.properties ?? null,
        expectedTargetOwnerCount: current === undefined ? 0 : 1,
        allTargetOwnerCount: current === undefined ? 0 : 1,
        scopeLinkCount: current === undefined ? 0 : 1,
        exactSemanticCount: current === undefined ? 0 : 1,
        eventCount: current === undefined ? 0 : eventCount,
        targetEventRelationshipCount: current === undefined
          ? 0
          : eventCount + (options.duplicateCoverageLinkAfterWrite ? 1 : 0),
        eventOwnerRelationshipCount: current === undefined ? 0 : eventCount,
        ownedEventCount: current === undefined
          ? 0
          : eventCount - (options.foreignCoverageEventAfterWrite ? 1 : 0),
        invalidEventCount: 0,
      })] };
    }
    if (query.includes('evidence-authority:case-topology')) {
      const current = cases.get(String(params.caseNodeId));
      const eventCount = [...events.values()].filter((item) => item.event.case_id === params.caseId).length;
      return { records: [record({
        target: current?.properties ?? null,
        expectedTargetOwnerCount: current === undefined ? 0 : 1,
        allTargetOwnerCount: current === undefined ? 0 : 1,
        coverageLinkCount: current === undefined ? 0 : 1,
        scopeLinkCount: current === undefined ? 0 : 1,
        exactSemanticCount: current === undefined ? 0 : 1,
        eventCount: current === undefined ? 0 : eventCount,
        targetEventRelationshipCount: current === undefined ? 0 : eventCount,
        eventOwnerRelationshipCount: current === undefined ? 0 : eventCount,
        ownedEventCount: current === undefined ? 0 : eventCount,
        invalidEventCount: 0,
      })] };
    }
    if (query.includes('evidence-authority:coverage-latest')) {
      const latest = [...events.values()].filter((item) => item.event.kind === 'coverage').at(-1);
      return { records: latest === undefined ? [] : [record({ event: latest.event })] };
    }
    if (query.includes('evidence-authority:case-latest')) {
      const latest = [...events.values()].filter((item) => item.event.case_id === params.caseId).at(-1);
      return { records: latest === undefined ? [] : [record({ event: latest.event })] };
    }
    if (query.includes('evidence-authority:append-')) {
      sequence += 1;
      const kind = String(params.kind);
      const state = String(params.state);
      const action = String(params.action);
      const temporal = () => options.temporalObjects
        ? Object.freeze({ toString: () => RECORDED_AT })
        : RECORDED_AT;
      const event = {
        id: params.eventId,
        tenant_id: params.tenantId,
        project_scope: params.projectScope,
        semantic_id: params.semanticId,
        case_id: params.caseId,
        operation_id: params.operationId,
        kind,
        action,
        state,
        sequence: options.wrongAppendSequence ? sequence + 1 : sequence,
        recorded_at: temporal(),
      };
      const outbox = {
        id: params.outboxId,
        event_id: params.eventId,
        tenant_id: params.tenantId,
        project_scope: params.projectScope,
        semantic_id: params.semanticId,
        case_id: params.caseId,
        kind,
        action,
        state,
        sequence: options.wrongAppendSequence ? sequence + 1 : sequence,
        recorded_at: temporal(),
      };
      const target = kind === 'coverage'
        ? {
            id: params.coverageId,
            tenant_id: params.tenantId,
            project_scope: params.projectScope,
            semantic_id: params.semanticId,
            created_at: temporal(),
          }
        : {
            id: params.caseNodeId,
            tenant_id: params.tenantId,
            project_scope: params.projectScope,
            semantic_id: params.semanticId,
            coverage_id: params.coverageId,
            case_id: params.caseId,
            created_at: temporal(),
          };
      if (options.corruptAppend) return { records: [record({ event, outbox: null, target })] };
      const stored = { event, outbox, target };
      events.set(String(params.eventId), stored);
      if (kind === 'coverage') coverage.set(String(params.coverageId), { properties: target, state });
      else cases.set(String(params.caseNodeId), { properties: target, state });
      return { records: [record(stored)] };
    }
    throw new Error(`unexpected query: ${query}`);
  });
  const executeWrite = vi.fn(async <T>(work: (tx: { run: typeof run }) => Promise<T>) => {
    if (options.executeWriteError) throw new Error(SECRET_CANARY);
    return work({ run });
  });
  const close = vi.fn(async () => {
    if (options.closeError) throw new Error(SECRET_CANARY);
  });
  const driver = { session: vi.fn(() => ({ executeWrite, close })) } as unknown as Driver;
  return { driver, run, executeWrite, close, queries, events, coverage, cases };
}

async function openCoverage(driver: Driver, scope = SCOPE, operationId = 'coverage-open-001') {
  const store = createEvidenceAuthorityLedgerPersistence(driver);
  const capture = createEvidenceAuthorityCaptureFacet(store, scope);
  return store.openCoverage(capture, scope, { operationId });
}

function authorities(driver: Driver, scope = SCOPE) {
  const store = createEvidenceAuthorityLedgerPersistence(driver);
  return {
    store,
    capture: createEvidenceAuthorityCaptureFacet(store, scope),
    review: createEvidenceAuthorityReviewFacet(store, scope),
  };
}

function expectSafeError(error: unknown, code: string, canary = SECRET_CANARY): void {
  expect(error).toBeInstanceOf(EvidenceAuthorityLedgerError);
  expect(error).toMatchObject({ code });
  expect(String(error)).toBe(`EvidenceAuthorityLedgerError: evidence_authority_ledger:${code}`);
  expect(String(error)).not.toContain(canary);
}

describe('EvidenceAuthorityLedgerPersistence V1', () => {
  it('starts RED against an absent implementation and freezes the exact public boundary', () => {
    expect(EVIDENCE_AUTHORITY_LEDGER_VERSION).toBe('memberry.evidence-authority-ledger/1.0.0');
    const exports = readFileSync(resolve(REPO_ROOT, 'packages/neo4j/src/index.ts'), 'utf8');
    expect(exports).toContain("from './evidence-authority-ledger.js'");
    expect(exports).not.toContain('createEvidenceAuthorityLedgerPersistence');
    expect(exports).not.toContain('createEvidenceAuthorityCaptureFacet');
    expect(exports).not.toContain('createEvidenceAuthorityReviewFacet');
  });

  it('opens coverage only for an exactly tenant/project-bound Semantic using database time', async () => {
    const fake = makeDriver();
    const result = await openCoverage(fake.driver);

    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.getPrototypeOf(result.facet)).toBeNull();
    expect(Object.isFrozen(result.facet)).toBe(true);
    expect(result.receipt).toEqual({
      contractVersion: EVIDENCE_AUTHORITY_LEDGER_VERSION,
      kind: 'coverage',
      action: 'opened',
      state: 'open',
      sequence: 1,
      recordedAt: RECORDED_AT,
    });
    expect(Object.isFrozen(result.receipt)).toBe(true);
    expect(fake.run.mock.calls[0]?.[0]).toContain('s.tenant_id = $tenantId');
    expect(fake.run.mock.calls[0]?.[0]).toContain('s.scope = $projectScope');
    expect(fake.queries.join('\n')).toContain('datetime()');
    expect(fake.queries.join('\n')).not.toContain('timestamp()');
  });

  it('stores database time as a canonical string and rejects duck-typed temporal objects', async () => {
    const fake = makeDriver({ temporalObjects: true });
    await expect(openCoverage(fake.driver)).rejects.toMatchObject({ code: 'write_incomplete' });
    const source = readFileSync(
      resolve(REPO_ROOT, 'packages/neo4j/src/evidence-authority-ledger.ts'),
      'utf8',
    );
    expect(source).toContain('recorded_at: toString(datetime())');
  });

  it('requires a sealed package-internal capture authority before any graph access', async () => {
    const fake = makeDriver();
    const store = createEvidenceAuthorityLedgerPersistence(fake.driver);
    await expect(store.openCoverage(Object.freeze({}), SCOPE, { operationId: 'open' }))
      .rejects.toMatchObject({ code: 'invalid_facet' });
    expect(fake.executeWrite).not.toHaveBeenCalled();
    const capture = createEvidenceAuthorityCaptureFacet(store, SCOPE);
    const review = createEvidenceAuthorityReviewFacet(store, SCOPE);
    for (const facet of [capture, review]) {
      expect(Object.getPrototypeOf(facet)).toBeNull();
      expect(Object.isFrozen(facet)).toBe(true);
    }
  });

  it('does not enroll legacy Semantic rows or infer clear from missing ledger state', async () => {
    const fake = makeDriver({ semanticIds: [] });
    let error: unknown;
    try { await openCoverage(fake.driver); } catch (caught) { error = caught; }
    expectSafeError(error, 'semantic_not_found');
    expect(fake.events.size).toBe(0);
    expect(fake.coverage.size).toBe(0);

    const migrations = readFileSync(resolve(REPO_ROOT, 'packages/neo4j/src/migrations.ts'), 'utf8');
    const migration = migrations.slice(migrations.indexOf("id: '0008-evidence-authority-ledger-v1'"));
    expect(migration).not.toMatch(/MATCH\s*\(s:Semantic\)/);
    expect(migration).not.toMatch(/SET\s+s\./);
    expect(migration).not.toMatch(/backfill/i);
  });

  it('supports pending -> rejected and pending -> resolving -> resolved across multiple cases', async () => {
    const fake = makeDriver();
    const { store, capture, review } = authorities(fake.driver);
    const { facet: coverageFacet } = await store.openCoverage(capture, SCOPE, { operationId: 'coverage-open' });
    const first = await store.openCase(capture, coverageFacet, SCOPE, { caseId: 'case-1', operationId: 'case-1-open' });
    const second = await store.openCase(capture, coverageFacet, SCOPE, { caseId: 'case-2', operationId: 'case-2-open' });
    expect(first.receipt.state).toBe('pending');
    expect(second.receipt.state).toBe('pending');

    await expect(store.rejectCase(review, first.facet, SCOPE, { operationId: 'case-1-reject' }))
      .resolves.toMatchObject({ state: 'rejected', action: 'rejected' });
    await expect(store.beginResolution(review, second.facet, SCOPE, { operationId: 'case-2-resolving' }))
      .resolves.toMatchObject({ state: 'resolving', action: 'resolution_started' });
    await expect(store.resolveCase(review, second.facet, SCOPE, { operationId: 'case-2-resolved' }))
      .resolves.toMatchObject({ state: 'resolved', action: 'resolved' });
    expect(fake.cases.size).toBe(2);
  });

  it('rejects illegal lifecycle jumps and operation-id conflicts without adding an event', async () => {
    const fake = makeDriver();
    const { store, capture, review } = authorities(fake.driver);
    const { facet: coverageFacet } = await store.openCoverage(capture, SCOPE, { operationId: 'coverage-open' });
    const { facet: caseFacet } = await store.openCase(
      capture,
      coverageFacet,
      SCOPE,
      { caseId: 'case-1', operationId: 'case-open' },
    );
    const before = fake.events.size;
    await expect(store.resolveCase(review, caseFacet, SCOPE, { operationId: 'direct-resolve' }))
      .rejects.toMatchObject({ code: 'invalid_transition' });
    expect(fake.events.size).toBe(before);

    await expect(store.rejectCase(review, caseFacet, SCOPE, { operationId: 'case-open' }))
      .rejects.toMatchObject({ code: 'operation_conflict' });
    expect(fake.events.size).toBe(before);
  });

  it('replays exact operations deterministically and returns the original database timestamp', async () => {
    const fake = makeDriver();
    const { store, capture } = authorities(fake.driver);
    const first = await store.openCoverage(capture, SCOPE, { operationId: 'coverage-open' });
    const replay = await store.openCoverage(capture, SCOPE, { operationId: 'coverage-open' });
    expect(replay.receipt).toEqual(first.receipt);
    expect(fake.events.size).toBe(1);
    expect(fake.queries.filter((query) => query.includes('append-open-coverage'))).toHaveLength(1);
    await expect(store.openCoverage(capture, SCOPE, { operationId: 'coverage-reopen' }))
      .rejects.toMatchObject({ code: 'invalid_transition' });
    expect(fake.events.size).toBe(1);
  });

  it('seals facets to their store and exact scope, and revoked coverage cannot create cases', async () => {
    const fakeA = makeDriver();
    const fakeB = makeDriver();
    const authorityA = authorities(fakeA.driver);
    const authorityB = authorities(fakeB.driver);
    const { store: storeA, capture: captureA, review: reviewA } = authorityA;
    const { store: storeB, capture: captureB } = authorityB;
    const { facet } = await storeA.openCoverage(captureA, SCOPE, { operationId: 'coverage-open' });

    await expect(storeB.openCoverage(captureA, SCOPE, { operationId: 'foreign-capture' }))
      .rejects.toMatchObject({ code: 'invalid_facet' });
    await expect(storeB.openCase(captureB, facet, SCOPE, { caseId: 'case-1', operationId: 'case-open' }))
      .rejects.toMatchObject({ code: 'invalid_facet' });
    await expect(storeA.openCase(captureA, facet, OTHER_SCOPE, { caseId: 'case-1', operationId: 'case-open' }))
      .rejects.toMatchObject({ code: 'facet_scope_mismatch' });
    await expect(storeA.openCase(captureA, facet, { ...SCOPE, tenantId: 'tenant-other' }, { caseId: 'case-1', operationId: 'case-open' }))
      .rejects.toMatchObject({ code: 'facet_scope_mismatch' });
    await expect(storeA.openCase(captureA, facet, { ...SCOPE, projectScope: 'project:other' }, { caseId: 'case-1', operationId: 'case-open' }))
      .rejects.toMatchObject({ code: 'facet_scope_mismatch' });

    await storeA.revokeCoverage(reviewA, facet, SCOPE, { operationId: 'coverage-revoke' });
    await expect(storeA.openCase(captureA, facet, SCOPE, { caseId: 'case-1', operationId: 'case-open' }))
      .rejects.toMatchObject({ code: 'facet_revoked' });
  });

  it('seals capture and review authority to the exact tenant/project/Semantic scope', async () => {
    const fake = makeDriver();
    const { store, capture, review } = authorities(fake.driver);
    for (const scope of [OTHER_SCOPE, OTHER_TENANT_SCOPE, OTHER_PROJECT_SCOPE]) {
      await expect(store.openCoverage(capture, scope, { operationId: 'foreign-open' }))
        .rejects.toMatchObject({ code: 'facet_scope_mismatch' });
    }
    expect(fake.executeWrite).not.toHaveBeenCalled();

    const { facet } = await store.openCoverage(capture, SCOPE, { operationId: 'coverage-open' });
    for (const scope of [OTHER_SCOPE, OTHER_TENANT_SCOPE, OTHER_PROJECT_SCOPE]) {
      await expect(store.revokeCoverage(review, facet, scope, { operationId: 'foreign-review' }))
        .rejects.toMatchObject({ code: 'facet_scope_mismatch' });
    }
    expect(fake.events.size).toBe(1);
  });

  it('rejects case facets across stores/scopes and terminal transitions stay terminal', async () => {
    const fakeA = makeDriver();
    const fakeB = makeDriver();
    const authorityA = authorities(fakeA.driver);
    const authorityB = authorities(fakeB.driver);
    const { store: storeA, capture: captureA, review: reviewA } = authorityA;
    const { store: storeB, review: reviewB } = authorityB;
    const { facet: coverageFacet } = await storeA.openCoverage(captureA, SCOPE, { operationId: 'coverage-open' });
    const { facet: caseFacet } = await storeA.openCase(
      captureA,
      coverageFacet,
      SCOPE,
      { caseId: 'case-1', operationId: 'case-open' },
    );
    await expect(storeB.rejectCase(reviewB, caseFacet, SCOPE, { operationId: 'reject' }))
      .rejects.toMatchObject({ code: 'invalid_facet' });
    await expect(storeA.rejectCase(reviewA, caseFacet, OTHER_SCOPE, { operationId: 'reject' }))
      .rejects.toMatchObject({ code: 'facet_scope_mismatch' });
    await storeA.rejectCase(reviewA, caseFacet, SCOPE, { operationId: 'reject' });
    await expect(storeA.beginResolution(reviewA, caseFacet, SCOPE, { operationId: 'late-resolve' }))
      .rejects.toMatchObject({ code: 'invalid_transition' });
  });

  it('rejects a forged receiver even when own properties are copied from a genuine store', async () => {
    const fake = makeDriver();
    const { store, capture } = authorities(fake.driver);
    const forged = Object.create(Object.getPrototypeOf(store));
    Object.assign(forged, store);
    await expect(forged.openCoverage(capture, SCOPE, { operationId: 'forged-open' }))
      .rejects.toMatchObject({ code: 'invalid_facet' });
  });

  it('rejects a deterministic ledger id whose persisted scope identity is poisoned', async () => {
    const fake = makeDriver({ poisonedLedger: true });
    let error: unknown;
    try { await openCoverage(fake.driver); } catch (caught) { error = caught; }
    expectSafeError(error, 'existing_state_mismatch');
    expect(fake.events.size).toBe(0);
  });

  it.each([
    ['orphan replay', { replayOrphanAfterWrite: true }, 'replay'],
    ['duplicate replay owner', { replayDuplicateAfterWrite: true }, 'replay'],
    ['foreign target event', { foreignCoverageEventAfterWrite: true }, 'state'],
    ['duplicate target link', { duplicateCoverageLinkAfterWrite: true }, 'state'],
    ['high sequence', { highSequenceAfterWrite: true }, 'replay'],
  ] as const)('fails closed on %s topology corruption', async (_name, options, path) => {
    const fake = makeDriver(options);
    const { store, capture } = authorities(fake.driver);
    const opened = await store.openCoverage(capture, SCOPE, { operationId: 'coverage-open' });
    const operation = path === 'replay'
      ? store.openCoverage(capture, SCOPE, { operationId: 'coverage-open' })
      : store.openCase(
          capture,
          opened.facet,
          SCOPE,
          { caseId: 'case-1', operationId: 'case-open' },
        );
    await expect(operation).rejects.toMatchObject({ code: 'existing_state_mismatch' });
  });

  it('never transmits undefined nextSequence to Neo4j read queries', async () => {
    const fake = makeDriver();
    await openCoverage(fake.driver);
    for (const [query, params] of fake.run.mock.calls) {
      if (!String(query).includes('evidence-authority:append-')) {
        expect(params).not.toHaveProperty('nextSequence');
        expect(Object.values(params as Record<string, unknown>)).not.toContain(undefined);
      }
    }
  });

  it('rejects balanced per-event outbox corruption that preserves ledger-wide totals', async () => {
    const fake = makeDriver({ balancedOutboxCorruptionAfterWrite: true });
    const { store, capture } = authorities(fake.driver);
    const { facet } = await store.openCoverage(capture, SCOPE, { operationId: 'coverage-open' });
    await store.openCase(capture, facet, SCOPE, { caseId: 'case-1', operationId: 'case-open' });
    await expect(store.openCase(
      capture,
      facet,
      SCOPE,
      { caseId: 'case-2', operationId: 'case-2-open' },
    )).rejects.toMatchObject({ code: 'existing_state_mismatch' });
  });

  it.each([
    'event-operation-id',
    'outbox-id',
    'outbox-recorded-at',
  ] as const)('rejects a null required historical %s field', async (field) => {
    const fake = makeDriver({ nullHistoricalFieldAfterWrite: field });
    const { store, capture } = authorities(fake.driver);
    const { facet } = await store.openCoverage(capture, SCOPE, { operationId: 'coverage-open' });
    await expect(store.openCase(
      capture,
      facet,
      SCOPE,
      { caseId: 'case-1', operationId: 'case-open' },
    )).rejects.toMatchObject({ code: 'existing_state_mismatch' });
  });

  it.each(['coverage', 'case'] as const)('rejects an impossible ordered %s history', async (kind) => {
    const fake = makeDriver({ impossibleHistoryAfterWrite: kind });
    const { store, capture, review } = authorities(fake.driver);
    const { facet: coverageFacet } = await store.openCoverage(
      capture,
      SCOPE,
      { operationId: 'coverage-open' },
    );
    if (kind === 'coverage') {
      await store.revokeCoverage(review, coverageFacet, SCOPE, { operationId: 'coverage-revoke' });
      await expect(store.openCase(
        capture,
        coverageFacet,
        SCOPE,
        { caseId: 'case-1', operationId: 'case-open' },
      )).rejects.toMatchObject({ code: 'existing_state_mismatch' });
      return;
    }
    const { facet: caseFacet } = await store.openCase(
      capture,
      coverageFacet,
      SCOPE,
      { caseId: 'case-1', operationId: 'case-open' },
    );
    await store.beginResolution(review, caseFacet, SCOPE, { operationId: 'case-resolving' });
    await expect(store.resolveCase(review, caseFacet, SCOPE, { operationId: 'case-resolved' }))
      .rejects.toMatchObject({ code: 'existing_state_mismatch' });
  });

  it.each(['coverage', 'case'] as const)(
    'rejects exact replay when the %s target ownership chain is orphaned',
    async (kind) => {
      const fake = makeDriver({ orphanTargetChainAfterWrite: kind });
      const { store, capture } = authorities(fake.driver);
      const coverage = await store.openCoverage(capture, SCOPE, { operationId: 'coverage-open' });
      if (kind === 'coverage') {
        await expect(store.openCoverage(capture, SCOPE, { operationId: 'coverage-open' }))
          .rejects.toMatchObject({ code: 'existing_state_mismatch' });
        return;
      }
      const openedCase = await store.openCase(
        capture,
        coverage.facet,
        SCOPE,
        { caseId: 'case-1', operationId: 'case-open' },
      );
      await expect(store.openCase(
        capture,
        coverage.facet,
        SCOPE,
        { caseId: 'case-1', operationId: 'case-open' },
      )).rejects.toMatchObject({ code: 'existing_state_mismatch' });
      expect(openedCase.receipt.state).toBe('pending');
    },
  );

  it.each(['case-before-open', 'case-after-revoke'] as const)(
    'rejects globally impossible cross-target chronology: %s',
    async (mode) => {
      const fake = makeDriver({ crossHistoryAfterWrite: mode });
      const { store, capture, review } = authorities(fake.driver);
      const coverage = await store.openCoverage(capture, SCOPE, { operationId: 'coverage-open' });
      const openedCase = await store.openCase(
        capture,
        coverage.facet,
        SCOPE,
        { caseId: 'case-1', operationId: 'case-open' },
      );
      if (mode === 'case-after-revoke') {
        await store.revokeCoverage(review, coverage.facet, SCOPE, { operationId: 'coverage-revoke' });
      }
      await expect(store.openCase(
        capture,
        coverage.facet,
        SCOPE,
        { caseId: 'case-1', operationId: 'case-open' },
      )).rejects.toMatchObject({ code: 'existing_state_mismatch' });
      expect(openedCase.receipt.state).toBe('pending');
    },
  );

  it('hardens unknown inputs and normalizes session, transaction, result, and close failures', async () => {
    const session = vi.fn(() => { throw new Error(SECRET_CANARY); });
    const unavailableAuthority = authorities({ session } as unknown as Driver);
    const { store: unavailable, capture } = unavailableAuthority;
    const invalidScopes: unknown[] = [
      null,
      [],
      { ...SCOPE, extra: true },
      { ...SCOPE, tenantId: `t${'x'.repeat(501)}` },
      { ...SCOPE, projectScope: 'memberry' },
      Object.assign(Object.create({ inherited: true }), SCOPE),
      { ...SCOPE, [Symbol('hostile')]: true },
      new Proxy({ ...SCOPE }, {}),
      Object.defineProperty({ ...SCOPE }, 'semanticId', { get: () => SECRET_CANARY }),
    ];
    for (const scope of invalidScopes) {
      let error: unknown;
      try { await unavailable.openCoverage(capture, scope, { operationId: 'open' }); } catch (caught) { error = caught; }
      expectSafeError(error, 'invalid_scope');
    }
    expect(session).not.toHaveBeenCalled();

    let storageError: unknown;
    try { await unavailable.openCoverage(capture, SCOPE, { operationId: 'open' }); } catch (caught) { storageError = caught; }
    expectSafeError(storageError, 'storage_unavailable');

    for (const command of [
      null,
      [],
      { operationId: '' },
      { operationId: `bad ${SECRET_CANARY}` },
      { operationId: `o${'x'.repeat(501)}` },
      { operationId: 'open', extra: true },
      { operationId: 'open', [Symbol('hostile')]: true },
      Object.assign(Object.create({ inherited: true }), { operationId: 'open' }),
      new Proxy({ operationId: 'open' }, {}),
    ]) {
      let error: unknown;
      try { await unavailable.openCoverage(capture, SCOPE, command); } catch (caught) { error = caught; }
      expectSafeError(error, 'invalid_command');
    }
  });

  it('fails closed on hostile driver output and proves event/outbox are created in one query', async () => {
    const fake = makeDriver({ corruptAppend: true });
    let error: unknown;
    try { await openCoverage(fake.driver); } catch (caught) { error = caught; }
    expectSafeError(error, 'write_incomplete');
    const append = fake.queries.find((query) => query.includes('append-open-coverage')) ?? '';
    expect(append).toContain('CREATE (event:EvidenceAuthorityEvent');
    expect(append).toContain('CREATE (outbox:EvidenceAuthorityOutbox');
    expect(append).toContain('recorded_at: event.recorded_at');
    expect(fake.executeWrite).toHaveBeenCalledTimes(1);
  });

  it('rejects a self-consistent append result with the wrong next sequence', async () => {
    const fake = makeDriver({ wrongAppendSequence: true });
    await expect(openCoverage(fake.driver)).rejects.toMatchObject({ code: 'write_incomplete' });
  });

  it.each([
    ['transaction rejection', { executeWriteError: true }, 'storage_unavailable'],
    ['close rejection', { closeError: true }, 'storage_unavailable'],
    ['duck-typed integer', { hostileInteger: true }, 'write_incomplete'],
  ] as const)('normalizes %s without leaking driver values', async (_name, options, code) => {
    const fake = makeDriver(options);
    let error: unknown;
    try { await openCoverage(fake.driver); } catch (caught) { error = caught; }
    expectSafeError(error, code);
  });

  it('exports no direct clear mint and stores no content-bearing payload', () => {
    const source = readFileSync(
      resolve(REPO_ROOT, 'packages/neo4j/src/evidence-authority-ledger.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/markClear|mintClear|setClear|content\s*:/);
    expect(source).not.toMatch(/new Date\(|Date\.now\(|timestamp\(\)/);
    expect(source).not.toMatch(/Redis|ProposalStore|Consolidation|Retrieval|MCP/);
    expect(source).toContain('datetime()');
  });
});

// Compile-time API guards: callers can hold capabilities but cannot construct
// the hidden runtime brand that the persistence factory verifies.
void (undefined as unknown as EvidenceAuthorityCoverageFacetV1);
void (undefined as unknown as EvidenceAuthorityCaseFacetV1);
