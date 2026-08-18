import { describe, expect, it, vi } from 'vitest';
import { computeQueryStats, inferSourceTypeBoost } from '../index.js';
import { UnifiedAssembler } from '../assembler.js';
import { DeterministicAssembler } from '../deterministic.js';
import { expandQuery } from '../expand.js';
import { FeedbackTracker } from '../feedback.js';
import { classifyIntent } from '../intent.js';
import { DeterministicRuntimeTraceAdapter, RankedRuntimeTraceAdapter } from '../runtime-trace.js';
import type { UnifiedContext } from '../types.js';

const LIMIT = 5_000;
const TOO_LARGE = 'query_input_too_large';
const INVALID = 'query_input_invalid';
const FEEDBACK_INVALID = 'feedback_input_invalid';

function hostileValue(): { value: unknown; reads: () => number } {
  let count = 0;
  return {
    value: new Proxy(Object.create(null) as object, {
      get() {
        count += 1;
        throw new Error('hostile_query_was_touched');
      },
      getOwnPropertyDescriptor() {
        count += 1;
        throw new Error('hostile_query_was_touched');
      },
    }),
    reads: () => count,
  };
}

function hostileOptions(): { value: object; reads: () => number } {
  let count = 0;
  const value = {
    get strategy() {
      count += 1;
      return 'ranked' as const;
    },
    include_code: false,
    include_arch: false,
    include_memory: false,
  };
  return { value, reads: () => count };
}

function dependencies(llmAvailable = true) {
  const run = vi.fn(async () => ({ records: [] }));
  const close = vi.fn(async () => undefined);
  const session = vi.fn(() => ({ run, close }));
  const redis = {
    zincrby: vi.fn(async () => 0),
    zrevrangeWithScores: vi.fn(async () => []),
    lpush: vi.fn(async () => 0),
    ltrim: vi.fn(async () => undefined),
  };
  const codeSearch = vi.fn(async () => []);
  const memoryLoad = vi.fn(async () => ({ markdown: '', tokens: 0, sources: [] }));
  const embed = vi.fn(async () => [1]);
  const embedBatch = vi.fn(async () => []);
  const chat = vi.fn(async () => JSON.stringify({ answer: 'ok', cited: [] }));
  const assembler = new UnifiedAssembler(
    { session } as never,
    redis,
    { search: codeSearch },
    { load: memoryLoad },
    { available: true, embed, embedBatch },
    { available: llmAvailable, chat, modelFor: vi.fn(() => 'test') } as never,
  );
  return {
    assembler,
    probes: { session, run, close, codeSearch, memoryLoad, embed, embedBatch, chat, redis },
  };
}

function expectNoProviderWork(probes: ReturnType<typeof dependencies>['probes']): void {
  expect(probes.session).not.toHaveBeenCalled();
  expect(probes.run).not.toHaveBeenCalled();
  expect(probes.codeSearch).not.toHaveBeenCalled();
  expect(probes.memoryLoad).not.toHaveBeenCalled();
  expect(probes.embed).not.toHaveBeenCalled();
  expect(probes.embedBatch).not.toHaveBeenCalled();
  expect(probes.chat).not.toHaveBeenCalled();
  expect(probes.redis.zrevrangeWithScores).not.toHaveBeenCalled();
}

function clearProviderProbes(probes: ReturnType<typeof dependencies>['probes']): void {
  for (const probe of [
    probes.session, probes.run, probes.close, probes.codeSearch, probes.memoryLoad,
    probes.embed, probes.embedBatch, probes.chat, probes.redis.zincrby,
    probes.redis.zrevrangeWithScores, probes.redis.lpush, probes.redis.ltrim,
  ]) probe.mockClear();
}

function candidateExecution() {
  let settlementReads = 0;
  let candidateReads = 0;
  const execution = {
    contractId: 'memberry.candidate-channel',
    contractVersion: '1.0.0',
    request: {
      plannedChannels: [],
      tenantId: 'default',
      resolvedEntityIds: [],
      temporalFrame: { mode: 'current' },
    },
    get settlements() {
      settlementReads += 1;
      return [];
    },
    get candidates() {
      candidateReads += 1;
      return [];
    },
  };
  return {
    execution,
    reads: () => ({ settlements: settlementReads, candidates: candidateReads }),
  };
}

function hostileExecution(): { value: unknown; reads: () => number } {
  let count = 0;
  return {
    value: new Proxy(Object.create(null) as object, {
      get() {
        count += 1;
        throw new Error('candidate_execution_was_touched');
      },
    }),
    reads: () => count,
  };
}

