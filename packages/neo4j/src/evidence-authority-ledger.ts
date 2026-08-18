import { createHash } from 'node:crypto';
import { types as nodeUtilTypes } from 'node:util';

import neo4j, { type Driver, type ManagedTransaction, type Session } from 'neo4j-driver';

export const EVIDENCE_AUTHORITY_LEDGER_VERSION =
  'memberry.evidence-authority-ledger/1.0.0' as const;

const ID_DOMAIN = 'memberry-evidence-authority-ledger-v1';
const MAX_IDENTIFIER_LENGTH = 500;
const PROJECT_SCOPE = /^project:[a-z0-9][a-z0-9._-]*$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const COVERAGE_TARGET_KEYS = [
  'id', 'tenant_id', 'project_scope', 'semantic_id', 'created_at',
] as const;
const CASE_TARGET_KEYS = [
  'id', 'tenant_id', 'project_scope', 'semantic_id', 'coverage_id', 'case_id', 'created_at',
] as const;
const LEDGER_KEYS = [
  'id', 'tenant_id', 'project_scope', 'semantic_id', 'version', 'locked',
] as const;
const EVENT_KEYS = [
  'id', 'tenant_id', 'project_scope', 'semantic_id', 'case_id', 'operation_id',
  'kind', 'action', 'state', 'sequence', 'recorded_at',
] as const;
const OUTBOX_KEYS = [
  'id', 'event_id', 'tenant_id', 'project_scope', 'semantic_id', 'case_id',
  'kind', 'action', 'state', 'sequence', 'recorded_at',
] as const;

export interface EvidenceAuthorityScopeV1 {
  readonly tenantId: string;
  readonly projectScope: string;
  readonly semanticId: string;
}

export interface EvidenceAuthorityOperationV1 {
  readonly operationId: string;
}

export interface EvidenceAuthorityOpenCaseOperationV1 extends EvidenceAuthorityOperationV1 {
  readonly caseId: string;
}

export type EvidenceAuthorityCoverageStateV1 = 'open' | 'revoked';
export type EvidenceAuthorityCaseStateV1 = 'pending' | 'rejected' | 'resolving' | 'resolved';
export type EvidenceAuthorityEventKindV1 = 'coverage' | 'case';
export type EvidenceAuthorityEventActionV1 =
  | 'opened'
  | 'revoked'
  | 'case_opened'
  | 'rejected'
  | 'resolution_started'
  | 'resolved';

export interface EvidenceAuthorityEventReceiptV1 {
  readonly contractVersion: typeof EVIDENCE_AUTHORITY_LEDGER_VERSION;
  readonly kind: EvidenceAuthorityEventKindV1;
  readonly action: EvidenceAuthorityEventActionV1;
  readonly state: EvidenceAuthorityCoverageStateV1 | EvidenceAuthorityCaseStateV1;
  readonly sequence: number;
  readonly recordedAt: string;
}

declare const COVERAGE_FACET_BRAND: unique symbol;
declare const CASE_FACET_BRAND: unique symbol;
declare const CAPTURE_FACET_BRAND: unique symbol;
declare const REVIEW_FACET_BRAND: unique symbol;

/** Package-internal enrollment authority. It is deliberately absent from the package root export. */
export interface EvidenceAuthorityCaptureFacetV1 {
  readonly contractVersion: typeof EVIDENCE_AUTHORITY_LEDGER_VERSION;
  readonly [CAPTURE_FACET_BRAND]: true;
}

/** Package-internal transition authority. It is deliberately absent from the package root export. */
export interface EvidenceAuthorityReviewFacetV1 {
  readonly contractVersion: typeof EVIDENCE_AUTHORITY_LEDGER_VERSION;
  readonly [REVIEW_FACET_BRAND]: true;
}

/** Opaque, frozen, process-local capability. Runtime authenticity is WeakMap sealed. */
export interface EvidenceAuthorityCoverageFacetV1 {
  readonly contractVersion: typeof EVIDENCE_AUTHORITY_LEDGER_VERSION;
  readonly [COVERAGE_FACET_BRAND]: true;
}

/** Opaque, frozen, process-local capability. Runtime authenticity is WeakMap sealed. */
export interface EvidenceAuthorityCaseFacetV1 {
  readonly contractVersion: typeof EVIDENCE_AUTHORITY_LEDGER_VERSION;
  readonly [CASE_FACET_BRAND]: true;
}

export interface EvidenceAuthorityCoverageOpenResultV1 {
  readonly facet: EvidenceAuthorityCoverageFacetV1;
  readonly receipt: EvidenceAuthorityEventReceiptV1;
}

export interface EvidenceAuthorityCaseOpenResultV1 {
  readonly facet: EvidenceAuthorityCaseFacetV1;
  readonly receipt: EvidenceAuthorityEventReceiptV1;
}

export type EvidenceAuthorityLedgerErrorCode =
  | 'invalid_scope'
  | 'invalid_command'
  | 'invalid_facet'
  | 'facet_scope_mismatch'
  | 'facet_revoked'
  | 'semantic_not_found'
  | 'coverage_missing'
  | 'case_missing'
  | 'invalid_transition'
  | 'operation_conflict'
  | 'existing_state_mismatch'
  | 'write_incomplete'
  | 'storage_unavailable';

const ERROR_CODES = new Set<EvidenceAuthorityLedgerErrorCode>([
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
]);

/** Fixed, value-free failures. Tenant/project/Semantic/case values never enter messages. */
export class EvidenceAuthorityLedgerError extends Error {
  constructor(readonly code: EvidenceAuthorityLedgerErrorCode) {
    super(`evidence_authority_ledger:${code}`);
    this.name = 'EvidenceAuthorityLedgerError';
  }
}

interface ScopeInternal extends EvidenceAuthorityScopeV1 {
  readonly ledgerId: string;
  readonly coverageId: string;
}

interface CoverageFacetMetadata {
  readonly storeToken: object;
  readonly scope: ScopeInternal;
}

interface CaseFacetMetadata extends CoverageFacetMetadata {
  readonly caseId: string;
  readonly caseNodeId: string;
}

const coverageFacets = new WeakMap<object, CoverageFacetMetadata>();
const caseFacets = new WeakMap<object, CaseFacetMetadata>();
const captureFacets = new WeakMap<object, CoverageFacetMetadata>();
const reviewFacets = new WeakMap<object, CoverageFacetMetadata>();
const storeMetadata = new WeakMap<object, {
  readonly driver: Driver;
  readonly storeToken: object;
}>();

interface OperationSpec {
  readonly scope: ScopeInternal;
  readonly operationId: string;
  readonly eventId: string;
  readonly outboxId: string;
  readonly kind: EvidenceAuthorityEventKindV1;
  readonly action: EvidenceAuthorityEventActionV1;
  readonly state: EvidenceAuthorityCoverageStateV1 | EvidenceAuthorityCaseStateV1;
  readonly caseId: string;
  readonly caseNodeId: string;
  readonly createTarget: 'coverage' | 'case' | null;
  readonly allowedPreviousState: string | null;
}

interface OperationResult {
  readonly receipt: EvidenceAuthorityEventReceiptV1;
  readonly target: Record<string, unknown>;
}

export interface EvidenceAuthorityLedgerPersistenceV1 {
  openCoverage(
    captureFacet: unknown,
    scope: unknown,
    operation: unknown,
  ): Promise<EvidenceAuthorityCoverageOpenResultV1>;
  revokeCoverage(
    reviewFacet: unknown,
    facet: unknown,
    scope: unknown,
    operation: unknown,
  ): Promise<EvidenceAuthorityEventReceiptV1>;
  openCase(
    captureFacet: unknown,
    facet: unknown,
    scope: unknown,
    operation: unknown,
  ): Promise<EvidenceAuthorityCaseOpenResultV1>;
  rejectCase(
    reviewFacet: unknown,
    facet: unknown,
    scope: unknown,
    operation: unknown,
  ): Promise<EvidenceAuthorityEventReceiptV1>;
  beginResolution(
    reviewFacet: unknown,
    facet: unknown,
    scope: unknown,
    operation: unknown,
  ): Promise<EvidenceAuthorityEventReceiptV1>;
  resolveCase(
    reviewFacet: unknown,
    facet: unknown,
    scope: unknown,
    operation: unknown,
  ): Promise<EvidenceAuthorityEventReceiptV1>;
}

