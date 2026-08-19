/**
 * RET-005B-AUTH-001B4: current-frame contradiction clearance derivation.
 *
 * This module derives one module-local verdict on one axis: whether a single Semantic's adjudicated contradiction state is clear in the current frame, under Decision 104 (B-ii). It is not authentication and it is not authorization: it verifies no human, actor, role, or permission, and it performs no access check of any kind. It confers no containment whatsoever. Its derivation is authoritative for exactly two reasons, neither of which is access control: it is the only code in this package that joins the raw contradiction and correction edges against durable case state, so the obligation set and the satisfaction set are compared in one place; and it is the only code that carries the bound total mapping, in which every input shape that is not a proven clear falls to a fixed value-free unsupported code. A caller holding the same driver can read the same rows; what this module owns is correctness, not reach.
 *
 * The audited listing alone is necessary but not sufficient. That listing shows the satisfaction set - the cases that exist - and never the obligation set. The obligation set lives on the raw edges, and a caller who derives clearance from the listing alone is structurally incapable of correctness, which is why the listing's own text forbids treating it as a clearance input. This module consumes the listing, the coverage-opened record time, and the raw edge join together, and fails closed on truncation.
 *
 * Current frame means one ledger version and one edge snapshot, read in three separate transactions, and it is stale the moment it is returned. The ledger listing and the record-time page are bound to each other by an observed-version equality check, and the edge read is not bound to either: a revocation or a new case that lands between them is not visible, so a clear verdict is a statement about a frame that has already passed. This is a disclosed, uncloseable property at this layer, not a defect; a consumer that memoizes a clear verdict makes it permanent and is wrong to do so. Nothing here may be cached, and this module remembers nothing between calls.
 *
 * The two timestamps compared here come from two different clocks. Coverage record time is the graph server's clock, written inside the ledger transaction; edge valid time is the application process's clock, written by the signal producer. Skew between them can make a healthy capture look like it predates its own coverage, and that comparison fails closed to unsupported, permanently, until the producer is fixed. A missing or non-canonical edge valid time is unsupported and is never defaulted toward clear.
 *
 * Every refusal is unconditional and value-free. Absent coverage, revoked coverage, an unreadable record time, a truncated listing, an open or in-progress case anywhere on the Semantic, an edge that predates coverage, an edge whose source cannot be identified, and an edge that matches no durable case all produce a fixed code carrying no tenant, project, Semantic, case, source, sequence, or time value. Clearance is never inferred from the absence of cases, and coverage carrying zero cases is not clear. An as-of request is refused before any driver call is made; this module has no historical authority of any kind.
 *
 * This module emits no cross-package result and imports nothing from the contract package. Its five unsupported codes are its own, and mapping them onto the published authority contract belongs to a later composition packet, which must also supply the lifecycle, temporal, and supersession axes this module cannot know. That composition may never present a refusal of this module as a receipt: the contract's parser rejects a semantic receipt whose contradiction axis is anything but clear, so a refusal must travel as an unsupported code or not at all.
 *
 * This module writes nothing, mints nothing, takes no lock, holds no cursor, computes no ledger identifier, and accepts no scope per call. Its only containment is that the tenant, project, and Semantic triple is bound at construction and that the module is absent from the package root export.
 */
import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';

import neo4j, { type Driver, type ManagedTransaction, type Session } from 'neo4j-driver';

import {
  EvidenceAuthorityLedgerError,
  type EvidenceAuthorityLedgerErrorCode,
} from './evidence-authority-ledger.js';
import {
  createEvidenceAuthorityRead,
  type EvidenceAuthorityCaseListingV1,
  type EvidenceAuthorityOutboxPageV1,
  type EvidenceAuthorityReadV1,
} from './evidence-authority-read.js';

export const EVIDENCE_AUTHORITY_CLEARANCE_VERSION =
  'memberry.evidence-authority-clearance/1.0.0' as const;

export type EvidenceAuthorityClearanceUnsupportedCodeV1 =
  | 'clearance-source-unavailable'
  | 'clearance-frame-unsupported'
  | 'clearance-adjudication-pending'
  | 'clearance-coverage-gap'
  | 'clearance-record-time-unavailable';

export interface EvidenceAuthorityClearanceClearV1 {
  readonly contractVersion: typeof EVIDENCE_AUTHORITY_CLEARANCE_VERSION;
  readonly outcome: 'clear';
  readonly observedVersion: number;
}

export interface EvidenceAuthorityClearanceUnsupportedV1 {
  readonly contractVersion: typeof EVIDENCE_AUTHORITY_CLEARANCE_VERSION;
  readonly outcome: 'unsupported';
  readonly code: EvidenceAuthorityClearanceUnsupportedCodeV1;
}

