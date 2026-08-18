import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Driver } from 'neo4j-driver';
import { describe, expect, it, vi } from 'vitest';

import { createEvidenceAuthorityAdjudication } from '../evidence-authority-adjudication.js';
import { createEvidenceAuthorityCapture } from '../evidence-authority-capture.js';
import {
  EvidenceAuthorityLedgerError,
  createEvidenceAuthorityCaptureFacet,
  createEvidenceAuthorityLedgerPersistence,
  type EvidenceAuthorityLedgerErrorCode,
} from '../evidence-authority-ledger.js';
import {
  EVIDENCE_AUTHORITY_REVOCATION_VERSION,
  createEvidenceAuthorityRevocation,
  type EvidenceAuthorityRevocationPrincipalV1,
  type EvidenceAuthorityRevocationRequestV1,
} from '../evidence-authority-revocation.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const RECORDED_AT = '2026-08-18T12:00:00.000Z';
const SECRET_CANARY = ['sk', 'revocation', 'must-not-leak-1234567890'].join('_');
const PRINCIPAL_CANARY = 'sk-principal-must-not-leak-1234567890';
const PRINCIPAL: EvidenceAuthorityRevocationPrincipalV1 = Object.freeze({
  tenantId: 'tenant-acme',
  projectScope: 'project:memberry',
  principalId: 'principal-alpha',
});
const REQUEST: EvidenceAuthorityRevocationRequestV1 = Object.freeze({
  semanticId: 'semantic-001',
});
const SCOPE = Object.freeze({
  tenantId: PRINCIPAL.tenantId,
  projectScope: PRINCIPAL.projectScope,
  semanticId: REQUEST.semanticId,
});
const UNREVOKED_RESULT = Object.freeze({
  contractVersion: EVIDENCE_AUTHORITY_REVOCATION_VERSION,
  outcome: 'unrevoked',
  code: 'unrevoked',
});

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
  sessionThrows?: boolean;
} = {}) {
  const semanticIds = new Set(options.semanticIds ?? [REQUEST.semanticId]);
  const events = new Map<string, StoredEvent>();
  const coverage = new Map<string, { properties: Record<string, unknown>; state: string }>();
  const cases = new Map<string, { properties: Record<string, unknown>; state: string }>();
  let sequence = 0;
  const queries: string[] = [];
  const controls = { failAfterCommit: false };

  const run = vi.fn(async (query: string, params: Record<string, unknown> = {}) => {
    queries.push(query);
    if (query.includes('evidence-authority:lock')) {
      if (!semanticIds.has(String(params.semanticId))) return { records: [] };
      return { records: [record({
        ledger: {
          id: params.ledgerId,
          tenant_id: params.tenantId,
          project_scope: params.projectScope,
          semantic_id: params.semanticId,
          version: sequence,
          locked: true,
        },
      })] };
    }
    if (query.includes('evidence-authority:ledger-event-audit')) {
      return { records: [...events.values()].map((item) => record({
        event: { ...item.event },
        eventLabels: ['EvidenceAuthorityEvent'],
        ownerCount: 1,
        emitCount: 1,
        outboxCount: 1,
        incomingCount: 1,
        outbox: { ...item.outbox },
        outboxLabels: ['EvidenceAuthorityOutbox'],
        targetCount: 1,
        targetType: item.event.kind === 'coverage' ? 'FOR_COVERAGE' : 'FOR_CASE',
        targetLabels: [item.event.kind === 'coverage'
          ? 'EvidenceAuthorityCoverage'
          : 'EvidenceAuthorityCase'],
        target: item.target,
        targetOwnerCount: 1,
        expectedTargetOwnerCount: 1,
        targetScopeCount: 1,
        exactTargetScopeCount: 1,
        caseSemanticScopeCount: item.event.kind === 'case' ? 1 : 0,
        exactCaseSemanticScopeCount: item.event.kind === 'case' ? 1 : 0,
      })) };
    }
    if (query.includes('evidence-authority:replay')) {
      const stored = events.get(String(params.eventId));
      const count = stored === undefined ? 0 : 1;
      return { records: [record({
        ...(stored ?? { event: null, outbox: null, target: null }),
        anyEventCount: count,
        anyOutboxCount: count,
        expectedOwnerCount: count,
        expectedEmitCount: count,
        expectedTargetCount: count,
        allOwnerCount: count,
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
        targetEventRelationshipCount: current === undefined ? 0 : eventCount,
        eventOwnerRelationshipCount: current === undefined ? 0 : eventCount,
        ownedEventCount: current === undefined ? 0 : eventCount,
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
    if (query.includes('evidence-authority:capture-raw-signal-count')) {
      return { records: [record({ rawSignalCount: 0 })] };
    }
    if (query.includes('evidence-authority:append-capture-coverage-case')) {
      const coverageSequence = sequence + 1;
      const caseSequence = sequence + 2;
      sequence = caseSequence;
      const shared = {
        tenant_id: params.tenantId,
        project_scope: params.projectScope,
        semantic_id: params.semanticId,
        recorded_at: RECORDED_AT,
      };
      const coverageEvent = {
        ...shared, id: params.coverageEventId, case_id: '',
        operation_id: params.coverageOperationId, kind: 'coverage',
        action: 'opened', state: 'open', sequence: coverageSequence,
      };
      const coverageOutbox = {
        ...shared, id: params.coverageOutboxId, event_id: params.coverageEventId,
        case_id: '', kind: 'coverage', action: 'opened', state: 'open',
        sequence: coverageSequence,
      };
      const coverageTarget = {
        id: params.coverageId, tenant_id: params.tenantId,
        project_scope: params.projectScope, semantic_id: params.semanticId,
        created_at: RECORDED_AT,
      };
      const caseEvent = {
        ...shared, id: params.caseEventId, case_id: params.caseId,
        operation_id: params.caseOperationId, kind: 'case',
        action: 'case_opened', state: 'pending', sequence: caseSequence,
      };
      const caseOutbox = {
        ...shared, id: params.caseOutboxId, event_id: params.caseEventId,
        case_id: params.caseId, kind: 'case', action: 'case_opened',
        state: 'pending', sequence: caseSequence,
      };
      const caseTarget = {
        id: params.caseNodeId, tenant_id: params.tenantId,
        project_scope: params.projectScope, semantic_id: params.semanticId,
        coverage_id: params.coverageId, case_id: params.caseId,
        created_at: RECORDED_AT,
      };
      events.set(String(params.coverageEventId), {
        event: coverageEvent, outbox: coverageOutbox, target: coverageTarget,
      });
      events.set(String(params.caseEventId), {
        event: caseEvent, outbox: caseOutbox, target: caseTarget,
      });
      coverage.set(String(params.coverageId), { properties: coverageTarget, state: 'open' });
      cases.set(String(params.caseNodeId), { properties: caseTarget, state: 'pending' });
      return { records: [record({
        coverageEvent, coverageOutbox, coverageTarget, caseEvent, caseOutbox, caseTarget,
      })] };
    }
    if (query.includes('evidence-authority:append-')) {
      sequence += 1;
      const kind = String(params.kind);
      const action = String(params.action);
      const state = String(params.state);
      const event = {
        id: params.eventId, tenant_id: params.tenantId, project_scope: params.projectScope,
        semantic_id: params.semanticId, case_id: params.caseId,
        operation_id: params.operationId, kind, action, state,
        sequence, recorded_at: RECORDED_AT,
      };
      const outbox = {
        id: params.outboxId, event_id: params.eventId, tenant_id: params.tenantId,
        project_scope: params.projectScope, semantic_id: params.semanticId,
        case_id: params.caseId, kind, action, state,
        sequence, recorded_at: RECORDED_AT,
      };
      const target = kind === 'coverage'
        ? {
            id: params.coverageId, tenant_id: params.tenantId,
            project_scope: params.projectScope, semantic_id: params.semanticId,
            created_at: RECORDED_AT,
          }
        : {
            id: params.caseNodeId, tenant_id: params.tenantId,
            project_scope: params.projectScope, semantic_id: params.semanticId,
            coverage_id: params.coverageId, case_id: params.caseId,
            created_at: RECORDED_AT,
          };
      const stored = { event, outbox, target };
      events.set(String(params.eventId), stored);
      if (kind === 'coverage') coverage.set(String(params.coverageId), { properties: target, state });
      else cases.set(String(params.caseNodeId), { properties: target, state });
      return { records: [record(stored)] };
    }
    throw new Error(`unexpected query: ${query}`);
  });
  const executeWrite = vi.fn(async <T>(work: (tx: { run: typeof run }) => Promise<T>) => {
    const value = await work({ run });
    if (controls.failAfterCommit) {
      controls.failAfterCommit = false;
      throw new Error(SECRET_CANARY);
    }
    return value;
  });
  const close = vi.fn(async () => undefined);
  const session = vi.fn(() => {
    if (options.sessionThrows) throw new Error(SECRET_CANARY);
    return { executeWrite, close };
  });
  const driver = { session } as unknown as Driver;
  return { driver, run, executeWrite, close, session, queries, events, coverage, cases, controls };
}

function ledgerFailureDriver(error: unknown) {
  const executeWrite = vi.fn(async () => {
    throw error;
  });
  const close = vi.fn(async () => undefined);
  const session = vi.fn(() => ({ executeWrite, close }));
  return { driver: { session } as unknown as Driver, executeWrite, session };
}

async function seedCase(
  driver: Driver,
  caseId = 'case-revocation-1',
  scope: { tenantId: string; projectScope: string; semanticId: string } = SCOPE,
): Promise<void> {
  const store = createEvidenceAuthorityLedgerPersistence(driver);
  const captureFacet = createEvidenceAuthorityCaptureFacet(store, scope);
  await store.captureCase(captureFacet, scope, {
    caseId,
    coverageOperationId: `seed-op-coverage-${caseId}`,
    caseOperationId: `seed-op-case-${caseId}`,
  });
}

function importSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(/from '([^']+)'/g),
    ...source.matchAll(/import '([^']+)'/g),
    ...source.matchAll(/import\('([^']+)'\)/g),
    ...source.matchAll(/require\('([^']+)'\)/g),
  ].map((match) => match[1]!);
}

function errorCodeLiteral(source: string, name: string): string[] {
  const match = source.match(new RegExp(
    `const ${name} = new Set<EvidenceAuthorityLedgerErrorCode>\\(\\[([\\s\\S]*?)\\]\\)`,
  ));
  expect(match, `${name} literal not found in source`).not.toBeNull();
  return [...match![1]!.matchAll(/'([a-z_]+)'/g)].map((entry) => entry[1]!).sort();
}

describe('EvidenceAuthorityRevocation V1 (RET-005B-AUTH-001B3B1)', () => {
  it('freezes the version constant exactly', () => {
    expect(EVIDENCE_AUTHORITY_REVOCATION_VERSION)
      .toBe('memberry.evidence-authority-revocation/1.0.0');
  });

  it('stays off the package root and exposes no reader, clearance, re-open, or logging surface', () => {
    const rootExports = readFileSync(resolve(REPO_ROOT, 'packages/neo4j/src/index.ts'), 'utf8');
    expect(rootExports).not.toContain('evidence-authority-revocation');
    const source = readFileSync(
      resolve(REPO_ROOT, 'packages/neo4j/src/evidence-authority-revocation.ts'),
      'utf8',
    );
    expect(source).not.toMatch(
      /isCovered|ensureCoverage|getCaseState|coverageState|readCase|adjudicationState|listCases|pendingCases|revocationState|isRevoked/,
    );
    expect(source).not.toMatch(/['"`]clear['"`]|['"`]withheld['"`]|['"`]approved['"`]|['"`]superseded['"`]/);
    expect(source).not.toMatch(/MATCH\s/);
    expect(source).not.toMatch(/coalesce/i);
    expect(source).not.toMatch(/console\./);
    expect(source).not.toMatch(/authenticated|non-repudiation|verified reviewer/i);
    expect(source).not.toMatch(/CREATE \(/);
    expect(source).not.toMatch(/MERGE \(/);
    expect(source).not.toMatch(/reopenCoverage|unrevokeCoverage|unrevoke\(|reEnroll|restoreCoverage/i);
    expect(source).toContain('MAX_INPUT_LENGTH = 500');
  });

  it('reaches no Redis, cache, queue, or stream module through its import graph', () => {
    const moduleSource = readFileSync(
      resolve(REPO_ROOT, 'packages/neo4j/src/evidence-authority-revocation.ts'),
      'utf8',
    );
    const moduleImports = importSpecifiers(moduleSource);
    expect([...moduleImports].sort()).toEqual([
      './evidence-authority-ledger.js',
      'neo4j-driver',
      'node:crypto',
      'node:util/types',
    ]);
    const ledgerSource = readFileSync(
      resolve(REPO_ROOT, 'packages/neo4j/src/evidence-authority-ledger.ts'),
      'utf8',
    );
    const ledgerImports = importSpecifiers(ledgerSource);
    for (const specifier of [...moduleImports, ...ledgerImports]) {
      expect(specifier).not.toMatch(/redis|cache|queue|stream|bull|kafka/i);
    }
  });

  it('pins the hand-copied ledger error-code set to the ledger source exactly', () => {
    const moduleSource = readFileSync(
      resolve(REPO_ROOT, 'packages/neo4j/src/evidence-authority-revocation.ts'),
      'utf8',
    );
    const ledgerSource = readFileSync(
      resolve(REPO_ROOT, 'packages/neo4j/src/evidence-authority-ledger.ts'),
      'utf8',
    );
    const moduleCodes = errorCodeLiteral(moduleSource, 'LEDGER_ERROR_CODES');
    const ledgerCodes = errorCodeLiteral(ledgerSource, 'ERROR_CODES');
    expect(moduleCodes).toEqual(ledgerCodes);
    expect(moduleCodes).toHaveLength(13);
  });

  it('keeps genuine revocation, idempotent replay, terminal refusal, and thrown transient distinguishable', async () => {
    // Arrangement 1: genuine revocation returns revoked with a non-null receipt.
    const fake = makeDriver();
    await seedCase(fake.driver);
    const revocation = createEvidenceAuthorityRevocation(fake.driver, { ...PRINCIPAL });
    const first = await revocation.revoke({ ...REQUEST });
    expect(first.outcome).toBe('revoked');
    expect(first.outcome === 'revoked' && first.receipt !== null
      && first.receipt !== undefined).toBe(true);
    expect(first.outcome === 'revoked' && first.receipt).toEqual({
      contractVersion: 'memberry.evidence-authority-ledger/1.0.0',
      kind: 'coverage',
      action: 'revoked',
      state: 'revoked',
      sequence: 3,
      recordedAt: RECORDED_AT,
    });
    expect(Object.getPrototypeOf(first)).toBeNull();
    expect(Object.isFrozen(first)).toBe(true);

    // Arrangement 2: same-principal replay returns the stored receipt with no second append.
    const appendsAfterFirst = fake.queries
      .filter((query) => query.includes('append-transition-coverage')).length;
    expect(appendsAfterFirst).toBe(1);
    const replay = await revocation.revoke({ ...REQUEST });
    expect(replay).toEqual(first);
    expect(fake.queries.filter((query) => query.includes('append-transition-coverage')))
      .toHaveLength(appendsAfterFirst);

    // Arrangement 3: invalid_transition (already revoked, other construction) is a
    // terminal unrevoked refusal with zero writes.
    const eventsBefore = fake.events.size;
    const other = createEvidenceAuthorityRevocation(fake.driver, {
      ...PRINCIPAL,
      principalId: 'principal-gamma',
    });
    const refusal = await other.revoke({ ...REQUEST });
    expect(refusal).toEqual(UNREVOKED_RESULT);
    expect(Object.isFrozen(refusal)).toBe(true);
    expect(fake.events.size).toBe(eventsBefore);
    expect(fake.queries.filter((query) => query.includes('append-transition-coverage')))
      .toHaveLength(appendsAfterFirst);

    // Arrangement 4: storage unavailability throws instead of returning either outcome.
    const unavailable = makeDriver({ sessionThrows: true });
    const failing = createEvidenceAuthorityRevocation(unavailable.driver, { ...PRINCIPAL });
    let storage: unknown;
    try { await failing.revoke({ ...REQUEST }); } catch (caught) { storage = caught; }
    expect(storage).toBeInstanceOf(EvidenceAuthorityLedgerError);
    expect(storage).toMatchObject({ code: 'storage_unavailable' });
  });

  it('classifies every terminal ledger code as the single frozen unrevoked constant and throws only transients', async () => {
    const terminalCodes: EvidenceAuthorityLedgerErrorCode[] = [
      'invalid_scope',
      'invalid_command',
      'invalid_facet',
      'facet_scope_mismatch',
      'facet_revoked',
      'semantic_not_found',
      'coverage_missing',
      'case_missing',
      'invalid_transition',
      'operation_conflict',
      'existing_state_mismatch',
    ];
    for (const code of terminalCodes) {
      const fake = ledgerFailureDriver(new EvidenceAuthorityLedgerError(code));
      const revocation = createEvidenceAuthorityRevocation(fake.driver, { ...PRINCIPAL });
      const result = await revocation.revoke({ ...REQUEST });
      expect(result).toEqual(UNREVOKED_RESULT);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.getPrototypeOf(result)).toBeNull();
      expect(fake.executeWrite).toHaveBeenCalledTimes(1);
      const again = await revocation.revoke({ ...REQUEST });
      expect(again).toBe(result);
      expect(fake.executeWrite).toHaveBeenCalledTimes(2);
    }
    for (const code of ['storage_unavailable', 'write_incomplete'] as const) {
      const fake = ledgerFailureDriver(new EvidenceAuthorityLedgerError(code));
      const revocation = createEvidenceAuthorityRevocation(fake.driver, { ...PRINCIPAL });
      let error: unknown;
      try { await revocation.revoke({ ...REQUEST }); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(EvidenceAuthorityLedgerError);
      expect(error).toMatchObject({ code });
      expect(fake.executeWrite).toHaveBeenCalledTimes(1);
    }
    const unknownFailure = ledgerFailureDriver(new Error(SECRET_CANARY));
    const revocation = createEvidenceAuthorityRevocation(unknownFailure.driver, { ...PRINCIPAL });
    let unknown: unknown;
    try { await revocation.revoke({ ...REQUEST }); } catch (caught) { unknown = caught; }
    expect(unknown).toBeInstanceOf(EvidenceAuthorityLedgerError);
    expect(unknown).toMatchObject({ code: 'storage_unavailable' });
    expect(String(unknown)).not.toContain(SECRET_CANARY);
  });

  it('refuses cross-principal replay-as-forgery with a different operation id and never success', async () => {
    const fake = makeDriver();
    await seedCase(fake.driver);
    const alpha = createEvidenceAuthorityRevocation(fake.driver, { ...PRINCIPAL });
    const beta = createEvidenceAuthorityRevocation(fake.driver, {
      ...PRINCIPAL,
      principalId: 'principal-beta',
    });
    const revoked = await alpha.revoke({ ...REQUEST });
    expect(revoked.outcome).toBe('revoked');
    const alphaAppend = fake.run.mock.calls
      .find(([query]) => String(query).includes('append-transition-coverage'))?.[1] as Record<string, unknown>;
    const callsBefore = fake.run.mock.calls.length;
    const forged = await beta.revoke({ ...REQUEST });
    expect(forged).toEqual(UNREVOKED_RESULT);
    const betaCalls = fake.run.mock.calls.slice(callsBefore);
    expect(betaCalls.length).toBeGreaterThan(0);
    expect(betaCalls.some(([query]) => String(query).includes('append-'))).toBe(false);
    const betaOperationIds = new Set(betaCalls
      .map(([, params]) => (params as Record<string, unknown> | undefined)?.operationId)
      .filter((value): value is string => typeof value === 'string'));
    expect(betaOperationIds.size).toBe(1);
    expect([...betaOperationIds][0]).not.toBe(alphaAppend.operationId);
  });

  it('makes cross-tenant and cross-project revocation unrepresentable, not merely refused', async () => {
    const fake = makeDriver({ sessionThrows: true });
    const revocation = createEvidenceAuthorityRevocation(fake.driver, { ...PRINCIPAL });
    for (const request of [
      { ...REQUEST, tenantId: PRINCIPAL.tenantId },
      { ...REQUEST, projectScope: PRINCIPAL.projectScope },
      { ...REQUEST, principalId: PRINCIPAL.principalId },
      { ...REQUEST, reviewerId: 'reviewer-1' },
      { ...REQUEST, actorId: 'actor-1' },
      { ...REQUEST, coverageId: 'coverage-1' },
      { ...REQUEST, caseId: 'case-1' },
    ]) {
      const result = await revocation.revoke(request);
      expect(result).toEqual(UNREVOKED_RESULT);
    }
    expect(fake.session).not.toHaveBeenCalled();

    const fakeA = makeDriver();
    await seedCase(fakeA.driver);
    const instanceA = createEvidenceAuthorityRevocation(fakeA.driver, { ...PRINCIPAL });
    await instanceA.revoke({ ...REQUEST });
    const fakeB = makeDriver();
    const scopeB = Object.freeze({
      tenantId: 'tenant-other',
      projectScope: 'project:other',
      semanticId: REQUEST.semanticId,
    });
    await seedCase(fakeB.driver, 'case-revocation-1', scopeB);
    const instanceB = createEvidenceAuthorityRevocation(fakeB.driver, {
      tenantId: scopeB.tenantId,
      projectScope: scopeB.projectScope,
      principalId: PRINCIPAL.principalId,
    });
    await instanceB.revoke({ ...REQUEST });
    const appendA = fakeA.run.mock.calls
      .find(([query]) => String(query).includes('append-transition-coverage'))?.[1] as Record<string, unknown>;
    const appendB = fakeB.run.mock.calls
      .find(([query]) => String(query).includes('append-transition-coverage'))?.[1] as Record<string, unknown>;
    expect(appendA).toBeDefined();
    expect(appendB).toBeDefined();
    expect(appendB.operationId).not.toBe(appendA.operationId);
    expect(appendB.ledgerId).not.toBe(appendA.ledgerId);
    expect(appendA.tenantId).toBe(PRINCIPAL.tenantId);
    expect(appendB.tenantId).toBe(scopeB.tenantId);
  });

  it('derives operation ids in a fresh domain that never collides with capture- or adjudication-derived identifiers', async () => {
    const probe = makeDriver();
    await createEvidenceAuthorityCapture(probe.driver).capture({
      tenantId: PRINCIPAL.tenantId,
      projectScope: PRINCIPAL.projectScope,
      semanticId: REQUEST.semanticId,
      signalKind: 'contradiction',
      sourceEpisodeId: 'episode-001',
    });
    const captureParams = probe.run.mock.calls
      .find(([query]) => String(query).includes('append-capture-coverage-case'))?.[1] as Record<string, unknown>;
    expect(captureParams).toBeDefined();

    const adjudicationFake = makeDriver();
    const capturedCaseId = String(captureParams.caseId);
    await seedCase(adjudicationFake.driver, capturedCaseId);
    const adjudication = createEvidenceAuthorityAdjudication(adjudicationFake.driver, { ...PRINCIPAL });
    const adjudicated = await adjudication.adjudicate({
      semanticId: REQUEST.semanticId,
      caseId: capturedCaseId,
      decision: 'reject',
    });
    expect(adjudicated.outcome).toBe('adjudicated');
    const adjParams = adjudicationFake.run.mock.calls
      .find(([query]) => String(query).includes('append-transition-case'))?.[1] as Record<string, unknown>;
    expect(adjParams).toBeDefined();

    const fake = makeDriver();
    await seedCase(fake.driver);
    const revocation = createEvidenceAuthorityRevocation(fake.driver, { ...PRINCIPAL });
    const result = await revocation.revoke({ ...REQUEST });
    expect(result.outcome).toBe('revoked');
    const revParams = fake.run.mock.calls
      .find(([query]) => String(query).includes('append-transition-coverage'))?.[1] as Record<string, unknown>;
    expect(String(revParams.operationId)).toMatch(/^rev-op-[0-9a-f]{64}$/);
    for (const derived of [
      captureParams.caseId,
      captureParams.coverageOperationId,
      captureParams.caseOperationId,
      adjParams.operationId,
    ]) {
      expect(revParams.operationId).not.toBe(derived);
      expect(String(derived).startsWith('rev-op-')).toBe(false);
    }
    expect(String(revParams.operationId).startsWith('adj-op-')).toBe(false);
    expect(String(revParams.operationId).startsWith('capture-')).toBe(false);
  });

  it('returns the fixed content-free unrevoked code with zero I/O for hostile requests and hardens the principal parser', async () => {
    const fake = makeDriver({ sessionThrows: true });
    const revocation = createEvidenceAuthorityRevocation(fake.driver, { ...PRINCIPAL });
    const hostileRequests: unknown[] = [
      null,
      undefined,
      'request',
      42,
      true,
      [],
      {},
      { ...REQUEST, extra: true },
      Object.assign(Object.create({ inherited: true }), REQUEST),
      { ...REQUEST, [Symbol('hostile')]: true },
      Object.defineProperty({ ...REQUEST }, 'semanticId', { get: () => SECRET_CANARY }),
      new Proxy({ ...REQUEST }, { getOwnPropertyDescriptor: () => { throw new Error(SECRET_CANARY); } }),
      { ...REQUEST, tenantId: PRINCIPAL.tenantId },
      { ...REQUEST, projectScope: PRINCIPAL.projectScope },
      { ...REQUEST, principalId: PRINCIPAL.principalId },
      { ...REQUEST, reviewerId: 'reviewer-1' },
      { ...REQUEST, actorId: 'actor-1' },
      { ...REQUEST, coverageId: 'coverage-1' },
      { ...REQUEST, caseId: 'case-1' },
      { semanticId: null },
      { semanticId: undefined },
      { semanticId: 42 },
      { semanticId: {} },
      { semanticId: '' },
      { semanticId: `s${'x'.repeat(501)}` },
      { semanticId: 'sem antic' },
      { semanticId: '-nanoid-shaped' },
      { semanticId: '_nanoid-shaped' },
      { semanticId: 'semantic\nnewline' },
      { semanticId: `bad ${SECRET_CANARY}` },
      { semanticId: `s${'x'.repeat(1_000_000)}` },
    ];
    expect(hostileRequests.length).toBeGreaterThanOrEqual(30);
    for (const request of hostileRequests) {
      const result = await revocation.revoke(request);
      expect(result).toEqual(UNREVOKED_RESULT);
      expect(Object.isFrozen(result)).toBe(true);
      expect(JSON.stringify(result)).not.toContain(SECRET_CANARY);
    }
    expect(fake.session).not.toHaveBeenCalled();

    const benign = makeDriver();
    const benignRevocation = createEvidenceAuthorityRevocation(benign.driver, { ...PRINCIPAL });
    const benignProxyResult = await benignRevocation.revoke(new Proxy({ ...REQUEST }, {}));
    expect(benignProxyResult).toEqual(UNREVOKED_RESULT);
    expect(benign.run).not.toHaveBeenCalled();
    expect(benign.session).not.toHaveBeenCalled();

    const hostilePrincipals: unknown[] = [
      null,
      undefined,
      'principal',
      42,
      [],
      {},
      { ...PRINCIPAL, extra: true },
      { tenantId: PRINCIPAL.tenantId, projectScope: PRINCIPAL.projectScope },
      Object.assign(Object.create({ inherited: true }), PRINCIPAL),
      { ...PRINCIPAL, [Symbol('hostile')]: true },
      new Proxy({ ...PRINCIPAL }, {}),
      new Proxy({ ...PRINCIPAL }, { getOwnPropertyDescriptor: () => { throw new Error(SECRET_CANARY); } }),
      Object.defineProperty({ ...PRINCIPAL }, 'tenantId', { get: () => SECRET_CANARY }),
      { ...PRINCIPAL, tenantId: 'bad tenant' },
      { ...PRINCIPAL, tenantId: `t${'x'.repeat(501)}` },
      { ...PRINCIPAL, projectScope: 'memberry' },
      { ...PRINCIPAL, projectScope: 'Project:memberry' },
      { ...PRINCIPAL, principalId: '' },
      { ...PRINCIPAL, principalId: `bad ${SECRET_CANARY}` },
      { ...PRINCIPAL, principalId: `p${'x'.repeat(501)}` },
      { ...PRINCIPAL, principalId: 42 },
    ];
    for (const principal of hostilePrincipals) {
      let error: unknown;
      try { createEvidenceAuthorityRevocation(fake.driver, principal); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(EvidenceAuthorityLedgerError);
      expect(error).toMatchObject({ code: 'invalid_scope' });
      expect(String(error)).toBe('EvidenceAuthorityLedgerError: evidence_authority_ledger:invalid_scope');
      expect(String(error)).not.toContain(SECRET_CANARY);
    }
    expect(fake.session).not.toHaveBeenCalled();
  });

  it('never leaks the principal identifier or request canaries through any result, parameter, or error', async () => {
    const fake = makeDriver();
    await seedCase(fake.driver);
    const revocation = createEvidenceAuthorityRevocation(fake.driver, {
      ...PRINCIPAL,
      principalId: PRINCIPAL_CANARY,
    });
    const result = await revocation.revoke({ ...REQUEST });
    expect(result.outcome).toBe('revoked');
    expect(JSON.stringify(result)).not.toContain(PRINCIPAL_CANARY);
    for (const [query, params] of fake.run.mock.calls) {
      expect(String(query)).not.toContain(PRINCIPAL_CANARY);
      expect(JSON.stringify(params ?? {})).not.toContain(PRINCIPAL_CANARY);
    }

    const hostile = makeDriver({ sessionThrows: true });
    const guarded = createEvidenceAuthorityRevocation(hostile.driver, { ...PRINCIPAL });
    for (const request of [
      { semanticId: `bad ${SECRET_CANARY}` },
      { semanticId: `_${SECRET_CANARY}` },
      { ...REQUEST, extra: SECRET_CANARY },
    ]) {
      const refused = await guarded.revoke(request);
      expect(refused).toEqual(UNREVOKED_RESULT);
      expect(JSON.stringify(refused)).not.toContain(SECRET_CANARY);
    }
    expect(hostile.session).not.toHaveBeenCalled();

    const unavailable = makeDriver({ sessionThrows: true });
    const failing = createEvidenceAuthorityRevocation(unavailable.driver, {
      ...PRINCIPAL,
      principalId: PRINCIPAL_CANARY,
    });
    let storage: unknown;
    try { await failing.revoke({ ...REQUEST }); } catch (caught) { storage = caught; }
    expect(storage).toBeInstanceOf(EvidenceAuthorityLedgerError);
    expect(String(storage)).toBe('EvidenceAuthorityLedgerError: evidence_authority_ledger:storage_unavailable');
    expect(String(storage)).not.toContain(PRINCIPAL_CANARY);
  });

  it('hardens construction: hostile principals throw and the frozen surface exposes nothing else', async () => {
    const fake = makeDriver();
    const revocation = createEvidenceAuthorityRevocation(fake.driver, { ...PRINCIPAL });
    expect(Object.getPrototypeOf(revocation)).toBeNull();
    expect(Object.isFrozen(revocation)).toBe(true);
    expect(Reflect.ownKeys(revocation)).toEqual(['contractVersion', 'revoke']);
    expect(revocation.contractVersion).toBe(EVIDENCE_AUTHORITY_REVOCATION_VERSION);
    expect(JSON.stringify(revocation)).not.toContain(PRINCIPAL.principalId);
    expect(JSON.stringify(revocation)).not.toContain(PRINCIPAL.tenantId);

    let hostile: unknown;
    let escaped: unknown;
    try {
      escaped = createEvidenceAuthorityRevocation(fake.driver, { ...PRINCIPAL, principalId: '' });
    } catch (caught) { hostile = caught; }
    expect(escaped).toBeUndefined();
    expect(hostile).toBeInstanceOf(EvidenceAuthorityLedgerError);
    expect(hostile).toMatchObject({ code: 'invalid_scope' });
    expect(fake.session).not.toHaveBeenCalled();
  });

  it('trips the B3B1 deferral wires: the five-code terminal branch, no revocation in adjudication, no re-open verb, and no read surface', () => {
    const captureSource = readFileSync(
      resolve(REPO_ROOT, 'packages/neo4j/src/evidence-authority-capture.ts'),
      'utf8',
    );
    for (const fragment of [
      "code === 'invalid_transition'",
      "code === 'operation_conflict'",
      "code === 'facet_revoked'",
      "code === 'semantic_not_found'",
      "code === 'existing_state_mismatch'",
    ]) {
      expect(captureSource).toContain(fragment);
    }
    expect(captureSource.match(/code === '/g)).toHaveLength(5);
    expect(captureSource).toContain('return UNCAPTURED;');
    expect(captureSource).toContain('throw new EvidenceAuthorityLedgerError(code);');

    const adjudicationSource = readFileSync(
      resolve(REPO_ROOT, 'packages/neo4j/src/evidence-authority-adjudication.ts'),
      'utf8',
    );
    expect(adjudicationSource).not.toMatch(/revokeCoverage/);
    expect(adjudicationSource).not.toMatch(/createEvidenceAuthorityCoverage/);

    const revocationSource = readFileSync(
      resolve(REPO_ROOT, 'packages/neo4j/src/evidence-authority-revocation.ts'),
      'utf8',
    );
    expect(revocationSource)
      .not.toMatch(/reopenCoverage|unrevokeCoverage|unrevoke\(|reEnroll|restoreCoverage/i);
    for (const source of [captureSource, adjudicationSource, revocationSource]) {
      expect(source).not.toMatch(/listCases|pullOutbox|outboxCursor|afterSequence/);
    }
  });
});
