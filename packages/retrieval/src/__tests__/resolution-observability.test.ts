import { describe, expect, it } from 'vitest';
import { RuntimeQueryPlannerError } from '../runtime-query-planner.js';
import { RetrievalResolutionObservabilityV1 } from '../resolution-observability.js';

describe('RetrievalResolutionObservabilityV1', () => {
  it('counts routing and closed resolution outcomes without retaining caller content', async () => {
    const observer = new RetrievalResolutionObservabilityV1();
    observer.recordCall('berry_context', 'unanchored');
    observer.recordCall('berry_context', 'anchored-resolver');
    observer.recordCall('berry_ask', 'anchored-resolver');

    await expect(observer.observeResolution(async () => 'ok')).resolves.toBe('ok');
    await expect(observer.observeResolution(async () => {
      throw new RuntimeQueryPlannerError('resolution_failed');
    })).rejects.toThrow('runtime_query_planner:resolution_failed');

    expect(observer.snapshot()).toEqual({
      schema_version: 1,
      affects_readiness: false,
      history_scope: 'process-lifetime',
      history_complete: false,
      counters_saturated: false,
      caller_type_known: false,
      content_captured: false,
      identity_captured: false,
      calls: { total: 3, berry_context: 2, berry_ask: 1 },
      routing: { unanchored: 1, anchored_legacy: 0, anchored_resolver: 2 },
      resolution: {
        attempted: 2,
        resolved: 1,
        failed: 1,
        success_rate: 0.5,
        invalid_request: 0,
        resolution_failed: 1,
        authentication_required: 0,
        unavailable: 0,
        other_failure: 0,
      },
    });
    expect(JSON.stringify(observer.snapshot())).not.toContain('ok');
  });

  it('separates every fixed planner failure class from unexpected failures', async () => {
    const observer = new RetrievalResolutionObservabilityV1();
    const codes = [
      'invalid_request',
      'authentication_required',
      'unavailable',
    ] as const;
    for (const code of codes) {
      await expect(observer.observeResolution(async () => {
        throw new RuntimeQueryPlannerError(code);
      })).rejects.toThrow(`runtime_query_planner:${code}`);
    }
    await expect(observer.observeResolution(async () => {
      throw new Error('private detail');
    })).rejects.toThrow('private detail');

    expect(observer.snapshot()).toMatchObject({
      resolution: {
        attempted: 4,
        resolved: 0,
        failed: 4,
        success_rate: 0,
        invalid_request: 1,
        resolution_failed: 0,
        authentication_required: 1,
        unavailable: 1,
        other_failure: 1,
      },
    });
    expect(JSON.stringify(observer.snapshot())).not.toContain('private detail');
  });
});
