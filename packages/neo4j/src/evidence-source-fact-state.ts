/**
 * RET-005B-AUTH-001B5: current-frame Fact state observation.
 *
 * This module observes raw, source-owned state for a bounded list of Fact ids
 * under one construction-bound (tenant, project, entity) triple. It is not
 * authentication and it is not authorization: it verifies no human, actor,
 * role, or permission, and it performs no access check of any kind. It confers
 * no containment whatsoever. What it owns is one thing: every value it returns
 * was read out of the graph in one read transaction, and no value it returns
 * was defaulted, inferred, or invented.
 *
 * The vocabulary here is deliberately the source's own - a status token, a
 * valid-time boolean, and a supersession boolean. Mapping those onto the
 * published eligibility axes belongs to the composition module in the contract
 * package, which this module never imports and cannot see. That separation is
 * load-bearing: an axis token minted here would be a policy claim made by a
 * reader, and the composition's fabrication tripwire would have two places to
 * look instead of one.
 *
 * Current frame means one snapshot, read once, stale the moment it returns.
 * Nothing is cached, nothing is remembered between calls, and no consumer may
 * memoize an observation: a snapshot carries no version binding of any kind,
 * so a retained entry is a claim about a frame that has already passed.
 *
 * Valid time is compared against the application process clock, read exactly
 * once per call, because every Fact valid time in this codebase is written by
 * that same clock. The graph server clock is deliberately not used: its
 * rendered form carries nine fractional digits, which is not the canonical
 * millisecond form this lane validates, and which sorts before an equal
 * millisecond application instant when compared as text.
 *
 * Every refusal is unconditional and value-free: an absent candidate, a status
 * outside the three known ones, an unusable time, an unreadable row shape, and
 * a historical request all produce a fixed code carrying no tenant, project,
 * entity, id, status, or time value. A historical request is refused before
 * any driver call is made; this module has no historical authority.
 *
 * The project scope is parsed and bound for identity discipline only. It is
 * provably not a query filter here: a Fact scope is a category, not a project
 * tag, so fact containment is the tenant and the resolved entity, and that
 * limitation is disclosed rather than papered over with a filter that would
 * silently drop every real row.
 *
 * This module writes nothing, takes no lock, holds no cursor, accepts no scope
 * per call, and is absent from the package root export.
 */
import { isProxy } from 'node:util/types';

import neo4j, { type Driver, type Session } from 'neo4j-driver';

import { resolveTenant, tenantWhere } from './tenant.js';

export const EVIDENCE_SOURCE_FACT_STATE_VERSION =
  'memberry.evidence-source-fact-state/1.0.0' as const;

export type EvidenceSourceFactStateUnsupportedCodeV1 =
  | 'fact-state-source-unavailable'
  | 'fact-state-frame-unsupported'
  | 'fact-state-candidate-missing'
  | 'fact-state-status-unrecognized'
  | 'fact-state-time-unusable';

export interface EvidenceSourceFactStateEntryV1 {
  readonly evidenceId: string;
  readonly status: 'active' | 'invalidated' | 'disputed';
  readonly withinValidTime: boolean;
  readonly superseded: boolean;
}

export interface EvidenceSourceFactStateObservedV1 {
  readonly contractVersion: typeof EVIDENCE_SOURCE_FACT_STATE_VERSION;
  readonly outcome: 'observed';
  readonly observedAt: string;
  readonly entries: readonly EvidenceSourceFactStateEntryV1[];
}

export interface EvidenceSourceFactStateUnsupportedV1 {
  readonly contractVersion: typeof EVIDENCE_SOURCE_FACT_STATE_VERSION;
  readonly outcome: 'unsupported';
  readonly code: EvidenceSourceFactStateUnsupportedCodeV1;
}

export type EvidenceSourceFactStateResultV1 =
  | EvidenceSourceFactStateObservedV1
  | EvidenceSourceFactStateUnsupportedV1;

export interface EvidenceSourceFactStateRequestV1 {
  readonly mode: 'current' | 'as-of';
  readonly evidenceIds: readonly string[];
}

export interface EvidenceSourceFactStateV1 {
  readonly contractVersion: typeof EVIDENCE_SOURCE_FACT_STATE_VERSION;
  observeFactState(request: unknown): Promise<EvidenceSourceFactStateResultV1>;
}

/**
 * Caller-fault failures. A malformed scope, a malformed request, and a
 * duplicate id are defects in the calling code, never observations, so they
 * throw instead of becoming a policy answer. The message carries a fixed code
 * and no input value.
 */
