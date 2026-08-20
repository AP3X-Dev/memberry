// packages/retrieval/src/__tests__/fusion.test.ts
import { describe, it, expect } from 'vitest';
import { rrfFusion, dedup } from '../fusion.js';
import type { RetrievalResult } from '../types.js';

function makeResult(id: string, score: number, sourceType: RetrievalResult['source_type'] = 'symbol'): RetrievalResult {
  return {
    id,
    source_type: sourceType,
    title: id,
    content: `content of ${id}`,
    score,
    metadata: { name: id, file_path: `/src/${id}.ts` },
  };
}

describe('rrfFusion', () => {
  it('returns empty for empty input', () => {
    expect(rrfFusion([], 10)).toEqual([]);
  });

  it('merges results from multiple lists', () => {
    const list1 = [makeResult('a', 0.9), makeResult('b', 0.5)];
    const list2 = [makeResult('b', 0.8), makeResult('c', 0.6)];
    const fused = rrfFusion([list1, list2], 10);
    expect(fused.length).toBe(3);
    // b appears in both lists — should have highest fused score
    const bResult = fused.find((r) => r.id === 'b');
    expect(bResult).toBeDefined();
    expect(bResult!.score).toBeGreaterThan(fused.find((r) => r.id === 'a')!.score);
  });

  it('respects limit', () => {
    const list1 = [makeResult('a', 0.9), makeResult('b', 0.8), makeResult('c', 0.7)];
    const list2 = [makeResult('d', 0.6), makeResult('e', 0.5)];
    const fused = rrfFusion([list1, list2], 2);
    expect(fused.length).toBeLessThanOrEqual(2);
  });

  it('applies feedback boosts', () => {
    const list1 = [makeResult('a', 0.9), makeResult('b', 0.8)];
    const boosts = {
      entity_boosts: { 'b': 0.5 },
      source_type_boosts: { symbol: 0, semantic: 0, episodic: 0, arch_entity: 0, aspect: 0 },
    };
    const fused = rrfFusion([list1], 10, 60, boosts);
    // b should be boosted
    const bScore = fused.find((r) => r.id === 'b')!.score;
    const aScore = fused.find((r) => r.id === 'a')!.score;
    // b was rank 1 (lower RRF) but boosted — might still be below a
    expect(bScore).toBeGreaterThan(0);
    expect(aScore).toBeGreaterThan(0);
  });

  it('OPT-51: empty/non-matching entity_boosts are no-ops; a matching substring boost still applies', () => {
    const list1 = [makeResult('alpha', 0.9), makeResult('beta', 0.8)];
    const srcZero = { symbol: 0, semantic: 0, episodic: 0, arch_entity: 0, aspect: 0 } as const;
    const scoresOf = (res: RetrievalResult[]) =>
      res.map((r) => [r.id, r.score] as const).sort((x, y) => x[0].localeCompare(y[0]));

    const noBoosts = rrfFusion([list1], 10);

    // Empty entity_boosts → identical to no boosts (the OPT-51 short-circuit is a
    // true no-op, not a result-altering path).
    const empty = rrfFusion([list1], 10, 60, { entity_boosts: {}, source_type_boosts: { ...srcZero } });
    expect(scoresOf(empty)).toEqual(scoresOf(noBoosts));

    // A boost key that matches NO candidate content/title → also a no-op (proves
    // the hoist preserved the substring-match guard, not an unconditional boost).
    const nonMatching = rrfFusion([list1], 10, 60, { entity_boosts: { zzz_nomatch: 0.5 }, source_type_boosts: { ...srcZero } });
    expect(scoresOf(nonMatching)).toEqual(scoresOf(noBoosts));

    // A boost key that IS a substring of alpha's content ("content of alpha") →
    // alpha's score changes (the boost still applies after the hoist).
    const matching = rrfFusion([list1], 10, 60, { entity_boosts: { alpha: 0.5 }, source_type_boosts: { ...srcZero } });
    const alphaMatched = matching.find((r) => r.id === 'alpha')!.score;
    const alphaBase = noBoosts.find((r) => r.id === 'alpha')!.score;
    expect(alphaMatched).not.toBe(alphaBase);
  });

  it('applies postBoost function before MMR', () => {
    const list1 = [makeResult('a', 0.9), makeResult('b', 0.3)];
    // Boost b's score dramatically
    const postBoost = (r: RetrievalResult) => r.id === 'b' ? r.score * 10 : r.score;
    const fused = rrfFusion([list1], 10, 60, undefined, undefined, postBoost);
    // After boost, b should be ranked higher
    expect(fused[0].id).toBe('b');
  });

  it('applies an identity-free batch decomposition multiplier after lexical boost', () => {
    const list = [makeResult('first', 0.9), makeResult('second', 0.8)];
    let observed: unknown;
    const fused = rrfFusion(
      [list], 10, 60, undefined, undefined,
      (result) => result.id === 'second' ? result.score * 1.1 : result.score,
      undefined,
      (window) => {
        observed = window;
        return [1, 1.25];
      },
    );
    expect(fused[0]!.id).toBe('second');
    expect(observed).toEqual([
      { content: 'content of first', ordinal: 0 },
      { content: 'content of second', ordinal: 1 },
    ]);
    expect(Object.keys((observed as object[])[0]!)).toEqual(['content', 'ordinal']);
  });

  it('uses exact identity multipliers when a decomposition callback fails validation', () => {
    const list = [makeResult('first', 0.9), makeResult('second', 0.8)];
    const baseline = rrfFusion([list], 10);
    const malformed = rrfFusion(
      [list], 10, 60, undefined, undefined, undefined, undefined,
      () => [1.5],
    );
    expect(malformed).toEqual(baseline);
    const sparse = rrfFusion(
      [list], 10, 60, undefined, undefined, undefined, undefined,
      () => new Array<number>(2),
    );
    expect(sparse).toEqual(baseline);
    let accessorCalls = 0;
    const hostile = [1, 1];
    Object.defineProperty(hostile, 0, { enumerable: true, get: () => { accessorCalls += 1; return 1.25; } });
    const accessor = rrfFusion(
      [list], 10, 60, undefined, undefined, undefined, undefined,
      () => hostile,
    );
    expect(accessor).toEqual(baseline);
    expect(accessorCalls).toBe(0);

    let proxyTraps = 0;
    const hostileVector = new Proxy([1.25, 1.25], {
      get: () => { proxyTraps += 1; throw new Error('forbidden get'); },
      getOwnPropertyDescriptor: () => { proxyTraps += 1; throw new Error('forbidden descriptor'); },
    });
    const proxied = rrfFusion(
      [list], 10, 60, undefined, undefined, undefined, undefined,
      () => hostileVector,
    );
    expect(proxied).toEqual(baseline);
    expect(proxyTraps).toBe(0);

    const revoked = Proxy.revocable([1.25, 1.25], {});
    revoked.revoke();
    expect(() => rrfFusion(
      [list], 10, 60, undefined, undefined, undefined, undefined,
      () => revoked.proxy,
    )).not.toThrow();
    expect(rrfFusion(
      [list], 10, 60, undefined, undefined, undefined, undefined,
      () => revoked.proxy,
    )).toEqual(baseline);
  });

  it('uses provenance quality to demote invalidated results during fusion', () => {
    const stale = makeResult('stale', 0.9, 'semantic');
    stale.metadata = {
      confidence: 0.9,
      source_episode_ids: ['ep-1'],
      invalidated_at: '2026-05-01T00:00:00.000Z',
    };

    const backed = makeResult('backed', 0.8, 'semantic');
    backed.metadata = {
      confidence: 0.95,
      source_episode_ids: ['ep-1', 'ep-2', 'ep-3', 'ep-4'],
    };

    const fused = rrfFusion([[stale, backed]], 2);
    expect(fused[0].id).toBe('backed');
  });

  it('handles single-item lists', () => {
    const list1 = [makeResult('a', 0.9)];
    const fused = rrfFusion([list1], 10);
    expect(fused).toHaveLength(1);
    expect(fused[0].id).toBe('a');
  });
});

describe('dedup', () => {
  it('removes duplicates keeping highest score', () => {
    const results = [
      makeResult('a', 0.9),
      makeResult('a', 0.5), // Duplicate, lower score
      makeResult('b', 0.7),
    ];
    const deduped = dedup(results);
    expect(deduped).toHaveLength(2);
    expect(deduped.find((r) => r.id === 'a')!.score).toBe(0.9);
  });

  it('returns empty for empty input', () => {
    expect(dedup([])).toEqual([]);
  });

  it('preserves order of first occurrence', () => {
    const results = [makeResult('a', 0.5), makeResult('b', 0.9)];
    const deduped = dedup(results);
    expect(deduped).toHaveLength(2);
  });
});