export type EvidenceAuthorityClearanceResultV1 =
  | EvidenceAuthorityClearanceClearV1
  | EvidenceAuthorityClearanceUnsupportedV1;

export interface EvidenceAuthorityClearanceRequestV1 {
  readonly mode: 'current' | 'as-of';
}

export interface EvidenceAuthorityClearanceV1 {
  readonly contractVersion: typeof EVIDENCE_AUTHORITY_CLEARANCE_VERSION;
  deriveClearance(request: unknown): Promise<EvidenceAuthorityClearanceResultV1>;
}

// Hand copies of the frozen capture vocabulary. Duplication is intended, not
// tolerated: the capture module exports none of these, and each copy is
// source-pinned against the capture literal by the unit suite.
const CAPTURE_ID_DOMAIN = 'memberry-evidence-authority-capture-v1';
const MAX_INPUT_LENGTH = 500;
const PROJECT_SCOPE = /^project:[a-z0-9][a-z0-9._-]*$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SOURCE_EPISODE_ID = /^[A-Za-z0-9._:-]+$/;
// The largest value that can ever change an outcome under source-id
// uniqueness: n qualifying edges need n distinct matching cases, and the
// audited listing truncates beyond its own 200-case cap, which R2 refuses.
// Source-pinned against the listing cap literal so the two never diverge.
const MAX_JOINED_RAW_EDGES = 200;
const SCOPE_KEYS = Object.freeze(['tenantId', 'projectScope', 'semanticId'] as const);
const REQUEST_KEYS = Object.freeze(['mode'] as const);
// Fifth hand copy of the ledger code union; a frozen array with .includes,
// matching the read module's container. Pinned sorted against the union type
// and the ledger literal.
const LEDGER_ERROR_CODES: readonly EvidenceAuthorityLedgerErrorCode[] = Object.freeze([
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
  'write_incomplete',
  'storage_unavailable',
] as const);
// Positive whitelist of the three terminal reader failures. Every other
// ledger code, and every unknown, is rethrown as storage_unavailable: a code
// added to the union later falls to rethrow automatically, the fail-closed
// direction.
const TERMINAL_SOURCE_CODES = Object.freeze([
  'invalid_command',
  'existing_state_mismatch',
  'invalid_scope',
] as const);
// Positive whitelist (never a blacklist): any own case value outside these
// two exact states refuses, including vocabulary that does not exist yet.
const TERMINAL_CASE_STATES = Object.freeze(['rejected', 'resolved'] as const);
// Closed relationship-type map; anything else is refused at R11.
const SIGNAL_KINDS = Object.freeze(Object.assign(Object.create(null), {
  CONTRADICTS: 'contradiction',
  CORRECTS: 'correction',
})) as Readonly<Record<string, 'contradiction' | 'correction'>>;

/** Fixed, value-free unsupported results. No input value ever enters one. */
const SOURCE_UNAVAILABLE = Object.freeze(Object.assign(Object.create(null), {
  contractVersion: EVIDENCE_AUTHORITY_CLEARANCE_VERSION,
  outcome: 'unsupported',
  code: 'clearance-source-unavailable',
})) as EvidenceAuthorityClearanceUnsupportedV1;

const FRAME_UNSUPPORTED = Object.freeze(Object.assign(Object.create(null), {
  contractVersion: EVIDENCE_AUTHORITY_CLEARANCE_VERSION,
  outcome: 'unsupported',
  code: 'clearance-frame-unsupported',
})) as EvidenceAuthorityClearanceUnsupportedV1;

const ADJUDICATION_PENDING = Object.freeze(Object.assign(Object.create(null), {
  contractVersion: EVIDENCE_AUTHORITY_CLEARANCE_VERSION,
  outcome: 'unsupported',
  code: 'clearance-adjudication-pending',
})) as EvidenceAuthorityClearanceUnsupportedV1;

const COVERAGE_GAP = Object.freeze(Object.assign(Object.create(null), {
  contractVersion: EVIDENCE_AUTHORITY_CLEARANCE_VERSION,
  outcome: 'unsupported',
  code: 'clearance-coverage-gap',
})) as EvidenceAuthorityClearanceUnsupportedV1;

const RECORD_TIME_UNAVAILABLE = Object.freeze(Object.assign(Object.create(null), {
  contractVersion: EVIDENCE_AUTHORITY_CLEARANCE_VERSION,
  outcome: 'unsupported',
  code: 'clearance-record-time-unavailable',
})) as EvidenceAuthorityClearanceUnsupportedV1;

