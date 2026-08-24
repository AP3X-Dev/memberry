# Admission-Feature Labels v2 — Labeling Function

Deterministic mapping from `signals` to oracle `dimensions`. Fully determined by
the dev split; publishing it leaks nothing beyond dev.

## Availability

A dimension is `available` iff its driving signal is not `unknown`; otherwise it is
`{"availability":"unavailable"}` with no `valuePermille`. Adjustment rules never
change availability: an adjustment whose *trigger* signal is `unknown` simply does
not fire.

| Dimension | Driving signal |
|---|---|
| salience | priority |
| novelty | noveltyEvidence |
| durability | retentionHorizon |
| evidenceQuality | evidenceSupport |
| scopeConfidence | scopeBinding |
| sensitivity | sensitivitySignal |

## Base values (permille)

| Dimension | Category → base |
|---|---|
| salience | none → 25, normal → 100, explicit → 850 |
| novelty | none → 50, partial → 500, independent → 900 |
| durability | transient → 150, session → 700, durable → 800 |
| evidenceQuality | none → 0, single → 450, corroborated → 1000 |
| scopeConfidence | missing → 100, inferred → 600, explicit → 1000 |
| sensitivity | none → 0, possible → 50, confirmed → 900 |

## Adjustment rules

Applied after base lookup, in the order listed. Each result is floored at 0
(`max(0, base - reduction)`). No cap rule is needed (no adjustment increases values).

- **R1 (corroboration discounts novelty):** if `evidenceSupport = corroborated` and
  novelty is available, `novelty = max(0, base - 300)`. Applies to every novelty
  base (none, partial, independent).
- **R2 (sensitivity discounts scope confidence):** if scopeConfidence is available,
  `sensitivitySignal = possible` reduces it by 100 and `sensitivitySignal = confirmed`
  reduces it by 250; `scopeConfidence = max(0, base - reduction)`.
  `none` and `unknown` sensitivity apply no reduction.

No other cross-signal interactions exist.

## Lineage

The v1 dev split (af-dev-001..003 of dataset 1.0.0) is reproduced exactly by this
function; v2 dev scenarios 001–003 mirror those inputs.
