import { describe, expect, it } from 'vitest';

import {
  QUERY_DECOMPOSITION_MAX_CANDIDATES,
  QUERY_DECOMPOSITION_MAX_MULTIPLIER,
  queryDecompositionMultipliersV1,
} from '../query-decomposition.js';

describe('RET-007 query decomposition', () => {
  it.each([
    ['coordination', 'Locate alpha marker and identify omega target'],
    ['semicolon', 'Locate alpha marker; identify omega target'],
    ['colon', 'Locate alpha marker: identify omega target'],
    ['sentence', 'Locate alpha marker. Identify omega target'],
    ['relative', 'Locate alpha marker where omega target exists'],
  ])('supports the closed %s syntax family', (_family, query) => {
    expect(queryDecompositionMultipliersV1(query, [
      { ordinal: 0, content: 'Alpha marker appears with linktoken.' },
      { ordinal: 1, content: 'Omega target appears with linktoken.' },
      { ordinal: 2, content: 'Neutral text uses another token.' },
    ])).toEqual([1.25, 1.25, 1]);
  });

  it('boosts the complementary pair joined by a rare non-query bridge', () => {
    const multipliers = queryDecompositionMultipliersV1(
      'Which record contains alpha marker, and where does that record place omega target?',
      [
        { ordinal: 0, content: 'Alpha marker appears with linktoken.' },
        { ordinal: 1, content: 'Omega target appears with linktoken.' },
        { ordinal: 2, content: 'Neutral text uses another token.' },
      ],
    );
    expect(multipliers).toEqual([
      QUERY_DECOMPOSITION_MAX_MULTIPLIER,
      QUERY_DECOMPOSITION_MAX_MULTIPLIER,
      1,
    ]);
  });

  it('fails closed when splitting, bridge discovery, or complementary coverage is absent', () => {
    expect(queryDecompositionMultipliersV1('Where is alpha marker?', [
      { ordinal: 0, content: 'Alpha marker appears with linktoken.' },
      { ordinal: 1, content: 'Omega target appears with linktoken.' },
    ])).toEqual([1, 1]);
    expect(queryDecompositionMultipliersV1('Find alpha marker and find omega target', [
      { ordinal: 0, content: 'Alpha marker contains linkone.' },
      { ordinal: 1, content: 'Omega target uses linktwo.' },
    ])).toEqual([1, 1]);
    expect(queryDecompositionMultipliersV1('Find alpha marker and find omega target', [
      { ordinal: 0, content: 'Alpha marker and omega target share linktoken.' },
      { ordinal: 1, content: 'Neutral text also has linktoken.' },
    ])).toEqual([1, 1]);
  });

  it('uses candidate content and positional ordinal only and resolves equal pair evidence by ordinal', () => {
    const candidates = [
      { ordinal: 0, content: 'Alpha marker appears with linkone.' },
      { ordinal: 1, content: 'Omega target appears with linkone.' },
      { ordinal: 2, content: 'Alpha marker appears with linktwo.' },
      { ordinal: 3, content: 'Omega target appears with linktwo.' },
    ];
    expect(queryDecompositionMultipliersV1(
      'Locate alpha marker and identify omega target', candidates,
    )).toEqual([1.25, 1.25, 1, 1]);
  });

  it('evaluates overlapping sentence/continuation split proposals deterministically', () => {
    const candidates = [
      { ordinal: 0, content: 'Alpha marker appears with linktoken.' },
      { ordinal: 1, content: 'Omega target appears with linktoken.' },
    ];
    const query = 'Locate alpha marker. Then identify omega target';
    const first = queryDecompositionMultipliersV1(query, candidates);
    const second = queryDecompositionMultipliersV1(query, candidates);
    expect(first).toEqual([1.25, 1.25]);
    expect(second).toEqual(first);
  });

  it('is bounded and returns exact identity multipliers for invalid candidate windows', () => {
    const oversized = Array.from({ length: QUERY_DECOMPOSITION_MAX_CANDIDATES + 1 }, (_, ordinal) => ({
      ordinal,
      content: 'bounded neutral content',
    }));
    expect(queryDecompositionMultipliersV1('first clause and second clause', oversized))
      .toEqual([]);
    expect(queryDecompositionMultipliersV1('first clause and second clause', [
      { ordinal: 0, content: 'first shared linktoken' },
      { ordinal: 0, content: 'second shared linktoken' },
    ])).toEqual([1, 1]);
  });

  it('rejects malformed requests with more than two disjoint clause boundaries', () => {
    expect(queryDecompositionMultipliersV1(
      'Locate alpha marker and identify omega target then confirm sigma value',
      [
        { ordinal: 0, content: 'Alpha marker appears with linktoken.' },
        { ordinal: 1, content: 'Omega target appears with linktoken.' },
      ],
    )).toEqual([1, 1]);
  });

  it('does not boost a full-chain candidate paired with one clause-specific candidate', () => {
    expect(queryDecompositionMultipliersV1(
      'Locate alpha marker and identify omega target',
      [
        { ordinal: 0, content: 'Alpha marker and omega target share linktoken.' },
        { ordinal: 1, content: 'Omega target also uses linktoken.' },
      ],
    )).toEqual([1, 1]);
  });

  it.each([
    ['identify', 'name'],
    ['give', 'state'],
    ['made', 'identify'],
  ])('keeps neutral task verbs %s/%s out of the grammatical stopword set', (left, right) => {
    expect(queryDecompositionMultipliersV1(`${left} alpha and ${right} omega`, [
      { ordinal: 0, content: `${left} alpha linktoken` },
      { ordinal: 1, content: `${right} omega linktoken` },
    ])).toEqual([1.25, 1.25]);
  });

  it('never invokes inherited numeric accessors while producing exact own multiplier slots', () => {
    const candidates = [
      { ordinal: 0, content: 'Alpha marker appears with linktoken.' },
      { ordinal: 1, content: 'Omega target appears with linktoken.' },
      { ordinal: 2, content: 'Neutral text uses another token.' },
    ];
    const originals = new Map<number, PropertyDescriptor | undefined>();
    let callbacks = 0;
    let multipliers: readonly number[] | undefined;
    try {
      for (let index = 0; index <= QUERY_DECOMPOSITION_MAX_CANDIDATES; index += 1) {
        originals.set(index, Object.getOwnPropertyDescriptor(Array.prototype, index));
        Object.defineProperty(Array.prototype, index, {
          configurable: true,
          get: () => { callbacks += 1; return 999; },
          set: () => { callbacks += 1; },
        });
      }
      multipliers = queryDecompositionMultipliersV1(
        'Locate alpha marker and identify omega target', candidates,
      );
    } finally {
      for (let index = 0; index <= QUERY_DECOMPOSITION_MAX_CANDIDATES; index += 1) {
        const original = originals.get(index);
        if (original) Object.defineProperty(Array.prototype, index, original);
        else delete (Array.prototype as unknown as Record<number, unknown>)[index];
      }
    }
    expect(callbacks).toBe(0);
    if (!multipliers) throw new Error('expected bounded multiplier vector');
    expect(multipliers).toEqual([1.25, 1.25, 1]);
    expect(multipliers).toHaveLength(candidates.length);
    for (let index = 0; index < candidates.length; index += 1) {
      expect(Object.getOwnPropertyDescriptor(multipliers, index)).toMatchObject({
        value: index < 2 ? 1.25 : 1,
      });
    }
  });

  it('fails closed without throwing for accessors, hostile proxies, revoked proxies, and hostile lengths', () => {
    let accessorCalls = 0;
    const accessorCandidate = Object.defineProperties({}, {
      ordinal: { enumerable: true, value: 0 },
      content: { enumerable: true, get: () => { accessorCalls += 1; throw new Error('forbidden'); } },
    });
    const ordinary = { ordinal: 1, content: 'Omega target appears with linktoken.' };
    expect(() => queryDecompositionMultipliersV1(
      'Locate alpha marker and identify omega target', [accessorCandidate, ordinary] as never,
    )).not.toThrow();
    expect(queryDecompositionMultipliersV1(
      'Locate alpha marker and identify omega target', [accessorCandidate, ordinary] as never,
    )).toEqual([1, 1]);
    const ordinalAccessor = Object.defineProperties({}, {
      content: { enumerable: true, value: 'Alpha marker appears with linktoken.' },
      ordinal: { enumerable: true, get: () => { accessorCalls += 1; throw new Error('forbidden'); } },
    });
    expect(queryDecompositionMultipliersV1(
      'Locate alpha marker and identify omega target', [ordinalAccessor, ordinary] as never,
    )).toEqual([1, 1]);
    const candidateArrayAccessor = new Array(2);
    Object.defineProperty(candidateArrayAccessor, 0, {
      enumerable: true,
      get: () => { accessorCalls += 1; throw new Error('forbidden'); },
    });
    Object.defineProperty(candidateArrayAccessor, 1, { enumerable: true, value: ordinary });
    expect(queryDecompositionMultipliersV1(
      'Locate alpha marker and identify omega target', candidateArrayAccessor,
    )).toEqual([1, 1]);
    expect(accessorCalls).toBe(0);

    const dense = [
      { ordinal: 0, content: 'Alpha marker appears with linktoken.' },
      ordinary,
    ];
    let proxyTraps = 0;
    const throwingGet = new Proxy(dense, {
      get: () => { proxyTraps += 1; throw new Error('forbidden get'); },
      getOwnPropertyDescriptor: () => { proxyTraps += 1; throw new Error('forbidden descriptor'); },
    });
    expect(() => queryDecompositionMultipliersV1(
      'Locate alpha marker and identify omega target', throwingGet,
    )).not.toThrow();
    expect(queryDecompositionMultipliersV1(
      'Locate alpha marker and identify omega target', throwingGet,
    )).toEqual([]);
    expect(proxyTraps).toBe(0);

    const candidateProxy = new Proxy(dense[0]!, {
      get: () => { proxyTraps += 1; throw new Error('forbidden candidate get'); },
      getOwnPropertyDescriptor: () => {
        proxyTraps += 1;
        throw new Error('forbidden candidate descriptor');
      },
    });
    expect(queryDecompositionMultipliersV1(
      'Locate alpha marker and identify omega target', [candidateProxy, ordinary],
    )).toEqual([1, 1]);
    expect(proxyTraps).toBe(0);

    const revoked = Proxy.revocable(dense, {});
    revoked.revoke();
    expect(() => queryDecompositionMultipliersV1(
      'Locate alpha marker and identify omega target', revoked.proxy,
    )).not.toThrow();
    expect(queryDecompositionMultipliersV1(
      'Locate alpha marker and identify omega target', revoked.proxy,
    )).toEqual([]);
    expect(queryDecompositionMultipliersV1(
      'Locate alpha marker and identify omega target', new Array(1_000_000) as never,
    )).toEqual([]);
  });
});
