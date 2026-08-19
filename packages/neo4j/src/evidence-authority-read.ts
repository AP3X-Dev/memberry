/**
 * RET-005B-AUTH-001B3B2: audited evidence-authority read surface.
 *
 * This module provides a read-only, construction-scope-bound, advisory snapshot of one evidence-authority ledger. It is not authentication and it is not authorization: it verifies no human, actor, role, or permission, and it performs no access check of any kind. Its only containment is that the tenant/project/Semantic triple is bound at construction and cannot be supplied per call, and that the module is absent from the package root export.
 *
 * The ledgerId is a public digest, not a capability. It is sha256 over a published domain string and three caller-known values; anyone who knows the scope can compute it. Every query re-asserts the full scope in Cypher and every returned row is re-checked in TypeScript; those predicates, not the identifier, are the boundary.
 *
 * This listing derives no clearance, and clearance derivation remains exclusively B4's under Decision 104 (B-ii). B4 may not treat this listing as a clearance input. Be plain about why the identifier ban is only hygiene: the state vocabulary is a closed transition table, so whenever truncated === false a caller can compute clearance client-side from coverageState and cases. Banning the words bans the vocabulary, not the capability. The hard cap and the truncated marker are the only real limiter; a truncated === true page is a deterministic, state-independent prefix from which clearance is NOT derivable.
 *
 * pullOutbox cannot report ledger absence. A mistyped Semantic drains forever and is indistinguishable from a healthy drained ledger - a deliberate anti-oracle tradeoff, not a defect. Equally, coverageState 'none' does not distinguish "Semantic absent" from "Semantic present and uncovered" - no query in this module ever joins (:Semantic).
 *
 * Refusal and emptiness are different channels here, deliberately and unlike the sibling write modules: an invalid cursor, an invalid request shape, or any row this module cannot validate is refused loudly by a thrown EvidenceAuthorityLedgerError, and only genuine emptiness - an absent ledger, an uncovered Semantic, or a cursor past the last event - returns an empty listing or an empty page.
 *
 * observedVersion discloses write volume. It is a dense monotone counter; polling it reveals a ledger's write rate and timing to anyone who can reach this module.
 *
 * At-least-once delivery and durable checkpointing are caller obligations. This module holds no cursor, persists nothing, and remembers nothing between calls: the caller owns the cursor, and a caller that loses it replays. No ack, skip, park, dead-letter, mark-delivered, push, or deliver verb exists in this module or anywhere in this lane - in an unwired package such a verb would be a forged delivery claim. The outbox is a permanent immutable journal; no delivery state exists anywhere in the audited subgraph, and adding any would permanently brick the ledger's write path.
 *
 * The snapshot is advisory and immediately stale. This module performs no writes, mints no ledger, mints no coverage, and takes no lock.
 */
import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';

import neo4j, { type Driver, type ManagedTransaction, type Session } from 'neo4j-driver';

import {
  EvidenceAuthorityLedgerError,
  type EvidenceAuthorityCaseStateV1,
  type EvidenceAuthorityCoverageStateV1,
  type EvidenceAuthorityEventActionV1,
  type EvidenceAuthorityEventKindV1,
  type EvidenceAuthorityLedgerErrorCode,
} from './evidence-authority-ledger.js';

export const EVIDENCE_AUTHORITY_READ_VERSION =
  'memberry.evidence-authority-read/1.0.0' as const;

