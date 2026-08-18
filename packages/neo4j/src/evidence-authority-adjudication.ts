import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';

import type { Driver } from 'neo4j-driver';

import {
  EvidenceAuthorityLedgerError,
  createEvidenceAuthorityLedgerPersistence,
  createEvidenceAuthorityReviewFacet,
  type EvidenceAuthorityEventReceiptV1,
  type EvidenceAuthorityLedgerErrorCode,
} from './evidence-authority-ledger.js';

/**
 * RET-005B-AUTH-001B3A: scope-bound capability-gated case adjudication.
 *
 * This module provides possession of a process-local, store-token-bound,
 * construction-scope-bound capability to transition existing
 * evidence-authority cases. It is not authentication. It does not verify a
 * human, an actor, a role, or a permission; it provides no undeniable proof
 * of origin and no durable attribution; the ledger records nothing
 * whatsoever about who adjudicated, and identity is not recoverable from any
 * stored value. It does not resist compromised in-process code: in-package
 * access to the ledger already implies full ledger authority. Real identity
 * verification and capability binding are obligations of the RET-005B wiring
 * packet and SEC-001B, not of this module.
 *
 * The construction-bound digest binds the idempotency key; it does not
 * attribute. Adjudication is durably anonymous in ledger v1: nothing in the
 * graph records or permits recovery of who adjudicated. The module emits,
 * returns, persists, and computes no clearance value of any kind, and it
 * offers no coverage revocation path.
 */
export const EVIDENCE_AUTHORITY_ADJUDICATION_VERSION =
  'memberry.evidence-authority-adjudication/1.0.0' as const;

const ADJUDICATION_ID_DOMAIN = 'memberry-evidence-authority-adjudication-v1';
const MAX_INPUT_LENGTH = 500;
const PROJECT_SCOPE = /^project:[a-z0-9][a-z0-9._-]*$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const PRINCIPAL_KEYS = ['tenantId', 'projectScope', 'principalId'] as const;
const REQUEST_KEYS = ['semanticId', 'caseId', 'decision'] as const;
const LEDGER_ERROR_CODES = new Set<EvidenceAuthorityLedgerErrorCode>([
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

export type EvidenceAuthorityAdjudicationDecisionV1 = 'reject' | 'begin_resolution' | 'resolve';

/** Closed decision-to-ledger-action mapping; no fourth verb exists. */
const DECISION_ACTIONS = Object.freeze({
  reject: 'rejected',
  begin_resolution: 'resolution_started',
  resolve: 'resolved',
} as const);

export interface EvidenceAuthorityAdjudicationPrincipalV1 {
  readonly tenantId: string;
  readonly projectScope: string;
  /**
   * Caller-asserted opaque label used solely as a digest input. It is never
   * verified, stored, returned, logged, or recoverable from any identifier.
   */
  readonly principalId: string;
}

export interface EvidenceAuthorityAdjudicationRequestV1 {
  readonly semanticId: string;
  readonly caseId: string;
  readonly decision: EvidenceAuthorityAdjudicationDecisionV1;
}

export interface EvidenceAuthorityAdjudicatedResultV1 {
  readonly contractVersion: typeof EVIDENCE_AUTHORITY_ADJUDICATION_VERSION;
  readonly outcome: 'adjudicated';
  readonly receipt: EvidenceAuthorityEventReceiptV1;
}

export interface EvidenceAuthorityUnadjudicatedResultV1 {
  readonly contractVersion: typeof EVIDENCE_AUTHORITY_ADJUDICATION_VERSION;
  readonly outcome: 'unadjudicated';
  readonly code: 'unadjudicated';
}

export type EvidenceAuthorityAdjudicationResultV1 =
  | EvidenceAuthorityAdjudicatedResultV1
  | EvidenceAuthorityUnadjudicatedResultV1;

export interface EvidenceAuthorityAdjudicationV1 {
  readonly contractVersion: typeof EVIDENCE_AUTHORITY_ADJUDICATION_VERSION;
  adjudicate(request: unknown): Promise<EvidenceAuthorityAdjudicationResultV1>;
}

/** Fixed, value-free non-adjudication outcome. Request values never enter it. */
const UNADJUDICATED: EvidenceAuthorityUnadjudicatedResultV1 = Object.freeze(
  Object.assign(Object.create(null), {
    contractVersion: EVIDENCE_AUTHORITY_ADJUDICATION_VERSION,
    outcome: 'unadjudicated',
    code: 'unadjudicated',
  }),
) as EvidenceAuthorityUnadjudicatedResultV1;

function adjudicatedResult(
  receipt: EvidenceAuthorityEventReceiptV1,
): EvidenceAuthorityAdjudicatedResultV1 {
  return Object.freeze(Object.assign(Object.create(null), {
    contractVersion: EVIDENCE_AUTHORITY_ADJUDICATION_VERSION,
    outcome: 'adjudicated',
    receipt,
  })) as EvidenceAuthorityAdjudicatedResultV1;
}

/** Byte budget first, charset second, always before any normalization or hashing. */
function boundedMatch(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_INPUT_LENGTH
    && pattern.test(value);
}

/**
 * Hostile-hardened construction parse. The principal is bound exactly once,
 * at construction; an invalid principal throws so no half-built object
 * escapes.
 */
function parseAdjudicationPrincipal(value: unknown): EvidenceAuthorityAdjudicationPrincipalV1 {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
      throw new EvidenceAuthorityLedgerError('invalid_scope');
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new EvidenceAuthorityLedgerError('invalid_scope');
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== PRINCIPAL_KEYS.length
      || ownKeys.some((key) => typeof key !== 'string'
        || !(PRINCIPAL_KEYS as readonly string[]).includes(key))) {
      throw new EvidenceAuthorityLedgerError('invalid_scope');
    }
    const input = Object.create(null) as Record<string, unknown>;
    for (const key of PRINCIPAL_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        throw new EvidenceAuthorityLedgerError('invalid_scope');
      }
      input[key] = descriptor.value;
    }
    if (!boundedMatch(input.tenantId, IDENTIFIER)
      || !boundedMatch(input.projectScope, PROJECT_SCOPE)
      || !boundedMatch(input.principalId, IDENTIFIER)) {
      throw new EvidenceAuthorityLedgerError('invalid_scope');
    }
    return Object.freeze({
      tenantId: input.tenantId,
      projectScope: input.projectScope,
      principalId: input.principalId,
    });
  } catch {
    throw new EvidenceAuthorityLedgerError('invalid_scope');
  }
}

