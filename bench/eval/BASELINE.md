# EVAL-001 baselines — APPEND ONLY

Spec: `docs/agent-runs/specs/2026-08-26-eval001-real-query-evaluation.md` §6.1 (drift control).

**The origin baseline — the first row below — is NEVER overwritten.** Later runs APPEND
rows; they do not replace. "No difficulty band" means no headroom qualification; it does
NOT mean no absolute anchor. A chain of accepted "did not regress" steps, each measured
only against the one before it, is a moving threshold — ten steps of −0.4% is a 4% decline
that no single comparison flags.

Rules for every entry:

- Every comparison reports drift against BOTH the immediately-prior accepted state AND the
  origin baseline. Two numbers, always, never one.
- A monotonic decline across three or more consecutive accepted runs is FLAGGED, even when
  no single step regressed. That is the boiling-frog case this table exists to catch.
- `flag` is the `MEMBERRY_CANDIDATE_CHANNEL_V1` state the SERVER ran (§5.1). A change in it
  invalidates cross-run comparison until a fresh baseline is taken — record the change and
  start a new anchor row rather than comparing across it.
- Numbers come from the runner's own output lines (`npx tsx bench/eval/run-eval001.ts`),
  pasted, not retyped from memory. Planner-error and skipped questions are excluded from
  the aggregates by the runner and must not be back-filled by hand.
- The origin baseline is re-pinned ONLY on a deliberate re-index (§8 item 4). Re-pinning is
  recorded with its reason and the prior origin is RETAINED, never deleted.

| date | git SHA | flag | split | n | keywordRecall@5 | keywordRecall@10 | noiseRate@5 | noiseRate@10 | note |
|---|---|---|---|---|---|---|---|---|---|
| _(origin baseline row goes here — do not edit it afterwards)_ | | | | | | | | | |
