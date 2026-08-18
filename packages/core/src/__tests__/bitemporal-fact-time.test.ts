import { readFileSync } from 'node:fs';
import { types as nodeUtilTypes } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  BITEMPORAL_FACT_TIME_CONTRACT_ID,
  BITEMPORAL_FACT_TIME_CONTRACT_VERSION,
  BitemporalFactTimeContractError,
  emitBitemporalFactTimeV1,
  isBitemporalFactVisibleV1,
  migrateLegacyFactTimeV1,
  parseBitemporalFactTimeV1,
  parseLegacyFactTimeV1,
} from '../bitemporal-fact-time.js';

const JAN_1 = '2026-01-01T00:00:00.000Z';
const JAN_2 = '2026-01-02T00:00:00.000Z';
const FEB_1 = '2026-02-01T00:00:00.000Z';
const FEB_2 = '2026-02-02T00:00:00.000Z';

function legacy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    valid_at: JAN_1,
    invalid_at: JAN_2,
    created_at: FEB_1,
    updated_at: FEB_2,
    ...overrides,
  };
}

function bitemporal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractId: 'memberry.bitemporal-fact-time',
    contractVersion: '1.0.0',
    valid_from: JAN_1,
    valid_to: JAN_2,
    recorded_from: FEB_1,
    recorded_to: FEB_2,
    ...overrides,
  };
}

function point(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    validAt: JAN_1,
    recordedAt: FEB_1,
    ...overrides,
  };
}

function expectFrozenRecord(value: object, keys: readonly string[]): void {
  expect(Object.getPrototypeOf(value)).toBeNull();
  expect(Object.isFrozen(value)).toBe(true);
  expect(Reflect.ownKeys(value)).toEqual(keys);
  for (let index = 0; index < keys.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, keys[index]!)!;
    expect(descriptor.enumerable).toBe(true);
    expect(descriptor.configurable).toBe(false);
    expect(descriptor.writable).toBe(false);
    expect(descriptor.get).toBeUndefined();
    expect(descriptor.set).toBeUndefined();
  }
}

