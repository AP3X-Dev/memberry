import { readFileSync } from 'node:fs';
import { types as nodeUtilTypes } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  CANDIDATE_CHANNEL_CONTRACT_ID,
  CANDIDATE_CHANNEL_CONTRACT_VERSION,
  CANDIDATE_CHANNEL_MAX_AGGREGATE_STRING_BYTES,
  CANDIDATE_CHANNEL_MAX_SERIALIZED_BYTES,
  CANDIDATE_CHANNEL_MAX_STRING_BYTES,
  RETRIEVAL_TRACE_CHANNEL_ORDER,
  CandidateChannelContractError,
  canonicalCandidateChannelRequestV1,
  canonicalCandidateChannelRunnerResultV1,
  computeRetrievalTraceReplayStateDigest,
  executeCandidateChannelsV1,
  parseCandidateChannelRequestV1,
  type CandidateChannelCandidateV1,
  type CandidateChannelRequestV1,
  type CandidateChannelRunnerRosterV1,
  type RetrievalTraceChannel,
} from '../index.js';
// RET-009: the executor deadline is deliberately not re-exported from index.ts.
// Under ESM this resolves to the same module instance as the import above.
import { CANDIDATE_CHANNEL_EXECUTOR_DEADLINE_MS } from '../candidate-channel.js';
import { RETRIEVAL_LATENCY_POLICY_V1 } from '../retrieval-latency-policy.js';

const CHANNELS = [
  'memory.scope', 'memory.semantic-vector', 'memory.episodic-vector', 'memory.fact',
  'memory.block', 'memory.graph', 'code.fulltext', 'code.lexical-vector',
  'code.dense-vector', 'code.semantic-vector', 'arch.fulltext', 'arch.hierarchy',
  'arch.dependency', 'arch.aspect', 'arch.entity',
] as const;

const CHANNEL_SOURCE = {
  'memory.scope': ['semantic', 'semanticId'],
  'memory.semantic-vector': ['semantic', 'semanticId'],
  'memory.episodic-vector': ['episodic', 'episodeId'],
  'memory.fact': ['fact', 'factId'],
  'memory.block': ['block', 'blockId'],
  'memory.graph': ['semantic', 'semanticId'],
  'code.fulltext': ['symbol', 'symbolId'],
  'code.lexical-vector': ['symbol', 'symbolId'],
  'code.dense-vector': ['symbol', 'symbolId'],
  'code.semantic-vector': ['symbol', 'symbolId'],
  'arch.fulltext': ['arch_entity', 'entityId'],
  'arch.hierarchy': ['arch_entity', 'entityId'],
  'arch.dependency': ['arch_entity', 'entityId'],
  'arch.aspect': ['aspect', 'aspectId'],
  'arch.entity': ['arch_entity', 'entityId'],
} as const;

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractId: 'memberry.candidate-channel',
    contractVersion: '1.0.0',
    tenantId: 'tenant-a',
    projectScope: 'project:memberry',
    resolvedEntityIds: ['entity-a'],
    temporalFrame: { mode: 'current' },
    plannedChannels: ['memory.scope'],
    ...overrides,
  };
}

function candidate(
  channel: RetrievalTraceChannel,
  evidenceId: string,
  rank: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const [sourceType, provenanceIdKey] = CHANNEL_SOURCE[channel];
  return {
    contractId: CANDIDATE_CHANNEL_CONTRACT_ID,
    contractVersion: CANDIDATE_CHANNEL_CONTRACT_VERSION,
    channel,
    tenantId: 'tenant-a',
    projectScope: 'project:memberry',
    resolvedEntityId: 'entity-a',
    temporalFrame: { mode: 'current' },
    sourceType,
    evidenceId,
    rank,
    score: 0.5,
    title: `title-${evidenceId}`,
    content: `content-${evidenceId}`,
    provenance: { kind: sourceType, [provenanceIdKey]: evidenceId },
    ...overrides,
  };
}

function success(channel: RetrievalTraceChannel, candidates: readonly unknown[]): Record<string, unknown> {
  return {
    contractId: CANDIDATE_CHANNEL_CONTRACT_ID,
    contractVersion: CANDIDATE_CHANNEL_CONTRACT_VERSION,
    channel,
    outcome: 'success',
    candidateCount: candidates.length,
    candidates,
  };
}

function safeFailure(channel: RetrievalTraceChannel, code: string): Record<string, unknown> {
  return {
    contractId: CANDIDATE_CHANNEL_CONTRACT_ID,
    contractVersion: CANDIDATE_CHANNEL_CONTRACT_VERSION,
    channel,
    outcome: 'safe-failure',
    code,
  };
}

function roster(entries: ReadonlyArray<readonly [
  RetrievalTraceChannel,
  (request: CandidateChannelRequestV1) => unknown,
]>): unknown {
  return entries.map(([channel, run]) => ({ channel, run }));
}

function serialized(
  channel: RetrievalTraceChannel,
  result: unknown,
  requestInput: unknown,
): string {
  return canonicalCandidateChannelRunnerResultV1(result, requestInput, channel);
}

function manyCandidates(channel: RetrievalTraceChannel, count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => (
    candidate(channel, `${channel.replace(/[^a-z]/g, '-')}-${index + 1}`, index + 1)
  ));
}

function expectContractFailure(work: Promise<unknown>, code: 'invalid-request' | 'invalid-roster'): Promise<void> {
  return expect(work).rejects.toMatchObject({
    name: 'CandidateChannelContractError',
    code,
    message: `candidate_channel_contract:${code}`,
  });
}

function deepStringBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (Array.isArray(value)) return value.reduce((total, item) => total + deepStringBytes(item), 0);
  if (value !== null && typeof value === 'object') {
    return Object.values(value).reduce((total, item) => total + deepStringBytes(item), 0);
  }
  return 0;
}

function allocateContentBytes(results: Record<string, unknown>[], bytes: number): void {
  let remaining = bytes;
  for (const result of results) {
    for (const item of result.candidates as Record<string, unknown>[]) {
      const assigned = Math.min(remaining, CANDIDATE_CHANNEL_MAX_STRING_BYTES);
      item.content = 'x'.repeat(assigned);
      remaining -= assigned;
    }
  }
  expect(remaining).toBe(0);
}

