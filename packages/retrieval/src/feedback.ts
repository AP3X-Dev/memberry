// packages/retrieval/src/feedback.ts
// Usage feedback tracking — makes retrieval improve over time without ML.
// Tracks which results agents actually use, boosts those in future queries.

import type { FeedbackSignal, BoostFactors, SourceType } from './types.js';
import { resolveTenant, isDefaultTenant } from '@memberry/neo4j';
import {
  assertBoundedQueryInput,
  MAX_FEEDBACK_QUERY_INPUT_CODE_UNITS,
} from './query-input.js';

// ─── Redis interface (injected, not concrete) ─────────────────────────────────

export interface FeedbackRedisLayer {
  zincrby(key: string, increment: number, member: string): Promise<number>;
  zrevrangeWithScores(key: string, start: number, stop: number): Promise<Array<{ member: string; score: number }>>;
  lpush(key: string, value: string): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<void>;
}

// ─── Feedback tracker ────────────────────────────────────────────────────────

const FEEDBACK_PREFIX = 'amp:feedback';
const MAX_LOG_SIZE = 10000;
const MAX_FEEDBACK_ID_CODE_UNITS = 500;
const MAX_FEEDBACK_TIMESTAMP_CODE_UNITS = 500;
const FEEDBACK_INPUT_INVALID = 'feedback_input_invalid';
const FEEDBACK_SOURCE_TYPES = new Set<SourceType>([
  'semantic', 'episodic', 'symbol', 'arch_entity', 'aspect', 'fact',
]);

// Per-tenant key namespacing. Feedback boosts re-rank retrieval, so a shared
// (process-global) key set lets one tenant's feedback poison another tenant's
// rankings AND co-mingles tenant-private entity names in the shared boost set.
// The DEFAULT (single-tenant / legacy) tenant keeps the original un-namespaced
// keys so existing boost data is preserved with no cold start; every named
// tenant gets its own isolated `amp:feedback:<tenant>:*` namespace.
function entityBoostKey(tenant: string): string {
  return isDefaultTenant(tenant) ? `${FEEDBACK_PREFIX}:entity_boost` : `${FEEDBACK_PREFIX}:${tenant}:entity_boost`;
}
function sourceBoostKey(tenant: string): string {
  return isDefaultTenant(tenant) ? `${FEEDBACK_PREFIX}:source_boost` : `${FEEDBACK_PREFIX}:${tenant}:source_boost`;
}
function feedbackLogKey(tenant: string): string {
  return isDefaultTenant(tenant) ? `${FEEDBACK_PREFIX}:log` : `${FEEDBACK_PREFIX}:${tenant}:log`;
}

export class FeedbackTracker {
  constructor(private redis: FeedbackRedisLayer) {}

  /**
   * Record that a result was used (or ignored) by an agent.
   * Positive feedback boosts the entity and source type for future queries.
   * Writes are scoped to `tenantId` so one tenant's feedback never re-ranks
  * another tenant's retrieval (defaults to the DEFAULT tenant when absent).
  */
  async recordFeedback(signal: FeedbackSignal, tenantId?: string): Promise<void> {
    const safeSignal = snapshotFeedbackSignal(signal);
    const tenant = resolveTenant(tenantId);
    const increment = safeSignal.was_useful ? 1 : -0.5;

    // Boost the entities mentioned in the result
    const entityNames = extractEntityNames(safeSignal.query);
    for (const entity of entityNames) {
      await this.redis.zincrby(entityBoostKey(tenant), increment, entity);
    }

    // Boost the source type
    await this.redis.zincrby(sourceBoostKey(tenant), increment, safeSignal.source_type);

    // Log the feedback event
    await this.redis.lpush(feedbackLogKey(tenant), JSON.stringify(safeSignal));
    await this.redis.ltrim(feedbackLogKey(tenant), 0, MAX_LOG_SIZE - 1);
  }

