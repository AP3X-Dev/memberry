import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import neo4j, { type Driver } from 'neo4j-driver';
import { describe, expect, it, vi } from 'vitest';

import { EvidenceAuthorityLedgerError } from '../evidence-authority-ledger.js';
import {
  EVIDENCE_AUTHORITY_READ_VERSION,
  createEvidenceAuthorityRead,
} from '../evidence-authority-read.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const MODULE_PATH = resolve(REPO_ROOT, 'packages/neo4j/src/evidence-authority-read.ts');
const LEDGER_PATH = resolve(REPO_ROOT, 'packages/neo4j/src/evidence-authority-ledger.ts');
const RECORDED_AT = '2026-08-18T12:00:00.000Z';
const SECRET_CANARY = ['sk', 'read', 'must not leak 1234567890'].join(' ');
const SCOPE = Object.freeze({
  tenantId: 'tenant-acme',
  projectScope: 'project:memberry',
  semanticId: 'semantic-read-001',
});

// Test-local hand copy of the ledger digest chain (pinned to source below);
// never imported from the module under test.
const TEST_ID_DOMAIN = 'memberry-evidence-authority-ledger-v1';
function testDigest(kind: string, ...values: string[]): string {
  const input = JSON.stringify([TEST_ID_DOMAIN, kind, ...values]);
  return `evidence-authority:${kind}:sha256:${createHash('sha256').update(input).digest('hex')}`;
}
const LEDGER_ID = testDigest('ledger', SCOPE.tenantId, SCOPE.projectScope, SCOPE.semanticId);

const EMPTY_LISTING_SHAPE = Object.freeze({
  contractVersion: EVIDENCE_AUTHORITY_READ_VERSION,
  coverageState: 'none',
  cases: {},
  truncated: false,
  observedVersion: 0,
});
const EMPTY_PAGE_SHAPE = Object.freeze({
  contractVersion: EVIDENCE_AUTHORITY_READ_VERSION,
  rows: [],
  observedVersion: 0,
});

type Props = Record<string, unknown>;

function record(values: Props) {
  return { get: (key: string) => values[key] };
}

function fakeEvent(input: {
  sequence: number;
  kind: string;
  action: string;
  state: string;
  caseId: string;
  operationId: string;
  scope?: { tenantId: string; projectScope: string; semanticId: string };
}): Props {
  const scope = input.scope ?? SCOPE;
  return {
    id: testDigest('event', scope.tenantId, scope.projectScope, scope.semanticId, input.operationId),
    tenant_id: scope.tenantId,
    project_scope: scope.projectScope,
    semantic_id: scope.semanticId,
    case_id: input.caseId,
    operation_id: input.operationId,
    kind: input.kind,
    action: input.action,
    state: input.state,
    sequence: input.sequence,
    recorded_at: RECORDED_AT,
  };
}

function fakeOutbox(event: Props): Props {
  return {
    id: testDigest('outbox', String(event.id)),
    event_id: event.id,
    tenant_id: event.tenant_id,
    project_scope: event.project_scope,
    semantic_id: event.semantic_id,
    case_id: event.case_id,
    kind: event.kind,
    action: event.action,
    state: event.state,
    sequence: event.sequence,
    recorded_at: event.recorded_at,
  };
}

function rowFor(event: Props): Props {
  return { event, outbox: fakeOutbox(event) };
}

/** Six-event healthy history: coverage open, two cases fully adjudicated. */
function baseHistory(): Props[] {
  return [
    fakeEvent({ sequence: 1, kind: 'coverage', action: 'opened', state: 'open', caseId: '', operationId: 'op-cov-open' }),
    fakeEvent({ sequence: 2, kind: 'case', action: 'case_opened', state: 'pending', caseId: 'case-alpha', operationId: 'op-a-open' }),
    fakeEvent({ sequence: 3, kind: 'case', action: 'case_opened', state: 'pending', caseId: 'case-beta', operationId: 'op-b-open' }),
    fakeEvent({ sequence: 4, kind: 'case', action: 'resolution_started', state: 'resolving', caseId: 'case-alpha', operationId: 'op-a-start' }),
    fakeEvent({ sequence: 5, kind: 'case', action: 'resolved', state: 'resolved', caseId: 'case-alpha', operationId: 'op-a-done' }),
    fakeEvent({ sequence: 6, kind: 'case', action: 'rejected', state: 'rejected', caseId: 'case-beta', operationId: 'op-b-reject' }),
  ];
}

function makeDriver(options: {
  events?: unknown[];
  rows?: unknown[];
  version?: number;
  absent?: boolean;
  versionRecords?: unknown[];
  listingRecords?: unknown[];
  rowsRecords?: unknown[];
  sessionThrows?: unknown;
  executeReadThrows?: unknown;
  closeThrows?: unknown;
} = {}) {
  const calls: Array<[string, Props]> = [];
  const run = vi.fn(async (query: string, params: Props = {}) => {
    calls.push([query, params]);
    if (query.includes('evidence-authority:read-version')) {
      if (options.versionRecords !== undefined) return { records: options.versionRecords };
      if (options.absent) return { records: [] };
      return { records: [record({ version: options.version ?? 0 })] };
    }
    if (query.includes('evidence-authority:read-listing')) {
      if (options.listingRecords !== undefined) return { records: options.listingRecords };
      return { records: [record({ events: options.events ?? [] })] };
    }
    if (query.includes('evidence-authority:read-pull')) {
      if (options.rowsRecords !== undefined) return { records: options.rowsRecords };
      return { records: [record({ rows: options.rows ?? [] })] };
    }
    throw new Error(`unexpected query: ${query}`);
  });
  const executeRead = vi.fn(async <T>(work: (tx: { run: typeof run }) => Promise<T>) => {
    if (options.executeReadThrows !== undefined) throw options.executeReadThrows;
    return work({ run });
  });
  const executeWrite = vi.fn(async () => {
    throw new Error('executeWrite must never be reachable from the read surface');
  });
  const close = vi.fn(async () => {
    if (options.closeThrows !== undefined) throw options.closeThrows;
  });
  const sessionOptions: unknown[] = [];
  const session = vi.fn((config?: unknown) => {
    if (options.sessionThrows !== undefined) throw options.sessionThrows;
    sessionOptions.push(config);
    return { executeRead, executeWrite, close };
  });
  const driver = { session } as unknown as Driver;
  return { driver, run, calls, executeRead, executeWrite, close, session, sessionOptions };
}

function historyDriver(events: unknown[], version = 99) {
  return makeDriver({ events, version });
}

