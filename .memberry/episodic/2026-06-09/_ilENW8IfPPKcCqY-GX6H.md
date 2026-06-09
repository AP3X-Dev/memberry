---
id: _ilENW8IfPPKcCqY-GX6H
session_id: session-20260608-ag3ntic-stagef
agent_id: default
task: Stage F Part 2 live-probe — KEY FINDING: Hermes 0.14.0 rejects mcpServers in session/new; MCP servers attach via config (hermes mcp add), invalidating T16/T9's per-run-session approach
outcome: revised
created_at: "2026-06-09T09:00:06.000Z"
---

LIVE-PROBE RESULT (golden-path, real Hermes 0.14.0 on Cerebro): the deploy + worker + ACP run path all WORK — start_run -> runbus.enqueue_run_job -> worker run_worker.execute_acp_run -> adapter.start_run. But session bring-up FAILS: client.session_new(mcp_servers=[shim_entry]) -> AcpProtocolError "Invalid params" (JSON-RPC -32602). Hermes rejects the mcpServers param in session/new.

ROOT CAUSE (confirmed by reading the Hermes 0.14.0 source in the employee container, /opt/hermes-agent/lib/python3.11/site-packages/hermes_cli/): MCP servers are a CONFIG concept, not an ACP session param. Hermes reads cfg.get('mcp_servers') (a dict keyed by name) from read_raw_config() (oneshot.py:93, tools_config.py:1260). They are attached via the CLI `hermes mcp add <name> --url <URL> --auth {oauth,header} [--command/--args/--env for stdio]` which writes the persistent config (HERMES_HOME=/home/hermes/.hermes). The ACP session/new handler does NOT consume mcpServers, so passing it -> Invalid params.

IMPACT: T16 (mcpServers threaded into session/new + session/load) is INCOMPATIBLE with Hermes 0.14.0 and breaks EVERY ACP run at bring-up (not just MCP-capability runs) — the deployed worker ACP path is currently broken by it (the OLD one-shot hermes_run_executor would still work). T9's design — a PER-RUN shim mounted at /internal/mcp/{ws}/{emp}/{run_id} with a per-run Bearer token passed via session/new headers — does not fit a PERSISTENT config-based attach. This is exactly the plan's flagged 're-evaluate T9' decision (live-probe gate #2/#3: 'if headers only at init / config, the authn model moves to init-time binding -> re-evaluate T9').

DESIGN OPTIONS to attach the shim the Hermes-native way (config-based):
A) At employee LAUNCH (orchestrator already has docker-exec): write Hermes config mcp_servers['ag3ntic'] = {transport http/streamable_http, url, header Bearer <token>, enabled true} (via `hermes mcp add` or writing the config file). Needs a STABLE url (per-employee /internal/mcp/{ws}/{emp}, drop run_id from the path) + an employee-scoped token; the shim resolves run_id another way (current active run for the employee, or run_id in a per-call arg) — re-opens T9's per-run-path/token security model.
B) Reconfigure per RUN: before each ACP session, `hermes mcp add`/remove the per-run shim entry in the container (stateful, racy across concurrent runs of one employee).
C) Keep per-run identity but carry it in the token/headers with a stable URL; shim verifies token -> (ws,emp,run). Requires Hermes to forward the configured header on every MCP HTTP call (probe: does `--auth header` set a static header sent on every request? unverified).
MUST FIRST: remove mcpServers from acp.session_new/session_load (or guard it off for Hermes) so the ACP path works at all. `hermes mcp add --auth header` token-provisioning mechanism (how the header value is set non-interactively) is unverified — needs a probe before committing to a path.

STATUS: deploy is healthy + shim live (401 gating verified); a temp demo-ws API key (name stagef-smoke-temp) was minted server-side for the smoke (delete after). crm_mock+web_research bound to hermes-demo (healthy runtime employee-demo-hermes-demo). Stopped at this architectural decision point for human direction rather than unilaterally redesigning the shim-attach + T9 security model.