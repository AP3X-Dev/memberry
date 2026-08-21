import { createHash } from 'node:crypto';
import { types as nodeUtilTypes } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RERANKER_BASELINE_REASON,
  RERANKER_CONTRACT_ID,
  RERANKER_CONTRACT_VERSION,
  RERANKER_MAX_AGGREGATE_STRING_BYTES,
  RERANKER_MAX_CANDIDATES,
  RERANKER_MAX_QUERY_BYTES,
  RERANKER_MAX_RESPONSE_BYTES,
  RERANKER_MAX_STRING_BYTES,
  RERANKER_MAX_TIMEOUT_MS,
  RerankerContractError,
  createRerankerProviderV1,
  executeCalibratedRerankV1,
  type RerankCandidateInputV1,
  type RerankerCancellationV1,
  type RerankerProviderIdentityV1,
  type RerankerResultV1,
  type SerializedRerankerProviderRequestV1,
  baselineIdentityRerankerScoreV1,
  createHttpsRerankerProviderV1,
  createLocalRerankerProviderV1,
  type RerankerHttpsTransportV1,
} from '../index.js';
import {
  parseSerializedRerankerProviderRequestV1,
  serializeRerankerProviderResponseV1,
} from '../reranker.js';

const IDENTITY = Object.freeze({
  providerId: 'provider-a',
  modelId: 'model-a',
  calibrationId: 'calibration-a',
  locality: 'local',
} as const);

const REMOTE_IDENTITY = Object.freeze({ ...IDENTITY, locality: 'remote' as const });

function candidate<T>(value: T, overrides: Record<string, unknown> = {}): RerankCandidateInputV1<T> {
  return {
    value,
    sourceType: 'semantic',
    title: 'title',
    content: 'content',
    baselineScore: 0.25,
    ...overrides,
  } as RerankCandidateInputV1<T>;
}

function responseFor(
  serialized: SerializedRerankerProviderRequestV1,
  scores: readonly number[],
  identity: RerankerProviderIdentityV1 = IDENTITY,
  overrides: Record<string, unknown> = {},
): string {
  const request = JSON.parse(serialized) as {
    requestDigest: string;
    candidateCount: number;
    candidates: Array<{ key: string }>;
  };
  return JSON.stringify({
    contractId: RERANKER_CONTRACT_ID,
    contractVersion: RERANKER_CONTRACT_VERSION,
    requestDigest: request.requestDigest,
    providerId: identity.providerId,
    modelId: identity.modelId,
    calibrationId: identity.calibrationId,
    candidateCount: request.candidateCount,
    scores: request.candidates.map((item, index) => ({
      key: item.key,
      calibratedScore: scores[index],
    })),
    ...overrides,
  });
}

function manualResponseFor(
  serialized: SerializedRerankerProviderRequestV1,
  scores: readonly number[],
  identity: RerankerProviderIdentityV1 = IDENTITY,
): string {
  const request = JSON.parse(serialized) as {
    requestDigest: string;
    candidateCount: number;
    candidates: Array<{ key: string }>;
  };
  const quote = JSON.stringify;
  let scoreBytes = '[';
  for (let index = 0; index < request.candidates.length; index += 1) {
    if (index > 0) scoreBytes += ',';
    scoreBytes += `{"key":${quote(request.candidates[index]!.key)},"calibratedScore":${quote(scores[index])}}`;
  }
  scoreBytes += ']';
  return `{"contractId":${quote(RERANKER_CONTRACT_ID)},"contractVersion":${quote(RERANKER_CONTRACT_VERSION)},"requestDigest":${quote(request.requestDigest)},"providerId":${quote(identity.providerId)},"modelId":${quote(identity.modelId)},"calibrationId":${quote(identity.calibrationId)},"candidateCount":${request.candidateCount},"scores":${scoreBytes}}`;
}