function rowsDriver(rows: unknown[], version = 99) {
  return makeDriver({ rows, version });
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<unknown> {
  let error: unknown;
  try { await promise; } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(EvidenceAuthorityLedgerError);
  expect(error).toMatchObject({ code });
  expect(String(error)).toBe(`EvidenceAuthorityLedgerError: evidence_authority_ledger:${code}`);
  return error;
}

async function expectMismatchOnBothSurfaces(tamperedEvents: Props[], tamperedRows?: Props[]): Promise<void> {
  const listing = historyDriver(tamperedEvents);
  await expectCode(createEvidenceAuthorityRead(listing.driver, { ...SCOPE }).listCases(), 'existing_state_mismatch');
  const pull = rowsDriver(tamperedRows ?? tamperedEvents.map(rowFor));
  await expectCode(
    createEvidenceAuthorityRead(pull.driver, { ...SCOPE }).pullOutbox({ afterSequence: 0 }),
    'existing_state_mismatch',
  );
}

function importSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(/from '([^']+)'/g),
    ...source.matchAll(/import '([^']+)'/g),
    ...source.matchAll(/import\('([^']+)'\)/g),
    ...source.matchAll(/require\('([^']+)'\)/g),
  ].map((match) => match[1]!);
}

const moduleSource = readFileSync(MODULE_PATH, 'utf8');
const ledgerSource = readFileSync(LEDGER_PATH, 'utf8');

// (K)(27) helper: BC-1 anchor + scope predicates as observed at the driver.
function scopePredicateFailures(text: string, requireEventLeg: boolean): string[] {
  const failures: string[] = [];
  if (!text.includes('(ledger:EvidenceAuthorityLedger {id: $ledgerId})')) failures.push('anchor');
  for (const predicate of [
    'ledger.tenant_id = $tenantId',
    'ledger.project_scope = $projectScope',
    'ledger.semantic_id = $semanticId',
  ]) {
    if (!text.includes(predicate)) failures.push(predicate);
  }
  if (requireEventLeg) {
    for (const predicate of [
      'event.tenant_id = $tenantId',
      'event.project_scope = $projectScope',
      'event.semantic_id = $semanticId',
    ]) {
      if (!text.includes(predicate)) failures.push(predicate);
    }
  }
  return failures;
}

// §B2-REGISTER verbatim bytes (Decision 114 ERRATA 1); asserted byte-for-byte
// inside the module doc comment.
const REGISTER = `This module provides a read-only, construction-scope-bound, advisory snapshot of one evidence-authority ledger. It is not authentication and it is not authorization: it verifies no human, actor, role, or permission, and it performs no access check of any kind. Its only containment is that the tenant/project/Semantic triple is bound at construction and cannot be supplied per call, and that the module is absent from the package root export.

The ledgerId is a public digest, not a capability. It is sha256 over a published domain string and three caller-known values; anyone who knows the scope can compute it. Every query re-asserts the full scope in Cypher and every returned row is re-checked in TypeScript; those predicates, not the identifier, are the boundary.

This listing derives no clearance, and clearance derivation remains exclusively B4's under Decision 104 (B-ii). B4 may not treat this listing as a clearance input. Be plain about why the identifier ban is only hygiene: the state vocabulary is a closed transition table, so whenever truncated === false a caller can compute clearance client-side from coverageState and cases. Banning the words bans the vocabulary, not the capability. The hard cap and the truncated marker are the only real limiter; a truncated === true page is a deterministic, state-independent prefix from which clearance is NOT derivable.

pullOutbox cannot report ledger absence. A mistyped Semantic drains forever and is indistinguishable from a healthy drained ledger - a deliberate anti-oracle tradeoff, not a defect. Equally, coverageState 'none' does not distinguish "Semantic absent" from "Semantic present and uncovered" - no query in this module ever joins (:Semantic).

Refusal and emptiness are different channels here, deliberately and unlike the sibling write modules: an invalid cursor, an invalid request shape, or any row this module cannot validate is refused loudly by a thrown EvidenceAuthorityLedgerError, and only genuine emptiness - an absent ledger, an uncovered Semantic, or a cursor past the last event - returns an empty listing or an empty page.

observedVersion discloses write volume. It is a dense monotone counter; polling it reveals a ledger's write rate and timing to anyone who can reach this module.

At-least-once delivery and durable checkpointing are caller obligations. This module holds no cursor, persists nothing, and remembers nothing between calls: the caller owns the cursor, and a caller that loses it replays. No ack, skip, park, dead-letter, mark-delivered, push, or deliver verb exists in this module or anywhere in this lane - in an unwired package such a verb would be a forged delivery claim. The outbox is a permanent immutable journal; no delivery state exists anywhere in the audited subgraph, and adding any would permanently brick the ledger's write path.

The snapshot is advisory and immediately stale. This module performs no writes, mints no ledger, mints no coverage, and takes no lock.`;

