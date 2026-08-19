import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import neo4j, { type Driver } from 'neo4j-driver';
import { describe, expect, it, vi } from 'vitest';

import { EvidenceAuthorityLedgerError } from '../evidence-authority-ledger.js';
import {
  EVIDENCE_AUTHORITY_CLEARANCE_VERSION,
  createEvidenceAuthorityClearance,
  type EvidenceAuthorityClearanceResultV1,
} from '../evidence-authority-clearance.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const MODULE_PATH = resolve(REPO_ROOT, 'packages/neo4j/src/evidence-authority-clearance.ts');
const CAPTURE_PATH = resolve(REPO_ROOT, 'packages/neo4j/src/evidence-authority-capture.ts');
const LEDGER_PATH = resolve(REPO_ROOT, 'packages/neo4j/src/evidence-authority-ledger.ts');
const READ_PATH = resolve(REPO_ROOT, 'packages/neo4j/src/evidence-authority-read.ts');
const RECORDED_AT = '2026-08-18T12:00:00.000Z';
const AFTER_RECORDED_AT = '2026-08-18T12:00:01.000Z';
const SECRET_CANARY = ['sk', 'clearance', 'must not leak 1234567890'].join(' ');
const SCOPE = Object.freeze({
  tenantId: 'tenant-acme',
  projectScope: 'project:memberry',
  semanticId: 'semantic-clearance-001',
});

const moduleSource = readFileSync(MODULE_PATH, 'utf8');
const captureSource = readFileSync(CAPTURE_PATH, 'utf8');
const ledgerSource = readFileSync(LEDGER_PATH, 'utf8');
const readSource = readFileSync(READ_PATH, 'utf8');

// Test-local hand copies of the two digest chains (pinned to source below);
// never imported from the module under test.
const TEST_LEDGER_ID_DOMAIN = 'memberry-evidence-authority-ledger-v1';
const TEST_CAPTURE_ID_DOMAIN = 'memberry-evidence-authority-capture-v1';
function testLedgerDigest(kind: string, ...values: string[]): string {
  const input = JSON.stringify([TEST_LEDGER_ID_DOMAIN, kind, ...values]);
  return `evidence-authority:${kind}:sha256:${createHash('sha256').update(input).digest('hex')}`;
}
function testCaseId(sourceEpisodeId: string, signalKind: string): string {
  const input = JSON.stringify([
    TEST_CAPTURE_ID_DOMAIN, 'case',
    SCOPE.tenantId, SCOPE.projectScope, SCOPE.semanticId,
    sourceEpisodeId, signalKind,
  ]);
  return `capture-case-${createHash('sha256').update(input).digest('hex')}`;
}
// Transposed-argument control: signalKind before sourceEpisodeId. Must differ.
function transposedCaseId(sourceEpisodeId: string, signalKind: string): string {
  const input = JSON.stringify([
    TEST_CAPTURE_ID_DOMAIN, 'case',
    SCOPE.tenantId, SCOPE.projectScope, SCOPE.semanticId,
    signalKind, sourceEpisodeId,
  ]);
  return `capture-case-${createHash('sha256').update(input).digest('hex')}`;
}
const LEDGER_ID = testLedgerDigest('ledger', SCOPE.tenantId, SCOPE.projectScope, SCOPE.semanticId);

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
  recordedAt?: string;
}): Props {
  return {
    id: testLedgerDigest('event', SCOPE.tenantId, SCOPE.projectScope, SCOPE.semanticId, input.operationId),
    tenant_id: SCOPE.tenantId,
    project_scope: SCOPE.projectScope,
    semantic_id: SCOPE.semanticId,
    case_id: input.caseId,
    operation_id: input.operationId,
    kind: input.kind,
    action: input.action,
    state: input.state,
    sequence: input.sequence,
    recorded_at: input.recordedAt ?? RECORDED_AT,
  };
}

function fakeOutbox(event: Props): Props {
  return {
    id: testLedgerDigest('outbox', String(event.id)),
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

interface Fixture {
  versions?: number[];
  events?: unknown[];
  rows?: unknown[];
  edgeRecords?: unknown[];
  listingThrows?: unknown;
  pullThrows?: unknown;
  edgeThrows?: unknown;
  sessionThrows?: unknown;
  closeThrowsOnSession?: number;
}

/**
 * Fake driver satisfying the real reader's statements plus the clearance edge
 * statement (admission-observation executeRead-fake shape). Fixture state is
 * mutable between calls so the no-cache proof can change the ledger mid-test.
 */
function makeDriver(fixture: Fixture = {}) {
  const state = { ...fixture };
  const calls: Array<[string, Props]> = [];
  let versionCall = 0;
  let sessionCount = 0;
  const sessionConfigs: unknown[] = [];
  const run = vi.fn(async (query: string, params: Props = {}) => {
    calls.push([query, params]);
    if (query.includes('evidence-authority:read-version')) {
      const versions = state.versions ?? [0];
      const version = versions[Math.min(versionCall, versions.length - 1)]!;
      versionCall += 1;
      return { records: [record({ version })] };
    }
    if (query.includes('evidence-authority:read-listing')) {
      if (state.listingThrows !== undefined) throw state.listingThrows;
      return { records: [record({ events: state.events ?? [] })] };
    }
    if (query.includes('evidence-authority:read-pull')) {
      if (state.pullThrows !== undefined) throw state.pullThrows;
      return { records: [record({ rows: state.rows ?? [] })] };
    }
    if (query.includes('evidence-authority:clearance-raw-edges')) {
      if (state.edgeThrows !== undefined) throw state.edgeThrows;
      return { records: state.edgeRecords ?? [] };
    }
    throw new Error(`unexpected query: ${query}`);
  });
  const executeWrite = vi.fn(async () => {
    throw new Error('executeWrite must never be reachable from the clearance surface');
  });
  const session = vi.fn((config?: unknown) => {
    if (state.sessionThrows !== undefined) throw state.sessionThrows;
    sessionCount += 1;
    const ordinal = sessionCount;
    sessionConfigs.push(config);
    const executeRead = vi.fn(async <T>(work: (tx: { run: typeof run }) => Promise<T>) => work({ run }));
    const close = vi.fn(async () => {
      if (state.closeThrowsOnSession === ordinal) throw new Error(SECRET_CANARY);
    });
    return { executeRead, executeWrite, close };
  });
  const driver = { session } as unknown as Driver;
  return { driver, run, calls, session, sessionConfigs, executeWrite, state };
}

/** Healthy clear fixture: coverage open, one rejected case, one matching edge. */
const CLEAR_SOURCE_ID = 'episode-clear-1';
const CLEAR_CASE_ID = testCaseId(CLEAR_SOURCE_ID, 'contradiction');

function clearEvents(caseId = CLEAR_CASE_ID): Props[] {
  return [
    fakeEvent({ sequence: 1, kind: 'coverage', action: 'opened', state: 'open', caseId: '', operationId: 'op-cov-open' }),
    fakeEvent({ sequence: 2, kind: 'case', action: 'case_opened', state: 'pending', caseId, operationId: 'op-case-open' }),
    fakeEvent({ sequence: 3, kind: 'case', action: 'rejected', state: 'rejected', caseId, operationId: 'op-case-reject' }),
  ];
}

function clearEdge(overrides: Props = {}): Props {
  return { type: 'CONTRADICTS', validAt: AFTER_RECORDED_AT, sourceId: CLEAR_SOURCE_ID, ...overrides };
}

function edgeRecord(rawCount: unknown, edges: unknown): unknown {
  return record({ rawCount, edges });
}

function clearFixture(overrides: Partial<Fixture> = {}): Fixture {
  return {
    versions: [3, 3],
    events: clearEvents(),
    rows: [rowFor(clearEvents()[0]!)],
    edgeRecords: [edgeRecord(neo4j.int(1), [clearEdge()])],
    ...overrides,
  };
}

/** Zero-edge clear fixture: the ordinary healthy shape (E1.4 (14b)). */
function zeroEdgeClearFixture(overrides: Partial<Fixture> = {}): Fixture {
  return clearFixture({ edgeRecords: [edgeRecord(neo4j.int(0), [])], ...overrides });
}

function clearance(fixture: Fixture = clearFixture()) {
  const fake = makeDriver(fixture);
  const surface = createEvidenceAuthorityClearance(fake.driver, { ...SCOPE });
  return { fake, surface };
}

async function derive(fixture: Fixture): Promise<EvidenceAuthorityClearanceResultV1> {
  return clearance(fixture).surface.deriveClearance({ mode: 'current' });
}

function expectUnsupported(result: EvidenceAuthorityClearanceResultV1, code: string): void {
  expect(Reflect.ownKeys(result)).toEqual(['contractVersion', 'outcome', 'code']);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.getPrototypeOf(result)).toBeNull();
  expect({ ...result }).toEqual({
    contractVersion: EVIDENCE_AUTHORITY_CLEARANCE_VERSION,
    outcome: 'unsupported',
    code,
  });
}

function expectClear(result: EvidenceAuthorityClearanceResultV1, observedVersion: number): void {
  expect(Reflect.ownKeys(result)).toEqual(['contractVersion', 'outcome', 'observedVersion']);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.getPrototypeOf(result)).toBeNull();
  expect({ ...result }).toEqual({
    contractVersion: EVIDENCE_AUTHORITY_CLEARANCE_VERSION,
    outcome: 'clear',
    observedVersion,
  });
}

