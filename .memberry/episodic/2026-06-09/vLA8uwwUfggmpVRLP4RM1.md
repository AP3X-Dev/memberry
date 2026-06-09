---
id: vLA8uwwUfggmpVRLP4RM1
session_id: session-20260608-ag3ntic-morph
agent_id: mcp
task: [project:ag3ntic] Pillar 5 verification: adapter mcp_servers wiring, complete_tool_call, run_event sequencing, sec-22 event names
created_at: "2026-06-09T01:24:09.816Z"
---

[project:ag3ntic] Pillar 5 (Stage F adapter wiring + tool_call completion + event taxonomy) verified at HEAD 8bcacd6, branch morph/opt-hardening.

1. acp.AcpClient.session_load(self, session_id) DOES NOT accept mcp_servers (acp.py:441-443). Only session_new does (acp.py:428-439). Threading mcp_servers to BOTH new + load(resume) requires extending session_load's signature.
2. CTX CORRECTION: design says completion status="executed|failed". WRONG. ToolCall.status enum (models.py:621-623) = intercepted|started|completed|denied|failed|awaiting_approval. Success terminal is "completed" (matches sec-22 tool.completed). "executed" (service.py:334) is the APPROVAL status, not tool_call. complete_tool_call sets status="completed"/"failed".
3. sec-22 confirms tool.completed (line142) + tool.failed (line144), NOT tool.succeeded.
4. append_run_event (runlog.py:22-62) atomic row-locked. test_acp_gateway_interleave proves pump+gateway concurrent separate-session writes stay unique+contiguous. complete_tool_call (shim separate process) MUST use append_run_event not the adapter in-process _enqueue.
5. Plumb: add optional mcp_servers (default None) to _ensure_session; chat() (line544) passes None; start_run builds shim entry. Backward compatible.
6. Item4 out-of-scope confirmed: launch_capability only mcp_stdio/computer; crm_mock/web_research in-process, no RuntimeInstance.</content>
<parameter name="tags">["project:ag3ntic", "permission-gateway", "capabilities", "morph", "backend"]