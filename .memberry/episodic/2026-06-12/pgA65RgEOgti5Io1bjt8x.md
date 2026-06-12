---
id: pgA65RgEOgti5Io1bjt8x
session_id: session-20260611-ag3ntic-morph
agent_id: default
task: Second 'active run' report — corrected diagnosis + deploy discipline
created_at: "2026-06-12T06:00:41.635Z"
---

CORRECTED DIAGNOSIS of the user's second "already has an active run (run_7fdd4bdf)" report: the run did NOT strand — it SUCCEEDED 44s after start. The 409s were the user double-sending while the turn was still running (the one-run-per-employee rule working as designed, but with a nonsense error envelope). Their screenshot predated completion.

REAL issues found + fixed (commit abedc10, deployed): (1) the active-run 409 came from errors.conflict(), which maps ALL 409s to CapabilityUnavailable → its default suggested_action "Enable the required capability…" misled the user; the run_already_active raise now passes an accurate suggested_action ("employee is still working — wait or stop the active run"). (2) STALE_RUN_MINUTES=5 set on the deploy .env for fast zombie recovery.

BEHAVIORAL FINDING: that succeeded run used ZERO tool calls — the model answered "search the web for Denver plumbers" from memory because its REUSED ACP session had watched tools fail all evening (sidecar outage) and gave up on them. Session poisoning: after a tool-outage window, employees need a FRESH conversation (new ACP session) to re-engage tools. Advised the user to start a new chat.

DEPLOY DISCIPLINE (self-inflicted lesson): force-recreating api/worker KILLS in-flight runs (the ACP driver is in-process) — I stranded the user's earlier run this way. New rule, now practiced: before any api/worker recreate on the deploy host, check `SELECT count(*) FROM runs WHERE status IN ('queued','running','waiting_approval','cancelling')` and skip/wait if nonzero.