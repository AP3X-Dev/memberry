# Install: Local Docker (single machine)

The default install. Runs the whole stack — Neo4j, Redis, and the MemBerry MCP
server — in Docker on **one machine**, reachable only from that machine
(`127.0.0.1`). This is the right guide when the agent (Claude Code, Codex, …) and
MemBerry run on the same computer.

For LAN/server access from another machine, see
[install-remote-server.md](install-remote-server.md). For a non-Docker
production deployment with systemd, see [install-systemd.md](install-systemd.md).

## Prerequisites

- **Docker Engine + the Docker Compose v2 plugin** (`docker compose`, not the
  legacy `docker-compose`). Nothing else is required — Node is optional; the
  server image builds itself in Docker.

## Install

```bash
git clone https://github.com/AP3X-Dev/memberry.git
cd memberry
./scripts/setup.sh
```

`./scripts/setup.sh` is a guided wizard. With no flags it defaults to
**`--mode local`** (publish on `127.0.0.1`). It:

1. Checks Docker, the Compose v2 plugin, and that the daemon is reachable.
2. Generates a `.env` from `.env.example` — a random API token (`mbry_…`) plus
   random Neo4j and Redis passwords. The OpenAI key is optional (press Enter to
   skip).
3. Builds and starts the full stack via `docker compose --profile app up -d --build`.
4. Waits until `http://localhost:3101/healthz` is healthy.
5. Runs a best-effort authenticated smoke test (token auth + `/mcp` handshake +
   a dynamic domain enable).
6. Prints the exact MCP client config to paste into your agent, **including your
   generated bearer token**.

It is idempotent — safe to re-run. If a `.env` already exists it is reused
(pass `--reconfigure` to regenerate it).

### Useful flags

```bash
./scripts/setup.sh --yes          # non-interactive (CI) — accept all defaults
./scripts/setup.sh --db-only      # start only Neo4j + Redis (run the server yourself)
./scripts/setup.sh --with-wiki    # also start the wiki viewer (port 3200)
./scripts/setup.sh --reconfigure  # re-run the wizard even if .env exists
```

> **No OpenAI key?** MemBerry still runs — retrieval falls back to deterministic
> lexical + fulltext ranking (no random results). Add `OPENAI_API_KEY` to `.env`
> and `npm run stack:up` (or `./scripts/setup.sh --reconfigure`) to enable
> embeddings.

## What the `.env` holds

`setup.sh` copies `.env.example` and fills in the secrets. The keys that matter
for a local install:

| Key | What it is |
|-----|-----------|
| `MEMBERRY_API_TOKEN` | Random bearer token (`mbry_…`) — the gate for MCP access. |
| `NEO4J_PASSWORD` | Random Neo4j password (also provisions the Neo4j container). |
| `REDIS_PASSWORD` / `REDIS_URL` | Random Redis password (must match inside `REDIS_URL`). |
| `OPENAI_API_KEY` | Optional — enables embeddings + LLM entity extraction. |
| `MCP_PORT` | MCP server port (default `3101`). |
| `MEMBERRY_BIND_HOST` | Container bind host — stays `0.0.0.0` (publish layer is the gate). |
| `MEMBERRY_PUBLISH_HOST` | Host publish address — `127.0.0.1` in local mode. |
| `MEMBERRY_PUBLIC_HOST` | Host shown in printed client URLs — `localhost` in local mode. |

In local mode, `MEMBERRY_PUBLISH_HOST=127.0.0.1` means Docker only publishes the
port on the loopback interface, so nothing on the LAN can reach it. Neo4j
(`7474`/`7687`) and Redis (`6379`) are always bound to `127.0.0.1` regardless of
mode. See [`.env.example`](../.env.example) for the commonly-tuned keys, and
the `mcp` service block in [`docker-compose.yml`](../docker-compose.yml) for
the full set of flags the container reads, including the retrieval and
lifecycle rollout flags.

## Connect a client

After setup, point your agent at the running server. The `configure` command
emits (and with `--write` persists) the correct MCP client config — it reads the
URL from `MEMBERRY_MCP_URL` (or `MEMBERRY_PUBLIC_HOST`/`MCP_PORT`) and the token
from `MEMBERRY_API_TOKEN`:

```bash
# Claude Code — writes mcpServers.memberry into ~/.claude/settings.json
npx tsx packages/core/src/cli.ts configure claude --write

# Codex — writes [mcp_servers.memberry] into ~/.codex/config.toml
npx tsx packages/core/src/cli.ts configure codex --write
```

Run without `--write` to just print the config/commands. You can also let
`setup.sh` do it in one shot with `--configure-claude` / `--configure-codex`.

The Claude Code entry it writes looks like this (the `"type": "http"`
discriminator is mandatory — without it Claude treats it as the legacy
stdio/SSE shape and never connects):

```json
{
  "mcpServers": {
    "memberry": {
      "type": "http",
      "url": "http://localhost:3101/mcp",
      "headers": { "Authorization": "Bearer <your-token>" }
    }
  }
}
```

For Codex, the token is read from the `MEMBERRY_API_TOKEN` env var at launch and
is never written into the config file:

```bash
codex mcp add memberry --url http://localhost:3101/mcp --bearer-token-env-var MEMBERRY_API_TOKEN
```

**Works with any MCP-compatible agent:** Claude Code, Cursor, Windsurf, Cline,
Codex, or custom agents. See [SECURITY.md](../SECURITY.md) for the auth model.

## The wiki viewer (optional)

Pass `--with-wiki` to also start the wiki viewer (the `wiki` Compose profile) on
port `3200`. It compiles the knowledge graph into a browsable, interlinked wiki:

```bash
./scripts/setup.sh --with-wiki
# → Wiki viewer at http://localhost:3200/wiki/_index
```

Without the flag, only Neo4j + Redis + the MCP server start; the viewer is not
running.

## Manage the stack

```bash
npm run stack:up      # build + start Neo4j + Redis + MemBerry server
npm run stack:logs    # follow the server logs
npm run stack:down    # stop everything
curl http://localhost:3101/healthz
```

## Run from source instead (development)

Hacking on MemBerry itself? Start just the databases and run the server on the
host (needs Node.js 20+):

```bash
./scripts/setup.sh --db-only
npm install
npm run dev           # tsx (identical to npm start; restart it after edits)
```
