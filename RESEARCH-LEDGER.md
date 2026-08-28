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

### RL-002 — Split IDX-004's two mechanisms onto separate flags
**Evidence:** measured · **Status:** ready · **Opened:** 2026-08-27

Direct consequence of RL-001. Today `MEMBERRY_CODE_RERANK_V1` turns on both the widening (proven)
and the reranker (unproven), so you cannot take the safe half. The reranker also carries a real
latency risk: `scoreBatch` recomputes document frequency *inside* the per-candidate loop, so cost
scales with candidates² — and the window just went from 10 to 50, against a 250ms timeout. On
timeout it silently returns the unranked order (a latched warning was added, but it degrades
quietly by design).

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

### RL-007 — `FactStore` is constructed without an embedding provider
**Evidence:** audit (file read, not re-verified) · **Status:** open · **Opened:** 2026-08-27

`constructor(private driver: Driver)` — the identical defect IDX-003 fixed in `CodeIndexer`,
sitting ~18 lines above a correct `new SemanticStore(driver, embedding)`. Same class, same fix.

**Revisit when:** RL-008 is decided — if the Fact plane gets a reader, this is the prerequisite;
if the index is dropped, this becomes moot.

---

### RL-008 — The Fact plane: 0 of 29,314 embedded, and nothing reads the index
**Evidence:** measured (counts, 2026-08-27) + audit (reader absence) · **Status:** decision needed

`fact_embedding` and `fact_content` are created and maintained, and the audit found **no query
reads them**. Live counts: 29,314 Fact nodes, **0 embedded**. Status distribution: 29,109
`tentative`, 152 `active`, 53 `invalidated`.

Two live consequences:
- Backfilling the embeddings would cost money for an index with no reader.
- The new coverage guard (HK-1) reports Fact as under-covered on every boot, so `status.degraded`
  is permanently non-empty — which blunts HK-1's own signal (see RL-016).

**Either build a reader or drop the index.** Doing neither is the current state and is the worst
of the three.

**Revisit when:** before the next boot-health change, or as part of RL-006's findings.

---

### RL-009 — `berry_context` / `berry_ask` discard every Fact and MemoryBlock
**Evidence:** audit · **Status:** open · **Opened:** 2026-08-27

Aggregation headings in the assembler skip them, so `berry_ask` structurally **cannot cite a
fact**. Note the scope correction: this sounds like 29,314 lost rows, but 99.3% of Facts are
`tentative` (see RL-008), so the real gap is the **152 `active`** ones. That is a much smaller
finding than it first appeared, and it is recorded that way on purpose.

**Revisit when:** RL-006 lands and can size the impact, or if a user reports a fact that should
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

### RL-011 — 99.3% of Facts are stuck at `tentative`
**Evidence:** measured (2026-08-27) · **Status:** hypothesis · **Opened:** 2026-08-27

29,109 of 29,314. Only 152 `active`. Either promotion is working correctly and these genuinely
never earned promotion, or **the promotion pipeline does not run**. Nobody has looked.

If it is the second, it is a bigger finding than RL-009 — it would mean the whole tentative→active
lifecycle is inert.

**Revisit when:** one investigation, cheap, any time. This is a question, not a conclusion — do not
cite it as a defect until someone checks.

---

### RL-012 — 5,136 symbols are unreachable by any scoped search
**Evidence:** measured (2026-08-27) · **Status:** decision needed · **Opened:** 2026-08-27

Symbols with `project_tag = NULL`. IDX-002B's scope fix means no scoped search can ever return
them; the audit found them to be foreign or stale, none belonging to a live project.

They were embedded anyway on 2026-08-27 — deliberately, and the reasoning is worth keeping: the
alternative was either an arbitrary coverage threshold or an unattended destructive delete. Cost
was about half a cent, and it left this decision open rather than making it silently.

**They remain a deletion candidate.** Deleting them would also let the HK-1 coverage floor tighten.

**Revisit when:** someone is willing to make a destructive call on the graph, or before the next
index-wide operation.

---

### RL-013 — Seven indexes are maintained on every write and queried by nothing
**Evidence:** audit · **Status:** open · **Opened:** 2026-08-27

Every symbol write computes and stores vectors that no query reads (the 4096-slot sparse lexical
vector is the most expensive). This is a write-amplification and storage cost, not a correctness
problem — which is why it keeps losing to capability work.

**Revisit when:** write latency or graph size becomes a complaint, or during any index cleanup.
Pair it with RL-012, which is the same kind of housekeeping.

---

### RL-014 — `Semantic.status` is NULL on all 194 nodes
**Evidence:** measured (2026-08-27) · **Status:** open · **Opened:** 2026-08-27

The field exists and nothing sets it. Facts carry a real status distribution; Semantics carry
none. So there is currently no way to mark a semantic memory deferred, superseded, or retired —
which is part of why this ledger is a markdown file instead of living in MemBerry itself.

**Revisit when:** before attempting to migrate this ledger into MemBerry (RL-015), or when
lifecycle work next touches Semantic nodes.

---

### RL-015 — Move this ledger into MemBerry
**Evidence:** hypothesis · **Status:** open · **Opened:** 2026-08-27

MemBerry is a memory system for durable project context, and its own project context is tracked in
a flat file. That is worth fixing once it can actually hold the shape: an entry needs a status, a
revisit trigger, and citable retrieval.

**Blocked on:** RL-014 (no status field in use) and RL-009 (`berry_ask` cannot cite the entries
back). Both are prerequisites, not excuses.

**Revisit when:** both are closed. Until then this file is the source of truth.

---

### RL-016 — HK-1's coverage alarm lands in a channel that is already dirty
**Evidence:** verified · **Status:** open · **Opened:** 2026-08-27

The IDX-004 coverage guard reports any label below 95% embedding coverage. Fact sits at 0% (see
RL-008) and already reported under the previous zero-check, so `status.degraded` is permanently
non-empty on the live box.

An alarm nobody can act on gets ignored — which is the exact failure mode the guard was widened to
prevent, with the sign flipped. HK-1 does not fully pay off until RL-008 is decided.

**Revisit when:** RL-008 is decided.

---

### RL-017 — 14 pre-existing lab failures in RET-010E
**Evidence:** measured · **Status:** open · **Opened:** 2026-08-27

`bench/lab/ret010/__tests__/dev-gate.test.ts` ("RET-010E CommonJS executable boundary") fails 14
tests in both node:20 and node:22. Byte-identical across the IDX-003 and IDX-004 gates, so this
is stable and pre-existing, not drift.

They are currently absorbed as known-red at every gate, which means `LAB_EXIT=1` carries no
signal — the same "alarm nobody acts on" pattern as RL-016.

**Revisit when:** the lab gate needs to be trustworthy, or before anyone relies on `LAB_EXIT`.

---

## Closed

_Nothing yet. When an entry closes, move it here with the PR that closed it and keep the trigger
visible, so the reasoning survives the fix._
