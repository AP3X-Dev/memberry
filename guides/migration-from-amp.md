# Migration: from AMP to MemBerry

MemBerry was formerly called **AMP**. The rename touched env vars, config paths,
URI schemes, log prefixes, and the MCP server key. To make upgrades painless,
the canonical names are all `memberry`/`MEMBERRY_*`, but a set of **legacy AMP
aliases is retained** so an existing install keeps working without a flag day.
This page documents exactly what is kept, and the user-facing renames you will
notice.

> Rule of thumb: **`MEMBERRY_*` / `memberry` is canonical; `AMP_*` / `amp` still
> works but is deprecated.** Migrate at your convenience — nothing breaks
> immediately, and the deprecation warnings tell you what to rename.

## Retained backward-compatibility aliases

These are read as fallbacks. New writes always go to the canonical name/path.

### Environment variables: `AMP_*` → `MEMBERRY_*`

Env vars are read with the `MEMBERRY_*` name first; if only the legacy `AMP_*`
name is set, it is used and a **one-time deprecation warning** is logged to
stderr:

```
[memberry] env AMP_<NAME> is deprecated; rename it to MEMBERRY_<NAME>.
```

The fallback lives in `packages/core/src/config/settings.ts` (`readEnv()`), and
the `.env.example` header notes the same one-deprecation-cycle policy. Rename
`AMP_FOO` → `MEMBERRY_FOO` in your env files to silence the warning.

### Config directory: `~/.config/amp` → `~/.config/memberry`

Settings (`settings.json`) are read from `~/.config/memberry/settings.json`
first; if that file does not exist, the legacy `~/.config/amp/settings.json` is
read instead so un-migrated machines keep their existing settings
(`getSettingsPath()` in `settings.ts`). New writes always go to the canonical
`~/.config/memberry` path. `MEMBERRY_SETTINGS_PATH` overrides both.

### Project memory dir: `./.amp` → `./.memberry`

The default export / local-memory directory resolves to `./.memberry` if it
exists, else falls back to `./.amp` (`defaultExportPath()` in `settings.ts`).
The document-conversion cache likewise still lives under `.amp/converted/`
(gitignored). Both `.memberry/` and the legacy `.amp/` are kept in `.gitignore`.

### URI scheme: `amp://` → `memberry://`

`memberry://` is canonical, and `amp://` is still accepted as a legacy alias
(`URI_PREFIXES = ['memberry://', 'amp://']` in `packages/mcp/src/uri.ts`). An
invalid URI's error message documents this: *"must start with `memberry://`
(legacy `amp://` also accepted)"*.

### Legacy frontmatter key: `amp_id`

When parsing wiki frontmatter, both `memberry_id` and the legacy `amp_id` keys
are read and mapped to the internal `memberry_id` field
(`packages/wiki/src/reconcile.ts`). So an article carrying an old `amp_id:` line
still reconciles correctly.

### Transport endpoint: `/sse` (legacy) vs `/mcp` (supported)

The MCP server serves **both** endpoints (`packages/mcp/src/server.ts`):

- **`/mcp`** — the **supported** streamable-HTTP transport. Use this. Claude
  Code requires an explicit `"type": "http"` in the server entry to use it.
- **`/sse`** — the **legacy** SSE transport, retained for older clients. The
  server still logs its SSE listen address on startup, but new configs should
  target `/mcp`.

If you have an old client config pointing at `…:3101/sse`, switch the URL to
`…:3101/mcp` (and add `"type": "http"` for Claude Code). The easiest path is to
re-run `npx tsx packages/core/src/cli.ts configure <claude|codex>`, which always
emits the `/mcp` form.

### Stdio Codex key: `[mcp_servers.amp]`

`hooks install --agent codex --with-mcp` writes a stdio `[mcp_servers.amp]`
block into the **project-local** `./.codex/config.toml` (`addCodexMcp()` in
`packages/core/src/cli/install.ts`), and still does so today — so look there,
not in `~/.codex/config.toml`. The separate `configure codex` command is the
streamable-HTTP path and writes the canonical `[mcp_servers.memberry]` block
into the user-level `~/.codex/config.toml` (`codexConfigPath()` in
`configure.ts`). If a project has a `[mcp_servers.amp]` entry, remove it after
adding the `memberry` one, and drop `--with-mcp` from future hook installs.

## User-facing renames

These are not aliases — they are the new names you will see. No action required
beyond awareness.

### Log prefixes: `[amp-*]` → `[memberry-*]`

Runtime log lines now use `[memberry]` and `[memberry-mcp]` prefixes (e.g. the
MCP server's startup/shutdown lines and the env-deprecation warning above). If
you have log-scraping or alerting that matched `[amp-...]`, update it to
`[memberry-...]`.

> Note: a few **internal-only** identifiers keep the `amp` spelling for
> compatibility (e.g. the hook-group marker `_amp` and the `AMP_HOOK_EVENTS`
> constant in the Claude settings writer). These are never user-facing — they
> exist so previously-installed hook groups are still recognized.

### The MCP server key: `memberry`

The MCP client config key is `memberry` everywhere — `mcpServers.memberry` for
Claude Code and `[mcp_servers.memberry]` for Codex (`configure.ts`). If your
config still has an `amp` server key, add the `memberry` one (via
`configure --write`) and drop the old key.

### Wiki edit UI

The wiki viewer's edit affordance and styling are part of the renamed MemBerry
viewer (`packages/wiki/src/viewer.ts`); there is no retained legacy `.amp-edit`
CSS class to preserve. If you scripted against old wiki DOM/CSS class names,
re-check them against the current viewer markup.

## Not aliased (clarifications)

A couple of things you might expect to be aliased are **not** retained as
code-level aliases, to avoid implying behavior that does not exist:

- **`amp-graph` export format** — there is no legacy `amp-graph` format string.
  The graph export supports `json` and `html` only; the interactive HTML map
  uses `memberry-graph-*` DOM IDs internally, but `amp-graph` was never a
  selectable format.
- **`.amp-edit` CSS class** — not present as a retained legacy class (see Wiki
  edit UI above).

## Migration checklist

1. Rename `AMP_*` env vars → `MEMBERRY_*` (watch for the one-time deprecation
   warning to find them).
2. Move `~/.config/amp/settings.json` → `~/.config/memberry/settings.json` (or
   let the dual-read fallback keep using the old one).
3. Repoint any client config from `/sse` → `/mcp`, adding `"type": "http"` for
   Claude Code — easiest via `configure <claude|codex> --write`.
4. Replace an `amp` / `[mcp_servers.amp]` MCP server key with `memberry` — the
   `amp` one is written into the project-local `./.codex/config.toml`, not
   `~/.codex/config.toml`.
5. Update log-scraping rules from `[amp-*]` → `[memberry-*]`.
