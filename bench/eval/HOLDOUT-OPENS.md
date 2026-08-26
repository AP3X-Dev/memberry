# EVAL-001 holdout opens — APPEND ONLY

Spec: `docs/agent-runs/specs/2026-08-26-eval001-real-query-evaluation.md` §3.2.1
(holdout custody).

The holdout exists to stop the system being tuned to the question set. An unlogged reopen
is exactly the overfitting this split prevents, so every open gets one row here.

Rules:

- **Aggregate only.** Record the closed aggregate — never a per-question result, never a
  missing-keyword list. The runner enforces this: per-question lines print for `dev` only.
- **Append only.** Entries are never edited, reordered, or deleted.
- **Rate rule.** The holdout may not be reopened until the previous open's result has been
  ACTED ON — merged, or explicitly reverted and recorded as such in `outcome`. Back-to-back
  opens against successive tweaks of the same unmerged change are the prohibited loop.
- Confirm on the holdout only when a change is BELIEVED COMPLETE (§7 step 4). It confirms a
  change; it does not steer one.

| date | git SHA | flag | change tested | n | keywordRecall@5 | keywordRecall@10 | noiseRate@5 | noiseRate@10 | outcome (merged / reverted) |
|---|---|---|---|---|---|---|---|---|---|
| _(first open goes here)_ | | | | | | | | | |
