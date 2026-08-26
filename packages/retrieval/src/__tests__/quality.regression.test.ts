// Retrieval QUALITY regression gate.
// Runs the labeled golden-set evaluation (bench/quality-eval.ts) on every `npm test`
// and asserts the ranking pipeline stays above the locked-in quality thresholds.
// This is what makes retrieval *effectiveness* — not just latency — regression-proof.

import { describe, expect, it } from 'vitest';
import { runQualityEval, runConflictEval, QUALITY_THRESHOLDS } from '../../bench/quality-eval.js';

describe('retrieval quality gate (golden set)', () => {
  it('meets all aggregate quality thresholds', async () => {
    const report = await runQualityEval();

    expect(report.recall10).toBeGreaterThanOrEqual(QUALITY_THRESHOLDS.recallAt10);
    expect(report.ndcg10).toBeGreaterThanOrEqual(QUALITY_THRESHOLDS.ndcgAt10);
    expect(report.mrr).toBeGreaterThanOrEqual(QUALITY_THRESHOLDS.mrr);
    expect(report.precision5).toBeGreaterThanOrEqual(QUALITY_THRESHOLDS.precisionAt5);
    expect(report.intentAccuracy).toBeGreaterThanOrEqual(QUALITY_THRESHOLDS.intentAccuracy);
  });

  it('keeps precision@5 measured against its structural ceiling (RET-006)', async () => {
    // Precision@5 is capped per query at min(relevant, 5) / 5, so the aggregate can
    // never reach 1.0 on this set and a raw gain reads larger than it is. This pins
    // the ceiling itself: if the golden set gains relevant docs per query the ceiling
    // moves, and THAT is the moment precisionAt5 becomes a headroom metric worth
    // ratcheting. Fails loudly rather than letting a saturated gate look meaningful.
    const report = await runQualityEval();

    const ceilings = report.perQuery.map((p) => {
      // recall5 = hits@5 / relevant and precision5 = hits@5 / 5, so relevant is
      // recoverable from the pair without re-reading the fixture labels.
      const hitsAt5 = p.precision5 * 5;
      const relevant = p.recall5 > 0 ? Math.round(hitsAt5 / p.recall5) : 0;
      return Math.min(relevant, 5) / 5;
    });
    const meanCeiling = ceilings.reduce((sum, c) => sum + c, 0) / ceilings.length;

    expect(meanCeiling).toBeCloseTo(0.4667, 3);
    expect(report.precision5).toBeLessThanOrEqual(meanCeiling);
    // 8 of 12 queries are at their own ceiling — the saturation this note is about.
    const atCeiling = report.perQuery.filter((p, i) => p.precision5 >= ceilings[i]! - 1e-9);
    expect(atCeiling.length).toBe(8);
  });

  it('ranks an exact identifier lookup as the #1 result', async () => {
    // Pins Fix C: exact identifier-word match + full-identifier reconstruction must
    // place the exact symbol first, not a fuzzy semantic match that merely mentions it.
    const report = await runQualityEval();
    const validateToken = report.perQuery.find((p) => p.query === 'validateToken');
    expect(validateToken?.ranked[0]).toBe('sym-validateToken');
    expect(validateToken?.mrr).toBe(1);

    const authService = report.perQuery.find((p) => p.query === 'AuthService');
    expect(authService?.ranked[0]).toBe('sym-AuthService');
  });

  it('surfaces all sibling symbols for a code-seeking query (MMR relevance + source-type)', async () => {
    // Pins the MMR relevance-normalization fix + same-file softening + source-type
    // intent: a "payment charge functions" query must surface all four sibling charge
    // functions in the top results, not bury them behind provenance-boosted prose.
    const report = await runQualityEval();
    const charge = report.perQuery.find((p) => p.query === 'payment charge functions');
    expect(charge?.recall5).toBe(1); // all four siblings in the top 5
  });

  it('ranks current knowledge above invalidated knowledge (temporal truth)', async () => {
    // Core "what is true now" property: an invalidated/superseded memory must be
    // demoted below current ones even when it is highly on-topic. Guards the
    // provenanceQualityMultiplier invalidation path inside rrfFusion.
    const report = await runQualityEval();
    const authQ = report.perQuery.find((p) => p.query === 'how does authentication work');
    const currentIdx = authQ!.ranked.indexOf('sem-auth-jwt'); // current, high-confidence
    const invalidatedIdx = authQ!.ranked.indexOf('sem-old-auth'); // invalidated_at set
    expect(currentIdx).toBeGreaterThanOrEqual(0);
    expect(invalidatedIdx === -1 || currentIdx < invalidatedIdx).toBe(true);
  });

  it('resolves knowledge conflicts: current truth outranks superseded facts, no stale leak', async () => {
    // The agent-relevant memory property (MemoryAgentBench conflict-resolution /
    // LongMemEval knowledge-update): when memory holds a current AND a superseded fact
    // on one topic (e.g. Vitest now vs Jest before), surface current, suppress stale.
    const conflict = await runConflictEval();
    expect(conflict.currentAboveStaleRate).toBe(QUALITY_THRESHOLDS.currentAboveStaleRate);
    expect(conflict.staleLeakRate).toBeLessThanOrEqual(QUALITY_THRESHOLDS.maxStaleLeakRate);
  });

  it('classifies varied interrogative phrasings as SEMANTIC intent', async () => {
    // Pins Fix A: broadened question-pattern coverage ("how are…", "why do…").
    const report = await runQualityEval();
    for (const q of ['how are payment failures retried', 'why do we use RRF for fusion']) {
      const pq = report.perQuery.find((p) => p.query === q);
      expect(pq?.intent, `${q} should be SEMANTIC`).toBe('SEMANTIC');
      expect(pq?.intentOk).toBe(true);
    }
  });
});