class EvidenceSourceFactStateError extends Error {
  declare readonly code: 'invalid_scope' | 'invalid_command';

  constructor(code: 'invalid_scope' | 'invalid_command') {
    super(`evidence_source_fact_state:${code}`);
    Object.defineProperty(this, 'name', {
      value: 'EvidenceSourceFactStateError',
      writable: true,
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(this, 'code', {
      value: code,
      writable: false,
      enumerable: true,
      configurable: false,
    });
  }
}

// Sibling-precedent input bounds (evidence-authority-clearance.ts), reused
// unchanged so the hostile scope corpus behaves identically across the lane.
const MAX_INPUT_LENGTH = 500;
const PROJECT_SCOPE = /^project:[a-z0-9][a-z0-9._-]*$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
// Hand copies of unexported contract constants. Duplication is intended, not
// tolerated: the contract package exports none of these and this module may
// not import that package at all, so each copy is source-pinned against the
// contract literal by the unit suite.
const CANONICAL_INSTANT = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
const SAFE_EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/;
const MAX_EVIDENCE_ID_LENGTH = 200;
// One observation can never be asked for more ids than the contract admits
// candidates; the cap is the contract's, hand-copied and pinned.
const MAX_OBSERVED_CANDIDATES = 128;
const SCOPE_KEYS = Object.freeze(['tenantId', 'projectScope', 'resolvedEntityId'] as const);
const REQUEST_KEYS = Object.freeze(['mode', 'evidenceIds'] as const);
// Positive whitelist (never a blacklist): any status value outside these three
// refuses, including vocabulary that does not exist yet.
const FACT_STATUS_WHITELIST = Object.freeze(['active', 'invalidated', 'disputed'] as const);

/** Fixed, value-free unsupported results. No input value ever enters one. */
const SOURCE_UNAVAILABLE = Object.freeze(Object.assign(Object.create(null), {
  contractVersion: EVIDENCE_SOURCE_FACT_STATE_VERSION,
  outcome: 'unsupported',
  code: 'fact-state-source-unavailable',
})) as EvidenceSourceFactStateUnsupportedV1;

const FRAME_UNSUPPORTED = Object.freeze(Object.assign(Object.create(null), {
  contractVersion: EVIDENCE_SOURCE_FACT_STATE_VERSION,
  outcome: 'unsupported',
  code: 'fact-state-frame-unsupported',
})) as EvidenceSourceFactStateUnsupportedV1;

const CANDIDATE_MISSING = Object.freeze(Object.assign(Object.create(null), {
  contractVersion: EVIDENCE_SOURCE_FACT_STATE_VERSION,
  outcome: 'unsupported',
  code: 'fact-state-candidate-missing',
})) as EvidenceSourceFactStateUnsupportedV1;

const STATUS_UNRECOGNIZED = Object.freeze(Object.assign(Object.create(null), {
  contractVersion: EVIDENCE_SOURCE_FACT_STATE_VERSION,
  outcome: 'unsupported',
  code: 'fact-state-status-unrecognized',
})) as EvidenceSourceFactStateUnsupportedV1;

const TIME_UNUSABLE = Object.freeze(Object.assign(Object.create(null), {
  contractVersion: EVIDENCE_SOURCE_FACT_STATE_VERSION,
  outcome: 'unsupported',
  code: 'fact-state-time-unusable',
})) as EvidenceSourceFactStateUnsupportedV1;

interface FactStateScope {
  readonly tenantId: string;
  readonly projectScope: string;
  readonly resolvedEntityId: string;
}

/** Byte budget first, charset second. */
function boundedMatch(value: unknown, pattern: RegExp, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && pattern.test(value);
}

function strictRecord(
  value: unknown,
  code: 'invalid_scope' | 'invalid_command',
  expected: readonly string[],
): Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
      throw new EvidenceSourceFactStateError(code);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new EvidenceSourceFactStateError(code);
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== expected.length
      || ownKeys.some((key) => typeof key !== 'string' || !expected.includes(key))) {
      throw new EvidenceSourceFactStateError(code);
    }
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        throw new EvidenceSourceFactStateError(code);
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    throw new EvidenceSourceFactStateError(code);
  }
}

/**
 * Scope is bound exactly once, at construction; an invalid scope throws so no
 * half-built object escapes and no scope value is reachable afterwards.
 */