describe('retrieval query input boundary', () => {
  it('classifyIntent rejects non-strings without coercion', async () => {
    const hostile = hostileValue();
    await expect(classifyIntent(hostile.value as never)).rejects.toThrowError(INVALID);
    expect(hostile.reads()).toBe(0);
  });

  it('classifyIntent returns the established oversized fallback before scans or providers', async () => {
    const embedding = {
      available: true,
      embed: vi.fn(async () => [1]),
      embedBatch: vi.fn(async () => []),
    };
    const queryThunk = vi.fn(async () => [1]);
    const trimSpy = vi.spyOn(String.prototype, 'trim');
    const splitSpy = vi.spyOn(String.prototype, 'split');
    const regexSpy = vi.spyOn(RegExp.prototype, 'test');

    await classifyIntent('ordinary ambiguous retrieval question', embedding, queryThunk);
    const positive = {
      trim: trimSpy.mock.calls.length,
      split: splitSpy.mock.calls.length,
      regex: regexSpy.mock.calls.length,
      batches: embedding.embedBatch.mock.calls.length,
      thunk: queryThunk.mock.calls.length,
    };
    trimSpy.mockClear();
    splitSpy.mockClear();
    regexSpy.mockClear();
    embedding.embed.mockClear();
    embedding.embedBatch.mockClear();
    queryThunk.mockClear();

    const result = await classifyIntent('x'.repeat(LIMIT + 1), embedding, queryThunk);
    const oversized = {
      trim: trimSpy.mock.calls.length,
      split: splitSpy.mock.calls.length,
      regex: regexSpy.mock.calls.length,
      embed: embedding.embed.mock.calls.length,
      batches: embedding.embedBatch.mock.calls.length,
      thunk: queryThunk.mock.calls.length,
    };
    vi.restoreAllMocks();

    expect(positive.trim).toBeGreaterThan(0);
    expect(positive.split).toBeGreaterThan(0);
    expect(positive.regex).toBeGreaterThan(0);
    expect(positive.batches).toBeGreaterThan(0);
    expect(positive.thunk).toBeGreaterThan(0);
    expect(result).toEqual({ intent: 'HYBRID', confidence: 0.4, method: 'fallback' });
    expect(oversized).toEqual({ trim: 0, split: 0, regex: 0, embed: 0, batches: 0, thunk: 0 });
  });

  it('expandQuery rejects invalid and oversized values before string scans', () => {
    const hostile = hostileValue();
    expect(() => expandQuery(hostile.value as never)).toThrowError(INVALID);
    expect(hostile.reads()).toBe(0);

    const lowerSpy = vi.spyOn(String.prototype, 'toLowerCase');
    const splitSpy = vi.spyOn(String.prototype, 'split');
    const includesSpy = vi.spyOn(String.prototype, 'includes');
    const replaceSpy = vi.spyOn(String.prototype, 'replace');
    const regexSpy = vi.spyOn(RegExp.prototype, 'exec');

    expandQuery('find the error handling strategy');
    const positive = [lowerSpy, splitSpy, includesSpy, replaceSpy, regexSpy]
      .map((spy) => spy.mock.calls.length);
    for (const spy of [lowerSpy, splitSpy, includesSpy, replaceSpy, regexSpy]) spy.mockClear();

    let thrown: unknown;
    try {
      expandQuery('x'.repeat(LIMIT + 1));
    } catch (error) {
      thrown = error;
    }
    const oversized = [lowerSpy, splitSpy, includesSpy, replaceSpy, regexSpy]
      .map((spy) => spy.mock.calls.length);
    vi.restoreAllMocks();

    expect(positive.every((count) => count > 0)).toBe(true);
    expect(thrown).toEqual(new Error(TOO_LARGE));
    expect(oversized).toEqual([0, 0, 0, 0, 0]);
  });

  it('uses JS code units at the exact 5000/5001 boundary, including hostile Unicode', async () => {
    const exactAstral = '\u{1F600}'.repeat(LIMIT / 2);
    expect(exactAstral.length).toBe(LIMIT);
    await expect(classifyIntent(exactAstral)).resolves.toBeDefined();
    expect(() => expandQuery(exactAstral, 'IDENTIFIER')).not.toThrow();

    for (const oversized of [
      'x'.repeat(LIMIT + 1),
      '\uD800'.repeat(LIMIT + 1),
      '\uFF2D'.repeat(LIMIT + 1),
      '\u{1F600}'.repeat((LIMIT / 2) + 1),
    ]) {
      expect(() => expandQuery(oversized, 'IDENTIFIER')).toThrowError(TOO_LARGE);
      await expect(classifyIntent(oversized)).resolves.toEqual({
        intent: 'HYBRID', confidence: 0.4, method: 'fallback',
      });
    }
  });

  it.each([
    ['computeQueryStats', computeQueryStats, 'how does AuthService work'],
    ['inferSourceTypeBoost', inferSourceTypeBoost, 'find AuthService class'],
  ] as const)('%s enforces the root-exported query boundary before scans', (_name, operation, valid) => {
    const splitSpy = vi.spyOn(String.prototype, 'split');
    const lowerSpy = vi.spyOn(String.prototype, 'toLowerCase');
    const regexSpy = vi.spyOn(RegExp.prototype, 'test');

    const result = operation(valid);
    const positive = {
      split: splitSpy.mock.calls.length,
      lower: lowerSpy.mock.calls.length,
      regex: regexSpy.mock.calls.length,
    };
    splitSpy.mockClear();
    lowerSpy.mockClear();
    regexSpy.mockClear();

    let oversizedThrown: unknown;
    try {
      operation('x'.repeat(LIMIT + 1));
    } catch (error) {
      oversizedThrown = error;
    }
    const oversized = {
      split: splitSpy.mock.calls.length,
      lower: lowerSpy.mock.calls.length,
      regex: regexSpy.mock.calls.length,
    };
    splitSpy.mockClear();
    lowerSpy.mockClear();
    regexSpy.mockClear();

    const hostile = hostileValue();
    let invalidThrown: unknown;
    try {
      operation(hostile.value as never);
    } catch (error) {
      invalidThrown = error;
    }
    const invalid = {
      reads: hostile.reads(),
      split: splitSpy.mock.calls.length,
      lower: lowerSpy.mock.calls.length,
      regex: regexSpy.mock.calls.length,
    };
    vi.restoreAllMocks();

    if (_name === 'computeQueryStats') {
      expect(result).toEqual({
        totalTokens: 4,
        identifierDensity: 0.25,
        avgTokenLen: 5.5,
        narrativeHint: true,
        graphHint: false,
      });
    } else {
      expect(result).toEqual({ symbol: 0.25 });
    }
    expect(oversizedThrown).toEqual(new Error(TOO_LARGE));
    expect(invalidThrown).toEqual(new Error(INVALID));
    expect(positive.split).toBeGreaterThan(0);
    expect(positive.lower).toBeGreaterThan(0);
    if (_name === 'computeQueryStats') expect(positive.regex).toBeGreaterThan(0);
    expect(oversized).toEqual({ split: 0, lower: 0, regex: 0 });
    expect(invalid).toEqual({ reads: 0, split: 0, lower: 0, regex: 0 });
  });

  it.each(['assemble', 'assembleTraced'] as const)(
    'UnifiedAssembler.%s validates before options and every provider',
    async (lane) => {
      const { assembler, probes } = dependencies();
      const traceHook = vi.spyOn(RankedRuntimeTraceAdapter.prototype, 'recordDedup');
      await assembler[lane]('find ordinary functions', {
        strategy: 'ranked', include_code: true, include_arch: true, include_memory: true,
      });
      expect(probes.session).toHaveBeenCalled();
      expect(probes.codeSearch).toHaveBeenCalled();
      expect(probes.memoryLoad).toHaveBeenCalled();
      expect(probes.embed).toHaveBeenCalled();
      if (lane === 'assembleTraced') expect(traceHook).toHaveBeenCalled();
      clearProviderProbes(probes);
      traceHook.mockClear();

      const options = hostileOptions();
      await expect(assembler[lane]('x'.repeat(LIMIT + 1), options.value as never))
        .rejects.toThrowError(TOO_LARGE);
      expect(options.reads()).toBe(0);
      expectNoProviderWork(probes);
      expect(traceHook).not.toHaveBeenCalled();

      const hostile = hostileValue();
      await expect(assembler[lane](hostile.value as never)).rejects.toThrowError(INVALID);
      expect(hostile.reads()).toBe(0);
      expectNoProviderWork(probes);
      expect(traceHook).not.toHaveBeenCalled();
      traceHook.mockRestore();
    },
  );

  it.each([false, true])(
    'assembleCandidateExecution traced=%s validates before settlement, candidate, and trace work',
    (traced) => {
      const assembler = Object.create(UnifiedAssembler.prototype) as UnifiedAssembler;
      const traceHook = vi.spyOn(RankedRuntimeTraceAdapter.prototype, 'recordDedup');
      const positive = candidateExecution();
      assembler.assembleCandidateExecution('valid task', positive.execution as never, 8_000, true, true, traced);
      expect(positive.reads().settlements).toBeGreaterThan(0);
      expect(positive.reads().candidates).toBeGreaterThan(0);
      if (traced) expect(traceHook).toHaveBeenCalled();
      traceHook.mockClear();

      const oversizedExecution = hostileExecution();
      expect(() => assembler.assembleCandidateExecution(
        'x'.repeat(LIMIT + 1), oversizedExecution.value as never, 8_000, true, true, traced,
      )).toThrowError(TOO_LARGE);
      expect(oversizedExecution.reads()).toBe(0);
      expect(traceHook).not.toHaveBeenCalled();

      const hostileQuery = hostileValue();
      const invalidExecution = hostileExecution();
      expect(() => assembler.assembleCandidateExecution(
        hostileQuery.value as never, invalidExecution.value as never, 8_000, true, true, traced,
      )).toThrowError(INVALID);
      expect(hostileQuery.reads()).toBe(0);
      expect(invalidExecution.reads()).toBe(0);
      expect(traceHook).not.toHaveBeenCalled();
      traceHook.mockRestore();
    },
  );

  it.each(['assemble', 'assembleTraced'] as const)(
    'DeterministicAssembler.%s validates before options, driver, and trace work',
    async (lane) => {
      const run = vi.fn(async () => ({ records: [] }));
      const close = vi.fn(async () => undefined);
      const session = vi.fn(() => ({ run, close }));
      const assembler = new DeterministicAssembler({ session } as never);
      const traceHook = vi.spyOn(DeterministicRuntimeTraceAdapter.prototype, 'finalize');

      await assembler[lane]('valid deterministic task');
      expect(session).toHaveBeenCalled();
      expect(run).toHaveBeenCalled();
      if (lane === 'assembleTraced') expect(traceHook).toHaveBeenCalled();
      session.mockClear();
      run.mockClear();
      close.mockClear();
      traceHook.mockClear();

      const options = hostileOptions();
      await expect(assembler[lane]('x'.repeat(LIMIT + 1), options.value as never))
        .rejects.toThrowError(TOO_LARGE);
      expect(options.reads()).toBe(0);
      expect(session).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(traceHook).not.toHaveBeenCalled();

      const hostile = hostileValue();
      await expect(assembler[lane](hostile.value as never)).rejects.toThrowError(INVALID);
      expect(hostile.reads()).toBe(0);
      expect(session).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(traceHook).not.toHaveBeenCalled();
      traceHook.mockRestore();
    },
  );

  it('ask and askFromContext validate their direct question lane before synthesis state', async () => {
    const { assembler, probes } = dependencies(false);
    const options = hostileOptions();
    await expect(assembler.ask('x'.repeat(LIMIT + 1), options.value as never))
      .rejects.toThrowError(TOO_LARGE);
    expect(options.reads()).toBe(0);
    expectNoProviderWork(probes);

    let contextReads = 0;
    const context = new Proxy(Object.create(null) as UnifiedContext, {
      get() {
        contextReads += 1;
        throw new Error('hostile_context_was_touched');
      },
    });
    await expect(assembler.askFromContext('x'.repeat(LIMIT + 1), context))
      .rejects.toThrowError(TOO_LARGE);
    expect(contextReads).toBe(0);
    expectNoProviderWork(probes);
  });

  it('askFromContext proves context and chat hooks, then rejects before either hook', async () => {
    const { assembler, probes } = dependencies(true);
    let contextReads = 0;
    const context = Object.create(null) as UnifiedContext;
    Object.defineProperty(context, 'sections', {
      get() {
        contextReads += 1;
        return [{
          heading: 'evidence', source_type: 'semantic',
          items: [{ id: 'e-1', content: 'trusted test evidence', score: 1, metadata: {} }],
        }];
      },
    });

    await assembler.askFromContext('valid question', context);
    expect(contextReads).toBeGreaterThan(0);
    expect(probes.chat).toHaveBeenCalledTimes(1);
    contextReads = 0;
    probes.chat.mockClear();

    await expect(assembler.askFromContext('x'.repeat(LIMIT + 1), context))
      .rejects.toThrowError(TOO_LARGE);
    expect(contextReads).toBe(0);
    expect(probes.chat).not.toHaveBeenCalled();

    const hostile = hostileValue();
    await expect(assembler.askFromContext(hostile.value as never, context))
      .rejects.toThrowError(INVALID);
    expect(hostile.reads()).toBe(0);
    expect(contextReads).toBe(0);
    expect(probes.chat).not.toHaveBeenCalled();
  });

  it('FeedbackTracker preserves the 2000-code-unit Unicode boundary and rejects before match or Redis', async () => {
    const redis = {
      zincrby: vi.fn(async () => 0),
      zrevrangeWithScores: vi.fn(async () => []),
      lpush: vi.fn(async () => 0),
      ltrim: vi.fn(async () => undefined),
    };
    const tracker = new FeedbackTracker(redis);
    const matchSpy = vi.spyOn(String.prototype, 'match');
    const signal = (query: unknown) => ({
      query, result_id: 'result-1', source_type: 'semantic', was_useful: true,
      session_id: 'session-1', timestamp: '2026-08-17T00:00:00.000Z',
    });

    const exactAstral = '\u{1F600}'.repeat(1_000);
    expect(exactAstral.length).toBe(2_000);
    await tracker.recordFeedback(signal(exactAstral) as never);
    expect(matchSpy).toHaveBeenCalled();
    expect(redis.zincrby).toHaveBeenCalled();
    expect(redis.lpush).toHaveBeenCalled();
    expect(redis.ltrim).toHaveBeenCalled();
    matchSpy.mockClear();
    for (const probe of [redis.zincrby, redis.lpush, redis.ltrim]) probe.mockClear();

    for (const oversized of [
      'x'.repeat(2_001),
      '\uD800'.repeat(2_001),
      '\uFF2D'.repeat(2_001),
      '\u{1F600}'.repeat(1_001),
    ]) {
      await expect(tracker.recordFeedback(signal(oversized) as never))
        .rejects.toThrowError(TOO_LARGE);
      expect(matchSpy).not.toHaveBeenCalled();
      expect(redis.zincrby).not.toHaveBeenCalled();
      expect(redis.lpush).not.toHaveBeenCalled();
      expect(redis.ltrim).not.toHaveBeenCalled();
    }

    const hostile = hostileValue();
    await expect(tracker.recordFeedback(signal(hostile.value) as never))
      .rejects.toThrowError(INVALID);
    expect(hostile.reads()).toBe(0);
    expect(matchSpy).not.toHaveBeenCalled();
    expect(redis.zincrby).not.toHaveBeenCalled();
    expect(redis.lpush).not.toHaveBeenCalled();
    expect(redis.ltrim).not.toHaveBeenCalled();
    matchSpy.mockRestore();
  });

  it('FeedbackTracker snapshots a changing query and exact owned fields once', async () => {
    const redis = {
      zincrby: vi.fn(async () => 0),
      zrevrangeWithScores: vi.fn(async () => []),
      lpush: vi.fn(async () => 0),
      ltrim: vi.fn(async () => undefined),
    };
    const tracker = new FeedbackTracker(redis);
    const reads = new Map<PropertyKey, number>();
    const values: Record<string, unknown> = {
      result_id: 'result-1',
      source_type: 'semantic',
      was_useful: true,
      session_id: 'session-1',
      timestamp: '2026-08-17T00:00:00.000Z',
    };
    let extraReads = 0;
    const signal = new Proxy(values, {
      get(target, key, receiver) {
        reads.set(key, (reads.get(key) ?? 0) + 1);
        if (key === 'query') {
          return reads.get(key) === 1 ? 'ShortEntity' : 'x'.repeat(2_001);
        }
        return Reflect.get(target, key, receiver);
      },
      ownKeys() {
        return [...Reflect.ownKeys(values), 'query', 'hostile_extra'];
      },
      getOwnPropertyDescriptor(target, key) {
        if (key === 'query') return { configurable: true, enumerable: true };
        if (key === 'hostile_extra') {
          extraReads += 1;
          throw new Error('hostile_extra_was_touched');
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const stringifySpy = vi.spyOn(JSON, 'stringify');

    await tracker.recordFeedback(signal as never);

    expect(reads.get('query')).toBe(1);
    for (const key of ['result_id', 'source_type', 'was_useful', 'session_id', 'timestamp']) {
      expect(reads.get(key)).toBe(1);
    }
    expect(extraReads).toBe(0);
    expect(redis.zincrby).toHaveBeenCalled();
    expect(redis.lpush).toHaveBeenCalledTimes(1);
    expect(stringifySpy).toHaveBeenCalledTimes(1);
    const serializedInput = stringifySpy.mock.calls[0]![0] as object;
    expect(Object.getPrototypeOf(serializedInput)).toBeNull();
    expect(Reflect.ownKeys(serializedInput)).toEqual([
      'query', 'result_id', 'source_type', 'was_useful', 'session_id', 'timestamp',
    ]);
    for (const key of Reflect.ownKeys(serializedInput)) {
      const descriptor = Object.getOwnPropertyDescriptor(serializedInput, key)!;
      expect(descriptor.enumerable).toBe(true);
      expect('value' in descriptor).toBe(true);
      expect('get' in descriptor).toBe(false);
      expect('set' in descriptor).toBe(false);
    }
    const logged = JSON.parse(redis.lpush.mock.calls[0]![1]);
    expect(logged).toEqual({
      query: 'ShortEntity',
      result_id: 'result-1',
      source_type: 'semantic',
      was_useful: true,
      session_id: 'session-1',
      timestamp: '2026-08-17T00:00:00.000Z',
    });
    stringifySpy.mockRestore();
  });

  it('FeedbackTracker rejects an oversized first query read before other fields, match, or Redis', async () => {
    const redis = {
      zincrby: vi.fn(async () => 0),
      zrevrangeWithScores: vi.fn(async () => []),
      lpush: vi.fn(async () => 0),
      ltrim: vi.fn(async () => undefined),
    };
    const tracker = new FeedbackTracker(redis);
    let queryReads = 0;
    let otherReads = 0;
    const signal = new Proxy(Object.create(null) as object, {
      get(_target, key) {
        if (key === 'query') {
          queryReads += 1;
          return 'x'.repeat(2_001);
        }
        otherReads += 1;
        throw new Error('other_feedback_field_was_touched');
      },
    });
    const matchSpy = vi.spyOn(String.prototype, 'match');

    await expect(tracker.recordFeedback(signal as never)).rejects.toThrowError(TOO_LARGE);

    expect(queryReads).toBe(1);
    expect(otherReads).toBe(0);
    expect(matchSpy).not.toHaveBeenCalled();
    expect(redis.zincrby).not.toHaveBeenCalled();
    expect(redis.lpush).not.toHaveBeenCalled();
    expect(redis.ltrim).not.toHaveBeenCalled();
    matchSpy.mockRestore();
  });

  it('FeedbackTracker contains a throwing query accessor as a fixed value-free error', async () => {
    const redis = {
      zincrby: vi.fn(async () => 0), zrevrangeWithScores: vi.fn(async () => []),
      lpush: vi.fn(async () => 0), ltrim: vi.fn(async () => undefined),
    };
    const tracker = new FeedbackTracker(redis);
    let queryReads = 0;
    let siblingReads = 0;
    const marker = 'private-query-accessor-marker';
    const signal = new Proxy(Object.create(null) as object, {
      get(_target, key) {
        if (key === 'query') {
          queryReads += 1;
          throw new Error(marker);
        }
        siblingReads += 1;
        throw new Error('sibling_was_touched');
      },
    });
    let tenantHooks = 0;
    const tenant = new Proxy(Object.create(null) as object, {
      get() { tenantHooks += 1; throw new Error('tenant_was_touched'); },
    });

    let thrown: unknown;
    try {
      await tracker.recordFeedback(signal as never, tenant as never);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toEqual(new Error(INVALID));
    expect((thrown as Error).message).not.toContain(marker);
    expect(queryReads).toBe(1);
    expect(siblingReads).toBe(0);
    expect(tenantHooks).toBe(0);
    expect(redis.zincrby).not.toHaveBeenCalled();
    expect(redis.lpush).not.toHaveBeenCalled();
    expect(redis.ltrim).not.toHaveBeenCalled();
  });

  it.each(['result_id', 'source_type', 'was_useful', 'session_id', 'timestamp'] as const)(
    'FeedbackTracker rejects a hostile non-primitive %s without nested hooks or side effects',
    async (field) => {
      const redis = {
        zincrby: vi.fn(async () => 0), zrevrangeWithScores: vi.fn(async () => []),
        lpush: vi.fn(async () => 0), ltrim: vi.fn(async () => undefined),
      };
      const tracker = new FeedbackTracker(redis);
      let fieldReads = 0;
      let nestedHooks = 0;
      const nested = new Proxy(Object.create(null) as object, {
        get() { nestedHooks += 1; throw new Error('nested_get_marker'); },
        ownKeys() { nestedHooks += 1; throw new Error('nested_keys_marker'); },
        getOwnPropertyDescriptor() { nestedHooks += 1; throw new Error('nested_descriptor_marker'); },
      });
      const signal: Record<string, unknown> = {
        query: 'valid query', result_id: 'result-1', source_type: 'semantic', was_useful: true,
        session_id: 'session-1', timestamp: '2026-08-17T00:00:00.000Z',
      };
      Object.defineProperty(signal, field, {
        enumerable: true,
        get() { fieldReads += 1; return nested; },
      });
      const matchSpy = vi.spyOn(String.prototype, 'match');

      let thrown: unknown;
      try {
        await tracker.recordFeedback(signal as never);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toEqual(new Error(FEEDBACK_INVALID));
      expect(fieldReads).toBe(1);
      expect(nestedHooks).toBe(0);
      expect(matchSpy).not.toHaveBeenCalled();
      expect(redis.zincrby).not.toHaveBeenCalled();
      expect(redis.lpush).not.toHaveBeenCalled();
      expect(redis.ltrim).not.toHaveBeenCalled();
      matchSpy.mockRestore();
    },
  );

  it.each(['result_id', 'source_type', 'was_useful', 'session_id', 'timestamp'] as const)(
    'FeedbackTracker contains a throwing %s getter as a fixed value-free error',
    async (field) => {
      const redis = {
        zincrby: vi.fn(async () => 0), zrevrangeWithScores: vi.fn(async () => []),
        lpush: vi.fn(async () => 0), ltrim: vi.fn(async () => undefined),
      };
      const tracker = new FeedbackTracker(redis);
      let fieldReads = 0;
      const marker = `private-${field}-accessor-marker`;
      const signal: Record<string, unknown> = {
        query: 'valid query', result_id: 'result-1', source_type: 'semantic', was_useful: true,
        session_id: 'session-1', timestamp: '2026-08-17T00:00:00.000Z',
      };
      Object.defineProperty(signal, field, {
        enumerable: true,
        get() { fieldReads += 1; throw new Error(marker); },
      });
      const matchSpy = vi.spyOn(String.prototype, 'match');

      let thrown: unknown;
      try {
        await tracker.recordFeedback(signal as never);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toEqual(new Error(FEEDBACK_INVALID));
      expect((thrown as Error).message).not.toContain(marker);
      expect(fieldReads).toBe(1);
      expect(matchSpy).not.toHaveBeenCalled();
      expect(redis.zincrby).not.toHaveBeenCalled();
      expect(redis.lpush).not.toHaveBeenCalled();
      expect(redis.ltrim).not.toHaveBeenCalled();
      matchSpy.mockRestore();
    },
  );

  it.each(['result_id', 'session_id', 'timestamp'] as const)(
    'FeedbackTracker enforces the existing 500-unit %s bound with astral code units',
    async (field) => {
      const redis = {
        zincrby: vi.fn(async () => 0), zrevrangeWithScores: vi.fn(async () => []),
        lpush: vi.fn(async () => 0), ltrim: vi.fn(async () => undefined),
      };
      const tracker = new FeedbackTracker(redis);
      const signal = (value: string) => ({
        query: 'valid query', result_id: 'result', source_type: 'semantic', was_useful: true,
        session_id: 'session', timestamp: '2026-08-17T00:00:00.000Z', [field]: value,
      });
      const exactAstral = '\u{1F600}'.repeat(250);
      expect(exactAstral.length).toBe(500);

      await tracker.recordFeedback(signal(exactAstral) as never);
      expect(redis.zincrby).toHaveBeenCalled();
      for (const probe of [redis.zincrby, redis.lpush, redis.ltrim]) probe.mockClear();

      for (const invalid of ['x'.repeat(501), '\u{1F600}'.repeat(251)]) {
        await expect(tracker.recordFeedback(signal(invalid) as never)).rejects.toThrowError(FEEDBACK_INVALID);
        expect(redis.zincrby).not.toHaveBeenCalled();
        expect(redis.lpush).not.toHaveBeenCalled();
        expect(redis.ltrim).not.toHaveBeenCalled();
      }
    },
  );

  it('FeedbackTracker preserves empty strings, legacy timestamps, and every public source type', async () => {
    const redis = {
      zincrby: vi.fn(async () => 0), zrevrangeWithScores: vi.fn(async () => []),
      lpush: vi.fn(async () => 0), ltrim: vi.fn(async () => undefined),
    };
    const tracker = new FeedbackTracker(redis);
    const sources = ['semantic', 'episodic', 'symbol', 'arch_entity', 'aspect', 'fact'] as const;

    for (const source_type of sources) {
      await tracker.recordFeedback({
        query: '', result_id: '', source_type, was_useful: false,
        session_id: '', timestamp: '2025-01-01T00:00:00Z',
      });
    }

    const sourceMembers = redis.zincrby.mock.calls
      .filter(([key]) => String(key).endsWith(':source_boost'))
      .map((call) => call[2]);
    expect(sourceMembers).toEqual(sources);
    expect(redis.lpush).toHaveBeenCalledTimes(sources.length);
  });

  it.each([
    ['query', new String('valid'), INVALID],
    ['result_id', new String('result'), FEEDBACK_INVALID],
    ['source_type', new String('semantic'), FEEDBACK_INVALID],
    ['was_useful', new Boolean(true), FEEDBACK_INVALID],
    ['session_id', new String('session'), FEEDBACK_INVALID],
    ['timestamp', new Date('2026-08-17T00:00:00.000Z'), FEEDBACK_INVALID],
  ] as const)('FeedbackTracker rejects boxed %s without coercion or side effects', async (field, boxed, errorCode) => {
    const redis = {
      zincrby: vi.fn(async () => 0), zrevrangeWithScores: vi.fn(async () => []),
      lpush: vi.fn(async () => 0), ltrim: vi.fn(async () => undefined),
    };
    const tracker = new FeedbackTracker(redis);
    let coercionHooks = 0;
    const value = new Proxy(boxed, {
      get() { coercionHooks += 1; throw new Error('boxed_value_was_touched'); },
    });
    const signal: Record<string, unknown> = {
      query: 'valid query', result_id: 'result', source_type: 'semantic', was_useful: true,
      session_id: 'session', timestamp: '2026-08-17T00:00:00.000Z', [field]: value,
    };

    await expect(tracker.recordFeedback(signal as never)).rejects.toThrowError(errorCode);
    expect(coercionHooks).toBe(0);
    expect(redis.zincrby).not.toHaveBeenCalled();
    expect(redis.lpush).not.toHaveBeenCalled();
    expect(redis.ltrim).not.toHaveBeenCalled();
  });

  it.each(['query', 'result_id', 'source_type', 'was_useful', 'session_id', 'timestamp'] as const)(
    'FeedbackTracker stops immediately after invalid %s and never reads later fields',
    async (invalidField) => {
      const redis = {
        zincrby: vi.fn(async () => 0), zrevrangeWithScores: vi.fn(async () => []),
        lpush: vi.fn(async () => 0), ltrim: vi.fn(async () => undefined),
      };
      const tracker = new FeedbackTracker(redis);
      const order = ['query', 'result_id', 'source_type', 'was_useful', 'session_id', 'timestamp'] as const;
      const reads = new Map<string, number>();
      const valid: Record<string, unknown> = {
        query: 'valid', result_id: 'result', source_type: 'semantic', was_useful: true,
        session_id: 'session', timestamp: '2026-08-17T00:00:00.000Z',
      };
      const signal = Object.create(null) as Record<string, unknown>;
      for (const field of order) {
        Object.defineProperty(signal, field, {
          enumerable: true,
          get() {
            reads.set(field, (reads.get(field) ?? 0) + 1);
            return field === invalidField ? Object.create(null) : valid[field];
          },
        });
      }

      await expect(tracker.recordFeedback(signal as never)).rejects.toThrowError(
        invalidField === 'query' ? INVALID : FEEDBACK_INVALID,
      );
      const invalidIndex = order.indexOf(invalidField);
      for (let index = 0; index < order.length; index += 1) {
        expect(reads.get(order[index]! ) ?? 0).toBe(index <= invalidIndex ? 1 : 0);
      }
      expect(redis.zincrby).not.toHaveBeenCalled();
      expect(redis.lpush).not.toHaveBeenCalled();
      expect(redis.ltrim).not.toHaveBeenCalled();
    },
  );
});
