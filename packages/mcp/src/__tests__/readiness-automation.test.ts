import { describe, expect, it } from 'vitest';
import { readinessStatusCode } from '../server.js';

describe('automation readiness policy', () => {
  it('returns 503 only for genuinely unhealthy enabled automation', () => {
    expect(readinessStatusCode({ unhealthy: true })).toBe(503);
    expect(readinessStatusCode({ unhealthy: false })).toBe(200);
    expect(readinessStatusCode({})).toBe(200);
  });
});