function isLedgerError(value: unknown): value is EvidenceAuthorityLedgerError {
  try {
    return value instanceof EvidenceAuthorityLedgerError;
  } catch {
    return false;
  }
}

function normalizedError(
  value: unknown,
  fallback: EvidenceAuthorityLedgerErrorCode,
): EvidenceAuthorityLedgerError {
  if (isLedgerError(value)) {
    try {
      if (ERROR_CODES.has(value.code)) return new EvidenceAuthorityLedgerError(value.code);
    } catch {
      // A hostile Error subclass is normalized below.
    }
  }
  return new EvidenceAuthorityLedgerError(fallback);
}

function strictRecord(
  value: unknown,
  code: 'invalid_scope' | 'invalid_command',
): Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
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
  } catch (error) {
    throw normalizedError(error, code);
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

function parseScope(value: unknown): ScopeInternal {
  const input = strictRecord(value, 'invalid_scope');
  exactKeys(input, ['tenantId', 'projectScope', 'semanticId'], 'invalid_scope');
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
    coverageId: digest('coverage', tenantId, projectScope, semanticId),
  });
}

function parseOperation(value: unknown): EvidenceAuthorityOperationV1 {
  const input = strictRecord(value, 'invalid_command');
  exactKeys(input, ['operationId'], 'invalid_command');
  if (!identifier(input.operationId)) throw new EvidenceAuthorityLedgerError('invalid_command');
  return Object.freeze({ operationId: input.operationId });
}

function parseOpenCaseOperation(value: unknown): EvidenceAuthorityOpenCaseOperationV1 {
  const input = strictRecord(value, 'invalid_command');
  exactKeys(input, ['caseId', 'operationId'], 'invalid_command');
  if (!identifier(input.caseId) || !identifier(input.operationId)) {
    throw new EvidenceAuthorityLedgerError('invalid_command');
  }
  return Object.freeze({ caseId: input.caseId, operationId: input.operationId });
}

function sameScope(left: EvidenceAuthorityScopeV1, right: EvidenceAuthorityScopeV1): boolean {
  return left.tenantId === right.tenantId
    && left.projectScope === right.projectScope
    && left.semanticId === right.semanticId;
}

function facetObject(value: unknown): object {
  try {
    if (typeof value !== 'object' || value === null || nodeUtilTypes.isProxy(value)) {
      throw new EvidenceAuthorityLedgerError('invalid_facet');
    }
    return value;
  } catch (error) {
    throw normalizedError(error, 'invalid_facet');
  }
}

function newFacet<T extends object>(): T {
  const facet = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(facet, 'contractVersion', {
    value: EVIDENCE_AUTHORITY_LEDGER_VERSION,
    enumerable: true,
    configurable: false,
    writable: false,
  });
  return Object.freeze(facet) as T;
}

function sealedResult<T extends object>(facet: T, receipt: EvidenceAuthorityEventReceiptV1) {
  return Object.freeze(Object.assign(Object.create(null), { facet, receipt }));
}

function properties(
  value: unknown,
  keys: readonly string[],
  code: 'existing_state_mismatch' | 'write_incomplete',
): Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
      throw new EvidenceAuthorityLedgerError(code);
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length
      || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) {
      throw new EvidenceAuthorityLedgerError(code);
    }
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        throw new EvidenceAuthorityLedgerError(code);
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch (error) {
    throw normalizedError(error, code);
  }
}

function integer(value: unknown, code: 'existing_state_mismatch' | 'write_incomplete'): number {
  try {
    let parsed: number;
    if (typeof value === 'number') parsed = value;
    else if (typeof value === 'bigint') parsed = Number(value);
    else if (typeof value === 'object' && value !== null && !nodeUtilTypes.isProxy(value)
      && neo4j.isInt(value)) {
      parsed = (value as { toNumber(): number }).toNumber();
    } else parsed = Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new EvidenceAuthorityLedgerError(code);
    return parsed;
  } catch (error) {
    throw normalizedError(error, code);
  }
}

function dateTime(value: unknown, code: 'existing_state_mismatch' | 'write_incomplete'): string {
  try {
    const result = typeof value === 'string' ? value : '';
    if (!/^\d{4}-\d{2}-\d{2}T/.test(result) || !Number.isFinite(Date.parse(result))) {
      throw new EvidenceAuthorityLedgerError(code);
    }
    return result;
  } catch (error) {
    throw normalizedError(error, code);
  }
}

function singleRecord(
  value: unknown,
  code: 'existing_state_mismatch' | 'write_incomplete',
): { get(key: string): unknown } {
  try {
    const records = (value as { records?: unknown }).records;
    if (!Array.isArray(records) || records.length !== 1) {
      throw new EvidenceAuthorityLedgerError(code);
    }
    const current = records[0] as { get?: unknown };
    if (current === null || typeof current !== 'object' || nodeUtilTypes.isProxy(current)
      || typeof current.get !== 'function') {
      throw new EvidenceAuthorityLedgerError(code);
    }
    return current as { get(key: string): unknown };
  } catch (error) {
    throw normalizedError(error, code);
  }
}

function safeGet(
  record: { get(key: string): unknown },
  key: string,
  code: 'existing_state_mismatch' | 'write_incomplete',
): unknown {
  try {
    return record.get(key);
  } catch (error) {
    throw normalizedError(error, code);
  }
}

function expectedTarget(
  spec: OperationSpec,
  target: Record<string, unknown>,
  code: 'existing_state_mismatch' | 'write_incomplete' = 'existing_state_mismatch',
): void {
  const keys = spec.kind === 'coverage' ? COVERAGE_TARGET_KEYS : CASE_TARGET_KEYS;
  const parsed = properties(target, keys, code);
  if (parsed.id !== (spec.kind === 'coverage' ? spec.scope.coverageId : spec.caseNodeId)
    || parsed.tenant_id !== spec.scope.tenantId
    || parsed.project_scope !== spec.scope.projectScope
    || parsed.semantic_id !== spec.scope.semanticId
    || (spec.kind === 'case' && (
      parsed.coverage_id !== spec.scope.coverageId || parsed.case_id !== spec.caseId
    ))) {
    throw new EvidenceAuthorityLedgerError(code);
  }
  dateTime(parsed.created_at, code);
}

function validateStored(
  spec: OperationSpec,
  rawEvent: unknown,
  rawOutbox: unknown,
  rawTarget: unknown,
  code: 'existing_state_mismatch' | 'write_incomplete',
): OperationResult {
  const event = properties(rawEvent, EVENT_KEYS, code);
  const outbox = properties(rawOutbox, OUTBOX_KEYS, code);
  const target = properties(
    rawTarget,
    spec.kind === 'coverage' ? COVERAGE_TARGET_KEYS : CASE_TARGET_KEYS,
    code,
  );
  const sequence = integer(event.sequence, code);
  const outboxSequence = integer(outbox.sequence, code);
  if (sequence < 1) throw new EvidenceAuthorityLedgerError(code);
  if (outboxSequence !== sequence) throw new EvidenceAuthorityLedgerError(code);
  const recordedAt = dateTime(event.recorded_at, code);
  const outboxRecordedAt = dateTime(outbox.recorded_at, code);
  if (outboxRecordedAt !== recordedAt) throw new EvidenceAuthorityLedgerError(code);
  const expectedEvent = {
    id: spec.eventId,
    tenant_id: spec.scope.tenantId,
    project_scope: spec.scope.projectScope,
    semantic_id: spec.scope.semanticId,
    case_id: spec.caseId,
    operation_id: spec.operationId,
    kind: spec.kind,
    action: spec.action,
    state: spec.state,
  } as const;
  for (const [key, expected] of Object.entries(expectedEvent)) {
    if (event[key] !== expected) {
      throw new EvidenceAuthorityLedgerError(code === 'existing_state_mismatch' ? 'operation_conflict' : code);
    }
  }
  const expectedOutbox = {
    id: spec.outboxId,
    event_id: spec.eventId,
    tenant_id: spec.scope.tenantId,
    project_scope: spec.scope.projectScope,
    semantic_id: spec.scope.semanticId,
    case_id: spec.caseId,
    kind: spec.kind,
    action: spec.action,
    state: spec.state,
  } as const;
  for (const [key, expected] of Object.entries(expectedOutbox)) {
    if (outbox[key] !== expected) throw new EvidenceAuthorityLedgerError(code);
  }
  expectedTarget(spec, target, code);
  if (spec.createTarget !== null && dateTime(target.created_at, code) !== recordedAt) {
    throw new EvidenceAuthorityLedgerError(code);
  }
  const receipt = Object.freeze(Object.assign(Object.create(null), {
    contractVersion: EVIDENCE_AUTHORITY_LEDGER_VERSION,
    kind: spec.kind,
    action: spec.action,
    state: spec.state,
    sequence,
    recordedAt,
  })) as EvidenceAuthorityEventReceiptV1;
  return Object.freeze({ receipt, target });
}

