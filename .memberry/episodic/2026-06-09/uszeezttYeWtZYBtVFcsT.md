---
id: uszeezttYeWtZYBtVFcsT
session_id: session-20260608-ag3ntic-morph
agent_id: mcp
task: T0: Record per-run known capability-tool-name set at session bring-up
outcome: approved
created_at: "2026-06-09T04:20:21.213Z"
---

Task T0 complete. BASE_SHA=a5647b4cc79087701d7cba36c30ee6569124c41c, HEAD_SHA=be5fce2.

Implementation: resolve_employee_tool_names was already present in shim.py (thin set wrapper over resolve_employee_tools). Added known_tool_names: set[str] = set() field to _Session.__init__. Added _resolve_known_tool_names helper to HermesRuntimeAdapter that uses injected session_factory (preferred) or SqlAlchemyRunStore._sf (fallback) — returns empty set with best-effort exception handling when no factory is reachable. Added session_factory param to HermesRuntimeAdapter.__init__. In start_run, after session.run_id/sequence set, calls _resolve_known_tool_names and assigns to session.known_tool_names. run_worker.py passes session_factory=session_factory to the adapter constructor. Test test_start_run_records_known_tool_names seeds employee bound to crm_mock+web_research, calls start_run, checks known set. 375 passed, GATE: PASS.