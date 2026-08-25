// packages/core/src/__tests__/advisor.test.ts
//
// MEM-008 advisor scoring table: closed, deterministic, frozen. Pins the §2.2
// worked examples byte-exact, every base band, each modifier firing and NOT
// firing on absent/mistyped fields, clamp, band edges, sorted+deduped reasons,
// determinism, frozen output, and attachAdvisorV1's never-throws containment.
// Verifier C1: confidence-drop modifiers compare on integer permille
// (Math.round((before - after) * 1000), thresholds 300/100) — float >= 0.1
// silently misses the mainline 0.9→0.8 single-correction supersede drop.
// Verifier C2: low_confidence_result guards with Number.isFinite (NaN excluded).

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ADVISOR_CONTRACT_VERSION,
  adviseProposalV1,
  attachAdvisorV1,
  advisorBandForPermilleV1,
} from '../advisor.js';
import type { ConsolidationProposal } from '../types.js';

function makeProposal(overrides: Partial<ConsolidationProposal> = {}): ConsolidationProposal {
  return {
    id: 'p-1',
    type: 'supersede',
    scope: 'project:test',
    affected_ids: ['sem-1'],
    before: {},
    after: {},
    score: 1,
    created_at: '2026-08-25T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('adviseProposalV1 — worked examples (§2.2, byte-exact)', () => {
  it('supersede of a decision node, 0.2 drop, signal_count 1 → clamp 1000, high', () => {
    const rec = adviseProposalV1(makeProposal({
      type: 'supersede',
      before: { confidence: 0.9, memory_type: 'decision', signal_count: 1 },
      after: { confidence: 0.7 },
    }));
    expect(rec).toEqual({
      contract: 'advisor/v1',
      risk_permille: 1000,
      band: 'high',
      reasons: ['base_supersede', 'confidence_drop_minor', 'decision_target', 'low_signal_count'],
      calibration: 'structural-only',
    });
  });

  it('nightly decay with drop 0.45, after 0.45 → 700, high', () => {
    const rec = adviseProposalV1(makeProposal({
      type: 'decay',
      before: { confidence: 0.9 },
      after: { confidence: 0.45 },
    }));
    expect(rec).toEqual({
      contract: 'advisor/v1',
      risk_permille: 700,
      band: 'high',
      reasons: ['base_decay', 'confidence_drop_major', 'low_confidence_result'],
      calibration: 'structural-only',
    });
  });

  it('queued promote at confidence 0.6 with 3 sources → 300, elevated', () => {
    const rec = adviseProposalV1(makeProposal({
      type: 'promote',
      affected_ids: ['ep-1', 'ep-2', 'ep-3'],
      before: {},
      after: { confidence: 0.6, signal_count: 3 },
    }));
    expect(rec).toEqual({
      contract: 'advisor/v1',
      risk_permille: 300,
      band: 'elevated',
      reasons: ['base_promote', 'multi_target'],
      calibration: 'structural-only',
    });
  });
});

describe('adviseProposalV1 — base scores and bands', () => {
  const bases = [
    ['supersede', 600, 'high', 'base_supersede'],
    ['merge', 500, 'elevated', 'base_merge'],
    ['decay', 400, 'elevated', 'base_decay'],
    ['promote', 200, 'low', 'base_promote'],
    ['reinforce', 100, 'low', 'base_reinforce'],
  ] as const;
  for (const [type, permille, band, reason] of bases) {
    it(`${type} → ${permille} (${band})`, () => {
      const rec = adviseProposalV1(makeProposal({ type }));
      expect(rec.risk_permille).toBe(permille);
      expect(rec.band).toBe(band);
      expect(rec.reasons).toEqual([reason]);
    });
  }
});