function parseFactStateScope(value: unknown): FactStateScope {
  const input = strictRecord(value, 'invalid_scope', SCOPE_KEYS);
  if (!boundedMatch(input.tenantId, IDENTIFIER, MAX_INPUT_LENGTH)
    || !boundedMatch(input.projectScope, PROJECT_SCOPE, MAX_INPUT_LENGTH)
    || !boundedMatch(input.resolvedEntityId, IDENTIFIER, MAX_INPUT_LENGTH)) {
    throw new EvidenceSourceFactStateError('invalid_scope');
  }
  return Object.freeze(Object.assign(Object.create(null), {
    tenantId: input.tenantId,
    projectScope: input.projectScope,
    resolvedEntityId: input.resolvedEntityId,
  })) as FactStateScope;
}

/**
 * Exactly two keys. A malformed request is a caller defect and throws with
 * zero driver calls; a duplicate id throws for the same reason, because the
 * caller's own contract already forbids duplicates and a silently collapsed
 * list would answer fewer ids than were asked about.
 */
function parseFactStateRequest(value: unknown): EvidenceSourceFactStateRequestV1 {
  const input = strictRecord(value, 'invalid_command', REQUEST_KEYS);
  const mode = input.mode;
  if (mode !== 'current' && mode !== 'as-of') {
    throw new EvidenceSourceFactStateError('invalid_command');
  }
  const rawIds = input.evidenceIds;
  if (!Array.isArray(rawIds) || isProxy(rawIds) || rawIds.length > MAX_OBSERVED_CANDIDATES) {
    throw new EvidenceSourceFactStateError('invalid_command');
  }
  const evidenceIds = new Array<string>(rawIds.length);
  for (let index = 0; index < rawIds.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(rawIds, String(index));
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      throw new EvidenceSourceFactStateError('invalid_command');
    }
    const id = descriptor.value;
    if (!boundedMatch(id, SAFE_EVIDENCE_ID, MAX_EVIDENCE_ID_LENGTH)) {
      throw new EvidenceSourceFactStateError('invalid_command');
    }
    for (let prior = 0; prior < index; prior += 1) {
      if (evidenceIds[prior] === id) throw new EvidenceSourceFactStateError('invalid_command');
    }
    evidenceIds[index] = id;
  }
  return Object.freeze(Object.assign(Object.create(null), {
    mode,
    evidenceIds: Object.freeze(evidenceIds),
  })) as EvidenceSourceFactStateRequestV1;
}

/**
 * The one application-clock read of a call, by name. Every downstream time
 * decision - valid-time containment and the reported observation instant -
 * uses this single value, so no two answers in one result can disagree about
 * when they were taken. A non-canonical instant is refused, never coerced.
 */
function observationInstant(): string | null {
  const instant = new Date().toISOString();
  return CANONICAL_INSTANT.test(instant) ? instant : null;
}

/**
 * Hand copy of the audited reader's driver-integer normalizer, returning null
 * instead of throwing so a malformed count falls to a refusal. The proxy guard
 * is load-bearing: a forged counter must never reach the comparison floor.
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

function absent(value: unknown): boolean {
  return value === null || value === undefined;
}

/** The lane's canonical instant, exact width and exact shape, never coerced. */
function canonicalTime(value: unknown): value is string {
  return typeof value === 'string'
    && value.length === 24
    && CANONICAL_INSTANT.test(value);
}

function entryOf(
  evidenceId: string,
  status: 'active' | 'invalidated' | 'disputed',
  withinValidTime: boolean,
  superseded: boolean,
): EvidenceSourceFactStateEntryV1 {
  return Object.freeze(Object.assign(Object.create(null), {
    evidenceId,
    status,
    withinValidTime,
    superseded,
  })) as EvidenceSourceFactStateEntryV1;
}

function observedResult(
  observedAt: string,
  entries: readonly EvidenceSourceFactStateEntryV1[],
): EvidenceSourceFactStateObservedV1 {
  return Object.freeze(Object.assign(Object.create(null), {
    contractVersion: EVIDENCE_SOURCE_FACT_STATE_VERSION,
    outcome: 'observed',
    observedAt,
    entries,
  })) as EvidenceSourceFactStateObservedV1;
}

/** Defensive own-data read of one driver record; anything hostile is absent. */
function rowValue(record: unknown, key: string): unknown {
  try {
    if (typeof record !== 'object' || record === null || isProxy(record)) return undefined;
    const getter = (record as { get?: unknown }).get;
    if (typeof getter !== 'function') return undefined;
    return (record as { get(name: string): unknown }).get(key);
  } catch {
    return undefined;
  }
}

