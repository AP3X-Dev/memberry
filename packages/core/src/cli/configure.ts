// packages/core/src/cli/configure.ts
//
// `memberry configure <claude|codex>` — point an agent at a running MemBerry
// server by emitting (and, with --write, persisting) the MCP client config.
//
// The working transport is **streamable HTTP** at `/mcp` (NOT /sse). Claude Code
// requires an explicit `"type": "http"` discriminator in the server entry — a
// bare `{ url, headers }` is treated as the legacy stdio/sse shape and silently
// fails to connect. That `"type": "http"` is the load-bearing fix here.
//
// Config shapes are produced by pure helpers so they are unit-testable without
// touching the filesystem; --write merges idempotently via the install.ts I/O
// helpers (readJson/writeJson for Claude) and a TOML-block merge for Codex.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

type Flags = Record<string, string | boolean>;

const TARGETS = ['claude', 'codex'] as const;
type ConfigureTarget = (typeof TARGETS)[number];

/** The env var Codex reads the bearer token from (never the literal token). */
const TOKEN_ENV_VAR = 'MEMBERRY_API_TOKEN';

// ─── Resolution ────────────────────────────────────────────────────────────────

/**
 * Resolve the MCP URL: `--url` → `MEMBERRY_MCP_URL` → composed from
 * `MEMBERRY_PUBLIC_HOST` (default `localhost`) and `MCP_PORT` (default `3101`),
 * always terminating in the `/mcp` streamable-HTTP path.
 */
export function resolveUrl(flags: Flags, env: NodeJS.ProcessEnv = process.env): string {
  if (typeof flags['url'] === 'string' && flags['url']) return flags['url'];
  if (env['MEMBERRY_MCP_URL']) return env['MEMBERRY_MCP_URL'];
  const host = env['MEMBERRY_PUBLIC_HOST'] || 'localhost';
  const port = env['MCP_PORT'] || '3101';
  return `http://${host}:${port}/mcp`;
}

/** Resolve the bearer token: `--token` → `MEMBERRY_API_TOKEN` env → undefined. */
export function resolveToken(flags: Flags, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (typeof flags['token'] === 'string' && flags['token']) return flags['token'];
  return env[TOKEN_ENV_VAR] || undefined;
}

// ─── Pure config shapes (unit-testable) ─────────────────────────────────────────

