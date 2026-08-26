# EVAL-001 — baseline record

**Append-only. The ORIGIN baseline is never overwritten** (spec §6.1). Later runs are
appended; every comparison reports drift against BOTH the immediately-prior accepted run
AND the origin. A monotonic decline across three or more accepted runs is flagged even
when no single step regressed.

Re-pinning the origin is permitted ONLY on a deliberate re-index, recorded with its
reason, and the prior origin is retained rather than deleted.

---

## ORIGIN — 2026-08-26

| field | value |
|---|---|
| git SHA | `6c78804` (branch `feat/eval001-real-query-eval`, off master `a1439fb`) |
| MCP endpoint | `http://192.168.0.25:3101/mcp` (live) |
| candidate-channel flag | `1` — **declared, not verified** (see Caveat 2) |
| questions | 3 dev, 1 holdout, 1 blocked |

| split | keywordRecall@5 | keywordRecall@10 | noiseRate@5 | noiseRate@10 |
|---|---|---|---|---|
| dev (n=3) | **0.5000** | **0.5000** | **0.4667** | **0.6000** |
| holdout (n=1) | **0.0000** | **0.0000** | **1.0000** | **1.0000** |

### THE HEADLINE NUMBER IS MISLEADING — read the disaggregation

`keywordRecall = 0.5` conflates three different failure modes. Each miss was checked
against the live index to find out WHY, and only one is a ranking failure:

| question | recall@5 | actual cause |
|---|---|---|
| `d-01` assembler / code plane | 1.0000 | **success** |
| `d-02` admission tier routing | 0.0000 | **NOT INDEXED** — `admission-routing.ts` has **0** symbols in the index |
| `d-03` feedback tracking | 0.5000 | **genuine ranking failure** — `FeedbackTracker` IS indexed as a `class` and was not retrieved |
| `h-01` code-plane eligibility | 0.0000 | **NOT INDEXED** — `codeEligible` shipped 2026-08-26 and is absent |

**Only one of four is a ranking failure. Two are index coverage.**

### The finding this run actually produced

**The index is incomplete and of unknown vintage.**

- `admission-routing.ts` — merged in MEM-003, days old — has **zero** indexed symbols,
  while its own package (`core`) has 2,120. This is not "core is unindexed"; it is a
  per-file gap.
- `codeEligible`, merged and deployed today, is absent.
- **`indexed_at` is NULL on every symbol.** There is no freshness timestamp anywhere, so
  the age of the index is not merely stale — it is *unknowable*. This is the gap
  roadmap item **OPS-009** (deployed-version / project-index inventory readiness) names.

Consequence for the program's direction: retrieval quality work has been aimed at
ranking, and ranking cannot surface what was never indexed. Index coverage and freshness
may dominate ranking as a cause of poor answers. That reorders the lanes.

### What is NOT in doubt

`noiseRate` is unaffected by coverage — it measures what came back, not what was missing.
**46.67% of top-5 and 60.00% of top-10 results are test-file or bare-variable noise.**
That confirms at measurement scale what a single live query suggested (six copies of
`session: () => session` in twenty slots) and matches the index composition: 74% of
indexed `project:memberry` symbols are `variable`, 34% come from test files.

### Caveats — this baseline is a SHAPE, not a verdict

1. **n=4 scored questions.** The spec calls for 15-25. This is enough to validate the
   machinery and to surface a coverage defect that large; it is **not** enough to
   conclude anything about retrieval quality, and no delta computed against it should be
   treated as significant.
2. **Flag state is declared, not verified.** `/readyz` does not disclose
   `MEMBERRY_CANDIDATE_CHANNEL_V1`, so the runner records an asserted value. Verifying it
   requires the server to expose it.
3. **`gitSha=unknown` in the run output.** Git refused to read the SHA inside the
   container (`detected dubious ownership in repository at '/w'`). The SHA above is from
   the clone, recorded by hand. **The runner must set `safe.directory` before the next
   run** or the automatic record is not trustworthy.
4. **Holdout n=1.** A single question is a smoke test, not a held-out measurement.
