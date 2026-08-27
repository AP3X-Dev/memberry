# EVAL-001 — question selection rule

**Pre-registered 2026-08-27, against repo master `a1439fb`.**

This file is written **before any query has been executed and before any retrieval result
has been seen.** That ordering is the entire point of it. A selection rule authored after
looking at outcomes is not a rule, it is a rationalisation of a choice already made.

Append-only. Amendments are added at the bottom with a date and a reason; nothing above is
edited or deleted.

---

## 1. What changed from the spec, and why

EVAL-001's spec (`docs/agent-runs/specs/2026-08-26-eval001-real-query-evaluation.md`)
§3.1 states:

> **MemBerry does not log queries.** `retrieval-observer.ts` is explicitly "an
> instrumentation seam, not a public trace or persistence format", in-process only, and
> there is no query node label in the graph. So the set cannot be mined from history; it
> must be authored from real usage.

The first sentence is true. **The conclusion is false.** MemBerry does not log queries, but
its *clients* do. Agent transcripts on this machine contain the real `berry_*` tool calls
with their exact arguments.

The spec also assumed the wrong user. §3.1 ranks "questions the owner has actually asked"
as source #2, but the owner does not query MemBerry directly — **the connected agents do.**
Owner recall is therefore a near-empty source, and the real query population was sitting in
client transcripts the whole time.

Measured 2026-08-27 across 1,222 local Claude Code transcripts:

| tool | calls | plane |
|---|---|---|
| `berry_load` | 104 | memory |
| `berry_grep` | 25 | memory |
| `berry_context` | 13 | mixed |
| `berry_code_search` | 6 | code |
| **total population** | **148** | |
| `berry_query` | 20 | *excluded — Cypher, not retrieval* |

This is strictly better evidence than either owner recall or anything an agent could
author, because none of it was written for a test.

## 2. The risk this rule exists to control

The spec's anti-gaming rule guarded against **invented** questions. Mining removes that
risk and replaces it with a different one:

> **Cherry-picking.** Run all 148, see which fail, keep the ugly ones, call it a benchmark.

That is the same selection inflation in a different coat, and it would be undetectable
after the fact. So selection is fixed here, in advance, in mechanical terms that leave no
discretion at the moment of choosing.

### 2.1 Disclosure — what the author had already seen

Honesty about the author's own blindness, since this rule is only as good as that:

- **Seen:** roughly 60 of the 148 mined `input` payloads, as raw text, while establishing
  that the population exists at all. Task strings and scope tags only.
- **Not seen, by anyone, at time of writing:** any retrieval *result*. Zero queries have
  been executed. There is no outcome data in existence to select on.

The exposure is to the *questions*, not to their *answers*, and selection inflation is a
function of the latter. Recorded rather than glossed.

## 3. Population

Every `tool_use` entry in `~/.claude/projects/**/*.jsonl` whose name is one of:

    mcp__memberry__berry_load
    mcp__memberry__berry_grep
    mcp__memberry__berry_context
    mcp__memberry__berry_code_search

Mining cutoff: **2026-08-27**. Everything at or before the cutoff is in the population.

Excluded by kind, because they are not retrieval:

| tool | why excluded |
|---|---|
| `berry_query` | raw Cypher against the graph; bypasses retrieval entirely |
| `berry_store`, `berry_memory_insert` | writes |
| `berry_consolidate`, `berry_ingest_codebase`, `berry_code_index` | lifecycle / indexing |
| `berry_tools`, `berry_graph_report` | administrative |

## 4. Mechanical exclusions — the complete list

No exclusion may be added after mining begins without an amendment entry below, dated, with
a reason. These are the only permitted grounds:

- **E1 — duplicate.** Identical normalised query text (lowercased, whitespace-collapsed).
  Keep the **earliest** by timestamp. Record how many were folded.
- **E2 — unanswerable by construction.** Scope names a project with zero indexed symbols
  *and* zero memories. Nothing could be retrieved, so a zero would measure coverage, not
  ranking. Requires the live counts from Phase 0 to evaluate; recorded per query.
- **E3 — malformed.** Truncated or unparseable `input` payload.
- **E4 — degenerate.** Empty query/task string, or a single stopword.

