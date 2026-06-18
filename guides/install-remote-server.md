# Install: Remote / LAN Server (Docker)

Run MemBerry on one machine (a home server, a workstation, a VM) and connect
agents from **other machines on the LAN**. This is the setup for, e.g., Codex or
Claude Code on a Windows laptop talking to a MemBerry server elsewhere on the
network.

For a same-machine install, see
[install-local-docker.md](install-local-docker.md). For running outside Docker
under systemd, see [install-systemd.md](install-systemd.md).

## Prerequisites

- **Docker Engine + the Docker Compose v2 plugin** on the server.
- The server's LAN IP or hostname, reachable from the client machines.

## Install

On the **server**:

```bash
git clone https://github.com/AP3X-Dev/memberry.git
cd memberry
./scripts/setup.sh --mode server --with-wiki --workspace /path/to/your/projects
```

- `--mode server` publishes the MCP port on `0.0.0.0` so the LAN can reach it
  (vs. `--mode local`, which binds `127.0.0.1` only). In interactive mode the
  wizard also asks for the **public host** shown in the printed client URLs
  (it best-effort detects the LAN IP from `hostname -I`).
- `--with-wiki` also starts the wiki viewer on port `3200`.
- `--workspace <hostdir>` sets `MEMBERRY_WORKSPACE_HOST_PATH` — the host
  directory mounted read-only into the container at `/workspace` for code
  indexing / ingest / compile (see [Workspace mount](#workspace-mount-for-code-indexing)).

On completion the wizard prints the server URL
(`http://<public-host>:3101/mcp`), the bearer token, and a ready-to-paste client
config block. In server mode it also prints a warning that the server is now
reachable by any host on the LAN and the bearer token is the only gate.

## The publish-layer security model

This is the core of server mode. Read it before exposing MemBerry on a network.

- **The container always binds `0.0.0.0`** inside Docker (`MEMBERRY_HOST`, fed
  from `MEMBERRY_BIND_HOST`, default `0.0.0.0`). That is just so the server is
  reachable through Docker's port proxy — it is **not** the access gate.
- **The host publish address is the real gate.** In `docker-compose.yml` the MCP
  port is published as `${MEMBERRY_PUBLISH_HOST}:${MCP_PORT}:3101`:
  - local mode → `MEMBERRY_PUBLISH_HOST=127.0.0.1` (loopback only),
  - server mode → `MEMBERRY_PUBLISH_HOST=0.0.0.0` (all interfaces / LAN).
- **Neo4j and Redis always stay on `127.0.0.1`.** Their port mappings are
  hard-coded to `127.0.0.1:7474`, `127.0.0.1:7687`, and `127.0.0.1:6379` in
  `docker-compose.yml` — server mode does **not** expose the databases on the
  LAN. Only the MCP port (and the wiki port, when enabled) follow
  `MEMBERRY_PUBLISH_HOST`.
- **The bearer token is the only thing gating MCP access** once published on
  `0.0.0.0`. Keep `MEMBERRY_API_TOKEN` secret and rotate it if leaked. For
  revocable per-actor tokens, use `MEMBERRY_API_TOKENS` (comma-separated
  `name:token` pairs) — see [`.env.example`](../.env.example).

So the chain is: container binds everything → the host port binding decides who
can reach it → the bearer token decides who is allowed in.

## Workspace mount for code indexing

A Dockerized MCP server can only index host paths that are mounted into the
container. `--workspace <hostdir>` wires this up:

- It sets `MEMBERRY_WORKSPACE_HOST_PATH=<hostdir>` in `.env`.
- `docker-compose.yml` mounts that host dir **read-only** at `/workspace`
  (`${MEMBERRY_WORKSPACE_HOST_PATH:-./}:/workspace:ro`).
- The container confines all indexing / ingest / compile to `/workspace` via
  `MEMBERRY_INGEST_ALLOW_DIR=/workspace`.

Inside the server, your projects therefore live at `/workspace/<project>`. Put
the repos you want indexed under the host `<hostdir>` and refer to them by their
`/workspace/...` path in `project setup` (below).

## Connect a client (from another machine)

Point each client at the server's URL. The `configure` command emits/writes the
correct config; pass `--url` so it targets the server rather than localhost:

```bash
# Claude Code
npx tsx packages/core/src/cli.ts configure claude --url http://HOST:3101/mcp --write

# Codex
npx tsx packages/core/src/cli.ts configure codex --url http://HOST:3101/mcp --write
```

Replace `HOST` with the server's LAN IP or hostname. The Claude Code entry uses
the mandatory `"type": "http"` discriminator:

```json
{
  "mcpServers": {
    "memberry": {
      "type": "http",
      "url": "http://HOST:3101/mcp",
      "headers": { "Authorization": "Bearer <your-token>" }
    }
  }
}
```

For Codex, the token comes from the `MEMBERRY_API_TOKEN` env var at launch:

```bash
codex mcp add memberry --url http://HOST:3101/mcp --bearer-token-env-var MEMBERRY_API_TOKEN
```

Set `MEMBERRY_API_TOKEN` (and optionally `MEMBERRY_MCP_URL`) in the client
machine's environment. `setup.sh --print-env-snippets` (or
`configure … --print-env-snippets`) prints ready-made Bash and PowerShell
snippets.

## Bootstrap a project

With the workspace mounted, run a one-command project setup against the running
server. `<path>` is resolved **on the server** (its `/workspace` mount), not
locally:

```bash
npx tsx packages/core/src/cli.ts project setup /workspace/<proj> \
  --project-name X --with-wiki \
  --url http://HOST:3101/mcp
```

This drives the server's `berry_ingest_codebase` (scan → graph → index → bridge
→ seed) and, with `--with-wiki`, `berry_compile` plus a viewer refresh. It
reports file/symbol/entity counts and the wiki URL on success.

