#!/usr/bin/env bash
#
# MemBerry guided setup.
#
# Stands up the whole stack — Neo4j, Redis, and the MemBerry MCP server — in
# Docker with a single command. Only Docker is required; Node is optional (the
# server image builds itself).
#
#   ./setup.sh                 # guided (prompts when run in a terminal)
#   ./setup.sh --yes           # non-interactive, accept all defaults
#   ./setup.sh --db-only       # start only Neo4j + Redis (run the server yourself)
#   ./setup.sh --with-wiki     # also start the wiki viewer (port 3200, "wiki" profile)
#   ./setup.sh --reconfigure   # re-run the wizard even if .env already exists
#   ./setup.sh --mode local    # local-only access (publish on 127.0.0.1)
#   ./setup.sh --mode server   # LAN/server access (publish on 0.0.0.0)
#   ./setup.sh --workspace PATH    # set MEMBERRY_WORKSPACE_HOST_PATH
#   ./setup.sh --configure-claude  # after setup, write Claude Code MCP config
#   ./setup.sh --configure-codex   # after setup, write Codex MCP config
#   ./setup.sh --token-from-env    # reuse MEMBERRY_API_TOKEN from the env (don't mint one)
#   ./setup.sh --print-env-snippets  # print Bash + PowerShell client env snippets
#
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# ── Pretty output ───────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  B=$'\033[1m'; BLUE=$'\033[1;34m'; YEL=$'\033[1;33m'; RED=$'\033[1;31m'; GRN=$'\033[1;32m'; DIM=$'\033[2m'; R=$'\033[0m'
else
  B=''; BLUE=''; YEL=''; RED=''; GRN=''; DIM=''; R=''
fi
log()  { printf '%s[setup]%s %s\n' "$BLUE" "$R" "$*"; }
ok()   { printf '%s[setup]%s %s\n' "$GRN" "$R" "$*"; }
warn() { printf '%s[setup]%s %s\n' "$YEL" "$R" "$*" >&2; }
fail() { printf '%s[setup]%s %s\n' "$RED" "$R" "$*" >&2; exit 1; }

# ── Flags ───────────────────────────────────────────────────────────────────────
ASSUME_YES=0; DB_ONLY=0; RECONFIGURE=0; MODE=''; WITH_WIKI=0
WORKSPACE=''; CONFIGURE_CLAUDE=0; CONFIGURE_CODEX=0; TOKEN_FROM_ENV=0; PRINT_ENV_SNIPPETS=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1 ;;
    --db-only) DB_ONLY=1 ;;
    --with-wiki) WITH_WIKI=1 ;;
    --reconfigure) RECONFIGURE=1 ;;
    --configure-claude) CONFIGURE_CLAUDE=1 ;;
    --configure-codex) CONFIGURE_CODEX=1 ;;
    --token-from-env) TOKEN_FROM_ENV=1 ;;
    --print-env-snippets) PRINT_ENV_SNIPPETS=1 ;;
    --workspace)
      shift; WORKSPACE="${1:-}"
      [ -n "$WORKSPACE" ] || fail "--workspace requires a path" ;;
    --workspace=*) WORKSPACE="${1#--workspace=}"
      [ -n "$WORKSPACE" ] || fail "--workspace requires a path" ;;
    --mode)
      shift; MODE="${1:-}"
      [ "$MODE" = "local" ] || [ "$MODE" = "server" ] \
        || fail "--mode must be 'local' or 'server' (got: '${MODE:-<missing>}')" ;;
    --mode=*) MODE="${1#--mode=}"
      [ "$MODE" = "local" ] || [ "$MODE" = "server" ] \
        || fail "--mode must be 'local' or 'server' (got: '$MODE')" ;;
    -h|--help) grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "Unknown option: $1 (try --help)" ;;
  esac
  shift
done

INTERACTIVE=0
if [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ] && [ -t 1 ]; then INTERACTIVE=1; fi

# ── Helpers ─────────────────────────────────────────────────────────────────────
gen_secret() {
  # N random bytes as hex; fall back to /dev/urandom if openssl is missing.
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "${1:-24}"
  else LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c "$(( ${1:-24} * 2 ))"; fi
}

