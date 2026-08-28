# Research Ledger

Findings we chose **not** to act on yet, each with the condition that should bring it back.

This is not the roadmap. `10X_EXECUTION_ROADMAP.md` says what to build next; this file says what we
learned and deliberately deferred, and why. The roadmap has been wrong about the next real defect
three times running — every time, live measurement overturned it. This ledger exists so the
evidence that corrected it does not live only in someone's head.

## Rules

1. **Every entry needs a revisit trigger.** Not "later" — a condition someone can check. An entry
   without a trigger is a graveyard entry; delete it or give it one.
2. **Every entry names its evidence strength.** `measured` (a number from a real run),
   `verified` (read in the code, file:line), `audit` (found by review, not independently
   re-checked), `hypothesis` (plausible, untested).
3. **Negative results stay.** Something we tried that made things worse is the most valuable kind
   of entry, because it stops the next person burning a day on it.
4. **This repo is public.** Entries describe MemBerry's own code. No client names, no credentials,
   no infrastructure detail that is not already public.
5. **Closing an entry means linking the PR that closed it.** Move it to Closed, keep the trigger
   visible, so the reasoning survives.

---

## Open

### RL-001 — The BM25F reranker's value is unproven
**Evidence:** measured · **Status:** deferred · **Opened:** 2026-08-27 (PR #123)

IDX-004 shipped two mechanisms behind one flag: a wider retrieval window (the kind prior then
sorting 50 rows instead of 10) and BM25F reranking. Isolated on the live graph:

| | off | widen-only | +rerank |
|---|---|---|---|
| top-5 | 60.0% | **70.0%** | 70.0% |
| answers found | 6/10 | **7/10** | 7/10 |
| MRR | 53.3% | 57.5% | 58.3% |
| variable share@5 | 50.0% | **8.0%** | 8.0% |

The widening does essentially all the work. The reranker adds **+0.8 MRR** and is a wash by case:
fixes `oc-02` (4→1) and `oc-05` (2→1), breaks `oc-09` (1→2) and `oc-10` (1→3).

**Deferred because:** two-up-two-down at n=10 is indistinguishable from noise. Also structural —
the reranker's weights were calibrated on memory prose, and code signatures are a different token
distribution, so this is a mis-aimed instrument rather than a broken one.

**Live confirmation, 2026-08-28.** Deployed and the flag turned on. The deployed server reproduces
the container numbers exactly — top-5 **70.0%**, MRR **58.3%**, variable share **8.0%**,
test-file share **0.0%**, 0 errors — and the deploy-with-flag-off step measured byte-identical to
the old build, so the two are separately attributable. The +0.8 MRR and the two-up-two-down case
split both hold in production. **This entry is unchanged by shipping:** the reranker's value is
still unproven at n=10, it is just now unproven while switched on.

**Revisit when:** `bench/eval/outcome-cases.jsonl` exceeds ~30 cases (see RL-005), or if anyone
recalibrates the reranker weights on code.

**Cheap re-test:** `node bench/eval/idx004-measure.mjs --no-reranker` — the isolation arm is
already committed.

**If we never revisit:** delete the reranker path. Flagged-off code nobody returns to is rot with
a switch on it.

---

### RL-002 — Split IDX-004's four coupled behaviours off their single flag
**Evidence:** measured · **Status:** ready · **Opened:** 2026-08-27

Direct consequence of RL-001. Today `MEMBERRY_CODE_RERANK_V1` turns on both the widening (proven)
and the reranker (unproven), so you cannot take the safe half.

**Correction, 2026-08-28: it is four behaviours, not two, and their ORDER is load-bearing.** One
boolean, `rerankThisCall` (`packages/code/src/search.ts:245`), switches all of:
widen the retrieval window to at least 50 (`:248`; `widenLimit` is `Math.max(limit, 50)` at
`:128-130`, so a caller asking 100 still gets 100), run the reranker (`:332`), force the IDX-002A
kind prior on even when `MEMBERRY_KIND_RANK_V1` is off (`:346` — note the `||`), and truncate
back to the caller's limit (`:347`). The comment at `:242-244` records why they are computed once
— so the four "cannot drift apart into a configuration nobody measured" — and `:319-330` records
why their ORDER is load-bearing: fuse-wide → rerank → truncate with NO prior is **worse than
baseline**, because the reranker's coverage and phrase terms favour memory prose over a short
code signature on an English question.

So this is a flag-surface redesign with an order constraint, not a two-line split — and a naive
two-way split can reach exactly the configuration the comment forbids. `MEMBERRY_CODE_SCOPE_V2`
has the same shape and says so itself (`search.ts:91`, "Two leaks, one switch";
full docblock `:88-97`), gating three sites off one boolean. The reranker also carries a real
latency risk: `scoreBatch` recomputes document frequency *inside* the per-candidate loop, so cost
scales with candidates² — and the window just went from the caller's limit (20 by default) to
50, against a 250ms timeout. On timeout it silently returns the unranked order (a latched
warning was added, but it degrades quietly by design).

**Trigger fired 2026-08-28, and the decision was to ship both.** The flag is now on in
production. Recording what that means rather than quietly retiring the entry:

- The latency risk **did not materialise** on the 10-case probe. No `rerank declined (baseline
  outcome)` warning appeared in the logs, so the reranker completed inside its 250ms budget on
  every query. That is evidence, not a guarantee — 10 queries against one project is a narrow
  sample, and the warning is latched to once per process, so a later degradation on a busier or
  wordier corpus would log once and then go quiet.
- **The coupling is now a live liability, not a hypothetical one.** Turning off the unproven half
  currently means turning off the proven half with it. If the reranker ever misbehaves, the only
  lever available is one that also discards top-5 60% → 70% and variable share 50% → 8%.

**Revisit when:** RL-001 is decided, or at the first sign of rerank latency — whichever comes
first. Splitting the flags is the mechanism that makes RL-001 answerable without a rollback.

---

### RL-003 — The fulltext channel sends whole English questions to Lucene
**Evidence:** verified · **Status:** open · **Opened:** 2026-08-27

`packages/code/src/search.ts` builds the fulltext query as `` `${escaped}*` `` — the entire
natural-language question, wildcarded. That is why single-word variables whose names collide with
ordinary English (`to`, `at`, `results`, `budget`) scored hits at all.

IDX-002A's kind prior and IDX-004's widening both *compensate* for this downstream. Neither fixes
it.

**Revisit when:** the next retrieval packet touches the fulltext channel, or if rank-1 is still
stuck at 50% after the coverage work.

---

### RL-004 — Stopword stripping makes rank-1 WORSE (negative result)
**Evidence:** measured · **Status:** closed-negative · **Opened:** 2026-08-27

A six-config sweep tested stripping stopwords from the query before the fulltext channel. It
raises coverage but **drops rank-1 from 50% to 30%** (config F). An earlier read of the same sweep
called it "promising"; that was wrong and is corrected here.

**Do not retry blind.** If it comes back, it must come back paired with something that restores
precision over the wider recall — which is exactly what IDX-004 attempted, and see RL-001 for how
well that went.

**Revisit when:** a precision mechanism is proven on code text (RL-001 resolved positively).

---

### RL-005 — The outcome probe is only 10 cases
**Evidence:** measured · **Status:** open · **Opened:** 2026-08-27

`bench/eval/outcome-cases.jsonl` is the only file-level-ground-truth probe, and it has 10 entries.
Every retrieval decision this week rests on it. At n=10 a single case is 10 percentage points, so
differences below ~2 cases cannot be distinguished from noise — which is precisely what blocked
RL-001.

Expanding it is hand-authored work (each case needs a question plus a verified source-of-truth
file), but bounded.

**Revisit when:** any retrieval change produces a delta smaller than 2 cases and the decision
matters. That has already happened once.

---

### RL-006 — The memory plane has no outcome instrument
**Evidence:** measured · **Status:** open — NEXT SPRINT · **Opened:** 2026-08-27

Code search is ~13% of measured call volume. The memory plane — `berry_context`, `berry_ask`,
`berry_load` — is the other ~87%, and **nothing measures whether it returns the right thing.**

This is the single largest gap in the program. The audit produced ~20 candidate memory-plane
defects (RL-007 through RL-011 below) that cannot be *ranked* without it, and the last four
packets have all demonstrated the same lesson: the roadmap's guess about the top defect was wrong
until something measured it.

**Revisit when:** immediately. `bench/eval/run-outcome-probe.mjs` is the template and took under a
day for the code plane.

---

### RL-007 — `FactStore` cannot embed a Fact, and a constructor param would not change that
**Evidence:** verified · **Status:** open · **Opened:** 2026-08-27

`constructor(private driver: Driver)` (`packages/neo4j/src/fact.ts:13`) does take no embedding
provider, and `new SemanticStore(driver, embedding)` at `packages/core/src/services-factory.ts:194`
really is the correct sibling to the `new FactStore(driver)` at `:175`. (The original entry put
the two ~18 lines apart, which is right; it just read as though both lived in `fact.ts`.)

**Correction, 2026-08-28 — the diagnosis holds, the SIZE was wrong.** The original framing
invited a one-line constructor change, and that change would be **completely inert**: there is no
`resolveEmbedding` on `FactStore`, `create()` persists `fact.embedding` only when a caller hands
one in (`fact.ts:88-94`) and none of the five production call sites does —
`packages/core/src/service.ts:1162`, `packages/core/src/dream.ts:228`, and
`packages/core/src/consolidation.ts:1129`, `:1135`, `:1163`. That spread is itself the argument
for putting the embed call inside `create()` rather than at the callers. `setEmbedding`
(`fact.ts:581`) has exactly one caller in the tree, a test.

**IDX-003 is the template, not the counterexample.** It is tempting to say `CodeIndexer` already
owned its write-time embed call and `FactStore` does not — that is false, and git says so.
`a1345d9` added all three parts in ONE commit: the text synthesizer `symbolVectorText`, the
`embedSymbols` write-path call and its call site, and the optional constructor param
(`packages/code/src/indexer.ts:66`). `SymbolNode` had no `content` field either
(`packages/code/src/types.ts:101-127`). The shape transfers — with one caveat that cuts AGAINST
us: IDX-003's step 1 merely extracted an expression that already ran inline for the lexical
vectors, whereas the Fact plane has no such string anywhere, so step 1 is genuinely new work
here. The three parts are:

1. A text synthesizer. `FactNode` (`packages/core/src/types.ts:361-383`) has no `content` field,
   so there is nothing to embed yet; subject + predicate + object is the Fact's text.
2. A write-path embed call in `create()`, mirroring `embedSymbols`.
3. The constructor parameter, which is what makes 1 and 2 reachable.

Plus one thing IDX-003 also needed and this entry must not forget: a backfill for the 29,314
existing nodes, since `setEmbedding` has no production caller to drive it.

**Revisit when:** RL-008 is decided. Note the asymmetry: if the Fact plane gets a reader this is
the prerequisite, but if the indexes are DROPPED this is not neutrally moot — dropping
`fact_embedding` (`packages/neo4j/src/schema.ts:69`) removes the vector index this fix exists to
fill, so the drop forecloses it rather than deferring it. Dropping `fact_content` (`:63`) does
not: it indexes the subject/predicate/object properties, and those properties — the synthesizer's
input — survive it untouched.

---

### RL-008 — The Fact plane: 0 of 29,314 embedded, and nothing reads the index
**Evidence:** measured (counts, 2026-08-27) + verified (no reader) · **Status:** decision needed

`fact_embedding` and `fact_content` are created and maintained and **no query reads them** — each
appears only in its own CREATE statement in `packages/neo4j/src/schema.ts` (`:69` and `:63`). Live
counts: 29,314 Fact nodes, **0 embedded**. Status distribution: 29,109 `tentative`, 152 `active`,
53 `invalidated`. **Re-measured on the live graph 2026-08-28: identical, to the row.**

Two consequences:
- Backfilling the embeddings would cost money for an index with no reader.
- The new coverage guard (HK-1) reported Fact as under-covered on every boot, pinning
  `status.degraded` non-empty and blunting HK-1's own signal. RL-016 fixed that on 2026-08-28, at
  the cost recorded below.

**Either build a reader or drop the index.** Doing neither is the current state and is the worst
of the three.

**2026-08-28 — this entry lost its automated reminder.** RL-016 removed Fact from the coverage
guard's label list, because a guard for indexes nobody reads was pinning `status.degraded`
permanently non-empty. That was the right call for the guard and a real cost here: nothing in the
running system will mention the Fact plane again. **This ledger entry is now the only thing
holding this decision.** If it gets closed without a decision, the Fact plane silently becomes
permanent.

**Revisit when:** RL-006 lands and can size it — or sooner, since nothing else will raise its hand.

---

### RL-009 — `berry_context` / `berry_ask` discard every MemoryBlock, not every Fact
**Evidence:** verified · **Status:** open · **Opened:** 2026-08-27

`memory.block` sits in `RETRIEVAL_TRACE_CHANNEL_ORDER` (`retrieval/trace.ts:97-101`) but has no
`SOURCES` spec — the spec union admits only `memory.scope` and `arch.entity`
(`retrieval/runtime-candidate-channel.ts:74`, `:132-135`) — so it falls to the `(!spec && !isFact)`
branch at `:338` and resolves to `unavailable` on every request. The 16 MemoryBlocks in the graph
are unreachable through either tool.

**Scope correction, 2026-08-28: the Fact half of this entry was wrong the day it was opened.** The
original claim was read off `parseMemoryMarkdown` (`retrieval/assembler.ts:1984-1986`, `:2016-2021`),
which skips the `Core Memory` / `Working Memory` / `Current Facts` / `Fact Timeline` aggregate
headings and emits only `source_type: 'semantic'` (`:2042`). That is the legacy path. With
`MEMBERRY_CANDIDATE_CHANNEL_V1=1` — live — both tools run through
`assembleCandidateExecution(Served)` (`retrieval/tools.ts:514-539`, `:642-668`), where `memory.fact`
is a real channel: `FactStore.getActiveByEntityIdsBatch` → `sourceType: 'fact'`
(`runtime-candidate-channel.ts:336`, `:356-358`, `:262`) → a `Facts` heading in `groupAndBudget`
(`assembler.ts:2387`). That channel returns exactly `f.status = 'active'` rows (`neo4j/fact.ts:302`),
so the **152 `active`** Facts this entry named as the real gap are precisely the ones already
reachable. The heading map has carried `fact: 'Facts'` since `46ff991` (2026-08-16), eleven days
before this entry was opened — stale is not the excuse.

This does not weaken RL-008. The fact channel reads Fact node properties by entity MATCH;
`fact_embedding` and `fact_content` still have no reader.

**Revisit when:** RL-006 lands and can size the impact, or if a user reports a block that should
have been cited and was not.

---

### RL-010 — Raw episodes are injected at hard-coded confidence 1.0
**Evidence:** audit · **Status:** open · **Opened:** 2026-08-27

Raw episodes enter the candidate pool at a fixed confidence of 1.0, which outranks the
*consolidated semantics derived from those same episodes*. If true, consolidation is actively
losing to its own input — meaning the lifecycle work is being undone at retrieval time.

**Revisit when:** RL-006 lands. This is the memory-plane finding most likely to be large, and the
one most obviously unmeasurable without an instrument.

---

### RL-011 — 99.3% of Facts are `tentative`, and the pipeline that would promote them IS running
**Evidence:** verified · **Status:** open · **Opened:** 2026-08-27

29,109 of 29,314. Only 152 `active`, unchanged when the graph was re-counted on 2026-08-28.

**Someone looked, 2026-08-28. The alarming half is refuted.** The promotion path is fully wired,
with no flag gating it: `buildExtractionConsumer(core)` (`packages/mcp/src/bootstrap.ts:744`) →
`packages/core/src/services-factory.ts:345` → `processExtraction` (`service.ts:1003-1008`) →
`_extractFactsOnce` → `findBySubjectPredicate` with tentative contenders surfaced
(`service.ts:1073`) → the promotable guard (`:1104`) → `await factLayer.corroborate(...)`
(`:1106`) → `SET f.status = 'active'` (`packages/neo4j/src/fact.ts:658`). That is the only
writer that TRANSITIONS a Fact to active — consolidation separately MINTS facts already active
on its auto-invalidate branch (`packages/core/src/consolidation.ts:1118`), so the 152 `active`
rows are not all corroborations. The tentative→active lifecycle is not inert, so **do not cite
this entry as evidence that it is.** One precondition, not a flag: extraction only runs when
`config.embedding.apiKey` is set (`service.ts:913`, `:1005-1006`).

What remains are four narrower defects, each of which would suppress promotion without stopping
the pipeline:

- **Raw byte equality on the object.** `existing.find(f => f.object === fi.object)`
  (`service.ts:1077`) matches the object exactly, while the predicate immediately above it is
  normalized first (`:1065`). "Cerebro" and "cerebro" never reinforce each other.
- **Corroboration needs a DISTINCT episode.** `independent` requires non-empty provenance that
  does not already contain this episode (`service.ts:1097-1099`), and deductive facts are
  promotable only when it holds (`:1100-1103`). This is OPT-70b anti-poisoning and is
  deliberate — but it means a fact restated in one episode can never promote.
- **Minting is unconditionally `tentative`** (`service.ts:1146`) and nothing revisits old facts
  proactively. There is no expiry — a later distinct episode can still promote one at any time —
  but nothing goes looking, so a fact whose corroborating episode never arrives stays tentative.
- **Subject-phrasing drift hides contenders.** `findBySubjectPredicate` resolves the subject with
  `resolveExisting` and returns `[]` when there is no match (`packages/neo4j/src/fact.ts:553-554`),
  while `create()` resolves-or-CREATES (`:23`). So a subject never strands its own prior facts —
  but a later episode phrasing the subject differently mints a fresh Entity, and the existing
  contenders become invisible to it. Weakest of the four; listed for completeness.

**Revisit when:** RL-006 lands and can size which of the four actually accounts for the 29,109 —
or sooner for the object-normalization one, which is a one-line change with an a-priori
justification and needs no measurement. Loosening it touches an anti-poisoning gate, so it
wants a security read.

---

### RL-012 — 5,136 symbols are unreachable by any scoped search
**Evidence:** measured (2026-08-27) · **Status:** decision needed · **Opened:** 2026-08-27

Symbols with `project_tag = NULL`. IDX-002B's scope fix means no scoped search can ever return
them; the audit found them to be foreign or stale, none belonging to a live project.

They were embedded anyway on 2026-08-27 — deliberately, and the reasoning is worth keeping: the
alternative was either an arbitrary coverage threshold or an unattended destructive delete. Cost
was about half a cent, and it left this decision open rather than making it silently.

**They remain a deletion candidate.** Deleting them would also let the HK-1 coverage floor tighten.

**Confirmed 2026-08-28:** all 5,136 are still present and still embedded. The graph now holds
54,314 symbols at 100% coverage across all five tag buckets, so no coverage number will surface
them again. The deletion call has not been made.

**Revisit when:** someone is willing to make a destructive call on the graph, or before the next
index-wide operation.

---

### RL-013 — Two Symbol indexes are maintained on every write and queried by nothing
**Evidence:** verified · **Status:** open · **Opened:** 2026-08-27

`symbol_mini` (`code/schema.ts:30`) has no reader: `mini_vector` is written on every symbol at
`code/indexer.ts:87` and queried nowhere. `symbol_content_hash` (`code/schema.ts:16`) has no reader
either — nothing in the repo puts a predicate on `s.content_hash`. The one query that returns it
(`symbol-store.ts:370`) seeks on `symbol_file_path` and projects the hash out; the comparison then
happens in JS at `indexer.ts:216`. A property index serves predicates, and there is no predicate.
Two properties cost the same way with no index at all — `sparse_indices` / `sparse_values`
(`code/indexer.ts:225-226`). This is a write-amplification and storage cost, not a correctness
problem — which is why it keeps losing to capability work.

**Correction, 2026-08-28.** This entry opened claiming seven unread indexes and named the
4096-slot lexical vector as the most expensive of them. Both halves were wrong when it was written,
not stale, and the second is the dangerous one: acting on it would have deleted a live retrieval
channel. `packages/code/src/schema.ts` declares thirteen Symbol indexes — nine property (`:11-21`),
one fulltext (`:23-25`), three vector (`:27-31`) — and eleven are reachable: `symbol_search`,
`symbol_embedding` and `symbol_lexical` by the search channels (`code/search.ts:496`, `:547`,
`:604`), `symbol_name_file_kind` by `findByCompositeKey` (`code/symbol-store.ts:192-204`), the rest
by the language, kind and scope filters (`search.ts:476`, `:489`, `:786-812`). The lexical vector
is also **dense**, not sparse — `Float64Array(4096)` at `code/vectors.ts:68-70` — and
`symbol_lexical` is queried by `lexicalVectorSearch` (`search.ts:604`) as an ungated arm of the
4-way fan-out in `searchStandard` (`search.ts:270`, `:278-291`); only the semantic arm is flagged.
It has been read since the package landed in `195c5f0`.

**Revisit when:** write latency or graph size becomes a complaint, or during any index cleanup.
Pair it with RL-012, which is the same kind of housekeeping.

---

### RL-014 — `Semantic.status` is NULL on all 194 nodes
**Evidence:** measured (2026-08-27) + verified (lifecycle) · **Status:** open · **Opened:** 2026-08-27

The field exists and nothing sets it — there is no `status` on `SemanticNode`
(`core/types.ts:39-58`) and zero matches for it in `packages/neo4j/src/semantic.ts`. Facts carry a
real status distribution; Semantics carry none. Re-measured 2026-08-28: still 194 nodes, still NULL
on all 194.

**Scope correction, 2026-08-28.** This entry concluded there was no way to mark a semantic memory
deferred, superseded or retired. Two of the three ship today. **Superseded:** the `SUPERSEDES` edge,
written at `neo4j/semantic.ts:272` and read back by the provenance chain (`neo4j/provenance.ts:18`,
`:45`). **Retired:** the reversible `archived` flag (`core/types.ts:57`), set by the lifecycle
service (`core/lifecycle.ts:467` → `neo4j/lifecycle.ts:351`) and enforced across the read paths by
`archivedWhere` (`neo4j/query.ts:60-62`), with `MEMBERRY_LIFECYCLE_V1` live. Only **deferred** has
no mechanism at all. What is missing is a status vocabulary on Semantic, not a lifecycle — a
narrower prerequisite for RL-015 than this entry was written as, and still part of why this ledger
is a markdown file instead of living in MemBerry itself.

**Revisit when:** before attempting to migrate this ledger into MemBerry (RL-015), or when
lifecycle work next touches Semantic nodes.

---

### RL-015 — Move this ledger into MemBerry
**Evidence:** hypothesis · **Status:** open · **Opened:** 2026-08-27

MemBerry is a memory system for durable project context, and its own project context is tracked in
a flat file. That is worth fixing once it can actually hold the shape: an entry needs a status, a
revisit trigger, and citable retrieval.

**Blocked on:** RL-014, narrowly — the missing status vocabulary on Semantic, since `SUPERSEDES`
and `archived` already cover superseded and retired. RL-009 blocks this only if entries land as
MemoryBlocks: as of 2026-08-28 `berry_ask` cites semantics and facts, and blocks not at all.
Neither is an excuse.

**Revisit when:** both are closed. Until then this file is the source of truth.

---

### RL-016 — HK-1's coverage alarm landed in a channel that was already dirty
**Evidence:** verified · **Status:** RESOLVED 2026-08-28 · **Opened:** 2026-08-27

The coverage guard reported any label below 95%. Fact sits at 0%, so `status.degraded` was
permanently non-empty and could never clear on any boot.

**Fixed by correcting the guard's scope, not by muting it.** The guard exists to catch exactly one
failure: a vector index that queries hit and silently get nothing from. Nothing reads
`fact_embedding` — it appears only in its own CREATE statement in `schema.ts` — so Fact coverage
cannot produce that failure. The guard now iterates `EMBEDDING_READ_LABELS`
(`Symbol`, `Semantic`, `Episodic`), with the rule written down: add a label when something starts
reading its embeddings, not before. Pinned by S18.

**Not confirmable from outside the process, and worth knowing why.** `status.degraded` is a
bootstrap-local array (`packages/mcp/src/bootstrap.ts:254`, pushed at `:273`, `:292`, `:311`) that
is only ever printed to stderr at `:762-765`. It appears in no HTTP payload. `/readyz` does return
a `consolidation_automation` block with its own `degraded` / `limitations` fields, but those come
from consolidation worker health (`consolidation-coordinator.ts:111-117`) and would read the same
whether or not this fix landed — checking them proves nothing about the coverage guard. Verifying
this one means reading the server's boot log, or the S18 pin.

**What this cost, recorded because it is easy to lose:** the Fact plane's open decision just lost
its only automated reminder. See RL-008 — this ledger is now the only thing holding it.

---

### RL-017 — 13 of 14 "pre-existing lab failures" were a broken gate harness; the 14th is unexplained
**Evidence:** measured · **Status:** RESOLVED 2026-08-28 (13 of 14) · **Opened:** 2026-08-27

The lab sweep failed 14 tests in both Node majors, byte-identical across three consecutive gates
(recorded at the time against `bench/lab/ret010/__tests__/dev-gate.test.ts`, though the
dubious-ownership class reaches other lab suites that also shell out to git, so that single-file
attribution is not corroborated). Stable and pre-existing — and read, for three packets, as a
product defect nobody had time for.

**Thirteen of them were not a product defect. They were our own gate script.** CI runs the same
command (`npm run bench:lab:test`, `ci.yml:50`) and is expected green, which should have been the
tell. No CI run id was recorded at the time, so treat that green as expected rather than
attested. **The fourteenth is still unexplained** — see the bullet below; nothing here says it is
not a product defect.

- **13 of 14:** `fatal: detected dubious ownership in repository at '/w'`. The gate container ran
  as root against a uid-1000 worktree. `git config --global --add safe.directory` does not help,
  because the lab sandbox spawns git with a sanitised environment — HOME is unset, so the global
  config is never read. Fixed by matching the container uid to the worktree owner **and** running
  `npm ci` under the same uid; doing only one trades dubious-ownership for EACCES on
  `node_modules/.cache`.
- **1 of 14: CAUSE NOT ESTABLISHED.** This entry originally said the finalizer-drain test shells
  out to the `docker` CLI, which the `node:NN` image does not contain. **That attribution is
  withdrawn, 2026-08-28.** `grep -i docker` over `bench/lab/ret010/__tests__/dev-gate.test.ts`
  and `bench/lab/ret010/dev-gate.cjs` returns zero on both; the named test compiles the gate
  in-process and calls `__testFinalize` with injected hooks — no docker, no container. It is NOT
  subprocess-free, though: `developmentFailureFixture` runs
  `execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' })`
  (`dev-gate.test.ts:307`) — the same git-against-a-host-owned-worktree operation blamed for the
  other 13. **A lead, not a cause, and a weak one:** this failure SURVIVED the uid fix that
  cleared those 13, which is evidence the class is different, not the same. It has not been
  checked either way.
  **And docker is not reachable from this run at all:** the lab's docker spawns sit behind
  `candidate/live.ts` and `candidate-v3/live.ts`, which run from the `bench:lab:admission:*:live`
  scripts as their own CI steps, not from `vitest run bench/lab`. "Docker is missing" cannot
  explain a failure in this sweep, whichever test it is. The suite HAS been run — that is how we know one case
  still fails after the uid fix — but nobody has read that case's output, which is what would
  establish the cause. CI runs the same command (`npm run bench:lab:test`, `ci.yml:50`) and is
  expected green; that is an expectation, not an attestation, and **it does not license ignoring
  the red here** — with the cause unknown there is no established reason CI's environment differs
  from the container's. **Do not substitute a new cause without a run** — that is how this entry got its first
  one — and note the failing test's IDENTITY was recorded alongside the withdrawn cause and has
  not itself been re-confirmed.

The fix lives in a tracked script, `scripts/gate.sh`, so the reasoning cannot evaporate with a
box-local file again. **Expected steady state is `LAB_EXIT=1` with exactly ONE failure; two or
more is a real regression.**

**Lesson worth more than the fix:** "pre-existing, identical across gates" proved the failures were
*stable*, and I treated that as evidence they were *legitimate*. It was only evidence they were
consistent. A red gate nobody has diagnosed is not a baseline, it is an unread message.

**Revisit when:** the one remaining lab failure becomes worth diagnosing, or if lab failures
ever exceed one.

---

## Closed

_Nothing yet. When an entry closes, move it here with the PR that closed it and keep the trigger
visible, so the reasoning survives the fix._
