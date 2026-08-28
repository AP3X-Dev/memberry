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

**92 delivered slots across 10 queries.** Denominator is `finalIds`, which is facts + memories.

| source type | share of delivered slots | median confidence |
|---|---|---|
| semantic | **65.2%** (60) | 0.9 |
| episodic | **34.8%** (32) | **1.0** |
| fact | **0.0%** (0) | n/a |

Confidence histogram over every slot:

| source · confidence | slots |
|---|---|
| episodic · 1.0 | **32** |
| semantic · 0.9 | 41 |
| semantic · 0.3 | 10 |
| semantic · 0.5 | 5 |
| semantic · 1.0 | 4 |

Head-to-head, the four queries where both kinds were delivered:

| case | best episodic rank | best semantic rank | ahead |
|---|---|---|---|
| `eval001-d-11` | 1 | 2 | episode |
| `eval001-d-13` | 1 | 3 | episode |
| `eval001-d-19` | 13 | 1 | semantic |
| `eval001-d-25` | 13 | 1 | semantic |

**MemoryBlocks are UNMEASURABLE here, not zero.** Block ids never enter `finalIds` even though
blocks are rendered into the markdown, so this probe structurally cannot see them. The graph holds
16.

## 4. What the numbers say

**RL-010 is confirmed live.** Every one of the 32 delivered episodic slots carries confidence
exactly **1.0** — the hard-coded literal — against a median of 0.9 for semantics. The mechanism is
real and it is running in production.

**But it is not dominant.** Episodes take about a third of delivered slots, and the head-to-head
splits two-all. Four semantic rows also reached 1.0, so the episode does not sit above the entire
reachable semantic ceiling as previously written — it ties at the top rather than clearing it.

**The fact plane delivered nothing.** Zero fact candidates and zero fact slots across all ten
queries, against 29,353 Fact nodes in the graph. This probe cannot say why — `berry_load`'s fact
path is an entity-id lookup and these queries are task text — but "the fact channel contributes
nothing to a berry_load answer" is now measured rather than assumed.

## 5. The pre-registered rule, and its verdict

The rule below was pre-registered in the sprint plan **before** this run:

> FIRES if episodic share of delivered slots ≥ 40% **AND** median delivered episodic confidence
> exceeds median delivered semantic confidence.

**It does NOT fire.** Episodic share is 34.8%, below the 40% threshold. The second conjunct is
satisfied (1.0 > 0.9) and was already flagged as near-vacuous — episodes are injected at a literal
1.0, so it can only fail when zero episodes are delivered.

**The threshold is not being moved after the fact.** A replacement for the vacuous conjunct was
drafted but not written down before the run, so it cannot be applied to this result — choosing a
rule after seeing the number is the exact failure that killed golden v2. Recorded as a process
miss.

Any confidence change that ships from here does so on the **owner's separate direction and the
a-priori argument**, not on this gate. Those are different justifications and the distinction is
the point.

## 6. Reproducing

```
cd <worktree> && set -a && . <env-file> && set +a
node bench/eval/memory-occupancy-probe.mjs --dry-run     # audit the corpus first
node bench/eval/memory-occupancy-probe.mjs --out occupancy.json
```

Needs a completed `npm ci && npm run build`. Exits 2 without an embedding provider and 3 if the
workspace packages do not resolve — it will not produce shares for a system that did not run.