function providerReturning(
  build: (request: SerializedRerankerProviderRequestV1, cancellation: RerankerCancellationV1) => unknown,
  identity: RerankerProviderIdentityV1 = IDENTITY,
) {
  const run = vi.fn((request: SerializedRerankerProviderRequestV1, cancellation: RerankerCancellationV1) => (
    build(request, cancellation) as Promise<string>
  ));
  return { provider: createRerankerProviderV1(identity, run), run };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('memberry.reranker v1 core boundary', () => {
  it('uses own indexed data properties for all six canonical helper array-write classes', async () => {
    const inputs = Array.from({ length: RERANKER_MAX_CANDIDATES }, (_, index) => candidate(index, {
      title: `title-${index}`,
      content: `content-${index}`,
      baselineScore: index / RERANKER_MAX_CANDIDATES,
    }));
    const cases: Array<{ surface: 'array' | 'object' | 'inserted'; index: 0 | 127 }> = [];
    for (const surface of ['array', 'object', 'inserted'] as const) {
      cases.push({ surface, index: 0 }, { surface, index: 127 });
    }
    for (const testCase of cases) {
      let setters = 0;
      let getters = 0;
      const inserted = Object.create(Object.getPrototypeOf(Array.prototype)) as object;
      const originalArrayParent = Object.getPrototypeOf(Array.prototype);
      const host = testCase.surface === 'array'
        ? Array.prototype
        : testCase.surface === 'object' ? Object.prototype : inserted;
      const originalHostDescriptor = Object.getOwnPropertyDescriptor(host, String(testCase.index));
      let result: RerankerResultV1<number> | undefined;
      try {
        Object.defineProperty(host, String(testCase.index), {
          configurable: true,
          get: () => { getters += 1; return undefined; },
          set: () => { setters += 1; },
        });
        if (testCase.surface === 'inserted') Object.setPrototypeOf(Array.prototype, inserted);
        const provider = createRerankerProviderV1(IDENTITY, async (serialized) => {
          const request = parseSerializedRerankerProviderRequestV1(serialized);
          const scores = Array.from(
            { length: request.candidateCount },
            (_, index) => (request.candidateCount - index) / request.candidateCount,
          );
          return serializeRerankerProviderResponseV1(request, IDENTITY, scores);
        });
        result = await executeCalibratedRerankV1({ query: 'canonical helper', candidates: inputs }, provider);
      } finally {
        if (testCase.surface === 'inserted') Object.setPrototypeOf(Array.prototype, originalArrayParent);
        if (originalHostDescriptor === undefined) {
          delete (host as Record<string, unknown>)[String(testCase.index)];
        } else {
          Object.defineProperty(host, String(testCase.index), originalHostDescriptor);
        }
      }
      expect({ surface: testCase.surface, index: testCase.index, setters, getters })
        .toEqual({ surface: testCase.surface, index: testCase.index, setters: 0, getters: 0 });
      expect(result?.outcome).toBe('reranked');
      expect(result?.candidates).toHaveLength(RERANKER_MAX_CANDIDATES);
      expect(result?.candidates.map((item) => item.value))
        .toEqual(Array.from({ length: RERANKER_MAX_CANDIDATES }, (_, index) => index));
      expect(JSON.stringify(result?.candidates.map((item) => item.score)))
        .toBe(JSON.stringify(Array.from(
          { length: RERANKER_MAX_CANDIDATES },
          (_, index) => (RERANKER_MAX_CANDIDATES - index) / RERANKER_MAX_CANDIDATES,
        )));
    }
  });

  it('exports the contract and empty input short-circuits without provider execution', async () => {
    expect(RERANKER_CONTRACT_ID).toBe('memberry.reranker');
    expect(RERANKER_CONTRACT_VERSION).toBe('1.0.0');
    const { provider, run } = providerReturning(() => { throw new Error('must not run'); });
    const result = await executeCalibratedRerankV1({ query: '', candidates: [] }, provider);
    expect(result).toEqual({ outcome: 'baseline', reason: RERANKER_BASELINE_REASON, candidates: [] });
    expect(run).not.toHaveBeenCalled();
  });

  it('assigns opaque contiguous keys, accepts provider reorder, and sorts scores with stable ties', async () => {
    let payload = '';
    let successCancellation!: RerankerCancellationV1;
    const values = [{ id: 'first' }, { id: 'second' }, { id: 'third' }];
    const { provider } = providerReturning((request, cancellation) => {
      payload = request;
      successCancellation = cancellation;
      const parsed = JSON.parse(request) as { candidates: Array<{ key: string }> };
      return Promise.resolve(JSON.stringify({
        contractId: RERANKER_CONTRACT_ID,
        contractVersion: RERANKER_CONTRACT_VERSION,
        requestDigest: (JSON.parse(request) as { requestDigest: string }).requestDigest,
        providerId: IDENTITY.providerId,
        modelId: IDENTITY.modelId,
        calibrationId: IDENTITY.calibrationId,
        candidateCount: 3,
        scores: [
          { key: parsed.candidates[2]!.key, calibratedScore: 0.9 },
          { key: parsed.candidates[0]!.key, calibratedScore: 0.9 },
          { key: parsed.candidates[1]!.key, calibratedScore: 0.2 },
        ],
      }));
    });
    const result = await executeCalibratedRerankV1({
      query: 'find it',
      candidates: values.map((value, index) => candidate(value, { baselineScore: 0.1 + index })),
    }, provider);
    expect(result.outcome).toBe('reranked');
    expect(result.candidates.map((item) => item.value)).toEqual([values[0], values[2], values[1]]);
    expect(result.candidates.map((item) => item.score)).toEqual([0.9, 0.9, 0.2]);
    const request = JSON.parse(payload) as { candidates: Array<Record<string, unknown>> };
    expect(request.candidates.map((item) => item.key)).toEqual(['r0000', 'r0001', 'r0002']);
    expect(request.candidates.map((item) => item.baselineRank)).toEqual([1, 2, 3]);
    expect(Reflect.apply(successCancellation.isCancelled, { hostile: true }, ['ignored'])).toBe(false);
  });

  it('is repeatable and binds exact request digest and provider identity echoes', async () => {
    const payloads: string[] = [];
    const { provider } = providerReturning((request) => {
      payloads.push(request);
      return Promise.resolve(responseFor(request, [0.7]));
    });
    const input = { query: 'same', candidates: [candidate({ stable: true })] };
    await executeCalibratedRerankV1(input, provider);
    await executeCalibratedRerankV1(input, provider);
    expect(payloads[0]).toBe(payloads[1]);
    expect((JSON.parse(payloads[0]!) as { requestDigest: string }).requestDigest).toMatch(/^[a-f0-9]{64}$/);

    for (const overrides of [
      { requestDigest: '0'.repeat(64) },
      { providerId: 'other' },
      { modelId: 'other' },
      { calibrationId: 'other' },
      { candidateCount: 2 },
      { scores: [] },
      { scores: [{ key: 'r9999', calibratedScore: 0.8 }] },
      { scores: [{ key: 'r0000', calibratedScore: 2 }] },
    ]) {
      const hostile = providerReturning((request) => Promise.resolve(responseFor(request, [0.8], IDENTITY, overrides)));
      const result = await executeCalibratedRerankV1(input, hostile.provider);
      expect(result.outcome).toBe('baseline');
    }
    const duplicate = providerReturning((request) => {
      const parsed = JSON.parse(request) as { requestDigest: string; candidates: Array<{ key: string }> };
      return Promise.resolve(JSON.stringify({
        contractId: RERANKER_CONTRACT_ID,
        contractVersion: RERANKER_CONTRACT_VERSION,
        requestDigest: parsed.requestDigest,
        providerId: IDENTITY.providerId,
        modelId: IDENTITY.modelId,
        calibrationId: IDENTITY.calibrationId,
        candidateCount: 2,
        scores: [
          { key: parsed.candidates[0]!.key, calibratedScore: 0.8 },
          { key: parsed.candidates[0]!.key, calibratedScore: 0.7 },
        ],
      }));
    });
    await expect(executeCalibratedRerankV1({
      query: 'q', candidates: [candidate('a'), candidate('b')],
    }, duplicate.provider)).resolves.toMatchObject({ outcome: 'baseline' });
  });

  it('never traverses or serializes opaque values and emits only the approved provider fields', async () => {
    let hooks = 0;
    const secret = 'tenant/project/entity/evidence/provenance/sk_live_NEVER_SEND';
    const opaque = new Proxy({ secret }, {
      get: () => { hooks += 1; throw new Error('opaque get'); },
      ownKeys: () => { hooks += 1; throw new Error('opaque ownKeys'); },
      getOwnPropertyDescriptor: () => { hooks += 1; throw new Error('opaque descriptor'); },
    });
    let payload = '';
    const { provider } = providerReturning((request) => {
      payload = request;
      return Promise.resolve(responseFor(request, [0.8]));
    });
    const result = await executeCalibratedRerankV1({ query: 'q', candidates: [candidate(opaque)] }, provider);
    expect(hooks).toBe(0);
    expect(payload).not.toContain(secret);
    const request = JSON.parse(payload) as { candidates: Array<Record<string, unknown>> };
    expect(Object.keys(request.candidates[0]!)).toEqual([
      'key', 'sourceType', 'title', 'content', 'baselineRank', 'baselineScore',
    ]);
    expect(result.candidates[0]!.value).toBe(opaque);
    expect(hooks).toBe(0);
  });

  it('returns the same fixed value-free baseline for every post-validation failure class', async () => {
    const value = { untouched: true };
    const input = { query: 'q', candidates: [candidate(value, { baselineScore: 0.375 })] };
    const failures = [
      undefined,
      providerReturning(() => { throw new Error('private sync cause'); }).provider,
      providerReturning(() => Promise.reject(new Error('private rejection'))).provider,
      providerReturning(() => 'not a promise').provider,
      providerReturning(() => Promise.resolve('{')).provider,
      providerReturning((request) => Promise.resolve(`${responseFor(request, [0.7])} `)).provider,
      providerReturning((request) => Promise.resolve(responseFor(request, [0.7]) + 'x'.repeat(RERANKER_MAX_RESPONSE_BYTES))).provider,
    ];
    const snapshots: string[] = [];
    for (const provider of failures) {
      const result = await executeCalibratedRerankV1(input, provider);
      expect(result.outcome).toBe('baseline');
      expect(result).toEqual({
        outcome: 'baseline',
        reason: RERANKER_BASELINE_REASON,
        candidates: [{ value, baselineRank: 1, baselineScore: 0.375, score: 0.375 }],
      });
      expect(result.candidates[0]!.value).toBe(value);
      expect(Object.is(result.candidates[0]!.baselineScore, 0.375)).toBe(true);
      expect(Object.is(result.candidates[0]!.score, 0.375)).toBe(true);
      snapshots.push(JSON.stringify(result));
    }
    expect(new Set(snapshots).size).toBe(1);
  });

  it('aborts on timeout, contains late fulfillment, and never retries', async () => {
    vi.useFakeTimers();
    let resolveLate!: (value: string) => void;
    let observedCancellation!: RerankerCancellationV1;
    const { provider, run } = providerReturning((request, cancellation) => {
      observedCancellation = cancellation;
      return new Promise<string>((resolve) => { resolveLate = () => resolve(responseFor(request, [1])); });
    });
    const value = { late: true };
    const pending = executeCalibratedRerankV1(
      { query: 'q', candidates: [candidate(value)] },
      provider,
      { timeoutMs: 25 },
    );
    await vi.advanceTimersByTimeAsync(25);
    const result = await pending;
    const bytes = JSON.stringify(result);
    expect(result.outcome).toBe('baseline');
    expect(observedCancellation.isCancelled()).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    resolveLate('ignored');
    await Promise.resolve();
    expect(JSON.stringify(result)).toBe(bytes);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('arms the deadline before provider invocation and cancels an over-deadline synchronous setup', async () => {
    let observedCancellation!: RerankerCancellationV1;
    const { provider } = providerReturning((request, cancellation) => {
      observedCancellation = cancellation;
      const until = Date.now() + 60;
      while (Date.now() < until) { /* intentional synchronous provider stall */ }
      return Promise.resolve(responseFor(request, [1]));
    });
    const result = await executeCalibratedRerankV1(
      { query: 'q', candidates: [candidate('x')] }, provider, { timeoutMs: 1 },
    );
    expect(result.outcome).toBe('baseline');
    expect(observedCancellation.isCancelled()).toBe(true);
  });

  it('exposes a closed polling-only cancellation record and emits no process errors or callbacks', async () => {
    vi.useFakeTimers();
    const uncaught: unknown[] = [];
    const unhandled: unknown[] = [];
    const onUncaught = (error: unknown) => { uncaught.push(error); };
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.prependListener('uncaughtException', onUncaught);
    process.prependListener('unhandledRejection', onUnhandled);
    let observedCancellation!: RerankerCancellationV1;
    let providerCallbacks = 0;
    try {
      const { provider } = providerReturning((_request, cancellation) => {
        observedCancellation = cancellation;
        const unreachable = () => { providerCallbacks += 1; throw new Error('must never run'); };
        void unreachable;
        return new Promise<string>(() => undefined);
      });
      const pending = executeCalibratedRerankV1(
        { query: 'q', candidates: [candidate('x')] }, provider, { timeoutMs: 5 },
      );
      await vi.advanceTimersByTimeAsync(5);
      await expect(pending).resolves.toMatchObject({ outcome: 'baseline' });
      await Promise.resolve();
      expect(Reflect.ownKeys(observedCancellation)).toEqual(['isCancelled']);
      expect(Object.getPrototypeOf(observedCancellation)).toBeNull();
      expect(Object.isFrozen(observedCancellation)).toBe(true);
      expect(Object.isFrozen(observedCancellation.isCancelled)).toBe(true);
      expect((observedCancellation as unknown as { addEventListener?: unknown }).addEventListener)
        .toBeUndefined();
      expect(observedCancellation.isCancelled()).toBe(true);
      expect(providerCallbacks).toBe(0);
      expect(uncaught).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('uncaughtException', onUncaught);
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  it('cancels through the same baseline path for every post-invocation failure class', async () => {
    const builders: Array<(request: SerializedRerankerProviderRequestV1) => unknown> = [
      () => { throw new Error('sync'); },
      () => Promise.reject(new Error('reject')),
      () => 'not-promise',
      () => Promise.resolve('{'),
    ];
    for (const build of builders) {
      let token!: RerankerCancellationV1;
      const { provider } = providerReturning((request, cancellation) => {
        token = cancellation;
        return build(request);
      });
      await expect(executeCalibratedRerankV1(
        { query: 'q', candidates: [candidate('x')] }, provider,
      )).resolves.toMatchObject({ outcome: 'baseline' });
      expect(token.isCancelled()).toBe(true);
    }
  });

  it('rejects hostile caller graphs before provider execution without invoking hooks', async () => {
    const run = vi.fn(() => Promise.resolve(''));
    const provider = createRerankerProviderV1(IDENTITY, run);
    let hooks = 0;
    const proxy = new Proxy({ query: 'q', candidates: [] }, {
      ownKeys: () => { hooks += 1; return []; },
      get: () => { hooks += 1; return undefined; },
    });
    const accessor = { candidates: [] } as Record<string, unknown>;
    Object.defineProperty(accessor, 'query', {
      enumerable: true,
      get: () => { hooks += 1; return 'q'; },
    });
    const symbolRoot = { query: 'q', candidates: [], [Symbol('hidden')]: true };
    const sparse = new Array(1);
    const duplicate = candidate({});
    for (const input of [
      proxy,
      accessor,
      symbolRoot,
      { query: 'q', candidates: sparse },
      { query: 'q', candidates: [duplicate, duplicate] },
    ]) {
      expect(() => executeCalibratedRerankV1(input, provider)).toThrow(RerankerContractError);
    }
    expect(hooks).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects hostile provider and options roots with zero hooks', () => {
    let hooks = 0;
    const providerProxy = new Proxy({ identity: IDENTITY, run: () => Promise.resolve('') }, {
      ownKeys: () => { hooks += 1; return []; },
      get: () => { hooks += 1; return undefined; },
    });
    const providerAccessor = { run: () => Promise.resolve('') } as Record<string, unknown>;
    Object.defineProperty(providerAccessor, 'identity', {
      enumerable: true,
      get: () => { hooks += 1; return IDENTITY; },
    });
    const optionsProxy = new Proxy({ timeoutMs: 10 }, {
      ownKeys: () => { hooks += 1; return []; },
      get: () => { hooks += 1; return undefined; },
    });
    for (const [provider, options] of [
      [providerProxy, undefined],
      [providerAccessor, undefined],
      [{ identity: IDENTITY, run: () => Promise.resolve(''), [Symbol('x')]: true }, undefined],
      [undefined, optionsProxy],
    ]) {
      expect(() => executeCalibratedRerankV1(
        { query: 'q', candidates: [candidate({})] }, provider, options,
      )).toThrow(RerankerContractError);
    }
    expect(hooks).toBe(0);
  });

  it('rejects thenables and Promise subclasses without touching hostile then hooks', async () => {
    let hooks = 0;
    const thenable = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(thenable, 'then', {
      get: () => { hooks += 1; throw new Error('must not touch'); },
    });
    class HostilePromise<T> extends Promise<T> {}
    const providers = [
      providerReturning(() => thenable).provider,
      providerReturning(() => new HostilePromise<string>(() => undefined)).provider,
    ];
    for (const provider of providers) {
      const result = await executeCalibratedRerankV1(
        { query: 'q', candidates: [candidate({})] }, provider, { timeoutMs: 10 },
      );
      expect(result.outcome).toBe('baseline');
    }
    expect(hooks).toBe(0);
  });

  it('deep-freezes null-prototype public graphs while leaving opaque values untouched', async () => {
    const value = { mutable: true };
    const local = createLocalRerankerProviderV1(IDENTITY, () => 0.8);
    const result = await executeCalibratedRerankV1({ query: 'q', candidates: [candidate(value)] }, local);
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.candidates)).toBe(true);
    expect(Object.getPrototypeOf(result.candidates[0]!)).toBeNull();
    expect(Object.isFrozen(result.candidates[0]!)).toBe(true);
    expect(Object.getPrototypeOf(result.outcome === 'reranked' ? result.provider : {})).toBeNull();
    expect(Object.isFrozen(value)).toBe(false);
  });

  it('survives ambient intrinsic drift after module initialization', async () => {
    const originalParse = JSON.parse;
    const originalStringify = JSON.stringify;
    const originalMap = Array.prototype.map;
    const originalSort = Array.prototype.sort;
    const driftParse = vi.fn((...args: Parameters<typeof JSON.parse>) => originalParse(...args));
    const driftStringify = vi.fn((...args: Parameters<typeof JSON.stringify>) => originalStringify(...args));
    const driftMap = vi.fn(function<T, U>(this: T[], callback: (value: T, index: number, array: T[]) => U) {
      return originalMap.call(this, callback);
    });
    const driftSort = vi.fn(function<T>(this: T[], compare?: (left: T, right: T) => number) {
      return originalSort.call(this, compare);
    });
    const { provider } = providerReturning((request) => {
      const parsed = originalParse(request) as { requestDigest: string; candidateCount: number; candidates: Array<{ key: string }> };
      const response = originalStringify({
        contractId: RERANKER_CONTRACT_ID,
        contractVersion: RERANKER_CONTRACT_VERSION,
        requestDigest: parsed.requestDigest,
        providerId: IDENTITY.providerId,
        modelId: IDENTITY.modelId,
        calibrationId: IDENTITY.calibrationId,
        candidateCount: parsed.candidateCount,
        scores: originalMap.call(parsed.candidates, (item: { key: string }) => ({ key: item.key, calibratedScore: 0.6 })),
      });
      JSON.parse = driftParse as typeof JSON.parse;
      JSON.stringify = driftStringify as typeof JSON.stringify;
      Array.prototype.map = driftMap as typeof Array.prototype.map;
      Array.prototype.sort = driftSort as typeof Array.prototype.sort;
      return Promise.resolve(response);
    });
    try {
      const result = await executeCalibratedRerankV1({ query: 'q', candidates: [candidate({})] }, provider);
      expect(result.outcome).toBe('reranked');
      expect(driftParse).not.toHaveBeenCalled();
      expect(driftStringify).not.toHaveBeenCalled();
      expect(driftMap).not.toHaveBeenCalled();
      expect(driftSort).not.toHaveBeenCalled();
    } finally {
      JSON.parse = originalParse;
      JSON.stringify = originalStringify;
      Array.prototype.map = originalMap;
      Array.prototype.sort = originalSort;
    }
  });

  it('keeps digests distinct when Hash prototype methods drift after import', async () => {
    const prototype = Object.getPrototypeOf(createHash('sha256')) as Record<string, unknown>;
    const updateDescriptor = Object.getOwnPropertyDescriptor(prototype, 'update')!;
    const digestDescriptor = Object.getOwnPropertyDescriptor(prototype, 'digest')!;
    let hooks = 0;
    const payloads: string[] = [];
    const { provider } = providerReturning((request) => {
      payloads.push(request);
      return Promise.resolve(manualResponseFor(request, [0.5]));
    });
    Object.defineProperty(prototype, 'update', {
      ...updateDescriptor,
      value: () => { hooks += 1; throw new Error('ambient hash update drift'); },
    });
    Object.defineProperty(prototype, 'digest', {
      ...digestDescriptor,
      value: () => { hooks += 1; throw new Error('ambient hash digest drift'); },
    });
    try {
      await executeCalibratedRerankV1({ query: 'alpha', candidates: [candidate('x')] }, provider);
      await executeCalibratedRerankV1({ query: 'omega', candidates: [candidate('x')] }, provider);
    } finally {
      Object.defineProperty(prototype, 'update', updateDescriptor);
      Object.defineProperty(prototype, 'digest', digestDescriptor);
    }
    expect(hooks).toBe(0);
    expect((JSON.parse(payloads[0]!) as { requestDigest: string }).requestDigest)
      .not.toBe((JSON.parse(payloads[1]!) as { requestDigest: string }).requestDigest);
  });

  it('never invokes inherited Object or Array toJSON hooks during canonical serialization', async () => {
    const objectDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
    const arrayDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
    let hooks = 0;
    const hostile = () => { hooks += 1; throw new Error('ambient toJSON hook'); };
    const { provider } = providerReturning(
      (request) => Promise.resolve(manualResponseFor(request, [0.5])),
    );
    Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, value: hostile });
    Object.defineProperty(Array.prototype, 'toJSON', { configurable: true, value: hostile });
    try {
      const result = await executeCalibratedRerankV1(
        { query: 'q', candidates: [candidate('x')] }, provider,
      );
      expect(result.outcome).toBe('reranked');
    } finally {
      if (objectDescriptor === undefined) delete (Object.prototype as { toJSON?: unknown }).toJSON;
      else Object.defineProperty(Object.prototype, 'toJSON', objectDescriptor);
      if (arrayDescriptor === undefined) delete (Array.prototype as { toJSON?: unknown }).toJSON;
      else Object.defineProperty(Array.prototype, 'toJSON', arrayDescriptor);
    }
    expect(hooks).toBe(0);
  });
});

describe('memberry.reranker v1 exact boundaries', () => {
  it('accepts the 2-second hard deadline and rejects the next millisecond before provider execution', async () => {
    const { provider, run } = providerReturning(
      (request) => Promise.resolve(responseFor(request, [0.5])),
    );
    await expect(executeCalibratedRerankV1(
      { query: 'q', candidates: [candidate('x')] }, provider, { timeoutMs: 2_000 },
    )).resolves.toMatchObject({ outcome: 'reranked' });
    const calls = run.mock.calls.length;
    expect(() => executeCalibratedRerankV1(
      { query: 'q', candidates: [candidate('x')] }, provider, { timeoutMs: 2_001 },
    )).toThrow(/invalid-options/);
    expect(run).toHaveBeenCalledTimes(calls);
  });

  it('accepts N and exact byte maxima, then rejects N+1 before provider execution', async () => {
    const { provider, run } = providerReturning((request) => {
      const count = (JSON.parse(request) as { candidateCount: number }).candidateCount;
      return Promise.resolve(responseFor(request, Array.from({ length: count }, () => 0.5)));
    });
    const maxCount = Array.from({ length: RERANKER_MAX_CANDIDATES }, (_, index) => candidate(index));
    await expect(executeCalibratedRerankV1({ query: 'q', candidates: maxCount }, provider))
      .resolves.toMatchObject({ outcome: 'reranked' });
    const callsAtN = run.mock.calls.length;
    expect(() => executeCalibratedRerankV1({
      query: 'q', candidates: [...maxCount, candidate(129)],
    }, provider)).toThrow(/request-too-large/);
    expect(run).toHaveBeenCalledTimes(callsAtN);

    await expect(executeCalibratedRerankV1({
      query: 'q'.repeat(RERANKER_MAX_QUERY_BYTES), candidates: [candidate(1)],
    }, provider)).resolves.toMatchObject({ outcome: 'reranked' });
    expect(() => executeCalibratedRerankV1({
      query: 'q'.repeat(RERANKER_MAX_QUERY_BYTES + 1), candidates: [candidate(1)],
    }, provider)).toThrow(/request-too-large/);

    await expect(executeCalibratedRerankV1({
      query: '', candidates: [candidate(1, { content: 'x'.repeat(RERANKER_MAX_STRING_BYTES) })],
    }, provider)).resolves.toMatchObject({ outcome: 'reranked' });
    expect(() => executeCalibratedRerankV1({
      query: '', candidates: [candidate(1, { content: 'x'.repeat(RERANKER_MAX_STRING_BYTES + 1) })],
    }, provider)).toThrow(/request-too-large/);
  });

  it('enforces the exact aggregate N/N+1 UTF-8 byte boundary', async () => {
    const count = 64;
    const sourceBytes = count * Buffer.byteLength('semantic');
    const exactContentBytes = RERANKER_MAX_AGGREGATE_STRING_BYTES - sourceBytes;
    const contents = Array.from({ length: count }, (_, index) => (
      index < count - 1
        ? 'x'.repeat(RERANKER_MAX_STRING_BYTES)
        : 'x'.repeat(exactContentBytes - ((count - 1) * RERANKER_MAX_STRING_BYTES))
    ));
    const { provider } = providerReturning((request) => Promise.resolve(
      responseFor(request, Array.from({ length: count }, () => 0.5)),
    ));
    await expect(executeCalibratedRerankV1({
      query: '',
      candidates: contents.map((content, index) => candidate(index, { title: '', content })),
    }, provider, { timeoutMs: RERANKER_MAX_TIMEOUT_MS })).resolves.toMatchObject({ outcome: 'reranked' });
    contents[count - 1] += 'x';
    expect(() => executeCalibratedRerankV1({
      query: '',
      candidates: contents.map((content, index) => candidate(index, { title: '', content })),
    }, provider)).toThrow(/request-too-large/);
  });

  it('handles real response bodies at the exact 64-KiB N/N+1 transport boundary', async () => {
    for (const bytes of [RERANKER_MAX_RESPONSE_BYTES, RERANKER_MAX_RESPONSE_BYTES + 1]) {
      let observedBytes = 0;
      const transport: RerankerHttpsTransportV1 = vi.fn(() => {
        const body = 'x'.repeat(bytes);
        observedBytes = Buffer.byteLength(body);
        return Promise.resolve({ statusCode: 200, body });
      });
      const provider = createHttpsRerankerProviderV1({
        identity: REMOTE_IDENTITY,
        endpoint: 'https://reranker.example/v1/score',
        transport,
      });
      await expect(executeCalibratedRerankV1(
        { query: 'q', candidates: [candidate('value')] }, provider,
      )).resolves.toMatchObject({ outcome: 'baseline' });
      expect(observedBytes).toBe(bytes);
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects oversized malformed strings before Unicode scanning at every reranker boundary', async () => {
    const originalCharCodeAt = String.prototype.charCodeAt;
    let target = '';
    let targetScans = 0;
    String.prototype.charCodeAt = function countedCharCodeAt(this: string, index: number): number {
      if (this === target) targetScans += 1;
      return originalCharCodeAt.call(this, index);
    };
    vi.resetModules();
    let dynamicContract: typeof import('../reranker.js');
    try {
      dynamicContract = await import('../reranker.js');
    } finally {
      String.prototype.charCodeAt = originalCharCodeAt;
    }

    const oversizedMalformed = (maxBytes: number): string => `${'a'.repeat(maxBytes + 1)}\ud800`;
    const expectRequestBudgetWithoutScan = (run: () => unknown): void => {
      targetScans = 0;
      expect(run).toThrow(/request-too-large/);
      expect(targetScans).toBe(0);
    };

    try {
      for (const field of ['providerId', 'modelId', 'calibrationId'] as const) {
        target = oversizedMalformed(128);
        targetScans = 0;
        expect(() => dynamicContract.createRerankerProviderV1({
          providerId: field === 'providerId' ? target : 'provider-a',
          modelId: field === 'modelId' ? target : 'model-a',
          calibrationId: field === 'calibrationId' ? target : 'calibration-a',
          locality: 'local',
        }, () => Promise.reject(new Error('must not run')))).toThrow(/invalid-provider/);
        expect(targetScans).toBe(0);
      }

      const provider = dynamicContract.createRerankerProviderV1(IDENTITY, () => (
        Promise.reject(new Error('must not run'))
      ));
      target = `a\ud800`;
      targetScans = 0;
      expect(() => dynamicContract.executeCalibratedRerankV1(
        { query: target, candidates: [candidate('x')] },
        provider,
      )).toThrow(/invalid-request/);
      expect(targetScans).toBeGreaterThan(0);

      const requestCases: Array<{ maxBytes: number; input: (value: string) => unknown }> = [
        {
          maxBytes: dynamicContract.RERANKER_MAX_QUERY_BYTES,
          input: (value) => ({ query: value, candidates: [candidate('x')] }),
        },
        {
          maxBytes: dynamicContract.RERANKER_MAX_STRING_BYTES,
          input: (value) => ({ query: 'q', candidates: [candidate('x', { title: value })] }),
        },
        {
          maxBytes: dynamicContract.RERANKER_MAX_STRING_BYTES,
          input: (value) => ({ query: 'q', candidates: [candidate('x', { content: value })] }),
        },
      ];
      for (const entry of requestCases) {
        target = oversizedMalformed(entry.maxBytes);
        expectRequestBudgetWithoutScan(() => dynamicContract.executeCalibratedRerankV1(
          entry.input(target) as never,
          provider,
        ));
      }

      const maxSerializedBytes = (dynamicContract.RERANKER_MAX_AGGREGATE_STRING_BYTES * 6)
        + (dynamicContract.RERANKER_MAX_CANDIDATES * 256);
      target = oversizedMalformed(maxSerializedBytes);
      targetScans = 0;
      expect(() => dynamicContract.parseSerializedRerankerProviderRequestV1(target)).toThrow(
        /invalid-reranker-request/,
      );
      expect(targetScans).toBe(0);

      target = oversizedMalformed(dynamicContract.RERANKER_MAX_RESPONSE_BYTES);
      targetScans = 0;
      const responseProvider = dynamicContract.createRerankerProviderV1(
        IDENTITY,
        () => Promise.resolve(target as SerializedRerankerProviderRequestV1),
      );
      await expect(dynamicContract.executeCalibratedRerankV1(
        { query: 'q', candidates: [candidate('x')] },
        responseProvider,
      )).resolves.toMatchObject({ outcome: 'baseline' });
      expect(targetScans).toBe(0);
    } finally {
      vi.resetModules();
    }
  });
});

describe('memberry.reranker v1 providers', () => {
  it('rejects oversized provider strings before UTF-8 byte scanning', async () => {
    const originalByteLength = Buffer.byteLength;
    let target = '';
    let targetScans = 0;
    Buffer.byteLength = ((
      input: Parameters<typeof Buffer.byteLength>[0],
      encoding?: BufferEncoding,
    ): number => {
      if (input === target) targetScans += 1;
      return originalByteLength(input, encoding);
    }) as typeof Buffer.byteLength;
    vi.resetModules();
    let dynamicContract: typeof import('../reranker.js');
    let dynamicProviders: typeof import('../reranker-providers.js');
    try {
      dynamicContract = await import('../reranker.js');
      dynamicProviders = await import('../reranker-providers.js');
    } finally {
      Buffer.byteLength = originalByteLength;
    }

    const transport: RerankerHttpsTransportV1 = () => Promise.reject(new Error('must not run'));
    const oversizedMalformed = (maxBytes: number): string => `${'a'.repeat(maxBytes + 1)}\ud800`;

    try {
      target = 'https://reranker.example/v1/score';
      targetScans = 0;
      dynamicProviders.createHttpsRerankerProviderV1({
        identity: REMOTE_IDENTITY,
        endpoint: target,
        transport,
      });
      expect(targetScans).toBeGreaterThan(0);

      target = `https://reranker.example/${oversizedMalformed(65_536)}`;
      targetScans = 0;
      expect(() => dynamicProviders.createHttpsRerankerProviderV1({
        identity: REMOTE_IDENTITY,
        endpoint: target,
        transport,
      })).toThrow(/invalid-reranker-endpoint/);
      expect(targetScans).toBe(0);

      target = 'Bearer explicit-only';
      targetScans = 0;
      dynamicProviders.createHttpsRerankerProviderV1({
        identity: REMOTE_IDENTITY,
        endpoint: 'https://reranker.example/v1/score',
        authorizationHeader: target,
        transport,
      });
      expect(targetScans).toBeGreaterThan(0);

      target = oversizedMalformed(8_192);
      targetScans = 0;
      expect(() => dynamicProviders.createHttpsRerankerProviderV1({
        identity: REMOTE_IDENTITY,
        endpoint: 'https://reranker.example/v1/score',
        authorizationHeader: target,
        transport,
      })).toThrow(/invalid-reranker-authorization/);
      expect(targetScans).toBe(0);

      const directTransport: RerankerHttpsTransportV1 = vi.fn(() => (
        Promise.reject(new Error('expected direct-run failure'))
      ));
      const directProvider = dynamicProviders.createHttpsRerankerProviderV1({
        identity: REMOTE_IDENTITY,
        endpoint: 'https://reranker.example/v1/score',
        transport: directTransport,
      });
      const cancellation: RerankerCancellationV1 = { isCancelled: () => false };
      let canonicalBody: SerializedRerankerProviderRequestV1 | undefined;
      const captureProvider = dynamicContract.createRerankerProviderV1(IDENTITY, (body) => {
        canonicalBody = body;
        return Promise.reject(new Error('capture only'));
      });
      await expect(dynamicContract.executeCalibratedRerankV1(
        { query: 'q', candidates: [candidate('x')] },
        captureProvider,
      )).resolves.toMatchObject({ outcome: 'baseline' });
      expect(canonicalBody).toBeDefined();

      target = canonicalBody!;
      targetScans = 0;
      await expect(directProvider.run(
        canonicalBody!,
        cancellation,
      )).rejects.toThrow(/https-reranker-failed/);
      expect(targetScans).toBeGreaterThan(0);
      const directCalls = vi.mocked(directTransport).mock.calls.length;

      const maxSerializedBytes = (dynamicContract.RERANKER_MAX_AGGREGATE_STRING_BYTES * 6)
        + (dynamicContract.RERANKER_MAX_CANDIDATES * 256);
      target = oversizedMalformed(maxSerializedBytes);
      targetScans = 0;
      await expect(directProvider.run(
        target as SerializedRerankerProviderRequestV1,
        cancellation,
      )).rejects.toThrow(/https-reranker-failed/);
      expect(targetScans).toBe(0);
      expect(directTransport).toHaveBeenCalledTimes(directCalls);

      target = canonicalBody!;
      targetScans = 0;
      await expect(directProvider.run(
        canonicalBody!,
        { isCancelled: () => true },
      )).rejects.toThrow(/https-reranker-failed/);
      expect(targetScans).toBe(0);
      expect(directTransport).toHaveBeenCalledTimes(directCalls);

      let responseTargetScans = 0;
      const responseProvider = dynamicProviders.createHttpsRerankerProviderV1({
        identity: REMOTE_IDENTITY,
        endpoint: 'https://reranker.example/v1/score',
        transport: (request: Parameters<RerankerHttpsTransportV1>[0]) => {
          target = responseFor(
            request.body as SerializedRerankerProviderRequestV1,
            [0.5],
            REMOTE_IDENTITY,
          );
          targetScans = 0;
          return Promise.resolve({ statusCode: 200, body: target });
        },
      });
      await expect(dynamicContract.executeCalibratedRerankV1(
        { query: 'q', candidates: [candidate('x')] },
        responseProvider,
      )).resolves.toMatchObject({ outcome: 'reranked' });
      responseTargetScans = targetScans;
      expect(responseTargetScans).toBeGreaterThan(0);

      target = oversizedMalformed(dynamicContract.RERANKER_MAX_RESPONSE_BYTES);
      targetScans = 0;
      const oversizedResponseProvider = dynamicProviders.createHttpsRerankerProviderV1({
        identity: REMOTE_IDENTITY,
        endpoint: 'https://reranker.example/v1/score',
        transport: () => Promise.resolve({ statusCode: 200, body: target }),
      });
      await expect(dynamicContract.executeCalibratedRerankV1(
        { query: 'q', candidates: [candidate('x')] },
        oversizedResponseProvider,
      )).resolves.toMatchObject({ outcome: 'baseline' });
      expect(targetScans).toBe(0);
    } finally {
      vi.resetModules();
    }
  });

  it('runs the trusted local primitive scorer synchronously and canonicalizes before returning', async () => {
    const calls: Array<{ query: string; key: string }> = [];
    const provider = createLocalRerankerProviderV1(IDENTITY, (query, item) => {
      calls.push({ query, key: item.key });
      expect(Object.getPrototypeOf(item)).toBeNull();
      expect(Object.isFrozen(item)).toBe(true);
      return item.key === 'r0000' ? 0.2 : 0.9;
    });
    const direct = provider.run as (
      request: SerializedRerankerProviderRequestV1,
      cancellation: RerankerCancellationV1,
    ) => Promise<string>;
    const result = await executeCalibratedRerankV1({
      query: 'local', candidates: [candidate('a'), candidate('b')],
    }, provider);
    expect(result.candidates.map((item) => item.value)).toEqual(['b', 'a']);
    expect(calls).toEqual([{ query: 'local', key: 'r0000' }, { query: 'local', key: 'r0001' }]);
    expect(typeof direct).toBe('function');
    const hostile = createLocalRerankerProviderV1(IDENTITY, () => new Number(0.5) as unknown as number);
    await expect(executeCalibratedRerankV1({ query: 'q', candidates: [candidate('a')] }, hostile))
      .resolves.toMatchObject({ outcome: 'baseline' });
  });

  it('provides a truthful baseline-identity reference scorer without learned-quality claims', async () => {
    const provider = createLocalRerankerProviderV1(IDENTITY, baselineIdentityRerankerScoreV1);
    const result = await executeCalibratedRerankV1({
      query: 'q',
      candidates: [candidate('a', { baselineScore: 0.2 }), candidate('b', { baselineScore: 0.8 })],
    }, provider);
    expect(result.candidates.map((item) => [item.value, item.score])).toEqual([['b', 0.8], ['a', 0.2]]);
  });

  it('enforces the exact safe 128-byte provider identity boundary and response feasibility', async () => {
    const maxIdentity = Object.freeze({
      providerId: 'p'.repeat(128),
      modelId: 'm'.repeat(128),
      calibrationId: 'c'.repeat(128),
      locality: 'local' as const,
    });
    const provider = createLocalRerankerProviderV1(maxIdentity, () => 0.5);
    await expect(executeCalibratedRerankV1(
      { query: 'q', candidates: [candidate('x')] }, provider,
    )).resolves.toMatchObject({ outcome: 'reranked' });
    for (const invalid of [
      { ...IDENTITY, providerId: 'p'.repeat(129) },
      { ...IDENTITY, modelId: 'model with spaces' },
      { ...IDENTITY, calibrationId: 'calibration?unsafe' },
    ]) {
      expect(() => createLocalRerankerProviderV1(invalid, () => 0.5)).toThrow();
    }
  });

  it('uses captured URL accessors once and gives transport an immutable canonical HTTPS string', async () => {
    const names = ['protocol', 'username', 'password', 'hash', 'href'] as const;
    const descriptors = new Map(names.map((name) => [
      name, Object.getOwnPropertyDescriptor(URL.prototype, name)!,
    ]));
    let hooks = 0;
    let observedUrl = '';
    const transport: RerankerHttpsTransportV1 = vi.fn((request) => {
      observedUrl = request.url;
      return Promise.resolve({
        statusCode: 200,
        body: manualResponseFor(request.body, [0.5], REMOTE_IDENTITY),
      });
    });
    for (const name of names) {
      const descriptor = descriptors.get(name)!;
      Object.defineProperty(URL.prototype, name, {
        ...descriptor,
        get: () => { hooks += 1; throw new Error(`ambient URL ${name} drift`); },
      });
    }
    try {
      const provider = createHttpsRerankerProviderV1({
        identity: REMOTE_IDENTITY,
        endpoint: 'https://reranker.example/v1/score',
        transport,
      });
      await expect(executeCalibratedRerankV1(
        { query: 'q', candidates: [candidate('x')] }, provider,
      )).resolves.toMatchObject({ outcome: 'reranked' });
    } finally {
      for (const name of names) Object.defineProperty(URL.prototype, name, descriptors.get(name)!);
    }
    expect(hooks).toBe(0);
    expect(observedUrl).toBe('https://reranker.example/v1/score');
  });

  it('rejects empty-fragment endpoint aliases while preserving an encoded fragment octet', async () => {
    for (const endpoint of [
      'https://reranker.example/v1/score#',
      'https://reranker.example/v1/score?#',
    ]) {
      expect(() => createHttpsRerankerProviderV1({
        identity: REMOTE_IDENTITY,
        endpoint,
        transport: () => Promise.reject(new Error('must not run')),
      })).toThrow(/invalid-reranker-endpoint/);
    }
    let observedUrl = '';
    const provider = createHttpsRerankerProviderV1({
      identity: REMOTE_IDENTITY,
      endpoint: 'https://reranker.example/v1/score%23',
      transport: (request: Parameters<RerankerHttpsTransportV1>[0]) => {
        observedUrl = request.url;
        return Promise.resolve({
          statusCode: 200,
          body: manualResponseFor(
            request.body as SerializedRerankerProviderRequestV1,
            [0.5],
            REMOTE_IDENTITY,
          ),
        });
      },
    });
    await expect(executeCalibratedRerankV1(
      { query: 'q', candidates: [candidate('x')] }, provider,
    )).resolves.toMatchObject({ outcome: 'reranked' });
    expect(observedUrl).toBe('https://reranker.example/v1/score%23');
  });

  it('tears down the private native request when setup throws after request creation', async () => {
    vi.useFakeTimers();
    let destroyCalls = 0;
    let active = true;
    let privateSignal: AbortSignal | undefined;
    let observedNativeUrl = '';
    const requestStub = vi.fn((url: string, options: { signal?: AbortSignal }) => {
      observedNativeUrl = url;
      privateSignal = options.signal;
      const request = {
        on: vi.fn(() => request),
        end: vi.fn(() => { throw new Error('native end setup failure'); }),
        destroy: vi.fn(() => {
          destroyCalls += 1;
          active = false;
        }),
      };
      return request;
    });
    vi.resetModules();
    vi.doMock('node:https', () => ({ request: requestStub }));
    try {
      const dynamicProviders = await import('../reranker-providers.js');
      const provider = dynamicProviders.createHttpsRerankerProviderV1({
        identity: REMOTE_IDENTITY,
        endpoint: 'https://reranker.example/v1/score',
      });
      await expect(executeCalibratedRerankV1(
        { query: 'q', candidates: [candidate('x')] }, provider,
      )).resolves.toMatchObject({ outcome: 'baseline' });
      await vi.runAllTimersAsync();
      expect(observedNativeUrl).toBe('https://reranker.example/v1/score');
      expect(privateSignal?.aborted).toBe(true);
      expect(destroyCalls).toBe(1);
      expect(active).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.doUnmock('node:https');
      vi.resetModules();
    }
  });

  it('posts only explicit safe headers, accepts remote score reorder, and sends no ambient credentials', async () => {
    let observed: Parameters<RerankerHttpsTransportV1>[0] | undefined;
    const transport: RerankerHttpsTransportV1 = vi.fn((request) => {
      observed = request;
      const parsed = JSON.parse(request.body) as {
        requestDigest: string; candidateCount: number; candidates: Array<{ key: string }>;
      };
      return Promise.resolve({
        statusCode: 200,
        body: JSON.stringify({
          contractId: RERANKER_CONTRACT_ID,
          contractVersion: RERANKER_CONTRACT_VERSION,
          requestDigest: parsed.requestDigest,
          providerId: REMOTE_IDENTITY.providerId,
          modelId: REMOTE_IDENTITY.modelId,
          calibrationId: REMOTE_IDENTITY.calibrationId,
          candidateCount: parsed.candidateCount,
          scores: [
            { key: parsed.candidates[1]!.key, calibratedScore: 0.9 },
            { key: parsed.candidates[0]!.key, calibratedScore: 0.1 },
          ],
        }),
      });
    });
    const provider = createHttpsRerankerProviderV1({
      identity: REMOTE_IDENTITY,
      endpoint: 'https://reranker.example/v1/score',
      authorizationHeader: 'Bearer explicit-only',
      transport,
    });
    const secret = { tenantId: 'tenant-secret', credentials: 'ambient-secret' };
    const result = await executeCalibratedRerankV1({
      query: 'remote', candidates: [candidate(secret), candidate('safe')],
    }, provider);
    expect(result.candidates.map((item) => item.value)).toEqual(['safe', secret]);
    expect(observed?.method).toBe('POST');
    expect(observed?.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      'content-length': `${Buffer.byteLength(observed!.body)}`,
      authorization: 'Bearer explicit-only',
    });
    expect(Object.keys(observed!.headers)).not.toContain('cookie');
    expect(Object.keys(observed!.headers)).not.toContain('referer');
    expect(observed!.body).not.toContain('tenant-secret');
    expect(observed!.body).not.toContain('ambient-secret');
  });

  it('maps non-2xx, redirects, disconnects, oversize and hostile transport boundaries to one baseline with no retry', async () => {
    const cases: Array<(body: string) => unknown> = [
      () => ({ statusCode: 500, body: '' }),
      () => ({ statusCode: 302, body: '' }),
      () => Promise.reject(new Error('disconnect')),
      () => ({ statusCode: 200, body: 'x'.repeat(RERANKER_MAX_RESPONSE_BYTES + 1) }),
      () => ({ statusCode: 200, body: '{' }),
      () => ({ statusCode: 200, body: '', extra: true }),
      () => ({ statusCode: 200, get body() { throw new Error('accessor'); } }),
    ];
    for (const make of cases) {
      const transport = vi.fn((request: Parameters<RerankerHttpsTransportV1>[0]) => {
        const value = make(request.body);
        return nodeUtilTypes.isPromise(value) ? value : Promise.resolve(value);
      }) as unknown as RerankerHttpsTransportV1;
      const provider = createHttpsRerankerProviderV1({
        identity: REMOTE_IDENTITY,
        endpoint: 'https://reranker.example/v1/score',
        transport,
      });
      const result = await executeCalibratedRerankV1({ query: 'q', candidates: [candidate('x')] }, provider);
      expect(result.outcome).toBe('baseline');
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects hostile transport thenables and Promise subclasses without invoking then hooks', async () => {
    let hooks = 0;
    const thenable = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(thenable, 'then', {
      get: () => { hooks += 1; throw new Error('must not touch'); },
    });
    class ForeignPromise<T> extends Promise<T> {}
    for (const returned of [thenable, new ForeignPromise(() => undefined)]) {
      const transport = (() => returned) as unknown as RerankerHttpsTransportV1;
      const provider = createHttpsRerankerProviderV1({
        identity: REMOTE_IDENTITY,
        endpoint: 'https://reranker.example/v1/score',
        transport,
      });
      await expect(executeCalibratedRerankV1(
        { query: 'q', candidates: [candidate('x')] }, provider, { timeoutMs: 10 },
      )).resolves.toMatchObject({ outcome: 'baseline' });
    }
    expect(hooks).toBe(0);
  });
});
