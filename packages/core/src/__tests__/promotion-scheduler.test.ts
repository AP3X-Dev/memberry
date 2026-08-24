// packages/core/src/__tests__/promotion-scheduler.test.ts
//
// MEM-005: the pure cursor contract behind the dual-window promotion fetch.
// The cursor round-trips through Redis, so the parser must survive anything —
// a corrupt cursor means "restart from head", never a throw.
import { describe, it, expect } from 'vitest';
import {
  SCHEDULER_CONTRACT_VERSION,
  SchedulerContractError,
  advancePromotionCursorV1,
  parsePromotionCursorV1,
  planPromotionFetchV1,
  promotionClassTierV1,
  promotionCursorRedisKeyV1,
  serializePromotionCursorV1,
  type PromotionCursorV1,
} from '../promotion-scheduler.js';

const VALID: PromotionCursorV1 = {
  contractVersion: SCHEDULER_CONTRACT_VERSION,
  classTier: 2,
  createdAt: '2026-08-12T00:00:00.000Z',
  id: 'ep-1',
};

// ─── parsePromotionCursorV1 ──────────────────────────────────────────────────

describe('parsePromotionCursorV1', () => {
  it('round-trips a serialized cursor and freezes the result', () => {
    const parsed = parsePromotionCursorV1(serializePromotionCursorV1(VALID));
    expect(parsed).toEqual(VALID);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each([
    ['non-string input', 42],
    ['null input', null],
    ['object input', { ...VALID }],
    ['empty string', ''],
    ['non-JSON string', 'not-json{'],
    ['JSON array', JSON.stringify([VALID])],
    ['JSON scalar', JSON.stringify('cursor')],
    ['missing key', JSON.stringify({ contractVersion: SCHEDULER_CONTRACT_VERSION, classTier: 2, createdAt: 'x' })],
    ['extra key', JSON.stringify({ ...VALID, extra: 1 })],
    ['prototype key smuggled in', '{"contractVersion":"promotion-scheduler-v1","classTier":2,"createdAt":"x","id":"y","__proto__":{"polluted":true}}'],
    ['wrong contract version', JSON.stringify({ ...VALID, contractVersion: 'promotion-scheduler-v2' })],
    ['tier out of range', JSON.stringify({ ...VALID, classTier: 3 })],
    ['negative tier', JSON.stringify({ ...VALID, classTier: -1 })],
    ['non-integer tier', JSON.stringify({ ...VALID, classTier: 1.5 })],
    ['string tier', JSON.stringify({ ...VALID, classTier: '2' })],
    ['non-string createdAt', JSON.stringify({ ...VALID, createdAt: 7 })],
    ['empty createdAt', JSON.stringify({ ...VALID, createdAt: '' })],
    ['non-string id', JSON.stringify({ ...VALID, id: null })],
    ['empty id', JSON.stringify({ ...VALID, id: '' })],
    ['oversized payload', JSON.stringify({ ...VALID, id: 'x'.repeat(5000) })],
  ])('returns null (never throws) for %s', (_label, raw) => {
    expect(parsePromotionCursorV1(raw)).toBeNull();
  });

  it('does not pollute Object.prototype when fed a __proto__ payload', () => {
    parsePromotionCursorV1('{"__proto__":{"polluted":true},"contractVersion":"promotion-scheduler-v1","classTier":2,"createdAt":"x","id":"y"}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

// ─── planPromotionFetchV1 ────────────────────────────────────────────────────

describe('planPromotionFetchV1', () => {
  it('splits an even budget in half', () => {
    const plan = planPromotionFetchV1(200);
    expect(plan).toEqual({ headLimit: 100, continuationLimit: 100 });
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it('gives the head window the extra slot on an odd budget', () => {
    expect(planPromotionFetchV1(7)).toEqual({ headLimit: 4, continuationLimit: 3 });
    expect(planPromotionFetchV1(1)).toEqual({ headLimit: 1, continuationLimit: 0 });
  });

  it.each([0, -1, 2001, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'throws SchedulerContractError for %s',
    (bad) => {
      expect(() => planPromotionFetchV1(bad)).toThrowError(SchedulerContractError);
      expect(() => planPromotionFetchV1(bad)).toThrowError('invalid-max-candidates');
    },
  );
});

// ─── promotionClassTierV1 ────────────────────────────────────────────────────

describe('promotionClassTierV1', () => {
  it('mirrors the findPromotable CASE rule exactly', () => {
    expect(promotionClassTierV1({ id: 'a', created_at: 't', memory_type: 'decision', outcome: 'approved' })).toBe(0);
    expect(promotionClassTierV1({ id: 'a', created_at: 't', memory_type: 'decision', outcome: 'rejected' })).toBe(2);
    expect(promotionClassTierV1({ id: 'a', created_at: 't', memory_type: 'pattern' })).toBe(1);
    expect(promotionClassTierV1({ id: 'a', created_at: 't', memory_type: 'convention' })).toBe(1);
    expect(promotionClassTierV1({ id: 'a', created_at: 't', memory_type: 'general' })).toBe(2);
    expect(promotionClassTierV1({ id: 'a', created_at: 't' })).toBe(2);
  });
});

// ─── advancePromotionCursorV1 ────────────────────────────────────────────────

describe('advancePromotionCursorV1', () => {
  const head = [
    { id: 'h1', created_at: '2026-01-01T00:00:00.000Z' },
    { id: 'h2', created_at: '2026-01-02T00:00:00.000Z', memory_type: 'pattern' },
  ];
  const continuation = [
    { id: 'c1', created_at: '2026-02-01T00:00:00.000Z' },
    { id: 'c2', created_at: '2026-02-02T00:00:00.000Z' },
  ];

  it('advances to the last continuation element when the window came back full', () => {
    const next = advancePromotionCursorV1(continuation, 2, head, 2);
    expect(next).toEqual({
      contractVersion: SCHEDULER_CONTRACT_VERSION,
      classTier: 2,
      createdAt: '2026-02-02T00:00:00.000Z',
      id: 'c2',
    });
    expect(Object.isFrozen(next)).toBe(true);
  });

  it('wraps (null) when the continuation batch is short — scan exhausted', () => {
    expect(advancePromotionCursorV1(continuation.slice(0, 1), 2, head, 2)).toBeNull();
    expect(advancePromotionCursorV1([], 2, head, 2)).toBeNull();
    // Degenerate limit 0: an empty batch never mints a cursor.
    expect(advancePromotionCursorV1([], 0, head, 2)).toBeNull();
  });

  it('seed pass: cursor comes from the LAST head element, with the derived tier', () => {
    expect(advancePromotionCursorV1(null, 2, head, 2)).toEqual({
      contractVersion: SCHEDULER_CONTRACT_VERSION,
      classTier: 1, // h2 is a pattern
      createdAt: '2026-01-02T00:00:00.000Z',
      id: 'h2',
    });
  });

  it('seed pass: null when the head batch is short — everything fit in the head window', () => {
    expect(advancePromotionCursorV1(null, 2, head.slice(0, 1), 2)).toBeNull();
    expect(advancePromotionCursorV1(null, 2, [], 2)).toBeNull();
  });
});

// ─── promotionCursorRedisKeyV1 ───────────────────────────────────────────────

describe('promotionCursorRedisKeyV1', () => {
  it('defaults null parts to stable placeholders', () => {
    expect(promotionCursorRedisKeyV1(null, null)).toBe(
      'memberry:consolidation:promote-cursor:v1:default:all',
    );
  });

  it('encodes the separator so (a:b, c) and (a, b:c) cannot collide', () => {
    expect(promotionCursorRedisKeyV1('c', 'a:b')).not.toBe(promotionCursorRedisKeyV1('b:c', 'a'));
    expect(promotionCursorRedisKeyV1('project:test', 'tenant-a')).toBe(
      'memberry:consolidation:promote-cursor:v1:tenant-a:project%3Atest',
    );
  });
});
