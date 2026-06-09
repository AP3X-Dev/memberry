---
id: WOwT131DbUN0aaQTW-4Zq
session_id: session-20260608-ag3ntic-stagef
agent_id: mcp
task: Stage F (Capability Execution Pipeline) — finish T12: defer approval approved→executed finalization to complete_tool_call
outcome: approved
created_at: "2026-06-09T04:09:24.535Z"
---

T12 DONE and committed (a5647b4) on branch morph/opt-hardening. Change: the approved→executed transition + approval.executed emit were moved OUT of intercept_tool_call's standing-grant fast-path (decision time) INTO complete_tool_call's success branch (after the real backing call). The grant fast-path now only carries grant.approval_request_id onto the freshly-minted started ToolCall (tool_call.approval_request_id=granted_approval_id); complete_tool_call's success branch does the status-guarded _guard(approved→executed) + emits approval.executed once. So approval.executed fires only after successful backing execution; a backing failure leaves the approval NOT executed and emits tool.failed.

The one red test was a TEST ARTIFACT, not a code bug: test_tasks.py::test_run_parks_on_approval_then_reissues runs the whole flow in ONE session, so gateway.get_approval returns the identity-mapped ApprovalRequest; complete_tool_call's Core UPDATE (synchronize_session='auto'→'evaluate' on the PK+status WHERE) mutates that in-memory object's .status to 'executed' in place, and the test read mid.status LAZILY at return time → it saw 'executed' not 'approved'. Fix: snapshot mid.status (and finalized.status) into plain locals immediately after each get_approval, matching the sibling test_resume_reissue.py (fresh-session-per-step) and the same file's test_task_transitions ("snapshot each status immediately — identity-mapped object reflects only the latest"). Production deferral is correct and proven by the 2 sibling tests in test_resume_reissue.py. Full suite 374 passed; cleanliness gate PASS at strictest M12.

CONVENTION (gotcha): in single-session async tests, never assert an ORM attribute read at return time if a later Core UPDATE with synchronize_session evaluate/fetch touches that row — snapshot to a plain local immediately, or read each step in a fresh factory() session.

NEXT (Part 1 autonomous, in-process testable; user's order): T0 (record per-run known capability-tool-name set at bring-up) → T11 (gateway_bridge auto-allow known caps, no double-gate) → T16 (acp.session_load(mcp_servers) threading) → T15 (suppress pump tool.* for capability calls) → T20 (verbatim args in resume prompt + reissue_args_mismatch event) → T18 (fetch_page SSRF resolve-DNS setting) → T9 (mount stateless StreamableHTTP shim at /internal/mcp/{ws}/{emp}/{run_id} with HMAC token). Plan: platform/docs/superpowers/plans/2026-06-08-golden-path-F-execution-pipeline.md. HARD STOP at Part 2 (live-probe gate + golden-path smoke on Cerebro — supervised, not CI-autonomous).