// Hand copies of the frozen ledger vocabulary. Duplication is intended, not
// tolerated (Decision 114 (D)): the ledger exports none of these, and each
// copy is source-pinned against the ledger literal by the unit suite.
const ID_DOMAIN = 'memberry-evidence-authority-ledger-v1';
const MAX_IDENTIFIER_LENGTH = 500;
const PROJECT_SCOPE = /^project:[a-z0-9][a-z0-9._-]*$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_LISTED_CASES = 200;
const MAX_PULLED_ROWS = 100;
const SCOPE_KEYS = Object.freeze(['tenantId', 'projectScope', 'semanticId'] as const);
const ROW_KEYS = Object.freeze(['event', 'outbox'] as const);
const EVENT_KEYS = Object.freeze([
  'id', 'tenant_id', 'project_scope', 'semantic_id', 'case_id', 'operation_id',
  'kind', 'action', 'state', 'sequence', 'recorded_at',
] as const);
const OUTBOX_KEYS = Object.freeze([
  'id', 'event_id', 'tenant_id', 'project_scope', 'semantic_id', 'case_id',
  'kind', 'action', 'state', 'sequence', 'recorded_at',
] as const);
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
// The closed six-member (kind, action, state) table. Vocabulary the ledger can
// never mint is refused, not returned.
const EVENT_PAIRS = Object.freeze([
  Object.freeze(['coverage', 'opened', 'open'] as const),
  Object.freeze(['coverage', 'revoked', 'revoked'] as const),
  Object.freeze(['case', 'case_opened', 'pending'] as const),
  Object.freeze(['case', 'rejected', 'rejected'] as const),
  Object.freeze(['case', 'resolution_started', 'resolving'] as const),
  Object.freeze(['case', 'resolved', 'resolved'] as const),
] as const);

export type EvidenceAuthorityReadCoverageStateV1 = 'none' | 'open' | 'revoked';

export interface EvidenceAuthorityCaseListingV1 {
  readonly contractVersion: typeof EVIDENCE_AUTHORITY_READ_VERSION;
  readonly coverageState: EvidenceAuthorityReadCoverageStateV1;
  readonly cases: Readonly<Record<string, EvidenceAuthorityCaseStateV1>>;
  readonly truncated: boolean;
  readonly observedVersion: number;
}

export interface EvidenceAuthorityOutboxRowV1 {
  readonly id: string;
  readonly eventId: string;
  readonly kind: EvidenceAuthorityEventKindV1;
  readonly action: EvidenceAuthorityEventActionV1;
  readonly state: EvidenceAuthorityCoverageStateV1 | EvidenceAuthorityCaseStateV1;
  readonly sequence: number;
  readonly recordedAt: string;
  readonly caseId: string | null;
}

export interface EvidenceAuthorityOutboxPageV1 {
  readonly contractVersion: typeof EVIDENCE_AUTHORITY_READ_VERSION;
  readonly rows: readonly EvidenceAuthorityOutboxRowV1[];
  readonly observedVersion: number;
}

export interface EvidenceAuthorityOutboxPullRequestV1 {
  readonly afterSequence: number;
  readonly limit?: number;
}

export interface EvidenceAuthorityReadV1 {
  readonly contractVersion: typeof EVIDENCE_AUTHORITY_READ_VERSION;
  listCases(): Promise<EvidenceAuthorityCaseListingV1>;
  pullOutbox(request: unknown): Promise<EvidenceAuthorityOutboxPageV1>;
}

interface ReadScope {
  readonly tenantId: string;
  readonly projectScope: string;
  readonly semanticId: string;
  readonly ledgerId: string;
}

interface ValidatedEvent {
  readonly eventId: string;
  readonly kind: EvidenceAuthorityEventKindV1;
  readonly action: EvidenceAuthorityEventActionV1;
  readonly state: EvidenceAuthorityCoverageStateV1 | EvidenceAuthorityCaseStateV1;
  readonly caseId: string;
  readonly sequence: number;
  readonly recordedAt: string;
}

/** Fixed value-free empties: genuine emptiness, never a refusal channel. */
const EMPTY_LISTING = Object.freeze(Object.assign(Object.create(null), {
  contractVersion: EVIDENCE_AUTHORITY_READ_VERSION,
  coverageState: 'none',
  cases: Object.freeze(Object.create(null)) as Readonly<Record<string, EvidenceAuthorityCaseStateV1>>,
  truncated: false,
  observedVersion: 0,
})) as EvidenceAuthorityCaseListingV1;

const EMPTY_PAGE = Object.freeze(Object.assign(Object.create(null), {
  contractVersion: EVIDENCE_AUTHORITY_READ_VERSION,
  rows: Object.freeze([]) as readonly EvidenceAuthorityOutboxRowV1[],
  observedVersion: 0,
})) as EvidenceAuthorityOutboxPageV1;

const LEDGER_VERSION_QUERY = `/* evidence-authority:read-version */
MATCH (ledger:EvidenceAuthorityLedger {id: $ledgerId})
WHERE ledger.tenant_id = $tenantId
  AND ledger.project_scope = $projectScope
  AND ledger.semantic_id = $semanticId
RETURN ledger.version AS version`;

