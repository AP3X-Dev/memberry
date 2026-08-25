# RET-007 v4 — exchangeability report (C5)

Instrument memberry-multihop-v4 4.0.0; frozen knobs {"corpusSizePerScenario":22,"bridgeTokenCollisions":{"low":0,"medium":1,"high":1},"domainLexicalOverlapShare":{"low":0.8,"medium":0.85,"high":0.85},"factTokenEcho":{"low":0,"medium":0,"high":0}}.
Generated deterministically by `bench/lab/multihop/exchangeability-v4.ts` from the frozen bytes.

## Custody statement (read first)

- Per custody, control success on dev, holdout and twin is NOT computed locally: it is the hosted
  one-shot's job (D3). The control comparison below is therefore CALIB-ONLY; the dev/holdout/twin
  marginals are STRUCTURAL (adapter-visible inputs only; no oracle opened; no scenario outcome).
- The calib-vs-dev two-proportion test (`twoProportionTest`) is to be run at D3 from the receipt's
  closed aggregate (dev successes / 60) against the calib figure published here.
- Distractor-probe overlap = Jaccard over the funnel tokenizer; pre-registered band [0, 0.5]
  (asserted per scenario by the generator, C2 iv). The structural overlap proxy below excludes the two
  highest-overlap memories per scenario because the oracle is not opened for this report.

## Knob-marginal histograms per split (structural)

### calib (n = 45)

| density | count |
|---|---|
| low | 15 |
| medium | 15 |
| high | 15 |

| family | count |
|---|---|
| routing | 9 |
| assignment | 9 |
| component | 9 |
| custody | 9 |
| maintenance | 9 |

| corpus size | count |
|---|---|
| 22 | 45 |

| max distractor-probe overlap (proxy) | count |
|---|---|
| [0.0, 0.1) | 0 |
| [0.1, 0.2) | 4 |
| [0.2, 0.3) | 41 |
| [0.3, 0.4) | 0 |
| [0.4, 0.5) | 0 |
| [0.5, 1.0] | 0 |

Mean distractor-probe overlap (proxy): 0.0870

| domain | count |
|---|---|
| aquarium | 3 |
| bindery | 3 |
| brewery | 1 |
| candleworks | 1 |
| clockworks | 3 |
| cooperage | 1 |
| dairy | 2 |
| foundry | 2 |
| glassworks | 3 |
| herbarium | 2 |
| icehouse | 3 |
| lighthouse | 1 |
| mint | 1 |
| observatory | 1 |
| papermill | 2 |
| planetarium | 3 |
| pottery | 3 |
| printworks | 2 |
| ropewalk | 1 |
| saltern | 2 |
| tannery | 2 |
| vineyard | 2 |
| weaving | 1 |

### dev (n = 60)

| density | count |
|---|---|
| low | 20 |
| medium | 20 |
| high | 20 |

| family | count |
|---|---|
| routing | 12 |
| assignment | 12 |
| component | 12 |
| custody | 12 |
| maintenance | 12 |

| corpus size | count |
|---|---|
| 22 | 60 |

| max distractor-probe overlap (proxy) | count |
|---|---|
| [0.0, 0.1) | 0 |
| [0.1, 0.2) | 1 |
| [0.2, 0.3) | 59 |
| [0.3, 0.4) | 0 |
| [0.4, 0.5) | 0 |
| [0.5, 1.0] | 0 |

Mean distractor-probe overlap (proxy): 0.0878

| domain | count |
|---|---|
| apiary | 4 |
| aquarium | 1 |
| bakery | 2 |
| bindery | 3 |
| candleworks | 2 |
| clockworks | 1 |
| cooperage | 2 |
| dairy | 4 |
| distillery | 2 |
| foundry | 2 |
| glassworks | 2 |
| herbarium | 2 |
| icehouse | 2 |
| lighthouse | 1 |
| mint | 4 |
| observatory | 4 |
| orchard | 2 |
| papermill | 2 |
| pottery | 2 |
| printworks | 3 |
| ropewalk | 2 |
| saltern | 4 |
| seedbank | 4 |
| tannery | 1 |
| vineyard | 2 |

### holdout (n = 100)

| density | count |
|---|---|
| low | 34 |
| medium | 33 |
| high | 33 |

| family | count |
|---|---|
| routing | 20 |
| assignment | 20 |
| component | 20 |
| custody | 20 |
| maintenance | 20 |

| corpus size | count |
|---|---|
| 22 | 100 |

| max distractor-probe overlap (proxy) | count |
|---|---|
| [0.0, 0.1) | 0 |
| [0.1, 0.2) | 6 |
| [0.2, 0.3) | 94 |
| [0.3, 0.4) | 0 |
| [0.4, 0.5) | 0 |
| [0.5, 1.0] | 0 |

Mean distractor-probe overlap (proxy): 0.0846

| domain | count |
|---|---|
| apiary | 2 |
| aquarium | 1 |
| bakery | 3 |
| bindery | 2 |
| brewery | 5 |
| candleworks | 4 |
| clockworks | 4 |
| cooperage | 4 |
| dairy | 3 |
| distillery | 2 |
| foundry | 5 |
| glassworks | 5 |
| herbarium | 4 |
| icehouse | 3 |
| lighthouse | 3 |
| mint | 5 |
| observatory | 4 |
| orchard | 5 |
| papermill | 3 |
| planetarium | 3 |
| pottery | 5 |
| printworks | 3 |
| ropewalk | 5 |
| saltern | 1 |
| seedbank | 5 |
| tannery | 2 |
| vineyard | 4 |
| weaving | 5 |

### twin (n = 30)

| density | count |
|---|---|
| low | 10 |
| medium | 10 |
| high | 10 |

| family | count |
|---|---|
| routing | 6 |
| assignment | 6 |
| component | 6 |
| custody | 6 |
| maintenance | 6 |

| corpus size | count |
|---|---|
| 22 | 30 |

| max distractor-probe overlap (proxy) | count |
|---|---|
| [0.0, 0.1) | 0 |
| [0.1, 0.2) | 0 |
| [0.2, 0.3) | 30 |
| [0.3, 0.4) | 0 |
| [0.4, 0.5) | 0 |
| [0.5, 1.0] | 0 |

Mean distractor-probe overlap (proxy): 0.0863

| domain | count |
|---|---|
| apiary | 1 |
| aquarium | 3 |
| bakery | 1 |
| bindery | 1 |
| candleworks | 1 |
| clockworks | 2 |
| cooperage | 2 |
| glassworks | 2 |
| herbarium | 3 |
| icehouse | 3 |
| mint | 1 |
| orchard | 1 |
| papermill | 1 |
| planetarium | 1 |
| saltern | 1 |
| seedbank | 1 |
| tannery | 2 |
| weaving | 3 |

## Calib-only control success (funnel control, committed calib bytes)

- n = 45; successes = 22; rate = 0.4889
- low: 8/7 (n = 15)
- medium: 5/10 (n = 15)
- high: 9/6 (n = 15)
- headroom H = 14/45 = 0.3111; score-driven share = 1.0000
- tie summary: scenarios with a boundary straddle = 3; max tied at boundary = 11; mean tied at boundary = 1.5111

## Two-proportion test (calib vs dev) — DEFERRED to D3

At D3, compute `twoProportionTest(22, 45, devSuccesses, 60)` from the hosted receipt's
closed dev aggregate. Pre-registered reading: |z| < 1.96 is consistent with exchangeability of calib
and dev under the shared-pool draw; |z| >= 1.96 is flagged in the D3 record (it does not change the
D3 verdict, which is the pre-registered band on dev and holdout).

