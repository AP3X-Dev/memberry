---
id: Kh2awVWkW0Y3C1be1qLaf
session_id: session-20260611-ux-loop
agent_id: default
task: Record the inline-executor finding that unblocked auto-start-on-message
created_at: "2026-06-11T16:38:10.353Z"
---

A chat turn in AG3NTIC executes a run INLINE via `_default_executor` when the employee has no healthy RuntimeInstance — no manual Launch / provisioned runtime required. Path: `chat/service.py:412` send_message → start_run; `tasks/runs.py:250-257` enqueues to the ACP worker only when run_worker_enabled AND acp_eligible, else runs inline via `_get_executor()`; `tasks/runs.py:704-724` hermes_run_executor falls back to `_default_executor` when runtime is None / no container. The only real gates on a turn are ensure_no_active_run (409) and the S17 budget check (403). Consequence (UX): the manual "Launch" button is OPTIONAL pre-provisioning, not a prerequisite — so the ag3ntic-ux-optimizer loop (cycle 2, commit 4cf81a3) reframed it web-only: first message shows a "starting…" cue and Launch was demoted to a power-user affordance. This resolved Blocked row B1 with no apps/api changes.