export function createEvidenceSourceFactState(
  driver: Driver,
  scope: unknown,
): EvidenceSourceFactStateV1 {
  const parsed = parseFactStateScope(scope);
  const tenant = resolveTenant(parsed.tenantId);
  // One statement, built once from the bound triple. The carried index makes
  // row order deterministic, so the row-order equality asserted below is a
  // real regression guard instead of a nondeterministic refusal of a valid
  // batch. The supersession leg counts inbound edges from tenant-visible
  // Facts only; an edge from a foreign tenant can never raise a count here.
  const observeQuery = `UNWIND range(0, size($evidenceIds) - 1) AS idx
WITH idx, $evidenceIds[idx] AS eid
OPTIONAL MATCH (f:Fact {id: eid})
  WHERE f.entity_id = $resolvedEntityId AND ${tenantWhere('f', tenant)}
WITH idx, eid, f
OPTIONAL MATCH (s:Fact)-[:SUPERSEDES_FACT]->(f)
  WHERE ${tenantWhere('s', tenant)}
WITH idx, eid, f, count(s) AS supersedingCount
RETURN eid AS evidenceId,
       f.status AS status,
       f.valid_at AS validAt,
       f.invalid_at AS invalidAt,
       supersedingCount
ORDER BY idx`;

  /**
   * One READ-mode session, one statement, closed in a finally. Returns null
   * when anything at all goes wrong on the wire; no failure value, message,
   * or cause is ever carried out of here.
   */
  const readRows = async (evidenceIds: readonly string[]): Promise<readonly unknown[] | null> => {
    let session: Session;
    try {
      session = driver.session({ defaultAccessMode: neo4j.session.READ });
    } catch {
      return null;
    }
    try {
      const result = await session.run(observeQuery, {
        evidenceIds,
        resolvedEntityId: parsed.resolvedEntityId,
        tenantId: tenant,
      });
      const records = (result as { records?: unknown }).records;
      if (!Array.isArray(records) || isProxy(records)) return null;
      return records;
    } catch {
      return null;
    } finally {
      try {
        await session.close();
      } catch {
        // Cleanup never manufactures or replaces an observation.
      }
    }
  };

  const observeFactState = async (
    request: unknown,
  ): Promise<EvidenceSourceFactStateResultV1> => {
    const command = parseFactStateRequest(request);
    // No historical authority of any kind; refused before any driver call.
    if (command.mode === 'as-of') return FRAME_UNSUPPORTED;

    const observedAt = observationInstant();
    if (observedAt === null) return TIME_UNUSABLE;

    const records = await readRows(command.evidenceIds);
    if (records === null) return SOURCE_UNAVAILABLE;
    // Row count and row order are asserted, never assumed from the statement.
    if (records.length !== command.evidenceIds.length) return SOURCE_UNAVAILABLE;

    const entries = new Array<EvidenceSourceFactStateEntryV1>(records.length);
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      const evidenceId = command.evidenceIds[index]!;
      if (rowValue(record, 'evidenceId') !== evidenceId) return SOURCE_UNAVAILABLE;
      const status = rowValue(record, 'status');
      const validAt = rowValue(record, 'validAt');
      const invalidAt = rowValue(record, 'invalidAt');
      // An absent candidate is every property absent at once: the optional
      // leg matched nothing, in this tenant, on this entity.
      if (absent(status) && absent(validAt) && absent(invalidAt)) return CANDIDATE_MISSING;
      if (typeof status !== 'string'
        || !(FACT_STATUS_WHITELIST as readonly string[]).includes(status)) {
        return STATUS_UNRECOGNIZED;
      }
      if (!canonicalTime(validAt)) return TIME_UNUSABLE;
      const closed = !absent(invalidAt);
      if (closed && !canonicalTime(invalidAt)) return TIME_UNUSABLE;
      const count = normalizedCount(rowValue(record, 'supersedingCount'));
      if (count === null) return SOURCE_UNAVAILABLE;
      // Canonical fixed-width instants written by one clock compare as text
      // exactly as they compare as instants. Containment is inclusive on the
      // opening bound and strict on the closing one.
      const withinValidTime = validAt <= observedAt
        && (!closed || (invalidAt as string) > observedAt);
      entries[index] = entryOf(
        evidenceId,
        status as 'active' | 'invalidated' | 'disputed',
        withinValidTime,
        count > 0,
      );
    }

    return observedResult(observedAt, Object.freeze(entries));
  };

  return Object.freeze(Object.assign(Object.create(null), {
    contractVersion: EVIDENCE_SOURCE_FACT_STATE_VERSION,
    observeFactState,
  })) as EvidenceSourceFactStateV1;
}
