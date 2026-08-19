/**
 * RET-005B-AUTH-001B5: evidence eligibility composition, fact-only V1.
 *
 * This module composes one contract-canonical eligibility result from one
 * observation of source-owned Fact state. It is not authentication and it is
 * not authorization: it verifies no human, actor, role, or permission, and it
 * performs no access check of any kind. It confers no containment whatsoever.
 * It holds one narrow authority: the mapping from observed source state onto
 * the published axes, and the refusal of every batch it cannot answer honestly.
 *
 * V1 answers exactly one evidence type. A batch containing any candidate of
 * another type is refused whole, before any observation is requested, because
 * the two other types have no lifecycle and no valid-time source at all in
 * this codebase, and emitting an axis value for a state nobody observed would
 * be policy invention wearing a receipt's clothes. That is a disclosed scope
 * limit, not a defect, and it is the honest maximum available at V1.
 *
 * The observation arrives through a structural port whose return value is
 * treated as untrusted input: shape, count, order, and identity are all
 * checked before a single field is used. The port is not imported, not typed
 * from its own package, and not constructed here; the wiring layer owns which
 * observer is passed in.
 *
 * All or nothing: one refusal refuses the batch, there are no partial
 * receipts, no accumulator survives a refusal, and nothing is written, cached,
 * or retained on any path. Every instant in the output comes from the observer;
 * this module reads no clock, so a receipt can never claim a frame the
 * observation did not have.
 *
 * The composed result is the sealed parser's own canonicalized output. A
 * mapping mistake therefore fails as a contract error rather than escaping as
 * a plausible-looking receipt, and the catch around the observation call is
 * scoped to that one await so a mapping fault can never be laundered into a
 * policy answer.
 *
 * This module is absent from the package root export.
 */
import {
  EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_PROVENANCE_REF_BYTES,
  parseEvidenceEligibilityAuthorityRequestV1,
  parseEvidenceEligibilityAuthorityResultV1,
  type EvidenceEligibilityAuthorityDescriptorV1,
  type EvidenceEligibilityAuthorityReceiptV1,
  type EvidenceEligibilityAuthorityRequestV1,
  type EvidenceEligibilityAuthorityResultV1,
  type EvidenceEligibilityAuthorityUnsupportedCodeV1,
} from './evidence-eligibility-authority.js';

export const EVIDENCE_ELIGIBILITY_COMPOSITION_VERSION =
  'memberry.evidence-eligibility-composition/1.0.0' as const;

export interface EvidenceEligibilityCompositionFactStatePortV1 {
  observeFactState(request: unknown): Promise<unknown>;
}

export interface EvidenceEligibilityCompositionV1 {
  readonly contractVersion: typeof EVIDENCE_ELIGIBILITY_COMPOSITION_VERSION;
  composeAuthorityResult(request: unknown): Promise<EvidenceEligibilityAuthorityResultV1>;
}

// Hand copies of unexported contract predicates, source-pinned by the unit
// suite. The contract exports neither, and the sealed file is never edited.
const SAFE_PROVENANCE_REF = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/;
const CANONICAL_INSTANT = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
// A bounded string only. The status vocabulary itself is checked in exactly
// one place, and this is deliberately not that place.
const MAX_STATUS_LENGTH = 64;
const SOURCE_POLICY_UNAVAILABLE = 'source-policy-unavailable';
const RECORD_TIME_UNAVAILABLE = 'record-time-unavailable';
const FACT_SOURCE_TYPE = 'fact';
// Total, fail-closed, deliberately not injective: the contract's code set is
// content-free by design, and separating "this id is not in your tenant" from
// "the observer is down" is exactly the disclosure the contract prevents. The
// frame code can only arrive from an observer that has violated its own
// contract, because this module only ever asks for the current frame; it is a
// misbehaving-observer signal, never a temporal claim.
const PORT_CODE_MAPPING = Object.freeze(Object.assign(Object.create(null), {
  'fact-state-source-unavailable': SOURCE_POLICY_UNAVAILABLE,
  'fact-state-frame-unsupported': SOURCE_POLICY_UNAVAILABLE,
  'fact-state-candidate-missing': SOURCE_POLICY_UNAVAILABLE,
  'fact-state-status-unrecognized': SOURCE_POLICY_UNAVAILABLE,
  'fact-state-time-unusable': RECORD_TIME_UNAVAILABLE,
})) as Readonly<Record<string, EvidenceEligibilityAuthorityUnsupportedCodeV1>>;

interface PortEntryV1 {
  readonly evidenceId: string;
  readonly status: string;
  readonly withinValidTime: boolean;
  readonly superseded: boolean;
}

interface ObservationV1 {
  readonly contractVersion: string;
  readonly observedAt: string;
  readonly entries: readonly PortEntryV1[];
}

type Refusal = {
  readonly ok: false;
  readonly code: EvidenceEligibilityAuthorityUnsupportedCodeV1;
};

type MappedEntry = { readonly ok: true; readonly receipt: EvidenceEligibilityAuthorityReceiptV1 }
  | Refusal;

