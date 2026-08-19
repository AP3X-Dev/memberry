import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  EvidenceEligibilityAuthorityContractError,
  parseEvidenceEligibilityAuthorityResultV1,
} from '../evidence-eligibility-authority.js';
import {
  EVIDENCE_ELIGIBILITY_COMPOSITION_VERSION,
  createEvidenceEligibilityComposition,
  type EvidenceEligibilityCompositionFactStatePortV1,
} from '../evidence-eligibility-composition.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const MODULE_PATH = resolve(REPO_ROOT, 'packages/core/src/evidence-eligibility-composition.ts');
const CONTRACT_PATH = resolve(REPO_ROOT, 'packages/core/src/evidence-eligibility-authority.ts');
const moduleSource = readFileSync(MODULE_PATH, 'utf8');
const contractSource = readFileSync(CONTRACT_PATH, 'utf8');

const MAP_BEGIN = '// --- B5-MAP-BEGIN mapFactEntryToReceipt ---';
const MAP_END = '// --- B5-MAP-END mapFactEntryToReceipt ---';
const AXIS_AND_STATUS_LITERALS = [
  "'active'", "'inactive'", "'in-frame'", "'out-of-frame'", "'clear'",
  "'superseded'", "'withheld'", "'invalidated'", "'disputed'",
];

const PORT_VERSION = 'memberry.evidence-source-fact-state/1.0.0';
const OBSERVED_AT = '2026-08-19T03:00:00.000Z';
const TENANT_ID = 'tenant-acme';
const PROJECT_SCOPE = 'project:memberry';
const ENTITY_ID = 'entity-acme-001';

type SourceType = 'semantic' | 'fact' | 'arch_entity';

function candidate(index: number, sourceType: SourceType = 'fact') {
  return {
    ref: `c${String(index).padStart(3, '0')}`,
    sourceType,
    evidenceId: `fact-${index}`,
  };
}

function request(candidates: ReadonlyArray<ReturnType<typeof candidate>>, asOf?: string) {
  return {
    contractId: 'memberry.evidence-eligibility-authority',
    contractVersion: '1.0.0',
    tenantId: TENANT_ID,
    projectScope: PROJECT_SCOPE,
    resolvedEntityId: ENTITY_ID,
    temporalFrame: asOf === undefined ? { mode: 'current' } : { mode: 'as-of', asOf },
    recordTime: { mode: 'current' },
    candidates,
  };
}

function entry(index: number, status: string, withinValidTime = true, superseded = false) {
  return { evidenceId: `fact-${index}`, status, withinValidTime, superseded };
}

function observation(entries: readonly unknown[], overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: PORT_VERSION,
    outcome: 'observed',
    observedAt: OBSERVED_AT,
    entries,
    ...overrides,
  };
}

interface StubPort extends EvidenceEligibilityCompositionFactStatePortV1 {
  readonly calls: unknown[];
}

function port(behavior: { result?: unknown; rejects?: unknown }): StubPort {
  const calls: unknown[] = [];
  return {
    calls,
    observeFactState: async (input: unknown) => {
      calls.push(input);
      if (behavior.rejects !== undefined) throw behavior.rejects;
      return behavior.result;
    },
  };
}

async function compose(behavior: { result?: unknown; rejects?: unknown }, input: unknown) {
  const stub = port(behavior);
  const surface = createEvidenceEligibilityComposition(stub);
  const result = await surface.composeAuthorityResult(input);
  return { result, stub };
}

function unsupported(code: string, asOf?: string) {
  return {
    contractId: 'memberry.evidence-eligibility-authority',
    contractVersion: '1.0.0',
    outcome: 'unsupported',
    tenantId: TENANT_ID,
    projectScope: PROJECT_SCOPE,
    resolvedEntityId: ENTITY_ID,
    temporalFrame: asOf === undefined ? { mode: 'current' } : { mode: 'as-of', asOf },
    recordTime: { mode: 'current' },
    code,
  };
}

function importSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(/from '([^']+)'/g),
    ...source.matchAll(/import '([^']+)'/g),
    ...source.matchAll(/import\('([^']+)'\)/g),
    ...source.matchAll(/require\('([^']+)'\)/g),
  ].map((match) => match[1]!);
}

