# RET-007 v4 — calib-split difficulty calibration log

Local, non-authoritative (spec "Calibration procedure (D2)").
Control arm: `memberry-retrieval-core-funnel-v1` (BM25-only funnel, top-N = 12 CONSTANT by rule
N = K + 2; never tuned), fixture execution mode, via `bench/lab/multihop/calibrate-v4.ts` over the
CALIB split generated in-memory by `bench/lab/multihop/generate-v4.ts`. Metric:
`strict-multi-hop-task-success-v4` (both required hops in the top k = 10).

Pre-registered acceptance (`MULTIHOP_V4_CALIB_ACCEPTANCE`): calib success in [0.42, 0.58] AND >= 3
successes and >= 3 failures per density stratum AND headroom H >= 0.25 AND H score-driven (>= 80% of
B-withheld scenarios have B's BM25 score STRICTLY below the 12th emitted score). Ledger line: if the
frozen H < 0.30, the D3 record must flag that the achievable delta may sit near the +10 threshold.

Definitions reported per run:
- H = share of calib scenarios in which memory B is NOT in the pass-1 funnel emission (12 of 22).
- sd = score-driven share among B-withheld scenarios.
- straddle = number of scenarios in which at least one memory tied at the boundary score fell OUTSIDE
  the emission; maxTied = the largest number of memories sharing the boundary score in any scenario.
- Only DATASET knobs were varied: corpus = corpusSizePerScenario; bridge = bridgeTokenCollisions
  (low/medium/high, max 1 under C1); share = domainLexicalOverlapShare; echo = factTokenEcho. Every
  trial was bounds-checked by `validateMultiHopV4Knobs`. N = 12 was never touched.

Dev, holdout and twin bytes were never generated, read, or scored during calibration.

## Generator revisions during calibration (transparency)

Each configuration re-draws the whole calib split (domains, forms, templates, names) from the
split PRNG, so per-configuration results carry sampling noise of roughly +/- 0.07 on the rate.
Two generator revisions preceded the committed one; their iterations are listed for the record but
are NOT reproducible with the committed generator:

- Revision A (iteration 1): 8 extra-distractor templates drawn WITH replacement, 80 base names.
  Repeated templates tied exactly under BM25 (mean 3.2 memories tied at the boundary, max 10) and
  2 of 5 B-withholdings were tie-driven (sd 0.60).
- Revision B (iterations 2-7): 20 distinct extra-distractor templates drawn WITHOUT replacement per
  scenario (12 subject/bridge-bearing, 8 answer-only), still 80 base names (6320 compound names).
  At corpus 24 the globally-disjoint name draw exhausted the pool (~30 names x 235 scenarios).
- Revision C (iterations 8-40, COMMITTED): as B with 90 base names (8010 compound names). No
  generator change after iteration 8; iteration 40 is the confirmation run at the frozen knobs.

## Iteration log

| # | corpus | bridge | share | echo | overall | strata s/f (low, medium, high) | H (withheld low/med/high) | sd | straddle / maxTied | accepted |
|---|--------|--------|-------|------|---------|--------------------------------|---------------------------|----|--------------------|----------|
| 1 (rev A) | 18 | 0/1/1 | 0.5/0.7/0.9 | 0/1/2 | 31/45 = 0.689 | 12/3, 11/4, 8/7 | 0.111 (5) | 0.60 | 21 / 10 | NO (rate, H, sd) |
| 2 (rev B) | 18 | 0/1/1 | 0.5/0.7/0.9 | 0/1/2 | 32/45 = 0.711 | 12/3, 7/8, 13/2 | 0.022 (0/1/0) | 1.00 | 17 / 11 | NO (rate, high stratum, H) |
| 3 (rev B) | 24 | 0/1/1 | 0.6/0.75/0.9 | 0/1/2 | — | — | — | — | — | NO (name pool exhausted at twin[23]) |
| 4 (rev B) | 24 | 0/1/1 | 0.7/0.8/0.9 | 0/1/2 | — | — | — | — | — | NO (name pool exhausted) |
| 5 (rev B) | 24 | 0/1/1 | 0.7/0.85/1.0 | 0/1/2 | — | — | — | — | — | NO (name pool exhausted) |
| 6 (rev B) | 22 | 0/1/1 | 0.7/0.85/1.0 | 0/1/2 | 15/45 = 0.333 | 10/5, 2/13, 3/12 | 0.422 (2/6/11) | 1.00 | 9 / 12 | NO (rate, medium stratum) |
| 7 (rev B) | 24 | 1/1/1 | 0.75/0.85/0.95 | 1/1/2 | — | — | — | — | — | NO (name pool exhausted) |
| 8 | 22 | 0/1/1 | 0.6/0.6/0.6 | 0/1/2 | 30/45 = 0.667 | 10/5, 10/5, 10/5 | 0.044 (2/0/0) | 1.00 | 14 / 14 | NO (rate, H) |
| 9 | 22 | 0/1/1 | 0.7/0.7/0.7 | 0/1/2 | 25/45 = 0.556 | 10/5, 6/9, 9/6 | 0.133 (2/3/1) | 1.00 | 13 / 12 | NO (H) |
| 10 | 22 | 0/1/1 | 0.75/0.75/0.75 | 0/1/2 | 24/45 = 0.533 | 9/6, 5/10, 10/5 | 0.133 (2/3/1) | 1.00 | 2 / 2 | NO (H) |
| 11 | 22 | 0/1/1 | 0.8/0.8/0.8 | 0/1/2 | 23/45 = 0.511 | 8/7, 6/9, 9/6 | 0.289 (5/3/5) | 1.00 | 3 / 2 | YES (H < 0.30 flag) |
| 12 | 24 | 0/1/1 | 0.7/0.7/0.7 | 0/1/2 | 27/45 = 0.600 | 9/6, 6/9, 12/3 | 0.089 (2/2/0) | 1.00 | 4 / 2 | NO (rate, H) |
| 13 | 24 | 0/1/1 | 0.8/0.8/0.8 | 0/1/2 | 14/45 = 0.311 | 2/13, 5/10, 7/8 | 0.511 (13/7/3) | 1.00 | 6 / 3 | NO (rate, low stratum) |
| 14 | 20 | 0/1/1 | 0.8/0.8/0.8 | 0/1/2 | 29/45 = 0.644 | 10/5, 9/6, 10/5 | 0.156 (3/1/3) | 1.00 | 15 / 9 | NO (rate, H) |
| 15 | 20 | 0/1/1 | 0.9/0.9/0.9 | 0/1/2 | 23/45 = 0.511 | 7/8, 6/9, 10/5 | 0.289 (5/6/2) | 1.00 | 11 / 3 | YES (H < 0.30 flag) |
| 16 | 22 | 0/1/1 | 0.85/0.85/0.85 | 0/1/2 | 14/45 = 0.311 | 4/11, 3/12, 7/8 | 0.422 (8/8/3) | 1.00 | 12 / 11 | NO (rate) |
| 17 | 22 | 0/1/1 | 0.75/0.8/0.85 | 0/1/2 | 22/45 = 0.489 | 9/6, 6/9, 7/8 | 0.222 (2/4/4) | 1.00 | 7 / 12 | NO (H) |
| 18 | 23 | 0/1/1 | 0.8/0.8/0.8 | 0/1/2 | 16/45 = 0.356 | 6/9, 4/11, 6/9 | 0.489 (8/8/6) | 1.00 | 5 / 2 | NO (rate) |
| 19 | 24 | 0/1/1 | 0.75/0.75/0.75 | 0/1/2 | 14/45 = 0.311 | 3/12, 3/12, 8/7 | 0.533 (11/8/5) | 1.00 | 8 / 3 | NO (rate) |
| 20 | 21 | 0/1/1 | 0.85/0.85/0.85 | 0/1/2 | 25/45 = 0.556 | 6/9, 9/6, 10/5 | 0.178 (6/1/1) | 1.00 | 10 / 10 | NO (H) |
| 21 | 22 | 0/1/1 | 0.8/0.85/0.9 | 0/1/2 | 24/45 = 0.533 | 8/7, 7/8, 9/6 | 0.244 (5/3/3) | 1.00 | 7 / 11 | NO (H) |
| 22 | 22 | 1/1/1 | 0.8/0.8/0.8 | 0/1/2 | 26/45 = 0.578 | 11/4, 6/9, 9/6 | 0.133 (1/5/0) | 1.00 | 7 / 11 | NO (H) |
| 23 | 22 | 0/1/1 | 0.8/0.8/0.8 | 0/0/1 | 23/45 = 0.511 | 8/7, 8/7, 7/8 | 0.200 (5/2/2) | 1.00 | 4 / 4 | NO (H) |
| 24 | 22 | 0/1/1 | 0.8/0.8/0.85 | 0/1/2 | 22/45 = 0.489 | 8/7, 6/9, 8/7 | 0.267 (5/3/4) | 1.00 | 3 / 11 | YES (H < 0.30 flag) |
| 25 | 22 | 0/1/1 | 0.8/0.85/0.8 | 0/1/2 | 24/45 = 0.533 | 8/7, 7/8, 9/6 | 0.222 (5/3/2) | 1.00 | 9 / 11 | NO (H) |
| 26 | 22 | 0/1/1 | 0.85/0.8/0.8 | 0/1/2 | 20/45 = 0.444 | 4/11, 7/8, 9/6 | 0.400 (8/7/3) | 1.00 | 9 / 11 | YES (non-monotone strata) |
| 27 | 22 | 0/0/1 | 0.8/0.8/0.8 | 0/1/2 | 23/45 = 0.511 | 8/7, 7/8, 8/7 | 0.244 (5/3/3) | 1.00 | 7 / 12 | NO (H) |
| 28 | 22 | 0/1/1 | 0.8/0.8/0.8 | 0/1/1 | 24/45 = 0.533 | 8/7, 6/9, 10/5 | 0.200 (5/3/1) | 1.00 | 8 / 11 | NO (H) |
| 29 | 22 | 0/1/1 | 0.8/0.8/0.8 | 1/1/2 | 24/45 = 0.533 | 9/6, 6/9, 9/6 | 0.156 (2/5/0) | 1.00 | 7 / 2 | NO (H) |
| 30 | 23 | 0/1/1 | 0.75/0.75/0.75 | 0/1/2 | 18/45 = 0.400 | 3/12, 6/9, 9/6 | 0.400 (10/4/4) | 1.00 | 4 / 2 | NO (rate) |
| 31 | 23 | 0/1/1 | 0.75/0.75/0.8 | 0/1/2 | 17/45 = 0.378 | 3/12, 6/9, 8/7 | 0.422 (10/4/5) | 1.00 | 6 / 2 | NO (rate) |
| 32 | 22 | 0/1/1 | 0.8/0.85/0.85 | 0/1/2 | 24/45 = 0.533 | 8/7, 7/8, 9/6 | 0.267 (5/3/4) | 1.00 | 6 / 11 | YES (H < 0.30 flag) |
| 33 | 22 | 0/1/1 | 0.8/0.8/0.85 | 0/0/1 | 24/45 = 0.533 | 8/7, 8/7, 8/7 | 0.267 (5/2/5) | 1.00 | 2 / 2 | YES (H < 0.30 flag) |
| 34 | 22 | 0/1/1 | 0.75/0.85/0.85 | 0/1/2 | 20/45 = 0.444 | 9/6, 4/11, 7/8 | 0.222 (2/4/4) | 1.00 | 9 / 11 | NO (H) |
| 35 | 22 | 0/0/0 | 0.8/0.8/0.85 | 0/1/2 | 23/45 = 0.511 | 8/7, 7/8, 8/7 | 0.289 (5/3/5) | 1.00 | 4 / 2 | YES (H < 0.30 flag) |
| 36 | 21 | 0/1/1 | 0.8/0.85/0.9 | 0/1/2 | 23/45 = 0.511 | 10/5, 6/9, 7/8 | 0.200 (1/3/5) | 1.00 | 10 / 10 | NO (H) |
| 37 | 23 | 0/1/1 | 0.7/0.75/0.8 | 0/1/2 | 25/45 = 0.556 | 9/6, 9/6, 7/8 | 0.200 (3/1/5) | 1.00 | 5 / 2 | NO (H) |
| 38 | 22 | 0/0/1 | 0.8/0.85/0.85 | 0/1/2 | 19/45 = 0.422 | 8/7, 2/13, 9/6 | 0.333 (5/7/3) | 1.00 | 7 / 3 | NO (medium stratum) |
| 39 | 22 | 0/1/1 | 0.8/0.85/0.85 | 0/0/0 | 22/45 = 0.489 | 8/7, 5/10, 9/6 | 0.311 (5/4/5) | 1.00 | 3 / 11 | **YES** |
| 40 (confirm) | 22 | 0/1/1 | 0.8/0.85/0.85 | 0/0/0 | 22/45 = 0.489 | 8/7, 5/10, 9/6 | 0.311 (5/4/5) | 1.00 | 3 / 11 | **YES** |

## Convergence decision

Seven configurations satisfied the acceptance (11, 15, 24, 26, 32, 33, 35, 39). Iteration 39 is
chosen: it is the only accepted configuration whose knob values are monotone across the density
strata AND whose headroom H = 0.311 sits above the pre-registered 0.30 ledger flag (the others
have H in [0.267, 0.289], or — iteration 26, H = 0.400 — a non-monotone share vector that makes the
"low" stratum the hardest). Its overall rate (0.489) is near the band centre and every stratum has
at least 5 successes and 6 failures. Every B-withholding is score-driven (14/14). The response
surface is dominated by the domain-vocabulary count (share x 20 distractors): 16 domain distractors
(share 0.80) leaves B mostly emitted, 17 (share 0.85) withholds it in roughly a third of scenarios,
and 18+ (corpus 23-24 at the same share) collapses the rate below the band.

Boundary-tie report at the frozen knobs (per scenario, from `calibrate-v4.ts --per-scenario`):
- B withheld (14): mh4-c-01, 05, 11, 14, 15 (low); 19, 20, 28, 30 (medium); 33, 38, 42, 43, 45
  (high). In every one of them B's score is STRICTLY below the 12th emitted score (score-driven).
- Memories tied at the boundary score: 1 in 32 scenarios, 2 in 12 scenarios, 11 in one scenario
  (mh4-c-18: the boundary falls inside a block of zero-score generic distractors; B was emitted).
- Scenarios with a straddle (a tied memory outside the emission): 3 (mh4-c-06, mh4-c-18,
  mh4-c-28). None of the three straddles involves B: in c-06 and c-18 B is emitted; in c-28 B is
  withheld strictly below the boundary.
- Ledger line: delta_max ~= H x capture = 0.311 x capture; at capture 0.5-0.7 the achievable delta
  is ~ +16 to +22 points, above the +10 reporting threshold; no flag required (H >= 0.30).

Knob echo = 0 in every stratum means `factTokenEcho` is a dead knob at the frozen values (any
non-zero echo lowered H below the floor at share 0.80-0.85, iterations 11/21/28/29/32); it remains a
pre-registered, bounds-checked knob and is reported as such.

**Frozen `MULTIHOP_V4_KNOBS`** (committed in `policy-v4.ts`):

```json
{
  "corpusSizePerScenario": 22,
  "bridgeTokenCollisions": { "low": 0, "medium": 1, "high": 1 },
  "domainLexicalOverlapShare": { "low": 0.8, "medium": 0.85, "high": 0.85 },
  "factTokenEcho": { "low": 0, "medium": 0, "high": 0 }
}
```

Confirmation run at the frozen values (`calibrate-v4.ts` with no arguments): overall 22/45 = 0.489;
strata low 8/7, medium 5/10, high 9/6; H = 14/45 = 0.311; score-driven 14/14; accepted.

After this freeze, calib, dev, holdout and twin were generated exactly once from the frozen knobs
and hashed into `MULTIHOP_V4_FREEZE.artifacts` (four splits) and `registry/datasets.json`. Any later
knob, generator, or dataset byte change invalidates the packet.