const LISTING_EVENTS_QUERY = `/* evidence-authority:read-listing */
MATCH (ledger:EvidenceAuthorityLedger {id: $ledgerId})-[:HAS_EVENT]->(event:EvidenceAuthorityEvent)
WHERE ledger.tenant_id = $tenantId
  AND ledger.project_scope = $projectScope
  AND ledger.semantic_id = $semanticId
  AND event.tenant_id = $tenantId
  AND event.project_scope = $projectScope
  AND event.semantic_id = $semanticId
WITH event
ORDER BY event.sequence ASC
RETURN collect(properties(event)) AS events`;

const PULL_ROWS_QUERY = `/* evidence-authority:read-pull */
MATCH (ledger:EvidenceAuthorityLedger {id: $ledgerId})-[:HAS_EVENT]->
      (event:EvidenceAuthorityEvent)-[:EMITTED]->(outbox:EvidenceAuthorityOutbox)
WHERE ledger.tenant_id = $tenantId
  AND ledger.project_scope = $projectScope
  AND ledger.semantic_id = $semanticId
  AND event.tenant_id = $tenantId
  AND event.project_scope = $projectScope
  AND event.semantic_id = $semanticId
  AND event.sequence > $afterSequence
WITH event, outbox
ORDER BY event.sequence ASC
LIMIT $limit
RETURN collect({ event: properties(event), outbox: properties(outbox) }) AS rows`;

function mismatch(): EvidenceAuthorityLedgerError {
  return new EvidenceAuthorityLedgerError('existing_state_mismatch');
}

function normalizedError(value: unknown): EvidenceAuthorityLedgerError {
  try {
    if (value instanceof EvidenceAuthorityLedgerError
      && LEDGER_ERROR_CODES.includes(value.code)
      && (value.code === 'existing_state_mismatch' || value.code === 'storage_unavailable')) {
      return new EvidenceAuthorityLedgerError(value.code);
    }
  } catch {
    // A hostile Error subclass normalizes to the transient fallback below.
  }
  return new EvidenceAuthorityLedgerError('storage_unavailable');
}

function strictRecord(
  value: unknown,
  code: 'invalid_scope' | 'invalid_command',
): Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
      throw new EvidenceAuthorityLedgerError(code);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new EvidenceAuthorityLedgerError(code);
    }
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        throw new EvidenceAuthorityLedgerError(code);
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    throw new EvidenceAuthorityLedgerError(code);
  }
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  code: 'invalid_scope' | 'invalid_command',
): void {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length
    || keys.some((key) => typeof key !== 'string' || !expected.includes(key))) {
    throw new EvidenceAuthorityLedgerError(code);
  }
}

function identifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_IDENTIFIER_LENGTH
    && IDENTIFIER.test(value);
}

function digest(kind: string, ...values: string[]): string {
  try {
    const input = JSON.stringify([ID_DOMAIN, kind, ...values]);
    return `evidence-authority:${kind}:sha256:${createHash('sha256').update(input).digest('hex')}`;
  } catch {
    throw new EvidenceAuthorityLedgerError('storage_unavailable');
  }
}

function properties(value: unknown, keys: readonly string[]): Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
      throw mismatch();
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length
      || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) {
      throw mismatch();
    }
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        throw mismatch();
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch (error) {
    throw normalizedError(error);
  }
}

function integer(value: unknown): number {
  try {
    let parsed: number;
    if (typeof value === 'number') parsed = value;
    else if (typeof value === 'bigint') parsed = Number(value);
    else if (typeof value === 'object' && value !== null && !isProxy(value)
      && neo4j.isInt(value)) {
      parsed = (value as { toNumber(): number }).toNumber();
    } else parsed = Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw mismatch();
    return parsed;
  } catch (error) {
    throw normalizedError(error);
  }
}

function dateTime(value: unknown): string {
  try {
    const result = typeof value === 'string' ? value : '';
    if (!/^\d{4}-\d{2}-\d{2}T/.test(result) || !Number.isFinite(Date.parse(result))) {
      throw mismatch();
    }
    return result;
  } catch (error) {
    throw normalizedError(error);
  }
}