function validateLatestStateEvent(
  spec: OperationSpec,
  rawEvent: unknown,
  targetKind: 'coverage' | 'case',
  ledgerVersion: number,
): string {
  const event = properties(rawEvent, EVENT_KEYS, 'existing_state_mismatch');
  const sequence = integer(event.sequence, 'existing_state_mismatch');
  if (sequence < 1 || sequence > ledgerVersion
    || event.tenant_id !== spec.scope.tenantId
    || event.project_scope !== spec.scope.projectScope
    || event.semantic_id !== spec.scope.semanticId
    || event.kind !== targetKind
    || event.case_id !== (targetKind === 'coverage' ? '' : spec.caseId)
    || !identifier(event.operation_id)) {
    throw new EvidenceAuthorityLedgerError('existing_state_mismatch');
  }
  dateTime(event.recorded_at, 'existing_state_mismatch');
  const action = event.action;
  const state = event.state;
  const valid = targetKind === 'coverage'
    ? (action === 'opened' && state === 'open') || (action === 'revoked' && state === 'revoked')
    : (action === 'case_opened' && state === 'pending')
      || (action === 'rejected' && state === 'rejected')
      || (action === 'resolution_started' && state === 'resolving')
      || (action === 'resolved' && state === 'resolved');
  if (!valid) throw new EvidenceAuthorityLedgerError('existing_state_mismatch');
  return state as string;
}

interface AuditedEvent {
  readonly sequence: number;
  readonly kind: EvidenceAuthorityEventKindV1;
  readonly action: EvidenceAuthorityEventActionV1;
  readonly state: EvidenceAuthorityCoverageStateV1 | EvidenceAuthorityCaseStateV1;
  readonly caseId: string;
  readonly recordedAt: string;
  readonly targetCreatedAt: string;
}

function auditRecord(value: unknown): { get(key: string): unknown } {
  try {
    if (value === null || typeof value !== 'object' || nodeUtilTypes.isProxy(value)
      || typeof (value as { get?: unknown }).get !== 'function') {
      throw new EvidenceAuthorityLedgerError('existing_state_mismatch');
    }
    return value as { get(key: string): unknown };
  } catch (error) {
    throw normalizedError(error, 'existing_state_mismatch');
  }
}

function exactTargetLabels(value: unknown, expected: string): void {
  try {
    if (!Array.isArray(value) || value.length !== 1 || value[0] !== expected) {
      throw new EvidenceAuthorityLedgerError('existing_state_mismatch');
    }
  } catch (error) {
    throw normalizedError(error, 'existing_state_mismatch');
  }
}

function validateAuditedEvent(
  scope: ScopeInternal,
  rawRecord: unknown,
): AuditedEvent {
  const row = auditRecord(rawRecord);
  const count = (key: string) => integer(
    safeGet(row, key, 'existing_state_mismatch'),
    'existing_state_mismatch',
  );
  if (count('ownerCount') !== 1
    || count('emitCount') !== 1
    || count('outboxCount') !== 1
    || count('incomingCount') !== 1
    || count('targetCount') !== 1
    || count('targetOwnerCount') !== 1
    || count('expectedTargetOwnerCount') !== 1
    || count('targetScopeCount') !== 1
    || count('exactTargetScopeCount') !== 1) {
    throw new EvidenceAuthorityLedgerError('existing_state_mismatch');
  }
  exactTargetLabels(
    safeGet(row, 'eventLabels', 'existing_state_mismatch'),
    'EvidenceAuthorityEvent',
  );
  const event = properties(
    safeGet(row, 'event', 'existing_state_mismatch'),
    EVENT_KEYS,
    'existing_state_mismatch',
  );
  const operationId = event.operation_id;
  const caseId = event.case_id;
  const kind = event.kind;
  const action = event.action;
  const state = event.state;
  if (!identifier(operationId) || typeof caseId !== 'string'
    || event.tenant_id !== scope.tenantId
    || event.project_scope !== scope.projectScope
    || event.semantic_id !== scope.semanticId
    || (kind !== 'coverage' && kind !== 'case')
    || (kind === 'coverage' ? caseId !== '' : !identifier(caseId))) {
    throw new EvidenceAuthorityLedgerError('existing_state_mismatch');
  }
  const validPair = kind === 'coverage'
    ? (action === 'opened' && state === 'open') || (action === 'revoked' && state === 'revoked')
    : (action === 'case_opened' && state === 'pending')
      || (action === 'rejected' && state === 'rejected')
      || (action === 'resolution_started' && state === 'resolving')
      || (action === 'resolved' && state === 'resolved');
  if (!validPair) throw new EvidenceAuthorityLedgerError('existing_state_mismatch');
  const auditedKind = kind as EvidenceAuthorityEventKindV1;
  const auditedAction = action as EvidenceAuthorityEventActionV1;
  const auditedState = state as EvidenceAuthorityCoverageStateV1 | EvidenceAuthorityCaseStateV1;
  if (count('caseSemanticScopeCount') !== (auditedKind === 'case' ? 1 : 0)
    || count('exactCaseSemanticScopeCount') !== (auditedKind === 'case' ? 1 : 0)) {
    throw new EvidenceAuthorityLedgerError('existing_state_mismatch');
  }
  const eventId = digest('event', scope.tenantId, scope.projectScope, scope.semanticId, operationId);
  if (event.id !== eventId) throw new EvidenceAuthorityLedgerError('existing_state_mismatch');
  const sequence = integer(event.sequence, 'existing_state_mismatch');
  if (sequence < 1) throw new EvidenceAuthorityLedgerError('existing_state_mismatch');
  const recordedAt = dateTime(event.recorded_at, 'existing_state_mismatch');
  const outbox = properties(
    safeGet(row, 'outbox', 'existing_state_mismatch'),
    OUTBOX_KEYS,
    'existing_state_mismatch',
  );
  exactTargetLabels(
    safeGet(row, 'outboxLabels', 'existing_state_mismatch'),
    'EvidenceAuthorityOutbox',
  );
  const expectedOutbox = {
    id: digest('outbox', eventId),
    event_id: eventId,
    tenant_id: scope.tenantId,
    project_scope: scope.projectScope,
    semantic_id: scope.semanticId,
    case_id: caseId,
    kind,
    action,
    state,
    sequence,
    recorded_at: recordedAt,
  } as const;
  for (const [key, expected] of Object.entries(expectedOutbox)) {
    const actual = key === 'sequence'
      ? integer(outbox[key], 'existing_state_mismatch')
      : key === 'recorded_at'
        ? dateTime(outbox[key], 'existing_state_mismatch')
        : outbox[key];
    if (actual !== expected) throw new EvidenceAuthorityLedgerError('existing_state_mismatch');
  }
  const targetType = safeGet(row, 'targetType', 'existing_state_mismatch');
  if (targetType !== (auditedKind === 'coverage' ? 'FOR_COVERAGE' : 'FOR_CASE')) {
    throw new EvidenceAuthorityLedgerError('existing_state_mismatch');
  }
  exactTargetLabels(
    safeGet(row, 'targetLabels', 'existing_state_mismatch'),
    auditedKind === 'coverage' ? 'EvidenceAuthorityCoverage' : 'EvidenceAuthorityCase',
  );
  const auditedSpec = operationSpec(
    scope,
    operationId,
    auditedKind,
    auditedAction,
    auditedState,
    caseId,
  );
  const target = properties(
    safeGet(row, 'target', 'existing_state_mismatch'),
    auditedKind === 'coverage' ? COVERAGE_TARGET_KEYS : CASE_TARGET_KEYS,
    'existing_state_mismatch',
  );
  expectedTarget(
    auditedSpec,
    target,
  );
  return Object.freeze({
    sequence,
    kind: auditedKind,
    action: auditedAction,
    state: auditedState,
    caseId,
    recordedAt,
    targetCreatedAt: dateTime(target.created_at, 'existing_state_mismatch'),
  }) as AuditedEvent;
}

