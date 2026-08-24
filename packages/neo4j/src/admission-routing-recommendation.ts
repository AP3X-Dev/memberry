import { createHash, randomUUID } from 'node:crypto';
import { types as nodeUtilTypes } from 'node:util';

import {
  ADMISSION_TIERS,
  TIER_ROUTING_CONTRACT_VERSION,
  TIER_ROUTING_POLICY_ID,
  TIER_ROUTING_POLICY_VERSION,
  type TierRoutingRecommendationV1,
} from '@memberry/core';
import type { Driver, ManagedTransaction, Session } from 'neo4j-driver';

const RECOMMENDATION_ID_DOMAIN = 'admission-routing-recommendation';
const MAX_IDENTIFIER_LENGTH = 500;
const PROJECT_SCOPE = /^project:[a-z0-9][a-z0-9._-]*$/;
const REASON_CODES = [
  'capture-rejected',
  'capture-duplicate',
  'sensitivity-protected',
  'approved-decision-candidate',
  'feature-candidate',
  'feature-discard',
  'feature-working',
  'baseline-episodic-default',
  'features-unavailable-default',
] as const;
const CONFIG_IDENTITY = /^sha256:[0-9a-f]{64}$/;

const PROPERTY_KEYS = [
  'id',
  'tenant_id',
  'project_scope',
  'episode_id',
  'contract_version',
  'policy_id',
  'policy_version',
  'config_identity',
  'recommended_tier',
  'reason_code',
  'would_change_baseline',
  'observed_at',
] as const;

// Same-episode/same-config re-persist is MERGE-idempotent; the first committed
// observed_at wins, so the timestamp is excluded from the read-back comparison.
const SUBSTANTIVE_PROPERTY_KEYS = PROPERTY_KEYS.filter((key) => key !== 'observed_at');

export interface AdmissionRoutingRecommendationScopeV1 {
  readonly tenantId: string;
  readonly projectScope: string;
  readonly episodeId: string;
}

export type AdmissionRoutingRecommendationStoreErrorCode =
  | 'invalid_scope'
  | 'invalid_recommendation'
  | 'episode_not_found'
  | 'existing_state_mismatch'
  | 'write_incomplete'
  | 'storage_unavailable';

const STORE_ERROR_CODES = new Set<AdmissionRoutingRecommendationStoreErrorCode>([
  'invalid_scope',
  'invalid_recommendation',
  'episode_not_found',
  'existing_state_mismatch',
  'write_incomplete',
  'storage_unavailable',
]);

/** Value-free persistence failures; tenant, project, and episode values never enter messages. */
export class AdmissionRoutingRecommendationStoreError extends Error {
  constructor(readonly code: AdmissionRoutingRecommendationStoreErrorCode) {
    super(`admission_routing_recommendation_store:${code}`);
    this.name = 'AdmissionRoutingRecommendationStoreError';
  }
}

function normalizedStoreError(
  value: unknown,
  fallback: AdmissionRoutingRecommendationStoreErrorCode,
): AdmissionRoutingRecommendationStoreError {
  try {
    if (value instanceof AdmissionRoutingRecommendationStoreError && STORE_ERROR_CODES.has(value.code)) {
      // Rebuild instead of returning a potentially message-mutated instance.
      return new AdmissionRoutingRecommendationStoreError(value.code);
    }
  } catch {
    // Treat a hostile error instance as an ordinary storage/input failure.
  }
  return new AdmissionRoutingRecommendationStoreError(fallback);
}

function strictRecord(
  value: unknown,
  failure: AdmissionRoutingRecommendationStoreErrorCode,
): Record<PropertyKey, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
      throw new AdmissionRoutingRecommendationStoreError(failure);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new AdmissionRoutingRecommendationStoreError(failure);
    }
    const clone = Object.create(null) as Record<PropertyKey, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        throw new AdmissionRoutingRecommendationStoreError(failure);
      }
      clone[key] = descriptor.value;
    }
    return clone;
  } catch (error) {
    throw normalizedStoreError(error, failure);
  }
}