function recordList(value: unknown): readonly unknown[] {
  try {
    const records = (value as { records?: unknown }).records;
    if (!Array.isArray(records) || isProxy(records)) throw mismatch();
    return records;
  } catch (error) {
    throw normalizedError(error);
  }
}

function singleRecord(value: unknown): { get(key: string): unknown } {
  try {
    const records = (value as { records?: unknown }).records;
    if (!Array.isArray(records) || records.length !== 1) {
      throw mismatch();
    }
    const current = records[0] as { get?: unknown };
    if (current === null || typeof current !== 'object' || isProxy(current)
      || typeof current.get !== 'function') {
      throw mismatch();
    }
    return current as { get(key: string): unknown };
  } catch (error) {
    throw normalizedError(error);
  }
}

function safeGet(record: { get(key: string): unknown }, key: string): unknown {
  try {
    return record.get(key);
  } catch (error) {
    throw normalizedError(error);
  }
}

/**
 * Scope is bound exactly once, at construction; an invalid scope throws so no
 * half-built object escapes. The ledgerId digest is closure-held: it is never
 * returned, never logged, and never accepted from a caller.
 */
function parseReadScope(value: unknown): ReadScope {
  try {
    const input = strictRecord(value, 'invalid_scope');
    exactKeys(input, SCOPE_KEYS, 'invalid_scope');
    if (!identifier(input.tenantId)
      || typeof input.projectScope !== 'string'
      || input.projectScope.length > MAX_IDENTIFIER_LENGTH
      || !PROJECT_SCOPE.test(input.projectScope)
      || !identifier(input.semanticId)) {
      throw new EvidenceAuthorityLedgerError('invalid_scope');
    }
    const tenantId = input.tenantId;
    const projectScope = input.projectScope;
    const semanticId = input.semanticId;
    return Object.freeze({
      tenantId,
      projectScope,
      semanticId,
      ledgerId: digest('ledger', tenantId, projectScope, semanticId),
    });
  } catch {
    throw new EvidenceAuthorityLedgerError('invalid_scope');
  }
}

/**
 * Cursor validation refuses, never coerces and never clamps: a silently
 * clamped over-large limit would return a short page indistinguishable from
 * approaching drain (the F8 failure class the refusal channel exists to
 * close).
 */
function parsePullRequest(value: unknown): { afterSequence: number; limit: number } {
  try {
    const input = strictRecord(value, 'invalid_command');
    const keys = Reflect.ownKeys(input) as readonly string[];
    const withLimit = keys.length === 2 && keys.includes('afterSequence') && keys.includes('limit');
    if (!withLimit && !(keys.length === 1 && keys[0] === 'afterSequence')) {
      throw new EvidenceAuthorityLedgerError('invalid_command');
    }
    const afterSequence = input.afterSequence;
    if (typeof afterSequence !== 'number' || !Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new EvidenceAuthorityLedgerError('invalid_command');
    }
    let limit = MAX_PULLED_ROWS;
    if (withLimit) {
      const raw = input.limit;
      if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1 || raw > MAX_PULLED_ROWS) {
        throw new EvidenceAuthorityLedgerError('invalid_command');
      }
      limit = raw;
    }
    return Object.freeze({ afterSequence, limit });
  } catch {
    throw new EvidenceAuthorityLedgerError('invalid_command');
  }
}

/**
 * Hostile-driver event validation. Every returned value is re-checked against
 * the construction-held scope triple and the recomputed ledger digest before
 * it can influence any returned value; a page is all-valid or a refusal.
 */
function validateEvent(scope: ReadScope, raw: unknown): ValidatedEvent {
  const event = properties(raw, EVENT_KEYS);
  const operationId = event.operation_id;
  const caseId = event.case_id;
  const kind = event.kind;
  const action = event.action;
  const state = event.state;
  if (event.tenant_id !== scope.tenantId
    || event.project_scope !== scope.projectScope
    || event.semantic_id !== scope.semanticId
    || !identifier(operationId)
    || typeof caseId !== 'string'
    || (kind !== 'coverage' && kind !== 'case')
    || (kind === 'coverage' ? caseId !== '' : !identifier(caseId))) {
    throw mismatch();
  }
  if (!EVENT_PAIRS.some((pair) => pair[0] === kind && pair[1] === action && pair[2] === state)) {
    throw mismatch();
  }
  const sequence = integer(event.sequence);
  if (sequence < 1) throw mismatch();
  const recordedAt = dateTime(event.recorded_at);
  const eventId = digest('event', scope.tenantId, scope.projectScope, scope.semanticId, operationId);
  if (event.id !== eventId) throw mismatch();
  return Object.freeze({
    eventId,
    kind: kind as EvidenceAuthorityEventKindV1,
    action: action as EvidenceAuthorityEventActionV1,
    state: state as EvidenceAuthorityCoverageStateV1 | EvidenceAuthorityCaseStateV1,
    caseId,
    sequence,
    recordedAt,
  });
}