**Not permitted grounds, ever:** the query looks hard, the query looks easy, the query
returned a bad result, the query returned a good result, the answer is hard to verify, the
question is embarrassing.

Every exclusion is logged with its ground and its query id. Total mined, total excluded per
ground, and total surviving are all reported. A silent drop is a falsified result.

## 5. Stratification

Strata are `plane × project`:

| plane | tools | metric coverage |
|---|---|---|
| memory | `berry_load`, `berry_grep` | `keywordRecall` only |
| code | `berry_code_search` | `keywordRecall` + `noiseRate` |
| mixed | `berry_context` | both, code items only for `noiseRate` |

### 5.1 Deliberate code-plane over-sampling — declared, not hidden

By raw frequency the population is 87% memory-plane. Sampling proportionally would put
roughly two code questions in the set.

**The primary diagnosed defect is a code-plane defect** — 74% of indexed `project:memberry`
symbols are `variable`, 34% come from test files, and `noiseRate` is the metric built to
catch exactly that. A proportional sample would leave the metric that matters most with
almost no questions behind it.

So: **take every code-plane and mixed query that survives §4**, then fill to target with
memory-plane queries.

This is a bias. It is chosen on an *a priori* ground — where the known defect lives — not
because of any measured outcome, and it is stated here so that it is a visible choice
rather than an accident. It means `keywordRecall` on this set does **not** describe
MemBerry's average traffic, and no report may claim that it does.

### 5.2 Fill order

Target: **15–25 questions**, per spec §3.2.

1. All surviving code-plane and mixed queries (expected ~12–19 before dedup).
2. If the total is under 15, fill from memory-plane queries: round-robin across projects by
   descending population, taking **earliest by timestamp** within each project.
3. If step 1 alone exceeds 25, truncate by taking **earliest by timestamp** within each
   stratum. Never by inspection.

Timestamp order is the tiebreak everywhere because it is unrelated to difficulty and cannot
be steered after the fact.

## 6. Split assignment — deterministic, no discretion

Within each stratum, order by timestamp ascending, then assign by cycling position:

    positions 1, 2, 3 -> dev
    positions 4, 5    -> holdout
    (repeat)

Exactly 60/40, reproducible from the mined file alone, and no human or agent chooses which
question goes where. Re-running the assignment on the same mined file must reproduce the
same splits byte for byte; a test asserts this.

## 7. Keyword authoring must be BLIND

The strongest control in this document, and the one most easily lost:

> **Required keywords are authored WITHOUT running the query.**

An author who has seen the response will write keywords that match it. That converts the
benchmark into a description of current behaviour and it would score near 1.0 on day one
while measuring nothing.

The order is fixed:

1. Select questions (§4–§6).
2. Author `requiredKeywords` for each, derived **only** from repo files and stored memories,
   with a `sourceOfTruth` naming the exact `file:line` or memory id that was opened.
3. Second reviewer independently re-derives **at least one** keyword per question from the
   cited source, per spec §4.1, without running the query either.
4. **Only then** execute anything.

If a question's ground truth cannot be established from a file or a memory without running
the query, the question is **dropped**, not guessed. Dropped-for-unverifiable is logged with
the query id and counted in the report.

## 8. Growth and retirement

Per spec §3.3, unchanged and restated because it now binds against a mined population:

- The set grows from **real failure cases**, appended with their keywords and provenance.
- A question is **never** removed to raise a score.
- Retiring one requires a recorded reason. The record is append-only.
- New mining runs extend the population; they never re-select the existing set.

## 9. What voids this rule

Any of these makes results under it uncomparable, and each requires a fresh baseline:

1. A re-index, which changes the corpus underneath (spec §8 item 4).
2. A change to `MEMBERRY_CANDIDATE_CHANNEL_V1` or the other flags recorded with the run
   (spec §5.1).
3. Re-selecting the question set by any rule other than the one above.
4. Discovery that the mined population is not what §3 claims — for example, if transcript
   coverage turns out to be partial in a way that correlates with query difficulty.

## 10. Known bias in the population itself

These transcripts are **Claude Code on one Windows workstation.** Codex, Neuri, and Hermes
agents also query MemBerry, and their logs are elsewhere and not mined here. The population
over-represents one client's phrasing and one client's tool-selection habits.