export interface ClaudeMcpEntry {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

/**
 * The Claude Code MCP server entry. `"type": "http"` is mandatory — without it
 * Claude does not use the streamable-HTTP transport and the server never
 * connects. When a token is present we attach an `Authorization: Bearer` header.
 */
export function claudeMcpEntry(url: string, token?: string): ClaudeMcpEntry {
  const entry: ClaudeMcpEntry = { type: 'http', url };
  if (token) entry.headers = { Authorization: `Bearer ${token}` };
  return entry;
}

/** The exact `claude mcp add-json` command form (single-quoted JSON arg). */
export function claudeAddJsonCommand(url: string, token?: string): string {
  return `claude mcp add-json memberry '${JSON.stringify(claudeMcpEntry(url, token))}'`;
}

/** The verified `codex mcp add` CLI form — token comes from an env var, never inline. */
export function codexAddCommand(url: string): string {
  return `codex mcp add memberry --url ${url} --bearer-token-env-var ${TOKEN_ENV_VAR}`;
}

/** The `[mcp_servers.memberry]` TOML block for `~/.codex/config.toml`. */
export function codexTomlBlock(url: string): string {
  return `[mcp_servers.memberry]\nurl = "${url}"\nbearer_token_env_var = "${TOKEN_ENV_VAR}"\n`;
}

// ─── Env snippets (unit-testable) ───────────────────────────────────────────────

export function bashEnvSnippet(url: string, token?: string): string {
  return [
    `export ${TOKEN_ENV_VAR}=${token ?? '<your-token>'}`,
    `export MEMBERRY_MCP_URL=${url}`,
  ].join('\n');
}

export function powershellEnvSnippet(url: string, token?: string): string {
  return [
    `[Environment]::SetEnvironmentVariable('${TOKEN_ENV_VAR}','${token ?? '<your-token>'}','User')`,
    `[Environment]::SetEnvironmentVariable('MEMBERRY_MCP_URL','${url}','User')`,
  ].join('\n');
}

// ─── File I/O paths ─────────────────────────────────────────────────────────────

/** User-level Claude settings (mcpServers live alongside the rest of the config). */
export function claudeConfigPath(home: string = os.homedir()): string {
  return path.join(home, '.claude', 'settings.json');
}

/** User-level Codex config (global MCP servers live in ~/.codex/config.toml). */
export function codexConfigPath(home: string = os.homedir()): string {
  return path.join(home, '.codex', 'config.toml');
}

// ─── Idempotent merges (pure-ish: take + return content) ─────────────────────────

type JsonObject = Record<string, unknown>;

/**
 * Merge the MemBerry server entry into a parsed Claude settings object under
 * `mcpServers.memberry`. Idempotent: re-running with the same inputs yields a
 * deep-equal object, so a second --write never duplicates.
 */
export function mergeClaudeConfig(settings: JsonObject, url: string, token?: string): JsonObject {
  const mcpServers: JsonObject = {
    ...((settings['mcpServers'] as JsonObject | undefined) ?? {}),
  };
  mcpServers['memberry'] = claudeMcpEntry(url, token) as unknown as JsonObject;
  return { ...settings, mcpServers };
}

/**
 * Merge the `[mcp_servers.memberry]` block into existing config.toml text.
 * If a `[mcp_servers.memberry]` block already exists it is replaced in place
 * (idempotent); otherwise the block is appended. Naive but sufficient for the
 * flat blocks Codex writes — we never reorder or drop other tables.
 */
export function mergeCodexToml(existing: string, url: string): string {
  const block = codexTomlBlock(url).trimEnd();
  const header = '[mcp_servers.memberry]';
  const lines = existing.split('\n');
  // Detect an existing block by a line-level EXACT match — a comment line such
  // as `# [mcp_servers.memberry]` must NOT count (a substring `includes` would
  // false-positive and then silently skip the write since the replace loop's
  // exact-match guard never fires).
  const hasBlock = lines.some((l) => l.trim() === header);
  if (!hasBlock) {
    const base = existing.replace(/\s*$/, '');
    return (base ? `${base}\n\n` : '') + `${block}\n`;
  }
  // Replace the existing block in place: from its header line to the next table
  // header (or EOF), preserving a single blank separator before the next table.
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === header) {
      out.push(block);
      i++;
      // Skip the old block body (lines until the next table header or EOF).
      while (i < lines.length && !/^\s*\[/.test(lines[i])) i++;
      // Keep a blank line between our block and a following table.
      if (i < lines.length) out.push('');
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  return out.join('\n').replace(/\s*$/, '') + '\n';
}

// ─── Filesystem helpers (mirror install.ts) ─────────────────────────────────────

function readJsonFile(file: string): JsonObject {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as JsonObject;
  } catch {
    throw new Error(`Existing ${file} is not valid JSON — refusing to overwrite.`);
  }
}

function writeJsonFile(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

// ─── Per-target runners ──────────────────────────────────────────────────────────

function configureClaude(url: string, token: string | undefined, flags: Flags): void {
  const entry = claudeMcpEntry(url, token);
  console.log('Claude Code — MemBerry MCP server config');
  console.log('');
  console.log('Raw server entry (mcpServers.memberry):');
  console.log(JSON.stringify(entry, null, 2));
  console.log('');
  console.log('Or add it via the CLI:');
  console.log(`  ${claudeAddJsonCommand(url, token)}`);
  if (!token) {
    console.log('');
    console.log('Note: no token resolved (pass --token or set MEMBERRY_API_TOKEN). The');
    console.log('      config above omits the Authorization header — add it before connecting.');
  }

  if (flags['write'] === true) {
    const file = claudeConfigPath();
    const merged = mergeClaudeConfig(readJsonFile(file), url, token);
    writeJsonFile(file, merged);
    console.log('');
    console.log(`Wrote mcpServers.memberry → ${file}`);
    console.log('Preview:');
    console.log(JSON.stringify({ mcpServers: { memberry: entry } }, null, 2));
    console.log('Re-running is idempotent (no duplication). Restart Claude Code to pick it up.');
  }
}

function configureCodex(url: string, flags: Flags): void {
  console.log('Codex — MemBerry MCP server config (streamable HTTP)');
  console.log('');
  console.log('Add it via the CLI:');
  console.log(`  ${codexAddCommand(url)}`);
  console.log('');
  console.log('Or add this block to ~/.codex/config.toml:');
  console.log(codexTomlBlock(url).trimEnd());
  console.log('');
  console.log(`(The bearer token is read from the ${TOKEN_ENV_VAR} env var at launch, never stored in the file.)`);

  if (flags['write'] === true) {
    const file = codexConfigPath();
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
    const merged = mergeCodexToml(existing, url);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, merged, 'utf-8');
    console.log('');
    console.log(`Wrote [mcp_servers.memberry] → ${file}`);
    console.log('Re-running is idempotent (the block is replaced in place, not duplicated).');
  }
}

function printEnvSnippets(url: string, token: string | undefined): void {
  console.log('');
  console.log('Environment variable snippets');
  console.log('');
  console.log('Bash / zsh:');
  console.log(bashEnvSnippet(url, token));
  console.log('');
  console.log('PowerShell:');
  console.log(powershellEnvSnippet(url, token));
}

function printConfigureUsage(): void {
  console.log('Usage: memberry configure <claude|codex> [options]');
  console.log('');
  console.log('Point an agent at a running MemBerry server (emit/persist its MCP client config).');
  console.log('  claude    Claude Code — mcpServers.memberry (streamable HTTP at /mcp)');
  console.log('  codex     Codex — [mcp_servers.memberry] in ~/.codex/config.toml');
  console.log('');
  console.log('Options:');
  console.log('  --url URL              MCP URL (else $MEMBERRY_MCP_URL, else http://$MEMBERRY_PUBLIC_HOST:$MCP_PORT/mcp)');
  console.log('  --token TOK           bearer token (else $MEMBERRY_API_TOKEN)');
  console.log('  --write               merge the config into the client config file (idempotent)');
  console.log('  --print-env-snippets  also print Bash + PowerShell env-var snippets');
  console.log('  --help                show this message');
}

/**
 * Entry. `positionals[0]` is the target agent; `flags` are the parsed options.
 * Never throws on bad input — prints a clear error and exits non-zero only when
 * the target is missing/unknown.
 */
export async function runConfigure(positionals: string[], flags: Flags): Promise<void> {
  if (flags['help'] === true) {
    printConfigureUsage();
    return;
  }

  const target = positionals[0] as ConfigureTarget | undefined;
  if (!target || !TARGETS.includes(target)) {
    if (target) console.error(`configure: unknown target "${target}" (expected claude|codex).`);
    else console.error('configure: missing target (expected claude|codex).');
    console.error('');
    printConfigureUsage();
    process.exit(1);
    return;
  }

  const url = resolveUrl(flags);
  const token = resolveToken(flags);

  try {
    if (target === 'claude') configureClaude(url, token, flags);
    else configureCodex(url, flags);

    if (flags['print-env-snippets'] === true) printEnvSnippets(url, token);
  } catch (err) {
    console.error(`configure ${target}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