/**
 * The fabrication tripwire, as a function so both mutation arms can run the
 * identical assertion over a deliberately poisoned fixture.
 */
function fabricationViolations(source: string): string[] {
  const begin = source.indexOf(MAP_BEGIN);
  const end = source.indexOf(MAP_END);
  if (begin < 0 || end < 0 || end < begin) return ['sentinels-missing'];
  const remainder = source.slice(0, begin) + source.slice(end);
  const violations: string[] = [];
  for (const literal of AXIS_AND_STATUS_LITERALS) {
    const count = remainder.split(literal).length - 1;
    if (count > 0) violations.push(`${literal} x${count}`);
  }
  // Proximity clause, inside the excised mapping region: no other evidence
  // type may be named near an axis literal, which is where a cross-axis
  // fabrication would have to be written.
  const region = source.slice(begin, end);
  for (const literal of AXIS_AND_STATUS_LITERALS) {
    let cursor = region.indexOf(literal);
    while (cursor >= 0) {
      const window = region.slice(Math.max(0, cursor - 200), cursor + literal.length + 200);
      if (window.includes('semantic') || window.includes('arch_entity')) {
        violations.push(`proximity ${literal}`);
      }
      cursor = region.indexOf(literal, cursor + 1);
    }
  }
  return violations;
}