type ValidatedObservation = { readonly ok: true; readonly observation: ObservationV1 } | Refusal;

function refused(code: EvidenceEligibilityAuthorityUnsupportedCodeV1): Refusal {
  return Object.freeze(Object.assign(Object.create(null), { ok: false, code })) as Refusal;
}

function frozenRecord<T extends object>(fields: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), fields)) as Readonly<T>;
}

/** A plain record, by prototype; a class instance or an array is not one. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

/**
 * Step 6. The cross-package boundary is untrusted input. Shape, count, order,
 * and identity are all checked before any field is used, field-wise by direct
 * access: a hostile accessor therefore throws through this function instead of
 * being quietly normalized, and that throw is deliberately not caught anywhere.
 * The status is checked for a bounded string and nothing else here.
 */
function validateObservation(
  value: unknown,
  candidates: readonly EvidenceEligibilityAuthorityDescriptorV1[],
): ValidatedObservation {
  if (!isPlainRecord(value)) return refused(SOURCE_POLICY_UNAVAILABLE);
  const outcome = value.outcome;
  if (outcome === 'unsupported') {
    const code = value.code;
    if (typeof code !== 'string' || !Object.hasOwn(PORT_CODE_MAPPING, code)) {
      return refused(SOURCE_POLICY_UNAVAILABLE);
    }
    return refused(PORT_CODE_MAPPING[code]!);
  }
  if (outcome !== 'observed') return refused(SOURCE_POLICY_UNAVAILABLE);
  const contractVersion = value.contractVersion;
  if (!boundedText(contractVersion, EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_PROVENANCE_REF_BYTES)
    || !SAFE_PROVENANCE_REF.test(contractVersion)) {
    return refused(SOURCE_POLICY_UNAVAILABLE);
  }
  const observedAt = value.observedAt;
  if (typeof observedAt !== 'string'
    || observedAt.length !== 24
    || !CANONICAL_INSTANT.test(observedAt)) {
    return refused(RECORD_TIME_UNAVAILABLE);
  }
  const rawEntries = value.entries;
  if (!Array.isArray(rawEntries)) return refused(SOURCE_POLICY_UNAVAILABLE);
  // Read once: a length-varying value must not be able to size the count check
  // and the loop differently and leave a hole behind.
  const entryCount = rawEntries.length;
  if (entryCount !== candidates.length) return refused(SOURCE_POLICY_UNAVAILABLE);
  const entries = new Array<PortEntryV1>(entryCount);
  for (let index = 0; index < entryCount; index += 1) {
    const entry: unknown = rawEntries[index];
    if (!isPlainRecord(entry)) return refused(SOURCE_POLICY_UNAVAILABLE);
    const evidenceId = entry.evidenceId;
    const status = entry.status;
    const withinValidTime = entry.withinValidTime;
    const superseded = entry.superseded;
    if (typeof evidenceId !== 'string'
      || evidenceId !== candidates[index]!.evidenceId
      || !boundedText(status, MAX_STATUS_LENGTH)
      || typeof withinValidTime !== 'boolean'
      || typeof superseded !== 'boolean') {
      return refused(SOURCE_POLICY_UNAVAILABLE);
    }
    entries[index] = frozenRecord({ evidenceId, status, withinValidTime, superseded });
  }
  return frozenRecord({
    ok: true as const,
    observation: frozenRecord({
      contractVersion,
      observedAt,
      entries: Object.freeze(entries) as readonly PortEntryV1[],
    }),
  });
}

// --- B5-MAP-BEGIN mapFactEntryToReceipt ---
// The single home of the fact status whitelist and of every axis literal in
// this module. A status outside the three known ones is a defined, contract
// relevant observation rather than a mapping defect, so it returns a refusal
// and never throws: a throw here would have needed a second catch, and that
// catch would have laundered genuine mapping faults into a policy answer.
// Provenance carries the observer's own version as its ref, echoed, never a
// literal, so a receipt always names the surface that actually observed it.
function mapFactEntryToReceipt(
  candidate: EvidenceEligibilityAuthorityDescriptorV1,
  entry: PortEntryV1,
  ref: string,
): MappedEntry {
  let lifecycle: 'active' | 'inactive';
  let contradiction: 'clear' | 'withheld';
  if (entry.status === 'active') {
    // Lifecycle-live and uncontested.
    lifecycle = 'active';
    contradiction = 'clear';
  } else if (entry.status === 'disputed') {
    // A dispute never writes an invalidation time, so the record is provably
    // still lifecycle-live while its content is contested; this is read out of
    // the source's own write path, not arranged to fit the parser.
    lifecycle = 'active';
    contradiction = 'withheld';
  } else if (entry.status === 'invalidated') {
    lifecycle = 'inactive';
    contradiction = 'clear';
  } else {
    return refused(SOURCE_POLICY_UNAVAILABLE);
  }
  const receipt = frozenRecord({
    ref: candidate.ref,
    sourceType: candidate.sourceType,
    evidenceId: candidate.evidenceId,
    lifecycle,
    temporal: entry.withinValidTime ? 'in-frame' : 'out-of-frame',
    supersession: entry.superseded ? 'superseded' : 'clear',
    contradiction,
    provenance: frozenRecord({ policy: 'fact-current-source-owned-v1', ref }),
  }) as EvidenceEligibilityAuthorityReceiptV1;
  return frozenRecord({ ok: true as const, receipt });
}
// --- B5-MAP-END mapFactEntryToReceipt ---

