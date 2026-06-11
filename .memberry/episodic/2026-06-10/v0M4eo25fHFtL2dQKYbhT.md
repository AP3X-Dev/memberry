---
id: v0M4eo25fHFtL2dQKYbhT
session_id: session-20260610-pre-launch-impl
agent_id: default
task: Implement v2 pre-launch build order on v2-phase1-prelaunch (commit-only)
outcome: approved
created_at: "2026-06-10T20:12:03.466Z"
---

DONE — all 5 code items of the pre-launch build order implemented on v2-phase1-prelaunch, TDD, ruff+mypy+full-pytest green per commit, nothing pushed. 6 commits (db9e95f doc + 5 items), final suite 2528 passed/1 skipped.

- 853aa27 #1 Journal ON: spawn env CIC_JOURNAL_ENABLED=1 + CIC_JOURNAL_RETENTION_DAYS=7 (guarded, explicit env wins); engine retention default 30→7.
- 4a014df #2 Trade matcher: src/engine/skills/trade_matcher.py resolve_trade() (exact→normalized→alias{electric:electrical}→unambiguous-fuzzy@0.86→unmatched), shared by sop_compiler.evaluate_sop + ProbingQuestionsLoader.for_classification (resolves missed exact key when resolve_trades on; unresolvable trade flagged once, full-SOP fallback). Gated on CIC_SOP_COMPILER_ENABLED, ACTIVATED in spawn env.
- 8cdeeef #3 Submit-gate: drain_timeout_max 75→30s; main.js maybeNotifySubmitGate fires facts-only OS notification at the ceiling ("Finalization didn't complete — review the form before submitting") and on review findings (gap_fills/discrepancies); clean form silent.
- 045bb5f #4 Hang recovery: python-backend.js requestAgentRestart() (kill WITHOUT _intentionalStop → crash-respawn path runs I-27 resync, preserves form); tray "Restart Assistant"; new POST /sessions/{id}/snapshot (SessionManager.snapshot_session → write_archive) called best-effort before kill.
- bf7e79f #5 SOP sync: PeriodicSopSync default 3600→1800s; FilesystemSopSource.reload_client_if_changed() disk-only version check (invalidate on change, demote-and-flag/keep-cache on malformed); SOPRegistry.start_session calls it (duck-typed).

OPEN for owner (flagged in summary): (a) #11 matcher couples to CIC_SOP_COMPILER_ENABLED which I turned ON in spawn env — also enables boot SOP-compilation (observability-only); confirm OK. (b) #14 chose option A (disk-only at call-start) but the Slice B.5 _on_session_start PORTAL check (try_sync_one) is still wired = the deferred option B; left in place (removing = confirm-first); ask if they want it disabled so call-start is strictly disk-only. (c) #6 send docs/portal-handoff-requests-2026-06-09.md = external human action, not done. (d) single-writer spike branch (decision #5) = separate follow-up, not started.