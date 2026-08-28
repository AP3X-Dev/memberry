# Memory-plane occupancy — origin reading

> **UNOFFICIAL. This is not a baseline and not an EVAL-001 result.**
>
> It is a section-8 sibling probe under [`BASELINE.md`](BASELINE.md): it never writes BASELINE
> section 7, never moves the origin, and its numbers must **never** be quoted beside the
> `keywordRecall` figures in BASELINE.md section 2.6 — those were voided by section 2.7 and a fresh
> EVAL-001 baseline is still owed. Different corpus, different metric, different question.
>
> What it measures is **what kind of thing occupied each delivered slot**, not whether any of it
> was correct. Nothing here says retrieval is good or bad.

## 1. Why this exists

The memory plane is most of the call volume and had never produced a non-keyword number
(`RESEARCH-LEDGER.md` RL-006). Five ledger entries were parked behind that gap because they could
not be ranked without one. This is the number.

It deliberately carries no ground truth. The two previous purpose-built instruments died on
hand-authored relevance labels over a mutating corpus; a structural question has no expected
answer, so a surprising result here cannot be confused with the corpus having moved.

## 2. Run identity

| field | value |
|---|---|
| date | 2026-08-28 |
| host | cerebro, gate worktree `/home/cerebro/gate/repo22` |
| repo commit in that worktree | `089a3da` |
| probe | `bench/eval/memory-occupancy-probe.mjs` (from branch `docs/refresh-stale-claims`) |
| node | v22.23.0 |
| graph | live `memberry-neo4j` |
| corpus | the 10 committed non-holdout `berry_load` rows, replayed from `provenance.originalInput` as task text |
| holdout | untouched |
| `mined-queries.jsonl` | never opened (gitignored; carries third-party client names) |

**Live graph population at run time:** Fact 29,353 · Episodic 1,696 · Semantic 195 · MemoryBlock 16.

**Conditions that make the run readable, not assumed:**

- `episodicChannel = success:10` — the episodic vector channel ran on **all ten** queries. This is
  the load-bearing check: without it an episodic share of 0 would be indistinguishable from a
  channel that never executed, and the probe fails loudly rather than reporting that ambiguity.
- Embedding provider live; the probe hard-exits rather than run without one.
- Cache bypassed by construction (`cacheResult: false`), so these are **cold-assembly** shares, not
  what a cache-hitting caller receives.

## 3. The numbers

**91 delivered slots across 10 queries.** Denominator is `finalIds`, which is facts + memories.

| source type | share of delivered slots | median confidence |
|---|---|---|
| semantic | **63.7%** (58) | 0.9 |
| episodic | **36.3%** (33) | **1.0** |
| fact | **0.0%** (0 candidates) | n/a |

> **Corrected before publication.** A first run reported 92 slots at 65.2/34.8 with an earlier
> build of the probe that forwarded only `task`, `tags` and `max_tokens` — silently dropping
> `entities` on the two cases that carried it. Since `entities` is what gates the fact fetch
> (`service.ts:408-416`), that run had disabled the fact channel itself. The numbers above are
> from the faithful replay. The fact result did not change, and section 4 explains why.

Confidence histogram over every slot:

| source · confidence | slots |
|---|---|
| episodic · 1.0 | **33** |
| semantic · 0.9 | 40 |
| semantic · 0.3 | 10 |
| semantic · 0.5 | 4 |
| semantic · 1.0 | 4 |

Head-to-head, the four queries where both kinds were delivered:

| case | best episodic rank | best semantic rank | ahead |
|---|---|---|---|
| `eval001-d-11` | 1 | 2 | episode |
| `eval001-d-13` | 1 | 3 | episode |
| `eval001-d-19` | 11 | 1 | semantic |
| `eval001-d-25` | 13 | 1 | semantic |

**MemoryBlocks are UNMEASURABLE here, not zero.** Block ids never enter `finalIds` even though
blocks are rendered into the markdown, so this probe structurally cannot see them. The graph holds
16.

## 4. What the numbers say

**RL-010 is confirmed live.** Every one of the 33 delivered episodic slots carries confidence
exactly **1.0** — the hard-coded literal — against a median of 0.9 for semantics. The mechanism is
real and it is running in production.

**But it is not dominant.** Episodes take about a third of delivered slots, and the head-to-head
splits two-all. Four semantic rows also reached 1.0, so the episode does not sit above the entire
reachable semantic ceiling as previously written — it ties at the top rather than clearing it.

**The fact plane delivered nothing, and the reason is not ranking.** Zero fact candidates across
all ten queries — including the two that supplied `entities` and therefore did reach the fact
fetch. The cause is upstream of every reader: **every fact query in the system filters
`f.status = 'active'`** (`packages/neo4j/src/fact.ts:302` for the served path,
`packages/mcp/src/tools.ts:810` for `berry_grep`), and the live graph holds **152 active facts
against 29,148 tentative** and 53 invalidated.

So 99.5% of the fact corpus is structurally unreachable by anything, and the fact plane's
bottleneck is promotion (RL-011), not indexing. This is the number that should govern any decision
to build fact readers: both `fact_content` and `fact_embedding` would serve a 152-row corpus until
promotion is fixed.