This is recorded in `BASELINE.md` alongside the numbers, and it is a real limitation on what
any EVAL-001 result generalises to. Mining a second client's logs is the obvious fix and is
not in scope for this pass.

---

## Amendments

### A1 — 2026-08-27 — exclusion ground E5, third-party data governance

**Added:** a fifth mechanical exclusion.

> **E5 — foreign-client scope.** A query whose `project:` scope names a project other than
> MemBerry's own (`project:memberry`, `project:neuri`, `project:hermes-agent`,
> `project:ag3nt`/`ag3ntic`) is excluded. Unscoped queries are retained.

**Reason.** `AP3X-Dev/memberry` is a **public** GitHub repository, and per spec §4 the
question set is a *tracked* file. The mined population carries verbatim agent task strings
from every project on this workstation, including **third-party client names and their
business context** from consulting work.

Those names are deliberately **not enumerated in this file** — writing them here to explain
why they must not be published would publish them. They live in `bench/eval/.foreign-terms`,
which is gitignored (see A5).

Redaction was rejected as an alternative: the client name *is* the retrieval signal, so a
redacted query is no longer the real query and would silently change what is being measured.

**This is a non-outcome ground.** It is admissible under §4 because it turns on where the
data may be published, not on how any query scored. No query has been executed.

**Measured cost, so the trade is visible rather than asserted:**

| | code | mixed | memory | total |
|---|---|---|---|---|
| pool after E1 dedup | 5 | 3 | 129 | 137 |
| retained under E5 | 5 | 3 | 40 | **48** |
| excluded by E5 | **0** | **0** | 89 | 89 |

E5 removes **zero** code-plane and **zero** mixed-plane queries — every one of them was
already scoped to MemBerry's own projects — and leaves 40 memory-plane candidates against a
fill requirement of roughly 12. The §5.1 code-plane over-sampling is therefore unaffected,
and the 15–25 target in §5.2 remains reachable without reaching for foreign scopes.

**Consequence for §10.** The population bias narrows further: this set now measures
retrieval on *MemBerry-and-siblings development traffic*, not on the workstation's whole
query load. Stated in `BASELINE.md` with the numbers.

**The rejected alternative, recorded so it is not silently re-litigated.** The full-fidelity
set could live in the gitignored `docs/` private workspace instead of the public repo,
keeping all 137 queries. That was not chosen because it splits the eval artifact away from
the runner that consumes it and contradicts spec §4's "one tracked file". If memory-plane
breadth later proves to be the binding constraint, this is the amendment to revisit.

**Also applied:** `bench/eval/mined-queries.jsonl` (the raw population) is gitignored and
must never be committed. It is reproducible with `node bench/eval/mine-queries.mjs`.

### A5 — 2026-08-27 — exclusion ground E6, third-party terms in query TEXT

**E5 had a hole, and a pre-commit leak check found it, not a review.**

E5 excludes by `project:` **scope**. An **unscoped** query carrying third-party content passes
straight through it. Staging the branch and grepping the staged diff surfaced one such query, plus
a worse problem: **amendment A1 itself enumerated the client names** while explaining why they must
never be published. Documenting the leak by leaking it.

**Added — E6:**

> **E6 — third-party term in query text.** A query whose `input` payload contains any term listed
> in `bench/eval/.foreign-terms` is excluded, **regardless of scope**.

`.foreign-terms` is **gitignored**, one term per line, `#` comments allowed, case-insensitive
substring match. Gitignoring it is the entire design: a denylist committed to a public repo
publishes exactly what it exists to suppress. If the file is absent E6 becomes a no-op and the
selector **says so loudly** rather than passing silently.

A1's enumeration has been removed from this file for the same reason.

**A wrong first attempt, recorded because the correction is the useful part.** E6 was first
implemented by deriving the term list **at runtime from the mined scope tags** — every
`project:X` not in MemBerry's own family. That looked elegant and needed no denylist file, but it
was wrong on the definition: it treated the owner's **own** sibling projects as third-party. It
excluded 3 queries, **one of them a code-plane question that had already survived blind authoring
and a second reviewer** — the scarcest artifact in this whole exercise, since the pool holds only
5 code-plane queries.