## Verify the install

```bash
npx tsx packages/core/src/cli.ts doctor
```

`doctor` diagnoses the install — Docker, stack health, reachable Neo4j/Redis,
env config, and wired agent hooks — and reports what is wrong and how to fix it.
You can also hit the health endpoints directly:

```bash
curl http://HOST:3101/healthz                                   # unauthenticated liveness
curl -H "Authorization: Bearer $MEMBERRY_API_TOKEN" http://HOST:3101/readyz   # authenticated readiness
```

## Dynamic tool exposure

MemBerry uses **progressive disclosure**: it exposes **8 Tier-1 `berry_*` tools
by default** and reveals the rest on demand. The always-exposed Tier-1 set is:

```
berry_load · berry_store · berry_memory_read · berry_memory_insert
berry_context · berry_ask · berry_grep · berry_tools
```

Everything else lives in on-demand domains (memory, temporal, admin, research,
code, arch, wiki, retrieval, graph). You activate a domain at runtime with the
gateway tool:

```
berry_tools(action: "enable", domain: "code")     # reveal the code-intelligence tools
berry_tools(action: "enable", domain: "all")       # reveal everything
berry_tools(action: "list")                         # see domains + what's enabled
```

When a domain is enabled or disabled, the server emits the MCP
**`tools/list_changed`** notification (`server.sendToolListChanged()` in
`packages/mcp/src/tools.ts`). Whether a client picks up the newly-exposed tools
depends on whether it honors that notification:

| Client | Honors `tools/list_changed`? | Effect of `berry_tools(enable, domain)` |
|--------|------------------------------|------------------------------------------|
| **Claude Code** | **Yes** | On the `tools/list_changed` notification it re-reads `tools/list` and the newly-enabled tools become directly callable. |
| **Codex** | **No** | Codex does **not** refresh its typed tool schema after the server-side change, so newly-enabled tools never appear as typed tools in the session. |

**What this means for Codex (and any client that ignores `tools/list_changed`):**
because dynamic tool exposure is fragile there, the **8 Tier-1 tools stay
always-exposed** and cover the everyday load/store/search/ask workflow without
any enable step. To reach a Tier-2 tool from such a client, either:

- call the gateway `berry_tools(enable, domain)` and then invoke the now-enabled
  tool via the **raw MCP `tools/call`** method (Codex can call a tool by name
  even when it is not in its typed schema), or
- drive it from a client that refreshes on `tools/list_changed` (e.g. Claude
  Code), or from the CLI helpers that do the enable + raw call for you (for
  example `project setup`, which enables the `admin`/`wiki` domains and then
  calls `berry_ingest_codebase` / `berry_compile` over `/mcp`).

In short: **`tools/list_changed` is the dynamic tool-exposure signal**; Claude
Code reacts to it, Codex does not — which is exactly why the Tier-1 first-run
tools are always exposed.
