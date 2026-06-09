---
id: OvoVduzNaOb43nDXDcL92
session_id: session-20260608-ag3ntic-stagef
agent_id: default
task: Stage F Part 2 — full live-probe synthesis: FOUR compounding blockers for the MCP-shim capability path + the redesign shape
outcome: revised
created_at: "2026-06-09T09:32:15.101Z"
---

Complete live-probe of the Hermes 0.14.0 MCP-shim path on Cerebro. The Stage F shim-execution design (T9/T16) has FOUR compounding mismatches with Hermes reality (all live-only; unit tests can't see them):

1. ATTACH MECHANISM: Hermes attaches MCP servers via PERSISTENT CONFIG (config.yaml mcp_servers dict: {name: {url, headers:{...}}}), populated by `hermes mcp add <name> --url <URL> --auth header` (interactive: prompts y/n + Bearer token via getpass, saves token to $HERMES_HOME/.env, tests the connection on add). Its ACP session/new does NOT accept an mcpServers param -> sending it (T16) = 'Invalid params'. Config schema (hermes_cli/mcp_config.py:276,332): server_config['url']=url; for header auth server_config['headers']={...} (token saved as an env_key). HERMES_HOME=/home/hermes/.hermes; config.yaml.

2. NETWORK ISOLATION: the employee container is on ag3ntic_runtime_<wsid> ONLY; api/worker are on ag3ntic-runtime + ag3ntic_control (NON-overlapping). So the employee CANNOT reach the shim at api:8000 (name doesn't resolve). BUT it CAN reach the host-published api: http://192.168.0.25:8096/api/health -> 200. So the shim URL Hermes uses must be the HOST-published URL (new setting, distinct from agent_runner_callback_base_url which the shim uses in-process for the backing routers), OR add the employee to ag3ntic-runtime.

3. CONFIG-RELOAD TIMING (unresolved): Hermes' long-running ACP process (hermes_cli/web_server.py) likely loads mcp_servers at PROCESS START, not per session/new. If so, per-run config injection requires restarting the Hermes process per run (expensive) -> favors LAUNCH-TIME config with a STABLE per-employee shim, OR accept restart. Needs one more probe (does web_server re-read mcp config per session?).

4. TOKEN MODEL: the config header is static -> a stable token. Per-run token (T13/T9) means rewriting config (+ maybe restart) per run; per-employee token means re-evaluating T9's per-run shim path (/internal/mcp/{ws}/{emp}/{run}) to per-employee (/internal/mcp/{ws}/{emp}) with the shim resolving the active run server-side.

REDESIGN SHAPE: (a) acp.session_new/session_load: STOP sending mcpServers (Hermes rejects it) — necessary first, unblocks the ACP session. (b) Add a host-reachable EXTERNAL shim base URL setting (e.g. https?://<host>:8096). (c) Orchestrator (it has docker-exec): write the employee's Hermes config mcp_servers entry (url=host shim url, headers Bearer token) — at LAUNCH if config loads at start (stable per-employee URL+token), or per-run + restart. (d) Re-evaluate T9 shim path/token to per-employee (likely) + resolve run_id server-side. (e) DE-RISK FIRST: before automating, manually write the config into hermes-demo + restart + drive a run, to prove the rest of the pipeline (tools/list, execute, gateway allow, approval/re-issue) works end-to-end once Hermes has the shim.

Deploy remains healthy + shim live (401-gating). Temp demo-ws API key 'stagef-smoke-temp' minted server-side (DELETE after). crm_mock+web_research bound to hermes-demo. This is a multi-component redesign (adapter + orchestrator + shim + token + a new setting), not a wire-shape tweak.