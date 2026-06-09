---
id: A4cIqgG3b-v694EGJtmqw
session_id: session-20260608-ag3ntic-T11
agent_id: mcp
task: T11: gateway_bridge auto-allow known capability tools (no double-gate)
outcome: approved
created_at: "2026-06-09T04:34:21.071Z"
---

Implemented T11 on branch morph/opt-hardening. HEAD 2e30f95 (base be5fce2).

DESIGN: decide() now resolves the per-run capability-tool known-set (resolve_employee_tool_names) in a short session before routing. Exact-name membership in the set → auto-allow (return allow_once option id, no intercept_tool_call). Anything not in the set falls through to the existing native shell gate unchanged.

SECURITY BOUNDARY: Classification is by EXACT-NAME membership ONLY. Dot-splitting tool_name is never used. A native terminal title like 'bash.exec' that contains a dot but is not a real bound capability tool does NOT match the known-set and goes to the shell gate (fail-closed by default).

FILES: apps/api/platform_core/runtime_adapter/gateway_bridge.py (modified), tests/test_gateway_bridge.py (new, 3 tests).

TESTS: 3 new tests (test_native_terminal_title_with_dot_is_not_auto_allowed, test_known_capability_tool_is_auto_allowed_no_second_tool_call, test_unrecognized_tool_name_goes_to_shell_gate). Confirmed failing before implementation (T11-2 AssertionError: found 1 ToolCall). All 3 green after. Full suite: 378 passed. Cleanliness gate: PASS.