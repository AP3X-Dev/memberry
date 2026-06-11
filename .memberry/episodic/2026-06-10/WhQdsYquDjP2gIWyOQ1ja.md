---
id: WhQdsYquDjP2gIWyOQ1ja
session_id: session-20260610-pre-launch-impl
agent_id: default
task: Grill-me resolution of remaining open v2 pre-launch decisions
outcome: approved
created_at: "2026-06-10T20:33:42.058Z"
---

Owner grill-me (2026-06-10) resolved the 3 open items after the 5 build-order items shipped:

1. MATCHER FLAG → SPLIT. Don't couple the runtime trade matcher to CIC_SOP_COMPILER_ENABLED (which also runs boot SOP-compilation). Add a dedicated CIC_TRADE_MATCHER_ENABLED (config trade_matcher_enabled); gate ProbingQuestionsLoader.resolve_trades on it; spawn env sets the matcher flag ON, leaves CIC_SOP_COMPILER_ENABLED default-off (boot compilation dormant until artifacts are wanted). On v2-phase1-prelaunch.

2. SLICE B.5 → DROP ENTIRELY. Remove _make_sop_session_sync_callback + the SOPRegistry on_session_start portal hook (try_sync_one at call-start). Reason: it's a background portal round-trip per call-start (the deferred "option B") and its async invalidate can reload the SOP MID-CALL, violating decision #14's never-mid-call rule. Call-start becomes strictly disk-only (the new FilesystemSopSource.reload_client_if_changed) + the 30-min PeriodicSopSync. On v2-phase1-prelaunch.

3. SINGLE-WRITER SPIKE (decision #5) → START NOW, isolated branch off main, SHADOW-EQUIVALENCE FIRST. Grow journal_replay reducer into a commit-path that runs in SHADOW alongside AssistStateStore + SOPRegistry three-lock; prove single-writer state matches lock-based state event-for-event (zero divergence) across property/determinism suites + CIC Harness BEFORE deleting any locks. Flag-gated, locks untouched in the spike. Direction signal = zero divergence; merge still gated on the soft-launch baseline ("metrics no worse"). Claude drives it.

KEY INSIGHT that flipped B.5: the _on_session_start callback runs on a background daemon thread (non-blocking) but its invalidate fires after the portal responds = mid-call → breaks never-mid-call.