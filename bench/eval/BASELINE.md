# EVAL-001 — origin baseline

**Status: TEMPLATE. No run has happened. Every number below is the literal token `TBD`.**

A `TBD` in this file is a placeholder for a measurement that does not exist yet. It is not
zero, it is not "roughly zero", and it must never be quoted, averaged, compared against, or
carried into a report. Filling one in is the act of taking the origin baseline, and that
happens exactly once.

Governed by spec
[`docs/agent-runs/specs/2026-08-26-eval001-real-query-evaluation.md`](../../docs/agent-runs/specs/2026-08-26-eval001-real-query-evaluation.md)
§6.1 and its amendments A2, A8, A9, and by [`SELECTION-RULE.md`](SELECTION-RULE.md) §5.1,
§9, §10 and amendment A1.

---

## 1. The rule this file exists to enforce

**Section 2 is written once and is NEVER overwritten.** Later runs APPEND to section 7.
They do not edit section 2, do not "refresh" it, and do not re-derive it from the most
recent run.

The failure this prevents is boiling-frog drift. "No band" (spec §1) means no headroom
qualification; it does **not** mean no absolute anchor, and conflating the two reintroduces
the failure by another route. A chain of accepted "did not regress" steps, each measured
only against the one immediately before it, IS a moving threshold — just an unrecorded one.
Ten steps of −0.4% each is a 4% decline that no single comparison ever flags.

Golden v1 avoids this with a fixed floor (`precisionAt5: 0.39`) that is never re-derived
from the latest run. This file is the analogous mechanism for EVAL-001.

---

## 2. ORIGIN BASELINE RECORD — write once, never overwrite

### 2.0 Run identity

| field | value |
|---|---|
| date/time of run (ISO 8601, with zone) | 2026-08-27, America/Los_Angeles |
| who ran it | autonomous-memberry-10x session, EVAL-001 lane |
| host the runner executed from | Windows workstation (the runner is a network MCP client; the SERVER is cerebro) |
| MCP endpoint (`--base`) | `http://192.168.0.25:3101` |

### 2.1 Code identity — two SHAs, because they differ

Two commits must be recorded, and the relationship between them stated, or the baseline is
not reproducible.

| field | value |
|---|---|
| repo `master` at time of writing | `a1439fb` |
| commit DEPLOYED on the box | `3eba9a9` |
| deployed code == master code? | **yes** |

**Why both.** The box runs `3eba9a9`; repo master is `a1439fb`. These are different commits,
and recording only one would misstate what was measured. But
`git diff --stat 3eba9a9..a1439fb -- packages/ src/` is **EMPTY** — the delta between them
is docs-only — so **the deployed code is identical to the master code**, and a result taken
against the box is a result against master's code. That fact is what makes the two SHAs
reconcilable; without it, a future reader has to re-derive it or distrust the run.

Confirm at run time and record the confirmation:

| check | value |
|---|---|
| `git diff --stat 3eba9a9..a1439fb -- packages/ src/` still empty at run time | TBD |
| repo SHA actually used, if it moved | TBD |
| deployed SHA actually used, if it moved | TBD |

### 2.2 Flag state — the complete set, including what is not in the repo

A change to any of these voids cross-run comparison (SELECTION-RULE §9 item 2) and requires
a fresh baseline.

| flag | value at origin |
|---|---|
| `MEMBERRY_QUERY_PLANNER_V1` | `1` |
| `MEMBERRY_CANDIDATE_CHANNEL_V1` | `1` |
| `MEMBERRY_RERANKER_V1` | `served` |
| `MEMBERRY_ADMISSION_ROUTING_V1` | `shadow` |
| `MEMBERRY_ADMISSION_FEATURE_PRODUCER_V1` | `live` |
| `MEMBERRY_LIFECYCLE_*` (all three) | `live` |

> **REPRODUCIBILITY HAZARD — read this before trying to reproduce the baseline.**
>
> **The three `MEMBERRY_LIFECYCLE_*=live` lines exist ONLY as an UNCOMMITTED modification to
> the box's `docker-compose.yml`. They are NOT in the repo's copy of that file.**
>
> A clean checkout of `a1439fb` brought up with the repo's compose file does not have them
> and will not reproduce this baseline. Anyone reconstructing the environment must add them
> by hand. Without this note the baseline is not reproducible, which is why it is stated
> here rather than left to be rediscovered.

Record the in-container verification at run time, so the flags are evidence rather than
recollection:

| field | value |
|---|---|
| command used to read the flags in-container | TBD |
| verbatim output | TBD |
| the three `LIFECYCLE` lines still uncommitted at run time? | TBD |

### 2.3 Index state at the moment of the run