describe('EvidenceEligibilityComposition V1 (RET-005B-AUTH-001B5, module 2)', () => {
  it('confines every axis and status literal to the single mapping function (T18)', () => {
    expect(moduleSource).toContain(MAP_BEGIN);
    expect(moduleSource).toContain(MAP_END);
    expect(moduleSource.indexOf(MAP_BEGIN)).toBeLessThan(moduleSource.indexOf(MAP_END));
    expect(moduleSource).toMatch(/function mapFactEntryToReceipt\(/);
    // The mapping function is inside the sentinels, and it is the only one.
    expect([...moduleSource.matchAll(/function mapFactEntryToReceipt\(/g)]).toHaveLength(1);
    expect(moduleSource.indexOf('function mapFactEntryToReceipt('))
      .toBeGreaterThan(moduleSource.indexOf(MAP_BEGIN));
    expect(moduleSource.indexOf('function mapFactEntryToReceipt('))
      .toBeLessThan(moduleSource.indexOf(MAP_END));
    expect(fabricationViolations(moduleSource)).toEqual([]);

    // Mutation arm 1: an axis literal written outside the mapping function.
    const outside = moduleSource.replace(
      'const FACT_SOURCE_TYPE =',
      "const SMUGGLED_AXIS = 'in-frame';\nconst FACT_SOURCE_TYPE =",
    );
    expect(outside).not.toBe(moduleSource);
    expect(fabricationViolations(outside)).toContain("'in-frame' x1");

    // Mutation arm 2: a status literal re-introduced into step 6's bounded
    // string check, which is exactly the collision the single-home binding
    // exists to prevent.
    const step6 = moduleSource.replace(
      '|| !boundedText(status, MAX_STATUS_LENGTH)',
      "|| !boundedText(status, MAX_STATUS_LENGTH) || status === 'active'",
    );
    expect(step6).not.toBe(moduleSource);
    expect(fabricationViolations(step6)).toContain("'active' x1");
  });

  it('refuses any non-fact batch whole, with zero port calls (T19)', async () => {
    const batches = [
      [candidate(1, 'semantic')],
      [candidate(1, 'arch_entity')],
      [candidate(1, 'fact'), candidate(2, 'semantic')],
      [candidate(1, 'semantic'), candidate(2, 'fact')],
      [candidate(1, 'fact'), candidate(2, 'arch_entity'), candidate(3, 'fact')],
    ];
    for (const candidates of batches) {
      const { result, stub } = await compose({}, request(candidates));
      expect(result).toEqual(unsupported('source-policy-unavailable'));
      expect(stub.calls).toHaveLength(0);
    }
  });

  it('refuses a historical frame with the only code the contract admits there (T20)', async () => {
    const asOf = '2026-08-01T00:00:00.000Z';
    const { result, stub } = await compose({}, request([candidate(1)], asOf));
    expect(result).toEqual(unsupported('temporal-history-unavailable', asOf));
    expect(stub.calls).toHaveLength(0);

    // Negative arm: the other four codes are unrepresentable in a historical
    // frame, proven through the sealed parser itself.
    for (const code of [
      'source-policy-unavailable', 'record-time-unavailable',
      'adjudication-pending', 'adjudication-coverage-gap',
    ]) {
      expect(() => parseEvidenceEligibilityAuthorityResultV1(
        unsupported(code, asOf),
        request([candidate(1)], asOf),
      )).toThrowError(EvidenceEligibilityAuthorityContractError);
    }
  });

  it('collapses all six refusal paths onto exactly two contract codes (T21)', async () => {
    const arms: Array<[string, string]> = [
      ['fact-state-source-unavailable', 'source-policy-unavailable'],
      ['fact-state-candidate-missing', 'source-policy-unavailable'],
      ['fact-state-status-unrecognized', 'source-policy-unavailable'],
      // A contract-violating port: this module only ever asks for the current
      // frame, so the frame code is a misbehaving-observer signal. Mapping it
      // to the temporal code would throw at the parser, never inform anyone.
      ['fact-state-frame-unsupported', 'source-policy-unavailable'],
      ['fact-state-time-unusable', 'record-time-unavailable'],
    ];
    for (const [portCode, contractCode] of arms) {
      const { result } = await compose(
        { result: { contractVersion: PORT_VERSION, outcome: 'unsupported', code: portCode } },
        request([candidate(1)]),
      );
      expect(result).toEqual(unsupported(contractCode));
      if (portCode === 'fact-state-frame-unsupported') {
        expect(result).not.toEqual(unsupported('temporal-history-unavailable'));
      }
    }
    // Sixth path: an unknown status returns a refusal out of the mapping.
    const unknownStatus = await compose(
      { result: observation([entry(1, 'tentative')]) },
      request([candidate(1)]),
    );
    expect(unknownStatus.result).toEqual(unsupported('source-policy-unavailable'));

    // Mechanical single-carrier proof: step 2 owns the temporal code alone.
    expect([...moduleSource.matchAll(/temporal-history-unavailable/g)]).toHaveLength(1);
  });

  it('round trips a three-fact batch through the sealed parser (T22)', async () => {
    const candidates = [candidate(1), candidate(2), candidate(3)];
    const { result, stub } = await compose({
      result: observation([
        entry(1, 'active'),
        entry(2, 'disputed', true, true),
        entry(3, 'invalidated', false, false),
      ]),
    }, request(candidates));

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toEqual({
      mode: 'current',
      evidenceIds: ['fact-1', 'fact-2', 'fact-3'],
    });
    const supported = result as {
      outcome: string;
      recordedAt: string;
      receipts: ReadonlyArray<Record<string, unknown>>;
    };
    expect(supported.outcome).toBe('supported');
    expect(supported.recordedAt).toBe(OBSERVED_AT);
    expect(supported.receipts).toHaveLength(3);
    expect(supported.receipts.map((receipt) => receipt.ref)).toEqual(['c001', 'c002', 'c003']);
    expect(supported.receipts.map((receipt) => receipt.evidenceId))
      .toEqual(['fact-1', 'fact-2', 'fact-3']);
    for (const receipt of supported.receipts) {
      expect(receipt.sourceType).toBe('fact');
      expect(receipt.provenance).toEqual({ policy: 'fact-current-source-owned-v1', ref: PORT_VERSION });
    }
    // Re-parsing the module's own output is a fixed point.
    expect(parseEvidenceEligibilityAuthorityResultV1(result, request(candidates))).toEqual(result);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('derives every axis from observed state, and a wrong pairing cannot survive (T23)', async () => {
    const arms: Array<[string, boolean, boolean, Record<string, string>]> = [
      ['active', true, false, { lifecycle: 'active', temporal: 'in-frame', supersession: 'clear', contradiction: 'clear' }],
      ['active', false, true, { lifecycle: 'active', temporal: 'out-of-frame', supersession: 'superseded', contradiction: 'clear' }],
      ['disputed', true, false, { lifecycle: 'active', temporal: 'in-frame', supersession: 'clear', contradiction: 'withheld' }],
      ['disputed', false, true, { lifecycle: 'active', temporal: 'out-of-frame', supersession: 'superseded', contradiction: 'withheld' }],
      ['invalidated', true, false, { lifecycle: 'inactive', temporal: 'in-frame', supersession: 'clear', contradiction: 'clear' }],
      ['invalidated', false, true, { lifecycle: 'inactive', temporal: 'out-of-frame', supersession: 'superseded', contradiction: 'clear' }],
    ];
    for (const [status, withinValidTime, superseded, axes] of arms) {
      const { result } = await compose(
        { result: observation([entry(1, status, withinValidTime, superseded)]) },
        request([candidate(1)]),
      );
      const receipts = (result as { receipts: ReadonlyArray<Record<string, unknown>> }).receipts;
      expect(receipts).toHaveLength(1);
      expect({
        lifecycle: receipts[0]!.lifecycle,
        temporal: receipts[0]!.temporal,
        supersession: receipts[0]!.supersession,
        contradiction: receipts[0]!.contradiction,
      }).toEqual(axes);
    }

    // MUTATION ARM: the disputed pairing is not decoration. A contested record
    // that is also called lifecycle-dead is rejected by the sealed parser, so
    // step 8's self-validation is load-bearing rather than ceremonial.
    const candidates = [candidate(1)];
    const draft = {
      contractId: 'memberry.evidence-eligibility-authority',
      contractVersion: '1.0.0',
      outcome: 'supported',
      tenantId: TENANT_ID,
      projectScope: PROJECT_SCOPE,
      resolvedEntityId: ENTITY_ID,
      temporalFrame: { mode: 'current' },
      recordTime: { mode: 'current' },
      recordedAt: OBSERVED_AT,
      receipts: [{
        ...candidates[0]!,
        lifecycle: 'inactive',
        temporal: 'in-frame',
        supersession: 'clear',
        contradiction: 'withheld',
        provenance: { policy: 'fact-current-source-owned-v1', ref: PORT_VERSION },
      }],
    };
    expect(() => parseEvidenceEligibilityAuthorityResultV1(draft, request(candidates)))
      .toThrowError(EvidenceEligibilityAuthorityContractError);
    expect(() => parseEvidenceEligibilityAuthorityResultV1(
      { ...draft, receipts: [{ ...draft.receipts[0]!, lifecycle: 'active' }] },
      request(candidates),
    )).not.toThrow();
  });

  it('treats the port boundary as untrusted input on every axis of its shape (T24)', async () => {
    const candidates = [candidate(1), candidate(2)];
    const valid = [entry(1, 'active'), entry(2, 'active')];
    const arms: Array<[string, unknown, string]> = [
      ['non-object', 'observed', 'source-policy-unavailable'],
      ['null', null, 'source-policy-unavailable'],
      ['array', [], 'source-policy-unavailable'],
      ['class instance', new (class { outcome = 'observed'; })(), 'source-policy-unavailable'],
      ['unknown outcome', observation(valid, { outcome: 'maybe' }), 'source-policy-unavailable'],
      ['unknown port code', { contractVersion: PORT_VERSION, outcome: 'unsupported', code: 'nope' }, 'source-policy-unavailable'],
      ['count mismatch', observation([entry(1, 'active')]), 'source-policy-unavailable'],
      ['order shuffle', observation([entry(2, 'active'), entry(1, 'active')]), 'source-policy-unavailable'],
      ['id substitution', observation([entry(1, 'active'), entry(9, 'active')]), 'source-policy-unavailable'],
      ['non-boolean flag', observation([entry(1, 'active'), { ...entry(2, 'active'), withinValidTime: 'true' }]), 'source-policy-unavailable'],
      ['non-boolean supersession', observation([entry(1, 'active'), { ...entry(2, 'active'), superseded: 1 }]), 'source-policy-unavailable'],
      ['unknown status', observation([entry(1, 'active'), entry(2, 'tentative')]), 'source-policy-unavailable'],
      ['missing contractVersion', observation(valid, { contractVersion: undefined }), 'source-policy-unavailable'],
      ['empty contractVersion', observation(valid, { contractVersion: '' }), 'source-policy-unavailable'],
      ['unsafe contractVersion', observation(valid, { contractVersion: 'has space' }), 'source-policy-unavailable'],
      ['oversize contractVersion', observation(valid, { contractVersion: `v${'a'.repeat(201)}` }), 'source-policy-unavailable'],
      ['non-array entries', observation(valid, { entries: { 0: entry(1, 'active') } }), 'source-policy-unavailable'],
      ['null entries', observation(valid, { entries: null }), 'source-policy-unavailable'],
      ['entry not a record', observation([entry(1, 'active'), 'fact-2']), 'source-policy-unavailable'],
      ['proxy narrowing entries', new Proxy(observation(valid), {
        get: (target, key) => (key === 'entries' ? [] : Reflect.get(target, key)),
      }), 'source-policy-unavailable'],
      ['proxy hiding everything', new Proxy(observation(valid), { get: () => undefined }), 'source-policy-unavailable'],
      ['malformed observedAt', observation(valid, { observedAt: '2026-08-19T03:00:00Z' }), 'record-time-unavailable'],
      ['null observedAt', observation(valid, { observedAt: null }), 'record-time-unavailable'],
      ['non-canonical observedAt', observation(valid, { observedAt: '2026-08-19T03:00:00.000000000Z' }), 'record-time-unavailable'],
    ];
    for (const [label, result, code] of arms) {
      const composed = await compose({ result }, request(candidates));
      expect(composed.result, label).toEqual(unsupported(code));
    }

    // Regression guard for the single-read discipline on entries.length. The
    // observation reports 2 on its first length read and 1 on every later one.
    // Because the length is read exactly once and reused, the whole batch is
    // answered from the count that was actually checked and the result is
    // supported with two receipts. Reading the length per site instead would
    // size the count check at 2 and the loop at 1, leaving a hole that step 7
    // dereferences into a raw TypeError - so this arm turns red the moment the
    // single read is reverted, which is the only reason it exists. It cannot
    // be an unsupported-code arm: a self-consistent observation has nothing to
    // refuse.
    const varyingLength = (() => {
      let lengthReads = 0;
      return new Proxy(observation(valid), {
        get: (target, key) => (key === 'entries'
          ? new Proxy([entry(1, 'active'), entry(2, 'active')], {
            get: (array, property) => (property === 'length'
              ? (lengthReads++ === 0 ? 2 : 1)
              : Reflect.get(array, property)),
          })
          : Reflect.get(target, key)),
      });
    })();
    const varying = await compose({ result: varyingLength }, request(candidates));
    expect((varying.result as { outcome: string }).outcome).toBe('supported');
    expect((varying.result as { receipts: unknown[] }).receipts).toHaveLength(2);
  });

  it('refuses a port rejection but never launders a mapping fault (T25)', async () => {
    const rejected = await compose({ rejects: new Error('port-down') }, request([candidate(1)]));
    expect(rejected.result).toEqual(unsupported('source-policy-unavailable'));

    // A poisoned accessor is a defect, not an observation: it throws through
    // the composition unchanged, because the catch covers the port await only.
    const poisoned = {
      contractVersion: PORT_VERSION,
      outcome: 'observed',
      observedAt: OBSERVED_AT,
      entries: [{
        evidenceId: 'fact-1',
        get status(): string { throw new Error('poisoned-getter'); },
        withinValidTime: true,
        superseded: false,
      }],
    };
    const surface = createEvidenceEligibilityComposition(port({ result: poisoned }));
    await expect(surface.composeAuthorityResult(request([candidate(1)])))
      .rejects.toThrowError('poisoned-getter');
  });

  it('holds the empty batch, the caller-fault channel, and the module-2 containment regime (T26)', async () => {
    const { result, stub } = await compose(
      { result: observation([]) },
      request([]),
    );
    expect((result as { outcome: string; receipts: unknown[] }).outcome).toBe('supported');
    expect((result as { receipts: unknown[] }).receipts).toEqual([]);
    expect(stub.calls).toEqual([{ mode: 'current', evidenceIds: [] }]);

    // A malformed request is a caller fault and propagates as a contract
    // error, never as an unsupported capability.
    const surface = createEvidenceEligibilityComposition(port({ result: observation([]) }));
    for (const bad of [null, {}, request([candidate(1)], 'not-an-instant')]) {
      await expect(surface.composeAuthorityResult(bad))
        .rejects.toThrowError(EvidenceEligibilityAuthorityContractError);
    }

    expect(EVIDENCE_ELIGIBILITY_COMPOSITION_VERSION)
      .toBe('memberry.evidence-eligibility-composition/1.0.0');
    expect(surface.contractVersion).toBe(EVIDENCE_ELIGIBILITY_COMPOSITION_VERSION);
    expect(Object.isFrozen(surface)).toBe(true);
    expect(Object.getPrototypeOf(surface)).toBeNull();

    // (1) the composition consumes a port, never a database handle.
    expect(moduleSource).not.toMatch(/@memberry\/neo4j|packages\/neo4j|neo4j-driver/);
    // (2) no query text in the contract package.
    expect(moduleSource).not.toMatch(/\bDriver\b/);
    expect(moduleSource).not.toMatch(/\.session\(/);
    expect(moduleSource).not.toMatch(/session\.run/);
    expect(moduleSource).not.toMatch(/UNWIND/);
    expect(moduleSource).not.toMatch(/MATCH\s*\(/);
    expect(moduleSource).not.toMatch(/MERGE\s*\(/);
    expect(moduleSource).not.toMatch(/\bCypher\b/);
    // (3) B5 does not consume B4 on either side of the port.
    expect(moduleSource).not.toMatch(/clearance-/);
    expect(moduleSource).not.toMatch(/EvidenceAuthorityClearance/);
    // (4) every instant comes from the observer; this module reads no clock.
    expect(moduleSource).not.toMatch(/new Date\(/);
    expect(moduleSource).not.toMatch(/Date\.now\(/);
    // (5) the semantic precondition is discharged structurally, not guarded.
    expect(moduleSource).not.toMatch(/adjudication-pending/);
    expect(moduleSource).not.toMatch(/adjudication-coverage-gap/);
    // (6) infrastructure and structural sets.
    expect(moduleSource).not.toMatch(/process\.env|MEMBERRY_/);
    expect(moduleSource).not.toMatch(/console\./);
    expect(moduleSource).not.toContain('node:fs');
    expect(moduleSource).not.toMatch(/Redis|ProposalStore|Consolidation|Retrieval|MCP/);
    expect(moduleSource).not.toMatch(/^(let|var)\s/m);
    expect(moduleSource).not.toMatch(/new (Map|Set)\b/);
    // (7) honesty and delivery sets.
    expect(moduleSource).not.toMatch(/authenticated|non-repudiation|verified reviewer/i);
    expect(moduleSource).not.toMatch(/\backRow|acknowledge|nack\(|markDelivered|deadLetter|redeliver|inflight/i);
    expect(moduleSource).not.toMatch(/createSink|deliverTo|pushOutbox|pushTo|saveCheckpoint|checkpointCursor/i);
    // Import allowlist, exact: one specifier, type and value.
    expect([...new Set(importSpecifiers(moduleSource))]).toEqual(['./evidence-eligibility-authority.js']);

    // Hand copies pinned to the sealed contract's own literals.
    const pin = (source: string, name: string): string | undefined =>
      source.match(new RegExp(`const ${name} = (/.*/);`))?.[1];
    expect(pin(moduleSource, 'SAFE_PROVENANCE_REF')).toBe(pin(contractSource, 'SAFE_PROVENANCE_REF'));
    expect(pin(moduleSource, 'SAFE_PROVENANCE_REF')).toBeDefined();
    expect(pin(moduleSource, 'CANONICAL_INSTANT')).toBe(pin(contractSource, 'CANONICAL_INSTANT'));
    expect(pin(moduleSource, 'CANONICAL_INSTANT')).toBeDefined();

    // Export visibility: the composition is a private provider surface.
    const coreIndex = readFileSync(resolve(REPO_ROOT, 'packages/core/src/index.ts'), 'utf8');
    for (const name of [
      'evidence-eligibility-composition', 'createEvidenceEligibilityComposition',
      'EVIDENCE_ELIGIBILITY_COMPOSITION_VERSION',
    ]) {
      expect(coreIndex).not.toContain(name);
    }
  });
});