/**
 * Full event-joined digest chain (BC-3): outbox.id and outbox.event_id are
 * both validated against the digest recomputed from the joined event's
 * operation_id. Validating outbox.id against outbox.event_id alone is
 * self-referential and trivially forgeable, and is deliberately not done.
 */
function validatePulledRow(scope: ReadScope, raw: unknown): EvidenceAuthorityOutboxRowV1 {
  const pair = properties(raw, ROW_KEYS);
  const event = validateEvent(scope, pair.event);
  const outbox = properties(pair.outbox, OUTBOX_KEYS);
  if (outbox.tenant_id !== scope.tenantId
    || outbox.project_scope !== scope.projectScope
    || outbox.semantic_id !== scope.semanticId
    || outbox.kind !== event.kind
    || outbox.action !== event.action
    || outbox.state !== event.state
    || outbox.case_id !== event.caseId) {
    throw mismatch();
  }
  if (integer(outbox.sequence) !== event.sequence) throw mismatch();
  if (dateTime(outbox.recorded_at) !== event.recordedAt) throw mismatch();
  if (outbox.event_id !== event.eventId) throw mismatch();
  const outboxId = digest('outbox', event.eventId);
  if (outbox.id !== outboxId) throw mismatch();
  // The '' sentinel is a storage detail and does not cross the module
  // boundary: normalization happens exactly once, here, only after
  // validation.
  return Object.freeze(Object.assign(Object.create(null), {
    id: outboxId,
    eventId: event.eventId,
    kind: event.kind,
    action: event.action,
    state: event.state,
    sequence: event.sequence,
    recordedAt: event.recordedAt,
    caseId: event.kind === 'coverage' ? null : event.caseId,
  })) as EvidenceAuthorityOutboxRowV1;
}

function coverageStateOf(latest: ValidatedEvent | undefined): EvidenceAuthorityReadCoverageStateV1 {
  if (latest === undefined) return 'none';
  if (latest.action === 'opened' && latest.state === 'open') return 'open';
  if (latest.action === 'revoked' && latest.state === 'revoked') return 'revoked';
  throw mismatch();
}

/** Absent-ledger handling (GAP-11): zero records is genuine emptiness. */
function ledgerVersion(result: unknown): number | null {
  const records = recordList(result);
  if (records.length === 0) return null;
  if (records.length !== 1) throw mismatch();
  return integer(safeGet(singleRecord(result), 'version'));
}

function collectedList(result: unknown, key: string): readonly unknown[] {
  const list = safeGet(singleRecord(result), key);
  if (!Array.isArray(list) || isProxy(list)) throw mismatch();
  return list;
}

/**
 * One session, one executeRead, both statements inside the one transaction
 * callback (BC-7): version and rows are one consistent snapshot. The session
 * routing hint and the transaction access mode fail independently; no prior
 * call site in this package composes both, so this is defence in depth, not
 * precedent-following.
 */
async function managedRead<T>(
  driver: Driver,
  work: (tx: ManagedTransaction) => Promise<T>,
): Promise<T> {
  let session: Session;
  try {
    session = driver.session({ defaultAccessMode: neo4j.session.READ });
  } catch {
    throw new EvidenceAuthorityLedgerError('storage_unavailable');
  }
  let result: T | undefined;
  let failure: EvidenceAuthorityLedgerError | undefined;
  try {
    result = await session.executeRead(work);
  } catch (error) {
    failure = normalizedError(error);
  }
  try {
    await session.close();
  } catch (error) {
    // A close failure never replaces a more specific domain failure.
    failure ??= normalizedError(error);
  }
  if (failure) throw failure;
  return result as T;
}