function validateOrderedHistory(events: readonly AuditedEvent[]): void {
  const coverage = events.filter((event) => event.kind === 'coverage');
  const caseEvents = events.filter((event) => event.kind === 'case');
  if (coverage.length > 0 && (
    coverage.length > 2
    || coverage[0]?.action !== 'opened'
    || coverage[0]?.state !== 'open'
    || (coverage.length === 2
      && (coverage[1]?.action !== 'revoked' || coverage[1]?.state !== 'revoked'))
  )) {
    throw new EvidenceAuthorityLedgerError('existing_state_mismatch');
  }
  if (coverage.length > 0 && coverage[0]?.targetCreatedAt !== coverage[0]?.recordedAt) {
    throw new EvidenceAuthorityLedgerError('existing_state_mismatch');
  }
  const coverageOpened = coverage[0];
  const coverageRevoked = coverage[1];
  if (caseEvents.length > 0 && (
    coverageOpened === undefined
    || caseEvents.some((event) => event.sequence <= coverageOpened.sequence)
    || (coverageRevoked !== undefined
      && caseEvents.some((event) => event.sequence >= coverageRevoked.sequence))
  )) {
    throw new EvidenceAuthorityLedgerError('existing_state_mismatch');
  }
  const caseIds = new Set(caseEvents.map((event) => event.caseId));
  for (const caseId of caseIds) {
    const history = events.filter((event) => event.kind === 'case' && event.caseId === caseId);
    const valid = history.length >= 1
      && history.length <= 3
      && history[0]?.action === 'case_opened'
      && history[0]?.state === 'pending'
      && (history.length === 1
        || (history.length === 2 && (
          (history[1]?.action === 'rejected' && history[1]?.state === 'rejected')
          || (history[1]?.action === 'resolution_started' && history[1]?.state === 'resolving')
        ))
        || (history.length === 3
          && history[1]?.action === 'resolution_started'
          && history[1]?.state === 'resolving'
          && history[2]?.action === 'resolved'
          && history[2]?.state === 'resolved'));
    if (!valid || history[0]?.targetCreatedAt !== history[0]?.recordedAt) {
      throw new EvidenceAuthorityLedgerError('existing_state_mismatch');
    }
  }
}

function operationSpec(
  scope: ScopeInternal,
  operationId: string,
  kind: EvidenceAuthorityEventKindV1,
  action: EvidenceAuthorityEventActionV1,
  state: EvidenceAuthorityCoverageStateV1 | EvidenceAuthorityCaseStateV1,
  caseId = '',
  createTarget: 'coverage' | 'case' | null = null,
  allowedPreviousState: string | null = null,
): OperationSpec {
  const eventId = digest('event', scope.tenantId, scope.projectScope, scope.semanticId, operationId);
  return Object.freeze({
    scope,
    operationId,
    eventId,
    outboxId: digest('outbox', eventId),
    kind,
    action,
    state,
    caseId,
    caseNodeId: caseId === ''
      ? ''
      : digest('case', scope.tenantId, scope.projectScope, scope.semanticId, caseId),
    createTarget,
    allowedPreviousState,
  });
}

function queryParams(spec: OperationSpec, nextSequence?: number): Record<string, unknown> {
  const result: Record<string, unknown> = {
    tenantId: spec.scope.tenantId,
    projectScope: spec.scope.projectScope,
    semanticId: spec.scope.semanticId,
    ledgerId: spec.scope.ledgerId,
    coverageId: spec.scope.coverageId,
    caseId: spec.caseId,
    caseNodeId: spec.caseNodeId,
    operationId: spec.operationId,
    eventId: spec.eventId,
    outboxId: spec.outboxId,
    kind: spec.kind,
    action: spec.action,
    state: spec.state,
  };
  if (nextSequence !== undefined) result.nextSequence = neo4j.int(nextSequence);
  return result;
}

const LOCK_QUERY = `/* evidence-authority:lock */
MATCH (s:Semantic {id: $semanticId})
WHERE s.tenant_id = $tenantId AND s.scope = $projectScope
MERGE (ledger:EvidenceAuthorityLedger {id: $ledgerId})
ON CREATE SET ledger.tenant_id = $tenantId,
              ledger.project_scope = $projectScope,
              ledger.semantic_id = $semanticId,
              ledger.version = 0,
              ledger.locked = true
SET ledger.locked = true
RETURN properties(ledger) AS ledger`;

const LEDGER_EVENT_AUDIT_QUERY = `/* evidence-authority:ledger-event-audit */
MATCH (ledger:EvidenceAuthorityLedger {id: $ledgerId})-[:HAS_EVENT]->(event)
CALL {
  WITH event
  OPTIONAL MATCH ()-[owner:HAS_EVENT]->(event)
  RETURN count(owner) AS ownerCount
}
CALL {
  WITH event
  OPTIONAL MATCH (event)-[emit:EMITTED]->(candidate)
  WITH count(emit) AS emitCount, collect(candidate) AS outboxes
  RETURN emitCount,
         size(outboxes) AS outboxCount,
         CASE WHEN size(outboxes) = 1 THEN properties(outboxes[0]) ELSE null END AS outbox,
         CASE WHEN size(outboxes) = 1 THEN labels(outboxes[0]) ELSE null END AS outboxLabels,
         CASE WHEN size(outboxes) = 1 THEN outboxes[0] ELSE null END AS outboxNode
}
CALL {
  WITH outboxNode
  OPTIONAL MATCH ()-[incoming:EMITTED]->(candidate)
  WHERE outboxNode IS NOT NULL AND candidate = outboxNode
  RETURN count(incoming) AS incomingCount
}
CALL {
  WITH event
  OPTIONAL MATCH (event)-[target:FOR_COVERAGE|FOR_CASE]->(targetNode)
  WITH count(target) AS targetCount,
       collect(type(target)) AS targetTypes,
       collect(labels(targetNode)) AS targetLabelSets,
       collect(properties(targetNode)) AS targets,
       collect(targetNode) AS targetNodes
  RETURN targetCount,
         CASE WHEN targetCount = 1 THEN targetTypes[0] ELSE null END AS targetType,
         CASE WHEN targetCount = 1 THEN targetLabelSets[0] ELSE null END AS targetLabels,
         CASE WHEN targetCount = 1 THEN targets[0] ELSE null END AS target,
         CASE WHEN targetCount = 1 THEN targetNodes[0] ELSE null END AS targetNode
}
CALL {
  WITH ledger, event, targetNode
  OPTIONAL MATCH (owner)-[targetOwner:HAS_COVERAGE|HAS_CASE]->(targetNode)
  RETURN count(targetOwner) AS targetOwnerCount,
         count(CASE WHEN owner = ledger
                          AND ((event.kind = 'coverage' AND type(targetOwner) = 'HAS_COVERAGE')
                            OR (event.kind = 'case' AND type(targetOwner) = 'HAS_CASE'))
                    THEN 1 END) AS expectedTargetOwnerCount
}
CALL {
  WITH event, targetNode
  OPTIONAL MATCH (targetNode)-[targetScope:COVERS|FOR_COVERAGE]->(scopeNode)
  RETURN count(targetScope) AS targetScopeCount,
         count(CASE WHEN event.kind = 'coverage'
                          AND type(targetScope) = 'COVERS'
                          AND 'Semantic' IN labels(scopeNode)
                          AND scopeNode.id = $semanticId
                          AND scopeNode.tenant_id = $tenantId
                          AND scopeNode.scope = $projectScope
                    THEN 1
                    WHEN event.kind = 'case'
                          AND type(targetScope) = 'FOR_COVERAGE'
                          AND 'EvidenceAuthorityCoverage' IN labels(scopeNode)
                          AND scopeNode.id = $coverageId
                          AND scopeNode.tenant_id = $tenantId
                          AND scopeNode.project_scope = $projectScope
                          AND scopeNode.semantic_id = $semanticId
                    THEN 1 END) AS exactTargetScopeCount
}
CALL {
  WITH event, targetNode
  OPTIONAL MATCH (targetNode)-[:FOR_COVERAGE]->(:EvidenceAuthorityCoverage)-
                 [caseSemanticScope:COVERS]->(caseSemantic)
  RETURN count(caseSemanticScope) AS caseSemanticScopeCount,
         count(CASE WHEN caseSemantic.id = $semanticId
                          AND caseSemantic.tenant_id = $tenantId
                          AND caseSemantic.scope = $projectScope
                    THEN 1 END) AS exactCaseSemanticScopeCount
}
RETURN properties(event) AS event, labels(event) AS eventLabels,
       ownerCount, emitCount, outboxCount, incomingCount, outbox, outboxLabels,
       targetCount, targetType, targetLabels, target,
       targetOwnerCount, expectedTargetOwnerCount,
       targetScopeCount, exactTargetScopeCount,
       caseSemanticScopeCount, exactCaseSemanticScopeCount
ORDER BY event.sequence`;