async function expectThrown(promise: Promise<unknown>, code: string): Promise<unknown> {
  let error: unknown;
  let resolved = false;
  try { await promise; resolved = true; } catch (caught) { error = caught; }
  expect(resolved).toBe(false);
  expect(error).toBeInstanceOf(EvidenceAuthorityLedgerError);
  expect(error).toMatchObject({ code });
  expect(String(error)).toBe(`EvidenceAuthorityLedgerError: evidence_authority_ledger:${code}`);
  return error;
}

function importSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(/from '([^']+)'/g),
    ...source.matchAll(/import '([^']+)'/g),
    ...source.matchAll(/import\('([^']+)'\)/g),
    ...source.matchAll(/require\('([^']+)'\)/g),
  ].map((match) => match[1]!);
}

// (J)(15) helper: anchor + scope predicates of the edge statement as observed
// at the driver. The negative arm below proves the helper bites.
function clearanceQueryFailures(text: string): string[] {
  const failures: string[] = [];
  if (!text.includes('(semantic:Semantic {id: $semanticId})')) failures.push('anchor');
  for (const predicate of ['semantic.tenant_id = $tenantId', 'semantic.scope = $projectScope']) {
    if (!text.includes(predicate)) failures.push(predicate);
  }
  if (!text.includes('[raw:CONTRADICTS|CORRECTS]')) failures.push('edge-types');
  if (!text.includes(']-(source)')) failures.push('untyped-source');
  if (/\bLIMIT\b/.test(text)) failures.push('row-limiting-clause');
  return failures;
}

// Test-local copy of the bound (D) flow over already-observed frames, used
// only by the (J)(12) guard-ordering mutation arms. Each mutation removes or
// moves exactly one guard and must CHANGE the outcome.
interface Frames {
  listing: { coverageState: string; cases: Record<string, string>; truncated: boolean; observedVersion: number };
  page: { rows: Array<{ sequence: number; kind: string; action: string; state: string; caseId: string | null; recordedAt: string }>; observedVersion: number };
  rawCount: number;
  edges: Array<{ type: string; validAt: string; sourceId: string }>;
}
function localFlow(frames: Frames, mutation?: 'drop-R2' | 'move-R4-after-join' | 'drop-R13'): string {
  const { listing, page, rawCount, edges } = frames;
  if (mutation !== 'drop-R2' && listing.truncated) return 'clearance-coverage-gap';
  if (listing.coverageState === 'none') return 'clearance-coverage-gap';
  if (mutation !== 'move-R4-after-join' && listing.coverageState === 'revoked') return 'clearance-coverage-gap';
  const caseIds = Object.keys(listing.cases);
  if (caseIds.length === 0) return 'clearance-coverage-gap';
  for (const caseId of caseIds) {
    const state = listing.cases[caseId];
    if (state !== 'rejected' && state !== 'resolved') return 'clearance-adjudication-pending';
  }
  const opened = page.rows.length === 1 ? page.rows[0] : undefined;
  if (opened === undefined || opened.sequence !== 1 || opened.kind !== 'coverage'
    || opened.action !== 'opened' || opened.state !== 'open' || opened.caseId !== null
    || page.observedVersion !== listing.observedVersion) return 'clearance-record-time-unavailable';
  const coverageInstant = Date.parse(opened.recordedAt);
  if (rawCount > 200) return 'clearance-coverage-gap';
  if (edges.length !== rawCount) return 'clearance-source-unavailable';
  for (const edge of edges) {
    if (edge.type !== 'CONTRADICTS' && edge.type !== 'CORRECTS') return 'clearance-source-unavailable';
  }
  for (const edge of edges) {
    if (mutation !== 'drop-R13' && Date.parse(edge.validAt) < coverageInstant) return 'clearance-coverage-gap';
  }
  for (const edge of edges) {
    const kind = edge.type === 'CONTRADICTS' ? 'contradiction' : 'correction';
    if (!Object.hasOwn(listing.cases, testCaseId(edge.sourceId, kind))) return 'clearance-coverage-gap';
  }
  return 'clear';
}

// §B4-REGISTER verbatim bytes (Decision 116 (I)); asserted byte-for-byte
// inside the module doc comment. Injected below by the maker from the
// decision record; any reflow fails the (J)(26) pin.
const REGISTER = `This module derives one module-local verdict on one axis: whether a single Semantic's adjudicated contradiction state is clear in the current frame, under Decision 104 (B-ii). It is not authentication and it is not authorization: it verifies no human, actor, role, or permission, and it performs no access check of any kind. It confers no containment whatsoever. Its derivation is authoritative for exactly two reasons, neither of which is access control: it is the only code in this package that joins the raw contradiction and correction edges against durable case state, so the obligation set and the satisfaction set are compared in one place; and it is the only code that carries the bound total mapping, in which every input shape that is not a proven clear falls to a fixed value-free unsupported code. A caller holding the same driver can read the same rows; what this module owns is correctness, not reach.

The audited listing alone is necessary but not sufficient. That listing shows the satisfaction set - the cases that exist - and never the obligation set. The obligation set lives on the raw edges, and a caller who derives clearance from the listing alone is structurally incapable of correctness, which is why the listing's own text forbids treating it as a clearance input. This module consumes the listing, the coverage-opened record time, and the raw edge join together, and fails closed on truncation.

Current frame means one ledger version and one edge snapshot, read in three separate transactions, and it is stale the moment it is returned. The ledger listing and the record-time page are bound to each other by an observed-version equality check, and the edge read is not bound to either: a revocation or a new case that lands between them is not visible, so a clear verdict is a statement about a frame that has already passed. This is a disclosed, uncloseable property at this layer, not a defect; a consumer that memoizes a clear verdict makes it permanent and is wrong to do so. Nothing here may be cached, and this module remembers nothing between calls.

The two timestamps compared here come from two different clocks. Coverage record time is the graph server's clock, written inside the ledger transaction; edge valid time is the application process's clock, written by the signal producer. Skew between them can make a healthy capture look like it predates its own coverage, and that comparison fails closed to unsupported, permanently, until the producer is fixed. A missing or non-canonical edge valid time is unsupported and is never defaulted toward clear.

Every refusal is unconditional and value-free. Absent coverage, revoked coverage, an unreadable record time, a truncated listing, an open or in-progress case anywhere on the Semantic, an edge that predates coverage, an edge whose source cannot be identified, and an edge that matches no durable case all produce a fixed code carrying no tenant, project, Semantic, case, source, sequence, or time value. Clearance is never inferred from the absence of cases, and coverage carrying zero cases is not clear. An as-of request is refused before any driver call is made; this module has no historical authority of any kind.

This module emits no cross-package result and imports nothing from the contract package. Its five unsupported codes are its own, and mapping them onto the published authority contract belongs to a later composition packet, which must also supply the lifecycle, temporal, and supersession axes this module cannot know. That composition may never present a refusal of this module as a receipt: the contract's parser rejects a semantic receipt whose contradiction axis is anything but clear, so a refusal must travel as an unsupported code or not at all.

This module writes nothing, mints nothing, takes no lock, holds no cursor, computes no ledger identifier, and accepts no scope per call. Its only containment is that the tenant, project, and Semantic triple is bound at construction and that the module is absent from the package root export.`;

