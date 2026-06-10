---
id: GjRLU3uO0Yzu45nrrSmLS
session_id: session-20260609-ag3ntic-morph
agent_id: default
task: Implement Stage F Part 2 Phase A (per-employee shim redesign) + adversarial review remediation
outcome: approved
created_at: "2026-06-09T11:51:41.453Z"
---

DONE this session (committed dfeee30 on morph/opt-hardening, never pushed): the deterministic, R1-independent half of the per-employee shim redesign + its review hardening. Full suite 425 green, ruff clean, cleanliness gate M12 PASS.

WHAT SHIPPED:
- T13 token (auth/security.py): sign_employee_shim_token(ws, emp) — run_id dropped; verify returns {workspace_id, employee_id}. Long-lived.
- T9 shim (capabilities/shim_transport.py): mount /internal/mcp/{ws}/{emp}; _verify_identity asserts (ws,emp)==path; _call_tool resolves the active run server-side then passes run_id to execute_tool (execute_tool keeps its explicit-run_id contract — unchanged).
- resolve_active_run (capabilities/shim.py): single running|waiting_approval run for (ws,emp), deleted_at IS NULL, LIMIT 2; fail-closed (None) on 0 or >1.
- Config (config.py): shim_external_base_url ("" default; orchestrator falls back to api_base_url) + shim_token_ttl_seconds (bounded 300..31536000, default 30d).
- R5 cleanup: removed dead mcp_servers param from acp.session_new/session_load + hermes_adapter._ensure_session, and the per-run shim_entry block from start_run.
- One active run per employee ENFORCED at run creation: tasks/runs.start_run now raises conflict(code="run_already_active") (409) if the employee already has a non-terminal run. This makes the resolver's >1 fail-closed branch a backstop, not the primary guard. NOTE: app-level guard only (no DB partial-unique index) so the resolver's ambiguity tests can still seed >1 via raw ORM; a concurrent-POST race is caught fail-closed by the resolver.

ADVERSARIAL REVIEW (15-agent workflow): 11 raised, 5 confirmed (1 medium=the unenforced-invariant above, 4 low=2 stale main.py comments fixed + 2 test-gap fixes: resolve_active_run deleted_at coverage + token expiry-boundary), 6 refuted (notably: the resolve→execute race is NOT new — old per-run code had the same window with a staler run_id; non-numeric exp TypeError is unreachable behind the HMAC check).

NEXT (needs Cerebro, the cerebro skill): Phase B = R1 config-reload probe + R4 manual inject on hermes-demo to learn the EXACT Hermes mcp_servers config.yaml shape (+ whether token sits inline vs $HERMES_HOME/.env, + reload-at-process-start vs per-exec). Then Phase C = orchestrator launch-time config injection in provision_employee using docker_client.exec_output (printf > $HERMES_HOME/config.yaml — EXEC is allowed; container is read_only except the rw HERMES_HOME volume; no put_archive exists). Then Phase D = E2E-GOLD-01 + deploy (fix deploy_cerebro_release.py: --env-file .env, health-gate mapped 8096, path ~/projects/ag3ntic-morph).