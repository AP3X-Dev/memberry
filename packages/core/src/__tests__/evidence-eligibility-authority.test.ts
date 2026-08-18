import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  EVIDENCE_ELIGIBILITY_AUTHORITY_CONTRACT_ID,
  EVIDENCE_ELIGIBILITY_AUTHORITY_CONTRACT_VERSION,
  EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_AGGREGATE_STRING_BYTES,
  EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_CANDIDATES,
  EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_EVIDENCE_ID_BYTES,
  EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_PROVENANCE_REF_BYTES,
  EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_REF_BYTES,
  EvidenceEligibilityAuthorityContractError,
  emitEvidenceEligibilityAuthorityRequestV1,
  parseEvidenceEligibilityAuthorityRequestV1,
  parseEvidenceEligibilityAuthorityResultV1,
  type EvidenceEligibilityAuthorityRequestV1,
  type EvidenceEligibilityAuthorityResultV1,
  type EvidenceEligibilityAuthoritySourceTypeV1,
} from '../evidence-eligibility-authority.js';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const POLICIES = {
  semantic: 'semantic-current-adjudicated-v1',
  fact: 'fact-current-source-owned-v1',
  arch_entity: 'arch-current-closed-world-v1',
} as const;

function descriptor(
  index: number,
  sourceType: EvidenceEligibilityAuthoritySourceTypeV1 = 'semantic',
) {
  return {
    ref: `c${String(index).padStart(3, '0')}`,
    sourceType,
    evidenceId: `evidence-${index}`,
  };
}

function request(
  candidates: readonly ReturnType<typeof descriptor>[] = [descriptor(0)],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    contractId: EVIDENCE_ELIGIBILITY_AUTHORITY_CONTRACT_ID,
    contractVersion: EVIDENCE_ELIGIBILITY_AUTHORITY_CONTRACT_VERSION,
    tenantId: 'tenant-a',
    projectScope: 'project:memberry',
    resolvedEntityId: 'entity:memberry',
    temporalFrame: { mode: 'current' },
    recordTime: { mode: 'current' },
    candidates,
    ...overrides,
  };
}

function receipt(
  candidate: ReturnType<typeof descriptor>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ref: candidate.ref,
    sourceType: candidate.sourceType,
    evidenceId: candidate.evidenceId,
    lifecycle: 'active',
    temporal: 'in-frame',
    supersession: 'clear',
    contradiction: candidate.sourceType === 'fact' ? 'clear' : 'clear',
    provenance: {
      policy: POLICIES[candidate.sourceType],
      ref: `authority-${candidate.evidenceId}`,
    },
    ...overrides,
  };
}

function supported(
  expected: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const candidates = expected.candidates as readonly ReturnType<typeof descriptor>[];
  return {
    contractId: EVIDENCE_ELIGIBILITY_AUTHORITY_CONTRACT_ID,
    contractVersion: EVIDENCE_ELIGIBILITY_AUTHORITY_CONTRACT_VERSION,
    outcome: 'supported',
    tenantId: expected.tenantId,
    projectScope: expected.projectScope,
    resolvedEntityId: expected.resolvedEntityId,
    temporalFrame: expected.temporalFrame,
    recordTime: expected.recordTime,
    recordedAt: '2026-08-18T12:34:56.789Z',
    receipts: candidates.map((candidate) => receipt(candidate)),
    ...overrides,
  };
}

function unsupported(
  expected: Record<string, unknown>,
  code = 'source-policy-unavailable',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    contractId: EVIDENCE_ELIGIBILITY_AUTHORITY_CONTRACT_ID,
    contractVersion: EVIDENCE_ELIGIBILITY_AUTHORITY_CONTRACT_VERSION,
    outcome: 'unsupported',
    tenantId: expected.tenantId,
    projectScope: expected.projectScope,
    resolvedEntityId: expected.resolvedEntityId,
    temporalFrame: expected.temporalFrame,
    recordTime: expected.recordTime,
    code,
    ...overrides,
  };
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error('expected contract error');
  } catch (error) {
    expect(error).toBeInstanceOf(EvidenceEligibilityAuthorityContractError);
    expect((error as EvidenceEligibilityAuthorityContractError).code).toBe(code);
    expect((error as Error).message).toBe(`evidence_eligibility_authority_contract:${code}`);
    expect((error as Error).message)
      .not.toMatch(/tenant-a|project:memberry|entity:memberry|evidence-\d|authority-evidence/);
  }
}

