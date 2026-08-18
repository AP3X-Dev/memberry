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
 * RET-005B-AUTH-001B3B1: scope-bound capability-gated coverage revocation.
 *
 * This module provides possession of a process-local, store-token-bound,
 * construction-scope-bound capability to revoke evidence-authority coverage.
 * It is not authentication. It verifies no human, actor, role, or
 * permission; it provides no undeniable proof of origin and no durable
 * attribution: the ledger records nothing about who revoked, and identity
 * is not recoverable from any stored value. Revocation is irreversible by
 * construction: no re-open, re-enroll, or un-revoke verb exists in this
 * package or is named anywhere in this lane. Revocation permanently freezes
 * any open case on that coverage and renders the Semantic permanently
 * unsupported under Decision 98 and Decision 104 (B-ii) — never clear and
 * never withheld.
 *
 * The construction-bound digest binds the idempotency key; it does not
 * attribute. Revocation is durably anonymous in ledger v1: nothing in the
 * graph records or permits recovery of who revoked. The module emits,
 * returns, persists, and computes no clearance value of any kind, and it
 * offers no coverage or case creation path and no read or listing surface.
 */
export const EVIDENCE_AUTHORITY_REVOCATION_VERSION =
  'memberry.evidence-authority-revocation/1.0.0' as const;

const REVOCATION_ID_DOMAIN = 'memberry-evidence-authority-revocation-v1';
const MAX_INPUT_LENGTH = 500;
const PROJECT_SCOPE = /^project:[a-z0-9][a-z0-9._-]*$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const PRINCIPAL_KEYS = ['tenantId', 'projectScope', 'principalId'] as const;
const REQUEST_KEYS = ['semanticId'] as const;
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

export interface EvidenceAuthorityRevocationPrincipalV1 {
  readonly tenantId: string;
  readonly projectScope: string;
  /**
   * Caller-asserted opaque label used solely as a digest input. It is never
   * verified, stored, returned, logged, or recoverable from any identifier.
   */
  readonly principalId: string;
}

export interface EvidenceAuthorityRevocationRequestV1 {
  readonly semanticId: string;
}

export interface EvidenceAuthorityRevokedResultV1 {
  readonly contractVersion: typeof EVIDENCE_AUTHORITY_REVOCATION_VERSION;
  readonly outcome: 'revoked';
  readonly receipt: EvidenceAuthorityEventReceiptV1;
}

export interface EvidenceAuthorityUnrevokedResultV1 {
  readonly contractVersion: typeof EVIDENCE_AUTHORITY_REVOCATION_VERSION;
  readonly outcome: 'unrevoked';
  readonly code: 'unrevoked';
}

export type EvidenceAuthorityRevocationResultV1 =
  | EvidenceAuthorityRevokedResultV1
  | EvidenceAuthorityUnrevokedResultV1;

export interface EvidenceAuthorityRevocationV1 {
  readonly contractVersion: typeof EVIDENCE_AUTHORITY_REVOCATION_VERSION;
  revoke(request: unknown): Promise<EvidenceAuthorityRevocationResultV1>;
}

/** Fixed, value-free non-revocation outcome. Request values never enter it. */
const UNREVOKED: EvidenceAuthorityUnrevokedResultV1 = Object.freeze(
  Object.assign(Object.create(null), {
    contractVersion: EVIDENCE_AUTHORITY_REVOCATION_VERSION,
    outcome: 'unrevoked',
    code: 'unrevoked',
  }),
) as EvidenceAuthorityUnrevokedResultV1;

function revokedResult(
  receipt: EvidenceAuthorityEventReceiptV1,
): EvidenceAuthorityRevokedResultV1 {
  return Object.freeze(Object.assign(Object.create(null), {
    contractVersion: EVIDENCE_AUTHORITY_REVOCATION_VERSION,
    outcome: 'revoked',
    receipt,
  })) as EvidenceAuthorityRevokedResultV1;
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
function parseRevocationPrincipal(value: unknown): EvidenceAuthorityRevocationPrincipalV1 {
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
 * malformed request maps to the single fixed unrevoked code with zero I/O.
 * The request carries no tenant, project, principal, coverage, case, or
 * actor key; exact-key parsing makes cross-scope revocation unrepresentable.
 */
function parseRevocationRequest(value: unknown): EvidenceAuthorityRevocationRequestV1 | null {
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
    if (!boundedMatch(input.semanticId, IDENTIFIER)) {
      return null;
    }
    return Object.freeze({
      semanticId: input.semanticId,
    });
  } catch {
    return null;
  }
}

/** Domain-separated sha256 over bounded inputs; never a substring of any input. */
function revocationDigest(values: readonly string[]): string {
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

export function createEvidenceAuthorityRevocation(
  driver: Driver,
  principal: unknown,
): EvidenceAuthorityRevocationV1 {
  const parsed = parseRevocationPrincipal(principal);
  const tenantId = parsed.tenantId;
  const projectScope = parsed.projectScope;
  const principalDigest = revocationDigest([
    REVOCATION_ID_DOMAIN,
    'principal',
    tenantId,
    projectScope,
    parsed.principalId,
  ]);
  const persistence = createEvidenceAuthorityLedgerPersistence(driver);
  const revoke = async (rawRequest: unknown): Promise<EvidenceAuthorityRevocationResultV1> => {
    const request = parseRevocationRequest(rawRequest);
    if (request === null) return UNREVOKED;
    const scope = Object.freeze({
      tenantId,
      projectScope,
      semanticId: request.semanticId,
    });
    const operationId = `rev-op-${revocationDigest([
      REVOCATION_ID_DOMAIN,
      'operation-revoke',
      principalDigest,
      tenantId,
      projectScope,
      request.semanticId,
    ])}`;
    const operation = Object.freeze({ operationId });
    let facet: unknown;
    try {
      facet = createEvidenceAuthorityReviewFacet(persistence, scope);
    } catch {
      return UNREVOKED;
    }
    try {
      const receipt = await persistence.revokeCoverageByReview(facet, scope, operation);
      return revokedResult(receipt);
    } catch (error) {
      const code = ledgerErrorCode(error);
      // Only genuine storage faults are transient. Every policy refusal,
      // including refusal of a coverage that is already revoked or was never
      // opened, is a terminal unrevoked result and is never retried.
      if (code === 'storage_unavailable' || code === 'write_incomplete') {
        throw new EvidenceAuthorityLedgerError(code);
      }
      return UNREVOKED;
    }
  };
  return Object.freeze(Object.assign(Object.create(null), {
    contractVersion: EVIDENCE_AUTHORITY_REVOCATION_VERSION,
    revoke,
  })) as EvidenceAuthorityRevocationV1;
}