const REPLAY_COVERAGE_QUERY = `/* evidence-authority:replay */
MATCH (ledger:EvidenceAuthorityLedger {id: $ledgerId})
OPTIONAL MATCH (anyEvent:EvidenceAuthorityEvent {id: $eventId})
OPTIONAL MATCH (anyOutbox:EvidenceAuthorityOutbox {id: $outboxId})
OPTIONAL MATCH (ledger)-[expectedOwner:HAS_EVENT]->(event:EvidenceAuthorityEvent {id: $eventId})
OPTIONAL MATCH (event)-[expectedEmit:EMITTED]->(outbox:EvidenceAuthorityOutbox {id: $outboxId})
OPTIONAL MATCH (event)-[expectedTarget:FOR_COVERAGE]->(target:EvidenceAuthorityCoverage {id: $coverageId})
OPTIONAL MATCH (:EvidenceAuthorityLedger)-[allOwner:HAS_EVENT]->(anyEvent)
OPTIONAL MATCH (anyEvent)-[allEmit:EMITTED]->(:EvidenceAuthorityOutbox)
OPTIONAL MATCH (anyEvent)-[allTarget:FOR_COVERAGE|FOR_CASE]->()
OPTIONAL MATCH (:EvidenceAuthorityEvent)-[allIncoming:EMITTED]->(anyOutbox)
RETURN properties(event) AS event,
       properties(outbox) AS outbox,
       properties(target) AS target,
       count(DISTINCT anyEvent) AS anyEventCount,
       count(DISTINCT anyOutbox) AS anyOutboxCount,
       count(DISTINCT expectedOwner) AS expectedOwnerCount,
       count(DISTINCT expectedEmit) AS expectedEmitCount,
       count(DISTINCT expectedTarget) AS expectedTargetCount,
       count(DISTINCT allOwner) AS allOwnerCount,
       count(DISTINCT allEmit) AS allEmitCount,
       count(DISTINCT allTarget) AS allTargetCount,
       count(DISTINCT allIncoming) AS allIncomingCount`;

const REPLAY_CASE_QUERY = REPLAY_COVERAGE_QUERY
  .replace('FOR_COVERAGE]->(target:EvidenceAuthorityCoverage {id: $coverageId})',
    'FOR_CASE]->(target:EvidenceAuthorityCase {id: $caseNodeId})');

const COVERAGE_TOPOLOGY_QUERY = `/* evidence-authority:coverage-topology */
MATCH (ledger:EvidenceAuthorityLedger {id: $ledgerId})
OPTIONAL MATCH (target:EvidenceAuthorityCoverage {id: $coverageId})
OPTIONAL MATCH (ledger)-[expectedTargetOwner:HAS_COVERAGE]->(target)
OPTIONAL MATCH (:EvidenceAuthorityLedger)-[allTargetOwner:HAS_COVERAGE]->(target)
OPTIONAL MATCH (target)-[scopeLink:COVERS]->(semantic:Semantic)
OPTIONAL MATCH (event:EvidenceAuthorityEvent)-[targetEvent:FOR_COVERAGE]->(target)
OPTIONAL MATCH (ownerLedger:EvidenceAuthorityLedger)-[eventOwner:HAS_EVENT]->(event)
RETURN properties(target) AS target,
       count(DISTINCT expectedTargetOwner) AS expectedTargetOwnerCount,
       count(DISTINCT allTargetOwner) AS allTargetOwnerCount,
       count(DISTINCT scopeLink) AS scopeLinkCount,
       count(DISTINCT CASE WHEN semantic.id = $semanticId
                              AND semantic.tenant_id = $tenantId
                              AND semantic.scope = $projectScope
                           THEN semantic END) AS exactSemanticCount,
       count(DISTINCT event) AS eventCount,
       count(DISTINCT targetEvent) AS targetEventRelationshipCount,
       count(DISTINCT eventOwner) AS eventOwnerRelationshipCount,
       count(DISTINCT CASE WHEN ownerLedger.id = $ledgerId THEN event END) AS ownedEventCount,
       count(DISTINCT CASE WHEN event.tenant_id <> $tenantId
                              OR event.project_scope <> $projectScope
                              OR event.semantic_id <> $semanticId
                              OR event.kind <> 'coverage'
                           THEN event END) AS invalidEventCount`;

const CASE_TOPOLOGY_QUERY = `/* evidence-authority:case-topology */
MATCH (ledger:EvidenceAuthorityLedger {id: $ledgerId})
OPTIONAL MATCH (target:EvidenceAuthorityCase {id: $caseNodeId})
OPTIONAL MATCH (ledger)-[expectedTargetOwner:HAS_CASE]->(target)
OPTIONAL MATCH (:EvidenceAuthorityLedger)-[allTargetOwner:HAS_CASE]->(target)
OPTIONAL MATCH (target)-[coverageLink:FOR_COVERAGE]->(coverage:EvidenceAuthorityCoverage {id: $coverageId})
OPTIONAL MATCH (coverage)-[scopeLink:COVERS]->(semantic:Semantic)
OPTIONAL MATCH (event:EvidenceAuthorityEvent)-[targetEvent:FOR_CASE]->(target)
OPTIONAL MATCH (ownerLedger:EvidenceAuthorityLedger)-[eventOwner:HAS_EVENT]->(event)
RETURN properties(target) AS target,
       count(DISTINCT expectedTargetOwner) AS expectedTargetOwnerCount,
       count(DISTINCT allTargetOwner) AS allTargetOwnerCount,
       count(DISTINCT coverageLink) AS coverageLinkCount,
       count(DISTINCT scopeLink) AS scopeLinkCount,
       count(DISTINCT CASE WHEN semantic.id = $semanticId
                              AND semantic.tenant_id = $tenantId
                              AND semantic.scope = $projectScope
                           THEN semantic END) AS exactSemanticCount,
       count(DISTINCT event) AS eventCount,
       count(DISTINCT targetEvent) AS targetEventRelationshipCount,
       count(DISTINCT eventOwner) AS eventOwnerRelationshipCount,
       count(DISTINCT CASE WHEN ownerLedger.id = $ledgerId THEN event END) AS ownedEventCount,
       count(DISTINCT CASE WHEN event.tenant_id <> $tenantId
                              OR event.project_scope <> $projectScope
                              OR event.semantic_id <> $semanticId
                              OR event.kind <> 'case'
                              OR event.case_id <> $caseId
                           THEN event END) AS invalidEventCount`;

const COVERAGE_LATEST_QUERY = `/* evidence-authority:coverage-latest */
MATCH (:EvidenceAuthorityLedger {id: $ledgerId})-[:HAS_EVENT]->
      (event:EvidenceAuthorityEvent)-[:FOR_COVERAGE]->
      (:EvidenceAuthorityCoverage {id: $coverageId})
RETURN properties(event) AS event
ORDER BY event.sequence DESC
LIMIT 1`;

const CASE_LATEST_QUERY = `/* evidence-authority:case-latest */
MATCH (:EvidenceAuthorityLedger {id: $ledgerId})-[:HAS_EVENT]->
      (event:EvidenceAuthorityEvent)-[:FOR_CASE]->
      (:EvidenceAuthorityCase {id: $caseNodeId})
RETURN properties(event) AS event
ORDER BY event.sequence DESC
LIMIT 1`;