  /**
   * Get current boost factors for RRF fusion.
   * Returns normalized boosts (0.0–1.0 range) for entities and source types.
   * Reads are scoped to `tenantId` so boosts never cross tenant boundaries
   * (defaults to the DEFAULT tenant when absent).
   */
  async getBoosts(tenantId?: string): Promise<BoostFactors> {
    const tenant = resolveTenant(tenantId);

    // Top 50 entity boosts
    const entityScores = await this.redis.zrevrangeWithScores(entityBoostKey(tenant), 0, 49);
    const maxEntityScore = entityScores.length > 0 ? entityScores[0].score : 1;

    const entity_boosts: Record<string, number> = {};
    for (const { member, score } of entityScores) {
      if (score > 0) {
        entity_boosts[member] = Math.min(1.0, score / Math.max(maxEntityScore, 1));
      }
    }

    // Source type boosts
    const sourceScores = await this.redis.zrevrangeWithScores(sourceBoostKey(tenant), 0, 10);
    const maxSourceScore = sourceScores.length > 0 ? sourceScores[0].score : 1;

    const source_type_boosts: BoostFactors['source_type_boosts'] = {
      semantic: 0,
      episodic: 0,
      symbol: 0,
      arch_entity: 0,
      aspect: 0,
    };
    for (const { member, score } of sourceScores) {
      if (score > 0 && member in source_type_boosts) {
        source_type_boosts[member as Exclude<SourceType, 'fact'>] = Math.min(0.5, score / Math.max(maxSourceScore, 1) * 0.5);
      }
    }

    return { entity_boosts, source_type_boosts };
  }

  /**
   * Infer feedback from agent behavior: if a result_id appears in a subsequent
   * berry_store content, the agent used it.
   */
  async inferUsage(storeContent: string, recentResultIds: string[], sessionId: string, tenantId?: string): Promise<number> {
    let usageCount = 0;
    for (const resultId of recentResultIds) {
      // Simple heuristic: if the result ID or a key term from the result appears in store content
      const shortId = resultId.slice(0, 8);
      const wasUsed = storeContent.includes(shortId) || storeContent.includes(resultId);
      if (wasUsed) {
        await this.recordFeedback({
          query: '',
          result_id: resultId,
          source_type: 'semantic',
          was_useful: true,
          session_id: sessionId,
          timestamp: new Date().toISOString(),
        }, tenantId);
        usageCount++;
      }
    }
    return usageCount;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function snapshotFeedbackSignal(signal: FeedbackSignal): FeedbackSignal {
  // Read and validate each known field in contract order. A failed field stops
  // before any later accessor, query scan, tenant resolution, or Redis work.
  let query: unknown;
  try {
    query = signal.query;
  } catch {
    throw new Error('query_input_invalid');
  }
  assertBoundedQueryInput(query, MAX_FEEDBACK_QUERY_INPUT_CODE_UNITS);

  const resultId = readFeedbackField(signal, 'result_id');
  if (typeof resultId !== 'string' || resultId.length > MAX_FEEDBACK_ID_CODE_UNITS) {
    return feedbackInputInvalid();
  }

  const sourceType = readFeedbackField(signal, 'source_type');
  if (typeof sourceType !== 'string' || !FEEDBACK_SOURCE_TYPES.has(sourceType as SourceType)) {
    return feedbackInputInvalid();
  }

  const wasUseful = readFeedbackField(signal, 'was_useful');
  if (typeof wasUseful !== 'boolean') return feedbackInputInvalid();

  const sessionId = readFeedbackField(signal, 'session_id');
  if (typeof sessionId !== 'string' || sessionId.length > MAX_FEEDBACK_ID_CODE_UNITS) {
    return feedbackInputInvalid();
  }

  const timestamp = readFeedbackField(signal, 'timestamp');
  if (typeof timestamp !== 'string' || timestamp.length > MAX_FEEDBACK_TIMESTAMP_CODE_UNITS) {
    return feedbackInputInvalid();
  }

  // Null prototype + assignments create exactly six enumerable data properties
  // in the legacy JSON order. Caller extras and accessors are never enumerated.
  const snapshot = Object.create(null) as FeedbackSignal;
  snapshot.query = query;
  snapshot.result_id = resultId;
  snapshot.source_type = sourceType as SourceType;
  snapshot.was_useful = wasUseful;
  snapshot.session_id = sessionId;
  snapshot.timestamp = timestamp;
  return snapshot;
}

function readFeedbackField(
  signal: FeedbackSignal,
  field: Exclude<keyof FeedbackSignal, 'query'>,
): unknown {
  try {
    return signal[field];
  } catch {
    return feedbackInputInvalid();
  }
}

function feedbackInputInvalid(): never {
  throw new Error(FEEDBACK_INPUT_INVALID);
}

function extractEntityNames(text: string): string[] {
  // Extract potential entity names: capitalized words, kebab-case, snake_case identifiers
  const patterns = text.match(/[A-Z][a-zA-Z]+|[a-z]+(?:-[a-z]+)+|[a-z]+(?:_[a-z]+)+/g) ?? [];
  return [...new Set(patterns)].slice(0, 10);
}
