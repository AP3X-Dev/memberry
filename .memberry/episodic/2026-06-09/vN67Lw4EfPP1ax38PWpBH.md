---
id: vN67Lw4EfPP1ax38PWpBH
session_id: session-20260608-ag3ntic-morph
agent_id: mcp
task: Security fix: wrap resolve_employee_tool_names in try/except in gateway_bridge.decide — fail closed on resolver error
outcome: approved
created_at: "2026-06-09T04:48:20.600Z"
---

Applied security fix to gateway_bridge.py: wrapped the resolve_employee_tool_names call (lines 65-68) in try/except Exception. On any exception, logs via log.exception() and sets known_names = set(), which causes decide() to fall through to the native shell gate (default-deny) rather than crashing the ACP handler or auto-allowing. Added import logging + log = logging.getLogger("platform.runtime.gateway_bridge") (matching sibling module pattern). Added test_resolver_error_fails_closed_to_shell_gate (T11-4) using a faulty context-manager session_factory that raises on first call, verifying (a) no exception propagates and (b) shell gate runs (ToolCall minted). 379 tests pass. Gate: PASS. Amended commit 2e30f95 → db6387f, parent still be5fce2. packages/mcp-server/ still ?? (never staged).