function parseScope(value: AdmissionRoutingRecommendationScopeV1): AdmissionRoutingRecommendationScopeV1 {
  const input = strictRecord(value, 'invalid_scope');
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 3 || !['tenantId', 'projectScope', 'episodeId'].every((key) => Object.hasOwn(input, key))) {
    throw new AdmissionRoutingRecommendationStoreError('invalid_scope');
  }
  const tenantId = input.tenantId;
  const projectScope = input.projectScope;
  const episodeId = input.episodeId;
  if (typeof tenantId !== 'string' || tenantId.trim().length === 0 || tenantId.length > MAX_IDENTIFIER_LENGTH
    || typeof projectScope !== 'string' || projectScope.length > MAX_IDENTIFIER_LENGTH || !PROJECT_SCOPE.test(projectScope)
    || typeof episodeId !== 'string' || episodeId.trim().length === 0 || episodeId.length > MAX_IDENTIFIER_LENGTH) {
    throw new AdmissionRoutingRecommendationStoreError('invalid_scope');
  }
  return Object.freeze({ tenantId, projectScope, episodeId });
}

function parseRecommendation(value: TierRoutingRecommendationV1): TierRoutingRecommendationV1 {
  const input = strictRecord(value, 'invalid_recommendation');
  const keys = Reflect.ownKeys(input);
  const expected = [
    'contractVersion', 'policyId', 'policyVersion', 'configIdentity',
    'recommendedTier', 'reasonCode', 'wouldChangeBaseline',
  ];
  if (keys.length !== expected.length || !expected.every((key) => Object.hasOwn(input, key))
    || input.contractVersion !== TIER_ROUTING_CONTRACT_VERSION
    || input.policyId !== TIER_ROUTING_POLICY_ID
    || input.policyVersion !== TIER_ROUTING_POLICY_VERSION
    || typeof input.configIdentity !== 'string' || !CONFIG_IDENTITY.test(input.configIdentity)
    || !(ADMISSION_TIERS as readonly unknown[]).includes(input.recommendedTier)
    || !(REASON_CODES as readonly unknown[]).includes(input.reasonCode)
    || typeof input.wouldChangeBaseline !== 'boolean') {
    throw new AdmissionRoutingRecommendationStoreError('invalid_recommendation');
  }
  return Object.freeze({ ...input }) as unknown as TierRoutingRecommendationV1;
}

/**
 * Internal only: distinct domain constant, so the digest can never collide with
 * the observation store's module-private id for the same scope triple. Because
 * configIdentity is in the tuple, a threshold change yields a NEW sibling node
 * while an identical re-persist stays MERGE-idempotent.
 */
function recommendationId(
  configIdentity: string,
  scope: AdmissionRoutingRecommendationScopeV1,
): string {
  const tuple = JSON.stringify([
    RECOMMENDATION_ID_DOMAIN,
    TIER_ROUTING_POLICY_ID,
    TIER_ROUTING_POLICY_VERSION,
    configIdentity,
    scope.tenantId,
    scope.projectScope,
    scope.episodeId,
  ]);
  return `admission-routing-recommendation:sha256:${createHash('sha256').update(tuple).digest('hex')}`;
}

function recommendationProperties(
  id: string,
  scope: AdmissionRoutingRecommendationScopeV1,
  recommendation: TierRoutingRecommendationV1,
  observedAt: string,
): Record<string, unknown> {
  return {
    id,
    tenant_id: scope.tenantId,
    project_scope: scope.projectScope,
    episode_id: scope.episodeId,
    contract_version: recommendation.contractVersion,
    policy_id: recommendation.policyId,
    policy_version: recommendation.policyVersion,
    config_identity: recommendation.configIdentity,
    recommended_tier: recommendation.recommendedTier,
    reason_code: recommendation.reasonCode,
    would_change_baseline: recommendation.wouldChangeBaseline,
    observed_at: observedAt,
  };
}

function persistedRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AdmissionRoutingRecommendationStoreError('existing_state_mismatch');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== PROPERTY_KEYS.length
    || keys.some((key) => typeof key !== 'string' || !PROPERTY_KEYS.includes(key as (typeof PROPERTY_KEYS)[number]))) {
    throw new AdmissionRoutingRecommendationStoreError('existing_state_mismatch');
  }
  const result: Record<string, unknown> = {};
  for (const key of PROPERTY_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      throw new AdmissionRoutingRecommendationStoreError('existing_state_mismatch');
    }
    result[key] = descriptor.value;
  }
  return result;
}