**Foreign means "someone else's", not "not memberry".** With the corrected term file, E6 excludes
**0** queries — every genuine third-party name was already caught by E5's scope filter — and the
code plane is back to 5. E6 stands as a guard against future mining runs, not as a filter that
does work today.

**Net effect on the authored set: none.** All 9 questions that survived authoring keep identical
ids and splits, so the origin baseline recorded in `BASELINE.md` §2.6 remains valid and was not
re-taken.


### A2 — 2026-08-27 — §6 split assignment was degenerate; replaced

**The rule as originally written produced a broken split.** §6 cycled positions 1‑3 → dev
and 4‑5 → holdout *within each `plane × project` stratum*. At this set size almost every
stratum holds three or fewer questions, so position 4 is rarely reached and holdout
collapses. Measured on the real selection: **dev 18, holdout 2** against a stated 60/40.

**Replacement.** Stratify by **plane only**, walk strata in the fixed order
`code → mixed → memory`, and apply one 3‑dev / 2‑holdout cycle with a cursor that **does not
reset between strata**.

Two a priori justifications, neither of them an outcome:

1. **Plane, not `plane × project`.** The metrics differ by plane — `noiseRate` applies only
   to code items — while project changes nothing about what is measured. Project was never
   a real stratum, it just shattered the set into fragments too small to split.
2. **Code first.** The code plane carries the primary diagnosed defect and is the only plane
   `noiseRate` scores. Giving it the head of the cycle guarantees it lands in *both* splits.
   An earlier round-robin variant put 4 of 5 code questions in holdout, leaving exactly one
   to develop against — which would have made code-plane work unmeasurable during
   development and forced holdout opens to substitute for dev.

**Result:** dev 12 / holdout 8, exactly 60/40. `dev` = 3 code, 3 mixed, 6 memory;
`holdout` = 2 code, 6 memory. Re-running the selector on the same mined population
reproduces the assignment byte-identically.

**Known wart, accepted.** The mixed stratum (n=3) lands 3 dev / 0 holdout. Three items
cannot be split 60/40 without rounding, and mixed queries still contribute code items to the
code-plane picture through the dev split. Not worth a special case.

**Why this is not tuning.** Both defects were found by running the selector, which touches
only the mined question inventory. **No query has been executed and no retrieval result
exists**, so there is no outcome to have steered either change. The criteria used — "a
holdout must actually contain questions" and "the plane under development must appear in the
dev split" — are structural and were true before any measurement. Recorded here so the
judgement is auditable rather than assumed.

### A3 — 2026-08-27 — §7 permitted ground-truth sources were too narrow

**The first authoring pass dropped 13 of 20 questions, and 9 of those drops were an artefact of
a badly-scoped instruction, not a property of the questions.**

§7 requires keywords to be derived from non-MemBerry sources. The authoring instruction rendered
that as "repository files … and the gitignored `docs/` workspace" — meaning *this* repo. But the
mined queries are about **sibling projects**, and their source trees are on this workstation. One
author found `C:/Users/Guerr/Desktop/Neuri` anyway and grounded a question from it successfully;
the others correctly obeyed the narrow instruction and dropped.

**Clarified — the permitted set is every non-MemBerry source on this workstation:**

| project | path | recovers |
|---|---|---|
| memberry | `C:/Users/Guerr/Desktop/memberry` (+ git, + `docs/`) | — |
| Neuri | `C:/Users/Guerr/Desktop/Neuri` | h-10, h-15, d-19 |
| scribo-agent | `C:/Users/Guerr/Desktop/scribo-agent` | h-06 |
| ag3nt / AG3NTIC | `C:/Users/Guerr/Documents/ag3nt`, `/AG3NTIC` | d-12, d-17 |
| hermes-agent | **not present on this machine** | d-01, d-02, d-03 remain dropped |

**This does not weaken blindness**, which is about not seeing *retrieval output*. A sibling repo
is a file on disk, exactly like this repo's files.

**Two sources stay forbidden, and one is newly named because it is the subtle one:**

