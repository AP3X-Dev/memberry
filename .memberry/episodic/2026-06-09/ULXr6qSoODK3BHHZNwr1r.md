---
id: ULXr6qSoODK3BHHZNwr1r
session_id: session-20260609-ag3ntic-morph
agent_id: default
task: Settle the per-run vs per-employee shim token decision for Stage F Part 2
outcome: approved
created_at: "2026-06-09T11:07:11.225Z"
---

DECISION (ratified by user 2026-06-09): the MCP Gateway shim token becomes PER-EMPLOYEE, not per-run.

- T13 token: sign_employee_shim_token(ws, emp) drops run_id; claims = (workspace_id, employee_id, exp). verify returns {workspace_id, employee_id}.
- T9 shim mount: /internal/mcp/{ws}/{emp} (drop run_id from path). The shim resolves the employee's ACTIVE run server-side = the single run in status running OR waiting_approval for that employee; fail-closed (deny) if 0 or >1 (ambiguous). Per-call default-deny PEP via gateway.intercept_tool_call unchanged.
- Orchestrator: write the Hermes config mcp_servers["ag3ntic"]={url:<shim_external_base_url>/internal/mcp/{ws}/{emp}, headers:{Authorization: Bearer <employee token>}, enabled:true} into the employee container ONCE at launch (provision_employee), not per run.

RATIONALE: (1) The token only AUTHENTICATES (ws,emp); authorization stays per-call via the gateway PEP, so dropping run_id does not weaken the security boundary. (2) Hermes 0.14.0 attaches MCP via persistent config with a STATIC token (hermes mcp add → config.yaml + $HERMES_HOME/.env); per-run forces rewriting that config every run. (3) Per-employee launch-time injection is robust to R1 (config-reload timing) EITHER WAY; per-run only works if Hermes re-reads config per exec AND tolerates a race (concurrent same-employee runs clobber the shared config.yaml). CONSEQUENCE accepted: one active run per employee at a time (a 2nd concurrent run makes active-run resolution ambiguous → fail-closed).

Prod transport spawns a fresh `hermes acp` per run via docker exec (hermes_adapter.docker_exec_transport → exec_attach(container,["hermes","acp"])); employee container is read_only with HERMES_HOME (/home/hermes/.hermes) on an rw volume, so config is written into that volume.