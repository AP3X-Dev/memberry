import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { measureStructuredDev } from '../measure-structured-dev.js';

describe('IDX-001B-D frozen structured dev measurement', () => {
  it('retains the pre-registered ten-point gain with a positive confidence bound', async () => {
    const result = await measureStructuredDev(resolve(import.meta.dirname, '../../../..'));
    expect(result).toMatchObject({
      split: 'dev', k: 10, n: 60,
      controlSuccesses: 28, candidateSuccesses: 36,
      deltaPoints: 13.333333333333334,
      improved: 8, regressed: 0,
      interval: {
        outcome: 'measured', pointPoints: 13.333333333333334,
        lowerPoints: 5,
      },
    });
    expect(result.interval.oneSidedLowerPoints).toBeGreaterThan(0);
    expect(result.interval.upperPoints).toBeGreaterThan(result.deltaPoints);
  }, 30_000);
});
