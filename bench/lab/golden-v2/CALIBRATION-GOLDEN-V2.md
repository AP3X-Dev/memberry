# Golden v2 — calibration and pilot record

Append-only. Entries are recorded in the order attempted, before the next attempt
begins. Deleting, reordering, editing, or overwriting a prior record is prohibited,
including entries rejected for being too easy.

No frozen instrument version exists. No dataset byte has been generated. No
candidate arm, candidate adapter, candidate registration, or candidate result
exists anywhere in the tree.

---

## Feasibility pilot (spec §2.5) — attempt 1

```
goldenv2-pilot-rework-record
  attempt:            1                       (of the 2-shape cap)
  recordedAt:         2026-08-26
  shapeId:            facet-decomposition-v1
  parentShapeId:      none
  changedFrom:        none - this is the original design of spec §3.2/§3.3
  changeRationale:    Original shape. Facet decomposition was chosen so the answer
                      to each query is genuinely plural: every relevant memory
                      names the subject S, asserts the queried relation, and
                      carries exactly one facet drawn without replacement. That is
                      what makes relevantPerQuery >= 5 honest and the structural
                      Precision@5 ceiling exactly 1.0, which is the defect in
                      golden v1 this instrument exists to remove.
  gridVectors:        72
  interior:           0
  outcome:            infeasible
  rejectReason:       control-precision-band-rejected (below band) and
                      control-stratum-not-mixed (zero clear successes in every
                      stratum of every vector)
  candidateState:     absent   (asserted: no golden-v2 registration in
                      systems.json or experiments.json, MEMBERRY_LAB_CANDIDATE
                      unset, no bench/lab/datasets/golden-v2 path)
```

### Grid summary, verbatim

```
GOLDENV2PILOT preflight ok: no golden-v2 registration, no candidate env flag, no golden-v2 dataset path
GOLDENV2PILOT vectors=72 interior=0
GOLDENV2PILOT verdict=infeasible
```

Executed in a `node:20` container on cerebro against the registered control
`memberry-retrieval-core-v1`, unchanged, through `bench/lab/runner.ts`, unchanged.
72 knob vectors x 18 scenarios = 1,296 control runs. Grid exit 0.

### What the grid shows

| Band term | Required | Best observed | Verdict |
|---|---|---|---|
| Structural ceiling P@5 | exactly `1.0` | `1.0000` on **all 72** vectors | **PASS** |
| Saturated queries | `<= 1` (pilot: `== 0`) | `0` on **all 72** vectors | **PASS** |
| Precision@5 | `[0.42, 0.58]` (interior `[0.46, 0.54]`) | `0.3111` | **FAIL — below** |
| Recall@10 | `[0.45, 0.80]` (interior `[0.52, 0.72]`) | `0.4444` | **FAIL — below** |
| Clear successes per stratum | `>= 3` of 14 (pilot: `>= 2` of 6) | **`0`**, in every stratum of every vector | **FAIL** |

**The instrument fails from the TOO-HARD side.** This is the exact mirror of the
golden v1 defect that motivated the design, and the same failure mode as the
LAB-013 rejection (dev control 5/20, holdout 3/20, zero successes in the holdout
low and medium strata).

The two structural terms both PASS, and they are the terms the redesign was for:
facet decomposition delivers a `1.0` ceiling exactly as intended, and saturation is
not merely under the cap but identically zero. The design solved the problem it set
out to solve. It failed on difficulty calibration instead.

### Knob response, measured (not assumed)

| `corpusSizePerScenario` | mean P@5 | max P@5 |
|---|---|---|
| 30 (**pre-registered minimum**) | 0.2759 | 0.3111 |
| 36 | 0.2377 | 0.2889 |
| 42 | 0.1951 | 0.2667 |
| 48 (pre-registered maximum) | 0.1661 | 0.2000 |

| `relevantFacetTokenOverlap` | mean P@5 | mean R@10 |
|---|---|---|
| 0 | 0.1958 | 0.2840 |
| 1 | 0.2162 | 0.3006 |
| 2 (**pre-registered maximum**) | 0.2440 | 0.3179 |

Both knobs respond monotonically and in the directions spec §3.5 predicted. The
best vector in the grid therefore sits at the **most favourable corner of the
pre-registered envelope** — `corpusSizePerScenario` at its minimum and
`relevantFacetTokenOverlap` at its maximum — and still lands `0.3111` against a
band floor of `0.42`.

`relevantFacetTokenOverlap` bought `+0.048` P@5 across its entire range, about
`+0.024` per step. Closing the remaining `~0.11` to the band floor would need
roughly seven more steps of a knob whose pre-registered bound is `2`. **The band is
not reachable by knob tuning inside the pre-registered bounds**, and widening those
bounds to reach it is precisely the manipulation §2.4 item 6 and §3.5 forbid.