describe('EvidenceAuthorityClearance V1 (RET-005B-AUTH-001B4)', () => {
  it('freezes the version constant and both caps by name and value (J1)', () => {
    expect(EVIDENCE_AUTHORITY_CLEARANCE_VERSION).toBe('memberry.evidence-authority-clearance/1.0.0');
    expect(moduleSource).toContain('const MAX_JOINED_RAW_EDGES = 200;');
    expect(moduleSource).toContain('const MAX_INPUT_LENGTH = 500;');
  });

  it('stays off the package root export entirely (J2)', () => {
    const rootExports = readFileSync(resolve(REPO_ROOT, 'packages/neo4j/src/index.ts'), 'utf8');
    expect(rootExports).not.toContain('evidence-authority-clearance');
    expect(rootExports).not.toContain('createEvidenceAuthorityClearance');
    expect(rootExports).not.toContain('EVIDENCE_AUTHORITY_CLEARANCE_VERSION');
  });

  it('passes every (H) source ban individually, including the four new bans and both errata bans (J3)', () => {
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
    expect(moduleSource).not.toMatch(/withheld/);
    expect(moduleSource).not.toMatch(/MEMBERRY_EVIDENCE_POST_FILTER|process\.env/);
    expect(moduleSource).not.toMatch(/ledgerId/);
    expect(moduleSource).not.toMatch(/\bLIMIT\b/);
    expect(moduleSource).not.toMatch(/@memberry\/core|packages\/core/);
    expect(moduleSource).not.toMatch(/\backRow|acknowledge|nack\(|markDelivered|deadLetter|redeliver|inflight/i);
    expect(moduleSource).not.toMatch(/createSink|deliverTo|pushOutbox|pushTo|saveCheckpoint|checkpointCursor/i);
    expect(moduleSource).not.toMatch(/authenticated|non-repudiation|verified reviewer/i);
    expect(moduleSource).not.toMatch(/Redis|ProposalStore|Consolidation|Retrieval|MCP/);
    expect(moduleSource).not.toMatch(/console\./);
    expect(moduleSource).not.toMatch(/new Date\(|Date\.now\(/);
    expect(moduleSource).not.toMatch(/EvidenceAuthorityCoverage/);
    expect(moduleSource).not.toMatch(/\bdetail\b/i);
  });

  it('holds the structural regime: const-only module scope, frozen aggregates, no Map/Set, no node:fs (J4)', async () => {
    expect(moduleSource).not.toMatch(/^(let|var)\s/m);
    expect(moduleSource).not.toMatch(/new (Map|Set)\b/);
    expect(moduleSource).not.toContain('node:fs');
    for (const name of [
      'SCOPE_KEYS', 'REQUEST_KEYS', 'LEDGER_ERROR_CODES', 'TERMINAL_SOURCE_CODES',
      'TERMINAL_CASE_STATES',
    ]) {
      expect(moduleSource).toMatch(new RegExp(`const ${name}[^=]*= Object\\.freeze\\(`));
    }
    for (const name of [
      'SIGNAL_KINDS', 'SOURCE_UNAVAILABLE', 'FRAME_UNSUPPORTED', 'ADJUDICATION_PENDING',
      'COVERAGE_GAP', 'RECORD_TIME_UNAVAILABLE',
    ]) {
      expect(moduleSource).toMatch(new RegExp(
        `const ${name}[^=]*= Object\\.freeze\\(\\s*Object\\.assign\\(Object\\.create\\(null\\)`,
      ));
    }
    // Runtime half on reachable values: both result shapes frozen, null-proto.
    expectUnsupported(await derive({ ...clearFixture(), events: clearEvents(), versions: [3, 3], rows: [] }), 'clearance-record-time-unavailable');
    expectClear(await derive(clearFixture()), 3);
  });

  it('imports exactly the bound allowlist, nothing from packages/core, no persistence or facet factory (J5)', () => {
    const moduleImports = importSpecifiers(moduleSource);
    expect([...moduleImports].sort()).toEqual([
      './evidence-authority-ledger.js',
      './evidence-authority-read.js',
      'neo4j-driver',
      'node:crypto',
      'node:util/types',
    ]);
    for (const specifier of moduleImports) {
      expect(specifier).not.toMatch(/@memberry\/core|packages\/core/);
    }
    for (const specifier of [...moduleImports, ...importSpecifiers(ledgerSource), ...importSpecifiers(readSource)]) {
      expect(specifier).not.toMatch(/redis|cache|queue|stream|bull|kafka/i);
    }
    expect(moduleSource).not.toContain('createEvidenceAuthorityLedgerPersistence');
    expect(moduleSource).not.toContain('createEvidenceAuthorityCaptureFacet');
    expect(moduleSource).not.toContain('createEvidenceAuthorityReviewFacet');
  });

  it('pins every hand copy to its source file (J6, E3.3, E12.2)', () => {
    // Capture-side pins.
    const captureDomain = captureSource.match(/const CAPTURE_ID_DOMAIN = '([^']+)';/);
    const moduleDomain = moduleSource.match(/const CAPTURE_ID_DOMAIN = '([^']+)';/);
    expect(moduleDomain?.[1]).toBe(captureDomain?.[1]);
    expect(moduleDomain?.[1]).toBe(TEST_CAPTURE_ID_DOMAIN);
    expect(moduleSource).toContain('`capture-case-${');
    expect(captureSource).toContain('caseId: `capture-case-${captureDigest(');

    // Digest argument list AND order: sourceEpisodeId strictly before
    // signalKind in both files (spot-check (d) of Decision 116).
    const captureArgs = captureSource.match(/JSON\.stringify\(\[\s*CAPTURE_ID_DOMAIN,([\s\S]*?)\]\)/);
    expect(captureArgs).not.toBeNull();
    const captureOrder = [...captureArgs![1]!.matchAll(/request\.(\w+)/g)].map((entry) => entry[1]!);
    expect(captureOrder).toEqual(['tenantId', 'projectScope', 'semanticId', 'sourceEpisodeId', 'signalKind']);
    const moduleArgs = moduleSource.match(/JSON\.stringify\(\[\s*CAPTURE_ID_DOMAIN,\s*'case',([\s\S]*?)\]\)/);
    expect(moduleArgs).not.toBeNull();
    const moduleOrder = [...moduleArgs![1]!.matchAll(/\b(tenantId|projectScope|semanticId|sourceEpisodeId|signalKind)\b/g)]
      .map((entry) => entry[1]!);
    expect(moduleOrder).toEqual(['tenantId', 'projectScope', 'semanticId', 'sourceEpisodeId', 'signalKind']);
    expect(moduleOrder.indexOf('sourceEpisodeId')).toBeLessThan(moduleOrder.indexOf('signalKind'));

    for (const name of ['IDENTIFIER', 'PROJECT_SCOPE', 'SOURCE_EPISODE_ID'] as const) {
      const fromCapture = captureSource.match(new RegExp(`const ${name} = (/.+/);`));
      const fromModule = moduleSource.match(new RegExp(`const ${name} = (/.+/);`));
      expect(fromCapture).not.toBeNull();
      expect(fromModule?.[1]).toBe(fromCapture?.[1]);
    }
    const captureMax = captureSource.match(/const MAX_INPUT_LENGTH = (\d+);/);
    const moduleMax = moduleSource.match(/const MAX_INPUT_LENGTH = (\d+);/);
    expect(moduleMax?.[1]).toBe(captureMax?.[1]);
    expect(moduleMax?.[1]).toBe('500');

    // LEDGER_ERROR_CODES: naming truth is the union type at ledger.ts,
    // cross-checked against the ERROR_CODES literal; container matches
    // read.ts's frozen array (E12).
    const moduleCodesMatch = moduleSource.match(/const LEDGER_ERROR_CODES[^=]*= Object\.freeze\(\[([\s\S]*?)\]/);
    expect(moduleCodesMatch).not.toBeNull();
    const moduleCodes = [...moduleCodesMatch![1]!.matchAll(/'([a-z_]+)'/g)].map((entry) => entry[1]!).sort();
    const unionMatch = ledgerSource.match(/export type EvidenceAuthorityLedgerErrorCode =([\s\S]*?);/);
    expect(unionMatch).not.toBeNull();
    const unionCodes = [...unionMatch![1]!.matchAll(/'([a-z_]+)'/g)].map((entry) => entry[1]!).sort();
    const setMatch = ledgerSource.match(/const ERROR_CODES = new Set<EvidenceAuthorityLedgerErrorCode>\(\[([\s\S]*?)\]\)/);
    expect(setMatch).not.toBeNull();
    const setCodes = [...setMatch![1]!.matchAll(/'([a-z_]+)'/g)].map((entry) => entry[1]!).sort();
    expect(unionCodes).toEqual(setCodes);
    expect(moduleCodes).toEqual(unionCodes);
    expect(moduleCodes).toHaveLength(13);
    expect(readSource).toContain('const LEDGER_ERROR_CODES: readonly EvidenceAuthorityLedgerErrorCode[] = Object.freeze([');

    // Canonical-instant predicate: identical regex and finite-parse floor in
    // module, ledger, and read sources; numeric comparison in the module.
    for (const source of [moduleSource, ledgerSource, readSource]) {
      expect(source).toContain('/^\\d{4}-\\d{2}-\\d{2}T/');
      expect(source).toContain('Number.isFinite(Date.parse(');
    }
    expect(moduleSource).toContain('Date.parse(');
    expect(moduleSource).not.toContain('validAt < ');
    expect(moduleSource).not.toContain("localeCompare");

    // Integer normalizer hand copy (E3.3): accepted-type set, isProxy guard,
    // and safe-integer floor byte-shared with read.ts integer().
    for (const line of [
      "if (typeof value === 'number') parsed = value;",
      "else if (typeof value === 'bigint') parsed = Number(value);",
      "else if (typeof value === 'object' && value !== null && !isProxy(value)",
      '&& neo4j.isInt(value)) {',
      'parsed = (value as { toNumber(): number }).toNumber();',
      '} else parsed = Number.NaN;',
    ]) {
      expect(moduleSource).toContain(line);
      expect(readSource).toContain(line);
    }
    expect(moduleSource).toContain('!Number.isSafeInteger(parsed) || parsed < 0');
    expect(readSource).toContain('!Number.isSafeInteger(parsed) || parsed < 0');

    // Cap pin: MAX_JOINED_RAW_EDGES can never silently diverge from
    // MAX_LISTED_CASES.
    const readCap = readSource.match(/const MAX_LISTED_CASES = (\d+);/);
    const moduleCap = moduleSource.match(/const MAX_JOINED_RAW_EDGES = (\d+);/);
    expect(moduleCap?.[1]).toBe(readCap?.[1]);
    expect(moduleCap?.[1]).toBe('200');
  });

  it('hardens construction: hostile scopes throw invalid_scope with zero driver calls and the surface is sealed (J7)', () => {
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
      Object.assign(Object.create({ semanticId: SCOPE.semanticId }), {
        tenantId: SCOPE.tenantId, projectScope: SCOPE.projectScope,
      }),
      { ...SCOPE, [Symbol('hostile')]: true },
      Object.defineProperty({ ...SCOPE }, 'tenantId', { get: () => SECRET_CANARY }),
      new Proxy({ ...SCOPE }, {}),
      new Proxy({ ...SCOPE }, { getOwnPropertyDescriptor: () => { throw new Error(SECRET_CANARY); } }),
      new String('scope'),
      { ...SCOPE, tenantId: new String(SCOPE.tenantId) },
      { ...SCOPE, tenantId: '' },
      { ...SCOPE, tenantId: `t${'x'.repeat(501)}` },
      { ...SCOPE, tenantId: `bad ${SECRET_CANARY}` },
      { ...SCOPE, tenantId: '.leading-dot' },
      { ...SCOPE, projectScope: 'memberry' },
      { ...SCOPE, projectScope: 'Project:memberry' },
      { ...SCOPE, projectScope: `project:${'x'.repeat(501)}` },
      { ...SCOPE, semanticId: '' },
      { ...SCOPE, semanticId: 42 },
      { ...SCOPE, __proto__: { polluted: true } },
      Object.defineProperty({ ...SCOPE }, 'constructor', { value: 'x', enumerable: true }),
      { ...SCOPE, prototype: 'x' },
    ];
    expect(hostileScopes.length).toBeGreaterThanOrEqual(20);
    const fake = makeDriver({ sessionThrows: new Error(SECRET_CANARY) });
    for (const scope of hostileScopes) {
      let error: unknown;
      try { createEvidenceAuthorityClearance(fake.driver, scope); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(EvidenceAuthorityLedgerError);
      expect(error).toMatchObject({ code: 'invalid_scope' });
      expect(String(error)).toBe('EvidenceAuthorityLedgerError: evidence_authority_ledger:invalid_scope');
      expect(String(error)).not.toContain(SECRET_CANARY);
      expect(((error as Error).stack ?? '')).not.toContain(SECRET_CANARY);
    }
    expect(fake.session).not.toHaveBeenCalled();

    const surface = createEvidenceAuthorityClearance(fake.driver, { ...SCOPE });
    expect(fake.session).not.toHaveBeenCalled();
    expect(Reflect.ownKeys(surface)).toEqual(['contractVersion', 'deriveClearance']);
    expect(Object.isFrozen(surface)).toBe(true);
    expect(Object.getPrototypeOf(surface)).toBeNull();
    expect(surface.contractVersion).toBe(EVIDENCE_AUTHORITY_CLEARANCE_VERSION);
    const serialized = JSON.stringify(surface);
    expect(serialized).toBe(`{"contractVersion":"${EVIDENCE_AUTHORITY_CLEARANCE_VERSION}"}`);
    expect(serialized).not.toContain(SCOPE.tenantId);
    expect(serialized).not.toContain('sha256');
  });

  it('refuses every abused request with invalid_command and zero session opens; both lawful modes behave (J8, R0)', async () => {
    const fake = makeDriver({ sessionThrows: new Error(SECRET_CANARY) });
    const surface = createEvidenceAuthorityClearance(fake.driver, { ...SCOPE });
    const abusedRequests: unknown[] = [
      {},
      { mode: 'current', extra: true },
      { mode: 'Current' },
      { mode: 'as_of' },
      { mode: 'asof' },
      { mode: null },
      { mode: undefined },
      { mode: new String('current') },
      { mode: ['current'] },
      { mode: `bad ${SECRET_CANARY}` },
      new Proxy({ mode: 'current' }, {}),
      ['current'],
      null,
      undefined,
      'current',
      42,
      Object.assign(Object.create({ mode: 'current' }), {}),
      Object.defineProperty({}, 'mode', { get: () => 'current', enumerable: true }),
      { mode: 'current', tenantId: SCOPE.tenantId },
      { mode: 'current', semanticId: SCOPE.semanticId },
      { mode: 'current', [Symbol('mode')]: 'current' },
    ];
    for (const request of abusedRequests) {
      const error = await expectThrown(surface.deriveClearance(request), 'invalid_command');
      expect(String(error)).not.toContain(SECRET_CANARY);
      expect(((error as Error).stack ?? '')).not.toContain(SECRET_CANARY);
    }
    // R0: an as-of request is a lawful request for an unsupported capability,
    // refused with zero session opens.
    expectUnsupported(await surface.deriveClearance({ mode: 'as-of' }), 'clearance-frame-unsupported');
    expect(fake.session).not.toHaveBeenCalled();

    // Positive: { mode: 'current' } proceeds to the driver.
    const healthy = clearance();
    expectClear(await healthy.surface.deriveClearance({ mode: 'current' }), 3);
    expect(healthy.fake.session).toHaveBeenCalledTimes(3);
  });

  it('recomputes the capture digest byte-exactly; a transposed argument order bites (J9)', async () => {
    // The clear fixture's case id IS the independently recomputed digest: a
    // module recomputing differently cannot reach clear on it.
    expectClear(await derive(clearFixture()), 3);
    // Transposition control: different bytes, and a ledger keyed by the
    // transposed id is refused at R15.
    expect(transposedCaseId(CLEAR_SOURCE_ID, 'contradiction')).not.toBe(CLEAR_CASE_ID);
    expectUnsupported(
      await derive(clearFixture({ events: clearEvents(transposedCaseId(CLEAR_SOURCE_ID, 'contradiction')) })),
      'clearance-coverage-gap',
    );
    // CORRECTS maps to 'correction' in the digest.
    const correctionCaseId = testCaseId('episode-correction-1', 'correction');
    expectClear(await derive(clearFixture({
      events: clearEvents(correctionCaseId),
      edgeRecords: [edgeRecord(neo4j.int(1), [clearEdge({ type: 'CORRECTS', sourceId: 'episode-correction-1' })])],
    })), 3);
  });

  it('walks all seventeen (D) rows, each with its bound code (J10)', async () => {
    // R0 (zero driver calls proven in J8/J13).
    const r0 = clearance(clearFixture());
    expectUnsupported(await r0.surface.deriveClearance({ mode: 'as-of' }), 'clearance-frame-unsupported');
    expect(r0.fake.session).not.toHaveBeenCalled();
    // R1: terminal listing failure.
    expectUnsupported(
      await derive(clearFixture({ listingThrows: new EvidenceAuthorityLedgerError('existing_state_mismatch') })),
      'clearance-source-unavailable',
    );
    // R2: truncated listing (201 distinct cases, all terminal).
    const manyEvents: Props[] = [clearEvents()[0]!];
    for (let index = 0; index < 201; index += 1) {
      const caseId = `case-${String(index).padStart(3, '0')}`;
      manyEvents.push(fakeEvent({
        sequence: 2 + index * 2, kind: 'case', action: 'case_opened', state: 'pending', caseId, operationId: `op-open-${caseId}`,
      }));
      manyEvents.push(fakeEvent({
        sequence: 3 + index * 2, kind: 'case', action: 'rejected', state: 'rejected', caseId, operationId: `op-reject-${caseId}`,
      }));
    }
    expectUnsupported(
      await derive(clearFixture({ events: manyEvents, versions: [404, 404] })),
      'clearance-coverage-gap',
    );
    // R3: no coverage.
    expectUnsupported(
      await derive(clearFixture({ events: [], versions: [0, 0] })),
      'clearance-coverage-gap',
    );
    // R4: revoked coverage with terminal cases.
    const revokedEvents = [
      ...clearEvents(),
      fakeEvent({ sequence: 4, kind: 'coverage', action: 'revoked', state: 'revoked', caseId: '', operationId: 'op-cov-revoke' }),
    ];
    expectUnsupported(
      await derive(clearFixture({ events: revokedEvents, versions: [4, 4] })),
      'clearance-coverage-gap',
    );
    // R5: open coverage, zero cases.
    expectUnsupported(
      await derive(clearFixture({ events: [clearEvents()[0]!], versions: [1, 1] })),
      'clearance-coverage-gap',
    );
    // R6: one pending case anywhere refuses.
    const pendingEvents = [
      ...clearEvents(),
      fakeEvent({ sequence: 4, kind: 'case', action: 'case_opened', state: 'pending', caseId: 'case-open-1', operationId: 'op-pending' }),
    ];
    expectUnsupported(
      await derive(clearFixture({ events: pendingEvents, versions: [4, 4] })),
      'clearance-adjudication-pending',
    );
    // R7: record time unobtainable (empty pull page).
    expectUnsupported(
      await derive(clearFixture({ rows: [] })),
      'clearance-record-time-unavailable',
    );
    // R8: zero and multiple edge records.
    expectUnsupported(await derive(clearFixture({ edgeRecords: [] })), 'clearance-source-unavailable');
    expectUnsupported(
      await derive(clearFixture({
        edgeRecords: [edgeRecord(neo4j.int(1), [clearEdge()]), edgeRecord(neo4j.int(1), [clearEdge()])],
      })),
      'clearance-source-unavailable',
    );
    // R9: over-cap count refuses as coverage gap.
    expectUnsupported(
      await derive(clearFixture({ edgeRecords: [edgeRecord(neo4j.int(201), [clearEdge()])] })),
      'clearance-coverage-gap',
    );
    // R10: record/count inconsistency.
    expectUnsupported(
      await derive(clearFixture({ edgeRecords: [edgeRecord(neo4j.int(2), [clearEdge()])] })),
      'clearance-source-unavailable',
    );
    // R11: bogus relationship type.
    expectUnsupported(
      await derive(clearFixture({ edgeRecords: [edgeRecord(neo4j.int(1), [clearEdge({ type: 'REINFORCES' })])] })),
      'clearance-source-unavailable',
    );
    // R12: non-canonical edge valid time.
    expectUnsupported(
      await derive(clearFixture({ edgeRecords: [edgeRecord(neo4j.int(1), [clearEdge({ validAt: 'not-a-date' })])] })),
      'clearance-record-time-unavailable',
    );
    // R13: pre-coverage edge.
    expectUnsupported(
      await derive(clearFixture({
        edgeRecords: [edgeRecord(neo4j.int(1), [clearEdge({ validAt: '2026-08-18T11:59:59.999Z' })])],
      })),
      'clearance-coverage-gap',
    );
    // R14: unidentifiable source.
    expectUnsupported(
      await derive(clearFixture({ edgeRecords: [edgeRecord(neo4j.int(1), [clearEdge({ sourceId: 'bad source' })])] })),
      'clearance-coverage-gap',
    );
    // R15: edge matching no durable case.
    expectUnsupported(
      await derive(clearFixture({ edgeRecords: [edgeRecord(neo4j.int(1), [clearEdge({ sourceId: 'episode-unmatched' })])] })),
      'clearance-coverage-gap',
    );
    // R16: every guard passed.
    expectClear(await derive(clearFixture()), 3);
  });

  it('keeps clear unreachable from truncated, none, revoked, and empty-case listings even when everything else is perfect (J11)', async () => {
    // Each fixture is a perfect clear except for exactly one refused input.
    const perfect = clearFixture();
    // truncated === true: 201 terminal cases including the matching one.
    const truncatedEvents: Props[] = [...clearEvents()];
    for (let index = 0; index < 200; index += 1) {
      const caseId = `case-extra-${String(index).padStart(3, '0')}`;
      truncatedEvents.push(fakeEvent({
        sequence: 4 + index * 2, kind: 'case', action: 'case_opened', state: 'pending', caseId, operationId: `op-open-${caseId}`,
      }));
      truncatedEvents.push(fakeEvent({
        sequence: 5 + index * 2, kind: 'case', action: 'rejected', state: 'rejected', caseId, operationId: `op-reject-${caseId}`,
      }));
    }
    expectUnsupported(
      await derive({ ...perfect, events: truncatedEvents, versions: [403, 403] }),
      'clearance-coverage-gap',
    );
    // coverageState 'none': the case exists without coverage.
    expectUnsupported(
      await derive({ ...perfect, events: clearEvents().slice(1), versions: [3, 3] }),
      'clearance-coverage-gap',
    );
    // coverageState 'revoked' with the case fully terminal.
    expectUnsupported(
      await derive({
        ...perfect,
        events: [
          ...clearEvents(),
          fakeEvent({ sequence: 4, kind: 'coverage', action: 'revoked', state: 'revoked', caseId: '', operationId: 'op-cov-revoke' }),
        ],
        versions: [4, 4],
      }),
      'clearance-coverage-gap',
    );
    // Empty cases with a perfect record-time page and zero edges.
    expectUnsupported(
      await derive({
        ...perfect,
        events: [clearEvents()[0]!],
        versions: [1, 1],
        edgeRecords: [edgeRecord(neo4j.int(0), [])],
      }),
      'clearance-coverage-gap',
    );
  });

  it('proves the three guard-ordering mutations each flip the outcome (J12)', async () => {
    // Arm (i): R2 removed => truncated listing hiding a pending case clears.
    const truncatedFrames: Frames = {
      listing: { coverageState: 'open', cases: { [CLEAR_CASE_ID]: 'rejected' }, truncated: true, observedVersion: 3 },
      page: { rows: [{ sequence: 1, kind: 'coverage', action: 'opened', state: 'open', caseId: null, recordedAt: RECORDED_AT }], observedVersion: 3 },
      rawCount: 0,
      edges: [],
    };
    expect(localFlow(truncatedFrames)).toBe('clearance-coverage-gap');
    expect(localFlow(truncatedFrames, 'drop-R2')).toBe('clear');
    // The module agrees with the unmutated flow on the analogous fixture.
    const truncatedEvents: Props[] = [...clearEvents()];
    for (let index = 0; index < 200; index += 1) {
      const caseId = `case-extra-${String(index).padStart(3, '0')}`;
      truncatedEvents.push(fakeEvent({
        sequence: 4 + index, kind: 'case', action: 'case_opened', state: 'pending', caseId, operationId: `op-open-${caseId}`,
      }));
    }
    expectUnsupported(
      await derive(clearFixture({ events: truncatedEvents, versions: [203, 203], edgeRecords: [edgeRecord(neo4j.int(0), [])] })),
      'clearance-coverage-gap',
    );

    // Arm (ii): R4 moved after the join => revoked + frozen resolved clears.
    const revokedFrames: Frames = {
      ...truncatedFrames,
      listing: { coverageState: 'revoked', cases: { [CLEAR_CASE_ID]: 'resolved' }, truncated: false, observedVersion: 3 },
    };
    expect(localFlow(revokedFrames)).toBe('clearance-coverage-gap');
    expect(localFlow(revokedFrames, 'move-R4-after-join')).toBe('clear');

    // Arm (iii): R13 removed => a pre-coverage edge clears.
    const preCoverageFrames: Frames = {
      listing: { coverageState: 'open', cases: { [CLEAR_CASE_ID]: 'rejected' }, truncated: false, observedVersion: 3 },
      page: truncatedFrames.page,
      rawCount: 1,
      edges: [{ type: 'CONTRADICTS', validAt: '2026-08-18T11:59:59.999Z', sourceId: CLEAR_SOURCE_ID }],
    };
    expect(localFlow(preCoverageFrames)).toBe('clearance-coverage-gap');
    expect(localFlow(preCoverageFrames, 'drop-R13')).toBe('clear');
    expectUnsupported(
      await derive(clearFixture({
        edgeRecords: [edgeRecord(neo4j.int(1), [clearEdge({ validAt: '2026-08-18T11:59:59.999Z' })])],
      })),
      'clearance-coverage-gap',
    );
  });

  it('opens no driver session before it must: R0 zero, R2-R6 one, R7 two, edges three (J13)', async () => {
    const r0 = clearance();
    expectUnsupported(await r0.surface.deriveClearance({ mode: 'as-of' }), 'clearance-frame-unsupported');
    expect(r0.fake.session).toHaveBeenCalledTimes(0);

    const r3 = clearance(clearFixture({ events: [], versions: [0, 0] }));
    expectUnsupported(await r3.surface.deriveClearance({ mode: 'current' }), 'clearance-coverage-gap');
    expect(r3.fake.session).toHaveBeenCalledTimes(1);
    expect(r3.fake.calls.some(([query]) => query.includes('read-pull'))).toBe(false);
    expect(r3.fake.calls.some(([query]) => query.includes('clearance-raw-edges'))).toBe(false);

    const r7 = clearance(clearFixture({ rows: [] }));
    expectUnsupported(await r7.surface.deriveClearance({ mode: 'current' }), 'clearance-record-time-unavailable');
    expect(r7.fake.session).toHaveBeenCalledTimes(2);
    expect(r7.fake.calls.some(([query]) => query.includes('clearance-raw-edges'))).toBe(false);

    const r16 = clearance();
    expectClear(await r16.surface.deriveClearance({ mode: 'current' }), 3);
    expect(r16.fake.session).toHaveBeenCalledTimes(3);
  });

  it('survives the hostile-driver battery on the edge record with the bound codes and no partial result (J14, E1.4, E3.4)', async () => {
    // Zero-edge arms (E1.4): rawCount 0 with edges [] proceeds to clear.
    expectClear(await derive(zeroEdgeClearFixture()), 3);
    // Plain-number zero also proceeds (the normalizer accepts numbers).
    expectClear(await derive(clearFixture({ edgeRecords: [edgeRecord(0, [])] })), 3);
    // Regression guard: the pre-errata driver shape (rawCount 0 with one
    // map-of-nulls element) is R10 unsupported, never clear.
    expectUnsupported(
      await derive(clearFixture({
        edgeRecords: [edgeRecord(neo4j.int(0), [{ type: null, validAt: null, sourceId: null }])],
      })),
      'clearance-source-unavailable',
    );
    // Driver-Integer positive arm (E3.4): neo4j.int(2) with two edges proceeds.
    const secondSourceId = 'episode-clear-2';
    const secondCaseId = testCaseId(secondSourceId, 'contradiction');
    const twoCaseEvents = [
      ...clearEvents(),
      fakeEvent({ sequence: 4, kind: 'case', action: 'case_opened', state: 'pending', caseId: secondCaseId, operationId: 'op-case2-open' }),
      fakeEvent({ sequence: 5, kind: 'case', action: 'resolved', state: 'resolved', caseId: secondCaseId, operationId: 'op-case2-done' }),
    ];
    expectClear(await derive(clearFixture({
      events: twoCaseEvents,
      versions: [5, 5],
      edgeRecords: [edgeRecord(neo4j.int(2), [clearEdge(), clearEdge({ sourceId: secondSourceId })])],
    })), 5);

    // rawCount abuse: string, float, negative, beyond-safe Integer, null,
    // bigint negative, forged isInt proxy.
    for (const rawCount of [
      '1', 1.5, -1, neo4j.int('9007199254740993'), null, BigInt(-1),
      new Proxy({ toNumber: () => 1, low: 1, high: 0 }, {}),
    ]) {
      expectUnsupported(
        await derive(clearFixture({ edgeRecords: [edgeRecord(rawCount, [clearEdge()])] })),
        'clearance-source-unavailable',
      );
    }
    // edges non-array; length/count disagreement in both directions.
    expectUnsupported(
      await derive(clearFixture({ edgeRecords: [edgeRecord(neo4j.int(1), 'edges')] })),
      'clearance-source-unavailable',
    );
    expectUnsupported(
      await derive(clearFixture({ edgeRecords: [edgeRecord(neo4j.int(2), [clearEdge()])] })),
      'clearance-source-unavailable',
    );
    expectUnsupported(
      await derive(clearFixture({ edgeRecords: [edgeRecord(neo4j.int(1), [clearEdge(), clearEdge()])] })),
      'clearance-source-unavailable',
    );
    // type abuse.
    for (const type of ['REINFORCES', '', null, {}, 42]) {
      expectUnsupported(
        await derive(clearFixture({ edgeRecords: [edgeRecord(neo4j.int(1), [clearEdge({ type })])] })),
        'clearance-source-unavailable',
      );
    }
    // validAt abuse: missing, null, non-ISO, numeric.
    const missingValidAt: Props = { type: 'CONTRADICTS', sourceId: CLEAR_SOURCE_ID };
    expectUnsupported(
      await derive(clearFixture({ edgeRecords: [edgeRecord(neo4j.int(1), [missingValidAt])] })),
      'clearance-record-time-unavailable',
    );
    for (const validAt of [null, 'not-a-date', 42]) {
      expectUnsupported(
        await derive(clearFixture({ edgeRecords: [edgeRecord(neo4j.int(1), [clearEdge({ validAt })])] })),
        'clearance-record-time-unavailable',
      );
    }
    // Boundary trio: one ms before refuses; exactly equal must NOT refuse;
    // one ms after proceeds.
    expectUnsupported(
      await derive(clearFixture({
        edgeRecords: [edgeRecord(neo4j.int(1), [clearEdge({ validAt: '2026-08-18T11:59:59.999Z' })])],
      })),
      'clearance-coverage-gap',
    );
    expectClear(await derive(clearFixture({
      edgeRecords: [edgeRecord(neo4j.int(1), [clearEdge({ validAt: RECORDED_AT })])],
    })), 3);
    expectClear(await derive(clearFixture({
      edgeRecords: [edgeRecord(neo4j.int(1), [clearEdge({ validAt: '2026-08-18T12:00:00.001Z' })])],
    })), 3);
    // sourceId abuse: null, over-length, bad charset, __proto__ (charset-legal
    // but digest-mismatched), non-record edge.
    for (const sourceId of [null, `e${'x'.repeat(501)}`, 'bad source']) {
      expectUnsupported(
        await derive(clearFixture({ edgeRecords: [edgeRecord(neo4j.int(1), [clearEdge({ sourceId })])] })),
        'clearance-coverage-gap',
      );
    }
    expectUnsupported(
      await derive(clearFixture({ edgeRecords: [edgeRecord(neo4j.int(1), [clearEdge({ sourceId: '__proto__' })])] })),
      'clearance-coverage-gap',
    );
    expectUnsupported(
      await derive(clearFixture({ edgeRecords: [edgeRecord(neo4j.int(1), [null])] })),
      'clearance-source-unavailable',
    );
    // Recomputed caseId present only on Object.prototype must refuse: the
    // own-key check never consults the prototype chain.
    const foreignCaseId = testCaseId('episode-polluted', 'contradiction');
    try {
      (Object.prototype as Props)[foreignCaseId] = 'rejected';
      expectUnsupported(
        await derive(clearFixture({
          edgeRecords: [edgeRecord(neo4j.int(1), [clearEdge({ sourceId: 'episode-polluted' })])],
        })),
        'clearance-coverage-gap',
      );
    } finally {
      delete (Object.prototype as Props)[foreignCaseId];
    }
  });

  it('issues the bound edge statement, driver-observed, with neo4j.int params; the shape helper bites (J15)', async () => {
    const healthy = clearance();
    expectClear(await healthy.surface.deriveClearance({ mode: 'current' }), 3);
    const edgeCall = healthy.fake.calls.find(([query]) => query.includes('evidence-authority:clearance-raw-edges'));
    expect(edgeCall).toBeDefined();
    const [text, params] = edgeCall!;
    expect(clearanceQueryFailures(text)).toEqual([]);
    expect(neo4j.isInt(params.edgeCap as object)).toBe(true);
    expect((params.edgeCap as { toNumber(): number }).toNumber()).toBe(200);
    expect(params.tenantId).toBe(SCOPE.tenantId);
    expect(params.projectScope).toBe(SCOPE.projectScope);
    expect(params.semanticId).toBe(SCOPE.semanticId);
    expect(Reflect.ownKeys(params).sort()).toEqual(['edgeCap', 'projectScope', 'semanticId', 'tenantId']);
    // The null-guarded zero-edge form is present as observed at the driver.
    expect(text).toContain('CASE WHEN raw IS NULL THEN null ELSE');
    expect(text).toContain('[0..$edgeCap]');
    expect(text).toContain('count(raw) AS rawCount');
    // Negative arm: the helper FAILS on weakened copies.
    expect(clearanceQueryFailures(text.replace('(semantic:Semantic {id: $semanticId})', '(semantic:Semantic)'))).not.toEqual([]);
    expect(clearanceQueryFailures(text.replace('semantic.tenant_id = $tenantId', 'true'))).not.toEqual([]);
    expect(clearanceQueryFailures(text.replace('semantic.scope = $projectScope', 'true'))).not.toEqual([]);
  });

  it('uses one READ session and one executeRead per driver-touching step, closes each exactly once, and a close failure never replaces a specific failure (J16)', async () => {
    const healthy = clearance();
    expectClear(await healthy.surface.deriveClearance({ mode: 'current' }), 3);
    expect(healthy.fake.session).toHaveBeenCalledTimes(3);
    expect(healthy.fake.sessionConfigs).toEqual([
      { defaultAccessMode: neo4j.session.READ },
      { defaultAccessMode: neo4j.session.READ },
      { defaultAccessMode: neo4j.session.READ },
    ]);
    expect(healthy.fake.executeWrite).not.toHaveBeenCalled();
    for (const result of healthy.fake.session.mock.results) {
      const sessionObject = result.value as { executeRead: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
      expect(sessionObject.executeRead).toHaveBeenCalledTimes(1);
      expect(sessionObject.close).toHaveBeenCalledTimes(1);
    }
    // Refusal path closes its sessions too.
    const refusal = clearance(clearFixture({ events: [], versions: [0, 0] }));
    expectUnsupported(await refusal.surface.deriveClearance({ mode: 'current' }), 'clearance-coverage-gap');
    for (const result of refusal.fake.session.mock.results) {
      expect((result.value as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(1);
    }
    // A pull-session close failure never replaces the specific terminal
    // failure: the domain refusal still becomes the bound R7 verdict.
    const closing = clearance(clearFixture({
      pullThrows: new EvidenceAuthorityLedgerError('existing_state_mismatch'),
      closeThrowsOnSession: 2,
    }));
    expectUnsupported(await closing.surface.deriveClearance({ mode: 'current' }), 'clearance-record-time-unavailable');
    // An edge-session close failure fails closed to a thrown transient, never
    // to clear.
    const edgeClosing = clearance(clearFixture({ closeThrowsOnSession: 3 }));
    const thrown = await expectThrown(edgeClosing.surface.deriveClearance({ mode: 'current' }), 'storage_unavailable');
    expect(String(thrown)).not.toContain(SECRET_CANARY);
  });

  it('builds the reader once at construction with the parsed triple and accepts nothing per call (J17)', async () => {
    // Static half: exactly one construction site, inside the factory.
    const readerCalls = [...moduleSource.matchAll(/createEvidenceAuthorityRead\(/g)];
    const importOccurrences = [...moduleSource.matchAll(/\bcreateEvidenceAuthorityRead\b/g)];
    expect(readerCalls).toHaveLength(1);
    expect(importOccurrences).toHaveLength(2);
    expect(readerCalls[0]!.index).toBeGreaterThan(moduleSource.indexOf('export function createEvidenceAuthorityClearance'));
    expect(readerCalls[0]!.index).toBeLessThan(moduleSource.indexOf('const deriveClearance'));
    // Behavioral half: two calls, every reader statement carries the
    // construction triple and the digest recomputed from it; construction
    // opens no session.
    const healthy = clearance();
    expect(healthy.fake.session).not.toHaveBeenCalled();
    expectClear(await healthy.surface.deriveClearance({ mode: 'current' }), 3);
    expectClear(await healthy.surface.deriveClearance({ mode: 'current' }), 3);
    const readerStatements = healthy.fake.calls.filter(([query]) => query.includes('evidence-authority:read-'));
    expect(readerStatements.length).toBeGreaterThanOrEqual(4);
    for (const [, params] of readerStatements) {
      expect(params.tenantId).toBe(SCOPE.tenantId);
      expect(params.projectScope).toBe(SCOPE.projectScope);
      expect(params.semanticId).toBe(SCOPE.semanticId);
      expect(params.ledgerId).toBe(LEDGER_ID);
    }
  });

  it('fires every record-time sub-clause of R7, and pins the one-page pull args at the driver (J18, E9)', async () => {
    // Terminal pull throw.
    expectUnsupported(
      await derive(clearFixture({ pullThrows: new EvidenceAuthorityLedgerError('existing_state_mismatch') })),
      'clearance-record-time-unavailable',
    );
    // rows.length !== 1 (empty page).
    expectUnsupported(await derive(clearFixture({ rows: [] })), 'clearance-record-time-unavailable');
    // Two rows: the reader itself refuses a page above its limit; the terminal
    // throw lands on the record-time channel as R7.
    expectUnsupported(
      await derive(clearFixture({ rows: [rowFor(clearEvents()[0]!), rowFor(clearEvents()[1]!)] })),
      'clearance-record-time-unavailable',
    );
    // sequence !== 1: a case row at sequence 2 as the first pulled row.
    expectUnsupported(
      await derive(clearFixture({ rows: [rowFor(clearEvents()[1]!)] })),
      'clearance-record-time-unavailable',
    );
    // kind/action/state: a coverage-revoked row at sequence 1 passes the
    // reader vocabulary but is not the opened record.
    expectUnsupported(
      await derive(clearFixture({
        rows: [rowFor(fakeEvent({ sequence: 1, kind: 'coverage', action: 'revoked', state: 'revoked', caseId: '', operationId: 'op-cov-revoke' }))],
      })),
      'clearance-record-time-unavailable',
    );
    // Non-canonical recordedAt: the reader's own predicate refuses the row and
    // the terminal throw is R7 on this channel.
    expectUnsupported(
      await derive(clearFixture({
        rows: [rowFor(fakeEvent({ sequence: 1, kind: 'coverage', action: 'opened', state: 'open', caseId: '', operationId: 'op-cov-open', recordedAt: 'not-a-date' }))],
      })),
      'clearance-record-time-unavailable',
    );
    // Observed-version inequality between the two ledger reads (D7).
    expectUnsupported(
      await derive(clearFixture({ versions: [3, 4] })),
      'clearance-record-time-unavailable',
    );
    // The caseId !== null clause is structural defence in depth: the audited
    // reader always normalizes a coverage row's case value to null, so the
    // clause is asserted in source (see the binding report) and cannot be
    // reached through the real reader.
    expect(moduleSource).toContain('opened.caseId !== null');

    // E9: the pull statement is issued exactly once per derivation with
    // afterSequence 0 and one-row page size, observed at the driver.
    const healthy = clearance();
    expectClear(await healthy.surface.deriveClearance({ mode: 'current' }), 3);
    const pullCalls = healthy.fake.calls.filter(([query]) => query.includes('evidence-authority:read-pull'));
    expect(pullCalls).toHaveLength(1);
    const [, pullParams] = pullCalls[0]!;
    expect(neo4j.isInt(pullParams.afterSequence as object)).toBe(true);
    expect((pullParams.afterSequence as { toNumber(): number }).toNumber()).toBe(0);
    expect(neo4j.isInt(pullParams.limit as object)).toBe(true);
    expect((pullParams.limit as { toNumber(): number }).toNumber()).toBe(1);
  });

  it('partitions all thirteen ledger codes: mismatch is terminal, everything else is a rethrown storage_unavailable (J19, E6.2)', async () => {
    // Table-literal-driven over the full union so a fourteenth code is
    // visibly missing. Through the construction-bound audited reader, only
    // existing_state_mismatch and storage_unavailable can surface from the
    // driver (the reader normalizes every other injected code to
    // storage_unavailable before this module's three-code terminal whitelist
    // can observe it); the whitelist itself is asserted statically below.
    const partition: Array<[string, 'verdict' | 'thrown']> = [
      ['invalid_scope', 'thrown'],
      ['invalid_command', 'thrown'],
      ['invalid_facet', 'thrown'],
      ['facet_scope_mismatch', 'thrown'],
      ['facet_revoked', 'thrown'],
      ['semantic_not_found', 'thrown'],
      ['coverage_missing', 'thrown'],
      ['case_missing', 'thrown'],
      ['invalid_transition', 'thrown'],
      ['operation_conflict', 'thrown'],
      ['existing_state_mismatch', 'verdict'],
      ['write_incomplete', 'thrown'],
      ['storage_unavailable', 'thrown'],
    ];
    expect(partition).toHaveLength(13);
    const observed: string[] = [];
    for (const [code, expected] of partition) {
      // Listing channel.
      const listing = clearance(clearFixture({
        listingThrows: new EvidenceAuthorityLedgerError(code as never),
      }));
      const listingResult = listing.surface.deriveClearance({ mode: 'current' });
      if (expected === 'verdict') {
        const verdict = await listingResult;
        expectUnsupported(verdict, 'clearance-source-unavailable');
        observed.push((verdict as { code: string }).code);
      } else {
        await expectThrown(listingResult, 'storage_unavailable');
        observed.push('thrown:storage_unavailable');
      }
      // Pull channel.
      const pull = clearance(clearFixture({
        pullThrows: new EvidenceAuthorityLedgerError(code as never),
      }));
      const pullResult = pull.surface.deriveClearance({ mode: 'current' });
      if (expected === 'verdict') {
        const verdict = await pullResult;
        expectUnsupported(verdict, 'clearance-record-time-unavailable');
        observed.push((verdict as { code: string }).code);
      } else {
        await expectThrown(pullResult, 'storage_unavailable');
        observed.push('thrown:storage_unavailable');
      }
    }
    expect(observed).toHaveLength(26);
    for (const outcome of observed) {
      expect([
        'clearance-source-unavailable',
        'clearance-record-time-unavailable',
        'thrown:storage_unavailable',
      ]).toContain(outcome);
    }
    // The module-level terminal whitelist is a positive whitelist of exactly
    // the three bound codes.
    const whitelist = moduleSource.match(/const TERMINAL_SOURCE_CODES[^=]*= Object\.freeze\(\[([\s\S]*?)\]/);
    expect(whitelist).not.toBeNull();
    expect([...whitelist![1]!.matchAll(/'([a-z_]+)'/g)].map((entry) => entry[1]!).sort()).toEqual([
      'existing_state_mismatch', 'invalid_command', 'invalid_scope',
    ]);
    // D6 proof: storage_unavailable is rethrown, never converted to a verdict.
    await expectThrown(
      derive(clearFixture({ listingThrows: new EvidenceAuthorityLedgerError('storage_unavailable') })),
      'storage_unavailable',
    );
    // Unknowns normalize to a thrown storage_unavailable: non-ledger Error,
    // string, null, forged .code object, and an edge-channel unknown.
    for (const hostile of [
      new Error(SECRET_CANARY),
      SECRET_CANARY,
      null,
      { code: 'existing_state_mismatch', message: SECRET_CANARY },
    ]) {
      const viaListing = await expectThrown(
        derive(clearFixture({ listingThrows: hostile })),
        'storage_unavailable',
      );
      expect(String(viaListing)).not.toContain(SECRET_CANARY);
    }
    const viaEdge = await expectThrown(
      derive(clearFixture({ edgeThrows: new Error(SECRET_CANARY) })),
      'storage_unavailable',
    );
    expect(String(viaEdge)).not.toContain(SECRET_CANARY);
    expect(((viaEdge as Error).stack ?? '')).not.toContain(SECRET_CANARY);
  });

  it('closes the vacuous clear: open coverage, zero cases, zero edges is a coverage gap (J20, F5)', async () => {
    expectUnsupported(
      await derive(clearFixture({
        events: [clearEvents()[0]!],
        versions: [1, 1],
        edgeRecords: [edgeRecord(neo4j.int(0), [])],
      })),
      'clearance-coverage-gap',
    );
  });

  it('leaks no construction, request, or driver value through any message or stack (J21)', async () => {
    // Every canary is structurally invalid (embedded spaces) before charset
    // could matter.
    let scopeError: unknown;
    try {
      createEvidenceAuthorityClearance(makeDriver({}).driver, { ...SCOPE, semanticId: `bad ${SECRET_CANARY}` });
    } catch (caught) { scopeError = caught; }
    expect(String(scopeError)).toBe('EvidenceAuthorityLedgerError: evidence_authority_ledger:invalid_scope');
    expect(((scopeError as Error).stack ?? '')).not.toContain(SECRET_CANARY);

    const surface = createEvidenceAuthorityClearance(makeDriver({}).driver, { ...SCOPE });
    const requestError = await expectThrown(
      surface.deriveClearance({ mode: `bad ${SECRET_CANARY}` }),
      'invalid_command',
    );
    expect(((requestError as Error).stack ?? '')).not.toContain(SECRET_CANARY);

    const driverError = await expectThrown(
      derive(clearFixture({ edgeThrows: new Error(SECRET_CANARY) })),
      'storage_unavailable',
    );
    expect(String(driverError)).not.toContain(SECRET_CANARY);
    expect(((driverError as Error).stack ?? '')).not.toContain(SECRET_CANARY);

    // A refused hostile edge produces a value-free unsupported result; no
    // canary can travel on a value-free frozen singleton.
    const refused = await derive(clearFixture({
      edgeRecords: [edgeRecord(neo4j.int(1), [clearEdge({ sourceId: `bad ${SECRET_CANARY}` })])],
    }));
    expect(JSON.stringify(refused)).not.toContain(SECRET_CANARY);
  });

  it('pollutes no prototype under hostile source and case identifiers (J22)', async () => {
    expectUnsupported(
      await derive(clearFixture({
        edgeRecords: [edgeRecord(neo4j.int(1), [clearEdge({ sourceId: '__proto__' })])],
      })),
      'clearance-coverage-gap',
    );
    expectUnsupported(
      await derive(clearFixture({
        edgeRecords: [edgeRecord(neo4j.int(1), [clearEdge({ sourceId: 'constructor' })])],
      })),
      'clearance-coverage-gap',
    );
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
    expect(({} as Props).constructor).toBe(Object);
    expect(Object.keys({})).toEqual([]);
  });

  it('caches nothing: a changed ledger changes the verdict on the next call (J23, F6)', async () => {
    const healthy = clearance();
    expectClear(await healthy.surface.deriveClearance({ mode: 'current' }), 3);
    // The ledger moves under the same surface: coverage revoked.
    healthy.fake.state.events = [
      ...clearEvents(),
      fakeEvent({ sequence: 4, kind: 'coverage', action: 'revoked', state: 'revoked', caseId: '', operationId: 'op-cov-revoke' }),
    ];
    healthy.fake.state.versions = [4, 4];
    expectUnsupported(await healthy.surface.deriveClearance({ mode: 'current' }), 'clearance-coverage-gap');
  });

  it('scans the whole case map and never blocks clear on orphans, in both edge shapes (J24, E1.5)', async () => {
    // 200 cases where the 200th in sort order is pending: refused (R6 scans
    // the WHOLE map, not a prefix).
    const events: Props[] = [clearEvents()[0]!];
    let sequence = 1;
    for (let index = 0; index < 200; index += 1) {
      const caseId = `case-${String(index).padStart(3, '0')}`;
      sequence += 1;
      events.push(fakeEvent({ sequence, kind: 'case', action: 'case_opened', state: 'pending', caseId, operationId: `op-open-${caseId}` }));
      if (index < 199) {
        sequence += 1;
        events.push(fakeEvent({ sequence, kind: 'case', action: 'rejected', state: 'rejected', caseId, operationId: `op-reject-${caseId}` }));
      }
    }
    expectUnsupported(
      await derive(clearFixture({ events, versions: [sequence, sequence], edgeRecords: [edgeRecord(neo4j.int(0), [])] })),
      'clearance-adjudication-pending',
    );
    // Resolved orphan clears against the zero-edge record.
    const orphanEvents = [
      clearEvents()[0]!,
      fakeEvent({ sequence: 2, kind: 'case', action: 'case_opened', state: 'pending', caseId: 'case-orphan', operationId: 'op-orphan-open' }),
      fakeEvent({ sequence: 3, kind: 'case', action: 'resolved', state: 'resolved', caseId: 'case-orphan', operationId: 'op-orphan-done' }),
    ];
    expectClear(await derive(clearFixture({
      events: orphanEvents,
      edgeRecords: [edgeRecord(neo4j.int(0), [])],
    })), 3);
    // Mixed record: one live matching edge plus two terminal orphans clears.
    const mixedEvents = [
      ...clearEvents(),
      fakeEvent({ sequence: 4, kind: 'case', action: 'case_opened', state: 'pending', caseId: 'case-orphan-a', operationId: 'op-orphan-a-open' }),
      fakeEvent({ sequence: 5, kind: 'case', action: 'resolved', state: 'resolved', caseId: 'case-orphan-a', operationId: 'op-orphan-a-done' }),
      fakeEvent({ sequence: 6, kind: 'case', action: 'case_opened', state: 'pending', caseId: 'case-orphan-b', operationId: 'op-orphan-b-open' }),
      fakeEvent({ sequence: 7, kind: 'case', action: 'rejected', state: 'rejected', caseId: 'case-orphan-b', operationId: 'op-orphan-b-reject' }),
    ];
    expectClear(await derive(clearFixture({
      events: mixedEvents,
      versions: [7, 7],
      edgeRecords: [edgeRecord(neo4j.int(1), [clearEdge()])],
    })), 7);
  });

  it('trips the B4 deferral wire: no wiring verb and no composition leak in the module (J25)', () => {
    expect(moduleSource).not.toMatch(/createSink|deliverTo|pushOutbox|pushTo|saveCheckpoint|checkpointCursor/i);
    expect(moduleSource).not.toMatch(/EvidenceEligibilityAuthority|sourcePolicy|contractId|receipts/);
  });

  it('simulates producer clock skew: the strictly-less-than comparison is the F11 guard, not lexical (J29, J29b)', async () => {
    // These shapes are unreachable on a healthy ledger by construction
    // (capture refuses unless the raw signal count is zero, so every lawful
    // edge postdates its coverage record); they simulate F11 cross-clock
    // skew, which R13 exists to refuse.
    // 1 ms before: refuse.
    expectUnsupported(
      await derive(clearFixture({
        edgeRecords: [edgeRecord(neo4j.int(1), [clearEdge({ validAt: '2026-08-18T11:59:59.999Z' })])],
      })),
      'clearance-coverage-gap',
    );
    // Exactly equal: must NOT refuse.
    expectClear(await derive(clearFixture({
      edgeRecords: [edgeRecord(neo4j.int(1), [clearEdge({ validAt: RECORDED_AT })])],
    })), 3);
    // 1 ms after: proceed.
    expectClear(await derive(clearFixture({
      edgeRecords: [edgeRecord(neo4j.int(1), [clearEdge({ validAt: '2026-08-18T12:00:00.001Z' })])],
    })), 3);

    // (J)(29b) mixed-format arms. Arms A and B verify sub-millisecond
    // truncation and offset parsing across mixed formats; Arm C is the
    // discriminating lexical-vs-numeric arm.
    const nineDigit = '2026-08-19T12:00:00.123456789+00:00';
    const threeDigitLater = '2026-08-19T12:00:00.124Z';
    const armEvents = (recordedAt: string) => [
      fakeEvent({ sequence: 1, kind: 'coverage', action: 'opened', state: 'open', caseId: '', operationId: 'op-cov-open', recordedAt }),
      fakeEvent({ sequence: 2, kind: 'case', action: 'case_opened', state: 'pending', caseId: CLEAR_CASE_ID, operationId: 'op-case-open', recordedAt }),
      fakeEvent({ sequence: 3, kind: 'case', action: 'rejected', state: 'rejected', caseId: CLEAR_CASE_ID, operationId: 'op-case-reject', recordedAt }),
    ];
    // Arm A: nine-digit +00:00 record time, edge 1 ms after in Z form: clear.
    const armAEvents = armEvents(nineDigit);
    expectClear(await derive(clearFixture({
      events: armAEvents,
      rows: [rowFor(armAEvents[0]!)],
      edgeRecords: [edgeRecord(neo4j.int(1), [clearEdge({ validAt: threeDigitLater })])],
    })), 3);
    // Arm B (inverse): Z-form record time, edge 1 ms before in nine-digit
    // +00:00 form: refuse.
    const armBEvents = armEvents(threeDigitLater);
    expectUnsupported(
      await derive(clearFixture({
        events: armBEvents,
        rows: [rowFor(armBEvents[0]!)],
        edgeRecords: [edgeRecord(neo4j.int(1), [clearEdge({ validAt: nineDigit })])],
      })),
      'clearance-coverage-gap',
    );
    // Arm C (discriminating): offset form lexically far below, numerically
    // EQUAL: any lexical comparator refuses it; the bound comparator must not.
    const armCEvents = armEvents('2026-08-19T12:00:00.000Z');
    expectClear(await derive(clearFixture({
      events: armCEvents,
      rows: [rowFor(armCEvents[0]!)],
      edgeRecords: [edgeRecord(neo4j.int(1), [clearEdge({ validAt: '2026-08-19T07:00:00.000-05:00' })])],
    })), 3);
  });

  it('embeds the verbatim ASCII honest-claim register in the module doc comment (J26)', () => {
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
    expect(REGISTER).toHaveLength(4060);
    expect(stripped).toContain(REGISTER);
    expect(moduleSource).not.toMatch(/non-repudiation/i);
  });
});