function expectNullFrozen(value: unknown): void {
  expect(Object.isFrozen(value)).toBe(true);
  if (Array.isArray(value)) {
    for (const child of value) expectNullFrozen(child);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  expect(Object.getPrototypeOf(value)).toBeNull();
  for (const child of Object.values(value)) expectNullFrozen(child);
}

function deepStringBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (Array.isArray(value)) return value.reduce((total, item) => total + deepStringBytes(item), 0);
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).reduce((total, item) => total + deepStringBytes(item), 0);
  }
  return 0;
}

function dataAccessor(value: unknown): Record<string, unknown> {
  const input = request();
  Object.defineProperty(input, 'tenantId', { enumerable: true, get: () => value });
  return input;
}

describe('RET-005B-AUTH-001A evidence eligibility authority contract', () => {
  it('pins the versioned contract identity and conservative public budgets', () => {
    expect(EVIDENCE_ELIGIBILITY_AUTHORITY_CONTRACT_ID)
      .toBe('memberry.evidence-eligibility-authority');
    expect(EVIDENCE_ELIGIBILITY_AUTHORITY_CONTRACT_VERSION).toBe('1.0.0');
    expect(EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_CANDIDATES).toBe(128);
    expect(EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_AGGREGATE_STRING_BYTES).toBe(32_768);
  });

  it('canonicalizes 0, 1, and 128 ordered descriptors as deeply frozen values', () => {
    for (const count of [0, 1, EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_CANDIDATES]) {
      const candidates = Array.from({ length: count }, (_, index) => descriptor(
        index,
        (['semantic', 'fact', 'arch_entity'] as const)[index % 3],
      ));
      const parsed = parseEvidenceEligibilityAuthorityRequestV1(request(candidates));
      expect(parsed.candidates).toHaveLength(count);
      expect(parsed.candidates.map((item) => item.ref)).toEqual(candidates.map((item) => item.ref));
      expectNullFrozen(parsed);
      expect(emitEvidenceEligibilityAuthorityRequestV1(parsed)).toEqual(parsed);
    }
  });

  it('accepts current and as-of request frames but only current record time', () => {
    expect(parseEvidenceEligibilityAuthorityRequestV1(request()).temporalFrame)
      .toEqual({ mode: 'current' });
    const historical = request([], {
      temporalFrame: { mode: 'as-of', asOf: '2026-08-17T00:00:00.000Z' },
    });
    expect(parseEvidenceEligibilityAuthorityRequestV1(historical).temporalFrame)
      .toEqual({ mode: 'as-of', asOf: '2026-08-17T00:00:00.000Z' });
    expectCode(() => parseEvidenceEligibilityAuthorityRequestV1(request([], {
      recordTime: { mode: 'as-of', asOf: '2026-08-17T00:00:00.000Z' },
    })), 'invalid-request');
  });

  it('rejects >128, duplicate refs, and duplicate source/evidence identities', () => {
    expectCode(() => parseEvidenceEligibilityAuthorityRequestV1(request(
      Array.from({ length: EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_CANDIDATES + 1 }, (_, index) => descriptor(index)),
    )), 'budget-exceeded');
    expectCode(() => parseEvidenceEligibilityAuthorityRequestV1(request([
      descriptor(0),
      { ...descriptor(1), ref: descriptor(0).ref },
    ])), 'invalid-request');
    expectCode(() => parseEvidenceEligibilityAuthorityRequestV1(request([
      descriptor(0),
      { ...descriptor(0), ref: 'different-ref' },
    ])), 'invalid-request');
  });

  it('parses a supported all-or-nothing result with exact authority and order', () => {
    const expected = request([
      descriptor(0, 'semantic'),
      descriptor(1, 'fact'),
      descriptor(2, 'arch_entity'),
    ]);
    const parsed = parseEvidenceEligibilityAuthorityResultV1(supported(expected), expected);
    expect(parsed.outcome).toBe('supported');
    if (parsed.outcome !== 'supported') throw new Error('unreachable');
    expect(parsed.receipts.map((item) => item.ref)).toEqual(['c000', 'c001', 'c002']);
    expect(parsed.receipts.map((item) => item.provenance.policy)).toEqual([
      POLICIES.semantic,
      POLICIES.fact,
      POLICIES.arch_entity,
    ]);
    expectNullFrozen(parsed);
  });

  it('accepts every fixed unsupported code without partial receipts', () => {
    const current = request([descriptor(0, 'semantic')]);
    for (const code of [
      'source-policy-unavailable',
      'adjudication-pending',
      'adjudication-coverage-gap',
      'record-time-unavailable',
    ]) {
      const parsed = parseEvidenceEligibilityAuthorityResultV1(unsupported(current, code), current);
      expect(parsed).toMatchObject({ outcome: 'unsupported', code });
      expect('receipts' in parsed).toBe(false);
      expectNullFrozen(parsed);
    }
    const historical = request([descriptor(0)], {
      temporalFrame: { mode: 'as-of', asOf: '2026-08-17T00:00:00.000Z' },
    });
    expect(parseEvidenceEligibilityAuthorityResultV1(
      unsupported(historical, 'temporal-history-unavailable'),
      historical,
    )).toMatchObject({ outcome: 'unsupported', code: 'temporal-history-unavailable' });
  });

  it('makes every as-of result unsupported and rejects dishonest code/source combinations', () => {
    const historical = request([descriptor(0)], {
      temporalFrame: { mode: 'as-of', asOf: '2026-08-17T00:00:00.000Z' },
    });
    expectCode(
      () => parseEvidenceEligibilityAuthorityResultV1(supported(historical), historical),
      'invalid-result',
    );
    expectCode(
      () => parseEvidenceEligibilityAuthorityResultV1(
        unsupported(historical, 'source-policy-unavailable'),
        historical,
      ),
      'invalid-result',
    );
    const factsOnly = request([descriptor(0, 'fact')]);
    for (const code of ['adjudication-pending', 'adjudication-coverage-gap', 'temporal-history-unavailable']) {
      expectCode(
        () => parseEvidenceEligibilityAuthorityResultV1(unsupported(factsOnly, code), factsOnly),
        'invalid-result',
      );
    }
  });

  it('enforces exact authority echoes and rejects missing, extra, or reordered receipts', () => {
    const candidates = [descriptor(0), descriptor(1)];
    const expected = request(candidates);
    for (const [field, value] of [
      ['tenantId', 'tenant-b'],
      ['projectScope', 'project:other'],
      ['resolvedEntityId', 'entity:other'],
      ['temporalFrame', { mode: 'as-of', asOf: '2026-08-17T00:00:00.000Z' }],
      ['recordTime', { mode: 'other' }],
    ] as const) {
      expectCode(
        () => parseEvidenceEligibilityAuthorityResultV1(supported(expected, { [field]: value }), expected),
        'invalid-result',
      );
    }
    const exact = supported(expected);
    const receipts = exact.receipts as Record<string, unknown>[];
    for (const changed of [
      supported(expected, { receipts: receipts.slice(0, 1) }),
      supported(expected, { receipts: [...receipts, receipt(descriptor(2))] }),
      supported(expected, { receipts: [receipts[1], receipts[0]] }),
      supported(expected, { receipts: [{ ...receipts[0], evidenceId: 'different' }, receipts[1]] }),
    ]) {
      expectCode(
        () => parseEvidenceEligibilityAuthorityResultV1(changed, expected),
        'invalid-result',
      );
    }
  });

  it('enforces current source-owned classification policies', () => {
    const cases = [
      {
        source: 'semantic' as const,
        valid: { contradiction: 'clear' },
        invalid: [
          { contradiction: 'withheld' },
          { provenance: { policy: POLICIES.fact, ref: 'wrong' } },
        ],
      },
      {
        source: 'fact' as const,
        valid: { contradiction: 'withheld', lifecycle: 'active' },
        invalid: [
          { contradiction: 'withheld', lifecycle: 'inactive' },
          { provenance: { policy: POLICIES.semantic, ref: 'wrong' } },
        ],
      },
      {
        source: 'arch_entity' as const,
        valid: { lifecycle: 'inactive', temporal: 'in-frame', supersession: 'clear', contradiction: 'clear' },
        invalid: [
          { temporal: 'out-of-frame' },
          { supersession: 'superseded' },
          { contradiction: 'withheld' },
          { provenance: { policy: POLICIES.semantic, ref: 'wrong' } },
        ],
      },
    ];
    for (const entry of cases) {
      const candidate = descriptor(0, entry.source);
      const expected = request([candidate]);
      expect(parseEvidenceEligibilityAuthorityResultV1(supported(expected, {
        receipts: [receipt(candidate, entry.valid)],
      }), expected).outcome).toBe('supported');
      for (const invalid of entry.invalid) {
        expectCode(() => parseEvidenceEligibilityAuthorityResultV1(supported(expected, {
          receipts: [receipt(candidate, invalid)],
        }), expected), 'invalid-result');
      }
    }
  });

  it('requires canonical provider-generated recordedAt and exact variants', () => {
    const expected = request();
    for (const recordedAt of [
      '2026-08-18T12:34:56Z',
      '2026-08-18T12:34:56.789+00:00',
      '2026-02-30T12:34:56.789Z',
      'not-a-time',
      1,
    ]) {
      expectCode(() => parseEvidenceEligibilityAuthorityResultV1(
        supported(expected, { recordedAt }),
        expected,
      ), 'invalid-result');
    }
    expectCode(() => parseEvidenceEligibilityAuthorityResultV1(
      { ...supported(expected), extra: true },
      expected,
    ), 'invalid-result');
    expectCode(() => parseEvidenceEligibilityAuthorityResultV1(
      { ...unsupported(expected), receipts: [] },
      expected,
    ), 'invalid-result');
  });

  it('accepts null-prototype records and rejects proxies, accessors, symbols, arrays, and typed arrays', () => {
    const nullCandidate = Object.assign(Object.create(null), descriptor(0));
    const nullRequest = Object.assign(Object.create(null), request([nullCandidate]));
    nullRequest.temporalFrame = Object.assign(Object.create(null), { mode: 'current' });
    nullRequest.recordTime = Object.assign(Object.create(null), { mode: 'current' });
    expect(parseEvidenceEligibilityAuthorityRequestV1(nullRequest).candidates).toHaveLength(1);

    const symbolRoot = request();
    Object.defineProperty(symbolRoot, Symbol('hidden'), { value: true, enumerable: true });
    const sparse = new Array(2);
    sparse[0] = descriptor(0);
    const hostile: unknown[] = [
      new Proxy(request(), {}),
      dataAccessor('tenant-a'),
      symbolRoot,
      [],
      new Uint8Array(),
      Object.assign(Object.create({ unsafe: true }), request()),
      request(sparse as ReturnType<typeof descriptor>[]),
      request([new Proxy(descriptor(0), {})]),
    ];
    for (const value of hostile) {
      expectCode(() => parseEvidenceEligibilityAuthorityRequestV1(value), 'invalid-request');
    }
  });

  it('does not invoke hostile getters, coercion hooks, proxy traps, or thenables', () => {
    let calls = 0;
    const accessor = request();
    Object.defineProperty(accessor, 'tenantId', {
      enumerable: true,
      get() { calls += 1; return 'tenant-a'; },
    });
    expectCode(() => parseEvidenceEligibilityAuthorityRequestV1(accessor), 'invalid-request');
    const coercible = { toString() { calls += 1; return 'tenant-a'; } };
    expectCode(() => parseEvidenceEligibilityAuthorityRequestV1(request([], {
      tenantId: coercible,
    })), 'invalid-request');
    const proxy = new Proxy({}, {
      ownKeys() { calls += 1; return []; },
      getOwnPropertyDescriptor() { calls += 1; return undefined; },
      getPrototypeOf() { calls += 1; return Object.prototype; },
    });
    expectCode(() => parseEvidenceEligibilityAuthorityRequestV1(proxy), 'invalid-request');
    expect(calls).toBe(0);
  });

  it('rejects lone surrogates and distinguishes code-unit pre-budget from exact UTF-8 overflow', () => {
    expectCode(() => parseEvidenceEligibilityAuthorityRequestV1(request([], {
      tenantId: `tenant\ud800`,
    })), 'invalid-request');
    expectCode(() => parseEvidenceEligibilityAuthorityRequestV1(request([], {
      resolvedEntityId: '🙂'.repeat(EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_EVIDENCE_ID_BYTES / 4 + 1),
    })), 'budget-exceeded');
    expectCode(() => parseEvidenceEligibilityAuthorityRequestV1(request([
      { ...descriptor(0), evidenceId: 'x'.repeat(EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_EVIDENCE_ID_BYTES + 1) },
    ])), 'budget-exceeded');
    expectCode(() => parseEvidenceEligibilityAuthorityRequestV1(request([
      { ...descriptor(0), ref: 'x'.repeat(EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_REF_BYTES + 1) },
    ])), 'budget-exceeded');
  });

  it('enforces exact aggregate UTF-8 N/N+1 request budgets', () => {
    const candidates = Array.from(
      { length: EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_CANDIDATES },
      (_, index) => ({
        ...descriptor(index),
        ref: `r${'x'.repeat(EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_REF_BYTES - 5)}${String(index).padStart(3, '0')}`,
        evidenceId: `e${'y'.repeat(EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_EVIDENCE_ID_BYTES - 5)}${String(index).padStart(3, '0')}`,
      }),
    );
    const exact = request(candidates);
    let excess = deepStringBytes(exact) - EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_AGGREGATE_STRING_BYTES;
    expect(excess).toBeGreaterThan(0);
    for (let index = candidates.length - 1; index >= 0 && excess > 0; index -= 1) {
      const candidate = candidates[index]!;
      const removable = candidate.evidenceId.length - 5;
      const remove = Math.min(removable, excess);
      candidate.evidenceId = `${candidate.evidenceId.slice(0, -3 - remove)}${String(index).padStart(3, '0')}`;
      excess -= remove;
    }
    expect(deepStringBytes(exact)).toBe(EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_AGGREGATE_STRING_BYTES);
    expect(parseEvidenceEligibilityAuthorityRequestV1(exact).candidates).toHaveLength(128);
    const first = candidates[0]!;
    first.evidenceId += 'z';
    expect(deepStringBytes(exact)).toBe(EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_AGGREGATE_STRING_BYTES + 1);
    expectCode(() => parseEvidenceEligibilityAuthorityRequestV1(exact), 'budget-exceeded');
  });

  it('enforces provenance per-string and aggregate budgets at the result boundary', () => {
    const candidate = descriptor(0, 'semantic');
    const expected = request([candidate]);
    expect(parseEvidenceEligibilityAuthorityResultV1(supported(expected, {
      receipts: [receipt(candidate, {
        provenance: {
          policy: POLICIES.semantic,
          ref: `p${'x'.repeat(EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_PROVENANCE_REF_BYTES - 1)}`,
        },
      })],
    }), expected).outcome).toBe('supported');
    expectCode(() => parseEvidenceEligibilityAuthorityResultV1(supported(expected, {
      receipts: [receipt(candidate, {
        provenance: {
          policy: POLICIES.semantic,
          ref: `p${'x'.repeat(EVIDENCE_ELIGIBILITY_AUTHORITY_MAX_PROVENANCE_REF_BYTES)}`,
        },
      })],
    }), expected), 'budget-exceeded');
  });

  it('returns content-free fixed errors and never carries candidate values or raw details', () => {
    const secret = 'DO-NOT-LEAK-CONTENT';
    try {
      parseEvidenceEligibilityAuthorityRequestV1(request([
        { ...descriptor(0), evidenceId: secret },
        { ...descriptor(1), evidenceId: secret },
      ]));
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(Object.keys(error as object)).toEqual(['code']);
    }
    const parsed = parseEvidenceEligibilityAuthorityResultV1(supported(request()), request());
    expect(JSON.stringify(parsed)).not.toMatch(/query|content|title|metadata|score|detail/i);
  });

  it('exports only an unwired structural contract without an authority mint or runtime side effects', () => {
    const source = readFileSync(new URL('../evidence-eligibility-authority.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/export\s+(?:async\s+)?function\s+.*(?:mint|create|resolve|execute|apply)/i);
    expect(source).not.toMatch(/from ['"](?:node:fs|node:net|node:http|node:https|@memberry\/redis|@memberry\/neo4j)/);
    expect(source).not.toMatch(/\b(?:fetch|setTimeout|setImmediate|Promise|process\.env)\b/);
    expect(source).not.toMatch(/runtime-query-planner|candidate-channel|tools\.ts|bootstrap/i);
  });

  it('exposes the canonical types through the Core package index', async () => {
    const core = await import('../index.js');
    expect(core.parseEvidenceEligibilityAuthorityRequestV1)
      .toBe(parseEvidenceEligibilityAuthorityRequestV1);
    expect(core.parseEvidenceEligibilityAuthorityResultV1)
      .toBe(parseEvidenceEligibilityAuthorityResultV1);
  });
});

void ({} as EvidenceEligibilityAuthorityRequestV1);
void ({} as EvidenceEligibilityAuthorityResultV1);
void ({} as Mutable<EvidenceEligibilityAuthorityRequestV1>);