# set_env KEY VALUE — update KEY=… in .env (handles values with / : @), else append.
set_env() {
  local key="$1" val="$2" file=".env"
  touch "$file"
  if grep -qE "^${key}=" "$file"; then
    KEY="$key" VAL="$val" awk '
      BEGIN { k=ENVIRON["KEY"]; v=ENVIRON["VAL"] }
      $0 ~ "^"k"=" { print k"="v; next }
      { print }
    ' "$file" >"$file.tmp" && mv "$file.tmp" "$file"
  else
    printf '%s=%s\n' "$key" "$val" >>"$file"
  fi
}

prompt() { # prompt VAR "question" "default"  (reads only when INTERACTIVE)
  local __var="$1" __q="$2" __def="${3:-}" __ans=''
  if [ "$INTERACTIVE" -eq 1 ]; then
    if [ -n "$__def" ]; then printf '%s[setup]%s %s %s[%s]%s ' "$BLUE" "$R" "$__q" "$DIM" "$__def" "$R" >&2
    else printf '%s[setup]%s %s ' "$BLUE" "$R" "$__q" >&2; fi
    read -r __ans || __ans=''
  fi
  printf -v "$__var" '%s' "${__ans:-$__def}"
}

# ── Prerequisites ───────────────────────────────────────────────────────────────
printf '\n%s== MemBerry setup ==%s\n\n' "$B" "$R"
log "Checking prerequisites..."
command -v docker >/dev/null 2>&1 || fail "Docker is required but was not found on PATH. Install Docker, then re-run."
docker compose version >/dev/null 2>&1 || fail "The Docker Compose v2 plugin is required ('docker compose'). Install it and retry."
docker info >/dev/null 2>&1 || fail "Docker is installed but the daemon is not reachable. Start Docker and retry."
ok "Docker $(docker --version | awk '{print $3}' | tr -d ',') + Compose v2"

# ── Configure (.env) ────────────────────────────────────────────────────────────
if [ -f .env ] && [ "$RECONFIGURE" -eq 0 ]; then
  log ".env already present — reusing it (pass --reconfigure to redo)."
else
  [ -f .env.example ] || fail ".env.example is missing — cannot generate .env."
  cp -f .env.example .env
  log "Generating .env (secrets are random and saved only locally)..."

  OPENAI_KEY=''
  if [ "$INTERACTIVE" -eq 1 ]; then
    printf '%s         Embeddings & extraction use OpenAI. Without a key, MemBerry still runs\n' "$DIM"
    printf '         with deterministic lexical/fulltext retrieval (no random results).%s\n\n' "$R"
    prompt OPENAI_KEY "OpenAI API key (optional — press Enter to skip):" ""
  fi

  prompt PORT_VAL "MCP server port:" "3101"

  # Mint a fresh token, unless --token-from-env was passed AND the env already
  # carries one (lets CI / re-provisioning reuse a known token instead of rotating).
  if [ "$TOKEN_FROM_ENV" -eq 1 ] && [ -n "${MEMBERRY_API_TOKEN:-}" ]; then
    API_TOKEN="$MEMBERRY_API_TOKEN"
    log "Reusing MEMBERRY_API_TOKEN from the environment (--token-from-env)."
  else
    API_TOKEN="mbry_$(gen_secret 24)"
  fi
  NEO_PW="$(gen_secret 16)"
  REDIS_PW="$(gen_secret 16)"

  set_env OPENAI_API_KEY "$OPENAI_KEY"
  set_env MEMBERRY_API_TOKEN "$API_TOKEN"
  set_env NEO4J_PASSWORD "$NEO_PW"
  set_env REDIS_PASSWORD "$REDIS_PW"
  # Host-facing URLs (for running CLI/tools on the host); the container overrides
  # these with service-DNS URLs in docker-compose.yml.
  set_env REDIS_URL "redis://:${REDIS_PW}@localhost:6379"
  set_env MCP_PORT "$PORT_VAL"

  # ── Access mode (local vs LAN/server) ───────────────────────────────────────
  # Decide the publish address and the host shown in printed URLs. The container
  # always binds 0.0.0.0 (MEMBERRY_BIND_HOST); the publish layer is the gate.
  RESOLVED_MODE="$MODE"
  if [ -z "$RESOLVED_MODE" ]; then
    if [ "$INTERACTIVE" -eq 1 ]; then
      prompt MODE_CHOICE "Access mode — [1] local-only (127.0.0.1)  [2] LAN/server (0.0.0.0):" "1"
      case "$MODE_CHOICE" in
        2|server) RESOLVED_MODE="server" ;;
        *)        RESOLVED_MODE="local" ;;
      esac
    else
      RESOLVED_MODE="local"
    fi
  fi

  if [ "$RESOLVED_MODE" = "server" ]; then
    PUBLISH_HOST="0.0.0.0"
    # Best-effort LAN IP detection: first address from `hostname -I`, falling
    # back to `hostname` if that yields nothing.
    ip_guess="$(hostname -I 2>/dev/null | awk '{print $1}')"
    [ -n "$ip_guess" ] || ip_guess="$(hostname 2>/dev/null || true)"
    if [ "$INTERACTIVE" -eq 1 ]; then
      prompt PUBLIC_HOST "Public host shown in client URLs (LAN IP or hostname):" "${ip_guess:-localhost}"
    else
      PUBLIC_HOST="${ip_guess:-localhost}"
    fi
  else
    PUBLISH_HOST="127.0.0.1"
    PUBLIC_HOST="localhost"
  fi

  set_env MEMBERRY_BIND_HOST "0.0.0.0"
  set_env MEMBERRY_PUBLISH_HOST "$PUBLISH_HOST"
  set_env MEMBERRY_PUBLIC_HOST "$PUBLIC_HOST"
  ok "Wrote .env (API token generated; DB passwords randomized; access mode: ${RESOLVED_MODE})."
