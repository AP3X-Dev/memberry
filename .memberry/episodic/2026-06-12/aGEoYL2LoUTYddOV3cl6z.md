---
id: aGEoYL2LoUTYddOV3cl6z
session_id: session-20260611-ag3ntic-morph
agent_id: default
task: Stranded-run blocker: cleared live + class fix (stale_run_sweep)
created_at: "2026-06-12T05:48:23.407Z"
---

USER BLOCKED: "Employee already has an active run (run_ecd70002…); one active run per employee" on every chat turn. Root cause: the run started during the sidecar outage at 04:55, then its driver died (api force-recreates kill the in-process ACP adapter; I also paused the employee container mid-run during PTY testing) — the row stayed status='running' forever and the one-active-run-per-employee guard blocked all new turns. NO sweep existed for this class (worker swept approvals/budgets/sidecars/runtimes but not dead-driver runs).

FIX: (1) immediate — cancelled the stuck run via tasks.runs.stop_run (module path is platform_core.tasks.runs, NOT platform_core.runs). (2) class — added stale_run_sweep to the worker sweep_once: queued/running/cancelling runs with updated_at older than settings.stale_run_minutes (default 30; every run event bumps updated_at via the sequence allocator, so it is an accurate activity signal) are cancelled through the legal stop path (stop_run for queued/running; direct cancelling→cancelled completion for stuck-cancelling); waiting_approval is EXEMPT (parked runs legitimately wait on humans — the approval-expiry sweep owns those). Commit d812393, deployed (api+worker force-recreated), suite-area regression 202 green, test tests/test_stale_run_sweep.py.

Verified post-deploy: zero active runs for the employee, employee running, both sidecars up — user unblocked. NOTE the misleading error envelope: the 409 for 'already has an active run' surfaces with suggested_action 'Enable the required capability…' (a CapabilityUnavailable-ish mapping) — cosmetic error-envelope mismatch, candidate cleanup.