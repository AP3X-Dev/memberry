---
id: Gc-aBBGGOOQ9-gMoztXIU
session_id: session-20260608-ag3ntic-morph
agent_id: mcp
task: opt session 4: DockerAcpTransport.close() never joins the daemon reader thread (resource-cleanup hardening)
outcome: approved
created_at: "2026-06-08T10:15:53.664Z"
---

Hardening item #4 fixed on branch morph/opt-hardening (commit 43c6534). Root cause: DockerAcpTransport.close() invoked the injected socket-close callable (which unblocks the reader thread's parked recv) but never joined the daemon reader thread. The thread would eventually run its finally and exit, but close() returned before that, so each ACP run leaked a live Thread-N (_read_loop) daemon. Fix: after calling self._close(), close() now joins self._thread with a bounded _READER_JOIN_TIMEOUT=5.0s, run off the event loop via asyncio.to_thread (codebase idiom: blocking work wrapped in asyncio.to_thread, per docker_client.py) so the join never blocks the loop; logs a warning if a wedged socket doesn't unwind in time. Safe because _emit_line already swallows RuntimeError when the loop is gone, so a scheduled call_soon_threadsafe callback can't deadlock the join. Callers run_worker.execute_acp_run (finally: await adapter.close()) and capabilities/mcp_client need no change. TDD gotcha worth remembering: the naive test (FakeSock recv returns b'' immediately) is a FALSE NEGATIVE — the thread exits so fast the is_alive() check passes even without the join. Needed a _SlowUnwindSock whose recv blocks until close() then sleeps 0.2s before EOF to open a deterministic race window proving the join. Suite 222 -> 223 passed; cleanliness gate PASS. Next TODO: item #5 (execute_acp_run finally swallows adapter.close() exceptions).