/**
 * Hostile-hardened request parse. Returns null instead of throwing so every
 * malformed request maps to the single fixed unadjudicated code with zero
 * I/O. The request carries no tenant, project, principal, reviewer, or actor
 * key; exact-key parsing makes cross-scope adjudication unrepresentable.
 */
function parseAdjudicationRequest(value: unknown): EvidenceAuthorityAdjudicationRequestV1 | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== REQUEST_KEYS.length
      || ownKeys.some((key) => typeof key !== 'string'
        || !(REQUEST_KEYS as readonly string[]).includes(key))) {
      return null;
    }
    const input = Object.create(null) as Record<string, unknown>;
    for (const key of REQUEST_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return null;
      input[key] = descriptor.value;
    }
    if (!boundedMatch(input.semanticId, IDENTIFIER)
      || !boundedMatch(input.caseId, IDENTIFIER)
      || (input.decision !== 'reject'
        && input.decision !== 'begin_resolution'
        && input.decision !== 'resolve')) {
      return null;
    }
    return Object.freeze({
      semanticId: input.semanticId,
      caseId: input.caseId,
      decision: input.decision,
    });
  } catch {
    return null;
  }
}

/** Domain-separated sha256 over bounded inputs; never a substring of any input. */
function adjudicationDigest(values: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

function ledgerErrorCode(error: unknown): EvidenceAuthorityLedgerErrorCode {
  try {
    if (error instanceof EvidenceAuthorityLedgerError
      && LEDGER_ERROR_CODES.has(error.code)) {
      return error.code;
    }
  } catch {
    // A hostile Error subclass normalizes below.
  }
  return 'storage_unavailable';
}

export function createEvidenceAuthorityAdjudication(
  driver: Driver,
  principal: unknown,
): EvidenceAuthorityAdjudicationV1 {
  const parsed = parseAdjudicationPrincipal(principal);
  const tenantId = parsed.tenantId;
  const projectScope = parsed.projectScope;
  const principalDigest = adjudicationDigest([
    ADJUDICATION_ID_DOMAIN,
    'principal',
    tenantId,
    projectScope,
    parsed.principalId,
  ]);
  const persistence = createEvidenceAuthorityLedgerPersistence(driver);
  const adjudicate = async (rawRequest: unknown): Promise<EvidenceAuthorityAdjudicationResultV1> => {
    const request = parseAdjudicationRequest(rawRequest);
    if (request === null) return UNADJUDICATED;
    const scope = Object.freeze({
      tenantId,
      projectScope,
      semanticId: request.semanticId,
    });
    const operationId = `adj-op-${adjudicationDigest([
      ADJUDICATION_ID_DOMAIN,
      `operation-${request.decision}`,
      principalDigest,
      tenantId,
      projectScope,
      request.semanticId,
      request.caseId,
      request.decision,
    ])}`;
    const operation = Object.freeze({
      caseId: request.caseId,
      operationId,
      action: DECISION_ACTIONS[request.decision],
    });
    let facet: unknown;
    try {
      facet = createEvidenceAuthorityReviewFacet(persistence, scope);
    } catch {
      return UNADJUDICATED;
    }
    try {
      const receipt = await persistence.adjudicateCase(facet, scope, operation);
      return adjudicatedResult(receipt);
    } catch (error) {
      const code = ledgerErrorCode(error);
      // Only genuine storage faults are transient. Every policy refusal,
      // including the currently unreachable revoked-coverage code, is a
      // terminal unadjudicated result and is never retried.
      if (code === 'storage_unavailable' || code === 'write_incomplete') {
        throw new EvidenceAuthorityLedgerError(code);
      }
      return UNADJUDICATED;
    }
  };
  return Object.freeze(Object.assign(Object.create(null), {
    contractVersion: EVIDENCE_AUTHORITY_ADJUDICATION_VERSION,
    adjudicate,
  })) as EvidenceAuthorityAdjudicationV1;
}