// The one edge statement: anchored on the Semantic with both scope
// predicates, incoming raw edges of exactly the two adjudicable types, the
// source deliberately untyped and unfiltered. Zero records means an absent or
// foreign-scope Semantic, never a zero count. The null-guarded CASE form
// makes the ordinary zero-edge row collect to an empty list; the slice is
// transport bounding only and is provably inert on every non-refused path
// because edges.length must equal the unsliced count.
const CLEARANCE_RAW_EDGES_QUERY = `/* evidence-authority:clearance-raw-edges */
MATCH (semantic:Semantic {id: $semanticId})
WHERE semantic.tenant_id = $tenantId AND semantic.scope = $projectScope
OPTIONAL MATCH (semantic)<-[raw:CONTRADICTS|CORRECTS]-(source)
WITH semantic,
     count(raw) AS rawCount,
     collect(CASE WHEN raw IS NULL THEN null ELSE
       { type: type(raw), validAt: raw.valid_at, sourceId: source.id } END)[0..$edgeCap] AS edges
RETURN rawCount, edges`;

interface ClearanceScope {
  readonly tenantId: string;
  readonly projectScope: string;
  readonly semanticId: string;
}

/** Byte budget first, charset second, always before any hashing. */
function boundedMatch(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_INPUT_LENGTH
    && pattern.test(value);
}

function transientFailure(): EvidenceAuthorityLedgerError {
  return new EvidenceAuthorityLedgerError('storage_unavailable');
}

/**
 * The three-code positive whitelist over the reader's failure channel.
 * A hostile error object that throws while being inspected is not terminal
 * and falls to the transient rethrow.
 */
function terminalSourceFailure(error: unknown): boolean {
  try {
    return error instanceof EvidenceAuthorityLedgerError
      && (LEDGER_ERROR_CODES as readonly string[]).includes(error.code)
      && (TERMINAL_SOURCE_CODES as readonly string[]).includes(error.code);
  } catch {
    return false;
  }
}

function strictRecord(
  value: unknown,
  code: 'invalid_scope' | 'invalid_command',
  expected: readonly string[],
): Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
      throw new EvidenceAuthorityLedgerError(code);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new EvidenceAuthorityLedgerError(code);
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== expected.length
      || ownKeys.some((key) => typeof key !== 'string' || !expected.includes(key))) {
      throw new EvidenceAuthorityLedgerError(code);
    }
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        throw new EvidenceAuthorityLedgerError(code);
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    throw new EvidenceAuthorityLedgerError(code);
  }
}

/**
 * Scope is bound exactly once, at construction; an invalid scope throws so no
 * half-built object escapes and no scope value is reachable afterwards.
 */
function parseClearanceScope(value: unknown): ClearanceScope {
  const input = strictRecord(value, 'invalid_scope', SCOPE_KEYS);
  if (!boundedMatch(input.tenantId, IDENTIFIER)
    || !boundedMatch(input.projectScope, PROJECT_SCOPE)
    || !boundedMatch(input.semanticId, IDENTIFIER)) {
    throw new EvidenceAuthorityLedgerError('invalid_scope');
  }
  return Object.freeze({
    tenantId: input.tenantId,
    projectScope: input.projectScope,
    semanticId: input.semanticId,
  });
}

/**
 * Exactly one key, mode, literal 'current' or 'as-of'. A malformed request is
 * a caller defect and throws with zero driver calls; an explicit 'as-of' is a
 * lawful request for an unsupported capability and is refused at R0.
 */
function parseClearanceMode(value: unknown): 'current' | 'as-of' {
  const input = strictRecord(value, 'invalid_command', REQUEST_KEYS);
  const mode = input.mode;
  if (mode !== 'current' && mode !== 'as-of') {
    throw new EvidenceAuthorityLedgerError('invalid_command');
  }
  return mode;
}

/**
 * Hand copy of the audited reader's driver-integer normalizer, returning null
 * instead of throwing so a malformed count falls to the R10 verdict. The
 * isProxy guard is load-bearing: a proxy forging isInt and toNumber must
 * never reach the comparison floor.
 */
