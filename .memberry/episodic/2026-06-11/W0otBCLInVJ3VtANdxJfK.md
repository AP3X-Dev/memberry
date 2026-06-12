---
id: W0otBCLInVJ3VtANdxJfK
session_id: session-20260611-ux-eou1
agent_id: default
task: EOU-1 auto-start employee on first message — investigate inline executor vs control plane, implement web-only reframe
outcome: approved
created_at: "2026-06-11T16:34:23.023Z"
---

AG3NTIC chat does NOT require launching an employee before a run executes. Root cause / architecture fact (Branch A, confirmed read-only): the chat send-message path has no employee-status or launch gate. `POST .../sessions/{sid}/messages` (apps/api/platform_core/chat/router.py:154) → chat service `send_message` (chat/service.py:412) → `runs_service.start_run`. `_load_employee` (tasks/service.py:36-39) only 404s a missing employee row. `start_run` (tasks/runs.py:250-257) enqueues to the ACP worker ONLY when `settings.run_worker_enabled AND acp_eligible(run)` (a healthy RuntimeInstance with a container); otherwise it runs inline via `_get_executor()` → registered `hermes_run_executor`, which itself falls back to the offline deterministic `_default_executor` when the employee has no healthy Hermes runtime (tasks/runs.py:704-724). So the only real gates on a chat turn are `ensure_no_active_run` (one active run per employee, 409) and the S17 budget check (403 budget_exceeded). The manual "Launch" button only pre-provisions a live ACP runtime — it is an optimization/power-user affordance, not a prerequisite for chatting. UX implication: forcing a manual Launch before chat was a confusing gate; the correct fix is web-only reframe (surface a transient "starting…" cue on the first turn to a non-running employee, reframe copy to "starts automatically on your first message", demote Launch to a secondary/ghost affordance). This resolved Blocked row B1 in the ux-optimizer loop.