const OPEN_COVERAGE_QUERY = `/* evidence-authority:append-open-coverage */
MATCH (ledger:EvidenceAuthorityLedger {id: $ledgerId}),
      (semantic:Semantic {id: $semanticId})
WHERE semantic.tenant_id = $tenantId AND semantic.scope = $projectScope
CREATE (event:EvidenceAuthorityEvent {
  id: $eventId, tenant_id: $tenantId, project_scope: $projectScope,
  semantic_id: $semanticId, case_id: $caseId, operation_id: $operationId,
  kind: $kind, action: $action, state: $state,
  sequence: $nextSequence, recorded_at: toString(datetime())
})
CREATE (coverage:EvidenceAuthorityCoverage {
  id: $coverageId, tenant_id: $tenantId, project_scope: $projectScope,
  semantic_id: $semanticId, created_at: event.recorded_at
})
CREATE (outbox:EvidenceAuthorityOutbox {
  id: $outboxId, event_id: $eventId, tenant_id: $tenantId,
  project_scope: $projectScope, semantic_id: $semanticId, case_id: $caseId,
  kind: $kind, action: $action, state: $state,
  sequence: $nextSequence, recorded_at: event.recorded_at
})
CREATE (ledger)-[:HAS_COVERAGE]->(coverage)
CREATE (coverage)-[:COVERS]->(semantic)
CREATE (ledger)-[:HAS_EVENT]->(event)
CREATE (event)-[:FOR_COVERAGE]->(coverage)
CREATE (event)-[:EMITTED]->(outbox)
SET ledger.version = $nextSequence
RETURN properties(event) AS event,
       properties(outbox) AS outbox,
       properties(coverage) AS target`;

const OPEN_CASE_QUERY = `/* evidence-authority:append-open-case */
MATCH (ledger:EvidenceAuthorityLedger {id: $ledgerId}),
      (coverage:EvidenceAuthorityCoverage {id: $coverageId})-[:COVERS]->(semantic:Semantic {id: $semanticId})
WHERE semantic.tenant_id = $tenantId AND semantic.scope = $projectScope
CREATE (event:EvidenceAuthorityEvent {
  id: $eventId, tenant_id: $tenantId, project_scope: $projectScope,
  semantic_id: $semanticId, case_id: $caseId, operation_id: $operationId,
  kind: $kind, action: $action, state: $state,
  sequence: $nextSequence, recorded_at: toString(datetime())
})
CREATE (caseNode:EvidenceAuthorityCase {
  id: $caseNodeId, tenant_id: $tenantId, project_scope: $projectScope,
  semantic_id: $semanticId, coverage_id: $coverageId, case_id: $caseId,
  created_at: event.recorded_at
})
CREATE (outbox:EvidenceAuthorityOutbox {
  id: $outboxId, event_id: $eventId, tenant_id: $tenantId,
  project_scope: $projectScope, semantic_id: $semanticId, case_id: $caseId,
  kind: $kind, action: $action, state: $state,
  sequence: $nextSequence, recorded_at: event.recorded_at
})
CREATE (ledger)-[:HAS_CASE]->(caseNode)
CREATE (caseNode)-[:FOR_COVERAGE]->(coverage)
CREATE (ledger)-[:HAS_EVENT]->(event)
CREATE (event)-[:FOR_CASE]->(caseNode)
CREATE (event)-[:EMITTED]->(outbox)
SET ledger.version = $nextSequence
RETURN properties(event) AS event,
       properties(outbox) AS outbox,
       properties(caseNode) AS target`;

const COVERAGE_TRANSITION_QUERY = `/* evidence-authority:append-transition-coverage */
MATCH (ledger:EvidenceAuthorityLedger {id: $ledgerId})
MATCH (target:EvidenceAuthorityCoverage {id: $coverageId})-[:COVERS]->(semantic:Semantic {id: $semanticId})
WHERE semantic.tenant_id = $tenantId AND semantic.scope = $projectScope
CREATE (event:EvidenceAuthorityEvent {
  id: $eventId, tenant_id: $tenantId, project_scope: $projectScope,
  semantic_id: $semanticId, case_id: $caseId, operation_id: $operationId,
  kind: $kind, action: $action, state: $state,
  sequence: $nextSequence, recorded_at: toString(datetime())
})
CREATE (outbox:EvidenceAuthorityOutbox {
  id: $outboxId, event_id: $eventId, tenant_id: $tenantId,
  project_scope: $projectScope, semantic_id: $semanticId, case_id: $caseId,
  kind: $kind, action: $action, state: $state,
  sequence: $nextSequence, recorded_at: event.recorded_at
})
CREATE (ledger)-[:HAS_EVENT]->(event)
CREATE (event)-[:FOR_COVERAGE]->(target)
CREATE (event)-[:EMITTED]->(outbox)
SET ledger.version = $nextSequence
RETURN properties(event) AS event,
       properties(outbox) AS outbox,
       properties(target) AS target`;

const CASE_TRANSITION_QUERY = `/* evidence-authority:append-transition-case */
MATCH (ledger:EvidenceAuthorityLedger {id: $ledgerId})
MATCH (target:EvidenceAuthorityCase {id: $caseNodeId})-[:FOR_COVERAGE]->
      (:EvidenceAuthorityCoverage {id: $coverageId})-[:COVERS]->
      (semantic:Semantic {id: $semanticId})
WHERE semantic.tenant_id = $tenantId AND semantic.scope = $projectScope
CREATE (event:EvidenceAuthorityEvent {
  id: $eventId, tenant_id: $tenantId, project_scope: $projectScope,
  semantic_id: $semanticId, case_id: $caseId, operation_id: $operationId,
  kind: $kind, action: $action, state: $state,
  sequence: $nextSequence, recorded_at: toString(datetime())
})
CREATE (outbox:EvidenceAuthorityOutbox {
  id: $outboxId, event_id: $eventId, tenant_id: $tenantId,
  project_scope: $projectScope, semantic_id: $semanticId, case_id: $caseId,
  kind: $kind, action: $action, state: $state,
  sequence: $nextSequence, recorded_at: event.recorded_at
})
CREATE (ledger)-[:HAS_EVENT]->(event)
CREATE (event)-[:FOR_CASE]->(target)
CREATE (event)-[:EMITTED]->(outbox)
SET ledger.version = $nextSequence
RETURN properties(event) AS event,
       properties(outbox) AS outbox,
       properties(target) AS target`;

class EvidenceAuthorityLedgerPersistence implements EvidenceAuthorityLedgerPersistenceV1 {
  private metadata(): { readonly driver: Driver; readonly storeToken: object } {
    const metadata = storeMetadata.get(this);
    if (metadata === undefined) throw new EvidenceAuthorityLedgerError('invalid_facet');
    return metadata;
  }

  private async managed<T>(work: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
    let session: Session;
    try {
      session = this.metadata().driver.session();
    } catch {
      throw new EvidenceAuthorityLedgerError('storage_unavailable');
    }
    let value: T | undefined;
    let failure: EvidenceAuthorityLedgerError | undefined;
    try {
      value = await session.executeWrite(work);
    } catch (error) {
      failure = normalizedError(error, 'storage_unavailable');
    }
    try {
      await session.close();
    } catch (error) {
      failure ??= normalizedError(error, 'storage_unavailable');
    }
    if (failure) throw failure;
    return value as T;
  }

  private coverageFacet(scope: ScopeInternal): EvidenceAuthorityCoverageFacetV1 {
    const facet = newFacet<EvidenceAuthorityCoverageFacetV1>();
    coverageFacets.set(facet, Object.freeze({ storeToken: this.metadata().storeToken, scope }));
    return facet;
  }

  private caseFacet(
    scope: ScopeInternal,
    caseId: string,
    caseNodeId: string,
  ): EvidenceAuthorityCaseFacetV1 {
    const facet = newFacet<EvidenceAuthorityCaseFacetV1>();
    caseFacets.set(facet, Object.freeze({
      storeToken: this.metadata().storeToken,
      scope,
      caseId,
      caseNodeId,
    }));
    return facet;
  }

  private requireCoverageFacet(value: unknown, scope: ScopeInternal): CoverageFacetMetadata {
    const metadata = coverageFacets.get(facetObject(value));
    if (metadata === undefined || metadata.storeToken !== this.metadata().storeToken) {
      throw new EvidenceAuthorityLedgerError('invalid_facet');
    }
    if (!sameScope(metadata.scope, scope)) {
      throw new EvidenceAuthorityLedgerError('facet_scope_mismatch');
    }
    return metadata;
  }

