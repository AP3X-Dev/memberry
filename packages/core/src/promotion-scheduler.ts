// packages/core/src/promotion-scheduler.ts
//
// MEM-005: fair keyset scheduling for the episodic->semantic promotion fetch.
//
// findPromotable restarts from the head of (classTier, created_at, id) every
// pass, so once maxCandidates eligible-but-unpromotable episodes accumulate at
// the head, newer evidence is never fetched. This pure module supplies the
// cursor contract for a dual-window fetch: a head window (unchanged first-pass
// semantics) plus a keyset continuation window that advances monotonically and
// wraps at exhaustion, so deferral is finite and nothing is ever dropped.
//
// Everything here is pure and hostile-safe: the cursor is round-tripped through
// Redis, so the parser trusts nothing. A corrupt cursor means "restart from
// head", never an error — scheduling must never break a promotion pass.

export const SCHEDULER_CONTRACT_VERSION = 'promotion-scheduler-v1' as const;

/** Longest serialized cursor accepted back from storage; anything larger is
 *  not something this module wrote and is rejected as corrupt. */
const MAX_CURSOR_LENGTH = 4096;

/** Keyset position after which the continuation window resumes. Matches the
 *  findPromotable ORDER BY key exactly: (classTier CASE, created_at, id). */
export interface PromotionCursorV1 {
  readonly contractVersion: typeof SCHEDULER_CONTRACT_VERSION;
  readonly classTier: 0 | 1 | 2;
  readonly createdAt: string;
  readonly id: string;
}

/** The minimal episode shape the scheduler reads — a structural subset of
 *  EpisodicNode, so both windows' batches satisfy it without conversion. */
export interface PromotionEpisodeLikeV1 {
  readonly id: string;
  readonly created_at: string;
  readonly memory_type?: string;
  readonly outcome?: string;
}

export type SchedulerContractErrorCode = 'invalid-max-candidates';

/** Contract failures name only a closed code, never input values. */
export class SchedulerContractError extends Error {
  constructor(readonly code: SchedulerContractErrorCode) {
    super(`promotion_scheduler_contract:${code}`);
    this.name = 'SchedulerContractError';
  }
}

const CURSOR_KEYS = ['contractVersion', 'classTier', 'createdAt', 'id'] as const;

/**
 * The classification tier of an episode, derived by exactly the CASE rule in
 * findPromotable's ORDER BY (episodic.ts): approved decisions first, classified
 * recurrence next, everything else (including legacy unclassified) last.
 */
export function promotionClassTierV1(episode: PromotionEpisodeLikeV1): 0 | 1 | 2 {
  if (episode.memory_type === 'decision' && episode.outcome === 'approved') return 0;
  if (episode.memory_type === 'pattern' || episode.memory_type === 'convention') return 1;
  return 2;
}

/**
 * Closed parser for a cursor read back from Redis. Returns null on ANY defect
 * (non-string, oversized, non-JSON, wrong shape/keys, prototype tricks,
 * non-string fields, tier out of range, empty strings) and never throws for
 * hostile input: a corrupt cursor simply restarts the scan from the head.
 */
export function parsePromotionCursorV1(raw: unknown): PromotionCursorV1 | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_CURSOR_LENGTH) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  // JSON.parse yields plain objects, but keep the shape closed: exactly the
  // contract keys as own properties (a literal "__proto__" key fails here).
  const keys = Reflect.ownKeys(parsed);
  if (keys.length !== CURSOR_KEYS.length) return null;
  for (const key of CURSOR_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) return null;
  }
  const record = parsed as Record<string, unknown>;
  if (record.contractVersion !== SCHEDULER_CONTRACT_VERSION) return null;
  const tier = record.classTier;
  if (tier !== 0 && tier !== 1 && tier !== 2) return null;
  if (typeof record.createdAt !== 'string' || record.createdAt === '') return null;
  if (typeof record.id !== 'string' || record.id === '') return null;
  return Object.freeze({
    contractVersion: SCHEDULER_CONTRACT_VERSION,
    classTier: tier,
    createdAt: record.createdAt,
    id: record.id,
  });
}

/** Canonical fixed-key JSON — the only representation the parser accepts. */
export function serializePromotionCursorV1(cursor: PromotionCursorV1): string {
  return JSON.stringify({
    contractVersion: cursor.contractVersion,
    classTier: cursor.classTier,
    createdAt: cursor.createdAt,
    id: cursor.id,
  });
}

/**
 * Split one pass's candidate budget into the two windows. Head keeps the extra
 * slot on odd budgets so first-pass service is never smaller than half. Throws
 * on a non-integer or out-of-range budget — config-sourced maxCandidates
 * bypasses the env clamp, so the caller must treat this as a scheduler failure
 * and degrade to head-only, not crash the pass.
 */
export function planPromotionFetchV1(
  maxCandidates: number,
): { readonly headLimit: number; readonly continuationLimit: number } {
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 2000) {
    throw new SchedulerContractError('invalid-max-candidates');
  }
  return Object.freeze({
    headLimit: Math.ceil(maxCandidates / 2),
    continuationLimit: Math.floor(maxCandidates / 2),
  });
}

function cursorFromEpisode(episode: PromotionEpisodeLikeV1): PromotionCursorV1 {
  return Object.freeze({
    contractVersion: SCHEDULER_CONTRACT_VERSION,
    classTier: promotionClassTierV1(episode),
    createdAt: episode.created_at,
    id: episode.id,
  });
}

/**
 * Compute the cursor for the next pass.
 *
 * - Continuation ran (`continuationBatch !== null`): cursor = keyset key of its
 *   last element; null (wrap to head next pass) when the batch came back short
 *   — the scan is exhausted.
 * - Seed pass (`continuationBatch === null`, no valid cursor existed): cursor =
 *   keyset key of the LAST head-batch element, so pass 2's continuation starts
 *   immediately after the head window; null when the head batch is short — the
 *   entire eligible set fits in the head window and no cursor is needed.
 */
export function advancePromotionCursorV1(
  continuationBatch: PromotionEpisodeLikeV1[] | null,
  continuationLimit: number,
  headBatch: PromotionEpisodeLikeV1[],
  headLimit: number,
): PromotionCursorV1 | null {
  if (continuationBatch !== null) {
    if (continuationBatch.length === 0 || continuationBatch.length < continuationLimit) return null;
    return cursorFromEpisode(continuationBatch[continuationBatch.length - 1]!);
  }
  if (headBatch.length === 0 || headBatch.length < headLimit) return null;
  return cursorFromEpisode(headBatch[headBatch.length - 1]!);
}

/**
 * Redis key for the persisted cursor of one (tenant, scope) scan. Both parts
 * are URI-encoded so caller-supplied values cannot inject the `:` separator
 * and collide with another (tenant, scope) pair's key.
 */
export function promotionCursorRedisKeyV1(
  scope: string | null,
  tenantId: string | null,
): string {
  const tenant = encodeURIComponent(tenantId ?? 'default');
  const scopePart = encodeURIComponent(scope ?? 'all');
  return `memberry:consolidation:promote-cursor:v1:${tenant}:${scopePart}`;
}