function normalizedCount(value: unknown): number | null {
  try {
    let parsed: number;
    if (typeof value === 'number') parsed = value;
    else if (typeof value === 'bigint') parsed = Number(value);
    else if (typeof value === 'object' && value !== null && !isProxy(value)
      && neo4j.isInt(value)) {
      parsed = (value as { toNumber(): number }).toNumber();
    } else parsed = Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Hand copy of the lane's canonical-instant predicate. */
function canonicalInstant(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T/.test(value)
    && Number.isFinite(Date.parse(value));
}

/** Defensive own-data read; accessors, proxies, and non-records yield undefined. */
function edgeValue(edge: unknown, key: string): unknown {
  try {
    if (typeof edge !== 'object' || edge === null || Array.isArray(edge) || isProxy(edge)) {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(edge, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return undefined;
    return descriptor.value;
  } catch {
    return undefined;
  }
}

/**
 * caseId recomputation, hand-copied from the capture module and source-pinned
 * there: domain, salt 'case', scope triple, then sourceEpisodeId strictly
 * before signalKind. Every input is charset- and length-checked before it can
 * reach this hash; no input is a substring of the result.
 */
function recomputedCaseId(
  scope: ClearanceScope,
  sourceEpisodeId: string,
  signalKind: 'contradiction' | 'correction',
): string {
  try {
    const digest = createHash('sha256')
      .update(JSON.stringify([
        CAPTURE_ID_DOMAIN,
        'case',
        scope.tenantId,
        scope.projectScope,
        scope.semanticId,
        sourceEpisodeId,
        signalKind,
      ]))
      .digest('hex');
    return `capture-case-${digest}`;
  } catch {
    throw transientFailure();
  }
}

function clearResult(observedVersion: number): EvidenceAuthorityClearanceClearV1 {
  return Object.freeze(Object.assign(Object.create(null), {
    contractVersion: EVIDENCE_AUTHORITY_CLEARANCE_VERSION,
    outcome: 'clear',
    observedVersion,
  })) as EvidenceAuthorityClearanceClearV1;
}

/**
 * One READ-mode session, one executeRead, one statement. Returns null when
 * the statement yields anything but exactly one readable record (R8); every
 * thrown failure is a value-free transient, and a close failure never
 * replaces a more specific failure.
 */
async function readEdgeRecord(
  driver: Driver,
  params: Readonly<Record<string, unknown>>,
): Promise<{ rawCount: unknown; edges: unknown } | null> {
  let session: Session;
  try {
    session = driver.session({ defaultAccessMode: neo4j.session.READ });
  } catch {
    throw transientFailure();
  }
  let outcome: { rawCount: unknown; edges: unknown } | null | undefined;
  let failure: EvidenceAuthorityLedgerError | undefined;
  try {
    outcome = await session.executeRead(async (tx: ManagedTransaction) => {
      const result = await tx.run(CLEARANCE_RAW_EDGES_QUERY, params);
      const records = (result as { records?: unknown }).records;
      if (!Array.isArray(records) || isProxy(records) || records.length !== 1) return null;
      const single = records[0] as { get?: unknown };
      if (single === null || typeof single !== 'object' || isProxy(single)
        || typeof single.get !== 'function') {
        return null;
      }
      const row = single as { get(key: string): unknown };
      return { rawCount: row.get('rawCount'), edges: row.get('edges') };
    });
  } catch {
    failure = transientFailure();
  }
  try {
    await session.close();
  } catch {
    // Cleanup must never replace a more specific failure.
    failure ??= transientFailure();
  }
  if (failure) throw failure;
  return outcome ?? null;
}

export function createEvidenceAuthorityClearance(
  driver: Driver,
  scope: unknown,
): EvidenceAuthorityClearanceV1 {
  const parsed = parseClearanceScope(scope);
  // The audited reader is built exactly once, here, from the parsed triple.
  // No reader, persistence object, facet, identifier, or per-call scope is
  // ever accepted: one instance is one (tenant, project, Semantic).
  const reader: EvidenceAuthorityReadV1 = createEvidenceAuthorityRead(driver, {
    tenantId: parsed.tenantId,
    projectScope: parsed.projectScope,
    semanticId: parsed.semanticId,
  });
  const edgeParams = Object.freeze({
    tenantId: parsed.tenantId,
    projectScope: parsed.projectScope,
    semanticId: parsed.semanticId,
    edgeCap: neo4j.int(MAX_JOINED_RAW_EDGES),
  });

  const deriveClearance = async (request: unknown): Promise<EvidenceAuthorityClearanceResultV1> => {
    const mode = parseClearanceMode(request);
    // R0: no historical authority of any kind; refused before any driver call.
    if (mode === 'as-of') return FRAME_UNSUPPORTED;

    // R1: only the reader's terminal codes become a verdict; every transient
    // and every unknown propagates as a thrown storage_unavailable so an
    // outage can never freeze into a durable policy answer.
    let listing: EvidenceAuthorityCaseListingV1;
    try {
      listing = await reader.listCases();
    } catch (error) {
      if (terminalSourceFailure(error)) return SOURCE_UNAVAILABLE;
      throw transientFailure();
    }
    if (listing.truncated === true) return COVERAGE_GAP; // R2
    if (listing.coverageState === 'none') return COVERAGE_GAP; // R3
    if (listing.coverageState === 'revoked') return COVERAGE_GAP; // R4
    const caseIds = Object.keys(listing.cases);
    if (caseIds.length === 0) return COVERAGE_GAP; // R5
    // R6: whole-map scan against the positive state whitelist; one pending or
    // in-progress case anywhere on the Semantic refuses before any join.
    for (const caseId of caseIds) {
      const state: unknown = listing.cases[caseId];
      if (!(TERMINAL_CASE_STATES as readonly string[]).includes(state as string)) {
        return ADJUDICATION_PENDING;
      }
    }

    // R7: the coverage-opened record time through the audited reader; one
    // page, one row, never a drain. The opened event is provably the
    // sequence-1 event and its recorded time is byte-equal to the coverage
    // record's creation instant by the ledger's own append-time audit; every
    // component of that invariant is asserted rather than trusted, and the
    // observed-version equality binds the two ledger reads into one frame.
    let page: EvidenceAuthorityOutboxPageV1;
    try {
      page = await reader.pullOutbox({ afterSequence: 0, limit: 1 });
    } catch (error) {
      if (terminalSourceFailure(error)) return RECORD_TIME_UNAVAILABLE;
      throw transientFailure();
    }
    const opened = page.rows.length === 1 ? page.rows[0]! : undefined;
    if (opened === undefined
      || opened.sequence !== 1
      || opened.kind !== 'coverage'
      || opened.action !== 'opened'
      || opened.state !== 'open'
      || opened.caseId !== null
      || !canonicalInstant(opened.recordedAt)
      || page.observedVersion !== listing.observedVersion) {
      return RECORD_TIME_UNAVAILABLE;
    }
    const coverageInstant = Date.parse(opened.recordedAt);

    // R8: zero records is an absent or foreign-scope Semantic, never a count.
    const edgeRecord = await readEdgeRecord(driver, edgeParams);
    if (edgeRecord === null) return SOURCE_UNAVAILABLE;
    const rawCount = normalizedCount(edgeRecord.rawCount);
    if (rawCount !== null && rawCount > MAX_JOINED_RAW_EDGES) return COVERAGE_GAP; // R9
    if (rawCount === null
      || !Array.isArray(edgeRecord.edges) || isProxy(edgeRecord.edges)
      || edgeRecord.edges.length !== rawCount) {
      return SOURCE_UNAVAILABLE; // R10
    }
    const edges = edgeRecord.edges as readonly unknown[];
    // R11: the closed relationship-type map; a type this lane cannot mint is
    // refused, never skipped, because a skipped obligation is a false clear.
    for (const edge of edges) {
      const type = edgeValue(edge, 'type');
      if (typeof type !== 'string' || !Object.hasOwn(SIGNAL_KINDS, type)) {
        return SOURCE_UNAVAILABLE;
      }
    }
    // R12: a missing or non-canonical edge valid time is never defaulted.
    for (const edge of edges) {
      if (!canonicalInstant(edgeValue(edge, 'validAt'))) return RECORD_TIME_UNAVAILABLE;
    }
    // R13: numeric comparison of parsed milliseconds, strictly less than.
    // Lexical comparison is forbidden: the two clocks emit different
    // fractional precision and offset forms. This arm is unreachable on a
    // healthy ledger (capture refuses over pre-existing raw signals) and
    // exists as the cross-clock skew guard, failing closed.
    for (const edge of edges) {
      if (Date.parse(edgeValue(edge, 'validAt') as string) < coverageInstant) {
        return COVERAGE_GAP;
      }
    }
    // R14: an unidentifiable source is an obligation that cannot be matched.
    for (const edge of edges) {
      if (!boundedMatch(edgeValue(edge, 'sourceId'), SOURCE_EPISODE_ID)) return COVERAGE_GAP;
    }
    // R15: every live edge must map to an own key of the durable case map.
    for (const edge of edges) {
      const sourceId = edgeValue(edge, 'sourceId') as string;
      const type = edgeValue(edge, 'type') as string;
      const caseId = recomputedCaseId(parsed, sourceId, SIGNAL_KINDS[type]!);
      if (!Object.hasOwn(listing.cases, caseId)) return COVERAGE_GAP;
    }
    // R16: every guard above passed.
    return clearResult(listing.observedVersion);
  };

  return Object.freeze(Object.assign(Object.create(null), {
    contractVersion: EVIDENCE_AUTHORITY_CLEARANCE_VERSION,
    deriveClearance,
  })) as EvidenceAuthorityClearanceV1;
}
