---
id: -szz3RBn-SeVISArlb9LI
session_id: session-20260608-ag3ntic-morph
agent_id: mcp
task: opt session 14: AcpClient._read_loop silently drops non-JSON protocol lines (runtime_adapter/acp.py)
outcome: approved
created_at: "2026-06-08T12:12:25.900Z"
---

Item #14 (error-handling, DONE, commit a6b27dc on morph/opt-hardening). AcpClient._read_loop (apps/api/platform_core/runtime_adapter/acp.py) now SURFACES corruption on the ACP protocol channel instead of swallowing/crashing. stdout carries only newline-delimited JSON-RPC 2.0 objects (logs go to stderr per docs/hermes-contract-findings.md). Two defects of the same class fixed: (1) a JSONDecodeError was `continue`-d with NO log — corruption vanished silently; (2) a valid-JSON-but-non-object frame (42, "hi", [...]) sailed past json.loads into _dispatch, where `"id" in message` raises TypeError, caught by the loop's broad except Exception -> _fail_all, so ONE junk frame tore down the entire read loop and failed every in-flight request. Fix: added module logger `platform.runtime.acp` (mirrors sibling `platform.runtime.acp_transport`); JSONDecodeError logs a truncated warning (_LOG_LINE_CAP=512) + skips; a decoded non-dict logs + skips BEFORE _dispatch. Loop stays alive and dispatches the next well-formed frame. TDD: tests/test_acp_read_loop.py (raw-byte reader drives _read_loop directly). Suite 242 -> 244 passed; cleanliness gate PASS. CONVENTION confirmed: validate ACP wire shapes at the edge and surface (don't swallow) protocol-channel corruption; a single malformed frame must never tear down the read loop. Committed only the 3 touched files (acp.py, the test, the optimizer log) — never git add -A — so untracked packages/mcp-server stays out. Next TODO: #15 standing_grant_ttl_seconds bounds validation (config.py).