export function createEvidenceAuthorityRead(
  driver: Driver,
  scope: unknown,
): EvidenceAuthorityReadV1 {
  const parsed = parseReadScope(scope);
  const queryParams = Object.freeze({
    tenantId: parsed.tenantId,
    projectScope: parsed.projectScope,
    semanticId: parsed.semanticId,
    ledgerId: parsed.ledgerId,
  });

  const listCases = async (): Promise<EvidenceAuthorityCaseListingV1> => managedRead(driver, async (tx) => {
    const observedVersion = ledgerVersion(await tx.run(LEDGER_VERSION_QUERY, queryParams));
    if (observedVersion === null) return EMPTY_LISTING;
    const rawEvents = collectedList(await tx.run(LISTING_EVENTS_QUERY, queryParams), 'events');
    const validated = rawEvents.map((raw) => validateEvent(parsed, raw));
    for (const event of validated) {
      if (event.sequence > observedVersion) throw mismatch();
    }
    // The module sorts by sequence itself and never trusts arrival order;
    // duplicated sequences make "latest" ambiguous and are refused.
    const ordered = [...validated].sort((left, right) => left.sequence - right.sequence);
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index]!.sequence === ordered[index - 1]!.sequence) throw mismatch();
    }
    const coverageChain = ordered.filter((event) => event.kind === 'coverage');
    const coverageState = coverageStateOf(coverageChain[coverageChain.length - 1]);
    const latestCaseStates = Object.create(null) as Record<string, EvidenceAuthorityCaseStateV1>;
    for (const event of ordered) {
      if (event.kind === 'case') {
        latestCaseStates[event.caseId] = event.state as EvidenceAuthorityCaseStateV1;
      }
    }
    // Ascending case_id truncation prefix: state-independent and
    // deterministic (BC-8).
    const caseIds = Object.keys(latestCaseStates).sort();
    const cases = Object.create(null) as Record<string, EvidenceAuthorityCaseStateV1>;
    for (const caseId of caseIds.slice(0, MAX_LISTED_CASES)) {
      cases[caseId] = latestCaseStates[caseId]!;
    }
    return Object.freeze(Object.assign(Object.create(null), {
      contractVersion: EVIDENCE_AUTHORITY_READ_VERSION,
      coverageState,
      cases: Object.freeze(cases),
      truncated: caseIds.length > MAX_LISTED_CASES,
      observedVersion,
    })) as EvidenceAuthorityCaseListingV1;
  });

  const pullOutbox = async (request: unknown): Promise<EvidenceAuthorityOutboxPageV1> => {
    const command = parsePullRequest(request);
    return managedRead(driver, async (tx) => {
      const observedVersion = ledgerVersion(await tx.run(LEDGER_VERSION_QUERY, queryParams));
      if (observedVersion === null) return EMPTY_PAGE;
      const rawRows = collectedList(await tx.run(PULL_ROWS_QUERY, {
        tenantId: parsed.tenantId,
        projectScope: parsed.projectScope,
        semanticId: parsed.semanticId,
        ledgerId: parsed.ledgerId,
        afterSequence: neo4j.int(command.afterSequence),
        limit: neo4j.int(command.limit),
      }), 'rows');
      if (rawRows.length > command.limit) throw mismatch();
      const rows: EvidenceAuthorityOutboxRowV1[] = [];
      let previousSequence = command.afterSequence;
      for (const raw of rawRows) {
        const row = validatePulledRow(parsed, raw);
        // Client-side strictly-ascending assertion: the driver's ORDER BY and
        // cursor predicate are untrusted.
        if (row.sequence <= previousSequence || row.sequence > observedVersion) throw mismatch();
        previousSequence = row.sequence;
        rows.push(row);
      }
      return Object.freeze(Object.assign(Object.create(null), {
        contractVersion: EVIDENCE_AUTHORITY_READ_VERSION,
        rows: Object.freeze(rows),
        observedVersion,
      })) as EvidenceAuthorityOutboxPageV1;
    });
  };

  return Object.freeze(Object.assign(Object.create(null), {
    contractVersion: EVIDENCE_AUTHORITY_READ_VERSION,
    listCases,
    pullOutbox,
  })) as EvidenceAuthorityReadV1;
}
