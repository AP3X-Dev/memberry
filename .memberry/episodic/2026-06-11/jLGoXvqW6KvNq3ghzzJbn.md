---
id: jLGoXvqW6KvNq3ghzzJbn
session_id: session-20260611-093000
agent_id: default
task: Hardening loop cycle 2: bound drain Phase-3 to the remaining budget (OPT-2)
outcome: approved
created_at: "2026-06-11T10:40:46.432Z"
---

Cycle 2 (1319345): DrainCoordinator Phase-3 steps now receive the phase deadline — the pipeline sweep waits min(30s, remaining budget) with best-effort future.cancel/asyncio.wait_for, the notes retry never starts past the deadline, and the per-Job form-review loop re-checks the deadline before each Job and flags cuts via mark_form_review_skipped. Key insight: the GET /form-review route lets a stored partial result win over the skipped sentinel, so partial multi-job reviews keep their applied corrections — flagging a mid-loop cut is contract-safe. Root cause discovered (now OPT-13): _default_openai_client in llm_runners.py builds OpenAI(api_key=...) with NO timeout — SDK default 600s × 2 retries — so a hung drain-agent HTTP call can pin the daemon drain thread for many minutes; orchestration-level deadline checks only gate BETWEEN blocking calls, never inside one. The real bound for the drain-hang class is a client-level timeout (≈ drain_timeout_max, retries=0) on drain runners.