function substantivePropertiesMatch(actual: unknown, expected: Record<string, unknown>): boolean {
  let parsed: Record<string, unknown>;
  try {
    parsed = persistedRecord(actual);
  } catch {
    return false;
  }
  return SUBSTANTIVE_PROPERTY_KEYS.every((key) => Object.is(parsed[key], expected[key]));
}

function integerValue(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'object' && value !== null && 'toNumber' in value
    && typeof (value as { toNumber?: unknown }).toNumber === 'function') {
    return (value as { toNumber(): number }).toNumber();
  }
  return Number.NaN;
}

/**
 * Shadow-only MEM-003 sibling sidecar store. `AdmissionRoutingRecommendation`
 * and `RECOMMENDS_FOR` are intentionally absent from retrieval, consolidation,
 * wiki, graph analytics, provenance, tenant counts/export, and MCP
 * registration; only the admission shadow runtime writes through it.
 */
export class AdmissionRoutingRecommendationStore {
  constructor(private readonly driver: Driver) {}

  private async managed<T>(work: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
    let session: Session;
    try {
      session = this.driver.session();
    } catch {
      throw new AdmissionRoutingRecommendationStoreError('storage_unavailable');
    }

    let result: T | undefined;
    let failure: AdmissionRoutingRecommendationStoreError | undefined;
    try {
      result = await session.executeWrite(work);
    } catch (error) {
      failure = normalizedStoreError(error, 'storage_unavailable');
    }
    try {
      await session.close();
    } catch (error) {
      // Cleanup must never replace a more specific safe domain failure.
      failure ??= normalizedStoreError(error, 'storage_unavailable');
    }
    if (failure) throw failure;
    return result as T;
  }

  async persist(
    rawScope: AdmissionRoutingRecommendationScopeV1,
    rawRecommendation: TierRoutingRecommendationV1,
  ): Promise<void> {
    const scope = parseScope(rawScope);
    const recommendation = parseRecommendation(rawRecommendation);
    let id: string;
    let attemptToken: string;
    let observedAt: string;
    try {
      id = recommendationId(recommendation.configIdentity, scope);
      // Generated exactly once outside the managed callback: Neo4j may replay
      // the callback, and every attempt must identify the same logical creation.
      attemptToken = randomUUID();
      observedAt = new Date().toISOString();
    } catch {
      throw new AdmissionRoutingRecommendationStoreError('storage_unavailable');
    }
    const properties = recommendationProperties(id, scope, recommendation, observedAt);
    return this.managed(async (tx) => {
      const result = await tx.run(
        `/* admission-routing-recommendation:merge */
         MATCH (e:Episodic {id: $episodeId})
         WHERE e.tenant_id = $tenantId AND e.scope = $projectScope
         MERGE (r:AdmissionRoutingRecommendation {id: $id})
         ON CREATE SET r = $properties, r._admission_attempt = $attemptToken
         WITH e, r, r._admission_attempt = $attemptToken AS created
         FOREACH (_ IN CASE WHEN created THEN [1] ELSE [] END |
           CREATE (r)-[:RECOMMENDS_FOR]->(e))
         FOREACH (_ IN CASE WHEN created THEN [1] ELSE [] END |
           REMOVE r._admission_attempt)
         WITH e, r, created
         OPTIONAL MATCH (r)-[l]-(n)
         RETURN properties(r) AS properties,
                count(l) AS relationshipCount,
                sum(CASE WHEN type(l) = 'RECOMMENDS_FOR'
                          AND startNode(l) = r
                          AND 'Episodic' IN labels(n)
                          AND n.id = $episodeId
                          AND n.tenant_id = $tenantId
                          AND n.scope = $projectScope
                         THEN 1 ELSE 0 END) AS exactLinkCount,
                created`,
        { ...scope, id, properties, attemptToken },
      );
      if (result.records.length === 0) {
        throw new AdmissionRoutingRecommendationStoreError('episode_not_found');
      }
      if (result.records.length !== 1) throw new AdmissionRoutingRecommendationStoreError('write_incomplete');
      const record = result.records[0]!;
      if (integerValue(record.get('relationshipCount')) !== 1
        || integerValue(record.get('exactLinkCount')) !== 1
        || !substantivePropertiesMatch(record.get('properties'), properties)) {
        throw new AdmissionRoutingRecommendationStoreError('existing_state_mismatch');
      }
    });
  }
}
