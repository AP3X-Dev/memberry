---
id: p46jUOGVankifm58z8LvB
session_id: session-20260608-ag3ntic-morph
agent_id: mcp
task: T15: Suppress in-runtime pump tool.* for capability calls (shim is sole tool.* producer)
outcome: approved
created_at: "2026-06-09T05:03:33.739Z"
---

T15 COMPLETE. Implemented pump suppression in hermes_adapter.py _pump method. When a tool.started or tool.completed RunEventDTO is about to be enqueued and its payload["title"] is an exact member of session.known_tool_names, the event is skipped (no persist, no enqueue). Native terminal tools (title not in the set) are forwarded unchanged. No dot-splitting. Sequences stay contiguous because the skipped event never reaches _enqueue. Three tests added to test_acp_gateway_interleave.py: suppression of known capability tool, native tool unaffected, sequences gap-free. 386 passed (was 383). Gate PASS. Commit 88cfd07.