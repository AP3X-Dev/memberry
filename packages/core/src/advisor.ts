// packages/core/src/advisor.ts
//
// MEM-008 risky-proposal advisor: a deterministic risk score + structured
// rationale for every proposal that falls through to the review queue.
// Recommendation metadata ONLY — no apply decision ever reads it, and both
// auto-apply hatches (consolidation.ts) stay untouched. Pure synchronous
// function of the proposal object: no I/O, no LLM, no config. v1 scores on
// structural signals only (`calibration: 'structural-only'`) because no
// persisted ReliabilityReportV1 store exists at this SHA; that field is the
// forward-compatible seam for calibration-aware scoring.

import type { ConsolidationProposal, ProposalType } from './types.js';

export const ADVISOR_CONTRACT_VERSION = 'advisor/v1' as const;

export type AdvisorBandV1 = 'low' | 'elevated' | 'high';
export type AdvisorReasonV1 =
  | 'base_supersede' | 'base_decay' | 'base_merge' | 'base_promote' | 'base_reinforce'
  | 'multi_target'            // affected_ids.length > 1
  | 'confidence_drop_major'   // before→after confidence drop ≥ 300‰
  | 'confidence_drop_minor'   // drop ≥ 100‰ (and < 300‰)
  | 'decision_target'         // before.memory_type === 'decision'
  | 'archived_target'         // before.archived === true
  | 'low_signal_count'        // before.signal_count is a number ≤ 2
  | 'low_confidence_result';  // after.confidence is a finite number < 0.5

export interface AdvisorRecommendationV1 {
  contract: typeof ADVISOR_CONTRACT_VERSION;
  /** 0..1000, integer (sum of the closed table, clamped). */
  risk_permille: number;
  /** <300 low | 300..599 elevated | ≥600 high. */
  band: AdvisorBandV1;
  /** Lexicographically sorted, deduped, closed enum. */
  reasons: AdvisorReasonV1[];
  /** v1 constant — no persisted ReliabilityReportV1 exists to read. */
  calibration: 'structural-only';
}

// Closed base-score table: contradiction/correction clusters surface as
// supersede (the loudest class), decay is the nightly lifecycle class, merge is
// dormant but scored for completeness, promote/reinforce are the classes the
// hatches may auto-apply (queued instances land low by construction).
const BASE_PERMILLE: Record<ProposalType, { permille: number; reason: AdvisorReasonV1 }> = {
  supersede: { permille: 600, reason: 'base_supersede' },
  merge: { permille: 500, reason: 'base_merge' },
  decay: { permille: 400, reason: 'base_decay' },
  promote: { permille: 200, reason: 'base_promote' },
  reinforce: { permille: 100, reason: 'base_reinforce' },
};

/** Band mapping, exported so the exact edges (299/300/599/600) are pinnable. */
export function advisorBandForPermilleV1(permille: number): AdvisorBandV1 {
  if (permille >= 600) return 'high';
  if (permille >= 300) return 'elevated';
  return 'low';
}

/**
 * Score one proposal. Deterministic, order-independent, frozen output — the
 * same proposal yields the same bytes forever, so crash-redelivered re-saves
 * converge. Modifiers fire only when their field is present and correctly
 * typed on the proposal itself (decay carries confidences only; supersede and
 * reinforce embed the full target node in `before`).
 */
export function adviseProposalV1(proposal: ConsolidationProposal): AdvisorRecommendationV1 {
  const base = BASE_PERMILLE[proposal.type];
  if (!base) throw new Error(`[advisor] unknown proposal type: ${String(proposal.type)}`);

  let total = base.permille;
  const reasons: AdvisorReasonV1[] = [base.reason];
  const add = (permille: number, reason: AdvisorReasonV1): void => {
    total += permille;
    reasons.push(reason);
  };

  const before = (proposal.before ?? {}) as Record<string, unknown>;
  const after = (proposal.after ?? {}) as Record<string, unknown>;

  if (Array.isArray(proposal.affected_ids) && proposal.affected_ids.length > 1) {
    add(100, 'multi_target');
  }

  // Verifier C1: compare on integer permille, never raw floats — 0.9 - 0.8 is
  // 0.09999999999999998 and a float >= 0.1 check silently misses the mainline
  // single-correction supersede drop.
  const beforeConfidence = before.confidence;
  const afterConfidence = after.confidence;
  if (Number.isFinite(beforeConfidence) && Number.isFinite(afterConfidence)) {
    const dropPermille = Math.round(((beforeConfidence as number) - (afterConfidence as number)) * 1000);
    if (dropPermille >= 300) add(200, 'confidence_drop_major');
    else if (dropPermille >= 100) add(100, 'confidence_drop_minor');
  }

  if (before.memory_type === 'decision') add(250, 'decision_target');
  if (before.archived === true) add(100, 'archived_target');
  if (Number.isFinite(before.signal_count) && (before.signal_count as number) <= 2) {
    add(100, 'low_signal_count');
  }
  // Verifier C2: Number.isFinite excludes NaN explicitly (typeof would not).
  if (Number.isFinite(afterConfidence) && (afterConfidence as number) < 0.5) {
    add(100, 'low_confidence_result');
  }

  const clamped = Math.min(1000, Math.max(0, Math.round(total)));
  const record: AdvisorRecommendationV1 = {
    contract: ADVISOR_CONTRACT_VERSION,
    risk_permille: clamped,
    band: advisorBandForPermilleV1(clamped),
    reasons: [...new Set(reasons)].sort(),
    calibration: 'structural-only',
  };
  Object.freeze(record.reasons);
  return Object.freeze(record);
}

/**
 * Attach a recommendation to a proposal bound for the review queue. NEVER
 * throws: on any advisor failure the proposal is returned unchanged (saved
 * without advice) after one typed log line — a broken advisor must not block
 * proposal saving on either the consolidation gate or the lifecycle pass.
 */
export function attachAdvisorV1(proposal: ConsolidationProposal): ConsolidationProposal {
  try {
    return { ...proposal, advisor: adviseProposalV1(proposal) };
  } catch (err) {
    try {
      const id = typeof proposal?.id === 'string' ? proposal.id : '<unknown>';
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[advisor] scoring failed for proposal ${id}: ${message}`);
    } catch {
      // Logging must never throw either.
    }
    return proposal;
  }
}