describe('adviseProposalV1 — verifier C1: integer-permille confidence drop', () => {
  it('0.9→0.8 (mainline single-correction supersede) emits confidence_drop_minor', () => {
    // Float math: 0.9 - 0.8 === 0.09999999999999998, which a float >= 0.1
    // comparison silently misses. Permille rounding makes it exactly 100.
    const rec = adviseProposalV1(makeProposal({
      before: { confidence: 0.9 },
      after: { confidence: 0.8 },
    }));
    expect(rec.reasons).toContain('confidence_drop_minor');
    expect(rec.risk_permille).toBe(700); // 600 base + 100 minor
  });

  it('0.5→0.4 emits confidence_drop_minor', () => {
    const rec = adviseProposalV1(makeProposal({
      before: { confidence: 0.5 },
      after: { confidence: 0.4 },
    }));
    expect(rec.reasons).toContain('confidence_drop_minor');
  });

  it('0.3-edge: 0.7→0.4 (float 0.29999999999999993) rounds to 300‰ → major', () => {
    const rec = adviseProposalV1(makeProposal({
      before: { confidence: 0.7 },
      after: { confidence: 0.4 },
    }));
    expect(rec.reasons).toContain('confidence_drop_major');
    expect(rec.reasons).not.toContain('confidence_drop_minor');
  });

  it('0.3-edge: 0.8→0.5 rounds to 300‰ → major', () => {
    const rec = adviseProposalV1(makeProposal({
      before: { confidence: 0.8 },
      after: { confidence: 0.5 },
    }));
    expect(rec.reasons).toContain('confidence_drop_major');
  });

  it('drop below 100‰ emits no drop reason', () => {
    const rec = adviseProposalV1(makeProposal({
      before: { confidence: 0.8 },
      after: { confidence: 0.75 },
    }));
    expect(rec.reasons).toEqual(['base_supersede']);
  });
});

describe('adviseProposalV1 — modifiers fire only on provably present, typed fields', () => {
  it('multi_target: fires for >1 affected id, not for 1', () => {
    expect(adviseProposalV1(makeProposal({ affected_ids: ['a', 'b'] })).reasons)
      .toContain('multi_target');
    expect(adviseProposalV1(makeProposal({ affected_ids: ['a'] })).reasons)
      .not.toContain('multi_target');
  });

  it('confidence drop: no reason when before.confidence is a string or after.confidence absent', () => {
    expect(adviseProposalV1(makeProposal({
      before: { confidence: '0.9' },
      after: { confidence: 0.4 },
    })).reasons.filter((r) => r.startsWith('confidence_drop'))).toEqual([]);
    expect(adviseProposalV1(makeProposal({
      before: { confidence: 0.9 },
      after: {},
    })).reasons.filter((r) => r.startsWith('confidence_drop'))).toEqual([]);
  });

  it('decision_target: fires only on before.memory_type === "decision"', () => {
    expect(adviseProposalV1(makeProposal({ before: { memory_type: 'decision' } })).reasons)
      .toContain('decision_target');
    expect(adviseProposalV1(makeProposal({ before: { memory_type: 'fact' } })).reasons)
      .not.toContain('decision_target');
    expect(adviseProposalV1(makeProposal({ before: {} })).reasons)
      .not.toContain('decision_target');
  });

  it('archived_target: fires only on before.archived === true (not truthy strings)', () => {
    expect(adviseProposalV1(makeProposal({ before: { archived: true } })).reasons)
      .toContain('archived_target');
    expect(adviseProposalV1(makeProposal({ before: { archived: 'true' } })).reasons)
      .not.toContain('archived_target');
    expect(adviseProposalV1(makeProposal({ before: { archived: false } })).reasons)
      .not.toContain('archived_target');
  });

  it('low_signal_count: fires at numeric <= 2, not at 3 or mistyped', () => {
    expect(adviseProposalV1(makeProposal({ before: { signal_count: 2 } })).reasons)
      .toContain('low_signal_count');
    expect(adviseProposalV1(makeProposal({ before: { signal_count: 3 } })).reasons)
      .not.toContain('low_signal_count');
    expect(adviseProposalV1(makeProposal({ before: { signal_count: '1' } })).reasons)
      .not.toContain('low_signal_count');
  });

  it('low_confidence_result: fires below 0.5, not at 0.5', () => {
    expect(adviseProposalV1(makeProposal({ after: { confidence: 0.49 } })).reasons)
      .toContain('low_confidence_result');
    expect(adviseProposalV1(makeProposal({ after: { confidence: 0.5 } })).reasons)
      .not.toContain('low_confidence_result');
  });

  it('verifier C2: NaN after.confidence is excluded (Number.isFinite guard)', () => {
    const rec = adviseProposalV1(makeProposal({ after: { confidence: Number.NaN } }));
    expect(rec.reasons).not.toContain('low_confidence_result');
    expect(rec.reasons.filter((r) => r.startsWith('confidence_drop'))).toEqual([]);
    expect(adviseProposalV1(makeProposal({ after: { confidence: '0.2' } })).reasons)
      .not.toContain('low_confidence_result');
  });
});