describe('RET-003A candidate channel contract', () => {
  it('exports the exact existing 15-channel trace registry without drift', () => {
    expect(RETRIEVAL_TRACE_CHANNEL_ORDER).toEqual(CHANNELS);
    expect(Object.isFrozen(RETRIEVAL_TRACE_CHANNEL_ORDER)).toBe(true);
  });

  it('exposes a versioned default-off-independent request boundary', () => {
    expect(CANDIDATE_CHANNEL_CONTRACT_ID).toBe('memberry.candidate-channel');
    expect(CANDIDATE_CHANNEL_CONTRACT_VERSION).toBe('1.0.0');
    const parsed = parseCandidateChannelRequestV1(request());
    expect(parsed.limits).toEqual({ maxCandidatesPerChannel: 64, maxCandidatesAggregate: 128 });
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('has an executor API before any runtime adapter wiring', async () => {
    const run = vi.fn(() => ({
      contractId: CANDIDATE_CHANNEL_CONTRACT_ID,
      contractVersion: CANDIDATE_CHANNEL_CONTRACT_VERSION,
      channel: 'memory.scope',
      outcome: 'success',
      candidateCount: 0,
      candidates: [],
    }));
    const roster = [{ channel: 'memory.scope', run }] as unknown as CandidateChannelRunnerRosterV1;
    const result = await executeCandidateChannelsV1(request() as unknown as CandidateChannelRequestV1, roster);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.candidates).toEqual([]);
    expect(result.settlements).toEqual([{
      contractId: CANDIDATE_CHANNEL_CONTRACT_ID,
      contractVersion: CANDIDATE_CHANNEL_CONTRACT_VERSION,
      channel: 'memory.scope',
      outcome: 'success',
      candidateCount: 0,
    }]);
  });

  it('keeps the existing deterministic trace fixture replay digest unchanged', () => {
    const fixture = JSON.parse(readFileSync(
      new URL('./fixtures/retrieval-trace-deterministic-v2.json', import.meta.url),
      'utf8',
    )) as Parameters<typeof computeRetrievalTraceReplayStateDigest>[0];
    expect(fixture.replayStateDigest)
      .toBe('sha256:744c26c828a761ab7568163662131d5674802341783d2687539c05f8110a2c2d');
    expect(computeRetrievalTraceReplayStateDigest(fixture)).toBe(fixture.replayStateDigest);
  });

  it('independently snapshots, canonicalizes, and freezes request authority', () => {
    const resolvedEntityIds = ['entity-b', 'entity-a'];
    const temporalFrame = { mode: 'as-of', asOf: '2026-08-16T00:00:00.000Z' };
    const plannedChannels = ['arch.entity', 'memory.scope', 'code.fulltext'];
    const source = request({ resolvedEntityIds, temporalFrame, plannedChannels });
    const parsed = parseCandidateChannelRequestV1(source);
    resolvedEntityIds[0] = 'mutated';
    temporalFrame.asOf = 'mutated';
    plannedChannels[0] = 'mutated';
    expect(parsed.resolvedEntityIds).toEqual(['entity-a', 'entity-b']);
    expect(parsed.temporalFrame).toEqual({ mode: 'as-of', asOf: '2026-08-16T00:00:00.000Z' });
    expect(parsed.plannedChannels).toEqual(['memory.scope', 'code.fulltext', 'arch.entity']);
    expect(Object.isFrozen(parsed.resolvedEntityIds)).toBe(true);
    expect(Object.isFrozen(parsed.temporalFrame)).toBe(true);
    expect(Object.isFrozen(parsed.plannedChannels)).toBe(true);
    expect(Object.isFrozen(parsed.limits)).toBe(true);
    expect(JSON.stringify(parseCandidateChannelRequestV1(request({
      resolvedEntityIds: ['entity-b', 'entity-a'],
    })))).toBe(JSON.stringify(parseCandidateChannelRequestV1(request({
      resolvedEntityIds: ['entity-a', 'entity-b'],
    }))));
  });

  it('accepts every exact request N boundary and rejects N+1', () => {
    const ids32 = Array.from({ length: 32 }, (_, index) => `entity-${index}`);
    expect(parseCandidateChannelRequestV1(request({
      resolvedEntityIds: ids32,
      plannedChannels: [...CHANNELS].reverse(),
      limits: { maxCandidatesPerChannel: 64, maxCandidatesAggregate: 512 },
    })).plannedChannels).toEqual(CHANNELS);
    for (const invalid of [
      request({ resolvedEntityIds: [...ids32, 'entity-32'] }),
      request({ plannedChannels: [...CHANNELS, 'memory.scope'] }),
      request({ limits: { maxCandidatesPerChannel: 65, maxCandidatesAggregate: 128 } }),
      request({ limits: { maxCandidatesPerChannel: 64, maxCandidatesAggregate: 513 } }),
      request({ limits: { maxCandidatesPerChannel: -0, maxCandidatesAggregate: 128 } }),
      request({ limits: { maxCandidatesPerChannel: 64, maxCandidatesAggregate: Number.MAX_SAFE_INTEGER + 1 } }),
    ]) {
      expect(() => parseCandidateChannelRequestV1(invalid)).toThrow(CandidateChannelContractError);
    }
  });

  it('rejects non-authority inputs, duplicates, and noncanonical time without value disclosure', () => {
    const cases = [
      request({ tenantId: 'tenant secret' }),
      request({ projectScope: 'Project:Memberry' }),
      request({ resolvedEntityIds: ['entity-a', 'entity-a'] }),
      request({ plannedChannels: ['memory.scope', 'memory.scope'] }),
      request({ temporalFrame: { mode: 'as-of', asOf: '2026-08-16' } }),
      { ...request(), task: 'must-not-authorize' },
      { ...request(), tags: ['project:foreign'] },
    ];
    for (const invalid of cases) {
      let error: unknown;
      try { parseCandidateChannelRequestV1(invalid); } catch (caught) { error = caught; }
      expect(String(error)).toBe('CandidateChannelContractError: candidate_channel_contract:invalid-request');
      expect(String(error)).not.toContain('secret');
      expect(String(error)).not.toContain('foreign');
    }
  });

  it('rejects hostile request roots and nested values with zero hooks and runner calls', async () => {
    const hooks = vi.fn();
    const run = vi.fn(() => success('memory.scope', []));
    const rootProxy = new Proxy(request(), {
      get: () => { hooks(); throw new Error('secret'); },
      ownKeys: () => { hooks(); return []; },
      getOwnPropertyDescriptor: () => { hooks(); return undefined; },
    });
    const revoked = Proxy.revocable(request(), {}); revoked.revoke();
    const accessor = request();
    Object.defineProperty(accessor, 'tenantId', { enumerable: true, get: () => { hooks(); return 'tenant-a'; } });
    const nestedAccessor = request();
    const accessorIds: unknown[] = ['entity-a'];
    Object.defineProperty(accessorIds, '0', { enumerable: true, get: () => { hooks(); return 'entity-a'; } });
    nestedAccessor.resolvedEntityIds = accessorIds;
    const sparse = request({ plannedChannels: new Array(1) });
    const iterator = ['memory.scope'];
    Object.defineProperty(iterator, Symbol.iterator, { enumerable: true, value: () => { hooks(); return [][Symbol.iterator](); } });
    const withIterator = request({ plannedChannels: iterator });
    const withToJson = { ...request(), toJSON: () => { hooks(); return {}; } };
    const symbol = request(); Object.defineProperty(symbol, Symbol('secret'), { enumerable: true, value: 'secret' });
    const custom = Object.assign(Object.create({ inherited: true }), request());
    const typed = request({ resolvedEntityIds: new Uint8Array([1]) });
    const cyclic = request(); cyclic.temporalFrame = cyclic;
    for (const invalid of [
      rootProxy, revoked.proxy, accessor, nestedAccessor, sparse, withIterator,
      withToJson, symbol, custom, typed, cyclic,
    ]) {
      await expectContractFailure(
        executeCandidateChannelsV1(invalid, roster([['memory.scope', run]])),
        'invalid-request',
      );
    }
    expect(hooks).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects unknown, duplicate, missing, and hostile rosters before any runner call', async () => {
    const hooks = vi.fn();
    const run = vi.fn(() => success('memory.scope', []));
    const rootProxy = new Proxy([{ channel: 'memory.scope', run }], {
      get: () => { hooks(); throw new Error('secret'); },
      ownKeys: () => { hooks(); return []; },
    });
    const revoked = Proxy.revocable([{ channel: 'memory.scope', run }], {}); revoked.revoke();
    const accessor = { channel: 'memory.scope' } as Record<string, unknown>;
    Object.defineProperty(accessor, 'run', { enumerable: true, get: () => { hooks(); return run; } });
    const sparse = new Array(1);
    const iterator = [{ channel: 'memory.scope', run }];
    Object.defineProperty(iterator, Symbol.iterator, { enumerable: true, value: () => { hooks(); return [][Symbol.iterator](); } });
    const extra = [{ channel: 'memory.scope', run, extra: true }];
    const custom = [Object.assign(Object.create({ inherited: true }), { channel: 'memory.scope', run })];
    const withToJson = [{ channel: 'memory.scope', run, toJSON: () => { hooks(); return {}; } }];
    const symbolEntry = { channel: 'memory.scope', run };
    Object.defineProperty(symbolEntry, Symbol('secret'), { enumerable: true, value: true });
    for (const invalidRoster of [
      [],
      [{ channel: 'unknown', run }],
      [{ channel: 'memory.scope', run }, { channel: 'memory.scope', run }],
      rootProxy,
      revoked.proxy,
      [accessor],
      sparse,
      iterator,
      extra,
      custom,
      withToJson,
      [symbolEntry],
      new Uint8Array([1]),
    ]) {
      await expectContractFailure(executeCandidateChannelsV1(request(), invalidRoster), 'invalid-roster');
    }
    expect(hooks).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('is byte-canonical across runner order and inverted async completion timing', async () => {
    const plannedChannels = ['arch.entity', 'memory.scope', 'code.fulltext'];
    const input = request({ plannedChannels });
    const make = (delays: Readonly<Record<string, number>>, reverse: boolean) => {
      const entries: Array<readonly [RetrievalTraceChannel, () => Promise<unknown>]> = [
        ['memory.scope', async (received) => {
          await new Promise((resolve) => setTimeout(resolve, delays['memory.scope']));
          return serialized('memory.scope', success('memory.scope', [
            candidate('memory.scope', 'scope-a', 1),
            candidate('memory.scope', 'scope-b', 2),
          ]), received);
        }],
        ['code.fulltext', async (received) => {
          await new Promise((resolve) => setTimeout(resolve, delays['code.fulltext']));
          return serialized('code.fulltext', safeFailure('code.fulltext', 'unavailable'), received);
        }],
        ['arch.entity', async () => {
          await new Promise((resolve) => setTimeout(resolve, delays['arch.entity']));
          throw new Error('raw-secret-never-visible');
        }],
      ];
      return roster(reverse ? entries.reverse() : entries);
    };
    const first = await executeCandidateChannelsV1(input, make({
      'memory.scope': 8, 'code.fulltext': 4, 'arch.entity': 0,
    }, false));
    const second = await executeCandidateChannelsV1(input, make({
      'memory.scope': 0, 'code.fulltext': 4, 'arch.entity': 8,
    }, true));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.candidates.map((item) => item.evidenceId)).toEqual(['scope-a', 'scope-b']);
    expect(first.settlements.map((item) => [item.channel, item.outcome, 'code' in item ? item.code : null]))
      .toEqual([
        ['memory.scope', 'success', null],
        ['code.fulltext', 'safe-failure', 'unavailable'],
        ['arch.entity', 'safe-failure', 'query-failed'],
      ]);
    expect(JSON.stringify(first)).not.toContain('raw-secret');
  });

  it('rejects fulfilled Promise objects despite post-fulfillment mutations and preserves a sibling', async () => {
    for (const preattached of [false, true]) {
      const originalCandidate = candidate('memory.scope', 'mutable-object', 1);
      const original = success('memory.scope', [originalCandidate]);
      const fulfilled = Promise.resolve(original);
      if (preattached) void fulfilled.then(() => { originalCandidate.content = 'preattached-mutation'; });
      else queueMicrotask(() => { originalCandidate.content = 'queued-mutation'; });
      const result = await executeCandidateChannelsV1(
        request({ plannedChannels: ['memory.scope', 'code.fulltext'] }),
        roster([
          ['memory.scope', () => fulfilled],
          ['code.fulltext', (received) => new Promise((resolve) => {
            setTimeout(() => resolve(serialized(
              'code.fulltext',
              success('code.fulltext', [candidate('code.fulltext', 'sibling', 1)]),
              received,
            )), 10);
          })],
        ]),
      );
      expect(result.candidates.map((item) => item.evidenceId)).toEqual(['sibling']);
      expect(result.settlements).toMatchObject([
        { channel: 'memory.scope', code: 'invalid-result' },
        { channel: 'code.fulltext', outcome: 'success', candidateCount: 1 },
      ]);
    }
  });

  it('keeps helper-produced Promise string bytes original after source mutation', async () => {
    const input = request();
    const originalCandidate = candidate('memory.scope', 'serialized-original', 1);
    const original = success('memory.scope', [originalCandidate]);
    const encoded = serialized('memory.scope', original, input);
    const fulfilled = Promise.resolve(encoded);
    originalCandidate.content = 'mutated-after-serialization';
    const result = await executeCandidateChannelsV1(input, roster([['memory.scope', () => fulfilled]]));
    expect(result.candidates.map((item) => item.content)).toEqual(['content-serialized-original']);
  });

  it('canonicalizes only descriptor-safe runner snapshots without invoking serialization hooks', () => {
    const input = request();
    const raw = success('memory.scope', [candidate('memory.scope', 'canonical', 1)]);
    const encoded = canonicalCandidateChannelRunnerResultV1(raw, input, 'memory.scope');
    expect(encoded).toBe(JSON.stringify(raw));

    const hooks = vi.fn();
    const proxy = new Proxy(raw, {
      get: () => { hooks(); throw new Error('secret-proxy'); },
      ownKeys: () => { hooks(); return []; },
    });
    const revoked = Proxy.revocable(raw, {}); revoked.revoke();
    const accessor = success('memory.scope', []);
    Object.defineProperty(accessor, 'candidates', {
      enumerable: true,
      get: () => { hooks(); throw new Error('secret-accessor'); },
    });
    const withToJson = { ...raw, toJSON: () => { hooks(); return 'secret-json'; } };
    const cyclic = success('memory.scope', []); cyclic.candidates = [cyclic];
    for (const hostile of [proxy, revoked.proxy, accessor, withToJson, cyclic]) {
      expect(() => canonicalCandidateChannelRunnerResultV1(hostile, input, 'memory.scope'))
        .toThrow('candidate_channel_contract:invalid-result');
    }
    expect(hooks).not.toHaveBeenCalled();
  });

  it('keeps canonical helpers immune to Object and Array prototype toJSON poisoning', () => {
    const objectDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
    const arrayDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
    const input = request({ resolvedEntityIds: ['entity-b', 'entity-a'] });
    const raw = success('memory.scope', [candidate('memory.scope', 'prototype-safe', 1)]);
    const expectedRequest = canonicalCandidateChannelRequestV1(input);
    const expectedRunner = canonicalCandidateChannelRunnerResultV1(raw, input, 'memory.scope');
    const hooks = vi.fn();
    try {
      for (const hostile of [
        { get: () => { hooks(); throw new Error('secret-getter'); } },
        { value: () => { hooks(); return { secret: true }; }, writable: true },
      ]) {
        Object.defineProperty(Object.prototype, 'toJSON', {
          configurable: true,
          enumerable: false,
          ...hostile,
        });
        Object.defineProperty(Array.prototype, 'toJSON', {
          configurable: true,
          enumerable: false,
          ...hostile,
        });
        expect(canonicalCandidateChannelRequestV1(input)).toBe(expectedRequest);
        expect(canonicalCandidateChannelRunnerResultV1(raw, input, 'memory.scope')).toBe(expectedRunner);
      }
    } finally {
      if (objectDescriptor === undefined) delete (Object.prototype as { toJSON?: unknown }).toJSON;
      else Object.defineProperty(Object.prototype, 'toJSON', objectDescriptor);
      if (arrayDescriptor === undefined) delete (Array.prototype as { toJSON?: unknown }).toJSON;
      else Object.defineProperty(Array.prototype, 'toJSON', arrayDescriptor);
    }
    expect(hooks).not.toHaveBeenCalled();
  });

  it('uses captured JSON parse and stringify intrinsics after post-import substitution', async () => {
    const originalParse = JSON.parse;
    const originalStringify = JSON.stringify;
    const input = request();
    const raw = success('memory.scope', [candidate('memory.scope', 'captured-json', 1)]);
    const expectedRequest = canonicalCandidateChannelRequestV1(input);
    const encoded = canonicalCandidateChannelRunnerResultV1(raw, input, 'memory.scope');
    const hooks = vi.fn();
    try {
      JSON.parse = (() => { hooks(); throw new Error('secret-parse'); }) as typeof JSON.parse;
      JSON.stringify = (() => { hooks(); throw new Error('secret-stringify'); }) as typeof JSON.stringify;
      expect(canonicalCandidateChannelRequestV1(input)).toBe(expectedRequest);
      expect(canonicalCandidateChannelRunnerResultV1(raw, input, 'memory.scope')).toBe(encoded);
      const result = await executeCandidateChannelsV1(
        input,
        roster([['memory.scope', () => Promise.resolve(encoded)]]),
      );
      expect(result.candidates.map((item) => item.evidenceId)).toEqual(['captured-json']);
    } finally {
      JSON.parse = originalParse;
      JSON.stringify = originalStringify;
    }
    expect(hooks).not.toHaveBeenCalled();
  });

  it('seals a synchronous result before a queued mutation and delayed sibling', async () => {
    const originalCandidate = candidate('memory.scope', 'sync-original', 1);
    const original = success('memory.scope', [originalCandidate]);
    const result = await executeCandidateChannelsV1(
      request({ plannedChannels: ['memory.scope', 'code.fulltext'] }),
      roster([
        ['memory.scope', () => {
          queueMicrotask(() => { originalCandidate.content = 'mutated-after-return'; });
          return original;
        }],
        ['code.fulltext', (received) => new Promise((resolve) => {
          setTimeout(() => resolve(serialized(
            'code.fulltext',
            success('code.fulltext', [candidate('code.fulltext', 'sync-sibling', 1)]),
            received,
          )), 15);
        })],
      ]),
    );
    expect(result.candidates.map((item) => item.content)).toEqual([
      'content-sync-original',
      'content-sync-sibling',
    ]);
  });

  it('rejects non-exact Promise shapes and thenables without invoking hostile hooks', async () => {
    const hooks = vi.fn();
    const encoded = JSON.stringify(success('memory.scope', []));
    class HostilePromise<T> extends Promise<T> {}
    const subclass = new HostilePromise((resolve) => resolve(encoded));
    Object.defineProperty(HostilePromise.prototype, 'then', {
      configurable: true,
      get: () => { hooks(); throw new Error('secret-subclass-then'); },
    });
    const ownThen = Promise.resolve(encoded);
    Object.defineProperty(ownThen, 'then', {
      configurable: true,
      enumerable: true,
      get: () => { hooks(); throw new Error('secret-own-then'); },
    });
    const thenable = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(thenable, 'then', {
      enumerable: true,
      get: () => { hooks(); throw new Error('secret-thenable'); },
    });
    const ownKey = Promise.resolve(encoded);
    Object.defineProperty(ownKey, 'secret', { enumerable: true, value: 'never-read' });
    const boxed = new String(encoded);
    Object.defineProperty(boxed, 'toString', {
      get: () => { hooks(); throw new Error('secret-boxed'); },
    });
    const boxedPromise = Promise.resolve(boxed);
    const proxied = new Proxy(Promise.resolve(encoded), {
      get: () => { hooks(); throw new Error('secret-proxy'); },
    });
    const revoked = Proxy.revocable(Promise.resolve(encoded), {});
    revoked.revoke();

    for (const hostile of [subclass, ownThen, ownKey, thenable, boxedPromise, proxied, revoked.proxy]) {
      const result = await executeCandidateChannelsV1(
        request({ plannedChannels: ['memory.scope', 'code.fulltext'] }),
        roster([
          ['memory.scope', () => hostile],
          ['code.fulltext', () => success('code.fulltext', [candidate('code.fulltext', 'safe', 1)])],
        ]),
      );
      expect(result.candidates.map((item) => item.evidenceId)).toEqual(['safe']);
      expect(result.settlements).toMatchObject([
        { channel: 'memory.scope', code: 'invalid-result' },
        { channel: 'code.fulltext', outcome: 'success', candidateCount: 1 },
      ]);
    }
    expect(hooks).not.toHaveBeenCalled();
  });

  it('rejects Promise prototype constructor descriptor substitution without hooks', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Promise.prototype, 'constructor')!;
    const input = request({ plannedChannels: ['memory.scope', 'code.fulltext'] });
    const encoded = canonicalCandidateChannelRunnerResultV1(
      success('memory.scope', [candidate('memory.scope', 'promise-prototype', 1)]),
      input,
      'memory.scope',
    );
    const hooks = vi.fn();
    const variants: PropertyDescriptor[] = [
      {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        get: () => {
          hooks();
          Object.defineProperty(Promise.prototype, 'constructor', descriptor);
          return Promise;
        },
      },
      {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        writable: descriptor.writable,
        value: function hostilePromiseConstructor() { hooks(); },
      },
      {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        writable: descriptor.writable,
        value: class SubstitutePromise {},
      },
    ];
    for (const hostile of variants) {
      const fulfilled = Promise.resolve(encoded);
      let work: ReturnType<typeof executeCandidateChannelsV1>;
      try {
        Object.defineProperty(Promise.prototype, 'constructor', hostile);
        work = executeCandidateChannelsV1(
          input,
          roster([
            ['memory.scope', () => fulfilled],
            ['code.fulltext', () => success('code.fulltext', [candidate('code.fulltext', 'constructor-sibling', 1)])],
          ]),
        );
      } finally {
        Object.defineProperty(Promise.prototype, 'constructor', descriptor);
      }
      const result = await work!;
      expect(result.candidates.map((item) => item.evidenceId)).toEqual(['constructor-sibling']);
      expect(result.settlements).toMatchObject([
        { channel: 'memory.scope', code: 'invalid-result' },
        { channel: 'code.fulltext', outcome: 'success' },
      ]);
    }
    expect(hooks).not.toHaveBeenCalled();
  });

  it('settles an exact native Promise rejection as fixed query-failed', async () => {
    const result = await executeCandidateChannelsV1(
      request(),
      roster([['memory.scope', () => Promise.reject(new Error('raw-secret-rejection'))]]),
    );
    expect(result.candidates).toEqual([]);
    expect(result.settlements).toMatchObject([{ code: 'query-failed' }]);
    expect(JSON.stringify(result)).not.toContain('raw-secret');
  });

  it('rejects noncanonical or malformed serialized envelopes before admission', async () => {
    const input = request();
    const raw = success('memory.scope', [candidate('memory.scope', 'lexical', 1)]);
    const encoded = serialized('memory.scope', raw, input);
    const reordered = JSON.stringify({
      channel: raw.channel,
      contractId: raw.contractId,
      contractVersion: raw.contractVersion,
      outcome: raw.outcome,
      candidateCount: raw.candidateCount,
      candidates: raw.candidates,
    });
    const variants = [
      ` ${encoded}`,
      reordered,
      encoded.replace('memberry.candidate-channel', 'memberry.candidate\\u002dchannel'),
      encoded.replace('"candidateCount":1', '"candidateCount":1e0'),
      encoded.replace('"rank":1', '"rank":1.0'),
      encoded.replace('"rank":1', '"rank":-0'),
      `${encoded} trailing`,
      `\ufeff${encoded}`,
      encoded.replace('"contractId":', '"contractId":"memberry.candidate-channel","contractId":'),
      '{"unterminated":',
    ];
    for (const variant of variants) {
      const result = await executeCandidateChannelsV1(
        input,
        roster([['memory.scope', () => Promise.resolve(variant)]]),
      );
      expect(result.candidates).toEqual([]);
      expect(result.settlements).toMatchObject([{ code: 'invalid-result' }]);
    }
  });

  it('enforces the 32MiB UTF-8 serialized cap at exact N/N+1', async () => {
    const exact = '🙂'.repeat(CANDIDATE_CHANNEL_MAX_SERIALIZED_BYTES / 4);
    const atLimit = await executeCandidateChannelsV1(
      request(),
      roster([['memory.scope', () => Promise.resolve(exact)]]),
    );
    expect(atLimit.settlements).toMatchObject([{ code: 'invalid-result' }]);
    const overflow = await executeCandidateChannelsV1(
      request(),
      roster([['memory.scope', () => Promise.resolve(`${exact}x`)]]),
    );
    expect(overflow.settlements).toMatchObject([{ code: 'budget-exceeded' }]);
  });

  it('enforces lexical depth, value, and entry N/N+1 before JSON.parse', async () => {
    const cases = [
      ['['.repeat(12) + '0' + ']'.repeat(12), '['.repeat(13) + '0' + ']'.repeat(13)],
      [`{${Array.from({ length: 8191 }, (_, index) => `"k${index}":0`).join(',')}}`,
        `{${Array.from({ length: 8192 }, (_, index) => `"k${index}":0`).join(',')}}`],
      [`[${Array.from({ length: 4096 }, () => '0').join(',')}]`,
        `[${Array.from({ length: 4097 }, () => '0').join(',')}]`],
    ];
    for (const [exact, overflow] of cases) {
      const atLimit = await executeCandidateChannelsV1(
        request(),
        roster([['memory.scope', () => Promise.resolve(exact)]]),
      );
      expect(atLimit.settlements).toMatchObject([{ code: 'invalid-result' }]);
      const exceeded = await executeCandidateChannelsV1(
        request(),
        roster([['memory.scope', () => Promise.resolve(overflow)]]),
      );
      expect(exceeded.settlements).toMatchObject([{ code: 'budget-exceeded' }]);
    }
  });

  it('preserves every explicit fixed failure and returns valid empty all-failure results', async () => {
    const plannedChannels = ['memory.scope', 'memory.fact', 'code.fulltext'];
    const result = await executeCandidateChannelsV1(request({ plannedChannels }), roster([
      ['memory.scope', () => safeFailure('memory.scope', 'unavailable')],
      ['memory.fact', () => safeFailure('memory.fact', 'timeout')],
      ['code.fulltext', () => safeFailure('code.fulltext', 'query-failed')],
    ]));
    expect(result.candidates).toEqual([]);
    expect(result.settlements.map((item) => 'code' in item ? item.code : null))
      .toEqual(['unavailable', 'timeout', 'query-failed']);
    expect(result.settlements).toHaveLength(3);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.candidates)).toBe(true);
    expect(Object.isFrozen(result.settlements)).toBe(true);
  });

  it.each([
    ['tenant substitution', { tenantId: 'tenant-foreign' }],
    ['project substitution', { projectScope: 'project:foreign' }],
    ['entity substitution', { resolvedEntityId: 'entity-foreign' }],
    ['temporal substitution', { temporalFrame: { mode: 'as-of', asOf: '2026-08-16T00:00:00.000Z' } }],
    ['channel substitution', { channel: 'memory.fact' }],
  ])('isolates %s as invalid-result without suppressing a sibling', async (_label, overrides) => {
    const result = await executeCandidateChannelsV1(
      request({ plannedChannels: ['memory.scope', 'code.fulltext'] }),
      roster([
        ['memory.scope', () => success('memory.scope', [candidate('memory.scope', 'bad', 1, overrides)])],
        ['code.fulltext', () => success('code.fulltext', [candidate('code.fulltext', 'good', 1)])],
      ]),
    );
    expect(result.candidates.map((item) => item.evidenceId)).toEqual(['good']);
    expect(result.settlements).toMatchObject([
      { channel: 'memory.scope', outcome: 'safe-failure', code: 'invalid-result' },
      { channel: 'code.fulltext', outcome: 'success', candidateCount: 1 },
    ]);
  });

  it.each([
    ['NaN score', { score: Number.NaN }],
    ['infinite score', { score: Number.POSITIVE_INFINITY }],
    ['negative zero score', { score: -0 }],
    ['unsafe score', { score: Number.MAX_SAFE_INTEGER + 1 }],
    ['unsafe rank', { rank: Number.MAX_SAFE_INTEGER + 1 }],
    ['negative zero rank', { rank: -0 }],
  ])('rejects %s without leaking the malformed candidate', async (_label, overrides) => {
    const result = await executeCandidateChannelsV1(
      request(),
      roster([['memory.scope', () => success('memory.scope', [candidate('memory.scope', 'bad', 1, overrides)])]]),
    );
    expect(result.candidates).toEqual([]);
    expect(result.settlements).toMatchObject([
      { outcome: 'safe-failure', code: 'invalid-result' },
    ]);
  });

  it('rejects duplicate ranks and evidence IDs as whole-channel invalid results', async () => {
    for (const candidates of [
      [candidate('memory.scope', 'same-rank-a', 1), candidate('memory.scope', 'same-rank-b', 1)],
      [candidate('memory.scope', 'same-id', 1), candidate('memory.scope', 'same-id', 2)],
    ]) {
      const result = await executeCandidateChannelsV1(
        request(),
        roster([['memory.scope', () => success('memory.scope', candidates)]]),
      );
      expect(result.candidates).toEqual([]);
      expect(result.settlements).toMatchObject([{ code: 'invalid-result' }]);
    }
  });

  it('requires an exact declared candidate count and rejects missing, forged, and N+1 counts', async () => {
    const one = success('memory.scope', [candidate('memory.scope', 'one', 1)]);
    const missing = { ...one };
    delete missing.candidateCount;
    for (const raw of [
      missing,
      { ...one, candidateCount: 0 },
      { ...one, candidateCount: 2 },
      { ...one, candidateCount: '1' },
    ]) {
      const result = await executeCandidateChannelsV1(
        request(),
        roster([['memory.scope', () => raw]]),
      );
      expect(result.candidates).toEqual([]);
      expect(result.settlements).toMatchObject([{ code: 'invalid-result' }]);
    }

    const exact = success('memory.scope', manyCandidates('memory.scope', 64));
    const accepted = await executeCandidateChannelsV1(
      request(),
      roster([['memory.scope', () => exact]]),
    );
    expect(accepted.candidates).toHaveLength(64);

    const overflow = { ...success('memory.scope', []), candidateCount: 65 };
    const rejected = await executeCandidateChannelsV1(
      request(),
      roster([['memory.scope', () => overflow]]),
    );
    expect(rejected.candidates).toEqual([]);
    expect(rejected.settlements).toMatchObject([{ code: 'budget-exceeded' }]);
  });

  it('rejects reversed and gapped received ranks instead of normalizing them', async () => {
    for (const candidates of [
      [candidate('memory.scope', 'second', 2), candidate('memory.scope', 'first', 1)],
      [candidate('memory.scope', 'first', 1), candidate('memory.scope', 'third', 3)],
    ]) {
      const result = await executeCandidateChannelsV1(
        request(),
        roster([['memory.scope', () => success('memory.scope', candidates)]]),
      );
      expect(result.candidates).toEqual([]);
      expect(result.settlements).toMatchObject([{ code: 'invalid-result' }]);
    }
  });

  it('accepts only closed source-typed provenance and canonicalizes scores', async () => {
    const candidates = [
      candidate('memory.scope', 'typed-1', 1, { score: 0.123456789 }),
      candidate('memory.scope', 'typed-2', 2, { score: -0.0000001 }),
    ];
    const accepted = await executeCandidateChannelsV1(
      request(),
      roster([['memory.scope', () => success('memory.scope', candidates)]]),
    );
    expect(accepted.candidates.map((item) => item.provenance.kind)).toEqual(['semantic', 'semantic']);
    expect(accepted.candidates[0]!.score).toBe(0.123457);
    expect(accepted.candidates[1]!.score).toBe(0);
    expect(Object.is(accepted.candidates[1]!.score, -0)).toBe(false);

    for (const provenance of [
      { kind: 'semantic', semanticId: 'typed', metadata: { secret: true } },
      { kind: 'fact', semanticId: 'typed' },
      { kind: 'semantic', semanticId: new Uint8Array([1]) },
    ]) {
      const invalid = await executeCandidateChannelsV1(
        request(),
        roster([['memory.scope', () => success('memory.scope', [candidate(
          'memory.scope',
          'typed',
          1,
          { provenance },
        )])]]),
      );
      expect(invalid.candidates).toEqual([]);
      expect(invalid.settlements).toMatchObject([{ code: 'invalid-result' }]);
      expect(JSON.stringify(invalid)).not.toContain('secret');
    }
  });

  it('enforces the closed channel source mapping and evidence/provenance identity', async () => {
    const valid = await executeCandidateChannelsV1(
      request({ plannedChannels: [...CHANNELS].reverse() }),
      roster(CHANNELS.map((channel) => [
        channel,
        () => success(channel, [candidate(channel, `valid-${channel.replace(/\./g, '-')}`, 1)]),
      ] as const).reverse()),
    );
    expect(valid.candidates).toHaveLength(CHANNELS.length);
    expect(valid.settlements.every((settlement) => settlement.outcome === 'success')).toBe(true);

    for (const channel of CHANNELS) {
      const [expectedSource] = CHANNEL_SOURCE[channel];
      const wrongSource = expectedSource === 'semantic' ? 'symbol' : 'semantic';
      const wrongIdKey = wrongSource === 'symbol' ? 'symbolId' : 'semanticId';
      for (const malformed of [
        candidate(channel, 'evidence', 1, {
          sourceType: wrongSource,
          provenance: { kind: wrongSource, [wrongIdKey]: 'evidence' },
        }),
        candidate(channel, 'evidence', 1, {
          provenance: { kind: expectedSource, [CHANNEL_SOURCE[channel][1]]: 'substituted-id' },
        }),
      ]) {
        const rejected = await executeCandidateChannelsV1(
          request({ plannedChannels: [channel] }),
          roster([[channel, () => success(channel, [malformed])]]),
        );
        expect(rejected.candidates).toEqual([]);
        expect(rejected.settlements).toMatchObject([{ code: 'invalid-result' }]);
      }
    }
  });

  it('isolates every async authority, identity, count, rank, and decoded-budget failure', async () => {
    const authority = candidate('memory.scope', 'async-authority', 1, { tenantId: 'tenant-foreign' });
    const identity = candidate('memory.scope', 'async-identity', 1, {
      provenance: { kind: 'semantic', semanticId: 'substituted-id' },
    });
    const count = { ...success('memory.scope', [candidate('memory.scope', 'async-count', 1)]), candidateCount: 0 };
    const rank = success('memory.scope', [candidate('memory.scope', 'async-rank', 2)]);
    const overflow = success('memory.scope', [candidate('memory.scope', 'async-overflow', 1, {
      content: 'x'.repeat(CANDIDATE_CHANNEL_MAX_STRING_BYTES + 1),
    })]);
    const variants = [
      [success('memory.scope', [authority]), 'invalid-result'],
      [success('memory.scope', [identity]), 'invalid-result'],
      [count, 'invalid-result'],
      [rank, 'invalid-result'],
      [overflow, 'budget-exceeded'],
    ] as const;
    for (const [raw, code] of variants) {
      const result = await executeCandidateChannelsV1(
        request({ plannedChannels: ['memory.scope', 'code.fulltext'] }),
        roster([
          ['memory.scope', () => Promise.resolve(JSON.stringify(raw))],
          ['code.fulltext', () => success('code.fulltext', [candidate('code.fulltext', 'async-sibling', 1)])],
        ]),
      );
      expect(result.candidates.map((item) => item.evidenceId)).toEqual(['async-sibling']);
      expect(result.settlements).toMatchObject([
        { channel: 'memory.scope', code },
        { channel: 'code.fulltext', outcome: 'success', candidateCount: 1 },
      ]);
    }
  });

  it('turns malformed failure envelopes and raw diagnostics into fixed invalid-result', async () => {
    const malformed = { ...safeFailure('memory.scope', 'timeout'), diagnostic: 'raw-secret' };
    const result = await executeCandidateChannelsV1(
      request(),
      roster([['memory.scope', () => malformed]]),
    );
    expect(result.candidates).toEqual([]);
    expect(result.settlements).toMatchObject([{ code: 'invalid-result' }]);
    expect(JSON.stringify(result)).not.toContain('raw-secret');
  });

  it('invalidates only a hostile result channel with zero hostile hooks', async () => {
    const hooks = vi.fn();
    const proxy = new Proxy(success('memory.scope', []), {
      get: () => { hooks(); throw new Error('secret'); },
      ownKeys: () => { hooks(); return []; },
    });
    const revoked = Proxy.revocable(success('memory.scope', []), {}); revoked.revoke();
    const accessorCandidate = candidate('memory.scope', 'accessor', 1);
    Object.defineProperty(accessorCandidate, 'content', { enumerable: true, get: () => { hooks(); return 'secret'; } });
    const proxiedProvenance = candidate('memory.scope', 'proxy-provenance', 1, {
      provenance: new Proxy({ kind: 'semantic', semanticId: 'proxy-provenance' }, {
        get: () => { hooks(); throw new Error('secret'); },
      }),
    });
    const iteratorCandidates = [candidate('memory.scope', 'iterator', 1)];
    Object.defineProperty(iteratorCandidates, Symbol.iterator, {
      enumerable: true,
      value: () => { hooks(); return [][Symbol.iterator](); },
    });
    const toJsonCandidate = { ...candidate('memory.scope', 'json', 1), toJSON: () => { hooks(); return {}; } };
    const symbolCandidate = candidate('memory.scope', 'symbol', 1);
    Object.defineProperty(symbolCandidate, Symbol('secret'), { enumerable: true, value: true });
    const sparseCandidates = new Array(1);
    const extraCandidate = { ...candidate('memory.scope', 'extra', 1), extra: true };
    const customCandidate = Object.assign(Object.create({ inherited: true }), candidate('memory.scope', 'custom', 1));
    const sharedCandidate = candidate('memory.scope', 'shared', 1);
    const hostileResults: unknown[] = [
      proxy,
      revoked.proxy,
      success('memory.scope', [accessorCandidate]),
      success('memory.scope', [proxiedProvenance]),
      success('memory.scope', iteratorCandidates),
      success('memory.scope', [toJsonCandidate]),
      success('memory.scope', [symbolCandidate]),
      success('memory.scope', sparseCandidates),
      success('memory.scope', [extraCandidate]),
      success('memory.scope', [customCandidate]),
      success('memory.scope', new Uint8Array([1]) as unknown as readonly unknown[]),
      success('memory.scope', [sharedCandidate, sharedCandidate]),
    ];
    for (const hostile of hostileResults) {
      const result = await executeCandidateChannelsV1(
        request({ plannedChannels: ['memory.scope', 'code.fulltext'] }),
        roster([
          ['memory.scope', () => hostile],
          ['code.fulltext', () => success('code.fulltext', [candidate('code.fulltext', 'good', 1)])],
        ]),
      );
      expect(result.candidates.map((item) => item.evidenceId)).toEqual(['good']);
      expect(result.settlements[0]).toMatchObject({ code: 'invalid-result' });
      expect(result.settlements[1]).toMatchObject({ outcome: 'success' });
    }
    expect(hooks).not.toHaveBeenCalled();
  });

  it('enforces exact per-channel and default aggregate N/N+1 without prefixes', async () => {
    const pass64 = await executeCandidateChannelsV1(
      request(),
      roster([['memory.scope', () => success('memory.scope', manyCandidates('memory.scope', 64))]]),
    );
    expect(pass64.candidates).toHaveLength(64);
    const fail65 = await executeCandidateChannelsV1(
      request(),
      roster([['memory.scope', () => success('memory.scope', manyCandidates('memory.scope', 65))]]),
    );
    expect(fail65.candidates).toEqual([]);
    expect(fail65.settlements).toMatchObject([{ code: 'budget-exceeded' }]);

    const aggregate = await executeCandidateChannelsV1(
      request({ plannedChannels: ['memory.scope', 'memory.fact', 'code.fulltext'] }),
      roster([
        ['memory.scope', () => success('memory.scope', manyCandidates('memory.scope', 64))],
        ['memory.fact', () => success('memory.fact', manyCandidates('memory.fact', 64))],
        ['code.fulltext', () => success('code.fulltext', [candidate('code.fulltext', 'candidate-129', 1)])],
      ]),
    );
    expect(aggregate.candidates).toHaveLength(128);
    expect(aggregate.settlements).toMatchObject([
      { outcome: 'success', candidateCount: 64 },
      { outcome: 'success', candidateCount: 64 },
      { outcome: 'safe-failure', code: 'budget-exceeded' },
    ]);
  });

  it('accepts the configurable hard aggregate 512 boundary', async () => {
    const plannedChannels = CHANNELS.slice(0, 8);
    const entries = plannedChannels.map((channel) => [
      channel,
      () => success(channel, manyCandidates(channel, 64)),
    ] as const);
    const result = await executeCandidateChannelsV1(
      request({
        plannedChannels,
        limits: { maxCandidatesPerChannel: 64, maxCandidatesAggregate: 512 },
      }),
      roster(entries),
    );
    expect(result.candidates).toHaveLength(512);
    expect(result.settlements.every((item) => item.outcome === 'success')).toBe(true);
  });

  it('enforces exact UTF-8 per-string N/N+1 and discards the entire overflow channel', async () => {
    const exact = '🙂'.repeat(CANDIDATE_CHANNEL_MAX_STRING_BYTES / 4);
    const accepted = await executeCandidateChannelsV1(
      request(),
      roster([['memory.scope', () => success('memory.scope', [candidate('memory.scope', 'exact', 1, { content: exact })])]]),
    );
    expect(accepted.candidates).toHaveLength(1);
    const rejected = await executeCandidateChannelsV1(
      request(),
      roster([['memory.scope', () => success('memory.scope', [candidate('memory.scope', 'overflow', 1, { content: `${exact}x` })])]]),
    );
    expect(rejected.candidates).toEqual([]);
    expect(rejected.settlements).toMatchObject([{ code: 'budget-exceeded' }]);
  });

  it('rejects malformed UTF-16 in sync, helper, and raw or escaped Promise strings', async () => {
    const invalidStrings = [
      '\ud800',
      '\udc00',
      '\udc00\ud800',
      '\ud800x',
    ];
    const input = request({ plannedChannels: ['memory.scope', 'code.fulltext'] });
    for (const invalid of invalidStrings) {
      const raw = success('memory.scope', [candidate('memory.scope', 'unicode-invalid', 1, { content: invalid })]);
      const sync = await executeCandidateChannelsV1(input, roster([
        ['memory.scope', () => raw],
        ['code.fulltext', () => success('code.fulltext', [candidate('code.fulltext', 'unicode-sibling', 1)])],
      ]));
      expect(sync.candidates.map((item) => item.evidenceId)).toEqual(['unicode-sibling']);
      expect(sync.settlements[0]).toMatchObject({ code: 'invalid-result' });
      expect(() => canonicalCandidateChannelRunnerResultV1(raw, input, 'memory.scope'))
        .toThrow('candidate_channel_contract:invalid-result');

      const escaped = JSON.stringify(raw);
      const literal = JSON.stringify(success('memory.scope', [candidate(
        'memory.scope',
        'unicode-invalid',
        1,
        { content: '__INVALID_UTF16__' },
      )])).replace('__INVALID_UTF16__', invalid);
      for (const encoded of [escaped, literal]) {
        const asyncResult = await executeCandidateChannelsV1(input, roster([
          ['memory.scope', () => Promise.resolve(encoded)],
          ['code.fulltext', () => success('code.fulltext', [candidate('code.fulltext', 'unicode-sibling', 1)])],
        ]));
        expect(asyncResult.candidates.map((item) => item.evidenceId)).toEqual(['unicode-sibling']);
        expect(asyncResult.settlements[0]).toMatchObject({ code: 'invalid-result' });
        expect(JSON.stringify(asyncResult)).not.toContain(invalid);
      }
    }

    const valid = 'valid-🙂-pair';
    const validRaw = success('memory.scope', [candidate('memory.scope', 'unicode-valid', 1, { content: valid })]);
    const syncValid = await executeCandidateChannelsV1(
      request(),
      roster([['memory.scope', () => validRaw]]),
    );
    expect(syncValid.candidates.map((item) => item.content)).toEqual([valid]);
    const encodedValid = canonicalCandidateChannelRunnerResultV1(validRaw, request(), 'memory.scope');
    const asyncValid = await executeCandidateChannelsV1(
      request(),
      roster([['memory.scope', () => Promise.resolve(encodedValid)]]),
    );
    expect(asyncValid.candidates.map((item) => item.content)).toEqual([valid]);
  });

  it('enforces exact 4MiB aggregate string N/N+1 without accepting a prefix', async () => {
    const first = success('memory.scope', manyCandidates('memory.scope', 33));
    const second = success('code.fulltext', manyCandidates('code.fulltext', 32));
    const results = [first, second];
    for (const result of results) {
      for (const item of result.candidates as Record<string, unknown>[]) item.content = '';
    }
    const base = results.reduce((total, value) => total + deepStringBytes(value), 0);
    allocateContentBytes(results, CANDIDATE_CHANNEL_MAX_AGGREGATE_STRING_BYTES - base);
    expect(results.reduce((total, value) => total + deepStringBytes(value), 0))
      .toBe(CANDIDATE_CHANNEL_MAX_AGGREGATE_STRING_BYTES);
    const exact = await executeCandidateChannelsV1(
      request({ plannedChannels: ['memory.scope', 'code.fulltext'] }),
      roster([['memory.scope', () => first], ['code.fulltext', () => second]]),
    );
    expect(exact.candidates).toHaveLength(65);

    const secondCandidates = second.candidates as Record<string, unknown>[];
    const partial = secondCandidates.find((item) => (item.content as string).length < CANDIDATE_CHANNEL_MAX_STRING_BYTES)!;
    partial.content = `${partial.content as string}x`;
    const overflow = await executeCandidateChannelsV1(
      request({ plannedChannels: ['memory.scope', 'code.fulltext'] }),
      roster([['memory.scope', () => first], ['code.fulltext', () => second]]),
    );
    expect(overflow.candidates).toHaveLength(33);
    expect(overflow.settlements).toMatchObject([
      { outcome: 'success', candidateCount: 33 },
      { outcome: 'safe-failure', code: 'budget-exceeded' },
    ]);
  });

  it('commits zero decoded aggregate string budget for a late-invalid async exact-4MiB channel', async () => {
    const malformed = success('memory.scope', manyCandidates('memory.scope', 64));
    for (const item of malformed.candidates as Record<string, unknown>[]) item.content = '';
    const last = (malformed.candidates as Record<string, unknown>[]).at(-1)!;
    last.provenance = { ...(last.provenance as Record<string, unknown>), extra: true };
    const base = deepStringBytes(malformed);
    allocateContentBytes([malformed], CANDIDATE_CHANNEL_MAX_AGGREGATE_STRING_BYTES - base);
    expect(deepStringBytes(malformed)).toBe(CANDIDATE_CHANNEL_MAX_AGGREGATE_STRING_BYTES);

    const result = await executeCandidateChannelsV1(
      request({
        plannedChannels: ['memory.scope', 'code.fulltext'],
        limits: { maxCandidatesPerChannel: 64, maxCandidatesAggregate: 128 },
      }),
      roster([
        ['memory.scope', () => Promise.resolve(JSON.stringify(malformed))],
        ['code.fulltext', () => success('code.fulltext', [candidate('code.fulltext', 'tiny-sibling', 1)])],
      ]),
    );
    expect(result.candidates.map((item) => item.evidenceId)).toEqual(['tiny-sibling']);
    expect(result.settlements).toMatchObject([
      { channel: 'memory.scope', code: 'invalid-result' },
      { channel: 'code.fulltext', outcome: 'success', candidateCount: 1 },
    ]);
  });

  it('commits zero candidate aggregate for a rejected channel before admitting a sibling', async () => {
    const result = await executeCandidateChannelsV1(
      request({
        plannedChannels: ['memory.scope', 'code.fulltext'],
        limits: { maxCandidatesPerChannel: 64, maxCandidatesAggregate: 1 },
      }),
      roster([
        ['memory.scope', () => success('memory.scope', manyCandidates('memory.scope', 2))],
        ['code.fulltext', () => success('code.fulltext', [candidate('code.fulltext', 'aggregate-sibling', 1)])],
      ]),
    );
    expect(result.candidates.map((item) => item.evidenceId)).toEqual(['aggregate-sibling']);
    expect(result.settlements).toMatchObject([
      { channel: 'memory.scope', code: 'budget-exceeded' },
      { channel: 'code.fulltext', outcome: 'success', candidateCount: 1 },
    ]);
  });

  it('uses captured string, regexp, numeric, buffer, and date intrinsics after async settlement', async () => {
    const input = request({
      temporalFrame: { mode: 'as-of', asOf: '2026-08-16T00:00:00.000Z' },
    });
    const raw = success('memory.scope', [candidate('memory.scope', 'ambient-primitive', 1, {
      temporalFrame: { mode: 'as-of', asOf: '2026-08-16T00:00:00.000Z' },
    })]);
    const encoded = canonicalCandidateChannelRunnerResultV1(raw, input, 'memory.scope');
    const fulfilled = Promise.resolve(encoded);
    let hooks = 0;
    const define = Object.defineProperty;
    const stringDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'String')!;
    const numberDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Number')!;
    const dateDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Date')!;
    const symbolDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Symbol')!;
    const savedString = String;
    const savedNumber = Number;
    const savedDate = Date;
    const savedSymbol = Symbol;
    const savedApply = Reflect.apply;
    const savedConstruct = Reflect.construct;
    const originals = [
      [String.prototype, 'charCodeAt', String.prototype.charCodeAt],
      [String.prototype, 'slice', String.prototype.slice],
      [String.prototype, 'startsWith', String.prototype.startsWith],
      [String, 'fromCharCode', String.fromCharCode],
      [RegExp.prototype, 'test', RegExp.prototype.test],
      [RegExp.prototype, 'exec', RegExp.prototype.exec],
      [Number, 'parseInt', Number.parseInt],
      [Number, 'isFinite', Number.isFinite],
      [Number, 'isInteger', Number.isInteger],
      [Number, 'isSafeInteger', Number.isSafeInteger],
      [Number.prototype, 'toFixed', Number.prototype.toFixed],
      [Object, 'is', Object.is],
      [Math, 'abs', Math.abs],
      [Buffer, 'byteLength', Buffer.byteLength],
      [Date.prototype, 'getTime', Date.prototype.getTime],
      [Date.prototype, 'toISOString', Date.prototype.toISOString],
    ] as const;
    let installed = false;
    void fulfilled.then(() => {
      for (const [owner, key, original] of originals) {
        define(owner, key, {
          configurable: true,
          writable: true,
          value: function ambientTrap(this: unknown, ...args: unknown[]) {
            hooks += 1;
            return Reflect.apply(original as (...values: unknown[]) => unknown, this, args);
          },
        });
      }
      define(globalThis, 'String', {
        ...stringDescriptor,
        value: function AmbientString(...args: unknown[]) {
          hooks += 1;
          return savedApply(savedString as unknown as (...values: unknown[]) => unknown, undefined, args);
        },
      });
      define(globalThis, 'Number', {
        ...numberDescriptor,
        value: function AmbientNumber(...args: unknown[]) {
          hooks += 1;
          return savedApply(savedNumber as unknown as (...values: unknown[]) => unknown, undefined, args);
        },
      });
      define(globalThis, 'Date', {
        ...dateDescriptor,
        value: function AmbientDate(this: unknown, ...args: unknown[]) {
          hooks += 1;
          return savedConstruct(savedDate, args, new.target ?? savedDate);
        },
      });
      const ambientSymbol = function AmbientSymbol(...args: unknown[]) {
        hooks += 1;
        return savedApply(savedSymbol as unknown as (...values: unknown[]) => unknown, undefined, args);
      };
      define(ambientSymbol, 'species', {
        configurable: true,
        get: () => { hooks += 1; return savedSymbol.species; },
      });
      define(globalThis, 'Symbol', { ...symbolDescriptor, value: ambientSymbol });
      installed = true;
    });
    let result;
    try {
      result = await executeCandidateChannelsV1(
        input,
        roster([['memory.scope', () => fulfilled]]),
      );
    } finally {
      for (const [owner, key, original] of originals) {
        define(owner, key, { configurable: true, writable: true, value: original });
      }
      define(globalThis, 'String', stringDescriptor);
      define(globalThis, 'Number', numberDescriptor);
      define(globalThis, 'Date', dateDescriptor);
      define(globalThis, 'Symbol', symbolDescriptor);
    }
    expect(installed).toBe(true);
    expect(hooks).toBe(0);
    expect(result!.candidates).toMatchObject([{ evidenceId: 'ambient-primitive' }]);
    expect(result!.settlements).toMatchObject([{ outcome: 'success', candidateCount: 1 }]);
  });

  it('uses captured object, reflection, array, collection, iterator, and node-util intrinsics after settlement', async () => {
    const input = request();
    const raw = success('memory.scope', [candidate('memory.scope', 'ambient-structural', 1)]);
    const encoded = canonicalCandidateChannelRunnerResultV1(raw, input, 'memory.scope');
    const fulfilled = Promise.resolve(encoded);
    const hookCounts = new Array(25).fill(0) as number[];
    const define = Object.defineProperty;
    const savedDescriptors = new Map<object, Map<PropertyKey, PropertyDescriptor>>();
    const save = (owner: object, key: PropertyKey): PropertyDescriptor => {
      let entries = savedDescriptors.get(owner);
      if (entries === undefined) {
        entries = new Map();
        savedDescriptors.set(owner, entries);
      }
      const descriptor = Object.getOwnPropertyDescriptor(owner, key)!;
      entries.set(key, descriptor);
      return descriptor;
    };
    const replacements: Array<readonly [object, PropertyKey, (...args: any[]) => unknown]> = [
      [Object, 'create', Object.create],
      [Object, 'freeze', Object.freeze],
      [Object, 'setPrototypeOf', Object.setPrototypeOf],
      [Object, 'getPrototypeOf', Object.getPrototypeOf],
      [Object, 'getOwnPropertyDescriptor', Object.getOwnPropertyDescriptor],
      [Object, 'hasOwn', Object.hasOwn],
      [Reflect, 'ownKeys', Reflect.ownKeys],
      [Array, 'isArray', Array.isArray],
      [ArrayBuffer, 'isView', ArrayBuffer.isView],
      [Array.prototype, 'push', Array.prototype.push],
      [Array.prototype, 'includes', Array.prototype.includes],
      [Array.prototype, 'some', Array.prototype.some],
      [Array.prototype, 'map', Array.prototype.map],
      [Array.prototype, 'filter', Array.prototype.filter],
      [Array.prototype, 'sort', Array.prototype.sort],
      [Array.prototype, Symbol.iterator, Array.prototype[Symbol.iterator]],
      [Set.prototype, 'has', Set.prototype.has],
      [Set.prototype, 'add', Set.prototype.add],
      [WeakSet.prototype, 'has', WeakSet.prototype.has],
      [WeakSet.prototype, 'add', WeakSet.prototype.add],
      [WeakSet.prototype, 'delete', WeakSet.prototype.delete],
      [nodeUtilTypes, 'isProxy', nodeUtilTypes.isProxy],
      [nodeUtilTypes, 'isPromise', nodeUtilTypes.isPromise],
    ];
    for (const [owner, key] of replacements) save(owner, key);
    const setDescriptor = save(globalThis, 'Set');
    const weakSetDescriptor = save(globalThis, 'WeakSet');
    const savedGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
    let installed = false;
    void fulfilled.then(() => {
      for (let index = 0; index < replacements.length; index += 1) {
        const [owner, key, original] = replacements[index]!;
        define(owner, key, {
          configurable: true,
          writable: true,
          value: function ambientTrap(this: unknown, ...args: unknown[]) {
            let relevant = index !== 15;
            if (!relevant && typeof this === 'object' && this !== null) {
              const first = savedGetOwnPropertyDescriptor(this, '0');
              if (first !== undefined && 'value' in first
                && typeof first.value === 'object' && first.value !== null) {
                const channel = savedGetOwnPropertyDescriptor(first.value, 'channel');
                relevant = channel !== undefined && 'value' in channel
                  && channel.value === 'memory.scope';
              }
            }
            if (relevant) hookCounts[index] = hookCounts[index]! + 1;
            return Reflect.apply(original, this, args);
          },
        });
      }
      define(globalThis, 'Set', {
        ...setDescriptor,
        value: class AmbientSet<T> extends Set<T> {
          constructor(values?: readonly T[]) { hookCounts[23] = hookCounts[23]! + 1; super(values); }
        },
      });
      define(globalThis, 'WeakSet', {
        ...weakSetDescriptor,
        value: class AmbientWeakSet<T extends object> extends WeakSet<T> {
          constructor(values?: readonly T[]) { hookCounts[24] = hookCounts[24]! + 1; super(values); }
        },
      });
      installed = true;
    });
    let result;
    try {
      result = await executeCandidateChannelsV1(
        input,
        roster([['memory.scope', () => fulfilled]]),
      );
    } finally {
      for (const [owner, entries] of savedDescriptors) {
        for (const [key, descriptor] of entries) define(owner, key, descriptor);
      }
    }
    expect(installed).toBe(true);
    expect(hookCounts).toEqual(new Array(25).fill(0));
    expect(result!.candidates).toMatchObject([{ evidenceId: 'ambient-structural' }]);
    expect(result!.settlements).toMatchObject([{ outcome: 'success', candidateCount: 1 }]);
  });

  it('does not assimilate inherited then or read inherited optional discriminants after settlement', async () => {
    const input = request({ plannedChannels: ['memory.scope', 'code.fulltext'] });
    const encoded = canonicalCandidateChannelRunnerResultV1(
      success('memory.scope', [candidate('memory.scope', 'prototype-async', 1)]),
      input,
      'memory.scope',
    );
    const fulfilled = Promise.resolve(encoded);
    const define = Object.defineProperty;
    const deleteProperty = Reflect.deleteProperty;
    const thenDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'then');
    const codeDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'code');
    let hooks = 0;
    let installed = false;
    void fulfilled.then(() => {
      define(Object.prototype, 'then', {
        configurable: true,
        get() {
          hooks += 1;
          return (resolve: (value: unknown) => void) => {
            hooks += 1;
            resolve('prototype-assimilated');
          };
        },
      });
      define(Object.prototype, 'code', {
        configurable: true,
        get() { hooks += 1; return undefined; },
      });
      installed = true;
    });
    let result: unknown;
    try {
      result = await executeCandidateChannelsV1(input, roster([
        ['memory.scope', () => fulfilled],
        ['code.fulltext', () => success('code.fulltext', [candidate('code.fulltext', 'prototype-sync', 1)])],
      ]));
    } finally {
      if (thenDescriptor === undefined) deleteProperty(Object.prototype, 'then');
      else define(Object.prototype, 'then', thenDescriptor);
      if (codeDescriptor === undefined) deleteProperty(Object.prototype, 'code');
      else define(Object.prototype, 'code', codeDescriptor);
    }
    expect(installed).toBe(true);
    expect(hooks).toBe(0);
    expect(typeof result).toBe('object');
    expect((result as { candidates: readonly CandidateChannelCandidateV1[] }).candidates
      .map((item) => item.evidenceId)).toEqual(['prototype-async', 'prototype-sync']);
  });

  it('returns only null-prototype deeply frozen records', async () => {
    const result = await executeCandidateChannelsV1(
      request(),
      roster([['memory.scope', () => success('memory.scope', [candidate('memory.scope', 'null-record', 1)])]]),
    );
    const records = [
      result,
      result.request,
      result.request.temporalFrame,
      result.request.limits,
      result.candidates[0],
      result.candidates[0]!.temporalFrame,
      result.candidates[0]!.provenance,
      result.settlements[0],
    ];
    for (const record of records) {
      expect(Object.getPrototypeOf(record)).toBeNull();
      expect(Object.isFrozen(record)).toBe(true);
    }
    expect(Object.isFrozen(result.request.resolvedEntityIds)).toBe(true);
    expect(Object.isFrozen(result.request.plannedChannels)).toBe(true);
    expect(Object.isFrozen(result.candidates)).toBe(true);
    expect(Object.isFrozen(result.settlements)).toBe(true);
  });

  it('deep-copies and freezes candidates so source and returned mutation cannot alter bytes', async () => {
    const rawCandidate = candidate('memory.scope', 'stable', 1);
    const raw = success('memory.scope', [rawCandidate]);
    const result = await executeCandidateChannelsV1(
      request(),
      roster([['memory.scope', () => raw]]),
    );
    const before = JSON.stringify(result);
    rawCandidate.content = 'source-mutated';
    (rawCandidate.provenance as Record<string, unknown>).semanticId = 'source-mutated';
    (raw.candidates as unknown[]).push(candidate('memory.scope', 'late', 2));
    expect(JSON.stringify(result)).toBe(before);
    expect(Object.isFrozen(result.candidates[0])).toBe(true);
    expect(Object.isFrozen(result.candidates[0]!.temporalFrame)).toBe(true);
    expect(Object.isFrozen(result.candidates[0]!.provenance)).toBe(true);
    expect(() => (result.candidates as CandidateChannelCandidateV1[]).push(
      result.candidates[0]!,
    )).toThrow();
    expect(() => {
      (result.candidates[0] as { content: string }).content = 'returned-mutated';
    }).toThrow();
    expect(JSON.stringify(result)).toBe(before);
  });
});

