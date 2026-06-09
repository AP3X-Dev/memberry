---
id: YanMiC9JGkqdKeNavEj8J
session_id: session-20260608-ag3ntic-morph
agent_id: mcp
task: opt hardening D1 (partial): evict chat() ACP session on prompt-stream error
created_at: "2026-06-08T13:19:52.822Z"
---

Fixed the error-path subset of discovery D1 in HermesRuntimeAdapter (apps/api/platform_core/runtime_adapter/hermes_adapter.py). chat() is session-keyed and intentionally reused across turns, but a turn whose session/prompt raised AcpProtocolError left the now-dead _Session/AcpClient (and its live daemon reader thread) registered in self._sessions — so the next chat turn for the same key reused a broken client and the reader thread leaked until adapter close() (same leak class as item #6's terminal-event eviction). Fix: in chat()'s `except acp.AcpProtocolError` branch, call `await self._evict_session(session)` (the item-#6 best-effort helper: cancel pump + await client.close() + drop from _sessions) BEFORE re-raising HermesError(hermes_acp_chat_failed). This is the obviously-correct evict-on-error subset; the broader healthy-reuse eviction policy (TTL vs explicit end_chat for a still-good reused session — no terminal _DONE signal) is still an open design decision and remains a backlog candidate.

Convention reinforced: every adapter session brought up by _ensure_session must be reclaimed on its terminal/error path; on the cross-turn-reused chat() path the error branch is responsible for eviction (start_run/stream_run_events handle it via stream_run_events' finally + execute_acp_run's finally adapter.close()). TDD via tests/test_hermes_chat_evict.py with a new FailingPromptTransport fake peer that answers session/prompt with a JSON-RPC error frame. Suite 266 -> 268 passed; cleanliness gate PASS. Commit 455ac6e on morph/opt-hardening. Staged only the touched files (not git add -A) so untracked packages/mcp-server stays out of the commit, per established convention.