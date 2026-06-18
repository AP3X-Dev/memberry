# MemBerry Setup Gaps

This backlog captures setup and first-run product gaps observed while restoring
MemBerry on Cerebro and indexing Agent-Assist-CR from a Windows agent
workstation. The goal is to turn these into upstream fixes so a normal
open-source install produces a usable product without agent-led troubleshooting.

## Highest Priority Fixes

1. Remote/server mode setup
2. Claude Code and Codex client config generation
3. Wiki service included in the standard Docker setup
4. Workspace mounts for code indexing
5. One-command project bootstrap, code index, wiki refresh, and smoke test
6. Legacy AMP branding cleanup

## Actual Setup Gaps

### 1. Remote/LAN Server Mode Is Not Supported Cleanly

- Default Compose binds MCP to `127.0.0.1:3101`.
- That works only when the agent runs on the same machine as MemBerry.
- For Codex/Claude running on Windows against Cerebro, we had to patch the bind
  to `0.0.0.0:3101`.

Fix:

- Setup should ask `local-only` vs `LAN/server` mode.
- Configure bind host from that answer.
- Print the correct client URLs for the chosen mode.

### 2. Claude Code And Codex Config Are Stale Or Under-Specified

- Old examples/configs still referenced `/sse`.
- The working endpoint is `/mcp` with HTTP transport.
- Claude config needed:

```json
{
  "type": "http",
  "url": "http://192.168.0.25:3101/mcp"
}
```

Fix:

- Setup should print tested commands/config snippets for Claude Code and Codex.
- Avoid generic MCP JSON that does not match the current transport.

### 3. Wiki Viewer Is Advertised But Not Started By Default

- Docs mention the wiki UI on port `3200`.
- Default Compose starts Neo4j, Redis, and MCP, but not a wiki viewer.
- We had to add a `memberry-wiki` Compose service manually.

Fix:

- Add an upstream wiki service/profile.
- Provide a setup flag such as `--with-wiki`, or start the viewer by default.
- Include a health check for `/wiki/_index`.

### 4. Code Indexing Is Not First-Run Ready In Docker/Server Mode

- Code tools exist, but a Dockerized MCP server cannot index arbitrary
  host/client paths unless those paths are mounted into the container.
- Default Compose has no workspace volume.
- Setup does not ask where user projects live.
- We had to archive a repo, copy it into the MCP container, and index the
  container path.

Fix:

- Add `MEMBERRY_WORKSPACE_HOST_PATH` support.
- Mount it as `/workspace`.
- Set `MEMBERRY_INGEST_ALLOW_DIR=/workspace`.
- Teach setup and docs to use `/workspace/<project>` paths.

### 5. No One-Command Project Bootstrap And Code Index Path

- The repo has `berry_ingest_codebase` and `berry_code_index`, but setup only
  starts infrastructure.
- A new user can end with a healthy but empty graph.
- Agents must know the next sequence manually:
  - choose project path
  - create project tag
  - bootstrap project
  - index code
  - seed memory blocks
  - compile wiki
  - verify output

Fix:

- Add a first-run command such as:

```text
memberry project setup <path> --project-name <name> --with-wiki
```

- Internally it should:
  - verify the repo path is inside the allowed workspace
  - create/promote the project entity as `type=project`
  - run code indexing
  - create module/component entities
  - seed baseline semantic claims
  - seed memory blocks
  - compile the wiki
  - trigger the viewer refresh
  - return URLs and counts

### 6. First-Run Smoke Test Is Incomplete

- Setup should prove more than container health.
- We needed to manually verify token auth, MCP initialize, and tool listing.

Fix:

- Add an authenticated smoke test that proves:
  - token works
  - `/mcp` initialize works
  - `tools/list` returns expected `berry_*` tools
  - optional domains can be enabled
  - wiki endpoint responds when enabled

### 7. Token And Client Config Are Manual

- Setup generates or expects a token but does not configure clients.
- We had to manually reconcile Codex config, Claude config, and env vars after
  restore.

Fix:

- Add optional setup flags:
  - `--configure-codex`
  - `--configure-claude`
  - `--token-from-env`
  - `--print-env-snippets`

- Generate PowerShell and Bash snippets for persistent environment variables.

### 8. Docs Mix Old AMP, Systemd, And Cerebro-Specific Assumptions

- Examples still reference old AMP names, paths, systemd service names, Cerebro
  IPs, and SSE-era language.

Fix:

- Split docs into:
  - generic local Docker install
  - remote/server Docker install
  - systemd production install
  - migration from AMP

### 9. No Product-Ready Dashboard Or Doctor Command

- A user can have a healthy MCP server but no obvious next action.
- Wiki status, settings, code index status, graph counts, and tool health should
  be discoverable.

Fix:

- Add a `memberry doctor` command or small status page showing:
  - MCP health
  - token/auth status
  - OpenAI embedding mode
  - graph counts
  - indexed projects
  - wiki status
  - suggested next command

### 10. Dynamic Tool Exposure Is Fragile In Some Clients

- `berry_tools(action: "enable", domain: "...")` made tools available
  server-side, but Codex did not refresh its typed tool schema.
- We had to use raw MCP `tools/list` and `tools/call`.

Fix:

- Keep critical first-run tools always exposed, or provide stable wrapper tools
  that dispatch internally.
- Document which clients support dynamic tool refresh and which do not.

### 11. `berry_code_index` Lacks Stable Project Scoping

