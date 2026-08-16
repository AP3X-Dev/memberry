import { int } from 'neo4j-driver';
import { describe, expect, it } from 'vitest';

import { normalizeSemanticSignalCount } from '../semantic-signal-count.js';

describe('normalizeSemanticSignalCount', () => {
  it('preserves primitive nonnegative safe integers and converts official Neo4j Integers', () => {
    const accepted = [
      [0, 0],
      [1, 1],
      [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
      [int(0), 0],
      [int(1), 1],
      [int(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER],
    ] as const;

    for (const [value, expected] of accepted) {
      expect(normalizeSemanticSignalCount(value)).toBe(expected);
    }
  });

  it('rejects invalid values instead of clamping, rounding, or coercing them', () => {
    const rejected: unknown[] = [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      '1',
      1n,
      null,
      {},
      int(-1),
      int('9007199254740992'),
    ];

    for (const value of rejected) {
      expect(() => normalizeSemanticSignalCount(value)).toThrowError(TypeError);
    }
  });
});
