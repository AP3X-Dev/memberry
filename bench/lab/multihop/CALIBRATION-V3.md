# RET-007 v3 — calib-split difficulty calibration log

Local, non-authoritative (spec: "Calibration procedure (D2, local, non-authoritative)").
Control arm: `memberry-retrieval-core-v1`, fixture execution mode, via
`bench/lab/multihop/calibrate-v3.ts` over the CALIB split generated in-memory by
`bench/lab/multihop/generate-v3.ts`. Metric: `strict-multi-hop-task-success-v3`
(both required hops in the top k=10). Target: overall calib control success in
[0.30, 0.70] with >= 1 success and >= 1 failure per density stratum. Dev and
holdout bytes were never generated, read, or scored during calibration.

Measured v2 knob endpoints (from `measure-v2-knobs.output.txt`, v2 dev input only):
bridgeTokenCollisions max per density = {low: 1, medium: 2, high: 2};
factTokenEcho max per density = {low: 2, medium: 2, high: 4}.
All trial values below are inside `MULTIHOP_V3_KNOB_BOUNDS` (bounds-checked at
each run by `validateMultiHopV3Knobs`).

Knob key: corpus = corpusSizePerScenario; bridge = bridgeTokenCollisions
(low/medium/high); share = domainLexicalOverlapShare; echo = factTokenEcho.

| # | corpus | bridge | share | echo | overall | strata success/failure (low, medium, high) | in band |
|---|--------|--------|-------|------|---------|--------------------------------------------|---------|
| 1 | 24 | 1/2/2 | 0.5/0.5/0.5 | 1/2/2 | 2/15 = 0.133 | 1/4, 0/5, 1/4 | NO (below band; medium stratum has no success) |
| 2 | 11 | 0/0/0 | 0.25/0.25/0.25 | 0/0/0 | 15/15 = 1.000 | 5/0, 5/0, 5/0 | NO (saturated; easy endpoint probe) |
| 3 | 16 | 0/1/2 | 0.3/0.4/0.5 | 0/1/2 | 11/15 = 0.733 | 4/1, 3/2, 4/1 | NO (0.733 > 0.70) |
| 4 | 18 | 0/1/2 | 0.3/0.4/0.5 | 0/1/2 | 7/15 = 0.467 | 4/1, 1/4, 2/3 | YES |
| 5 | 17 | 0/1/2 | 0.3/0.4/0.5 | 0/1/2 | 8/15 = 0.533 | 4/1, 2/3, 2/3 | YES |

## Convergence decision

Iterations 4 and 5 are both in band. Iteration 5 (corpus 17) is chosen: its
overall rate (0.533) is closest to the band center and its medium stratum
carries 2 successes rather than 1, leaving more per-stratum slack for the
one-shot dev/holdout qualification at n = 7/7/6.

**Frozen `MULTIHOP_V3_KNOBS`** (committed in `policy-v3.ts`):

```json
{
  "corpusSizePerScenario": 17,
  "bridgeTokenCollisions": { "low": 0, "medium": 1, "high": 2 },
  "domainLexicalOverlapShare": { "low": 0.3, "medium": 0.4, "high": 0.5 },
  "factTokenEcho": { "low": 0, "medium": 1, "high": 2 }
}
```

Confirmation run at the frozen values (calibrate-v3.ts with no arguments):
overall 8/15 = 0.533; strata low 4/1, medium 2/3, high 2/3; in band.

After this freeze, dev and holdout were generated exactly once from the frozen
knobs and hashed into `MULTIHOP_V3_FREEZE.artifacts`. Any later knob or dataset
byte change invalidates the packet.
