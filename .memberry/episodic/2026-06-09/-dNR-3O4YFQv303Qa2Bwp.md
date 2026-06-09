---
id: -dNR-3O4YFQv303Qa2Bwp
session_id: session-20260608-ag3ntic-morph
agent_id: mcp
task: Define golden-path stage F (execution pipeline) scope and execution model
outcome: approved
created_at: "2026-06-09T01:06:26.465Z"
---

Stage F (execution pipeline) of the golden-path build = make bound capabilities actually callable by a RUNNING Hermes employee end-to-end (the decision path — ACP request_permission → PDP → standing-grant re-issue — was already committed; F adds execution). User confirmed two decisions:

(1) F SCOPE = FULL capability execution: build mcpServers in session_new from the employee's healthy bindings, BRIDGE non-MCP internal_api caps (web_research:8090, crm_mock:8080) so Hermes can call them as MCP tools, extend tool_mapping to map a capability tool's request_permission → (capability_slug, action, arguments) instead of always shell.run_command. Goal/DoD: a Sales-Researcher employee's web_research/crm_mock tool calls run end-to-end through the gateway.

(2) EXEC MODEL = SINGLE MCP GATEWAY SHIM (the 'MCP Gateway shim' the exec-B/exec-C briefs name): ONE Streamable-HTTP MCP server fronts ALL of an employee's bound capabilities, exposing actions as MCP tools and routing each call to the backing service (internal_api → http://{service}:{port}{base_path}). The shim is EXECUTION-ONLY; permission/PDP stays on the committed ACP request_permission path (Hermes asks permission before calling the shim tool; on allow Hermes calls the shim → shim executes → result returns via MCP, natively — resolving exec-B's 'result-delivery unknown'). Minimal new surface vs per-capability MCP containers.

ASSUMPTION-TO-VALIDATE (golden-path top-risk #1): whether Hermes 0.14.0 emits request_permission for MCP tool calls (not just its native terminal tool) and how it consumes mcpServers in session_new. Must be confirmed by a supervised live probe on Cerebro before claiming F done; build against the assumption but gate the 'done' claim on the live smoke.

State going into F (branch morph/opt-hardening, HEAD 8bcacd6): committed = P1 SSE passthrough, exec-A manifest types (internal_api/hosted_api/browser_worker/mcp_custom_container), P2.1 crm-mock+web-research backing services + §30.4 catalog seeded from 8 YAMLs + §29 templates, P2.2 EmployeeRevision re-mint, ACP approval engine, seed_shell.py. GAP: tool_mapping only handles native terminal→shell.run_command; session_new called with EMPTY mcp_servers so no bound capability is reachable by a running employee.

NOTE: untracked packages/mcp-server/ag3ntic_mcp/ (Jun 3, references Nimbus + cloud_computer SDK) is the OPERATOR/DEV-facing MCP server, NOT the employee execution pipeline — leave untouched.