## 5. The pre-registered rule, and its verdict

The rule below was pre-registered in the sprint plan **before** this run:

> FIRES if episodic share of delivered slots ≥ 40% **AND** median delivered episodic confidence
> exceeds median delivered semantic confidence.

**It does NOT fire.** Episodic share is 36.3%, below the 40% threshold. The second conjunct is
satisfied (1.0 > 0.9) and was already flagged as near-vacuous — episodes are injected at a literal
1.0, so it can only fail when zero episodes are delivered.

**The threshold is not being moved after the fact.** A replacement for the vacuous conjunct was
drafted but not written down before the run, so it cannot be applied to this result — choosing a
rule after seeing the number is the exact failure that killed golden v2. Recorded as a process
miss.

Any confidence change that ships from here does so on the **owner's separate direction and the
a-priori argument**, not on this gate. Those are different justifications and the distinction is
the point.

## 6. Two-arm measurement of the RL-010 fix

Both arms run back to back in one session against the same live graph and the same ten queries,
because lifecycle flags are live and the corpus mutates — a comparison against the section-3
origin would not be sound. The only difference between arms is the injected episode confidence in
the built `packages/core/dist/service.js`; the arm was verified by reading that line before each
run, not assumed.

| | arm A — `confidence: 1.0` | arm B — `confidence: 0.5` |
|---|---|---|
| delivered slots | 91 | 91 |
| semantic | 58 (63.7%) | **68 (74.7%)** |
| episodic | 33 (36.3%) | **23 (25.3%)** |
| median episodic confidence | 1.0 | 0.5 |
| queries where an episode outranked a semantic | 2 | **1** |
| `episodicChannel` | success:10 | success:10 |

**Ten delivered slots moved from raw captures to consolidated knowledge**, and the **top-ranked
answer changed on 2 of the 10 queries** — `eval001-d-11` and `eval001-d-29`, both from episodic to
semantic at rank 1. On `eval001-d-13` the best semantic moved from rank 3 to rank 2.

### What this does and does not establish

It establishes that the change is **real and load-bearing**: it moves about 11% of delivered slots
and rewrites the first answer on a fifth of the sample. It is not a no-op.

It does **not** establish that answers got better. This probe counts what KIND of thing occupied
each slot; it has no notion of whether any of it was correct. "More consolidated knowledge, fewer
raw captures" is only an improvement if corroborated knowledge is the better answer — which is the
a-priori argument for the fix, not a result of it.

**Nothing here should be reported as a retrieval-quality gain.** Measuring that needs ground truth
on the memory plane, which does not exist yet. The pre-registered rule in section 5 still did not
fire, and this measurement does not retroactively fire it.

## 7. Live confirmation after deploy and sweep

Both fixes were deployed (`9877414`) and the promotion sweep was run. Re-measured against the
live graph afterwards:

| | arm B prediction | live after deploy |
|---|---|---|
| delivered slots | 91 | 91 |
| semantic | 74.7% | **74.7%** |
| episodic | 25.3% | **25.3%** |
| median episodic confidence | 0.5 | 0.5 |
| queries where an episode outranked a semantic | 1 | 1 |
| `episodicChannel` | success:10 | success:10 |

**The deployed behaviour reproduces the measured arm exactly.** The confidence change is live and
doing what the two-arm run said it would.

### The sweep, and why this probe cannot see it

The sweep promoted the 340 inductive facts that already held two or more distinct source episodes,
mirroring `corroborate()` — status to active, inference type preserved, confidence raised the same
way. Active facts went **152 → 492**, and the number of distinct subjects holding at least one
active fact is now **306**.

Fact delivery in the table above is still 0%, and that is honest rather than a failure. `berry_load`
only fetches facts when the caller supplies `entities` (`service.ts:408-416`); only two of these ten
queries do, and the five entities they name (`OrgMap`, `console-ui`, `memberry`, `memory-core`,
`consolidation-engine`) have **no active facts** even after the sweep. The corpus got three times
larger; this ten-query sample simply does not reach it.

**Sizing the sweep by this probe would be wrong.** It measures `berry_load` occupancy on ten
entity-poor queries, which is the wrong instrument for fact reachability. What the sweep is worth
should be judged on the 306 subjects, not on this table.

### One defect introduced and repaired

The sweep initially wrote `updated_at` as epoch milliseconds while every other Fact in the graph
carries an ISO-8601 string, which would have mis-parsed in recency ranking. Caught immediately and
repaired on exactly the 340 backed-up ids; a full-graph check now returns zero Facts with a
non-string `updated_at`. Original values for all 340 rows are retained in
`/home/cerebro/gate/sweep-backup-20260828.csv`.

## 8. Reproducing

```
cd <worktree> && set -a && . <env-file> && set +a
node bench/eval/memory-occupancy-probe.mjs --dry-run     # audit the corpus first
node bench/eval/memory-occupancy-probe.mjs --out occupancy.json
```

Needs a completed `npm ci && npm run build`. Exits 2 without an embedding provider and 3 if the
workspace packages do not resolve — it will not produce shares for a system that did not run.