Spec §8 item 4: EVAL-001 measures the current index, so cross-index comparison is
conditional on recorded index state. Spec amendment A8: these counts must be captured **at
the same moment as the first run**, not afterwards.

**Reference measurement, taken 2026-08-27 during the Phase 0 grounding pass.** This is
pre-run context, not the baseline capture:

| `project_tag` | Symbol count |
|---|---|
| `project:memberry` | 16,399 |
| `project:hermes-agent` | 15,055 |
| `project:neuri` | 12,339 |
| `project:ag3ntic` | 5,385 |
| NULL | 5,136 |

`project:memberry` kind histogram:

| kind | count |
|---|---|
| `variable` | 11,847 |
| `function` | 2,589 |
| `method` | 880 |
| `interface` | 654 |
| `type` | 254 |
| `class` | 155 |
| `module` | 20 |

Derived shape of `project:memberry`:

| property | value |
|---|---|
| test-file symbols | 8,344 (**50.9%**) |
| bare-variable (kind `variable`, empty `doc_comment`) | 10,996 (**67.1%**) |

**`project:memberry` is 16,399 symbols, NOT the roadmap's 8,928** (+83.7%). Any document
still quoting 8,928 — or 34% test-file, or 74% variable — is stale and must not be used to
interpret a baseline number. The `noiseRate` motivation in spec §2.2 was written against
those stale figures.

**Captured at the moment of the origin run.** Re-measure; do not copy the reference table
above into these cells:

| field | value |
|---|---|
| per-`project_tag` Symbol counts at run time | TBD |
| `project:memberry` kind histogram at run time | TBD |
| test-file share at run time | TBD |
| bare-variable share at run time | TBD |
| query used to produce these counts | TBD |
| any re-index between 2026-08-27 and the run? | TBD |

### 2.4 Question set state

| field | value |
|---|---|
| question file | `bench/eval/eval001-questions.jsonl` |
| selection rule in force | `SELECTION-RULE.md` at `a1439fb`, incl. amendments A1 and A2 |
| total questions SELECTED | 34 (extended from 20 per SELECTION-RULE amendment A4) |
| total questions SURVIVING blind authoring | **9 of 34** — 25 could not be grounded outside MemBerry. See §4. |
| `dev` split | 21 selected — **4 surviving** (2 mixed, 2 memory) |
| `holdout` split | 13 selected — **5 surviving** (2 code, 3 memory) |
| SHA-256 of the question file at run time | TBD |
| questions carrying no `entity_scope` | 27 of 34 — see `SELECTION-LOG.md`, OPEN ISSUE. Mitigated: the runner replays each query through the tool that ACTUALLY issued it, so the planner requirement only binds the 3 `berry_context` questions. |

### 2.5 How the run was invoked

```
node bench/eval/run-eval001.mjs --split dev     --out bench/eval/last-run.json
node bench/eval/run-eval001.mjs --split holdout --out bench/eval/last-run-holdout.json
```

| field | value |
|---|---|
| exact command lines used | TBD |
| runner file SHA-256 at run time | TBD |
| node version | TBD |
| `EVAL001 session codeDomainEnabled=… codeToolsVisible=…` line | TBD |
| `--smoke` transport check passed before the scored run? | TBD |

Opening the `holdout` split at origin is an open, and **must be recorded in
[`HOLDOUT-OPENS.md`](HOLDOUT-OPENS.md)** like any other, with `change tested = origin
baseline`.

### 2.6 THE ORIGIN NUMBERS

Metric definitions in force, per spec §2.1 and amendment A2:

- **`keywordRecall@k`** — primary. Mean over questions of
  `|{kw in K(q) present in top-k}| / |K(q)|`, at `k = 5` and `k = 10`.
- **`testFileRate@k`** — secondary. Share of top-`k` items whose path contains `__tests__`
  or `.test.`.
- **kind histogram** — **descriptive and UNSCORED.** Context for reading the other two. It
  is not a metric, and no change may be justified by moving it.
- **`noiseRate` is RETIRED and NOT IMPLEMENTED.** Spec §2.2's bare-variable clause was
  measured unsound (amendment A2): `doc_comment` is a *preceding* comment rather than a
  docstring, and the six `session: () => session` items that motivated the whole metric
  classify as kind `method`, so they would have scored **clean** under it. The name is
  retired rather than redefined, so that no one ever compares numbers across two meanings.
  If a `noiseRate` appears in a later run's row, that row is wrong.

Two excluded-from-scoring counters travel with every result and are part of the record, not
footnotes. A run with a nonzero `nonRetrieval` is a partially-measured run:

- **`nonRetrieval`** — planner rejections and silent-zero modes, NEVER scored as zero.
- **`grammarMisses`** — render lines the pinned grammar failed to parse. Nonzero means
  `testFileRate` for that run is known-invalid, not merely noisy.