function unsupportedDraft(
  request: EvidenceEligibilityAuthorityRequestV1,
  code: EvidenceEligibilityAuthorityUnsupportedCodeV1,
): unknown {
  return frozenRecord({
    contractId: request.contractId,
    contractVersion: request.contractVersion,
    outcome: 'unsupported',
    tenantId: request.tenantId,
    projectScope: request.projectScope,
    resolvedEntityId: request.resolvedEntityId,
    temporalFrame: request.temporalFrame,
    recordTime: request.recordTime,
    code,
  });
}

export function createEvidenceEligibilityComposition(
  factState: EvidenceEligibilityCompositionFactStatePortV1,
): EvidenceEligibilityCompositionV1 {
  const composeAuthorityResult = async (
    request: unknown,
  ): Promise<EvidenceEligibilityAuthorityResultV1> => {
    // 1. Contract errors are caller faults and propagate unchanged; they are
    //    never rewritten into an unsupported capability.
    const parsed = parseEvidenceEligibilityAuthorityRequestV1(request);

    // 2. No historical authority anywhere in V1, and the contract makes a
    //    supported historical result unrepresentable. Sole carrier of this
    //    code in this module; no observation is requested.
    if (parsed.temporalFrame.mode === 'as-of') {
      return parseEvidenceEligibilityAuthorityResultV1(
        unsupportedDraft(parsed, 'temporal-history-unavailable'),
        parsed,
      );
    }

    // 3. One unanswerable candidate refuses the whole batch, with zero
    //    database contact of any kind.
    const evidenceIds = new Array<string>(parsed.candidates.length);
    for (let index = 0; index < parsed.candidates.length; index += 1) {
      const candidate = parsed.candidates[index]!;
      if (candidate.sourceType !== FACT_SOURCE_TYPE) {
        return parseEvidenceEligibilityAuthorityResultV1(
          unsupportedDraft(parsed, SOURCE_POLICY_UNAVAILABLE),
          parsed,
        );
      }
      evidenceIds[index] = candidate.evidenceId;
    }

    // 4/5. Exactly one observation per request, in request order. An empty
    //      list is lawful and yields a supported result with no receipts. The
    //      catch covers this await and nothing else.
    let observation: unknown;
    try {
      observation = await factState.observeFactState(frozenRecord({
        mode: 'current',
        evidenceIds: Object.freeze(evidenceIds) as readonly string[],
      }));
    } catch {
      return parseEvidenceEligibilityAuthorityResultV1(
        unsupportedDraft(parsed, SOURCE_POLICY_UNAVAILABLE),
        parsed,
      );
    }

    // 6. Untrusted input, validated before use.
    const validated = validateObservation(observation, parsed.candidates);
    if (!validated.ok) {
      return parseEvidenceEligibilityAuthorityResultV1(
        unsupportedDraft(parsed, validated.code),
        parsed,
      );
    }

    // 7. One receipt per candidate, in candidate order; a refused entry
    //    refuses the batch and no partial receipt survives.
    const receipts = new Array<EvidenceEligibilityAuthorityReceiptV1>(parsed.candidates.length);
    for (let index = 0; index < parsed.candidates.length; index += 1) {
      const mapped = mapFactEntryToReceipt(
        parsed.candidates[index]!,
        validated.observation.entries[index]!,
        validated.observation.contractVersion,
      );
      if (!mapped.ok) {
        return parseEvidenceEligibilityAuthorityResultV1(
          unsupportedDraft(parsed, mapped.code),
          parsed,
        );
      }
      receipts[index] = mapped.receipt;
    }

    // 8. The sealed parser's own canonicalized output, and nothing else.
    return parseEvidenceEligibilityAuthorityResultV1(frozenRecord({
      contractId: parsed.contractId,
      contractVersion: parsed.contractVersion,
      outcome: 'supported',
      tenantId: parsed.tenantId,
      projectScope: parsed.projectScope,
      resolvedEntityId: parsed.resolvedEntityId,
      temporalFrame: parsed.temporalFrame,
      recordTime: parsed.recordTime,
      recordedAt: validated.observation.observedAt,
      receipts: Object.freeze(receipts) as readonly EvidenceEligibilityAuthorityReceiptV1[],
    }), parsed);
  };

  return frozenRecord({
    contractVersion: EVIDENCE_ELIGIBILITY_COMPOSITION_VERSION,
    composeAuthorityResult,
  }) as EvidenceEligibilityCompositionV1;
}