describe('adviseProposalV1 — clamp, bands, ordering, determinism, immutability', () => {
  const maxed = (): ConsolidationProposal => makeProposal({
    type: 'supersede',
    affected_ids: ['a', 'b'],
    before: {
      confidence: 0.9, memory_type: 'decision', archived: true, signal_count: 1,
    },
    after: { confidence: 0.3 },
  });

  it('clamps the sum at 1000', () => {
    // 600 + 100 + 200 + 250 + 100 + 100 + 100 = 1450 → 1000
    const rec = adviseProposalV1(maxed());
    expect(rec.risk_permille).toBe(1000);
    expect(rec.band).toBe('high');
  });

  it('band edges: 299 low, 300 elevated, 599 elevated, 600 high', () => {
    expect(advisorBandForPermilleV1(0)).toBe('low');
    expect(advisorBandForPermilleV1(299)).toBe('low');
    expect(advisorBandForPermilleV1(300)).toBe('elevated');
    expect(advisorBandForPermilleV1(599)).toBe('elevated');
    expect(advisorBandForPermilleV1(600)).toBe('high');
    expect(advisorBandForPermilleV1(1000)).toBe('high');
  });

  it('reasons are lexicographically sorted and deduped', () => {
    const { reasons } = adviseProposalV1(maxed());
    expect(reasons).toEqual([...reasons].slice().sort());
    expect(new Set(reasons).size).toBe(reasons.length);
    expect(reasons).toEqual([
      'archived_target', 'base_supersede', 'confidence_drop_major',
      'decision_target', 'low_confidence_result', 'low_signal_count', 'multi_target',
    ]);
  });

  it('is deterministic: two calls on the same proposal are deep-equal', () => {
    expect(adviseProposalV1(maxed())).toEqual(adviseProposalV1(maxed()));
  });

  it('returns a frozen record with a frozen reasons array', () => {
    const rec = adviseProposalV1(maxed());
    expect(Object.isFrozen(rec)).toBe(true);
    expect(Object.isFrozen(rec.reasons)).toBe(true);
  });

  it('exports the contract version constant', () => {
    expect(ADVISOR_CONTRACT_VERSION).toBe('advisor/v1');
  });
});

describe('attachAdvisorV1 — containment (never throws through the save paths)', () => {
  it('attaches the recommendation as an optional advisor field', () => {
    const proposal = makeProposal({ type: 'decay', before: { confidence: 0.9 }, after: { confidence: 0.45 } });
    const attached = attachAdvisorV1(proposal);
    expect(attached.advisor?.contract).toBe('advisor/v1');
    expect(attached.advisor?.band).toBe('high');
    // Original proposal fields carried through unchanged.
    expect({ ...attached, advisor: undefined }).toEqual({ ...proposal, advisor: undefined });
  });

  it('on a poisoned proposal it logs one typed line and returns the proposal unchanged', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const poisoned = new Proxy(makeProposal(), {
      get(target, prop, receiver) {
        if (prop === 'before') throw new Error('poisoned getter');
        return Reflect.get(target, prop, receiver);
      },
    });
    const out = attachAdvisorV1(poisoned);
    expect(out).toBe(poisoned); // unchanged, same reference — the save proceeds without advice
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0]))
      .toMatch(/^\[advisor\] scoring failed for proposal p-1: /);
  });
});
