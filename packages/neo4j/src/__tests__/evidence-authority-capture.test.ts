import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Driver } from 'neo4j-driver';
import { describe, expect, it, vi } from 'vitest';

import {
  EVIDENCE_AUTHORITY_CAPTURE_VERSION,
  createEvidenceAuthorityCapture,
  type EvidenceAuthorityCaptureRequestV1,
} from '../evidence-authority-capture.js';
import {
  EvidenceAuthorityLedgerError,
  createEvidenceAuthorityCaptureFacet,
  createEvidenceAuthorityLedgerPersistence,
  createEvidenceAuthorityReviewFacet,
} from '../evidence-authority-ledger.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const RECORDED_AT = '2026-08-18T12:00:00.000Z';
const SECRET_CANARY = ['sk', 'capture', 'must-not-leak-1234567890'].join('_');
const REQUEST: EvidenceAuthorityCaptureRequestV1 = Object.freeze({
  tenantId: 'tenant-acme',
  projectScope: 'project:memberry',
  semanticId: 'semantic-001',
  signalKind: 'contradiction',
  sourceEpisodeId: '_V1StGXR8-Z5jdHi6B-myT',
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
  rawSignalCount?: number;
  sessionThrows?: boolean;
} = {}) {
  const semanticIds = new Set(options.semanticIds ?? [REQUEST.semanticId]);
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
      return { records: [record({ rawSignalCount: options.rawSignalCount ?? 0 })] };
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
  const executeWrite = vi.fn(async <T>(work: (tx: { run: typeof run }) => Promise<T>) => work({ run }));
  const close = vi.fn(async () => undefined);
  const session = vi.fn(() => {
    if (options.sessionThrows) throw new Error(SECRET_CANARY);
    return { executeWrite, close };
  });
  const driver = { session } as unknown as Driver;
  return { driver, run, executeWrite, close, session, queries, events, coverage, cases };
}

function importSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(/from '([^']+)'/g),
    ...source.matchAll(/import '([^']+)'/g),
    ...source.matchAll(/import\('([^']+)'\)/g),
    ...source.matchAll(/require\('([^']+)'\)/g),
  ].map((match) => match[1]!);
}

