---
id: JsTcJtjP8PT_EeKD3Hc4V
session_id: session-20260611-ag3ntic-morph
agent_id: default
task: Demo-workspace cleanup on Cerebro deployment + diagnose why employees report they cannot open a browser/Google
created_at: "2026-06-12T01:20:54.531Z"
---

Diagnostic + cleanup on the live AG3NTIC Cerebro deploy (demo workspace wsp_65af44e194692baac5f5efae).

ROOT CAUSE — "employee can't open Google": the demo employees' per-employee Hermes config.yaml (HERMES_HOME=/home/hermes/.hermes inside the employee container) had ONLY the `ag3ntic` MCP shim attached and NO Computer/browser capability. With no browser tool in its tool surface, the model (gpt-5.4) correctly reports it cannot open a visible browser. So this is a capability-attachment gap, not a runtime bug. Fix path = attach the gated "Computer" Capability to the employee so the shim exposes browser/computer tools at launch. (mcp-demo-computer container on Cerebro, ports 8765/9400, is the computer-use backing.)

SECURITY NOTE: the model provider API key was present in PLAINTEXT inside the employee container's ~/.hermes/config.yaml (custom_providers[].api_key). Worth surfacing — runtime config injects the decrypted key into the container FS. Recommend key rotation + reviewing whether the launch-time config injection can avoid writing the raw key to disk.

CLEANUP performed (user-requested, clean slate keeping only the Operator): deleted all 6 active demo employees via service.delete_employee(purge_volumes=True) run inside ag3ntic-api-1 (proper container+volume teardown, approval auto-cancel, audit preserved). Then cleared history tables in FK-safe child→parent order: run_events(14667), tool_calls(81), messages(85), approval_decisions(12), approval_requests(12), operator_proposals(9), operator_jobs(21), runs(56), conversations(25). Preserved: cost_events (22, run_id SET NULL) and audit_events (403, hash chain intact). Only the Operator (emp_9fc17d4e38a7039476e8f844, kind=operator) remains; it has no Hermes runtime container (runs inline/server-side), which is expected.

DB/op facts for next time: ag3ntic-postgres-1, role/db platform/platform; DELETE /workspaces/{ws}/employees/{id}?purge_volumes=true is admin+; APP_ENV=development on the deploy so dev_keys.py can mint a console key; all FKs into history tables are CASCADE or SET NULL (no RESTRICT).