fi

# --workspace overrides the host workspace path independently of .env (re)generation.
if [ -n "$WORKSPACE" ]; then
  set_env MEMBERRY_WORKSPACE_HOST_PATH "$WORKSPACE"
  log "Set MEMBERRY_WORKSPACE_HOST_PATH=${WORKSPACE}"
fi

# Load .env so we can report the token/port and poll health.
set -a; # shellcheck disable=SC1091
. ./.env; set +a
: "${MCP_PORT:=3101}"
: "${MEMBERRY_API_TOKEN:=}"
: "${MEMBERRY_PUBLIC_HOST:=localhost}"
: "${MEMBERRY_PUBLISH_HOST:=127.0.0.1}"

# ── Bring up the stack ──────────────────────────────────────────────────────────
if [ "$DB_ONLY" -eq 1 ]; then
  log "Starting databases (Neo4j + Redis)..."
  docker compose up -d
else
  log "Building and starting the full stack (Neo4j + Redis + MemBerry)..."
  log "The first build compiles all packages in Docker and may take a few minutes."
  profiles="--profile app"
  [ "$WITH_WIKI" = "1" ] && profiles="$profiles --profile wiki" && log "Wiki viewer enabled (--with-wiki): will publish on port 3200."
  docker compose $profiles up -d --build
fi

# ── Wait for health ─────────────────────────────────────────────────────────────
log "Waiting for services to become healthy..."
if [ "$DB_ONLY" -eq 1 ]; then
  for _ in $(seq 1 30); do
    if wget -qO- "http://localhost:7474" >/dev/null 2>&1 || curl -fsS "http://localhost:7474" >/dev/null 2>&1; then break; fi
    sleep 2
  done
  ok "Databases are up. Run the server on the host:  ${B}npm install && npm start${R}"
else
  health_ok=0
  for _ in $(seq 1 60); do
    if curl -fsS "http://localhost:${MCP_PORT}/healthz" >/dev/null 2>&1 \
       || wget -qO- "http://localhost:${MCP_PORT}/healthz" >/dev/null 2>&1; then
      health_ok=1; break
    fi
    sleep 2
  done
  if [ "$health_ok" -eq 1 ]; then
    ok "MemBerry is healthy at http://localhost:${MCP_PORT}/healthz"

    # ── Authenticated end-to-end smoke (best-effort, non-fatal) ──────────────
    # Once the server is up and we have a token, prove the real authenticated
    # contract (token auth + /mcp handshake + dynamic domain enable). It SKIPS
    # CLEANLY (exit 0) when no token / unreachable, so it never aborts setup —
    # but we wrap it anyway so a genuine assertion failure only WARNS under
    # `set -e` instead of killing the wizard.
    if [ -n "${MEMBERRY_API_TOKEN:-}" ] && command -v node >/dev/null 2>&1; then
      log "Running authenticated smoke test (best-effort)..."
      if node scripts/smoke-auth.mjs; then
        ok "Authenticated smoke test passed."
      else
        warn "Authenticated smoke test reported a problem (non-fatal). See output above."
      fi
    fi
  else
    warn "Server did not pass the health check in time. Check logs: ${B}docker compose --profile app logs mcp${R}"
  fi
