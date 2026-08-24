# Admission-Feature Labels v3 — Live Producer Labeling Function

Deterministic mapping from the five safe facts in `facts` to the narrowed
three-dimension v2 oracle `dimensions`. Fully determined by the published
tables below; publishing it leaks nothing beyond dev (same argument as
`fixtures/v2/MAPPING.md`). The candidate under test is the production module
`packages/core/src/admission-feature-producer.ts`
(`memberry.safe-facts-feature-producer@1.0.0`), not a lab copy.

Inputs are exactly five safe facts: `memoryClass`, `outcome`, `sensitivity`,
`hasSignals`, `hasEntities`. Nothing else is read (`hasModel` is generation
provenance, not corroborating structure, and is excluded). All outputs are
integers on the closed 0..1000 permille grid.

## sensitivity — same detection authority as routing rule 3

The MEM-001 preprocessor is the single sensitivity authority; the producer
emits a permille mapping of that SAME fact. A two-state detector supports no
intermediate confidence, so only the grid extremes are honest.

| `facts.sensitivity` | sensitivity (permille) |
|---|---|
| `not-detected` | 0 |
| `detected` | 1000 |
| availability | always `available` |

## durability — memory class base, retracted-outcome discount

| memoryClass | base (permille) |
|---|---|
| `decision` | 900 |
| `architecture` | 850 |
| `convention` | 800 |
| `pattern` | 750 |
| `preference` | 650 |
| `fact` | 600 |
| `general` | 250 |
| `unclassified` | `unavailable` (no memoryType was supplied; claiming a durability for an unclassified write would be invented signal) |

**Adjustment D1 (retracted-outcome discount):** if durability is available and
`outcome ∈ {rejected, abandoned}`, then `durability = max(0, base − 400)`.
Floor-at-zero, applied after base lookup, availability never changed by an
adjustment. `approved`, `revised`, and `unspecified` apply no adjustment.

## evidenceQuality — corroboration structure count

The content-safe corroboration structure is the pair of structural markers
`hasSignals` and `hasEntities`. The value ladder deliberately reuses the
qualified lab `evidenceSupport` ladder (none 0 / single 450 / corroborated
1000), keeping lineage with the instrument that passed the v2 holdout.

| count of `true` in {hasSignals, hasEntities} | evidenceQuality (permille) |
|---|---|
| 0 | 0 |
| 1 | 450 |
| 2 | 1000 |
| availability | always `available` (the booleans are always present) |

## Fixture completion

The lab completes `facts` to a full `AdmissionSafeFactsV1` through
`parseAdmissionSafeFactsV1` with fixed neutral values — none consumed by the
producer: `contractVersion '1.0.0'`, `captureState 'accepted-nonduplicate'`,
`tenantScope 'resolved'`, `projectScope 'resolved'`,
`redactionConfigured true`, `hasModel false`.

## Change discipline

These tables are frozen for the MEM-002 productionization packet. Any future
change to the mapping is an extractor-version bump AND triggers a
`TIER_ROUTING_POLICY_VERSION` review before deploy.
