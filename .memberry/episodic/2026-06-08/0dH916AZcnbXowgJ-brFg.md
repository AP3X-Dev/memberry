---
id: 0dH916AZcnbXowgJ-brFg
session_id: session-20260608-ag3ntic-opt
agent_id: mcp
task: [project:ag3ntic] opt(resource-cleanup): HermesRuntimeAdapter.close() best-effort per session (Discovery D4)
outcome: approved
created_at: "2026-06-08T18:27:39.468Z"
---

[project:ag3ntic] Hardening discovery D4 (commit 9365e93, branch morph/opt-hardening). HermesRuntimeAdapter.close() awaited session.client.close() RAW inside its teardown loop over self._sessions — so the first session whose close raised (wedged docker-exec socket / DockerAcpTransport reader-join re-raise) aborted the loop, leaked every later session's ACP client + reader thread, and skipped the trailing self._sessions.clear() (stale entries on a reused adapter). It also lacked the None-client guard, so a session registered before bring-up finished (client=None) AttributeError'd. Fix: the loop now delegates each session to the existing idempotent, None-guarded, exception-swallowing _evict_session helper (the same one used by item #6's terminal-event eviction and D1's chat error path). CONVENTION REINFORCED: in this codebase every multi-resource teardown loop must be best-effort — a wedged/throwing close must log+swallow and never abort cleanup of the remaining resources nor skip the registry clear (established by items #5 execute_acp_run close, #6 _evict_session, D1 chat error path; foundation: cleanup never masks/aborts). The remaining D1 healthy-reuse chat eviction policy (TTL vs explicit end_chat vs evict-per-turn) stays a DEFERRED design decision — multiple valid mutually-exclusive designs over intentional cross-turn session reuse, not an obviously-correct one-liner, so not picked unilaterally. Suite 284 -> 287 (new tests/test_hermes_adapter_close.py, 3 tests); cleanliness gate PASS.