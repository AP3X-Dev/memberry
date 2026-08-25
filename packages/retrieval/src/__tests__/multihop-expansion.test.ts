// RET-007 v4 D5 — multihop-expansion module bites (spec §2/§5/§6/§8).

import { describe, expect, it, vi } from 'vitest';

import {
  MULTIHOP_BRIDGE_DERIVATION,
  MULTIHOP_EXPANSION_FLAG,
  MULTIHOP_LAB_BUDGET_MS,
  MULTIHOP_PASS1_BUDGET_MS,
  MULTIHOP_RRF_K,
  expandMultihopV1,
  type MultihopProbeInput,
} from '../multihop-expansion.js';
import type { RetrievalResult } from '../types.js';

function mem(id: string, content: string, score = 0.5): RetrievalResult {
  return { id, source_type: 'semantic', title: id, content, score, metadata: {} };
}

const QUERY = 'For hive frame Alder, name its apiary shed and the endpoint beyond it.';
const PASS1 = [
  mem('mem-a', 'Hive frame Alder is warehoused at apiary shed Basalt.'),
  mem('mem-d0', 'Hive frame Filler0 passed its scheduled apiary shed inspection.'),
  mem('mem-d1', 'Hive frame Filler1 passed its scheduled apiary shed inspection.'),
  mem('mem-d2', 'Visitor badge Generic2 was returned to the front desk.'),
  mem('mem-d3', 'Visitor badge Generic3 was returned to the front desk.'),
  mem('mem-d4', 'Visitor badge Generic4 was returned to the front desk.'),
];
const PASS2 = [
  mem('mem-b', 'Freight leaving apiary shed Basalt goes to extraction room Cinder.'),
  mem('mem-e', 'Basalt apiary shed endpoint ledger names Cinder as the endpoint.'),
];

function probeOf(results: RetrievalResult[]) {
  const calls: MultihopProbeInput[] = [];
  const probe = vi.fn(async (input: MultihopProbeInput) => { calls.push(input); return results; });
  return { probe, calls };
}

