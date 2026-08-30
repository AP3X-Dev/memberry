import { createHash } from 'node:crypto';

import { RETRIEVAL_SOURCE_TYPES, type RetrievalStrategy, type SourceType, type UnifiedContext } from './types.js';

export const RETRIEVAL_TRACE_SUMMARY_VERSION = '1.0.0' as const;
export const RETRIEVAL_TRACE_SUMMARY_MAX_BYTES = 16_384;
export const RETRIEVAL_TRACE_SUMMARY_MAX_RESULTS = 64;

export interface RetrievalTraceSummaryRequestV1 {
  readonly strategy: RetrievalStrategy;
  readonly includeCode: boolean;
  readonly includeArchitecture: boolean;
  readonly includeMemory: boolean;
  readonly namedTenant: boolean;
  readonly projectScopeApplied: boolean;
  readonly entityCount: number;
  readonly tagCount: number;
  readonly temporalFilterApplied: boolean;
  readonly task: string;
  readonly maxTokens: number;
}

export interface RetrievalTraceSummaryV1 {
  readonly schemaVersion: typeof RETRIEVAL_TRACE_SUMMARY_VERSION;
  readonly kind: 'retrieval-trace-summary';
  readonly bounded: true;
  readonly replayable: false;
  readonly requestShape: {
    readonly strategy: RetrievalStrategy;
    readonly sources: { readonly code: boolean; readonly architecture: boolean; readonly memory: boolean };
    readonly tenantScope: 'default' | 'named';
    readonly projectScopeApplied: boolean;
    readonly entityScope: 'none' | 'one' | 'few' | 'many';
    readonly tagScope: 'none' | 'one' | 'few' | 'many';
    readonly temporalFilterApplied: boolean;
    readonly queryLength: 'empty' | 'short' | 'medium' | 'long';
    readonly tokenBudget: 'small' | 'medium' | 'large' | 'very-large';
  };
  readonly result: {
    readonly count: number;
    readonly tokenCount: number;
    readonly sourceCounts: Readonly<Record<SourceType, number>>;
    readonly sourceOrder: readonly SourceType[];
    readonly sourceOrderTruncated: boolean;
    readonly orderDigest: string;
  };
  readonly timing: { readonly totalMs: number };
  readonly omittedDetail: readonly ['candidate-identities', 'ranking-events', 'mmr-pairwise'];
  readonly limits: { readonly maxBytes: number; readonly maxResults: number };
}

function cardinality(value: number): 'none' | 'one' | 'few' | 'many' {
  return value === 0 ? 'none' : value === 1 ? 'one' : value <= 4 ? 'few' : 'many';
}

function queryLength(query: string): 'empty' | 'short' | 'medium' | 'long' {
  const count = query.trim() ? query.trim().split(/\s+/).length : 0;
  return count === 0 ? 'empty' : count <= 4 ? 'short' : count <= 16 ? 'medium' : 'long';
}

function tokenBudget(value: number): 'small' | 'medium' | 'large' | 'very-large' {
  return value <= 2_000 ? 'small' : value <= 8_000 ? 'medium' : value <= 16_000 ? 'large' : 'very-large';
}

function boundedCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, Number.MAX_SAFE_INTEGER) : 0;
}

function boundedDuration(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.round(value * 100) / 100, 3_600_000);
}

/**
 * Build an operator diagnostic from delivered results only. User text, evidence
 * content, titles, IDs, tenant names, and project names never cross this boundary.
 * The digest binds the exact delivered order without disclosing those identities.
 */
export function buildRetrievalTraceSummaryV1(
  context: UnifiedContext,
  request: RetrievalTraceSummaryRequestV1,
  totalMs: number,
): RetrievalTraceSummaryV1 {
  const sourceCounts = Object.fromEntries(RETRIEVAL_SOURCE_TYPES.map((source) => [source, 0])) as Record<SourceType, number>;
  const ordered = context.sections.flatMap((section) => section.items.map((item) => ({
    id: item.id,
    sourceType: section.source_type,
  })));
  for (const item of ordered) sourceCounts[item.sourceType] += 1;
  const digest = createHash('sha256');
  digest.update('memberry:retrieval-trace-summary:v1\0');
  for (const item of ordered) digest.update(`${item.sourceType}\0${item.id}\0`);

  return Object.freeze({
    schemaVersion: RETRIEVAL_TRACE_SUMMARY_VERSION,
    kind: 'retrieval-trace-summary',
    bounded: true,
    replayable: false,
    requestShape: Object.freeze({
      strategy: context.strategy,
      sources: Object.freeze({
        code: request.includeCode,
        architecture: request.includeArchitecture,
        memory: request.includeMemory,
      }),
      tenantScope: request.namedTenant ? 'named' : 'default',
      projectScopeApplied: request.projectScopeApplied,
      entityScope: cardinality(boundedCount(request.entityCount)),
      tagScope: cardinality(boundedCount(request.tagCount)),
      temporalFilterApplied: request.temporalFilterApplied,
      queryLength: queryLength(request.task),
      tokenBudget: tokenBudget(request.maxTokens),
    }),
    result: Object.freeze({
      count: ordered.length,
      tokenCount: boundedCount(context.token_count),
      sourceCounts: Object.freeze(sourceCounts),
      sourceOrder: Object.freeze(ordered.slice(0, RETRIEVAL_TRACE_SUMMARY_MAX_RESULTS).map((item) => item.sourceType)),
      sourceOrderTruncated: ordered.length > RETRIEVAL_TRACE_SUMMARY_MAX_RESULTS,
      orderDigest: `sha256:${digest.digest('hex')}`,
    }),
    timing: Object.freeze({ totalMs: boundedDuration(totalMs) }),
    omittedDetail: Object.freeze(['candidate-identities', 'ranking-events', 'mmr-pairwise'] as const),
    limits: Object.freeze({
      maxBytes: RETRIEVAL_TRACE_SUMMARY_MAX_BYTES,
      maxResults: RETRIEVAL_TRACE_SUMMARY_MAX_RESULTS,
    }),
  });
}

export function serializeRetrievalTraceSummaryV1(summary: RetrievalTraceSummaryV1): string {
  const serialized = JSON.stringify(summary);
  if (Buffer.byteLength(serialized, 'utf8') > RETRIEVAL_TRACE_SUMMARY_MAX_BYTES) {
    throw new Error('Retrieval trace summary exceeded its byte budget');
  }
  return serialized;
}