fi

# ── Done — connection details ────────────────────────────────────────────────────
printf '\n%s== Setup complete ==%s\n\n' "$GRN" "$R"
if [ "$DB_ONLY" -eq 0 ]; then
  cat <<EOF
${B}Your MemBerry MCP server is running:${R}
  URL:    http://${MEMBERRY_PUBLIC_HOST}:${MCP_PORT}/mcp
  Token:  ${MEMBERRY_API_TOKEN:-<none — set MEMBERRY_API_TOKEN in .env>}

${B}Connect an agent${R} — add this to your MCP client config:
  {
    "mcpServers": {
      "memberry": {
        "type": "http",
        "url": "http://${MEMBERRY_PUBLIC_HOST}:${MCP_PORT}/mcp",
        "headers": { "Authorization": "Bearer ${MEMBERRY_API_TOKEN}" }
      }
    }
  }

${B}Handy commands${R}
  Logs:    docker compose --profile app logs -f mcp
  Stop:    docker compose --profile app down
  Status:  curl http://localhost:${MCP_PORT}/healthz
EOF
  if [ "$WITH_WIKI" = "1" ]; then
    printf '\n%sWiki viewer is running:%s\n  URL:    http://%s:3200/wiki/_index\n' \
      "$B" "$R" "${MEMBERRY_PUBLIC_HOST}"
  fi
  if [ "$MEMBERRY_PUBLISH_HOST" = "0.0.0.0" ]; then
    warn "SERVER MODE: MemBerry is published on 0.0.0.0 and is reachable by ANY host on the LAN."
    warn "The bearer token is the ONLY thing gating access — keep MEMBERRY_API_TOKEN secret and rotate it if leaked."
  fi

  # ── Optional: wire up the agent client config (best-effort, non-fatal) ─────────
  # The CLI `configure` reads MEMBERRY_MCP_URL / MEMBERRY_API_TOKEN from the env,
  # both of which are loaded from .env above. Build the URL it would compute so
  # the printed fallback command matches exactly.
  MCP_URL="http://${MEMBERRY_PUBLIC_HOST}:${MCP_PORT}/mcp"
  configure_client() { # configure_client <claude|codex>
    local client="$1"
    printf '\n%s[setup]%s Configuring %s MCP client...\n' "$BLUE" "$R" "$client"
    if MEMBERRY_MCP_URL="$MCP_URL" npx tsx packages/core/src/cli.ts configure "$client" --write; then
      ok "Configured $client (mcpServers.memberry / [mcp_servers.memberry])."
    else
      warn "Could not auto-configure $client. Run it yourself:"
      warn "  MEMBERRY_MCP_URL=$MCP_URL npx tsx packages/core/src/cli.ts configure $client --write"
    fi
  }
  [ "$CONFIGURE_CLAUDE" -eq 1 ] && configure_client claude
  [ "$CONFIGURE_CODEX" -eq 1 ] && configure_client codex

  if [ "$PRINT_ENV_SNIPPETS" -eq 1 ]; then
    cat <<EOF

${B}Environment variable snippets${R}

Bash / zsh:
export MEMBERRY_API_TOKEN=${MEMBERRY_API_TOKEN:-<your-token>}
export MEMBERRY_MCP_URL=${MCP_URL}

PowerShell:
[Environment]::SetEnvironmentVariable('MEMBERRY_API_TOKEN','${MEMBERRY_API_TOKEN:-<your-token>}','User')
[Environment]::SetEnvironmentVariable('MEMBERRY_MCP_URL','${MCP_URL}','User')
EOF
  fi
fi
[ -z "${OPENAI_API_KEY:-}" ] && warn "No OPENAI_API_KEY set — running with lexical/fulltext retrieval only. Add one to .env and restart to enable embeddings."
exit 0