  private requireCaseFacet(value: unknown, scope: ScopeInternal): CaseFacetMetadata {
    const metadata = caseFacets.get(facetObject(value));
    if (metadata === undefined || metadata.storeToken !== this.metadata().storeToken) {
      throw new EvidenceAuthorityLedgerError('invalid_facet');
    }
    if (!sameScope(metadata.scope, scope)) {
      throw new EvidenceAuthorityLedgerError('facet_scope_mismatch');
    }
    return metadata;
  }

  private requireCaptureFacet(value: unknown, scope: ScopeInternal): void {
    const metadata = captureFacets.get(facetObject(value));
    if (metadata === undefined || metadata.storeToken !== this.metadata().storeToken) {
      throw new EvidenceAuthorityLedgerError('invalid_facet');
    }
    if (!sameScope(metadata.scope, scope)) {
      throw new EvidenceAuthorityLedgerError('facet_scope_mismatch');
    }
  }

  private requireReviewFacet(value: unknown, scope: ScopeInternal): void {
    const metadata = reviewFacets.get(facetObject(value));
    if (metadata === undefined || metadata.storeToken !== this.metadata().storeToken) {
      throw new EvidenceAuthorityLedgerError('invalid_facet');
    }
    if (!sameScope(metadata.scope, scope)) {
      throw new EvidenceAuthorityLedgerError('facet_scope_mismatch');
    }
  }

  private async state(
    tx: ManagedTransaction,
    spec: OperationSpec,
    targetKind: 'coverage' | 'case',
    ledgerVersion: number,
  ): Promise<{ target: Record<string, unknown> | null; state: string | null }> {
    const result = await tx.run(
      targetKind === 'coverage' ? COVERAGE_TOPOLOGY_QUERY : CASE_TOPOLOGY_QUERY,
      queryParams(spec),
    );
    const record = singleRecord(result, 'existing_state_mismatch');
    const rawTarget = safeGet(record, 'target', 'existing_state_mismatch');
    const count = (key: string) => integer(
      safeGet(record, key, 'existing_state_mismatch'),
      'existing_state_mismatch',
    );
    if (rawTarget === null) {
      for (const key of [
        'expectedTargetOwnerCount', 'allTargetOwnerCount', 'scopeLinkCount',
        'exactSemanticCount', 'eventCount', 'targetEventRelationshipCount',
        'eventOwnerRelationshipCount', 'ownedEventCount', 'invalidEventCount',
        ...(targetKind === 'case' ? ['coverageLinkCount'] : []),
      ]) {
        if (count(key) !== 0) throw new EvidenceAuthorityLedgerError('existing_state_mismatch');
      }
      return { target: null, state: null };
    }
    const target = properties(
      rawTarget,
      targetKind === 'coverage' ? COVERAGE_TARGET_KEYS : CASE_TARGET_KEYS,
      'existing_state_mismatch',
    );
    expectedTarget({ ...spec, kind: targetKind } as OperationSpec, target);
    const eventCount = count('eventCount');
    if (count('expectedTargetOwnerCount') !== 1
      || count('allTargetOwnerCount') !== 1
      || count('scopeLinkCount') !== 1
      || count('exactSemanticCount') !== 1
      || (targetKind === 'case' && count('coverageLinkCount') !== 1)
      || eventCount < 1
      || count('targetEventRelationshipCount') !== eventCount
      || count('eventOwnerRelationshipCount') !== eventCount
      || count('ownedEventCount') !== eventCount
      || count('invalidEventCount') !== 0) {
      throw new EvidenceAuthorityLedgerError('existing_state_mismatch');
    }
    const latestResult = await tx.run(
      targetKind === 'coverage' ? COVERAGE_LATEST_QUERY : CASE_LATEST_QUERY,
      queryParams(spec),
    );
    const latestRecord = singleRecord(latestResult, 'existing_state_mismatch');
    const state = validateLatestStateEvent(
      spec,
      safeGet(latestRecord, 'event', 'existing_state_mismatch'),
      targetKind,
      ledgerVersion,
    );
    return { target, state };
  }

  private async perform(spec: OperationSpec): Promise<OperationResult> {
    return this.managed(async (tx) => {
      const lock = await tx.run(LOCK_QUERY, queryParams(spec));
      try {
        const records = (lock as { records?: unknown }).records;
        if (!Array.isArray(records)) throw new EvidenceAuthorityLedgerError('write_incomplete');
        if (records.length === 0) throw new EvidenceAuthorityLedgerError('semantic_not_found');
        if (records.length !== 1) throw new EvidenceAuthorityLedgerError('write_incomplete');
      } catch (error) {
        throw normalizedError(error, 'write_incomplete');
      }
      const lockRecord = singleRecord(lock, 'write_incomplete');
      const ledger = properties(
        safeGet(lockRecord, 'ledger', 'write_incomplete'),
        LEDGER_KEYS,
        'write_incomplete',
      );
      const version = integer(ledger.version, 'write_incomplete');
      if (ledger.id !== spec.scope.ledgerId
        || ledger.tenant_id !== spec.scope.tenantId
        || ledger.project_scope !== spec.scope.projectScope
        || ledger.semantic_id !== spec.scope.semanticId
        || ledger.locked !== true) {
        throw new EvidenceAuthorityLedgerError('existing_state_mismatch');
      }
      const auditResult = await tx.run(LEDGER_EVENT_AUDIT_QUERY, queryParams(spec));
      let auditRows: unknown[];
      try {
        auditRows = (auditResult as { records?: unknown }).records as unknown[];
        if (!Array.isArray(auditRows) || auditRows.length !== version) {
          throw new EvidenceAuthorityLedgerError('existing_state_mismatch');
        }
      } catch (error) {
        throw normalizedError(error, 'existing_state_mismatch');
      }
      const auditedEvents = auditRows.map((row) => validateAuditedEvent(spec.scope, row));
      const orderedEvents = [...auditedEvents].sort((left, right) => left.sequence - right.sequence);
      const sequences = orderedEvents.map((event) => event.sequence);
      if (sequences.some((sequence, index) => sequence !== index + 1)) {
        throw new EvidenceAuthorityLedgerError('existing_state_mismatch');
      }
      validateOrderedHistory(orderedEvents);

      const replay = await tx.run(
        spec.kind === 'coverage' ? REPLAY_COVERAGE_QUERY : REPLAY_CASE_QUERY,
        queryParams(spec),
      );
      const replayRecord = singleRecord(replay, 'existing_state_mismatch');
      const replayEvent = safeGet(replayRecord, 'event', 'existing_state_mismatch');
      const replayCount = (key: string) => integer(
        safeGet(replayRecord, key, 'existing_state_mismatch'),
        'existing_state_mismatch',
      );
      const anyEventCount = replayCount('anyEventCount');
      const anyOutboxCount = replayCount('anyOutboxCount');
      if (replayEvent !== null) {
        const replayEventProperties = properties(
          replayEvent,
          EVENT_KEYS,
          'existing_state_mismatch',
        );
        if (replayEventProperties.id !== spec.eventId
          || replayEventProperties.tenant_id !== spec.scope.tenantId
          || replayEventProperties.project_scope !== spec.scope.projectScope
          || replayEventProperties.semantic_id !== spec.scope.semanticId
          || replayEventProperties.operation_id !== spec.operationId) {
          throw new EvidenceAuthorityLedgerError('existing_state_mismatch');
        }
        if (replayEventProperties.case_id !== spec.caseId
          || replayEventProperties.kind !== spec.kind
          || replayEventProperties.action !== spec.action
          || replayEventProperties.state !== spec.state) {
          throw new EvidenceAuthorityLedgerError('operation_conflict');
        }
        if (anyEventCount !== 1
          || anyOutboxCount !== 1
          || replayCount('expectedOwnerCount') !== 1
          || replayCount('expectedEmitCount') !== 1
          || replayCount('expectedTargetCount') !== 1
          || replayCount('allOwnerCount') !== 1
          || replayCount('allEmitCount') !== 1
          || replayCount('allTargetCount') !== 1
          || replayCount('allIncomingCount') !== 1) {
          throw new EvidenceAuthorityLedgerError('existing_state_mismatch');
        }
        const stored = validateStored(
          spec,
          replayEvent,
          safeGet(replayRecord, 'outbox', 'existing_state_mismatch'),
          safeGet(replayRecord, 'target', 'existing_state_mismatch'),
          'existing_state_mismatch',
        );
        if (stored.receipt.sequence > version) {
          throw new EvidenceAuthorityLedgerError('existing_state_mismatch');
        }
        return stored;
      }
      if (safeGet(replayRecord, 'outbox', 'existing_state_mismatch') !== null
        || safeGet(replayRecord, 'target', 'existing_state_mismatch') !== null
        || anyEventCount !== 0
        || anyOutboxCount !== 0
        || replayCount('expectedOwnerCount') !== 0
        || replayCount('expectedEmitCount') !== 0
        || replayCount('expectedTargetCount') !== 0
        || replayCount('allOwnerCount') !== 0
        || replayCount('allEmitCount') !== 0
        || replayCount('allTargetCount') !== 0
        || replayCount('allIncomingCount') !== 0) {
        throw new EvidenceAuthorityLedgerError('existing_state_mismatch');
      }

      const coverage = await this.state(tx, spec, 'coverage', version);
      if (spec.createTarget === 'coverage') {
        if (coverage.target !== null) throw new EvidenceAuthorityLedgerError('invalid_transition');
      } else {
        if (coverage.target === null) throw new EvidenceAuthorityLedgerError('coverage_missing');
        if (spec.kind === 'case' && coverage.state === 'revoked') {
          throw new EvidenceAuthorityLedgerError('facet_revoked');
        }
        if (spec.kind === 'coverage' && coverage.state !== spec.allowedPreviousState) {
          throw new EvidenceAuthorityLedgerError('invalid_transition');
        }
      }

      if (spec.kind === 'case') {
        const currentCase = await this.state(tx, spec, 'case', version);
        if (spec.createTarget === 'case') {
          if (currentCase.target !== null) throw new EvidenceAuthorityLedgerError('invalid_transition');
        } else {
          if (currentCase.target === null) throw new EvidenceAuthorityLedgerError('case_missing');
          if (currentCase.state !== spec.allowedPreviousState) {
            throw new EvidenceAuthorityLedgerError('invalid_transition');
          }
        }
      }

      const appendQuery = spec.createTarget === 'coverage'
        ? OPEN_COVERAGE_QUERY
        : spec.createTarget === 'case'
          ? OPEN_CASE_QUERY
          : spec.kind === 'coverage'
            ? COVERAGE_TRANSITION_QUERY
            : CASE_TRANSITION_QUERY;
      const appended = await tx.run(appendQuery, queryParams(spec, version + 1));
      const appendedRecord = singleRecord(appended, 'write_incomplete');
      const stored = validateStored(
        spec,
        safeGet(appendedRecord, 'event', 'write_incomplete'),
        safeGet(appendedRecord, 'outbox', 'write_incomplete'),
        safeGet(appendedRecord, 'target', 'write_incomplete'),
        'write_incomplete',
      );
      if (stored.receipt.sequence !== version + 1) {
        throw new EvidenceAuthorityLedgerError('write_incomplete');
      }
      return stored;
    });
  }