- Code symbols were scoped by indexed file paths and staging folder names.
- The user-facing project was not cleanly `project:Agent-Assist-CR`.

Fix:

- Add `project_name` and `project_tag` arguments to `berry_code_index`.
- Store project scope directly on Symbol nodes.
- Make `berry_code_search` project filtering use that scope before path
  heuristics.

### 12. Code Indexing And Wiki Knowledge Are Disconnected

- `berry_code_index` created Symbol nodes for code intelligence.
- The wiki did not show project entities from that alone.
- We had to run `berry_ingest_codebase`, then manually seed architecture
  entities and semantics.

Fix:

- The project setup command should bridge code symbols into wiki-visible
  project/module/component entities.
- The UI/docs should clearly distinguish code-symbol index from wiki entity
  graph.

### 13. Wiki Project Discovery Relies Too Much On Task Strings

- A stored episode with `scope=project:Agent-Assist-CR` and tags was not enough
  for project discovery.
- The wiki compiler relied on task text like `[project:Agent-Assist-CR]`.

Fix:

- Use structured `scope` and `tags` as the canonical project association.
- Keep task-prefix parsing only as a backward-compatible fallback.

### 14. `berry_ingest_codebase` Can Create The Root Project As `concept`

- The root `Agent-Assist-CR` entity existed as `type=concept`.
- The wiki compiler only discovers `Entity {type: "project"}`.
- We had to correct that graph property manually.

Fix:

- `berry_bootstrap` and `berry_ingest_codebase` should upsert or promote exact
  project-name entities to `type=project`.
- Add a regression test for an existing concept with the same project name.

### 15. Wiki Materialization Is Disconnected From Graph Updates

- MCP graph updates did not automatically update the served wiki.
- MCP and wiki containers did not share compiled output.
- We had to compile inside the wiki container.

Fix:

- Use a shared wiki volume.
- Add a rebuild endpoint or watcher.
- Trigger wiki refresh after project setup, ingest, bootstrap, or store events
  when the wiki service is enabled.

### 16. Default Codebase Ingestion Seeds Too Little Human-Readable Content

- Ingestion found modules like `src`, `electron`, and `engine`, but the wiki
  still needed additional semantic seeds to become useful.

Fix:

- Generate baseline semantics for every bootstrapped module/component.
- Include entry points, responsibilities, likely public interfaces, and
  relationship summaries.

### 17. Lint CLI Hides Useful Details

- CLI lint printed summary counts only.
- MCP lint returned actionable issue details.

Fix:

- Print issue details by default in CLI.
- Add `--summary-only` for terse output.

### 18. Legacy AMP Branding Still Leaks Into Agents And Product Surfaces

- Local Codex skills are still named `amp`, `amp-setup`, and `amp-wiki`.
- Global agent instructions still mention `$amp-setup` as the compatibility
  workflow.
- Some local skills still say "Use AMP memory".
- The MemBerry repo still contains internal strings such as `[amp-store]`,
  `[amp-code]`, `[amp-hook]`, `amp_id`, `.amp-edit`, and `/tmp/amp-*`.

Fix:

- Rename active skill handles to `memberry`, `memberry-setup`, and
  `memberry-wiki`.
- Keep `amp-*` only as hidden/backward-compatible aliases where necessary.
- Update global instructions and dependent skills to say MemBerry by default.
- Rename user-facing log prefixes, CSS/DOM classes, docs, examples, and tests.
- Decide whether internal schema fields like `amp_id` should migrate or stay as
  legacy-compatible internals with no user-facing exposure.

## Not MemBerry Bugs

- Installing Docker, Git, sudo, Node.js, or base Debian packages on a fresh
  server is host provisioning.
- Rebuilding Cerebro Control Center and Apache gateway is Cerebro-specific.
- Old memory data being gone was expected because the Neo4j volume lived on the
  failed disk.
- Windows SSH host-key and PowerShell quoting issues are environment friction,
  not MemBerry product defects.

## Proposed Upstream Issue Groups

### A. Install And Client Setup

- Remote/server mode
- Claude/Codex config generation
- token and environment setup
- authenticated smoke test

### B. Project Bootstrap

- workspace mount
- one-command project setup
- code index
- project entity upsert
- baseline semantic seeding

### C. Wiki Runtime

- wiki Compose service
- shared compiled output
- auto-refresh/rebuild
- visible project/entity pages after setup

### D. Data Model And Scoping

- canonical structured project scope
- `type=project` promotion
- Symbol nodes scoped by project tag
- wiki compiler uses structured scope/tags

### E. Naming And Rebrand Cleanup

- remove active AMP skill names
- remove user-facing AMP logs/docs/UI
- preserve legacy aliases only where migration requires them

## Acceptance Target

A fresh open-source install should support this path:

```text
memberry setup --mode server --with-wiki --workspace /home/cerebro/projects
memberry configure codex --url http://HOST:3101/mcp
memberry configure claude --url http://HOST:3101/mcp
memberry project setup /workspace/my-project --project-name MyProject --with-wiki
memberry doctor
```

Expected outcome:

- MCP is reachable from the intended client machine.
- Authenticated `tools/list` returns expected `berry_*` tools.
- Code indexing can read the selected project path.
- The graph contains a `type=project` root entity.
- Wiki shows project, entities, topics, and recent sessions.
- Lint has no broken links, missing links, or orphan pages.
