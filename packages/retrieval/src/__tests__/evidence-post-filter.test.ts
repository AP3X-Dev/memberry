import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import type { CandidateChannelRequestV1 } from '../candidate-channel.js';
import {
  EVIDENCE_POST_FILTER_CONTRACT_ID,
  EVIDENCE_POST_FILTER_CONTRACT_VERSION,
  EVIDENCE_POST_FILTER_MAX_CANDIDATES,
  EvidencePostFilterContractError,
  applyEvidencePostFilterV1,
  type EvidenceEligibilityReceiptV1,
} from '../evidence-post-filter.js';

const MAX_TENANT_ID_BYTES = 128;
const MAX_PROJECT_SCOPE_BYTES = 136;
const MAX_ENTITY_ID_BYTES = 200;
const MAX_EVIDENCE_ID_BYTES = 200;

function request(
  overrides: Partial<CandidateChannelRequestV1> = {},
): CandidateChannelRequestV1 {
  return {
    contractId: 'memberry.candidate-channel',
    contractVersion: '1.0.0',
    tenantId: 'tenant-a',
    projectScope: 'project:memberry',
    resolvedEntityIds: ['entity-a', 'entity-b'],
    temporalFrame: { mode: 'current' },
    plannedChannels: ['memory.scope', 'memory.fact'],
    limits: { maxCandidatesPerChannel: 64, maxCandidatesAggregate: 512 },
    ...overrides,
  };
}

function receipt(
  overrides: Partial<EvidenceEligibilityReceiptV1> = {},
): EvidenceEligibilityReceiptV1 {
  return {
    contractId: 'memberry.evidence-post-filter',
    version: '1.0.0',
    tenantId: 'tenant-a',
    projectScope: 'project:memberry',
    resolvedEntityId: 'entity-a',
    temporalFrame: { mode: 'current' },
    sourceType: 'semantic',
    evidenceId: 'evidence-a',
    lifecycle: 'active',
    temporal: 'in-frame',
    supersession: 'clear',
    contradiction: 'clear',
    ...overrides,
  };
}

function candidate<T>(value: T, overrides: Partial<EvidenceEligibilityReceiptV1> = {}) {
  return { value, receipt: receipt(overrides) };
}

function expectFailure(
  run: () => unknown,
  code: 'invalid-request' | 'invalid-receipt' | 'budget-exceeded',
): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(EvidencePostFilterContractError);
  expect(thrown).toMatchObject({ name: 'EvidencePostFilterContractError', code, message: code });
  expect(String(thrown)).toBe(`EvidencePostFilterContractError: ${code}`);
}

