---
id: ZbEf_eeqZpraFHLIVTePR
session_id: session-20260608-ag3ntic-t16
agent_id: mcp
task: T16: Extend acp.session_load with mcp_servers param, thread through _ensure_session and start_run in hermes_adapter
outcome: approved
created_at: "2026-06-09T04:54:43.603Z"
---

T16 DONE. Commit 9239474 on morph/opt-hardening.

Changes:
1. acp.py session_load(session_id, *, mcp_servers=None) — sends {"sessionId": ..., "mcpServers": mcp_servers or []} mirroring session_new's mcpServers field.
2. hermes_adapter.py _ensure_session gains mcp_servers=None kw-arg; passed to client.session_load(session_key, mcp_servers=mcp_servers) in load branch and client.session_new(mcp_servers=mcp_servers) in both new branches.
3. start_run builds shim_entry = {"type": "http", "url": settings.agent_runner_callback_base_url + /internal/mcp/{ws}/{emp}/{run_id}, "headers": {"Authorization": f"Bearer {shim_token}"}} using sign_employee_shim_token(workspace_id, employee_id, run_id) from platform_core.auth.security. Passes mcp_servers=[shim_entry] to _ensure_session. Both imports are lazy (inside start_run) to stay consistent with the file's lazy-import pattern.
4. chat() calls _ensure_session with no mcp_servers (defaults to []).
5. NOTE: wire-shape (type/url/headers) flagged validate-live (Part 2 live-probe gate #2/#3).

Tests: 4 new T16 tests in test_hermes_adapter.py, all green. Full suite: 383 passed. Gate: PASS.
URL setting used: settings.agent_runner_callback_base_url (already the internal API origin for runner callbacks, e.g. http://api:8000).