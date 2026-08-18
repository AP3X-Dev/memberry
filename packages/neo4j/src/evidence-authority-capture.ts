import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';

import type { Driver } from 'neo4j-driver';

import {
  EvidenceAuthorityLedgerError,
  createEvidenceAuthorityCaptureFacet,
  createEvidenceAuthorityLedgerPersistence,
  type EvidenceAuthorityEventReceiptV1,
  type EvidenceAuthorityLedgerErrorCode,
} from './evidence-authority-ledger.js';

export const EVIDENCE_AUTHORITY_CAPTURE_VERSION =
  'memberry.evidence-authority-capture/1.0.0' as const;

const CAPTURE_ID_DOMAIN = 'memberry-evidence-authority-capture-v1';
const MAX_INPUT_LENGTH = 500;
const PROJECT_SCOPE = /^project:[a-z0-9][a-z0-9._-]*$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SOURCE_EPISODE_ID = /^[A-Za-z0-9._:-]+$/;
const REQUEST_KEYS = [
  'tenantId', 'projectScope', 'semanticId', 'signalKind', 'sourceEpisodeId',
] as const;
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

export type EvidenceAuthorityCaptureSignalKindV1 = 'contradiction' | 'correction';

export interface EvidenceAuthorityCaptureRequestV1 {
  readonly tenantId: string;
  readonly projectScope: string;
  readonly semanticId: string;
  readonly signalKind: EvidenceAuthorityCaptureSignalKindV1;
  readonly sourceEpisodeId: string;
}

export interface EvidenceAuthorityCapturedResultV1 {
  readonly contractVersion: typeof EVIDENCE_AUTHORITY_CAPTURE_VERSION;
  readonly outcome: 'captured';
  readonly receipt: EvidenceAuthorityEventReceiptV1;
}

export interface EvidenceAuthorityUncapturedResultV1 {
  readonly contractVersion: typeof EVIDENCE_AUTHORITY_CAPTURE_VERSION;
  readonly outcome: 'uncaptured';
  readonly code: 'uncaptured';
}

export type EvidenceAuthorityCaptureResultV1 =
  | EvidenceAuthorityCapturedResultV1
  | EvidenceAuthorityUncapturedResultV1;

export interface EvidenceAuthorityCaptureV1 {
  readonly contractVersion: typeof EVIDENCE_AUTHORITY_CAPTURE_VERSION;
  capture(request: unknown): Promise<EvidenceAuthorityCaptureResultV1>;
}

/** Fixed, value-free non-capture outcome. Request values never enter it. */
const UNCAPTURED: EvidenceAuthorityUncapturedResultV1 = Object.freeze(
  Object.assign(Object.create(null), {
    contractVersion: EVIDENCE_AUTHORITY_CAPTURE_VERSION,
    outcome: 'uncaptured',
    code: 'uncaptured',
  }),
) as EvidenceAuthorityUncapturedResultV1;

function capturedResult(
  receipt: EvidenceAuthorityEventReceiptV1,
): EvidenceAuthorityCapturedResultV1 {
  return Object.freeze(Object.assign(Object.create(null), {
    contractVersion: EVIDENCE_AUTHORITY_CAPTURE_VERSION,
    outcome: 'captured',
    receipt,
  })) as EvidenceAuthorityCapturedResultV1;
}

/** Byte budget first, charset second, always before any normalization or hashing. */
function boundedMatch(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_INPUT_LENGTH
    && pattern.test(value);
}

/**
 * Hostile-hardened request parse. Returns null instead of throwing so every
 * malformed request maps to the single fixed uncaptured code with zero I/O.
 */
function parseCaptureRequest(value: unknown): EvidenceAuthorityCaptureRequestV1 | null {
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
    if (!boundedMatch(input.tenantId, IDENTIFIER)
      || !boundedMatch(input.projectScope, PROJECT_SCOPE)
      || !boundedMatch(input.semanticId, IDENTIFIER)
      || (input.signalKind !== 'contradiction' && input.signalKind !== 'correction')
      || !boundedMatch(input.sourceEpisodeId, SOURCE_EPISODE_ID)) {
      return null;
    }
    return Object.freeze({
      tenantId: input.tenantId,
      projectScope: input.projectScope,
      semanticId: input.semanticId,
      signalKind: input.signalKind,
      sourceEpisodeId: input.sourceEpisodeId,
    });
  } catch {
    return null;
  }
}

/** Domain-separated sha256 over the normalized identity tuple; never a substring of any input. */
function captureDigest(salt: string, request: EvidenceAuthorityCaptureRequestV1): string {
  return createHash('sha256')
    .update(JSON.stringify([
      CAPTURE_ID_DOMAIN,
      salt,
      request.tenantId,
      request.projectScope,
      request.semanticId,
      request.sourceEpisodeId,
      request.signalKind,
    ]))
    .digest('hex');
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

export function createEvidenceAuthorityCapture(driver: Driver): EvidenceAuthorityCaptureV1 {
  const persistence = createEvidenceAuthorityLedgerPersistence(driver);
  const capture = async (rawRequest: unknown): Promise<EvidenceAuthorityCaptureResultV1> => {
    const request = parseCaptureRequest(rawRequest);
    if (request === null) return UNCAPTURED;
    const scope = Object.freeze({
      tenantId: request.tenantId,
      projectScope: request.projectScope,
      semanticId: request.semanticId,
    });
    const operation = Object.freeze({
      caseId: `capture-case-${captureDigest('case', request)}`,
      coverageOperationId: `capture-op-coverage-${captureDigest('operation-coverage', request)}`,
      caseOperationId: `capture-op-case-${captureDigest('operation-case', request)}`,
    });
    let facet: unknown;
    try {
      facet = createEvidenceAuthorityCaptureFacet(persistence, scope);
    } catch {
      return UNCAPTURED;
    }
    try {
      const result = await persistence.captureCase(facet, scope, operation);
      return capturedResult(result.caseReceipt);
    } catch (error) {
      const code = ledgerErrorCode(error);
      // invalid_transition and operation_conflict are terminal policy refusals, not transient failures; the (B-i) zero-raw-edge refusal is the only module-reachable producer, and an uncaptured result is never retried.
      if (code === 'invalid_transition' || code === 'operation_conflict') {
        return UNCAPTURED;
      }
      throw new EvidenceAuthorityLedgerError(code);
    }
  };
  return Object.freeze(Object.assign(Object.create(null), {
    contractVersion: EVIDENCE_AUTHORITY_CAPTURE_VERSION,
    capture,
  })) as EvidenceAuthorityCaptureV1;
}