function expectExactFrozenRecord(value: object, keys: readonly string[]): void {
  expect(Object.getPrototypeOf(value)).toBeNull();
  expect(Reflect.ownKeys(value)).toEqual(keys);
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of keys) {
    expect(Object.getOwnPropertyDescriptor(value, key)).toMatchObject({
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
}

describe('applyEvidencePostFilterV1', () => {
  it('preserves eligible caller order and exact opaque value identity', () => {
    const first = { id: 1 };
    const second = Object.create(null) as { id?: number };
    second.id = 2;

    const result = applyEvidencePostFilterV1({
      request: request(),
      candidates: [
        candidate(first, { evidenceId: 'evidence-1' }),
        candidate(second, { evidenceId: 'evidence-2' }),
      ],
    });

    expect(result).toEqual({
      contractId: EVIDENCE_POST_FILTER_CONTRACT_ID,
      version: EVIDENCE_POST_FILTER_CONTRACT_VERSION,
      included: [
        { ref: 'p0000', value: first },
        { ref: 'p0001', value: second },
      ],
      decisions: [
        { ref: 'p0000', outcome: 'included' },
        { ref: 'p0001', outcome: 'included' },
      ],
    });
    expect(result.included[0]!.value).toBe(first);
    expect(result.included[1]!.value).toBe(second);
  });

  it('applies inactive, stale, contradictory, duplicate, included precedence exactly', () => {
    const result = applyEvidencePostFilterV1({
      request: request(),
      candidates: [
        candidate({ score: Number.MAX_VALUE }, {
          evidenceId: 'shared-inactive', lifecycle: 'inactive', temporal: 'out-of-frame',
          supersession: 'superseded', contradiction: 'withheld',
        }),
        candidate({ score: Number.MAX_VALUE }, {
          evidenceId: 'shared-inactive',
        }),
        candidate({ score: Number.MAX_VALUE }, {
          evidenceId: 'shared-stale', temporal: 'out-of-frame', contradiction: 'withheld',
        }),
        candidate({ score: Number.MAX_VALUE }, {
          evidenceId: 'shared-stale', supersession: 'superseded', contradiction: 'withheld',
        }),
        candidate({ score: Number.MAX_VALUE }, {
          evidenceId: 'shared-contradiction', contradiction: 'withheld',
        }),
        candidate({ score: Number.MAX_VALUE }, {
          evidenceId: 'shared-contradiction',
        }),
        candidate({ score: Number.MAX_VALUE }, {
          evidenceId: 'shared-contradiction',
        }),
      ],
    });

    expect(result.included.map((entry) => entry.ref)).toEqual(['p0001', 'p0005']);
    expect(result.decisions).toEqual([
      { ref: 'p0000', outcome: 'excluded', reason: 'inactive' },
      { ref: 'p0001', outcome: 'included' },
      { ref: 'p0002', outcome: 'excluded', reason: 'stale' },
      { ref: 'p0003', outcome: 'excluded', reason: 'stale' },
      { ref: 'p0004', outcome: 'excluded', reason: 'contradictory' },
      { ref: 'p0005', outcome: 'included' },
      { ref: 'p0006', outcome: 'excluded', reason: 'duplicate', duplicateOfRef: 'p0005' },
    ]);
  });

  it('does not let inherited index-0 setters substitute an inactive candidate', () => {
    const defineProperty = Object.defineProperty;
    const getDescriptor = Object.getOwnPropertyDescriptor;
    const deleteProperty = Reflect.deleteProperty;
    const prototypeCases = [
      { name: 'Array.prototype', target: Array.prototype },
      { name: 'Object.prototype', target: Object.prototype },
    ];
    const results: Array<{
      name: string;
      hooks: number;
      outcome: unknown;
    }> = [];

    for (const prototypeCase of prototypeCases) {
      const inactiveCandidate = candidate('inactive-value', {
        evidenceId: 'inactive-only',
        lifecycle: 'inactive' as const,
      });
      const input = {
        request: request(),
        candidates: [inactiveCandidate],
      };
      const activeSubstitute = candidate('forged-active', {
        evidenceId: 'forged-active',
      });
      const previous = getDescriptor(prototypeCase.target, '0');
      const previousArrayLength = getDescriptor(Array.prototype, 'length')!;
      let hooks = 0;
      let outcome: unknown;
      try {
        defineProperty(prototypeCase.target, '0', {
          configurable: true,
          set(value: unknown) {
            hooks += 1;
            defineProperty(this, '0', {
              value: value === inactiveCandidate ? activeSubstitute : value,
              enumerable: true,
              writable: true,
              configurable: true,
            });
          },
        });
        try {
          outcome = applyEvidencePostFilterV1(input);
        } catch (error) {
          outcome = error;
        }
      } finally {
        if (previous === undefined) deleteProperty(prototypeCase.target, '0');
        else defineProperty(prototypeCase.target, '0', previous);
        defineProperty(Array.prototype, 'length', previousArrayLength);
      }
      defineProperty(results, results.length, {
        value: { name: prototypeCase.name, hooks, outcome },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }

    for (const result of results) {
      expect(result.hooks, result.name).toBe(0);
      expect(result.outcome, result.name).toBeInstanceOf(EvidencePostFilterContractError);
      expect(result.outcome, result.name).toMatchObject({
        name: 'EvidencePostFilterContractError',
        code: 'invalid-request',
        message: 'invalid-request',
      });
    }
  });

  it('fails closed before inherited index-511 setters can drop any of 512 candidates', () => {
    const defineProperty = Object.defineProperty;
    const getDescriptor = Object.getOwnPropertyDescriptor;
    const deleteProperty = Reflect.deleteProperty;
    const prototypeCases = [
      { name: 'Array.prototype', target: Array.prototype },
      { name: 'Object.prototype', target: Object.prototype },
    ];
    const results: Array<{
      name: string;
      hooks: number;
      outcome: unknown;
    }> = [];

    for (const prototypeCase of prototypeCases) {
      const candidates = Array.from({ length: EVIDENCE_POST_FILTER_MAX_CANDIDATES }, (_, index) =>
        candidate(index, { evidenceId: `setter-${index}` }),
      );
      const previous = getDescriptor(prototypeCase.target, '511');
      const previousArrayLength = getDescriptor(Array.prototype, 'length')!;
      let hooks = 0;
      let outcome: unknown;
      try {
        defineProperty(prototypeCase.target, '511', {
          configurable: true,
          set(value: unknown) {
            hooks += 1;
            defineProperty(this, '511', {
              value,
              enumerable: true,
              writable: true,
              configurable: true,
            });
          },
        });
        try {
          outcome = applyEvidencePostFilterV1({
            request: request(),
            candidates,
          });
        } catch (error) {
          outcome = error;
        }
      } finally {
        if (previous === undefined) deleteProperty(prototypeCase.target, '511');
        else defineProperty(prototypeCase.target, '511', previous);
        defineProperty(Array.prototype, 'length', previousArrayLength);
      }
      defineProperty(results, results.length, {
        value: { name: prototypeCase.name, hooks, outcome },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }

    for (const result of results) {
      expect(result.hooks, result.name).toBe(0);
      expect(result.outcome, result.name).toBeInstanceOf(EvidencePostFilterContractError);
      expect(result.outcome, result.name).toMatchObject({
        name: 'EvidencePostFilterContractError',
        code: 'invalid-request',
        message: 'invalid-request',
      });
    }
  });

  it('fails closed before an inserted Array prototype-chain setter can run', () => {
    const getPrototypeOf = Object.getPrototypeOf;
    const setPrototypeOf = Object.setPrototypeOf;
    const previous = getPrototypeOf(Array.prototype);
    const sibling = Object.create(previous) as object;
    let hooks = 0;
    let outcome: unknown;
    Object.defineProperty(sibling, '0', {
      configurable: true,
      set() {
        hooks += 1;
        throw new Error('must not run');
      },
    });
    try {
      setPrototypeOf(Array.prototype, sibling);
      try {
        outcome = applyEvidencePostFilterV1({
          request: request(),
          candidates: [candidate('inactive', { lifecycle: 'inactive' })],
        });
      } catch (error) {
        outcome = error;
      }
    } finally {
      setPrototypeOf(Array.prototype, previous);
    }
    expect(hooks).toBe(0);
    expect(outcome).toBeInstanceOf(EvidencePostFilterContractError);
    expect(outcome).toMatchObject({
      name: 'EvidencePostFilterContractError',
      code: 'invalid-request',
      message: 'invalid-request',
    });
  });
  it('returns an empty included array when every receipt is withheld', () => {
    const result = applyEvidencePostFilterV1({
      request: request(),
      candidates: [
        candidate('secret-a', { evidenceId: 'a', contradiction: 'withheld' }),
        candidate('secret-b', { evidenceId: 'b', contradiction: 'withheld' }),
      ],
    });
    expect(result.included).toEqual([]);
    expect(result.decisions).toEqual([
      { ref: 'p0000', outcome: 'excluded', reason: 'contradictory' },
      { ref: 'p0001', outcome: 'excluded', reason: 'contradictory' },
    ]);
  });

  it('deduplicates a structural tenant/project/source/evidence tuple only', () => {
    const result = applyEvidencePostFilterV1({
      request: request({
        plannedChannels: ['memory.scope', 'memory.fact'],
      }),
      candidates: [
        candidate('semantic-first', { evidenceId: 'constructor', resolvedEntityId: 'entity-a' }),
        candidate('semantic-second-entity', { evidenceId: 'constructor', resolvedEntityId: 'entity-b' }),
        candidate('fact-same-bare-id', {
          sourceType: 'fact', evidenceId: 'constructor', resolvedEntityId: 'entity-a',
        }),
      ],
    });
    expect(result.included.map((entry) => entry.value)).toEqual([
      'semantic-first', 'fact-same-bare-id',
    ]);
    expect(result.decisions[1]).toEqual({
      ref: 'p0001', outcome: 'excluded', reason: 'duplicate', duplicateOfRef: 'p0000',
    });
  });

  it('does not seed deduplication with earlier inactive, stale, or contradictory evidence', () => {
    const result = applyEvidencePostFilterV1({
      request: request(),
      candidates: [
        candidate(0, { evidenceId: 'inactive', lifecycle: 'inactive' }),
        candidate(1, { evidenceId: 'inactive' }),
        candidate(2, { evidenceId: 'stale', temporal: 'out-of-frame' }),
        candidate(3, { evidenceId: 'stale' }),
        candidate(4, { evidenceId: 'withheld', contradiction: 'withheld' }),
        candidate(5, { evidenceId: 'withheld' }),
      ],
    });
    expect(result.included.map((entry) => entry.ref)).toEqual(['p0001', 'p0003', 'p0005']);
  });

  it('rejects every authority mismatch transactionally with no value exposure', () => {
    const mismatches: Array<Partial<EvidenceEligibilityReceiptV1>> = [
      { tenantId: 'tenant-b' },
      { projectScope: 'project:foreign' },
      { resolvedEntityId: 'entity-foreign' },
      { temporalFrame: { mode: 'as-of', asOf: '2026-08-17T00:00:00.000Z' } },
      { sourceType: 'episodic' },
    ];
    for (const mismatch of mismatches) {
      expectFailure(() => applyEvidencePostFilterV1({
        request: request(),
        candidates: [candidate('would-have-passed', { evidenceId: 'first' }), candidate('late', mismatch)],
      }), 'invalid-receipt');
    }
  });

  it('accepts exact as-of authority and rejects mode or instant drift', () => {
    const asOf = '2026-08-17T00:00:00.000Z';
    const accepted = applyEvidencePostFilterV1({
      request: request({ temporalFrame: { mode: 'as-of', asOf } }),
      candidates: [candidate('accepted', { temporalFrame: { mode: 'as-of', asOf } })],
    });
    expect(accepted.included[0]!.value).toBe('accepted');

    expectFailure(() => applyEvidencePostFilterV1({
      request: request({ temporalFrame: { mode: 'as-of', asOf } }),
      candidates: [candidate('rejected', { temporalFrame: { mode: 'current' } })],
    }), 'invalid-receipt');
    expectFailure(() => applyEvidencePostFilterV1({
      request: request({ temporalFrame: { mode: 'as-of', asOf } }),
      candidates: [candidate('rejected', {
        temporalFrame: { mode: 'as-of', asOf: '2026-08-17T00:00:00.001Z' },
      })],
    }), 'invalid-receipt');
  });

  it('accepts all source types only when the request plans an authoritative source channel', () => {
    const cases = [
      ['semantic', 'memory.scope'],
      ['episodic', 'memory.episodic-vector'],
      ['symbol', 'code.fulltext'],
      ['arch_entity', 'arch.entity'],
      ['aspect', 'arch.aspect'],
      ['fact', 'memory.fact'],
      ['block', 'memory.block'],
    ] as const;
    for (const [sourceType, plannedChannel] of cases) {
      const result = applyEvidencePostFilterV1({
        request: request({ plannedChannels: [plannedChannel] }),
        candidates: [candidate(sourceType, { sourceType })],
      });
      expect(result.included[0]!.value).toBe(sourceType);
    }
  });

  it('accepts persisted Nano IDs without widening authority identifiers', () => {
    const accepted = applyEvidencePostFilterV1({
      request: request({
        plannedChannels: ['memory.episodic-vector', 'memory.block'],
      }),
      candidates: [
        candidate('episode', { sourceType: 'episodic', evidenceId: '_episode' }),
        candidate('block', { sourceType: 'block', evidenceId: '-block' }),
      ],
    });

    expect(accepted.included.map((entry) => entry.value)).toEqual(['episode', 'block']);
    expectFailure(() => applyEvidencePostFilterV1({
      request: request(),
      candidates: [candidate('unsafe', { evidenceId: '.not-an-id' })],
    }), 'invalid-receipt');
  });

  it('supports 512 candidates and rejects 513 before processing candidates', () => {
    const values = Array.from({ length: EVIDENCE_POST_FILTER_MAX_CANDIDATES }, (_, index) => ({ index }));
    const candidates = values.map((value, index) => candidate(value, { evidenceId: `e-${index}` }));
    const accepted = applyEvidencePostFilterV1({ request: request(), candidates });
    expect(accepted.included).toHaveLength(512);
    expect(accepted.decisions).toHaveLength(512);
    expect(accepted.included[511]).toEqual({ ref: 'p0511', value: values[511] });

    const hook = { count: 0 };
    const late = {} as Record<string, unknown>;
    Object.defineProperty(late, 'value', { enumerable: true, get: () => { hook.count += 1; } });
    Object.defineProperty(late, 'receipt', { enumerable: true, value: receipt({ evidenceId: 'overflow' }) });
    expectFailure(() => applyEvidencePostFilterV1({
      request: request(), candidates: [...candidates, late],
    }), 'budget-exceeded');
    expect(hook.count).toBe(0);

    expectFailure(() => applyEvidencePostFilterV1({
      request: request({ limits: { maxCandidatesPerChannel: 64, maxCandidatesAggregate: 1 } }),
      candidates: [candidate('a', { evidenceId: 'a' }), candidate('b', { evidenceId: 'b' })],
    }), 'budget-exceeded');
  });

  it('reuses the request parser 32-ID cap and its closed grammar', () => {
    const ids32 = Array.from({ length: 32 }, (_, index) => `entity-${index}`);
    const accepted = applyEvidencePostFilterV1({
      request: request({ resolvedEntityIds: ids32 }),
      candidates: [candidate('ok', { resolvedEntityId: ids32[31] })],
    });
    expect(accepted.included[0]!.value).toBe('ok');
    const ids33 = [...ids32, 'entity-32'];
    expectFailure(() => applyEvidencePostFilterV1({
      request: request({ resolvedEntityIds: ids33 }), candidates: [],
    }), 'invalid-request');
    expectFailure(() => applyEvidencePostFilterV1({
      request: { ...request(), surprise: true }, candidates: [],
    }), 'invalid-request');
  });

  it('enforces exact existing authority/evidence byte caps at N and N+1', () => {
    const tenantN = 't'.repeat(MAX_TENANT_ID_BYTES);
    const projectN = `project:${'p'.repeat(MAX_PROJECT_SCOPE_BYTES - 8)}`;
    const entityN = `e${'x'.repeat(MAX_ENTITY_ID_BYTES - 1)}`;
    const evidenceN = `i${'x'.repeat(MAX_EVIDENCE_ID_BYTES - 1)}`;
    const accepted = applyEvidencePostFilterV1({
      request: request({
        tenantId: tenantN, projectScope: projectN, resolvedEntityIds: [entityN],
      }),
      candidates: [candidate('ok', {
        tenantId: tenantN, projectScope: projectN, resolvedEntityId: entityN, evidenceId: evidenceN,
      })],
    });
    expect(accepted.included[0]!.value).toBe('ok');

    expectFailure(() => applyEvidencePostFilterV1({
      request: request(),
      candidates: [candidate('no', { evidenceId: `i${'x'.repeat(MAX_EVIDENCE_ID_BYTES)}` })],
    }), 'budget-exceeded');
    expectFailure(() => applyEvidencePostFilterV1({
      request: request(),
      candidates: [candidate('no', { resolvedEntityId: `e${'x'.repeat(MAX_ENTITY_ID_BYTES)}` })],
    }), 'budget-exceeded');
    expectFailure(() => applyEvidencePostFilterV1({
      request: request(),
      candidates: [candidate('no', { tenantId: 't'.repeat(MAX_TENANT_ID_BYTES + 1) })],
    }), 'budget-exceeded');
    expectFailure(() => applyEvidencePostFilterV1({
      request: request(),
      candidates: [candidate('no', { projectScope: `project:${'p'.repeat(MAX_PROJECT_SCOPE_BYTES - 7)}` })],
    }), 'budget-exceeded');
    expectFailure(() => applyEvidencePostFilterV1({
      request: request({ tenantId: 't'.repeat(MAX_TENANT_ID_BYTES + 1) }), candidates: [],
    }), 'invalid-request');
    expectFailure(() => applyEvidencePostFilterV1({
      request: request({ projectScope: `project:${'p'.repeat(MAX_PROJECT_SCOPE_BYTES - 7)}` }), candidates: [],
    }), 'invalid-request');
    expectFailure(() => applyEvidencePostFilterV1({
      request: request({ resolvedEntityIds: [`e${'x'.repeat(MAX_ENTITY_ID_BYTES)}`] }), candidates: [],
    }), 'invalid-request');
    expectFailure(() => applyEvidencePostFilterV1({
      request: request({ temporalFrame: { mode: 'current' } }),
      candidates: [candidate('no', {
        temporalFrame: { mode: 'as-of', asOf: 'x'.repeat(33) },
      })],
    }), 'budget-exceeded');
    expectFailure(() => applyEvidencePostFilterV1({
      request: request(), candidates: [candidate('no', { evidenceId: '\ud800' })],
    }), 'invalid-receipt');
  });

  it('rejects every oversized malformed receipt field without scanning its Unicode code units', async () => {
    const originalCharCodeAt = String.prototype.charCodeAt;
    let target = '';
    let targetScans = 0;
    String.prototype.charCodeAt = function countedCharCodeAt(this: string, index: number): number {
      if (this === target) targetScans += 1;
      return originalCharCodeAt.call(this, index);
    };
    vi.resetModules();
    let dynamicContract: typeof import('../evidence-post-filter.js');
    try {
      dynamicContract = await import('../evidence-post-filter.js');
    } finally {
      String.prototype.charCodeAt = originalCharCodeAt;
    }

    const oversizedMalformed = (maxBytes: number): string => `${'a'.repeat(maxBytes + 1)}\ud800`;
    const cases: Array<{ maxBytes: number; overrides: Partial<EvidenceEligibilityReceiptV1> }> = [
      { maxBytes: 64, overrides: { sourceType: '' as never } },
      { maxBytes: 32, overrides: { temporalFrame: { mode: 'as-of', asOf: '' } } },
      { maxBytes: MAX_TENANT_ID_BYTES, overrides: { tenantId: '' } },
      { maxBytes: MAX_PROJECT_SCOPE_BYTES, overrides: { projectScope: '' } },
      { maxBytes: MAX_ENTITY_ID_BYTES, overrides: { resolvedEntityId: '' } },
      { maxBytes: MAX_EVIDENCE_ID_BYTES, overrides: { evidenceId: '' } },
    ];

    try {
      target = `a\ud800`;
      targetScans = 0;
      let malformedThrown: unknown;
      try {
        dynamicContract.applyEvidencePostFilterV1({
          request: request(),
          candidates: [candidate('no', { evidenceId: target })],
        });
      } catch (error) {
        malformedThrown = error;
      }
      expect(malformedThrown).toMatchObject({ code: 'invalid-receipt' });
      expect(targetScans).toBeGreaterThan(0);

      for (const entry of cases) {
        target = oversizedMalformed(entry.maxBytes);
        targetScans = 0;
        const overrides = { ...entry.overrides } as Record<string, unknown>;
        if ('sourceType' in overrides) overrides.sourceType = target;
        if ('temporalFrame' in overrides) overrides.temporalFrame = { mode: 'as-of', asOf: target };
        if ('tenantId' in overrides) overrides.tenantId = target;
        if ('projectScope' in overrides) overrides.projectScope = target;
        if ('resolvedEntityId' in overrides) overrides.resolvedEntityId = target;
        if ('evidenceId' in overrides) overrides.evidenceId = target;

        let thrown: unknown;
        try {
          dynamicContract.applyEvidencePostFilterV1({
            request: request(),
            candidates: [candidate('no', overrides as Partial<EvidenceEligibilityReceiptV1>)],
          });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toMatchObject({ code: 'budget-exceeded' });
        expect(targetScans).toBe(0);
      }
    } finally {
      vi.resetModules();
    }
  });

  it('accepts ordinary or null-prototype closed records and candidate arrays', () => {
    const temporalFrame = Object.assign(Object.create(null), { mode: 'current' as const });
    const structuralReceipt = Object.assign(Object.create(null), receipt({ temporalFrame }));
    const wrapper = Object.assign(Object.create(null), { value: 'opaque', receipt: structuralReceipt });
    const candidates = [wrapper];
    Object.setPrototypeOf(candidates, null);
    const root = Object.assign(Object.create(null), { request: request(), candidates });
    const result = applyEvidencePostFilterV1(root);
    expect(result.included[0]!.value).toBe('opaque');
  });

  it('rejects malformed roots, candidate wrappers, receipts, and temporal frames with fixed codes', () => {
    const invalidRequests: unknown[] = [
      null,
      [],
      { request: request() },
      { request: request(), candidates: [], extra: true },
      Object.create({ request: request(), candidates: [] }),
      { request: request(), candidates: [,] },
    ];
    for (const input of invalidRequests) {
      expectFailure(() => applyEvidencePostFilterV1(input), 'invalid-request');
    }

    const invalidReceipts: unknown[] = [
      null,
      [],
      { ...receipt(), extra: true },
      { ...receipt(), version: '2.0.0' },
      { ...receipt(), lifecycle: 'deleted' },
      { ...receipt(), temporal: 'unknown' },
      { ...receipt(), supersession: 'unknown' },
      { ...receipt(), contradiction: 'unknown' },
      { ...receipt(), temporalFrame: { mode: 'current', asOf: '2026-08-17T00:00:00.000Z' } },
      { ...receipt(), temporalFrame: { mode: 'as-of' } },
      { ...receipt(), temporalFrame: { mode: 'as-of', asOf: 'not-an-instant' } },
      Object.create(receipt()),
    ];
    for (const invalid of invalidReceipts) {
      expectFailure(() => applyEvidencePostFilterV1({
        request: request(), candidates: [{ value: 'opaque', receipt: invalid }],
      }), 'invalid-receipt');
    }
  });

  it('rejects symbols, accessors, proxies, revoked proxies, unsafe prototypes, and duplicate wrappers', () => {
    const symbolRoot = { request: request(), candidates: [] } as Record<PropertyKey, unknown>;
    symbolRoot[Symbol('extra')] = true;
    expectFailure(() => applyEvidencePostFilterV1(symbolRoot), 'invalid-request');

    let rootGetterCalls = 0;
    const accessorRoot = { candidates: [] } as Record<string, unknown>;
    Object.defineProperty(accessorRoot, 'request', {
      enumerable: true,
      get: () => { rootGetterCalls += 1; return request(); },
    });
    expectFailure(() => applyEvidencePostFilterV1(accessorRoot), 'invalid-request');
    expect(rootGetterCalls).toBe(0);

    let rootProxyGets = 0;
    const rootProxy = new Proxy({ request: request(), candidates: [] }, {
      get: () => { rootProxyGets += 1; throw new Error('root trap'); },
    });
    expectFailure(() => applyEvidencePostFilterV1(rootProxy), 'invalid-request');
    expect(rootProxyGets).toBe(0);

    let wrapperProxyGets = 0;
    const wrapperProxy = new Proxy(candidate('opaque'), {
      get: () => { wrapperProxyGets += 1; throw new Error('wrapper trap'); },
    });
    expectFailure(() => applyEvidencePostFilterV1({
      request: request(), candidates: [wrapperProxy],
    }), 'invalid-request');
    expect(wrapperProxyGets).toBe(0);

    let proxyGets = 0;
    const proxyReceipt = new Proxy(receipt(), { get: () => { proxyGets += 1; throw new Error('trap'); } });
    expectFailure(() => applyEvidencePostFilterV1({
      request: request(), candidates: [{ value: 'opaque', receipt: proxyReceipt }],
    }), 'invalid-receipt');
    expect(proxyGets).toBe(0);

    const revoked = Proxy.revocable(receipt(), {});
    revoked.revoke();
    expectFailure(() => applyEvidencePostFilterV1({
      request: request(), candidates: [{ value: 'opaque', receipt: revoked.proxy }],
    }), 'invalid-receipt');

    const wrapper = candidate('once');
    expectFailure(() => applyEvidencePostFilterV1({
      request: request(), candidates: [wrapper, wrapper],
    }), 'invalid-request');

    let iteratorCalls = 0;
    const candidatesWithIterator = [candidate('opaque')] as unknown[] & Record<PropertyKey, unknown>;
    Object.defineProperty(candidatesWithIterator, Symbol.iterator, {
      enumerable: false,
      get: () => { iteratorCalls += 1; throw new Error('iterator trap'); },
    });
    expectFailure(() => applyEvidencePostFilterV1({
      request: request(), candidates: candidatesWithIterator,
    }), 'invalid-request');
    expect(iteratorCalls).toBe(0);
  });

  it('reads value exactly once as own data and never traverses or freezes it', () => {
    let valueGetterCalls = 0;
    const accessorWrapper = { receipt: receipt() } as Record<string, unknown>;
    Object.defineProperty(accessorWrapper, 'value', {
      enumerable: true,
      get: () => { valueGetterCalls += 1; return 'secret'; },
    });
    expectFailure(() => applyEvidencePostFilterV1({
      request: request(), candidates: [accessorWrapper],
    }), 'invalid-request');
    expect(valueGetterCalls).toBe(0);

    const hooks = { get: 0, toJSON: 0, iterator: 0 };
    const target = Object.create(null) as Record<PropertyKey, unknown>;
    Object.defineProperty(target, 'toJSON', {
      enumerable: true,
      get: () => { hooks.toJSON += 1; throw new Error('toJSON touched'); },
    });
    Object.defineProperty(target, Symbol.iterator, {
      enumerable: true,
      get: () => { hooks.iterator += 1; throw new Error('iterator touched'); },
    });
    const opaque = new Proxy(target, {
      get: () => { hooks.get += 1; throw new Error('opaque touched'); },
      ownKeys: () => { throw new Error('opaque traversed'); },
    });
    const result = applyEvidencePostFilterV1({
      request: request(), candidates: [candidate(opaque)],
    });
    expect(result.included[0]!.value).toBe(opaque);
    expect(hooks).toEqual({ get: 0, toJSON: 0, iterator: 0 });
    expect(Object.isFrozen(target)).toBe(false);

    const revokedOpaque = Proxy.revocable({ secret: true }, {});
    revokedOpaque.revoke();
    const revokedResult = applyEvidencePostFilterV1({
      request: request(), candidates: [candidate(revokedOpaque.proxy)],
    });
    expect(revokedResult.included[0]!.value).toBe(revokedOpaque.proxy);
  });

  it('uses captured validation, collection, UTF-8, and freeze intrinsics', () => {
    const originals = {
      freeze: Object.freeze,
      create: Object.create,
      defineProperty: Object.defineProperty,
      getPrototypeOf: Object.getPrototypeOf,
      getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
      hasOwn: Object.hasOwn,
      ownKeys: Reflect.ownKeys,
      isArray: Array.isArray,
      byteLength: Buffer.byteLength,
      string: globalThis.String,
      map: globalThis.Map,
      set: globalThis.Set,
      weakSet: globalThis.WeakSet,
      mapGet: Map.prototype.get,
      mapSet: Map.prototype.set,
      mapHas: Map.prototype.has,
      setAdd: Set.prototype.add,
      setHas: Set.prototype.has,
      weakSetAdd: WeakSet.prototype.add,
      weakSetHas: WeakSet.prototype.has,
      regexpExec: RegExp.prototype.exec,
      charCodeAt: String.prototype.charCodeAt,
      padStart: String.prototype.padStart,
      iterator: Array.prototype[Symbol.iterator],
    };
    let result: ReturnType<typeof applyEvidencePostFilterV1<string>> | undefined;
    try {
      Object.freeze = (() => { throw new Error('ambient freeze'); }) as typeof Object.freeze;
      Object.create = (() => { throw new Error('ambient create'); }) as typeof Object.create;
      Object.defineProperty = (() => { throw new Error('ambient defineProperty'); }) as typeof Object.defineProperty;
      Object.getPrototypeOf = (() => { throw new Error('ambient prototype'); }) as typeof Object.getPrototypeOf;
      Object.getOwnPropertyDescriptor = (() => { throw new Error('ambient descriptor'); }) as typeof Object.getOwnPropertyDescriptor;
      Object.hasOwn = (() => { throw new Error('ambient hasOwn'); }) as typeof Object.hasOwn;
      Reflect.ownKeys = (() => { throw new Error('ambient ownKeys'); }) as typeof Reflect.ownKeys;
      Array.isArray = (() => { throw new Error('ambient isArray'); }) as unknown as typeof Array.isArray;
      Buffer.byteLength = (() => { throw new Error('ambient byteLength'); }) as typeof Buffer.byteLength;
      originals.map.prototype.get = (() => { throw new Error('ambient map.get'); }) as typeof Map.prototype.get;
      originals.map.prototype.set = (() => { throw new Error('ambient map.set'); }) as typeof Map.prototype.set;
      originals.map.prototype.has = (() => { throw new Error('ambient map.has'); }) as typeof Map.prototype.has;
      originals.set.prototype.add = (() => { throw new Error('ambient set.add'); }) as typeof Set.prototype.add;
      originals.set.prototype.has = (() => { throw new Error('ambient set.has'); }) as typeof Set.prototype.has;
      originals.weakSet.prototype.add = (() => { throw new Error('ambient weakSet.add'); }) as typeof WeakSet.prototype.add;
      originals.weakSet.prototype.has = (() => { throw new Error('ambient weakSet.has'); }) as typeof WeakSet.prototype.has;
      RegExp.prototype.exec = (() => { throw new Error('ambient regexp.exec'); }) as typeof RegExp.prototype.exec;
      originals.string.prototype.charCodeAt = (() => { throw new Error('ambient charCodeAt'); }) as typeof String.prototype.charCodeAt;
      originals.string.prototype.padStart = (() => { throw new Error('ambient padStart'); }) as typeof String.prototype.padStart;
      globalThis.String = function BrokenString() { throw new Error('ambient String'); } as unknown as StringConstructor;
      globalThis.Map = class BrokenMap { constructor() { throw new Error('ambient Map'); } } as typeof Map;
      globalThis.Set = class BrokenSet { constructor() { throw new Error('ambient Set'); } } as typeof Set;
      globalThis.WeakSet = class BrokenWeakSet { constructor() { throw new Error('ambient WeakSet'); } } as unknown as WeakSetConstructor;
      Array.prototype[Symbol.iterator] = (() => { throw new Error('ambient iterator'); }) as unknown as typeof originals.iterator;
      result = applyEvidencePostFilterV1({
        request: request(),
        candidates: [
          candidate('first', { evidenceId: 'same' }),
          candidate('second', { evidenceId: 'same' }),
        ],
      });
    } finally {
      Object.freeze = originals.freeze;
      Object.create = originals.create;
      Object.defineProperty = originals.defineProperty;
      Object.getPrototypeOf = originals.getPrototypeOf;
      Object.getOwnPropertyDescriptor = originals.getOwnPropertyDescriptor;
      Object.hasOwn = originals.hasOwn;
      Reflect.ownKeys = originals.ownKeys;
      Array.isArray = originals.isArray;
      Buffer.byteLength = originals.byteLength;
      globalThis.String = originals.string;
      globalThis.Map = originals.map;
      globalThis.Set = originals.set;
      globalThis.WeakSet = originals.weakSet;
      originals.map.prototype.get = originals.mapGet;
      originals.map.prototype.set = originals.mapSet;
      originals.map.prototype.has = originals.mapHas;
      originals.set.prototype.add = originals.setAdd;
      originals.set.prototype.has = originals.setHas;
      originals.weakSet.prototype.add = originals.weakSetAdd;
      originals.weakSet.prototype.has = originals.weakSetHas;
      RegExp.prototype.exec = originals.regexpExec;
      originals.string.prototype.charCodeAt = originals.charCodeAt;
      originals.string.prototype.padStart = originals.padStart;
      Array.prototype[Symbol.iterator] = originals.iterator;
    }
    expect(result!.included.map((entry) => entry.value)).toEqual(['first']);
    expect(result!.decisions[1]).toEqual({
      ref: 'p0001', outcome: 'excluded', reason: 'duplicate', duplicateOfRef: 'p0000',
    });
  });

  it('returns only exact null-prototype frozen records and dense frozen arrays', () => {
    const opaque = { mutable: true };
    const result = applyEvidencePostFilterV1({
      request: request(),
      candidates: [
        candidate(opaque, { evidenceId: 'included' }),
        candidate('inactive', { evidenceId: 'inactive', lifecycle: 'inactive' }),
        candidate('duplicate', { evidenceId: 'included' }),
      ],
    });

    expectExactFrozenRecord(result, ['contractId', 'version', 'included', 'decisions']);
    expect(Object.getPrototypeOf(result.included)).toBe(Array.prototype);
    expect(Object.getPrototypeOf(result.decisions)).toBe(Array.prototype);
    expect(Object.isFrozen(result.included)).toBe(true);
    expect(Object.isFrozen(result.decisions)).toBe(true);
    expect(Reflect.ownKeys(result.included)).toEqual(['0', 'length']);
    expect(Reflect.ownKeys(result.decisions)).toEqual(['0', '1', '2', 'length']);
    expectExactFrozenRecord(result.included[0]!, ['ref', 'value']);
    expectExactFrozenRecord(result.decisions[0]!, ['ref', 'outcome']);
    expectExactFrozenRecord(result.decisions[1]!, ['ref', 'outcome', 'reason']);
    expectExactFrozenRecord(result.decisions[2]!, ['ref', 'outcome', 'reason', 'duplicateOfRef']);
    expect(Object.isFrozen(opaque)).toBe(false);
  });

  it('produces deterministic value-free decisions across equivalent calls', () => {
    const makeInput = () => ({
      request: request(),
      candidates: [
        candidate({ secret: Math.random() }, { evidenceId: 'a' }),
        candidate({ secret: Math.random() }, { evidenceId: 'a' }),
        candidate({ secret: Math.random() }, { evidenceId: 'b', temporal: 'out-of-frame' as const }),
      ],
    });
    const first = applyEvidencePostFilterV1(makeInput()).decisions;
    const second = applyEvidencePostFilterV1(makeInput()).decisions;
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).not.toContain('tenant-a');
    expect(JSON.stringify(first)).not.toContain('project:memberry');
    expect(JSON.stringify(first)).not.toContain('evidence');
    expect(JSON.stringify(first)).not.toContain('secret');
  });

  it('has no runtime, persistence, clock, environment, logging, or network wiring', () => {
    const source = readFileSync(new URL('../evidence-post-filter.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from ['"]\.\/runtime-/);
    expect(source).not.toMatch(/from ['"]\.\/(assembler|fusion|scoring|trace)\.js['"]/);
    expect(source).not.toMatch(/\b(fetch|console|process|Date|Promise|JSON)\b/);
    expect(source).not.toMatch(/(@memberry\/(neo4j|redis|core)|neo4j-driver)/);
    expect(source).not.toMatch(/mint|authenticate/i);
  });
});