- MemBerry itself — any `berry_*` tool, any endpoint, any eval runner.
- **`~/.claude/projects/**/*.jsonl` — the agent transcripts.** They contain captured `berry_*`
  **tool_result payloads**, so reading one is equivalent to running the query. The miner reads
  them mechanically for tool *inputs*; a keyword author must never open one.

**The residual drops are correct and stay dropped.** Four questions (`d-09`, `d-13`, `d-14`,
`h-18`) ask for something that is a **property of the memory store** — "which stored memories
contain `NOT PUSHED`", "what did MemBerry ingest for project X". No file establishes that. This
is a real structural limit: **the memory plane is substantially harder to ground blind than the
code plane**, because code ground truth lives in repos and memory ground truth lives in MemBerry.
Recorded as a known limitation of EVAL-001, not solved here.

### A4 — 2026-08-27 — selection extended from 20 to 34 to offset attrition

Blind authoring plus a strict second reviewer removed 16 of the first 20 (13 dropped, 3
rejected), leaving 4 — far below §5.2's 15–25 target. The pool holds 48.

**Extended the target to 34** by re-running the selector unchanged. This is admissible because
**the rule picks, not the author**: same mechanical order, same exclusions, same split cycle, and
still **no retrieval result exists** to have steered which questions were added. Padding the set
with authored questions was rejected outright — that is how golden v2 died.

Result: 34 selected (dev 21 / holdout 13); planes code 5, mixed 3, memory 26.

**One assignment moved, disclosed rather than smoothed over.** Re-running with a larger target
kept **19 of 20** questions at an identical id and split; `eval001-h-12` became `eval001-d-12`
(holdout → dev). Cause: `assignmentOrder` sorts the memory plane by timestamp, so newly added
memory questions interleave and shift later cycle positions.

Not corrected, on purpose. The property that matters — no outcome-driven selection — is intact,
because no outcome exists; and the question in question was a drop candidate either way.
Re-engineering the split assignment to be provably append-only would be exactly the instrument
ceremony spec §1 warns against applying here. **If a future extension moves more than a couple of
assignments, revisit this** — the fix would be to freeze assignments by stable `queryId` rather
than by position.

### A6 — 2026-08-27 — the mined population is TRANSIENT, and §6's reproducibility claim is narrowed

**§6 says "re-running the assignment on the same mined file must reproduce the same splits byte
for byte". That is still true. What is NOT true is that re-mining reproduces the same mined file.**

Measured within a single working session, hours apart, with no change to `mine-queries.mjs`
except making one byte an escape sequence:

| | population |
|---|---|
| first mining run | **148** |
| second mining run, same day | **142** |

Six queries disappeared. Zero were gained. All six were memory-plane `berry_load` calls, and the
cause is not a miner bug: **their transcript files are no longer on disk.** Client transcripts are
working files that get rotated, compacted, and deleted; they were never a durable corpus, and the
miner reads exactly what is present at the moment it runs.

**Consequence, stated plainly so nobody trusts the wrong artifact:**

- `mined-queries.jsonl` is a **snapshot**, not a reproducible derivation. It is gitignored, so
  this does not corrupt anything committed — but re-running `mine-queries.mjs` months from now
  will yield a different population and therefore a different selection.
- **`eval001-questions.jsonl` is the durable artifact.** Every question carries its full
  `provenance` block, including the verbatim `originalInput` that was really issued. The
  questions remain replayable even when the transcript they came from is long gone. That is why
  the runner replays from `provenance.originalInput` rather than re-deriving anything.
- **Do not regenerate the selection to "refresh" it.** Doing so on a shrunken population would
  silently drop authored questions and renumber the rest. The committed set is frozen; it grows
  only by §8 (append real failure cases), never by re-selection.
- The committed `SELECTION-LOG.md` records the **148-query** population it was generated from.
  It is a historical record of that run and is deliberately not regenerated.

**Verified unaffected:** all 9 authored questions survive in the 142-query population, and the
`queryId` hash is provably unchanged by the escape-sequence edit (both forms digest to
`1fde0e85c0cc` on the same input).

**This also strengthens §10's bias warning.** The population is not merely single-client — it is
single-client *and* time-decaying. A query issued today may be unminable next month. Anyone
extending this set should mine early and treat the committed question file as the record of
record.
