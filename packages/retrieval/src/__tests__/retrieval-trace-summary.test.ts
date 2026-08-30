import { describe, expect, it } from 'vitest';

import {
  RETRIEVAL_TRACE_SUMMARY_MAX_BYTES,
  RETRIEVAL_TRACE_SUMMARY_MAX_RESULTS,
  buildRetrievalTraceSummaryV1,
  serializeRetrievalTraceSummaryV1,
} from '../retrieval-trace-summary.js';
import type { UnifiedContext } from '../types.js';

function context(ids: readonly string[]): UnifiedContext {
  return {
    task: 'do not expose this task',
    strategy: 'ranked',
    sections: [{
      heading: 'History',
      source_type: 'episodic',
      items: ids.map((id) => ({ id, content: 'do not expose this content', score: 1, metadata: {} })),
    }],
    token_count: 123,
    assembled_at: '2026-08-30T00:00:00.000Z',
  };
}

const request = {
  strategy: 'ranked' as const,
  includeCode: false,
  includeArchitecture: false,
  includeMemory: true,
  namedTenant: true,
  projectScopeApplied: true,
  entityCount: 1,
  tagCount: 5,
  temporalFilterApplied: true,
  task: 'sk_live_NEVER_EXPOSE_THIS_TASK',
  maxTokens: 6_500,
};

describe('bounded retrieval trace summary', () => {
  it('exposes only content-free shapes, counts, and an order digest', () => {
    const summary = buildRetrievalTraceSummaryV1(context(['private-id-one', 'private-id-two']), request, 12.345);
    const serialized = serializeRetrievalTraceSummaryV1(summary);

    expect(summary).toMatchObject({
      schemaVersion: '1.0.0',
      kind: 'retrieval-trace-summary',
      bounded: true,
      replayable: false,
      requestShape: {
        strategy: 'ranked', tenantScope: 'named', entityScope: 'one', tagScope: 'many',
        queryLength: 'short', tokenBudget: 'medium',
      },
      result: { count: 2, tokenCount: 123, sourceCounts: { episodic: 2 }, sourceOrder: ['episodic', 'episodic'] },
      timing: { totalMs: 12.35 },
    });
    expect(summary.result.orderDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(serialized).not.toContain('private-id');
    expect(serialized).not.toContain('NEVER_EXPOSE');
    expect(serialized).not.toContain('do not expose');
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(RETRIEVAL_TRACE_SUMMARY_MAX_BYTES);
  });

  it('caps source-order detail while binding the complete delivered order', () => {
    const ids = Array.from({ length: 100 }, (_, index) => `private-${index}`);
    const summary = buildRetrievalTraceSummaryV1(context(ids), request, Number.POSITIVE_INFINITY);
    const reversed = buildRetrievalTraceSummaryV1(context([...ids].reverse()), request, -1);

    expect(summary.result.count).toBe(100);
    expect(summary.result.sourceOrder).toHaveLength(RETRIEVAL_TRACE_SUMMARY_MAX_RESULTS);
    expect(summary.result.sourceOrderTruncated).toBe(true);
    expect(summary.result.orderDigest).not.toBe(reversed.result.orderDigest);
    expect(summary.timing.totalMs).toBe(0);
    expect(reversed.timing.totalMs).toBe(0);
  });
});
