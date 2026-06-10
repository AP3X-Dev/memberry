---
id: McTtYH0w1px5YNcx9Sn52
session_id: session-20260609-ag3ntic-morph
agent_id: default
task: Stage F Part 2 R1 — probe Hermes 0.14.0 mcp_servers config mechanics + reload timing on Cerebro
outcome: approved
created_at: "2026-06-09T14:56:13.127Z"
---

R1 ANSWERED (read from live Hermes 0.14.0 source in employee-demo-hermes-demo on Cerebro). Decisive for Phase C.

CONFIG SHAPE (hermes_cli/mcp_config.py): config at $HERMES_HOME/config.yaml (=/home/hermes/.hermes/config.yaml). mcp_servers is a DICT keyed by name. For an HTTP server with header auth, `hermes mcp add <name> --url <URL> --auth header` writes:
  mcp_servers:
    <name>:
      url: "<URL>"
      headers: {Authorization: "Bearer ${MCP_<NAME>_API_KEY}"}
      enabled: true
and saves the token to $HERMES_HOME/.env as MCP_<NAME>_API_KEY (referenced via ${} interpolation). enabled semantics: included unless cfg.get("enabled") is False.

INLINE TOKEN WORKS: tools/mcp_tool.py _interpolate_env_vars (line 2131) substitutes ${VAR} from os.environ but returns the literal unchanged when there's no ${}. So Phase C can write the token INLINE — headers: {Authorization: "Bearer <token>"} — NO .env needed. One file to write (config.yaml).

RELOAD TIMING (the R1 question): mcp_servers is re-read PER SESSION, not only at process start. acp_adapter/server.py new_session(929)/load_session(957)/resume_session(975) each call _register_session_mcp_servers(936/968/986); acp_adapter/session.py _create_agent(~568) calls hermes_cli.config.load_config() and builds configured_mcp_servers from config.get("mcp_servers") at agent creation. So every session/new reads config.yaml fresh. Combined with prod spawning a fresh `hermes acp` per run via docker exec (hermes_adapter.docker_exec_transport), launch-time config injection is DOUBLY robust — no process restart needed. The `hermes mcp add` success message "Start a new session to use these tools" matches this.

`hermes mcp add` is interactive (needs_auth confirm + getpass token + tool-selection input) and discovery-first (connects to list tools, fails if unreachable) → NOT scriptable. So Phase C writes config.yaml DIRECTLY (the plan's chosen path), token inline.

CURRENT LIVE STATE: ag3ntic stack up ~5h on Cerebro (api/worker/postgres/redis/qdrant/minio/registry/web/socket-proxy). Employee container = employee-demo-hermes-demo (image localhost:5000/ag3ntic-hermes-employee, up 38h); its config.yaml currently has only model: (provider openai-codex, default gpt-5.5), no mcp_servers, no .env. DEPLOYED CODE IS STILL 2cc355b (per-RUN shim) — my per-employee dfeee30 is NOT deployed yet; R4 against the new design needs dfeee30 deployed first (api/worker bind-mount apps/api → restart picks it up).