describe('RET-009 executor backstop deadline', () => {
  function hung(): Promise<string> {
    return new Promise<string>(() => undefined);
  }

  it('A1 settles a never-settling runner as timeout while a sibling settles on its own merits', async () => {
    vi.useFakeTimers();
    try {
      const input = request({ plannedChannels: ['memory.scope', 'code.fulltext'] });
      const pending = executeCandidateChannelsV1(input, roster([
        ['memory.scope', () => hung()],
        ['code.fulltext', async (received) => serialized(
          'code.fulltext',
          success('code.fulltext', [candidate('code.fulltext', 'sibling', 1)]),
          received,
        )],
      ]));
      let settled = false;
      void pending.then(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(CANDIDATE_CHANNEL_EXECUTOR_DEADLINE_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);

      const result = await pending;
      expect(result.settlements).toContainEqual(safeFailure('memory.scope', 'timeout'));
      expect(result.settlements).not.toContainEqual(safeFailure('memory.scope', 'query-failed'));
      expect(result.settlements).toContainEqual({
        contractId: CANDIDATE_CHANNEL_CONTRACT_ID,
        contractVersion: CANDIDATE_CHANNEL_CONTRACT_VERSION,
        channel: 'code.fulltext',
        outcome: 'success',
        candidateCount: 1,
      });
      expect(result.candidates.map((item) => item.evidenceId)).toEqual(['sibling']);
      // The policy's executor clause, against the behaviour just observed.
      expect(RETRIEVAL_LATENCY_POLICY_V1.candidateChannelExecutor)
        .toEqual({ boundMs: CANDIDATE_CHANNEL_EXECUTOR_DEADLINE_MS, faultSettlement: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('A2 bounds three hung runners by one deadline, not one deadline each', async () => {
    vi.useFakeTimers();
    try {
      const channels: readonly RetrievalTraceChannel[] = ['memory.scope', 'code.fulltext', 'arch.entity'];
      const pending = executeCandidateChannelsV1(
        request({ plannedChannels: [...channels] }),
        roster(channels.map((channel) => [channel, () => hung()] as const)),
      );
      let settled = false;
      void pending.then(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(CANDIDATE_CHANNEL_EXECUTOR_DEADLINE_MS - 1);
      expect(settled).toBe(false);
      // Attempts are started concurrently, so the whole execution must be bounded
      // by ONE deadline. Arming in the await loop instead would need 3 x deadline.
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);

      const result = await pending;
      expect(result.settlements)
        .toEqual(channels.map((channel) => safeFailure(channel, 'timeout')));
      expect(result.candidates).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('A3 leaves well-behaved runners unchanged and leaks no armed timer', async () => {
    vi.useFakeTimers();
    try {
      const channels: readonly RetrievalTraceChannel[] = [
        'memory.scope', 'code.fulltext', 'arch.entity', 'memory.block', 'memory.graph',
      ];
      const result = await executeCandidateChannelsV1(
        request({ plannedChannels: [...channels] }),
        roster([
          ['memory.scope', async (received) => serialized(
            'memory.scope',
            success('memory.scope', [candidate('memory.scope', 'resolved', 1)]),
            received,
          )],
          ['code.fulltext', async () => { throw new Error('rejected'); }],
          ['arch.entity', () => { throw new Error('sync-throw'); }],
          ['memory.block', () => success('memory.block', [])],
          ['memory.graph', () => new Proxy({}, {})],
        ]),
      );
      expect(result.settlements).toHaveLength(5);
      expect(result.settlements).toContainEqual({
        contractId: CANDIDATE_CHANNEL_CONTRACT_ID,
        contractVersion: CANDIDATE_CHANNEL_CONTRACT_VERSION,
        channel: 'memory.scope',
        outcome: 'success',
        candidateCount: 1,
      });
      expect(result.settlements).toContainEqual({
        contractId: CANDIDATE_CHANNEL_CONTRACT_ID,
        contractVersion: CANDIDATE_CHANNEL_CONTRACT_VERSION,
        channel: 'memory.block',
        outcome: 'success',
        candidateCount: 0,
      });
      expect(result.settlements).toContainEqual(safeFailure('code.fulltext', 'query-failed'));
      expect(result.settlements).toContainEqual(safeFailure('arch.entity', 'query-failed'));
      expect(result.settlements).toContainEqual(safeFailure('memory.graph', 'invalid-result'));
      expect(result.candidates.map((item) => item.evidenceId)).toEqual(['resolved']);
      expect(vi.getTimerCount()).toBe(0);

      // Early-return paths arm nothing at all: startAttempt returns before the
      // pending branch for every one of these runners.
      const early = await executeCandidateChannelsV1(
        request({ plannedChannels: ['memory.scope', 'code.fulltext'] }),
        roster([
          ['memory.scope', () => { throw new Error('sync-throw'); }],
          ['code.fulltext', () => new Proxy({}, {})],
        ]),
      );
      expect(early.settlements).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