describe('expandMultihopV1', () => {
  it('pins the policy enum, the flag name, and the budget constants', () => {
    expect(MULTIHOP_BRIDGE_DERIVATION).toEqual(['evidence-bridge', 'fact-lexical']);
    expect(MULTIHOP_EXPANSION_FLAG).toBe('MEMBERRY_MULTIHOP_EXPANSION_V1');
    expect(MULTIHOP_PASS1_BUDGET_MS).toBe(1500);
    expect(MULTIHOP_LAB_BUDGET_MS).toBe(Number.POSITIVE_INFINITY);
    // Decision 2b(2): pre-registered literal, not a knob.
    expect(MULTIHOP_RRF_K).toBe(10);
  });

  it('evidence-bridge: derives the bridge (Basalt) ahead of sentence-initial words and probes uncovered(q) + bridge', async () => {
    const { probe, calls } = probeOf(PASS2);
    // Decision 2b(3): budgetSlots is the seam's memory-list length (12 in the lab funnel). At 6
    // slots a 6-item pass-1 fills every slot on fused order alone and nothing is promoted.
    const out = await expandMultihopV1({ policy: 'evidence-bridge', query: QUERY, pass1: PASS1, budgetSlots: 12, probe });
    expect(out.fired).toBe(true);
    expect(out.reason).toBe('fired');
    // Basalt: source rank 0, frequency 1. "Hive" (rank 0, frequency 3) and "Visitor" (rank 3) rank after it.
    expect(calls[0]!.bridge).toBe('Basalt');
    expect(calls[0]!.conditionedTask.split(' ')).toContain('Basalt');
    expect(calls[0]!.conditionedTask.split(' ')).toContain('endpoint');
    expect(calls[0]!.conditionedTask.split(' ')).toContain('beyond');
    expect(calls[0]!.conditionedTask.split(' ')).not.toContain('hive');
    expect(calls.length).toBeLessThanOrEqual(3);
    // Decision 2c re-record (was ['mem-b', 'mem-e'], the probe-RETURN order): the pass-2 list is
    // now ranked against the conditionedTask, where mem-e ('endpoint' twice + 'Basalt') outscores
    // mem-b ('Basalt' only). Membership and count are unchanged.
    expect(out.pass2Ids).toEqual(['mem-e', 'mem-b']);
    // Six pass-1 + two pass-2-only identities, all inside 12 slots.
    expect(out.results).toHaveLength(8);
    expect(out.results.map(({ id }) => id)).toContain('mem-b');
  });

  it('fact-lexical: one probe, no bridge, top-IDF terms of top-3 not in q (m <= 6)', async () => {
    const { probe, calls } = probeOf(PASS2);
    const out = await expandMultihopV1({ policy: 'fact-lexical', query: QUERY, pass1: PASS1, budgetSlots: 6, probe });
    expect(out.fired).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.bridge).toBeUndefined();
    const terms = calls[0]!.conditionedTask.split(' ');
    expect(terms).toContain('basalt');
    expect(terms).not.toContain('hive');
    const top3 = new Set(PASS1.slice(0, 3).flatMap(({ content }) => content.toLowerCase().match(/[a-z0-9]+/g) ?? []));
    const uncovered = [...new Set(QUERY.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter((token) => token.length >= 2 && !top3.has(token));
    expect(terms.slice(0, uncovered.length)).toEqual(uncovered);
    expect(terms.length - uncovered.length).toBeLessThanOrEqual(6);
  });

  it('C1: weighted [1.0, 0.6] RRF orders differently from unweighted RRF', async () => {
    // Decision 2b(2) re-recording: pass1 [a, b, c] + pass2 [x, y] at MULTIHOP_RRF_K = 10. The
    // Decision 2a BM25-lite rank of pass1 is a tie (each doc matches exactly one query term, equal
    // IDF and length) so position holds: a, b, c.
    //   unweighted RRF order: a, x, b, y, c   (a/x tie at 1/11 broken pass-1 first, b/y at 1/12)
    //   weighted   RRF order: a, b, c, x, y   (0.6/11 = 0.0545 < 1/13 = 0.0769)
    // The two orders still DIFFER at k = 10, so the fixture stays discriminating.
    const pass1 = [mem('a', 'Alpha Beta gamma'), mem('b', 'Alpha Beta delta'), mem('c', 'Alpha Beta epsilon')];
    const pass2 = [mem('x', 'beta zeta gamma'), mem('y', 'beta eta delta')];
    const out = await expandMultihopV1({
      policy: 'evidence-bridge', query: 'gamma delta epsilon', pass1, budgetSlots: 5, probe: async () => pass2,
    });
    expect(out.fired).toBe(true);
    expect(out.results.map(({ id }) => id)).toEqual(['a', 'b', 'c', 'x', 'y']);
  });

  it.each([
    'Is Alder warehoused at Basalt?',
    'Does the shed forward freight?',
    'Alder or Basalt, which one forwards freight?',
    'Alder vs Basalt shed comparison',
    'Alder compared to Basalt',
    'which is larger Alder shed or Basalt',
  ])('gate: comparison/yes-no query "%s" stays single pass', async (query) => {
    const { probe } = probeOf(PASS2);
    const out = await expandMultihopV1({ policy: 'evidence-bridge', query, pass1: PASS1, budgetSlots: 6, probe });
    expect(out).toMatchObject({ fired: false, reason: 'comparison-query', results: PASS1, pass2Ids: [] });
    expect(probe).not.toHaveBeenCalled();
  });

  it('gate: "vs" needs word boundaries (a token like "vsphere" is not a comparison)', async () => {
    const { probe } = probeOf(PASS2);
    const out = await expandMultihopV1({
      policy: 'evidence-bridge', query: 'For hive frame Alder in vsphere, name the endpoint beyond its shed.',
      pass1: PASS1, budgetSlots: 6, probe,
    });
    expect(out.fired).toBe(true);
    expect(probe).toHaveBeenCalled();
  });

  it('gate: requires a name-shaped token in pass-1 top-3 that is not in q (top-3, never top-1)', async () => {
    const hits = [mem('h1', 'Basalt question ledger one'), mem('h2', 'Basalt question ledger two')];
    const probe = vi.fn(async () => hits);
    const noNames = [mem('p', 'all lowercase content here'), mem('q', 'nothing shaped like a name'), mem('r', 'still nothing')];
    const out = await expandMultihopV1({ policy: 'evidence-bridge', query: 'lowercase question here', pass1: noNames, budgetSlots: 3, probe });
    expect(out).toMatchObject({ fired: false, reason: 'no-bridge' });
    expect(probe).not.toHaveBeenCalled();
    // The bridge lives in rank 3 (index 2), not rank 1: still fires.
    const thirdOnly = [mem('p', 'all lowercase content here'), mem('q', 'nothing shaped like a name'), mem('r', 'the Basalt ledger')];
    const fired = await expandMultihopV1({ policy: 'evidence-bridge', query: 'lowercase question here', pass1: thirdOnly, budgetSlots: 3, probe });
    expect(fired.fired).toBe(true);
    // A name-shaped token that already appears in q is subtracted.
    const inQuery = [mem('p', 'Basalt only'), mem('q', 'nothing'), mem('r', 'nothing')];
    const subtracted = await expandMultihopV1({ policy: 'evidence-bridge', query: 'about Basalt', pass1: inQuery, budgetSlots: 3, probe });
    expect(subtracted).toMatchObject({ fired: false, reason: 'no-bridge' });
  });

  it('novelty abort: fewer than 2 new pass-2 ids returns pass-1 unchanged', async () => {
    const out = await expandMultihopV1({
      policy: 'evidence-bridge', query: QUERY, pass1: PASS1, budgetSlots: 6, probe: async () => [PASS2[0]!],
    });
    expect(out).toMatchObject({ fired: false, reason: 'novelty-abort', results: PASS1, pass2Ids: [] });
  });

  it('novelty abort: Jaccard(top-k pass-2, top-k pass-1) > 0.7 returns pass-1 unchanged', async () => {
    const out = await expandMultihopV1({
      policy: 'evidence-bridge', query: QUERY, pass1: PASS1, budgetSlots: 6,
      probe: async () => [...PASS1.slice(0, 5), ...PASS2],
    });
    expect(out).toMatchObject({ fired: false, reason: 'novelty-abort', results: PASS1 });
  });

  it('distractor latch: a pass-2 hit sharing no token with q is dropped', async () => {
    const stray = mem('mem-stray', 'Umbrella stand Halcyon moved beside a lobby door.');
    const out = await expandMultihopV1({
      policy: 'evidence-bridge', query: QUERY, pass1: PASS1, budgetSlots: 12, probe: async () => [...PASS2, stray],
    });
    expect(out.fired).toBe(true);
    // Decision 2c re-record (was ['mem-b', 'mem-e'], the probe-RETURN order); same reason as above.
    // The latch itself is unchanged: mem-stray is still dropped.
    expect(out.pass2Ids).toEqual(['mem-e', 'mem-b']);
    expect(out.results.map(({ id }) => id)).not.toContain('mem-stray');
  });

  // Decision 2b(3) bite (c): the cap is applied by SKIPPING lower-fused pass-2-only items, never
  // by truncating the tail, and the freed slots go to pass-1 so the total is unchanged.
  it('budget: pass-2-only <= ceil(budgetSlots/2) even when the probe returns many, total slots unchanged', async () => {
    const many = Array.from({ length: 8 }, (_, index) => mem(`mem-p${index}`, `Basalt endpoint record ${index}`));
    const out = await expandMultihopV1({ policy: 'evidence-bridge', query: QUERY, pass1: PASS1, budgetSlots: 12, probe: async () => many });
    expect(out.fired).toBe(true);
    expect(out.results).toHaveLength(12);
    expect(out.pass2Ids).toHaveLength(6);
    // The six highest-fused pass-2-only items are kept; the two lowest are skipped.
    expect(out.pass2Ids).toEqual(['mem-p0', 'mem-p1', 'mem-p2', 'mem-p3', 'mem-p4', 'mem-p5']);
    // Every pass-1 item survives: nothing is evicted by lexical rank alone.
    expect(out.results.filter(({ id }) => !id.startsWith('mem-p'))).toHaveLength(6);
    // The head of the fused list is still pass-1: the best pass-2 term is 0.6/11 = 0.0545, below
    // the two best pass-1 terms (1/11 = 0.0909, 1/12 = 0.0833).
    expect(out.results.slice(0, 2).map(({ id }) => id)).toEqual(['mem-a', 'mem-d0']);
  });

  // Decision 2b(1) bite (a): MERGE not exclude — a hop-2 memory the funnel already emitted at a LOW
  // lexical rank, returned at rank 0 by the bridge-conditioned probe, accrues BOTH RRF terms and is
  // promoted into the top ceil(budget/2). Under the old pre-fusion exclusion it accrued only its
  // pass-1 term and was evicted as lexical tail.
  it('2b confirmed boost: a low-lexical-rank pass-1 hop confirmed by the probe enters the top ceil(budget/2)', async () => {
    const hop = mem('mem-b', 'Freight leaving that apiary shed goes to extraction room Cinder.');
    const pass1 = [
      mem('mem-a', 'Hive frame Alder is warehoused at apiary shed Basalt.'),
      ...Array.from({ length: 10 }, (_, index) =>
        mem(`mem-d${index}`, `Hive frame Filler${index} passed its scheduled apiary shed inspection for hive frame work.`)),
      hop,
    ];
    const novel = [
      mem('mem-n1', 'Apiary shed ledger one names an endpoint beyond the dock.'),
      mem('mem-n2', 'Apiary shed ledger two names an endpoint beyond the dock.'),
    ];
    const confirmed = await expandMultihopV1({
      policy: 'evidence-bridge', query: QUERY, pass1, budgetSlots: 12, probe: async () => [hop, ...novel],
    });
    expect(confirmed.fired).toBe(true);
    expect(confirmed.results.slice(0, 6).map(({ id }) => id)).toContain('mem-b');
    // Same fixture, probe does NOT return the hop: it stays where its lexical rank put it.
    const unconfirmed = await expandMultihopV1({
      policy: 'evidence-bridge', query: QUERY, pass1, budgetSlots: 12, probe: async () => novel,
    });
    expect(unconfirmed.fired).toBe(true);
    expect(unconfirmed.results.slice(0, 6).map(({ id }) => id)).not.toContain('mem-b');
  });

  // Decision 2b(2)+(3) bite (b): a pass-2-ONLY rank-0 hit lands inside the top-10 of a 12-slot
  // output, and the pass-1 items are no longer evicted wholesale to make room for it.
  it('2b pass-2-only rank-0 hit lands inside the top-10 of a 12-slot output', async () => {
    const pass1 = [
      mem('mem-a', 'Hive frame Alder is warehoused at apiary shed Basalt.'),
      ...Array.from({ length: 11 }, (_, index) =>
        mem(`mem-d${index}`, `Hive frame Filler${index} passed its scheduled apiary shed inspection for hive frame work.`)),
    ];
    const hit = mem('mem-b', 'Freight leaving apiary shed Basalt goes to extraction room Cinder.');
    // Decision 2c re-record of the FIXTURE (was 'Basalt apiary shed endpoint ledger names Cinder as
    // the endpoint.'): "rank 0" used to mean probe-return position 0, which the probe controlled;
    // it now means best-by-conditionedTask. The old sibling carried 'endpoint' twice and would have
    // taken rank 0 from the hop, so the pin below would have measured the SIBLING's promotion, not
    // the hop's. Reworded to a plausible pass-2 sibling that matches q but not the conditioned task.
    const other = mem('mem-e', 'Apiary shed ledger lists a loading dock roster.');
    const out = await expandMultihopV1({
      policy: 'evidence-bridge', query: QUERY, pass1, budgetSlots: 12, probe: async () => [hit, other],
    });
    expect(out.fired).toBe(true);
    expect(out.results).toHaveLength(12);
    const ids = out.results.map(({ id }) => id);
    // The pass-2-ONLY rank-0 hit scores 0.6/11 = 0.0545, which beats the ninth pass-1 term
    // 1/(10 + 8 + 1) = 0.0526, so it lands at fused index 8 — inside the top-10.
    expect(ids.indexOf('mem-b')).toBe(8);
    expect(ids.indexOf('mem-b')).toBeLessThan(10);
    // Ten of the twelve pass-1 items survive (the old lexical-tail replacement kept only ten
    // because pass2Take was 2; with many pass-2 hits it kept six).
    expect(ids.filter((id) => id.startsWith('mem-a') || id.startsWith('mem-d'))).toHaveLength(10);
  });

  it('identityKey: a memory in both passes appears exactly once, is not novel, and is bridge-confirmed', async () => {
    // Served-style ids: `${channel}\0${rank}\0${evidenceId}` — the same memory carries two ids.
    const key = (result: RetrievalResult) => result.id.split(' ')[2]!;
    const pass1 = [
      mem('memory.scope 1 ev-a', 'Hive frame Alder is warehoused at apiary shed Basalt.'),
      mem('memory.scope 2 ev-d0', 'Hive frame Filler0 passed its scheduled apiary shed inspection.'),
      mem('memory.scope 3 ev-d1', 'Visitor badge Generic1 was returned to the front desk.'),
    ];
    const dup = mem('memory.scope 10001 ev-a', 'Hive frame Alder is warehoused at apiary shed Basalt.');
    const fresh = mem('memory.scope 10002 ev-b', 'Basalt forwards outbound freight to the endpoint Cinder.');
    const aborted = await expandMultihopV1({
      policy: 'evidence-bridge', query: QUERY, pass1, budgetSlots: 3, identityKey: key, probe: async () => [dup, fresh],
    });
    expect(aborted).toMatchObject({ fired: false, reason: 'novelty-abort' });
    const fresh2 = mem('memory.scope 10003 ev-e', 'Basalt endpoint ledger names the shed endpoint.');
    const out = await expandMultihopV1({
      policy: 'evidence-bridge', query: QUERY, pass1, budgetSlots: 5, identityKey: key, probe: async () => [dup, fresh, fresh2],
    });
    expect(out.fired).toBe(true);
    expect(out.results.map(key).filter((value) => value === 'ev-a')).toHaveLength(1);
    // Decision 2c re-record (was [fresh.id, fresh2.id], the probe-RETURN order): fresh2 carries
    // 'endpoint' twice and now leads the conditioned-task-ranked pass-2 list. Identity/dedup/
    // novelty behaviour under test is unchanged.
    expect(out.pass2Ids).toEqual([fresh2.id, fresh.id]);
    // Decision 2b(1): the merged identity keeps its PASS-1 result object (the served id encodes the
    // pass-1 channel rank) and accrues both RRF terms, so it leads the fused list.
    expect(out.results[0]!.id).toBe(pass1[0]!.id);
  });

  it('runs the probes concurrently under one injected-clock deadline and fails closed on deadline', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const probe = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return PASS2;
    };
    const pass1 = [
      mem('mem-a', 'Hive frame Alder is warehoused at apiary shed Basalt.'),
      mem('mem-b1', 'Courier slip Gossamer awaits a countersignature.'),
      mem('mem-c1', 'Notice board Saffron lists next month holidays.'),
    ];
    let now = 0;
    const out = await expandMultihopV1({
      policy: 'evidence-bridge', query: QUERY, pass1, budgetSlots: 3, probe, clock: () => now, budgetMs: 1000,
    });
    expect(out.fired).toBe(true);
    expect(maxInFlight).toBeGreaterThan(1);
    // Same probes, a clock that jumps past the budget while they run: pass-1 unchanged.
    now = 0;
    const late = await expandMultihopV1({
      policy: 'evidence-bridge', query: QUERY, pass1, budgetSlots: 3,
      probe: async (input) => { now = 5_000; return probe(input); },
      clock: () => now, budgetMs: 1000,
    });
    expect(late).toMatchObject({ fired: false, reason: 'deadline', results: pass1 });
  });

  it('skips pass 2 when pass-1 already exceeded the budget', async () => {
    const { probe } = probeOf(PASS2);
    const out = await expandMultihopV1({
      policy: 'evidence-bridge', query: QUERY, pass1: PASS1, budgetSlots: 6, probe, pass1ElapsedMs: MULTIHOP_PASS1_BUDGET_MS + 1,
    });
    expect(out).toMatchObject({ fired: false, reason: 'pass1-over-budget', results: PASS1 });
    expect(probe).not.toHaveBeenCalled();
  });

  it('fails closed to pass-1 on a throwing probe, a missing probe, or an empty pass-1', async () => {
    const thrown = await expandMultihopV1({
      policy: 'evidence-bridge', query: QUERY, pass1: PASS1, budgetSlots: 6, probe: async () => { throw new Error('boom'); },
    });
    expect(thrown).toMatchObject({ fired: false, reason: 'error', results: PASS1, pass2Ids: [] });
    const missing = await expandMultihopV1({ policy: 'evidence-bridge', query: QUERY, pass1: PASS1, budgetSlots: 6 });
    expect(missing).toMatchObject({ fired: false, reason: 'no-probe', results: PASS1 });
    const empty = await expandMultihopV1({ policy: 'evidence-bridge', query: QUERY, pass1: [], budgetSlots: 6, probe: async () => PASS2 });
    expect(empty).toMatchObject({ fired: false, reason: 'empty-pass1', results: [] });
    expect(thrown.results).toBe(PASS1);
  });

  // Decision 2a: pass-1 is UNRANKED at the seam; the module ranks it itself (BM25-lite vs q, ties by position).
  it('2a order-independence: a reversed pass-1 yields the same bridges and the same fused output', async () => {
    // No BM25 ties ANYWHERE (ties fall back to list position by the ruling, and Decision 2b(3)
    // keeps every pass-1 item in the output, so a tie anywhere would reorder the reversed run).
    const distinct = [
      PASS1[0]!,
      mem('mem-d0', 'Hive frame Filler0 passed a scheduled apiary shed inspection.'),
      mem('mem-d1', 'Hive frame Filler1 passed inspection at an apiary shed annex on a second morning.'),
      mem('mem-d2', 'Visitor badge Generic2 was returned to the front desk.'),
      mem('mem-d3', 'Visitor badge Generic3 was returned to the front desk after a long wait at the gate.'),
      mem('mem-d4', 'Visitor badge Generic4 was returned.'),
    ];
    const forward = probeOf(PASS2);
    const reversed = probeOf(PASS2);
    const a = await expandMultihopV1({ policy: 'evidence-bridge', query: QUERY, pass1: distinct, budgetSlots: 12, probe: forward.probe });
    const b = await expandMultihopV1({ policy: 'evidence-bridge', query: QUERY, pass1: [...distinct].reverse(), budgetSlots: 12, probe: reversed.probe });
    expect(a.fired).toBe(true);
    expect(b.fired).toBe(true);
    expect(reversed.calls.map(({ bridge }) => bridge)).toEqual(forward.calls.map(({ bridge }) => bridge));
    expect(reversed.calls.map(({ conditionedTask }) => conditionedTask)).toEqual(forward.calls.map(({ conditionedTask }) => conditionedTask));
    expect(b.results.map(({ id }) => id)).toEqual(a.results.map(({ id }) => id));
    expect(b.pass2Ids).toEqual(a.pass2Ids);
  });

  it('2a hop-1-last: the true hop-1 memory last in pass-1 still derives the bridge and B is fused in', async () => {
    const hopLast = [...PASS1.slice(1), PASS1[0]!];
    const { probe, calls } = probeOf(PASS2);
    const out = await expandMultihopV1({ policy: 'evidence-bridge', query: QUERY, pass1: hopLast, budgetSlots: 12, probe });
    expect(out.fired).toBe(true);
    expect(calls[0]!.bridge).toBe('Basalt');
    expect(out.results).toHaveLength(8);
    const ids = out.results.map(({ id }) => id);
    // The hop-1 memory is the most relevant PASS-1 item: it leads the output, and is never dropped
    // as tail.
    expect(ids[0]).toBe('mem-a');
    // Decision 2b(2): at MULTIHOP_RRF_K = 10 a pass-2 rank-0 item (0.6/11) outranks pass-1 items
    // ranked >= 8. Decision 2c re-record (was 6): the pass-2 items are ranked against the
    // conditionedTask, where mem-e outscores mem-b, so B follows it at index 7. B is still fused
    // in, which is the bite.
    expect(ids.indexOf('mem-b')).toBe(7);
  });

  // Decision 2c bite: the PASS-2 list arrives unranked too (the lab funnel emits corpus order), so
  // before 2c the pass-2 RRF rank was probe-return position — noise. The module now ranks each
  // probe's results with the SAME BM25-lite against THAT probe's conditionedTask. Here the
  // best-by-conditioned-task hit is returned LAST by the probe and the 8-slot budget admits only
  // two pass-2-only items: under the old corpus-order semantics it was the one cut.
  it('2c: the best-by-conditioned-task pass-2 item is returned LAST by the probe and still enters the output first', async () => {
    // conditionedTask = uncovered(q) + 'Basalt'; uncovered(q) drops the tokens covered by the
    // pass-1 top-3 (hive, frame, apiary, shed), leaving name/endpoint/beyond/it.
    const returned = [
      // Rank 2: shares 'shed' with q (so the distractor latch keeps it) but nothing with the
      // conditioned task.
      mem('mem-p2', 'The apiary shed roster was countersigned during the quiet hour.'),
      // Rank 1: 'endpoint' only.
      mem('mem-p1', 'A dock endpoint notice was pinned to the courier board.'),
      // Rank 0: 'Basalt' + 'endpoint' + 'beyond' — returned LAST by the probe.
      mem('mem-hop', 'Basalt forwards freight to the endpoint beyond it, extraction room Cinder.'),
    ];
    const { probe, calls } = probeOf(returned);
    const out = await expandMultihopV1({
      policy: 'evidence-bridge', query: QUERY, pass1: PASS1, budgetSlots: 8, probe,
    });
    expect(out.fired).toBe(true);
    expect(calls[0]!.bridge).toBe('Basalt');
    expect(out.results).toHaveLength(8);
    // mem-hop, returned LAST by the probe, leads pass-2 on its conditioned-task rank rather than on
    // probe-return position; mem-p2 (concatenated rank 2, 0.6/13 = 0.0461) loses to every pass-1
    // term and stays outside the eight slots.
    expect(out.pass2Ids).toEqual(['mem-hop', 'mem-p1']);
    expect(out.pass2Ids[0]).toBe('mem-hop');
    // All six pass-1 items keep their slots; the two pass-2 admissions fill the remainder.
    expect(out.results.filter(({ id }) => !id.startsWith('mem-p') && id !== 'mem-hop')).toHaveLength(6);
    // Probe-return order is NOT the pass-2 rank: reversing what the probe returns changes nothing.
    const reversed = probeOf([...returned].reverse());
    const same = await expandMultihopV1({
      policy: 'evidence-bridge', query: QUERY, pass1: PASS1, budgetSlots: 8, probe: reversed.probe,
    });
    expect(same.results.map(({ id }) => id)).toEqual(out.results.map(({ id }) => id));
  });

  it('2a gate-not-fired returns the caller\'s pass-1 list byte-identical (order preserved)', async () => {
    const reversed = [...PASS1].reverse();
    const { probe } = probeOf(PASS2);
    const out = await expandMultihopV1({ policy: 'evidence-bridge', query: 'Is Alder warehoused at Basalt?', pass1: reversed, budgetSlots: 6, probe });
    expect(out.results).toBe(reversed);
    const aborted = await expandMultihopV1({ policy: 'evidence-bridge', query: QUERY, pass1: reversed, budgetSlots: 6, probe: async () => [PASS2[0]!] });
    expect(aborted.results).toBe(reversed);
  });

  it('never reads a wall clock or randomness', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../multihop-expansion.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/Date\.now\(|Math\.random\(|new Date\(|performance\.now\(/);
  });
});