### The structural reading

This is not a near miss to be tuned away; it is a property of the shape. Under
facet decomposition every relevant memory is lexically interchangeable and
individually weak: each names `S` once and asserts one facet, so no relevant
document can rank strongly on its own merits. Meanwhile every
`sameSubjectOffRelation` near-miss also names `S` exactly. The ranker is therefore
asked to separate 5-8 uniformly weak relevant documents from subject-matched
near-misses on relation phrasing alone, and nothing in the design lets any relevant
document concentrate probability mass in the top 5.

Spec §16 item 4 already anticipated the mechanism from the other direction, noting
that facet decomposition "exercises MMR diversity penalties only weakly, because
relevant facets are lexically diverse by construction". That same lexical diversity
is what prevents the relevant set from concentrating in the top 5. The observation
would have been true before the grid ran; the grid measured its size.

### Disposition

**STOP. The build has not started. Version slot 1 has NOT been opened.** No dataset
byte was generated, no registry entry was written, no freeze was computed, and
nothing from the pilot worktree is committed.

Per spec §2.5.6 the permitted responses are exactly two: rework the corpus shape
once as attempt 2 under the two-shape cap, or tombstone the design and escalate to
the owner with the grid attached. **The band was not adjusted and will not be.**
Escalated to the owner with the grid.

**Owner decision (2026-08-26): proceed with the rework as attempt 2**, on the
explicit condition that the new shape answers the structural question "what lets a
relevant document rank strongly?" — a reworked shape without that answer would
spend the last slot to land in the same place.

---

## Feasibility pilot (spec §2.5) — attempt 2

Recorded BEFORE the attempt begins, per §2.5.6 Rule 1.

```
goldenv2-pilot-rework-record
  attempt:            2                       (of the 2-shape cap — THE LAST ONE)
  recordedAt:         2026-08-26
  shapeId:            primary-plus-supporting-v1
  parentShapeId:      facet-decomposition-v1
  changedFrom:        The relevant set stops being a flat set of interchangeable
                      peers. It becomes ONE primary relevant document that names
                      the subject, asserts the queried relation, and carries the
                      relation phrasing at full lexical weight while enumerating
                      the facet TYPE, plus (relevantPerQuery - 1) supporting
                      documents that each carry exactly one facet as before. This
                      deliberately retires generator invariant R5 (no single
                      memory carries two facet names) for the primary document
                      only; R5 continues to hold across the supporting set.
  changeRationale:    Facet decomposition cannot vary top-5 composition
                      independently of recall, because every relevant document is
                      lexically interchangeable. Each names the subject exactly
                      once and asserts exactly one facet, so no relevant document
                      can rank strongly on its own merits, while every
                      sameSubjectOffRelation near-miss also names the subject
                      exactly. The ranker is asked to separate uniformly weak
                      relevant documents from subject-matched near-misses on
                      relation phrasing alone, and the shape provides no mechanism
                      by which any relevant document can concentrate probability
                      mass in the top 5. Introducing one document that carries
                      both the subject and the full relation phrasing gives the
                      ranker something findable at rank 1 and makes top-5
                      composition a property the knobs can move, which is the
                      degree of freedom the flat shape structurally lacks.
  gridVectors:        <pending>
  gridSummary:        <pending>
  interior:           <pending>
  outcome:            <pending>
  rejectReason:       <pending>
  candidateState:     absent   (re-asserted at run time by the same preflight)
```

**Invariants that do NOT move.** `relevantPerQuery >= 5` still holds for every
query, so the structural Precision@5 ceiling stays exactly `1.0` — that floor is
the reason this instrument exists and is not negotiable. The band is untouched.
The strata definitions, split sizes, `k`, the Precision@5 cutoff, `tokenBudget`,
and the control adapter are untouched. Only the composition of the relevant set
changes.

**The risk this rework carries, stated before the numbers are seen.** Attempt 1
failed from the too-hard side. A primary document engineered to rank strongly is a
correction toward easier, and an over-correction lands on the too-easy side — the
golden v1 failure this whole instrument was built to escape. The saturation counter
(`saturatedQueries == 0` in the pilot's interior test) is the term that will catch
that, and it is the term to watch: attempt 1 scored `0` on it with room to spare,
so any movement there is the signal that the correction has gone too far.

**After attempt 2, escalation to the owner is MANDATORY regardless of outcome**,
including on a pass, before step 1 of the build. A shape that only became feasible
on the second try is exactly the case a human should see before eight days and two
version slots are committed to it.