  async openCoverage(
    rawCaptureFacet: unknown,
    rawScope: unknown,
    rawOperation: unknown,
  ): Promise<EvidenceAuthorityCoverageOpenResultV1> {
    const scope = parseScope(rawScope);
    this.requireCaptureFacet(rawCaptureFacet, scope);
    const operation = parseOperation(rawOperation);
    const spec = operationSpec(scope, operation.operationId, 'coverage', 'opened', 'open', '', 'coverage');
    const result = await this.perform(spec);
    return sealedResult(this.coverageFacet(scope), result.receipt);
  }

  async revokeCoverage(
    rawReviewFacet: unknown,
    rawFacet: unknown,
    rawScope: unknown,
    rawOperation: unknown,
  ): Promise<EvidenceAuthorityEventReceiptV1> {
    const scope = parseScope(rawScope);
    this.requireReviewFacet(rawReviewFacet, scope);
    this.requireCoverageFacet(rawFacet, scope);
    const operation = parseOperation(rawOperation);
    return (await this.perform(operationSpec(
      scope,
      operation.operationId,
      'coverage',
      'revoked',
      'revoked',
      '',
      null,
      'open',
    ))).receipt;
  }

  async openCase(
    rawCaptureFacet: unknown,
    rawFacet: unknown,
    rawScope: unknown,
    rawOperation: unknown,
  ): Promise<EvidenceAuthorityCaseOpenResultV1> {
    const scope = parseScope(rawScope);
    this.requireCaptureFacet(rawCaptureFacet, scope);
    this.requireCoverageFacet(rawFacet, scope);
    const operation = parseOpenCaseOperation(rawOperation);
    const spec = operationSpec(
      scope,
      operation.operationId,
      'case',
      'case_opened',
      'pending',
      operation.caseId,
      'case',
    );
    const result = await this.perform(spec);
    return sealedResult(this.caseFacet(scope, operation.caseId, spec.caseNodeId), result.receipt);
  }

  private async transitionCase(
    rawReviewFacet: unknown,
    rawFacet: unknown,
    rawScope: unknown,
    rawOperation: unknown,
    action: 'rejected' | 'resolution_started' | 'resolved',
    state: 'rejected' | 'resolving' | 'resolved',
    previous: 'pending' | 'resolving',
  ): Promise<EvidenceAuthorityEventReceiptV1> {
    const scope = parseScope(rawScope);
    this.requireReviewFacet(rawReviewFacet, scope);
    const metadata = this.requireCaseFacet(rawFacet, scope);
    const operation = parseOperation(rawOperation);
    const spec = operationSpec(
      scope,
      operation.operationId,
      'case',
      action,
      state,
      metadata.caseId,
      null,
      previous,
    );
    if (spec.caseNodeId !== metadata.caseNodeId) {
      throw new EvidenceAuthorityLedgerError('invalid_facet');
    }
    return (await this.perform(spec)).receipt;
  }

  rejectCase(reviewFacet: unknown, facet: unknown, scope: unknown, operation: unknown): Promise<EvidenceAuthorityEventReceiptV1> {
    return this.transitionCase(reviewFacet, facet, scope, operation, 'rejected', 'rejected', 'pending');
  }

  beginResolution(reviewFacet: unknown, facet: unknown, scope: unknown, operation: unknown): Promise<EvidenceAuthorityEventReceiptV1> {
    return this.transitionCase(reviewFacet, facet, scope, operation, 'resolution_started', 'resolving', 'pending');
  }

  resolveCase(reviewFacet: unknown, facet: unknown, scope: unknown, operation: unknown): Promise<EvidenceAuthorityEventReceiptV1> {
    return this.transitionCase(reviewFacet, facet, scope, operation, 'resolved', 'resolved', 'resolving');
  }
}

export function createEvidenceAuthorityLedgerPersistence(
  driver: Driver,
): EvidenceAuthorityLedgerPersistenceV1 {
  const persistence = new EvidenceAuthorityLedgerPersistence();
  storeMetadata.set(persistence, Object.freeze({
    driver,
    storeToken: Object.freeze(Object.create(null)) as object,
  }));
  return Object.freeze(persistence);
}

/** Internal package seam for future Neo4j-first B2 capture; intentionally not root-exported. */
export function createEvidenceAuthorityCaptureFacet(
  persistence: EvidenceAuthorityLedgerPersistenceV1,
  rawScope: unknown,
): EvidenceAuthorityCaptureFacetV1 {
  const store = facetObject(persistence);
  const metadata = storeMetadata.get(store);
  if (metadata === undefined) throw new EvidenceAuthorityLedgerError('invalid_facet');
  const scope = parseScope(rawScope);
  const facet = newFacet<EvidenceAuthorityCaptureFacetV1>();
  captureFacets.set(facet, Object.freeze({ storeToken: metadata.storeToken, scope }));
  return facet;
}

/** Internal package seam for future authenticated B3 review; intentionally not root-exported. */
export function createEvidenceAuthorityReviewFacet(
  persistence: EvidenceAuthorityLedgerPersistenceV1,
  rawScope: unknown,
): EvidenceAuthorityReviewFacetV1 {
  const store = facetObject(persistence);
  const metadata = storeMetadata.get(store);
  if (metadata === undefined) throw new EvidenceAuthorityLedgerError('invalid_facet');
  const scope = parseScope(rawScope);
  const facet = newFacet<EvidenceAuthorityReviewFacetV1>();
  reviewFacets.set(facet, Object.freeze({ storeToken: metadata.storeToken, scope }));
  return facet;
}
