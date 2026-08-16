// packages/retrieval/src/index.ts

// Types
export type {
  SourceType,
  RetrievalResult,
  RetrievalStrategy,
  RetrievalOptions,
  UnifiedContext,
  ContextSection,
  ContextItem,
  FeedbackSignal,
  BoostFactors,
} from './types.js';

// Query expansion
export { expandQuery } from './expand.js';
export type { ExpandedQuery } from './expand.js';

// Intent classification
export { classifyIntent } from './intent.js';
export type { QueryIntent, IntentResult } from './intent.js';

// Closed, bounded query-planning boundary (RET-002A)
export {
  QUERY_PLAN_CONTRACT_ID,
  QUERY_PLAN_CONTRACT_VERSION,
  QUERY_PLAN_MAX_PROJECT_SCOPES,
  QUERY_PLAN_MAX_HINTS_PER_KIND,
  QUERY_PLAN_MAX_EVIDENCE_NEEDS,
  QUERY_PLAN_MAX_RESOLVED_ENTITY_IDS,
  QUERY_PLAN_INTENTS,
  QUERY_PLAN_EVIDENCE_NEEDS,
  QUERY_PLAN_RESOLUTION_STATES,
  QueryPlanContractError,
  parseQueryPlanV1,
  canonicalQueryPlanV1,
} from './query-plan.js';
export type {
  QueryPlanIntentV1,
  QueryPlanEvidenceNeedV1,
  QueryPlanResolutionStateV1,
  QueryPlanAuthorityV1,
  QueryPlanCallerScopesV1,
  QueryPlanTemporalFrameV1,
  QueryPlanTaskHintsV1,
  QueryPlanResolutionV1,
  QueryPlanV1,
  QueryPlanContractErrorCode,
} from './query-plan.js';

// Read-only project/tenant-qualified stable Entity-ID resolution (RET-002B)
export {
  SCOPED_ENTITY_RESOLVER_MAX_RESULTS,
  SCOPED_ENTITY_RESOLVER_MAX_CONTAINMENT_DEPTH,
  SCOPED_ENTITY_RESOLVER_MAX_AUTHORITATIVE_DEPTH,
  SCOPED_ENTITY_RESOLVER_TIMEOUT_MS,
  ScopedEntityResolver,
  ScopedEntityResolverError,
} from './scoped-entity-resolver.js';
export type {
  ScopedEntityResolverDiagnosticCode,
  ScopedEntityResolverErrorCode,
  ScopedEntityResolutionResultV1,
  ScopedEntityTrustedAuthorityV1,
} from './scoped-entity-resolver.js';

// Scoring
export {
  scaleRrfK,
  lexicalTextScore,
  normalizeScores,
  computeQueryStats,
  adaptiveWeights,
  inferSourceTypeBoost,
  mmrDiversify,
} from './scoring.js';

// Fusion
export { rrfFusion, dedup } from './fusion.js';

// Deterministic assembly
export { DeterministicAssembler } from './deterministic.js';

// Feedback
export { FeedbackTracker } from './feedback.js';
export type { FeedbackRedisLayer } from './feedback.js';

// Unified assembler
export { UnifiedAssembler } from './assembler.js';
export type { AssemblerCodeLayer, AssemblerMemoryLayer, TracedUnifiedContext } from './assembler.js';

// Versioned, content-free retrieval trace contract (RET-001A)
export {
  RETRIEVAL_TRACE_VERSION,
  RETRIEVAL_TRACE_NUMBER_DECIMALS,
  RETRIEVAL_TRACE_DETERMINISTIC_OUTPUT_CHANNEL_ORDER_V2,
  RetrievalTraceCollector,
  RetrievalTraceValidationError,
  RetrievalTraceLimitError,
  roundTraceNumber,
  canonicalTraceJson,
  validateRetrievalTrace,
  assertRetrievalTraceSecretSafe,
  assertRetrievalTraceConformant,
  computeRetrievalTraceReplayStateDigest,
  replayRetrievalTrace,
} from './trace.js';
export type {
  RetrievalTraceAlgorithmVersion,
  RetrievalTraceSourceType,
  RetrievalTraceChannel,
  RetrievalTraceDeterministicOutputChannelV2,
  RetrievalTraceFilterName,
  RetrievalTraceExclusionReason,
  RetrievalTraceFailureStage,
  RetrievalTraceFailureCode,
  RetrievalTraceTerminalOutcome,
  RetrievalTraceScoreName,
  RetrievalTraceIncompleteReason,
  RetrievalTraceRequestShapeV1,
  RetrievalTraceChannelStateV1,
  RetrievalTraceEvidenceStateV1,
  RetrievalTraceCandidateDraft,
  RetrievalTraceCandidateV1,
  RetrievalTraceCandidateHandle,
  RetrievalTraceFilterEventInput,
  RetrievalTraceScoreEventInput,
  RetrievalTraceChannelSettlement,
  RetrievalTraceTerminalInput,
  RetrievalTraceMmrRecordInput,
  RetrievalTraceMmrPairwiseInput,
  RetrievalTraceMmrPairwiseV1,
  RetrievalTraceMmrRecordV1,
  RetrievalTraceStageEventV1,
  RetrievalTraceTerminalExclusionV1,
  RetrievalTraceV1,
  RetrievalTraceReplayResult,
  RetrievalTraceCollectorOptions,
} from './trace.js';

// MCP tools
export { registerRetrievalTools, setRetrievalServiceInstances, createRetrievalContainer, retrievalContainerForTenant, RETRIEVAL_TOOL_NAMES } from './tools.js';
export type { IUnifiedAssembler, IFeedbackTracker, RetrievalRegisteredTools, RetrievalServiceContainer } from './tools.js';
