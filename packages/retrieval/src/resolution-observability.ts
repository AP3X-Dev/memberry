import { RuntimeQueryPlannerError } from './runtime-query-planner.js';

export type RetrievalCallerToolV1 = 'berry_context' | 'berry_ask';
export type RetrievalRoutingShapeV1 = 'unanchored' | 'anchored-legacy' | 'anchored-resolver';

interface MutableCountersV1 {
  contextCalls: number;
  askCalls: number;
  unanchoredCalls: number;
  anchoredLegacyCalls: number;
  anchoredResolverCalls: number;
  resolved: number;
  invalidRequest: number;
  resolutionFailed: number;
  authenticationRequired: number;
  unavailable: number;
  otherFailure: number;
}

function emptyCounters(): MutableCountersV1 {
  return {
    contextCalls: 0,
    askCalls: 0,
    unanchoredCalls: 0,
    anchoredLegacyCalls: 0,
    anchoredResolverCalls: 0,
    resolved: 0,
    invalidRequest: 0,
    resolutionFailed: 0,
    authenticationRequired: 0,
    unavailable: 0,
    otherFailure: 0,
  };
}

function increment(value: number): number {
  return value < Number.MAX_SAFE_INTEGER ? value + 1 : Number.MAX_SAFE_INTEGER;
}

function boundedSum(...values: number[]): number {
  return values.reduce((total, value) => Math.min(Number.MAX_SAFE_INTEGER, total + value), 0);
}

/**
 * Content-free process-lifetime telemetry for the public retrieval boundary.
 *
 * This intentionally cannot answer who called, what they asked, which tenant
 * they belonged to, or which Entity they named. It only measures the request
 * shape and the planner's closed outcome classes. In production those MCP calls
 * are predominantly agent-generated, but the server does not infer caller type.
 */
export class RetrievalResolutionObservabilityV1 {
  private readonly counters = emptyCounters();

  recordCall(tool: RetrievalCallerToolV1, shape: RetrievalRoutingShapeV1): void {
    if (tool === 'berry_context') this.counters.contextCalls = increment(this.counters.contextCalls);
    else this.counters.askCalls = increment(this.counters.askCalls);

    if (shape === 'unanchored') this.counters.unanchoredCalls = increment(this.counters.unanchoredCalls);
    else if (shape === 'anchored-legacy') {
      this.counters.anchoredLegacyCalls = increment(this.counters.anchoredLegacyCalls);
    } else this.counters.anchoredResolverCalls = increment(this.counters.anchoredResolverCalls);
  }

  async observeResolution<T>(operation: () => Promise<T>): Promise<T> {
    try {
      const value = await operation();
      this.counters.resolved = increment(this.counters.resolved);
      return value;
    } catch (error) {
      if (error instanceof RuntimeQueryPlannerError) {
        if (error.code === 'invalid_request') this.counters.invalidRequest = increment(this.counters.invalidRequest);
        else if (error.code === 'resolution_failed') {
          this.counters.resolutionFailed = increment(this.counters.resolutionFailed);
        } else if (error.code === 'authentication_required') {
          this.counters.authenticationRequired = increment(this.counters.authenticationRequired);
        } else this.counters.unavailable = increment(this.counters.unavailable);
      } else {
        this.counters.otherFailure = increment(this.counters.otherFailure);
      }
      throw error;
    }
  }

  snapshot(): Record<string, unknown> {
    const countersSaturated = Object.values(this.counters)
      .some((value) => value === Number.MAX_SAFE_INTEGER);
    const calls = boundedSum(this.counters.contextCalls, this.counters.askCalls);
    const failed = boundedSum(
      this.counters.invalidRequest,
      this.counters.resolutionFailed,
      this.counters.authenticationRequired,
      this.counters.unavailable,
      this.counters.otherFailure,
    );
    const attempted = boundedSum(this.counters.resolved, failed);
    return {
      schema_version: 1,
      affects_readiness: false,
      history_scope: 'process-lifetime',
      history_complete: false,
      counters_saturated: countersSaturated,
      caller_type_known: false,
      content_captured: false,
      identity_captured: false,
      calls: {
        total: calls,
        berry_context: this.counters.contextCalls,
        berry_ask: this.counters.askCalls,
      },
      routing: {
        unanchored: this.counters.unanchoredCalls,
        anchored_legacy: this.counters.anchoredLegacyCalls,
        anchored_resolver: this.counters.anchoredResolverCalls,
      },
      resolution: {
        attempted,
        resolved: this.counters.resolved,
        failed,
        success_rate: attempted === 0 ? null : this.counters.resolved / attempted,
        invalid_request: this.counters.invalidRequest,
        resolution_failed: this.counters.resolutionFailed,
        authentication_required: this.counters.authenticationRequired,
        unavailable: this.counters.unavailable,
        other_failure: this.counters.otherFailure,
      },
    };
  }
}

const processObservability = new RetrievalResolutionObservabilityV1();

export function recordRetrievalCallV1(tool: RetrievalCallerToolV1, shape: RetrievalRoutingShapeV1): void {
  processObservability.recordCall(tool, shape);
}

export function observeRetrievalResolutionV1<T>(operation: () => Promise<T>): Promise<T> {
  return processObservability.observeResolution(operation);
}

export function getRetrievalResolutionProcessStatusV1(): Record<string, unknown> {
  return processObservability.snapshot();
}