function expectFailure(
  work: () => unknown,
  code: 'invalid-legacy' | 'invalid-bitemporal' | 'invalid-point',
): void {
  let caught: unknown;
  try {
    work();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(BitemporalFactTimeContractError);
  expect((caught as BitemporalFactTimeContractError).code).toBe(code);
  expect(String(caught)).toBe(`BitemporalFactTimeContractError: bitemporal_fact_time_contract:${code}`);
  expect(String(caught)).not.toContain('2026-');
}

describe('bitemporal fact time v1', () => {
  it('parses exact legacy time into a copied frozen null-prototype record', () => {
    const input = legacy();
    const parsed = parseLegacyFactTimeV1(input);

    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expectFrozenRecord(parsed, ['valid_at', 'invalid_at', 'created_at', 'updated_at']);
    expect(input).toEqual(legacy());
  });

  it('migrates legacy valid and record axes without treating updated_at as a record end', () => {
    const migrated = migrateLegacyFactTimeV1(legacy());

    expect(migrated).toEqual({
      contractId: 'memberry.bitemporal-fact-time',
      contractVersion: '1.0.0',
      valid_from: JAN_1,
      valid_to: JAN_2,
      recorded_from: FEB_1,
      recorded_to: null,
    });
    expectFrozenRecord(migrated, [
      'contractId', 'contractVersion', 'valid_from', 'valid_to', 'recorded_from', 'recorded_to',
    ]);
  });

  it('validates updated_at but permits equality and never emits it', () => {
    const equal = migrateLegacyFactTimeV1(legacy({ updated_at: FEB_1 }));
    expect(equal.recorded_to).toBeNull();
    expectFailure(() => migrateLegacyFactTimeV1(legacy({ updated_at: JAN_2 })), 'invalid-legacy');
    expectFailure(() => migrateLegacyFactTimeV1(legacy({ updated_at: 'not-a-date' })), 'invalid-legacy');
  });

  it('parses and emits exact v1 records as independent frozen copies', () => {
    const input = bitemporal();
    const parsed = parseBitemporalFactTimeV1(input);
    const emitted = emitBitemporalFactTimeV1(parsed);
    const reparsed = parseBitemporalFactTimeV1(emitted);

    expect(parsed).toEqual(input);
    expect(emitted).toEqual(parsed);
    expect(reparsed).toEqual(emitted);
    expect(parsed).not.toBe(input);
    expect(emitted).not.toBe(parsed);
    expect(reparsed).not.toBe(emitted);
    expectFrozenRecord(parsed, [
      'contractId', 'contractVersion', 'valid_from', 'valid_to', 'recorded_from', 'recorded_to',
    ]);
  });

  it('accepts canonical open-ended intervals on either axis', () => {
    const parsed = parseBitemporalFactTimeV1(bitemporal({ valid_to: null, recorded_to: null }));
    expect(parsed.valid_to).toBeNull();
    expect(parsed.recorded_to).toBeNull();
    expect(parseLegacyFactTimeV1(legacy({ invalid_at: null })).invalid_at).toBeNull();
  });

  it('requires strict increasing non-null ends on both axes', () => {
    expectFailure(() => parseLegacyFactTimeV1(legacy({ invalid_at: JAN_1 })), 'invalid-legacy');
    expectFailure(() => parseLegacyFactTimeV1(legacy({ valid_at: JAN_2, invalid_at: JAN_1 })), 'invalid-legacy');
    expectFailure(() => parseBitemporalFactTimeV1(bitemporal({ valid_to: JAN_1 })), 'invalid-bitemporal');
    expectFailure(() => parseBitemporalFactTimeV1(bitemporal({ recorded_to: FEB_1 })), 'invalid-bitemporal');
    expectFailure(() => parseBitemporalFactTimeV1(bitemporal({
      recorded_from: FEB_2,
      recorded_to: FEB_1,
    })), 'invalid-bitemporal');
  });

  it('uses strict half-open visibility on the valid axis', () => {
    const input = bitemporal({ recorded_to: null });
    expect(isBitemporalFactVisibleV1(input, point({ validAt: '2025-12-31T23:59:59.999Z' }))).toBe(false);
    expect(isBitemporalFactVisibleV1(input, point({ validAt: JAN_1 }))).toBe(true);
    expect(isBitemporalFactVisibleV1(input, point({ validAt: '2026-01-01T23:59:59.999Z' }))).toBe(true);
    expect(isBitemporalFactVisibleV1(input, point({ validAt: JAN_2 }))).toBe(false);
  });

  it('uses strict half-open visibility on the recorded axis', () => {
    const input = bitemporal({ valid_to: null });
    expect(isBitemporalFactVisibleV1(input, point({ recordedAt: '2026-01-31T23:59:59.999Z' }))).toBe(false);
    expect(isBitemporalFactVisibleV1(input, point({ recordedAt: FEB_1 }))).toBe(true);
    expect(isBitemporalFactVisibleV1(input, point({ recordedAt: '2026-02-01T23:59:59.999Z' }))).toBe(true);
    expect(isBitemporalFactVisibleV1(input, point({ recordedAt: FEB_2 }))).toBe(false);
  });

  it('models late-arriving truth independently across valid and recorded time', () => {
    const lateTruth = bitemporal({
      valid_from: '2025-01-01T00:00:00.000Z',
      valid_to: null,
      recorded_from: FEB_1,
      recorded_to: null,
    });
    const historicalPoint = { validAt: '2025-06-01T00:00:00.000Z', recordedAt: JAN_2 };
    const knownLater = { validAt: '2025-06-01T00:00:00.000Z', recordedAt: FEB_1 };

    expect(isBitemporalFactVisibleV1(lateTruth, historicalPoint)).toBe(false);
    expect(isBitemporalFactVisibleV1(lateTruth, knownLater)).toBe(true);
  });

  it('rejects non-canonical, normalized, invalid-calendar, timezone, and bound forms', () => {
    const invalid = [
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:00:00.00Z',
      '2026-01-01t00:00:00.000z',
      '2026-01-01T00:00:00.000+00:00',
      '2026-01-01T00:00:00.000-07:00',
      '2026-02-29T00:00:00.000Z',
      '2026-13-01T00:00:00.000Z',
      '2026-01-32T00:00:00.000Z',
      '2026-01-01T24:00:00.000Z',
      '2026-01-01T00:00:60.000Z',
      '10000-01-01T00:00:00.000Z',
      '-000001-01-01T00:00:00.000Z',
      '\ud800',
      '',
    ];
    for (let index = 0; index < invalid.length; index += 1) {
      expectFailure(() => parseBitemporalFactTimeV1(bitemporal({ valid_from: invalid[index] })), 'invalid-bitemporal');
      expectFailure(() => parseLegacyFactTimeV1(legacy({ valid_at: invalid[index] })), 'invalid-legacy');
      expectFailure(() => isBitemporalFactVisibleV1(bitemporal(), point({ validAt: invalid[index] })), 'invalid-point');
    }
  });

  it('rejects wrong contract literals, mixed versions, coercion, and defaults', () => {
    expectFailure(() => parseBitemporalFactTimeV1(bitemporal({ contractId: 'other' })), 'invalid-bitemporal');
    expectFailure(() => parseBitemporalFactTimeV1(bitemporal({ contractVersion: '1' })), 'invalid-bitemporal');
    expectFailure(() => parseBitemporalFactTimeV1({ ...bitemporal(), valid_at: JAN_1 }), 'invalid-bitemporal');
    expectFailure(() => parseLegacyFactTimeV1({ ...legacy(), contractId: BITEMPORAL_FACT_TIME_CONTRACT_ID }), 'invalid-legacy');
    expectFailure(() => parseBitemporalFactTimeV1(bitemporal({ valid_from: new Date(JAN_1) })), 'invalid-bitemporal');
    expectFailure(() => parseBitemporalFactTimeV1(bitemporal({ recorded_to: undefined })), 'invalid-bitemporal');
  });

  it('accepts null-prototype and parsed frozen records without mutating inputs', () => {
    const nullLegacy = Object.assign(Object.create(null), legacy());
    const nullV1 = Object.assign(Object.create(null), bitemporal());
    const nullPoint = Object.assign(Object.create(null), point());
    const parsedLegacy = parseLegacyFactTimeV1(nullLegacy);
    const parsedV1 = parseBitemporalFactTimeV1(nullV1);

    expect(parseLegacyFactTimeV1(parsedLegacy)).toEqual(parsedLegacy);
    expect(parseBitemporalFactTimeV1(parsedV1)).toEqual(parsedV1);
    expect(isBitemporalFactVisibleV1(parsedV1, nullPoint)).toBe(true);
    expect(Object.getPrototypeOf(nullLegacy)).toBeNull();
    expect(Object.isFrozen(nullLegacy)).toBe(false);
  });

  it('rejects extra, missing, symbol, accessor, array, and unsafe-prototype records without hooks', () => {
    expectFailure(() => parseLegacyFactTimeV1(legacy({ extra: true })), 'invalid-legacy');
    const missing = bitemporal();
    delete missing.valid_from;
    expectFailure(() => parseBitemporalFactTimeV1(missing), 'invalid-bitemporal');
    const symbol = point();
    Object.defineProperty(symbol, Symbol('extra'), { value: true, enumerable: true });
    expectFailure(() => isBitemporalFactVisibleV1(bitemporal(), symbol), 'invalid-point');

    let getterCalls = 0;
    const accessor = legacy();
    Object.defineProperty(accessor, 'valid_at', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return JAN_1;
      },
    });
    expectFailure(() => parseLegacyFactTimeV1(accessor), 'invalid-legacy');
    expect(getterCalls).toBe(0);
    expectFailure(() => parseBitemporalFactTimeV1([]), 'invalid-bitemporal');
    const unsafe = bitemporal();
    Object.setPrototypeOf(unsafe, { inherited: true });
    expectFailure(() => parseBitemporalFactTimeV1(unsafe), 'invalid-bitemporal');
  });

  it('rejects proxies and revoked proxies with zero hostile hooks', () => {
    let hooks = 0;
    const proxy = new Proxy(bitemporal(), {
      get() { hooks += 1; throw new Error('get'); },
      getOwnPropertyDescriptor() { hooks += 1; throw new Error('descriptor'); },
      getPrototypeOf() { hooks += 1; throw new Error('prototype'); },
      ownKeys() { hooks += 1; throw new Error('keys'); },
    });
    expectFailure(() => parseBitemporalFactTimeV1(proxy), 'invalid-bitemporal');
    expect(hooks).toBe(0);

    const revoked = Proxy.revocable(point(), {});
    revoked.revoke();
    expectFailure(() => isBitemporalFactVisibleV1(bitemporal(), revoked.proxy), 'invalid-point');
  });

  it('validates the complete input and point before returning visibility', () => {
    expectFailure(() => isBitemporalFactVisibleV1(
      bitemporal({ valid_from: 'bad' }),
      point({ validAt: '2025-01-01T00:00:00.000Z' }),
    ), 'invalid-bitemporal');
    expectFailure(() => isBitemporalFactVisibleV1(
      bitemporal({ valid_to: null, recorded_to: null }),
      point({ extra: true }),
    ), 'invalid-point');
  });

  it('uses captured Date, RegExp, Object, and String intrinsics without JSON or toJSON hooks', () => {
    const input = bitemporal({ valid_to: null, recorded_to: null });
    const visibilityPoint = point();
    const originalDate = globalThis.Date;
    const originalDateParse = Date.parse;
    const originalToISOString = Date.prototype.toISOString;
    const originalToJsonDescriptor = Object.getOwnPropertyDescriptor(Date.prototype, 'toJSON')!;
    const originalRegExp = globalThis.RegExp;
    const originalRegExpExec = RegExp.prototype.exec;
    const originalString = globalThis.String;
    const originalCharCodeAt = String.prototype.charCodeAt;
    const originalGetPrototypeOf = Object.getPrototypeOf;
    const originalGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
    const originalDefineProperty = Object.defineProperty;
    const originalCreate = Object.create;
    const originalFreeze = Object.freeze;
    const originalHasOwn = Object.hasOwn;
    const originalOwnKeys = Reflect.ownKeys;
    const originalIsArray = Array.isArray;
    const originalIsFinite = Number.isFinite;
    const originalIsProxy = nodeUtilTypes.isProxy;
    const originalJsonParse = JSON.parse;
    const originalJsonStringify = JSON.stringify;
    let hooks = 0;
    const hostile = () => { hooks += 1; throw new Error('ambient hook'); };
    let visible: unknown;
    try {
      originalDate.parse = hostile as typeof Date.parse;
      originalDate.prototype.toISOString = hostile as typeof Date.prototype.toISOString;
      Object.defineProperty(originalDate.prototype, 'toJSON', {
        value: hostile,
        writable: true,
        enumerable: false,
        configurable: true,
      });
      globalThis.Date = hostile as unknown as DateConstructor;
      originalRegExp.prototype.exec = hostile as typeof RegExp.prototype.exec;
      globalThis.RegExp = hostile as unknown as RegExpConstructor;
      originalString.prototype.charCodeAt = hostile as typeof String.prototype.charCodeAt;
      globalThis.String = hostile as unknown as StringConstructor;
      Object.getPrototypeOf = hostile as typeof Object.getPrototypeOf;
      Object.getOwnPropertyDescriptor = hostile as typeof Object.getOwnPropertyDescriptor;
      Object.defineProperty = hostile as typeof Object.defineProperty;
      Object.create = hostile as typeof Object.create;
      Object.freeze = hostile as typeof Object.freeze;
      Object.hasOwn = hostile as typeof Object.hasOwn;
      Reflect.ownKeys = hostile as typeof Reflect.ownKeys;
      Array.isArray = hostile as unknown as typeof Array.isArray;
      Number.isFinite = hostile as typeof Number.isFinite;
      nodeUtilTypes.isProxy = hostile as typeof nodeUtilTypes.isProxy;
      JSON.parse = hostile as typeof JSON.parse;
      JSON.stringify = hostile as typeof JSON.stringify;
      visible = isBitemporalFactVisibleV1(input, visibilityPoint);
    } finally {
      globalThis.Date = originalDate;
      originalDate.parse = originalDateParse;
      originalDate.prototype.toISOString = originalToISOString;
      originalDefineProperty(originalDate.prototype, 'toJSON', originalToJsonDescriptor);
      globalThis.RegExp = originalRegExp;
      originalRegExp.prototype.exec = originalRegExpExec;
      globalThis.String = originalString;
      originalString.prototype.charCodeAt = originalCharCodeAt;
      Object.getPrototypeOf = originalGetPrototypeOf;
      Object.getOwnPropertyDescriptor = originalGetOwnPropertyDescriptor;
      Object.defineProperty = originalDefineProperty;
      Object.create = originalCreate;
      Object.freeze = originalFreeze;
      Object.hasOwn = originalHasOwn;
      Reflect.ownKeys = originalOwnKeys;
      Array.isArray = originalIsArray;
      Number.isFinite = originalIsFinite;
      nodeUtilTypes.isProxy = originalIsProxy;
      JSON.parse = originalJsonParse;
      JSON.stringify = originalJsonStringify;
    }
    expect(visible).toBe(true);
    expect(hooks).toBe(0);
  });

  it('is deterministic and remains unwired from clocks, storage, environment, and networking', () => {
    expect(isBitemporalFactVisibleV1(bitemporal(), point()))
      .toBe(isBitemporalFactVisibleV1(bitemporal(), point()));
    expect(BITEMPORAL_FACT_TIME_CONTRACT_ID).toBe('memberry.bitemporal-fact-time');
    expect(BITEMPORAL_FACT_TIME_CONTRACT_VERSION).toBe('1.0.0');

    const source = readFileSync(new URL('../bitemporal-fact-time.ts', import.meta.url), 'utf8');
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/Date\.now|new Date\(\)|JSON\.|\.toJSON|for\s*\([^)]*\sof\s|\.sort\(/);
    expect(source).not.toMatch(/process\.|globalThis\.|@memberry\/(?:neo4j|redis|mcp)/);
    expect(source).not.toMatch(/from ['"]node:(?:fs|path|child_process|os|net|http|https|crypto)['"]/);
    expect(index).not.toContain('bitemporal-fact-time');
  });
});