describe('EvidenceAuthorityRead V1 (RET-005B-AUTH-001B3B2)', () => {
  it('freezes the version constant and both caps by name and value (K1)', () => {
    expect(EVIDENCE_AUTHORITY_READ_VERSION).toBe('memberry.evidence-authority-read/1.0.0');
    expect(moduleSource).toContain('const MAX_LISTED_CASES = 200;');
    expect(moduleSource).toContain('const MAX_PULLED_ROWS = 100;');
  });

  it('stays off the package root export entirely (K2, F18)', () => {
    const rootExports = readFileSync(resolve(REPO_ROOT, 'packages/neo4j/src/index.ts'), 'utf8');
    expect(rootExports).not.toContain('evidence-authority-read');
    expect(rootExports).not.toContain('createEvidenceAuthorityRead');
    expect(rootExports).not.toContain('EVIDENCE_AUTHORITY_READ_VERSION');
  });

  it('passes every amended (G) source ban individually (K3)', () => {
    expect(moduleSource).not.toMatch(/CREATE\s*\(/);
    expect(moduleSource).not.toMatch(/MERGE\s*\(/);
    expect(moduleSource).not.toMatch(/\bSET\b/);
    expect(moduleSource).not.toMatch(/\bDELETE\b/);
    expect(moduleSource).not.toMatch(/\bREMOVE\b/);
    expect(moduleSource).not.toMatch(/\bDETACH\b/);
    expect(moduleSource).not.toMatch(/executeWrite/);
    expect(moduleSource).not.toMatch(/session\.run\(/);
    expect(moduleSource).not.toMatch(/evidence-authority:lock/);
    expect(moduleSource).not.toMatch(/ledger\.locked/);
    expect(moduleSource).not.toMatch(/isClear|allResolved|hasOpen|clean/);
    expect(moduleSource).not.toMatch(/markClear|mintClear|setClear|deriveClearance|emitClearance/);
    expect(moduleSource).not.toMatch(/\backRow|acknowledge|nack\(|markDelivered|deadLetter|redeliver|inflight/i);
    expect(moduleSource).not.toMatch(/createSink|deliverTo|pushOutbox|pushTo|saveCheckpoint|checkpointCursor/i);
    expect(moduleSource).not.toMatch(/authenticated|non-repudiation|verified reviewer/i);
    expect(moduleSource).not.toMatch(/Redis|ProposalStore|Consolidation|Retrieval|MCP/);
    expect(moduleSource).not.toMatch(/console\./);
    expect(moduleSource).not.toMatch(/new Date\(|Date\.now\(/);
  });

  it('holds the BC-10 structural regime: const-only module scope, frozen aggregates, no Map/Set, no node:fs (K4)', async () => {
    expect(moduleSource).not.toMatch(/^(let|var)\s/m);
    expect(moduleSource).not.toMatch(/new (Map|Set)\b/);
    expect(moduleSource).not.toContain('node:fs');
    for (const name of ['LEDGER_ERROR_CODES', 'EVENT_KEYS', 'OUTBOX_KEYS', 'SCOPE_KEYS', 'ROW_KEYS', 'EVENT_PAIRS']) {
      expect(moduleSource).toMatch(new RegExp(`const ${name}[^=]*= Object\\.freeze\\(`));
    }
    for (const name of ['EMPTY_LISTING', 'EMPTY_PAGE']) {
      expect(moduleSource).toMatch(new RegExp(
        `const ${name}[^=]*= Object\\.freeze\\(\\s*Object\\.assign\\(Object\\.create\\(null\\)`,
      ));
    }
    // Runtime half on the two reachable module-scope values.
    const absent = makeDriver({ absent: true });
    const read = createEvidenceAuthorityRead(absent.driver, { ...SCOPE });
    const listing = await read.listCases();
    expect(Object.isFrozen(listing)).toBe(true);
    expect(Object.getPrototypeOf(listing)).toBeNull();
    expect(Object.isFrozen(listing.cases)).toBe(true);
    expect(Object.getPrototypeOf(listing.cases)).toBeNull();
    const page = await read.pullOutbox({ afterSequence: 0 });
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.getPrototypeOf(page)).toBeNull();
    expect(Object.isFrozen(page.rows)).toBe(true);
  });

  it('imports exactly the B3B1 allowlist and reaches no infra module (K5)', () => {
    const moduleImports = importSpecifiers(moduleSource);
    expect([...moduleImports].sort()).toEqual([
      './evidence-authority-ledger.js',
      'neo4j-driver',
      'node:crypto',
      'node:util/types',
    ]);
    const ledgerImports = importSpecifiers(ledgerSource);
    for (const specifier of [...moduleImports, ...ledgerImports]) {
      expect(specifier).not.toMatch(/redis|cache|queue|stream|bull|kafka/i);
    }
  });

  it('pins every hand copy to the ledger source: error codes, keys, domain, digest, pair table (K6)', () => {
    const moduleCodesMatch = moduleSource.match(/const LEDGER_ERROR_CODES[^=]*= Object\.freeze\(\[([\s\S]*?)\]/);
    expect(moduleCodesMatch).not.toBeNull();
    const moduleCodes = [...moduleCodesMatch![1]!.matchAll(/'([a-z_]+)'/g)].map((entry) => entry[1]!).sort();
    const ledgerCodesMatch = ledgerSource.match(/const ERROR_CODES = new Set<EvidenceAuthorityLedgerErrorCode>\(\[([\s\S]*?)\]\)/);
    expect(ledgerCodesMatch).not.toBeNull();
    const ledgerCodes = [...ledgerCodesMatch![1]!.matchAll(/'([a-z_]+)'/g)].map((entry) => entry[1]!).sort();
    expect(moduleCodes).toEqual(ledgerCodes);
    expect(moduleCodes).toHaveLength(13);

    for (const name of ['EVENT_KEYS', 'OUTBOX_KEYS'] as const) {
      const fromModule = moduleSource.match(new RegExp(`const ${name}[^=]*= Object\\.freeze\\(\\[([\\s\\S]*?)\\]`));
      const fromLedger = ledgerSource.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]`));
      expect(fromModule).not.toBeNull();
      expect(fromLedger).not.toBeNull();
      const moduleKeys = [...fromModule![1]!.matchAll(/'([a-z_]+)'/g)].map((entry) => entry[1]!);
      const ledgerKeys = [...fromLedger![1]!.matchAll(/'([a-z_]+)'/g)].map((entry) => entry[1]!);
      expect(moduleKeys).toEqual(ledgerKeys);
      expect(moduleKeys).toHaveLength(11);
    }

    const moduleDomain = moduleSource.match(/const ID_DOMAIN = '([^']+)';/);
    const ledgerDomain = ledgerSource.match(/const ID_DOMAIN = '([^']+)';/);
    expect(moduleDomain?.[1]).toBe(ledgerDomain?.[1]);
    expect(moduleDomain?.[1]).toBe(TEST_ID_DOMAIN);

    const digestLines = [
      'const input = JSON.stringify([ID_DOMAIN, kind, ...values]);',
      "return `evidence-authority:${kind}:sha256:${createHash('sha256').update(input).digest('hex')}`;",
    ];
    for (const line of digestLines) {
      expect(moduleSource).toContain(line);
      expect(ledgerSource).toContain(line);
    }

    const modulePairs = [...moduleSource.matchAll(
      /Object\.freeze\(\['([a-z_]+)', '([a-z_]+)', '([a-z_]+)'\] as const\)/g,
    )].map((entry) => `${entry[1]}:${entry[2]}:${entry[3]}`);
    expect(modulePairs).toHaveLength(6);
    const ledgerPairs = new Set([...ledgerSource.matchAll(
      /action === '([a-z_]+)' && state === '([a-z_]+)'/g,
    )].map((entry) => `${entry[1]}:${entry[2]}`));
    expect([...ledgerPairs].sort()).toEqual([
      'case_opened:pending',
      'opened:open',
      'rejected:rejected',
      'resolution_started:resolving',
      'resolved:resolved',
      'revoked:revoked',
    ]);
    // Kind partition: opened/revoked are the coverage actions in the ledger's
    // own validators; every other pinned pair is case-kind.
    const expectedTriples = [
      'coverage:opened:open',
      'coverage:revoked:revoked',
      'case:case_opened:pending',
      'case:rejected:rejected',
      'case:resolution_started:resolving',
      'case:resolved:resolved',
    ];
    expect([...modulePairs].sort()).toEqual([...expectedTriples].sort());
    for (const triple of modulePairs) {
      const [, action, state] = triple.split(':');
      expect(ledgerPairs.has(`${action}:${state}`)).toBe(true);
    }
  });

  it('hardens construction: hostile scopes throw invalid_scope with zero I/O and the surface is sealed (K7)', async () => {
    const hostileScopes: unknown[] = [
      null,
      undefined,
      'scope',
      42,
      true,
      [],
      {},
      { ...SCOPE, extra: true },
      { tenantId: SCOPE.tenantId, projectScope: SCOPE.projectScope },
      Object.assign(Object.create({ inherited: true }), SCOPE),
      { ...SCOPE, [Symbol('hostile')]: true },
      Object.defineProperty({ ...SCOPE }, 'tenantId', { get: () => SECRET_CANARY }),
      new Proxy({ ...SCOPE }, {}),
      new Proxy({ ...SCOPE }, { getOwnPropertyDescriptor: () => { throw new Error(SECRET_CANARY); } }),
      new String('scope'),
      { ...SCOPE, tenantId: new String(SCOPE.tenantId) },
      { ...SCOPE, tenantId: '' },
      { ...SCOPE, tenantId: `t${'x'.repeat(501)}` },
      { ...SCOPE, tenantId: 'bad tenant' },
      { ...SCOPE, tenantId: 42 },
      { ...SCOPE, projectScope: 'memberry' },
      { ...SCOPE, projectScope: 'Project:memberry' },
      { ...SCOPE, projectScope: `project:${'x'.repeat(501)}` },
      { ...SCOPE, semanticId: '' },
      { ...SCOPE, semanticId: 42 },
      { ...SCOPE, semanticId: `bad ${SECRET_CANARY}` },
    ];
    expect(hostileScopes.length).toBeGreaterThanOrEqual(20);
    const fake = makeDriver({ sessionThrows: new Error(SECRET_CANARY) });
    for (const scope of hostileScopes) {
      let error: unknown;
      try { createEvidenceAuthorityRead(fake.driver, scope); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(EvidenceAuthorityLedgerError);
      expect(error).toMatchObject({ code: 'invalid_scope' });
      expect(String(error)).toBe('EvidenceAuthorityLedgerError: evidence_authority_ledger:invalid_scope');
      expect(String(error)).not.toContain(SECRET_CANARY);
    }
    expect(fake.session).not.toHaveBeenCalled();

    const read = createEvidenceAuthorityRead(fake.driver, { ...SCOPE });
    expect(Reflect.ownKeys(read)).toEqual(['contractVersion', 'listCases', 'pullOutbox']);
    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.getPrototypeOf(read)).toBeNull();
    expect(read.contractVersion).toBe(EVIDENCE_AUTHORITY_READ_VERSION);
    const serialized = JSON.stringify(read);
    expect(serialized).toBe(`{"contractVersion":"${EVIDENCE_AUTHORITY_READ_VERSION}"}`);
    expect(serialized).not.toContain('sha256');
    expect(serialized).not.toContain(LEDGER_ID);
  });

  it('lists the folded case map exactly on the happy path (K8)', async () => {
    const fake = makeDriver({ events: baseHistory(), version: 6 });
    const read = createEvidenceAuthorityRead(fake.driver, { ...SCOPE });
    const listing = await read.listCases();
    expect(listing).toEqual({
      contractVersion: EVIDENCE_AUTHORITY_READ_VERSION,
      coverageState: 'open',
      cases: { 'case-alpha': 'resolved', 'case-beta': 'rejected' },
      truncated: false,
      observedVersion: 6,
    });
    expect(Object.keys(listing.cases)).toEqual(['case-alpha', 'case-beta']);
  });

  it('synthesizes coverageState from the coverage event chain: none, open, revoked (K9, GAP-1)', async () => {
    const noCoverage = makeDriver({ events: [], version: 0 });
    const none = await createEvidenceAuthorityRead(noCoverage.driver, { ...SCOPE }).listCases();
    expect(none.coverageState).toBe('none');
    expect(none.observedVersion).toBe(0);

    const openedOnly = makeDriver({
      events: [fakeEvent({ sequence: 1, kind: 'coverage', action: 'opened', state: 'open', caseId: '', operationId: 'op-cov-open' })],
      version: 1,
    });
    const open = await createEvidenceAuthorityRead(openedOnly.driver, { ...SCOPE }).listCases();
    expect(open.coverageState).toBe('open');

    const revokedEvents = [
      ...baseHistory(),
      fakeEvent({ sequence: 7, kind: 'coverage', action: 'revoked', state: 'revoked', caseId: '', operationId: 'op-cov-revoke' }),
    ];
    const revokedFake = makeDriver({ events: revokedEvents, version: 7 });
    const revoked = await createEvidenceAuthorityRead(revokedFake.driver, { ...SCOPE }).listCases();
    expect(revoked.coverageState).toBe('revoked');
    // Cases under a revoked coverage still list with their frozen last states.
    expect(revoked.cases).toEqual({ 'case-alpha': 'resolved', 'case-beta': 'rejected' });
  });

  it('returns the frozen value-free empties for an absent ledger and never issues the second statement (K10)', async () => {
    const listFake = makeDriver({ absent: true });
    const listRead = createEvidenceAuthorityRead(listFake.driver, { ...SCOPE });
    const listing = await listRead.listCases();
    expect(listing).toEqual(EMPTY_LISTING_SHAPE);
    expect(listFake.run).toHaveBeenCalledTimes(1);
    expect(await listRead.listCases()).toBe(listing);
    const pullFake = makeDriver({ absent: true });
    const pullRead = createEvidenceAuthorityRead(pullFake.driver, { ...SCOPE });
    const page = await pullRead.pullOutbox({ afterSequence: 0 });
    expect(page).toEqual(EMPTY_PAGE_SHAPE);
    expect(pullFake.run).toHaveBeenCalledTimes(1);
    expect(await pullRead.pullOutbox({ afterSequence: 0 })).toBe(page);
    for (const fake of [listFake, pullFake]) {
      expect(fake.executeWrite).not.toHaveBeenCalled();
      for (const [query] of fake.calls) {
        expect(query).not.toContain('MERGE');
        expect(query).not.toContain('CREATE');
      }
    }
  });

  it('refuses a multi-record version read on both surfaces (K11)', async () => {
    const versionRecords = [record({ version: 1 }), record({ version: 2 })];
    const listFake = makeDriver({ versionRecords });
    await expectCode(
      createEvidenceAuthorityRead(listFake.driver, { ...SCOPE }).listCases(),
      'existing_state_mismatch',
    );
    const pullFake = makeDriver({ versionRecords });
    await expectCode(
      createEvidenceAuthorityRead(pullFake.driver, { ...SCOPE }).pullOutbox({ afterSequence: 0 }),
      'existing_state_mismatch',
    );
  });

  it('truncates deterministically: 250 cases in any driver order yield one byte-identical 200-entry prefix (K12, F3)', async () => {
    const events: Props[] = [
      fakeEvent({ sequence: 1, kind: 'coverage', action: 'opened', state: 'open', caseId: '', operationId: 'op-cov-open' }),
    ];
    let sequence = 1;
    for (let index = 0; index < 250; index += 1) {
      sequence += 1;
      const caseId = `case-${String(index).padStart(3, '0')}`;
      events.push(fakeEvent({
        sequence, kind: 'case', action: 'case_opened', state: 'pending', caseId, operationId: `op-open-${caseId}`,
      }));
    }
    for (let index = 0; index < 250; index += 1) {
      const caseId = `case-${String(index).padStart(3, '0')}`;
      if (index % 3 === 1) {
        sequence += 1;
        events.push(fakeEvent({
          sequence, kind: 'case', action: 'rejected', state: 'rejected', caseId, operationId: `op-reject-${caseId}`,
        }));
      } else if (index % 3 === 2) {
        sequence += 1;
        events.push(fakeEvent({
          sequence, kind: 'case', action: 'resolution_started', state: 'resolving', caseId, operationId: `op-start-${caseId}`,
        }));
      }
    }
    const version = sequence;
    const ascending = events;
    const descending = [...events].reverse();
    const shuffled = [
      ...events.filter((_, index) => index % 2 === 0),
      ...events.filter((_, index) => index % 2 === 1).reverse(),
    ];
    const results = [];
    for (const order of [ascending, descending, shuffled]) {
      const fake = makeDriver({ events: order, version });
      results.push(await createEvidenceAuthorityRead(fake.driver, { ...SCOPE }).listCases());
    }
    const [first, second, third] = results;
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(third)).toBe(JSON.stringify(first));
    expect(first!.truncated).toBe(true);
    const keys = Object.keys(first!.cases);
    expect(keys).toHaveLength(200);
    expect(keys).toEqual([...Array.from({ length: 200 }, (_, index) => `case-${String(index).padStart(3, '0')}`)]);
    // States correlated with order: a shifted prefix would change bytes.
    expect(first!.cases['case-000']).toBe('pending');
    expect(first!.cases['case-001']).toBe('rejected');
    expect(first!.cases['case-002']).toBe('resolving');
    expect(first!.cases['case-199']).toBe('rejected');
  });

  it('keeps hostile case ids as ordinary own keys and never pollutes prototypes (K13)', async () => {
    const events = [
      fakeEvent({ sequence: 1, kind: 'coverage', action: 'opened', state: 'open', caseId: '', operationId: 'op-cov-open' }),
      fakeEvent({ sequence: 2, kind: 'case', action: 'case_opened', state: 'pending', caseId: 'constructor', operationId: 'op-ctor' }),
      fakeEvent({ sequence: 3, kind: 'case', action: 'case_opened', state: 'pending', caseId: 'prototype', operationId: 'op-proto' }),
      fakeEvent({ sequence: 4, kind: 'case', action: 'case_opened', state: 'pending', caseId: 'toString', operationId: 'op-tostr' }),
    ];
    const fake = makeDriver({ events, version: 4 });
    const listing = await createEvidenceAuthorityRead(fake.driver, { ...SCOPE }).listCases();
    expect(Object.getPrototypeOf(listing.cases)).toBeNull();
    for (const key of ['constructor', 'prototype', 'toString']) {
      expect(Object.hasOwn(listing.cases, key)).toBe(true);
      expect(listing.cases[key]).toBe('pending');
    }
    // '__proto__' fails the ledger identifier charset (leading underscore), so
    // it can never be ledger-minted: the row is refused, and still pollutes
    // nothing.
    const protoEvents = [
      events[0]!,
      fakeEvent({ sequence: 2, kind: 'case', action: 'case_opened', state: 'pending', caseId: '__proto__', operationId: 'op-dunder' }),
    ];
    const protoFake = makeDriver({ events: protoEvents, version: 2 });
    await expectCode(
      createEvidenceAuthorityRead(protoFake.driver, { ...SCOPE }).listCases(),
      'existing_state_mismatch',
    );
    expect(Object.hasOwn(Object.prototype, 'case-alpha')).toBe(false);
    expect(({} as Record<string, unknown>).constructor).toBe(Object);
    expect(Object.keys({})).toEqual([]);
  });

  it('refuses every abused cursor with invalid_command and zero session opens; valid defaults reach the driver as neo4j.int (K14, BC-5/BC-6)', async () => {
    const fake = makeDriver({ sessionThrows: new Error(SECRET_CANARY) });
    const read = createEvidenceAuthorityRead(fake.driver, { ...SCOPE });
    const abusedRequests: unknown[] = [
      { afterSequence: Number.NaN },
      { afterSequence: Number.POSITIVE_INFINITY },
      { afterSequence: Number.NEGATIVE_INFINITY },
      { afterSequence: -1 },
      { afterSequence: 1.5 },
      { afterSequence: Number.MAX_SAFE_INTEGER + 1 },
      { afterSequence: '5' },
      { afterSequence: null },
      { afterSequence: undefined },
      { afterSequence: neo4j.int(5) },
      { afterSequence: { valueOf() { return 5; } } },
      { afterSequence: BigInt(5) },
      { afterSequence: 0, limit: 0 },
      { afterSequence: 0, limit: -1 },
      { afterSequence: 0, limit: 101 },
      { afterSequence: 0, limit: 1.5 },
      { afterSequence: 0, limit: Number.NaN },
      { afterSequence: 0, limit: '10' },
      { afterSequence: 0, limit: 1, extra: true },
      { afterSequence: 0, tenantId: SCOPE.tenantId },
      { afterSequence: 0, projectScope: SCOPE.projectScope },
      { afterSequence: 0, semanticId: SCOPE.semanticId },
      { afterSequence: 0, ledgerId: LEDGER_ID },
      {},
      null,
      undefined,
      'request',
      42,
      [],
      new Proxy({ afterSequence: 0 }, {}),
      Object.defineProperty({ afterSequence: 0 }, 'limit', { get: () => 10 }),
      Object.assign(Object.create({ inherited: true }), { afterSequence: 0 }),
    ];
    for (const request of abusedRequests) {
      const error = await expectCode(read.pullOutbox(request), 'invalid_command');
      expect(String(error)).not.toContain(SECRET_CANARY);
    }
    expect(fake.session).not.toHaveBeenCalled();

    // Positive arm: the cursor params reach the rows statement as neo4j.int,
    // with the omitted limit defaulting to MAX_PULLED_ROWS.
    const present = makeDriver({ rows: [], version: 0 });
    await createEvidenceAuthorityRead(present.driver, { ...SCOPE }).pullOutbox({ afterSequence: 0 });
    const rowsCall = present.calls.find(([query]) => query.includes('evidence-authority:read-pull'));
    expect(rowsCall).toBeDefined();
    expect(neo4j.isInt(rowsCall![1].limit as object)).toBe(true);
    expect((rowsCall![1].limit as { toNumber(): number }).toNumber()).toBe(100);
    expect((rowsCall![1].afterSequence as { toNumber(): number }).toNumber()).toBe(0);
  });

  it('refuses key-set attacks on event and outbox nodes on both surfaces (K15-i)', async () => {
    const extraKey = baseHistory();
    extraKey[2] = { ...extraKey[2]!, forged: true };
    await expectMismatchOnBothSurfaces(extraKey);

    const missingKey = baseHistory().map((event, index) => {
      if (index !== 3) return event;
      const { operation_id: _dropped, ...rest } = event;
      return rest;
    });
    await expectMismatchOnBothSurfaces(missingKey as Props[]);

    const inheritedOnly = baseHistory();
    const inheritedEvent = { ...inheritedOnly[1]! };
    delete inheritedEvent.state;
    inheritedOnly[1] = Object.assign(Object.create({ state: 'pending' }), inheritedEvent);
    await expectMismatchOnBothSurfaces(inheritedOnly);

    const accessor = baseHistory();
    accessor[4] = Object.defineProperty({ ...accessor[4]! }, 'state', { get: () => 'resolved', enumerable: true });
    await expectMismatchOnBothSurfaces(accessor);

    // Outbox-side key-set attacks (pull only).
    const healthy = baseHistory();
    const outboxExtra = healthy.map(rowFor);
    outboxExtra[0] = { event: healthy[0]!, outbox: { ...fakeOutbox(healthy[0]!), forged: true } };
    await expectCode(
      createEvidenceAuthorityRead(rowsDriver(outboxExtra).driver, { ...SCOPE }).pullOutbox({ afterSequence: 0 }),
      'existing_state_mismatch',
    );
    const outboxMissing = healthy.map(rowFor);
    const { event_id: _droppedEventId, ...outboxRest } = fakeOutbox(healthy[0]!);
    outboxMissing[0] = { event: healthy[0]!, outbox: outboxRest };
    await expectCode(
      createEvidenceAuthorityRead(rowsDriver(outboxMissing).driver, { ...SCOPE }).pullOutbox({ afterSequence: 0 }),
      'existing_state_mismatch',
    );
  });

  it('recomputes the full event-joined digest chain and refuses every forgery (K15-ii, F6)', async () => {
    const forgedEventId = baseHistory();
    forgedEventId[1] = { ...forgedEventId[1]!, id: testDigest('event', SCOPE.tenantId, SCOPE.projectScope, SCOPE.semanticId, 'op-forged') };
    await expectMismatchOnBothSurfaces(forgedEventId);

    // THE F6 ATTACK: outbox.id is self-consistent with outbox.event_id, but
    // outbox.event_id does not match the joined event. A self-referential
    // implementation (outbox.id === digest('outbox', outbox.event_id))
    // accepts this row; the bound implementation must refuse it.
    const healthy = baseHistory();
    const forgedForeignEventId = testDigest('event', SCOPE.tenantId, SCOPE.projectScope, SCOPE.semanticId, 'op-foreign');
    const selfConsistentForgery = healthy.map(rowFor);
    selfConsistentForgery[2] = {
      event: healthy[2]!,
      outbox: {
        ...fakeOutbox(healthy[2]!),
        event_id: forgedForeignEventId,
        id: testDigest('outbox', forgedForeignEventId),
      },
    };
    await expectCode(
      createEvidenceAuthorityRead(rowsDriver(selfConsistentForgery).driver, { ...SCOPE }).pullOutbox({ afterSequence: 0 }),
      'existing_state_mismatch',
    );

    const mismatchedOutboxId = healthy.map(rowFor);
    mismatchedOutboxId[0] = {
      event: healthy[0]!,
      outbox: { ...fakeOutbox(healthy[0]!), id: testDigest('outbox', 'not-the-event-id') },
    };
    await expectCode(
      createEvidenceAuthorityRead(rowsDriver(mismatchedOutboxId).driver, { ...SCOPE }).pullOutbox({ afterSequence: 0 }),
      'existing_state_mismatch',
    );
  });

  it('refuses vocabulary the ledger can never mint (K15-iii vocabulary forgery)', async () => {
    const forgeries: Array<Partial<{ kind: string; action: string; state: string }>> = [
      { kind: 'coverage', action: 'resolved', state: 'resolved' },
      { kind: 'case', action: 'opened', state: 'open' },
      { kind: 'case', action: 'revoked', state: 'revoked' },
      { kind: 'audit', action: 'opened', state: 'open' },
      { kind: 'coverage', action: 'opened', state: 'revoked' },
      { kind: 'case', action: 'case_opened', state: 'resolved' },
    ];
    for (const forgery of forgeries) {
      const events = baseHistory();
      const caseLike = forgery.kind === 'coverage' ? '' : 'case-alpha';
      events[1] = { ...events[1]!, ...forgery, case_id: caseLike };
      await expectMismatchOnBothSurfaces(events);
    }
  });

  it("validates case_id on the wire value: '' for coverage, identifier for case, null always hostile (K15-iii as amended)", async () => {
    // Four negative arms, each on both surfaces.
    const coverageNonEmpty = baseHistory();
    coverageNonEmpty[0] = { ...coverageNonEmpty[0]!, case_id: 'case-alpha' };
    await expectMismatchOnBothSurfaces(coverageNonEmpty);

    const coverageNull = baseHistory();
    coverageNull[0] = { ...coverageNull[0]!, case_id: null };
    await expectMismatchOnBothSurfaces(coverageNull);

    const caseEmpty = baseHistory();
    caseEmpty[1] = { ...caseEmpty[1]!, case_id: '' };
    await expectMismatchOnBothSurfaces(caseEmpty);

    const caseNull = baseHistory();
    caseNull[1] = { ...caseNull[1]!, case_id: null };
    await expectMismatchOnBothSurfaces(caseNull);

    // Outbox-side arms on pull: the outbox must carry the same wire value.
    const healthy = baseHistory();
    const outboxCoverageNonEmpty = healthy.map(rowFor);
    outboxCoverageNonEmpty[0] = { event: healthy[0]!, outbox: { ...fakeOutbox(healthy[0]!), case_id: 'case-alpha' } };
    await expectCode(
      createEvidenceAuthorityRead(rowsDriver(outboxCoverageNonEmpty).driver, { ...SCOPE }).pullOutbox({ afterSequence: 0 }),
      'existing_state_mismatch',
    );
    const outboxCaseNull = healthy.map(rowFor);
    outboxCaseNull[1] = { event: healthy[1]!, outbox: { ...fakeOutbox(healthy[1]!), case_id: null } };
    await expectCode(
      createEvidenceAuthorityRead(rowsDriver(outboxCaseNull).driver, { ...SCOPE }).pullOutbox({ afterSequence: 0 }),
      'existing_state_mismatch',
    );

    // POSITIVE CONTROL (the ERRATA 1 bite-proof): a well-formed coverage row
    // with wire case_id '' and a well-formed case row with an identifier both
    // validate; the boundary normalizes '' to null exactly once.
    const control = rowsDriver(healthy.map(rowFor), 6);
    const page = await createEvidenceAuthorityRead(control.driver, { ...SCOPE }).pullOutbox({ afterSequence: 0 });
    expect(page.rows).toHaveLength(6);
    expect(page.rows[0]!.kind).toBe('coverage');
    expect(page.rows[0]!.caseId).toBeNull();
    expect(page.rows[1]!.kind).toBe('case');
    expect(page.rows[1]!.caseId).toBe('case-alpha');
    const listingControl = historyDriver(healthy, 6);
    const listing = await createEvidenceAuthorityRead(listingControl.driver, { ...SCOPE }).listCases();
    expect(listing.coverageState).toBe('open');
    expect(listing.cases).toEqual({ 'case-alpha': 'resolved', 'case-beta': 'rejected' });
  });

  it('refuses type confusion on sequence, recorded_at, and scope fields (K15-iv, BC-1 TS half)', async () => {
    for (const sequence of ['5', 1.5, null, 0, -1]) {
      const events = baseHistory();
      events[1] = { ...events[1]!, sequence };
      await expectMismatchOnBothSurfaces(events);
    }
    const mismatchedSequence = baseHistory().map(rowFor);
    mismatchedSequence[1] = {
      event: baseHistory()[1]!,
      outbox: { ...fakeOutbox(baseHistory()[1]!), sequence: 9 },
    };
    await expectCode(
      createEvidenceAuthorityRead(rowsDriver(mismatchedSequence).driver, { ...SCOPE }).pullOutbox({ afterSequence: 0 }),
      'existing_state_mismatch',
    );

    for (const recordedAt of ['not-a-date', '', 42, null]) {
      const events = baseHistory();
      events[2] = { ...events[2]!, recorded_at: recordedAt };
      await expectMismatchOnBothSurfaces(events);
    }
    const mismatchedRecordedAt = baseHistory().map(rowFor);
    mismatchedRecordedAt[2] = {
      event: baseHistory()[2]!,
      outbox: { ...fakeOutbox(baseHistory()[2]!), recorded_at: '2026-08-18T13:00:00.000Z' },
    };
    await expectCode(
      createEvidenceAuthorityRead(rowsDriver(mismatchedRecordedAt).driver, { ...SCOPE }).pullOutbox({ afterSequence: 0 }),
      'existing_state_mismatch',
    );

    for (const tamper of [
      { tenant_id: 'tenant-other' },
      { project_scope: 'project:other' },
      { semantic_id: 'semantic-other' },
    ]) {
      const events = baseHistory();
      events[3] = { ...events[3]!, ...tamper };
      await expectMismatchOnBothSurfaces(events);
      const rows = baseHistory().map(rowFor);
      rows[3] = { event: baseHistory()[3]!, outbox: { ...fakeOutbox(baseHistory()[3]!), ...tamper } };
      await expectCode(
        createEvidenceAuthorityRead(rowsDriver(rows).driver, { ...SCOPE }).pullOutbox({ afterSequence: 0 }),
        'existing_state_mismatch',
      );
    }
  });

  it('refuses a non-ascending or duplicated page despite ORDER BY (K16)', async () => {
    const [first, second] = baseHistory();
    const descending = rowsDriver([rowFor(second!), rowFor(first!)]);
    await expectCode(
      createEvidenceAuthorityRead(descending.driver, { ...SCOPE }).pullOutbox({ afterSequence: 0 }),
      'existing_state_mismatch',
    );
    const duplicateSequence = fakeEvent({
      sequence: 1, kind: 'case', action: 'case_opened', state: 'pending', caseId: 'case-dup', operationId: 'op-dup',
    });
    const duplicated = rowsDriver([rowFor(first!), rowFor(duplicateSequence)]);
    await expectCode(
      createEvidenceAuthorityRead(duplicated.driver, { ...SCOPE }).pullOutbox({ afterSequence: 0 }),
      'existing_state_mismatch',
    );
    // Listing: duplicated sequences destroy latest-state determinism.
    const listingDuplicate = historyDriver([baseHistory()[0]!, baseHistory()[1]!, duplicateSequence]);
    await expectCode(
      createEvidenceAuthorityRead(listingDuplicate.driver, { ...SCOPE }).listCases(),
      'existing_state_mismatch',
    );
    // A cursor-straddling row (sequence <= afterSequence) is refused, not skipped.
    const straddling = rowsDriver([rowFor(first!), rowFor(second!)]);
    await expectCode(
      createEvidenceAuthorityRead(straddling.driver, { ...SCOPE }).pullOutbox({ afterSequence: 1 }),
      'existing_state_mismatch',
    );
  });

  it('opens exactly one READ-mode session and one executeRead per call, both statements in one transaction, session closed once (K17, BC-7)', async () => {
    const listFake = makeDriver({ events: baseHistory(), version: 6 });
    await createEvidenceAuthorityRead(listFake.driver, { ...SCOPE }).listCases();
    expect(listFake.session).toHaveBeenCalledTimes(1);
    expect(listFake.sessionOptions).toEqual([{ defaultAccessMode: neo4j.session.READ }]);
    expect(listFake.executeRead).toHaveBeenCalledTimes(1);
    expect(listFake.executeWrite).not.toHaveBeenCalled();
    expect(listFake.run).toHaveBeenCalledTimes(2);
    expect(listFake.close).toHaveBeenCalledTimes(1);

    const pullFake = makeDriver({ rows: baseHistory().map(rowFor), version: 6 });
    await createEvidenceAuthorityRead(pullFake.driver, { ...SCOPE }).pullOutbox({ afterSequence: 0 });
    expect(pullFake.session).toHaveBeenCalledTimes(1);
    expect(pullFake.sessionOptions).toEqual([{ defaultAccessMode: neo4j.session.READ }]);
    expect(pullFake.executeRead).toHaveBeenCalledTimes(1);
    expect(pullFake.executeWrite).not.toHaveBeenCalled();
    expect(pullFake.run).toHaveBeenCalledTimes(2);
    expect(pullFake.close).toHaveBeenCalledTimes(1);

    // Refusal path still closes the session exactly once.
    const tampered = baseHistory();
    tampered[0] = { ...tampered[0]!, case_id: 'case-alpha' };
    const refusal = historyDriver(tampered);
    await expectCode(
      createEvidenceAuthorityRead(refusal.driver, { ...SCOPE }).listCases(),
      'existing_state_mismatch',
    );
    expect(refusal.session).toHaveBeenCalledTimes(1);
    expect(refusal.close).toHaveBeenCalledTimes(1);
  });

  it('refuses a torn read: any observed sequence above the version snapshot (K18)', async () => {
    const tornListing = makeDriver({
      events: [fakeEvent({ sequence: 2, kind: 'coverage', action: 'opened', state: 'open', caseId: '', operationId: 'op-cov-open' })],
      version: 1,
    });
    await expectCode(
      createEvidenceAuthorityRead(tornListing.driver, { ...SCOPE }).listCases(),
      'existing_state_mismatch',
    );
    const tornPull = makeDriver({
      rows: [rowFor(fakeEvent({ sequence: 2, kind: 'coverage', action: 'opened', state: 'open', caseId: '', operationId: 'op-cov-open' }))],
      version: 1,
    });
    await expectCode(
      createEvidenceAuthorityRead(tornPull.driver, { ...SCOPE }).pullOutbox({ afterSequence: 0 }),
      'existing_state_mismatch',
    );
  });

  it('raises only the four bound codes; storage_unavailable is the sole transient and never replaces a domain refusal (K19)', async () => {
    const observedCodes: string[] = [];
    const collect = async (promise: Promise<unknown>) => {
      try { await promise; } catch (caught) {
        expect(caught).toBeInstanceOf(EvidenceAuthorityLedgerError);
        observedCodes.push((caught as EvidenceAuthorityLedgerError).code);
      }
    };
    const brokenScope = makeDriver({});
    try { createEvidenceAuthorityRead(brokenScope.driver, { bad: true }); } catch (caught) {
      observedCodes.push((caught as EvidenceAuthorityLedgerError).code);
    }
    const abused = makeDriver({});
    await collect(createEvidenceAuthorityRead(abused.driver, { ...SCOPE }).pullOutbox({ afterSequence: -1 }));
    const tampered = baseHistory();
    tampered[0] = { ...tampered[0]!, id: 'forged' };
    await collect(createEvidenceAuthorityRead(historyDriver(tampered).driver, { ...SCOPE }).listCases());

    const sessionThrows = makeDriver({ sessionThrows: new Error(SECRET_CANARY) });
    const sessionError = await expectCode(
      createEvidenceAuthorityRead(sessionThrows.driver, { ...SCOPE }).listCases(),
      'storage_unavailable',
    );
    expect(String(sessionError)).not.toContain(SECRET_CANARY);
    observedCodes.push('storage_unavailable');

    const readThrows = makeDriver({ executeReadThrows: new Error(SECRET_CANARY) });
    const readError = await expectCode(
      createEvidenceAuthorityRead(readThrows.driver, { ...SCOPE }).pullOutbox({ afterSequence: 0 }),
      'storage_unavailable',
    );
    expect(String(readError)).not.toContain(SECRET_CANARY);
    expect((readError as Error).stack ?? '').not.toContain(SECRET_CANARY);

    const closeThrows = makeDriver({ events: baseHistory(), version: 6, closeThrows: new Error(SECRET_CANARY) });
    const closeError = await expectCode(
      createEvidenceAuthorityRead(closeThrows.driver, { ...SCOPE }).listCases(),
      'storage_unavailable',
    );
    expect(String(closeError)).not.toContain(SECRET_CANARY);

    // A close failure never replaces the more specific domain failure.
    const tornAndClosing = makeDriver({
      events: [fakeEvent({ sequence: 2, kind: 'coverage', action: 'opened', state: 'open', caseId: '', operationId: 'op-cov-open' })],
      version: 1,
      closeThrows: new Error(SECRET_CANARY),
    });
    await expectCode(
      createEvidenceAuthorityRead(tornAndClosing.driver, { ...SCOPE }).listCases(),
      'existing_state_mismatch',
    );

    observedCodes.push('existing_state_mismatch');
    expect(observedCodes.length).toBeGreaterThanOrEqual(5);
    for (const code of observedCodes) {
      expect(['invalid_scope', 'invalid_command', 'existing_state_mismatch', 'storage_unavailable']).toContain(code);
    }
  });

  it('leaks no construction, request, or driver value through any thrown message or stack (K20)', async () => {
    // Every canary is structurally invalid (embedded spaces) before charset
    // could matter, per the Decision 111 R1 lesson.
    let scopeError: unknown;
    try {
      createEvidenceAuthorityRead(makeDriver({}).driver, { ...SCOPE, tenantId: `bad ${SECRET_CANARY}` });
    } catch (caught) { scopeError = caught; }
    expect(String(scopeError)).toBe('EvidenceAuthorityLedgerError: evidence_authority_ledger:invalid_scope');
    expect((scopeError as Error).stack ?? '').not.toContain(SECRET_CANARY);

    const requestError = await expectCode(
      createEvidenceAuthorityRead(makeDriver({}).driver, { ...SCOPE }).pullOutbox({ afterSequence: `bad ${SECRET_CANARY}` }),
      'invalid_command',
    );
    expect((requestError as Error).stack ?? '').not.toContain(SECRET_CANARY);

    const poisoned = baseHistory();
    poisoned[1] = { ...poisoned[1]!, operation_id: `bad ${SECRET_CANARY}` };
    const driverError = await expectCode(
      createEvidenceAuthorityRead(historyDriver(poisoned).driver, { ...SCOPE }).listCases(),
      'existing_state_mismatch',
    );
    expect(String(driverError)).not.toContain(SECRET_CANARY);
    expect((driverError as Error).stack ?? '').not.toContain(SECRET_CANARY);
  });

  it('trips the B3B2 deferral wire: no delivery, checkpoint, or clearance verb in the read module (K21)', () => {
    expect(moduleSource).not.toMatch(/createSink|deliverTo|pushOutbox|pushTo|saveCheckpoint|checkpointCursor/i);
    expect(moduleSource).not.toMatch(/markClear|mintClear|setClear|deriveClearance|emitClearance/);
  });

  it('anchors and scopes every statement observed at the driver, with a recomputed $ledgerId; the helper bites (K27, BC-1 Cypher half)', async () => {
    const listFake = makeDriver({ events: baseHistory(), version: 6 });
    await createEvidenceAuthorityRead(listFake.driver, { ...SCOPE }).listCases();
    const pullFake = makeDriver({ rows: baseHistory().map(rowFor), version: 6 });
    await createEvidenceAuthorityRead(pullFake.driver, { ...SCOPE }).pullOutbox({ afterSequence: 0, limit: 10 });

    const versionText = listFake.calls[0]![0];
    const listingText = listFake.calls[1]![0];
    const pullText = pullFake.calls[1]![0];
    expect(versionText).toContain('evidence-authority:read-version');
    expect(listingText).toContain('evidence-authority:read-listing');
    expect(pullText).toContain('evidence-authority:read-pull');
    expect(scopePredicateFailures(versionText, false)).toEqual([]);
    expect(scopePredicateFailures(listingText, true)).toEqual([]);
    expect(scopePredicateFailures(pullText, true)).toEqual([]);

    for (const [, params] of [...listFake.calls, ...pullFake.calls]) {
      expect(params.ledgerId).toBe(testDigest('ledger', SCOPE.tenantId, SCOPE.projectScope, SCOPE.semanticId));
      expect(params.tenantId).toBe(SCOPE.tenantId);
      expect(params.projectScope).toBe(SCOPE.projectScope);
      expect(params.semanticId).toBe(SCOPE.semanticId);
    }

    // Negative arm: the helper must FAIL on weakened copies of each statement.
    for (const [text, eventLeg] of [
      [versionText, false],
      [listingText, true],
      [pullText, true],
    ] as const) {
      expect(scopePredicateFailures(text.replace('(ledger:EvidenceAuthorityLedger {id: $ledgerId})', '(ledger:EvidenceAuthorityLedger)'), eventLeg)).not.toEqual([]);
      expect(scopePredicateFailures(text.replace('ledger.tenant_id = $tenantId', 'true'), eventLeg)).not.toEqual([]);
      if (eventLeg) {
        expect(scopePredicateFailures(text.replace('event.semantic_id = $semanticId', 'true'), eventLeg)).not.toEqual([]);
      }
    }
  });

  it('embeds the verbatim ASCII honest-claim register in the module doc comment (K28)', () => {
    expect(moduleSource.startsWith('/**')).toBe(true);
    const end = moduleSource.indexOf('*/');
    expect(end).toBeGreaterThan(0);
    const comment = moduleSource.slice(0, end + 2);
    expect(comment).toMatch(/^[\x20-\x7E\n]*$/);
    const stripped = comment
      .replace(/^\/\*\*/, '')
      .replace(/\*\/$/, '')
      .split('\n')
      .map((line) => line.replace(/^[ \t]*\*[ \t]?/, ''))
      .join('\n');
    expect(stripped).toContain(REGISTER);
    expect(moduleSource).not.toMatch(/non-repudiation/i);
  });
});