describe('EvidenceAuthorityCapture V1', () => {
  it('freezes the version, stays off the package root, and exposes no reader surface', () => {
    expect(EVIDENCE_AUTHORITY_CAPTURE_VERSION).toBe('memberry.evidence-authority-capture/1.0.0');
    const rootExports = readFileSync(resolve(REPO_ROOT, 'packages/neo4j/src/index.ts'), 'utf8');
    expect(rootExports).not.toContain('evidence-authority-capture');
    const source = readFileSync(
      resolve(REPO_ROOT, 'packages/neo4j/src/evidence-authority-capture.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/isCovered|ensureCoverage|getCaseState|coverageState|readCase/);
    expect(source).not.toMatch(/MATCH\s/);
    expect(source).not.toMatch(/coalesce/i);
    expect(source).not.toMatch(/console\./);
    expect(source).toContain('MAX_INPUT_LENGTH = 500');
  });

  it('reaches no Redis, cache, queue, or stream module through its import graph', () => {
    const captureSource = readFileSync(
      resolve(REPO_ROOT, 'packages/neo4j/src/evidence-authority-capture.ts'),
      'utf8',
    );
    const captureImports = importSpecifiers(captureSource);
    expect([...captureImports].sort()).toEqual([
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
    expect([...ledgerImports].sort()).toEqual(['neo4j-driver', 'node:crypto', 'node:util']);
    for (const specifier of [...captureImports, ...ledgerImports]) {
      expect(specifier).not.toMatch(/redis|cache|queue|stream|bull|kafka/i);
    }
  });

  it('captures a first signal as coverage + case in a single write and echoes the case receipt', async () => {
    const fake = makeDriver();
    const capture = createEvidenceAuthorityCapture(fake.driver);
    expect(Object.getPrototypeOf(capture)).toBeNull();
    expect(Object.isFrozen(capture)).toBe(true);
    const result = await capture.capture({ ...REQUEST });

    expect(result).toEqual({
      contractVersion: EVIDENCE_AUTHORITY_CAPTURE_VERSION,
      outcome: 'captured',
      receipt: {
        contractVersion: 'memberry.evidence-authority-ledger/1.0.0',
        kind: 'case',
        action: 'case_opened',
        state: 'pending',
        sequence: 2,
        recordedAt: RECORDED_AT,
      },
    });
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.isFrozen(result)).toBe(true);
    expect(fake.executeWrite).toHaveBeenCalledTimes(1);
    expect(fake.events.size).toBe(2);
    expect(fake.coverage.size).toBe(1);
    expect(fake.cases.size).toBe(1);

    const appendCall = fake.run.mock.calls.find(([query]) => String(query).includes('append-capture-coverage-case'));
    const params = appendCall?.[1] as Record<string, unknown>;
    expect(String(params.caseId)).toMatch(/^capture-case-[0-9a-f]{64}$/);
    expect(String(params.coverageOperationId)).toMatch(/^capture-op-coverage-[0-9a-f]{64}$/);
    expect(String(params.caseOperationId)).toMatch(/^capture-op-case-[0-9a-f]{64}$/);
    expect(params.coverageOperationId).not.toBe(params.caseOperationId);
    for (const [, callParams] of fake.run.mock.calls) {
      expect(JSON.stringify(callParams ?? {})).not.toContain(REQUEST.sourceEpisodeId);
    }
  });

  it('derives identifiers deterministically with distinct domain salts per tuple member', async () => {
    const appendParams = async (request: Record<string, unknown>) => {
      const fake = makeDriver();
      await createEvidenceAuthorityCapture(fake.driver).capture(request);
      const call = fake.run.mock.calls.find(([query]) => String(query).includes('append-capture-coverage-case'));
      return call?.[1] as Record<string, unknown>;
    };
    const first = await appendParams({ ...REQUEST });
    const repeat = await appendParams({ ...REQUEST });
    expect(repeat.caseId).toBe(first.caseId);
    expect(repeat.coverageOperationId).toBe(first.coverageOperationId);
    expect(repeat.caseOperationId).toBe(first.caseOperationId);

    const correction = await appendParams({ ...REQUEST, signalKind: 'correction' });
    expect(correction.caseId).not.toBe(first.caseId);
    const otherEpisode = await appendParams({ ...REQUEST, sourceEpisodeId: 'other-episode' });
    expect(otherEpisode.caseId).not.toBe(first.caseId);
    const otherTenant = await appendParams({ ...REQUEST, tenantId: 'tenant-other' });
    expect(otherTenant.caseId).not.toBe(first.caseId);
    const otherProject = await appendParams({ ...REQUEST, projectScope: 'project:other' });
    expect(otherProject.caseId).not.toBe(first.caseId);
  });

  it('replays the identical request idempotently without a second append', async () => {
    const fake = makeDriver();
    const capture = createEvidenceAuthorityCapture(fake.driver);
    const first = await capture.capture({ ...REQUEST });
    const replay = await capture.capture({ ...REQUEST });
    expect(replay).toEqual(first);
    expect(fake.events.size).toBe(2);
    expect(fake.queries.filter((query) => query.includes('append-capture-coverage-case'))).toHaveLength(1);
  });

  it('returns the fixed content-free uncaptured code with zero I/O for hostile requests', async () => {
    const fake = makeDriver({ sessionThrows: true });
    const capture = createEvidenceAuthorityCapture(fake.driver);
    const hostileRequests: unknown[] = [
      null,
      undefined,
      'request',
      [],
      {},
      { ...REQUEST, extra: true },
      Object.assign(Object.create({ inherited: true }), REQUEST),
      { ...REQUEST, [Symbol('hostile')]: true },
      Object.defineProperty({ ...REQUEST }, 'semanticId', { get: () => SECRET_CANARY }),
      new Proxy({ ...REQUEST }, { getOwnPropertyDescriptor: () => { throw new Error(SECRET_CANARY); } }),
      { ...REQUEST, tenantId: null },
      { ...REQUEST, tenantId: `t${'x'.repeat(501)}` },
      { ...REQUEST, tenantId: `bad ${SECRET_CANARY}` },
      { ...REQUEST, projectScope: null },
      { ...REQUEST, projectScope: 'memberry' },
      { ...REQUEST, projectScope: 'Project:memberry' },
      { ...REQUEST, projectScope: 'project:MEMBERRY' },
      { ...REQUEST, projectScope: 'project:' },
      { ...REQUEST, projectScope: 'project:-memberry' },
      { ...REQUEST, projectScope: `project:${'x'.repeat(501)}` },
      { ...REQUEST, semanticId: '_nanoid-shaped' },
      { ...REQUEST, semanticId: '-nanoid-shaped' },
      { ...REQUEST, semanticId: 'sem antic' },
      { ...REQUEST, semanticId: `s${'x'.repeat(501)}` },
      { ...REQUEST, signalKind: 'reinforcement' },
      { ...REQUEST, signalKind: 'CONTRADICTION' },
      { ...REQUEST, signalKind: null },
      { ...REQUEST, sourceEpisodeId: '' },
      { ...REQUEST, sourceEpisodeId: `ep ${SECRET_CANARY}` },
      { ...REQUEST, sourceEpisodeId: 'ep\nnewline' },
      { ...REQUEST, sourceEpisodeId: `e${'x'.repeat(1_000_000)}` },
      { ...REQUEST, sourceEpisodeId: 42 },
    ];
    for (const request of hostileRequests) {
      const result = await capture.capture(request);
      expect(result).toEqual({
        contractVersion: EVIDENCE_AUTHORITY_CAPTURE_VERSION,
        outcome: 'uncaptured',
        code: 'uncaptured',
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(JSON.stringify(result)).not.toContain(SECRET_CANARY);
    }
    expect(fake.session).not.toHaveBeenCalled();
  });

  it('accepts nanoid-shaped source episode ids and never forwards them raw', async () => {
    const fake = makeDriver();
    const capture = createEvidenceAuthorityCapture(fake.driver);
    const nanoidEpisode = '-_09AZaz.:-id';
    const result = await capture.capture({ ...REQUEST, sourceEpisodeId: nanoidEpisode });
    expect(result.outcome).toBe('captured');
    for (const [query, params] of fake.run.mock.calls) {
      expect(String(query)).not.toContain(nanoidEpisode);
      expect(JSON.stringify(params ?? {})).not.toContain(nanoidEpisode);
    }
  });

  it('returns the terminal frozen uncaptured refusal for the ledger raw-edge precondition failure without residue', async () => {
    const fake = makeDriver({ rawSignalCount: 2 });
    const capture = createEvidenceAuthorityCapture(fake.driver);
    const result = await capture.capture({ ...REQUEST });
    expect(result).toEqual({
      contractVersion: EVIDENCE_AUTHORITY_CAPTURE_VERSION,
      outcome: 'uncaptured',
      code: 'uncaptured',
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(fake.events.size).toBe(0);
    expect(fake.coverage.size).toBe(0);
    expect(fake.cases.size).toBe(0);
  });

  it('returns the terminal frozen uncaptured refusal for operation_conflict and never retries', async () => {
    const probe = makeDriver();
    await createEvidenceAuthorityCapture(probe.driver).capture({ ...REQUEST });
    const probeCall = probe.run.mock.calls.find(([query]) => String(query).includes('append-capture-coverage-case'));
    const derived = probeCall?.[1] as Record<string, unknown>;

    const fake = makeDriver();
    const scope = {
      tenantId: REQUEST.tenantId,
      projectScope: REQUEST.projectScope,
      semanticId: REQUEST.semanticId,
    };
    const store = createEvidenceAuthorityLedgerPersistence(fake.driver);
    const captureFacet = createEvidenceAuthorityCaptureFacet(store, scope);
    await store.captureCase(captureFacet, scope, {
      caseId: 'capture-case-divergent',
      coverageOperationId: String(derived.coverageOperationId),
      caseOperationId: String(derived.caseOperationId),
    });
    const appendsBefore = fake.queries.filter((query) => query.includes('append-')).length;
    const result = await createEvidenceAuthorityCapture(fake.driver).capture({ ...REQUEST });
    expect(result).toEqual({
      contractVersion: EVIDENCE_AUTHORITY_CAPTURE_VERSION,
      outcome: 'uncaptured',
      code: 'uncaptured',
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(fake.queries.filter((query) => query.includes('append-'))).toHaveLength(appendsBefore);
  });

  it('keeps genuine captures, terminal policy refusals, and transient failures distinguishable', async () => {
    // Arrangement 1: genuine first capture and genuine idempotent replay are captured with a receipt.
    const genuine = makeDriver();
    const genuineCapture = createEvidenceAuthorityCapture(genuine.driver);
    const first = await genuineCapture.capture({ ...REQUEST });
    const replay = await genuineCapture.capture({ ...REQUEST });
    for (const result of [first, replay]) {
      expect(result.outcome).toBe('captured');
      expect(result.outcome === 'captured' && result.receipt !== null
        && result.receipt !== undefined).toBe(true);
    }

    // Arrangement 2: the (B-i) refusal and the operation_conflict path are terminal uncaptured.
    const refused = makeDriver({ rawSignalCount: 1 });
    const refusal = await createEvidenceAuthorityCapture(refused.driver).capture({ ...REQUEST });
    expect(refusal).toEqual({
      contractVersion: EVIDENCE_AUTHORITY_CAPTURE_VERSION,
      outcome: 'uncaptured',
      code: 'uncaptured',
    });
    const probeCall = genuine.run.mock.calls.find(([query]) => String(query).includes('append-capture-coverage-case'));
    const derived = probeCall?.[1] as Record<string, unknown>;
    const conflicted = makeDriver();
    const scope = {
      tenantId: REQUEST.tenantId,
      projectScope: REQUEST.projectScope,
      semanticId: REQUEST.semanticId,
    };
    const store = createEvidenceAuthorityLedgerPersistence(conflicted.driver);
    const captureFacet = createEvidenceAuthorityCaptureFacet(store, scope);
    await store.captureCase(captureFacet, scope, {
      caseId: 'capture-case-divergent',
      coverageOperationId: String(derived.coverageOperationId),
      caseOperationId: String(derived.caseOperationId),
    });
    const conflict = await createEvidenceAuthorityCapture(conflicted.driver).capture({ ...REQUEST });
    expect(conflict).toEqual({
      contractVersion: EVIDENCE_AUTHORITY_CAPTURE_VERSION,
      outcome: 'uncaptured',
      code: 'uncaptured',
    });

    // Arrangement 3: storage unavailability throws instead of returning either outcome.
    const unavailable = makeDriver({ sessionThrows: true });
    let storage: unknown;
    try { await createEvidenceAuthorityCapture(unavailable.driver).capture({ ...REQUEST }); } catch (caught) { storage = caught; }
    expect(storage).toBeInstanceOf(EvidenceAuthorityLedgerError);
    expect(storage).toMatchObject({ code: 'storage_unavailable' });
  });

  it('rejects a benign Proxy over an otherwise-valid request with zero driver calls', async () => {
    const fake = makeDriver();
    const capture = createEvidenceAuthorityCapture(fake.driver);
    const result = await capture.capture(new Proxy({ ...REQUEST }, {}));
    expect(result).toEqual({
      contractVersion: EVIDENCE_AUTHORITY_CAPTURE_VERSION,
      outcome: 'uncaptured',
      code: 'uncaptured',
    });
    expect(fake.run).not.toHaveBeenCalled();
    expect(fake.session).not.toHaveBeenCalled();
  });

  it('returns the terminal frozen uncaptured refusal for revoked coverage while the ledger boundary still throws content-free', async () => {
    const fake = makeDriver();
    const scope = {
      tenantId: REQUEST.tenantId,
      projectScope: REQUEST.projectScope,
      semanticId: REQUEST.semanticId,
    };
    const store = createEvidenceAuthorityLedgerPersistence(fake.driver);
    const captureFacet = createEvidenceAuthorityCaptureFacet(store, scope);
    const review = createEvidenceAuthorityReviewFacet(store, scope);
    const { facet } = await store.openCoverage(captureFacet, scope, { operationId: 'coverage-open' });
    await store.revokeCoverage(review, facet, scope, { operationId: 'coverage-revoke' });

    // The ledger boundary keeps its exact content-free thrown refusal.
    let ledgerError: unknown;
    try {
      await store.captureCase(captureFacet, scope, {
        caseId: 'capture-case-revoked',
        coverageOperationId: 'capture-op-coverage-revoked',
        caseOperationId: 'capture-op-case-revoked',
      });
    } catch (caught) { ledgerError = caught; }
    expect(ledgerError).toBeInstanceOf(EvidenceAuthorityLedgerError);
    expect(ledgerError).toMatchObject({ code: 'facet_revoked' });
    expect(String(ledgerError)).toBe('EvidenceAuthorityLedgerError: evidence_authority_ledger:facet_revoked');

    // The module boundary is terminal: the frozen uncaptured value, zero residue.
    const before = {
      events: fake.events.size,
      coverage: fake.coverage.size,
      cases: fake.cases.size,
    };
    const capture = createEvidenceAuthorityCapture(fake.driver);
    const result = await capture.capture({ ...REQUEST });
    expect(result).toEqual({
      contractVersion: EVIDENCE_AUTHORITY_CAPTURE_VERSION,
      outcome: 'uncaptured',
      code: 'uncaptured',
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect({
      events: fake.events.size,
      coverage: fake.coverage.size,
      cases: fake.cases.size,
    }).toEqual(before);
  });

  it('returns the terminal frozen uncaptured refusal for an unknown Semantic and propagates storage failures content-free', async () => {
    const missing = makeDriver({ semanticIds: [] });
    const notFound = await createEvidenceAuthorityCapture(missing.driver).capture({ ...REQUEST });
    expect(notFound).toEqual({
      contractVersion: EVIDENCE_AUTHORITY_CAPTURE_VERSION,
      outcome: 'uncaptured',
      code: 'uncaptured',
    });
    expect(Object.isFrozen(notFound)).toBe(true);
    expect(missing.events.size).toBe(0);

    const unavailable = makeDriver({ sessionThrows: true });
    let storage: unknown;
    try { await createEvidenceAuthorityCapture(unavailable.driver).capture({ ...REQUEST }); } catch (caught) { storage = caught; }
    expect(storage).toBeInstanceOf(EvidenceAuthorityLedgerError);
    expect(storage).toMatchObject({ code: 'storage_unavailable' });
    expect(String(storage)).not.toContain(SECRET_CANARY);
  });

  // RET-005B-AUTH-001B3B1 additive test: the third code of the Decision 105
  // errata triple is terminal at the capture boundary, never retried.
  it('returns the terminal frozen uncaptured refusal for existing_state_mismatch and never retries', async () => {
    const executeWrite = vi.fn(async () => {
      throw new EvidenceAuthorityLedgerError('existing_state_mismatch');
    });
    const close = vi.fn(async () => undefined);
    const session = vi.fn(() => ({ executeWrite, close }));
    const capture = createEvidenceAuthorityCapture({ session } as unknown as Driver);
    const result = await capture.capture({ ...REQUEST });
    expect(result).toEqual({
      contractVersion: EVIDENCE_AUTHORITY_CAPTURE_VERSION,
      outcome: 'uncaptured',
      code: 'uncaptured',
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(executeWrite).toHaveBeenCalledTimes(1);
    const again = await capture.capture({ ...REQUEST });
    expect(again).toBe(result);
    expect(executeWrite).toHaveBeenCalledTimes(2);
  });
});