**`dev` split (n = 4 authored, 3 scored):**

| metric | origin value |
|---|---|
| `keywordRecall@5` | **0.0833** |
| `keywordRecall@10` | **0.0833** |
| `testFileRate@5` | **0.1333** |
| `testFileRate@10` | **0.2000** |
| `nonRetrieval` (count, of 4 dev questions) | **1** — `eval001-d-08`, `runtime_query_planner:invalid_request` (no `entity_scope` in the original call). Excluded from scoring, never counted as zero. **n scored = 3.** |
| `grammarMisses` (count) | **0** |
| kind histogram over top-10 (descriptive) | see `bench/eval/last-run.json` |

**`holdout` split (n = 5) — AGGREGATE ONLY. No per-question row is ever recorded here.**

| metric | origin value |
|---|---|
| `keywordRecall@5` | **0.1000** |
| `keywordRecall@10` | **0.3000** |
| `testFileRate@5` | **0.0000** |
| `testFileRate@10` | **0.0000** |
| `nonRetrieval` (count, of 5 holdout questions) | **0** |
| `grammarMisses` (count) | **0** |
| kind histogram over top-10 (descriptive) | not recorded — aggregate-only split |

Verbatim `EVAL001 …` output lines, both splits, pasted unedited:

```
EVAL001 session codeDomainEnabled=true codeToolsVisible=7
EVAL001 split=dev n=3 keywordRecall5=0.0833 keywordRecall10=0.0833
EVAL001 split=dev testFileRate5=0.1333 testFileRate10=0.2000
EVAL001 split=dev grammarMisses=0 nonRetrieval=1 flags=QUERY_PLANNER_V1,CANDIDATE_CHANNEL_V1,RERANKER_V1
EVAL001 NON-RETRIEVAL question=eval001-d-08 tool=berry_context classified=true error=runtime_query_planner:invalid_request
EVAL001 split=dev question=eval001-d-07 keywordRecall5=0.2500 testFileRate5=0.4000 missing=UnifiedAssembler|AssemblerCodeLayer|CodeSearch
EVAL001 split=dev question=eval001-d-11 keywordRecall5=0.0000 testFileRate5=0.0000 missing=evidence-authority-ledger.ts|linkSignal|CONTRADICTS|EvidenceAuthorityCoverage
EVAL001 split=dev question=eval001-d-25 keywordRecall5=0.0000 testFileRate5=0.0000 missing=hibernated|computerStatus.ts

EVAL001 session codeDomainEnabled=true codeToolsVisible=7
EVAL001 split=holdout n=5 keywordRecall5=0.1000 keywordRecall10=0.3000
EVAL001 split=holdout testFileRate5=0.0000 testFileRate10=0.0000
EVAL001 split=holdout grammarMisses=0 nonRetrieval=0 flags=QUERY_PLANNER_V1,CANDIDATE_CHANNEL_V1,RERANKER_V1
```

**Per-question `dev` detail is permitted and belongs in the run artifact
(`bench/eval/last-run.json`), not in this file** — this file records split-level aggregates.
Per-question `holdout` detail is not permitted anywhere, per spec §3.2.1 and §5.

---

## 3. How every later comparison is reported

**Two numbers, always. Never one.** Every comparison reports drift against BOTH:

1. **the immediately-prior accepted state** — the previous accepted row in section 7, and
2. **the origin baseline** — section 2.6, which never moves.

A row reporting only one of the two is incomplete, and the change it supports is not
accepted. This is the mechanism, not the aspiration: a "did not regress" measured only
against the prior step cannot detect accumulated decline, because each individual step is
genuinely within noise.

Per split, per metric, the row carries:

```
keywordRecall@5   this=TBD   Δ vs prior=TBD   Δ vs ORIGIN=TBD
testFileRate@5    this=TBD   Δ vs prior=TBD   Δ vs ORIGIN=TBD
```

### 3.1 The monotonic-decline flag

**A monotonic decline across three or more consecutive accepted runs is FLAGGED, even when
no single step regressed.** That is the boiling-frog case, and it is the specific thing this
file exists to catch.

Flagging means the run is recorded with a `FLAG: monotonic decline over N runs` line in
section 7, and the next change touching that metric must either address the drift or justify
it in writing. A flag is a recorded event, not a veto — but clearing it silently is not
available.

Evaluate the flag per metric, per split, over the accepted rows only.

### 3.2 What voids comparison entirely

From SELECTION-RULE §9. Each of these makes results uncomparable and requires a **fresh
baseline**, not a delta:

1. A re-index, which changes the corpus underneath (spec §8 item 4).
2. A change to any flag in §2.2.
3. Re-selecting the question set by any rule other than `SELECTION-RULE.md`.
4. Discovery that the mined population is not what §3 of that rule claims — for example,
   transcript coverage turning out to be partial in a way that correlates with query
   difficulty.

Also voiding, from the metric side: a nonzero `grammarMisses`, which means the render
diverged from the pinned grammar and `testFileRate` is known-invalid for that run.

---

## 4. What these numbers do NOT describe — declared bias

These caveats travel with every EVAL-001 number. A report quoting a metric from this file
without them is overclaiming.

**Deliberate code-plane over-sampling (SELECTION-RULE §5.1).** By raw frequency the mined
population is 87% memory-plane; a proportional sample would have yielded roughly two code
questions. Because the primary diagnosed defect is a code-plane defect, the rule takes
**every** surviving code-plane and mixed query and then fills to target from memory. This is
a bias, chosen on an *a priori* ground — where the known defect lives — and not on any
measured outcome. **`keywordRecall` on this set does not describe MemBerry's average
traffic, and no report may claim that it does.**

**Single-client transcript source (SELECTION-RULE §10).** The population is Claude Code on
one Windows workstation. Codex, Neuri, and Hermes agents also query MemBerry; their logs live
elsewhere and were not mined. The set over-represents one client's phrasing and one client's
tool-selection habits. Mining a second client's logs is the obvious fix and was out of scope
for this pass.

**Foreign-client scopes excluded (SELECTION-RULE amendment A1, ground E5).** 89 memory-plane
queries scoped to non-MemBerry projects were excluded, because this repo is public and the
question file is tracked — and redaction was rejected on the ground that the client name *is*
the retrieval signal, so a redacted query is no longer the real query. E5 removed **zero**
code-plane and **zero** mixed-plane queries. The consequence is that this set measures
retrieval on *MemBerry-and-siblings development traffic*, not the workstation's whole query
load.

**Small n (spec §8 item 1).** The surviving set is sized for signal on obvious defects, not
statistical power. A small delta is not detectable and must not be claimed as one.

**Keyword presence is a proxy for usefulness (spec §8 item 2).** A response can contain every
required keyword and still be badly ordered or padded. `testFileRate` partly covers this;
nothing fully does.

**Author bias (spec §8 item 3).** Whoever authored the keywords decided what "good" means.
Blind authoring (SELECTION-RULE §7) constrains this; it does not remove it.

**A retrieval claim only (spec §2.4).** No answer quality, task completion, latency, or cost
is measured. A `keywordRecall` gain is a retrieval claim and must not be reported as anything
else.

---

## 5. Re-pinning the origin — the ONLY permitted procedure

The origin baseline is re-pinned **only on a deliberate re-index**, because a re-index
changes the corpus underneath (spec §8 item 4). Nothing else re-pins it — not a run that
looks anomalous, not a metric that has drifted, not a change of opinion about the question
set, and never as a way to clear a monotonic-decline flag.

When a deliberate re-index happens:

1. **Retain the prior origin. It is never deleted.** Move section 2 verbatim into section 6
   under a heading `Superseded origin N — <date>`. Not edited, not summarised, not trimmed.
2. Record the **reason** for the re-index — what was re-indexed and why — in that heading.
3. Write a **new** section 2 with new SHAs, new flag state, new index state, and a new run.
   The new origin is a fresh capture, not an adjustment of the old one.
4. Note in section 7 the exact row after which comparison switches to the new origin.
   **Deltas do not cross an origin boundary:** a run under origin N+1 is never compared to
   origin N's numbers.
5. Every re-pinning is itself an entry in section 6, so the count of re-pinnings is visible.
   Frequent re-pinning is a smell, and the record makes it one.

---

## 6. Superseded origins — retained forever

None. The origin in section 2 is the first, and it has not been taken yet.

---

## 7. Run log — APPEND ONLY

Later runs append rows here. **They do not touch section 2.** Rows are never edited,
reordered, or deleted; a mistaken row is corrected by appending a correction row that
references it.

Each row carries date, git SHA, split, the change being tested, the aggregate metrics, the
Δ vs prior accepted **and** the Δ vs origin for each, the `nonRetrieval` and `grammarMisses`
counts, the flag state if it differs from §2.2, and the accept/reject verdict.

| date | SHA | split | change tested | kwRecall@5 (Δprior / Δorigin) | kwRecall@10 (Δprior / Δorigin) | testFileRate@5 (Δprior / Δorigin) | testFileRate@10 (Δprior / Δorigin) | nonRetrieval | grammarMisses | verdict |
|---|---|---|---|---|---|---|---|---|---|---|

*No runs yet. The first row is the origin baseline itself, added when section 2.6 is filled.*
