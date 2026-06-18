// packages/core/src/cli/project.ts
//
// `memberry project <subcommand>` — per-project setup and management. The first
// subcommand is `project setup <path>`, a one-command bootstrap that scans, graphs,
// indexes, and (optionally) wikis a project.
//
// ARCHITECTURE: the full scan→bootstrap→index→bridge→seed pipeline already exists
// as the MCP tool `berry_ingest_codebase`, and the wiki build as `berry_compile`.
// Both live in @memberry/mcp / @memberry/wiki, which depend on @memberry/core — so
// core CANNOT import them (dependency cycle). Therefore `project setup` is a thin
// AUTHENTICATED MCP CLIENT that drives a RUNNING server's tools over HTTP `/mcp`.
// The server does the work on its mounted workspace; the path arg is
// server/container-relative. This reuses the whole pipeline with no refactor and
// matches the deployment model. (See cli/mcp-client.ts for the transport.)

import { resolveUrl, resolveToken } from './configure.js';
import {
  mcpInitialize,
  mcpCall,
  mcpEnableDomain,
  toolCallText,
  McpClientError,
  type McpSession,
} from './mcp-client.js';

type Flags = Record<string, string | boolean>;

function printProjectUsage(): void {
  console.log('Usage: memberry project <subcommand> [options]');
  console.log('');
  console.log('Subcommands:');
  console.log('  setup <path>    bootstrap a project: scan → graph → index → (optional) wiki');
  console.log('');
  console.log('  memberry project setup <path> --project-name <name> [options]');
  console.log('');
  console.log('Drives a RUNNING MemBerry server over /mcp: berry_ingest_codebase (and');
  console.log('berry_compile with --with-wiki). <path> is resolved on the SERVER (its mounted');
  console.log('workspace), not locally.');
  console.log('');
  console.log('Options:');
  console.log('  --project-name <name>   project name (recommended; else the server detects it)');
  console.log('  --project-tag <tag>     project tag (else derived as project:<name>)');
  console.log('  --with-wiki             also compile the wiki (berry_compile) and refresh the viewer');
  console.log('  --url URL               MCP URL (else $MEMBERRY_MCP_URL, else http://$MEMBERRY_PUBLIC_HOST:$MCP_PORT/mcp)');
  console.log('  --token TOK             bearer token (else $MEMBERRY_API_TOKEN)');
  console.log('  --help                  show this message');
}

/** Pull a string flag value (or undefined for absent / boolean-only flags). */
function strFlag(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' && v ? v : undefined;
}

/**
 * Parse a `**Key:** value` line out of the markdown summary `berry_ingest_codebase`
 * returns, so we can echo real counts (files/symbols/entities/...) in the final
 * summary without re-deriving them. Returns undefined when the label is absent.
 */
export function parseSummaryField(text: string, label: string): string | undefined {
  // Match a bolded `**Label:** value` line; the label may contain spaces/parens.
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\*\\*${escaped}:\\*\\*\\s*(.+)`);
  const m = text.match(re);
  return m ? m[1].trim() : undefined;
}

/**
 * Derive the wiki viewer base URL from the resolved MCP URL: the viewer always
 * serves on port 3200 (docker-compose, scripts/setup.sh, packages/wiki/cli.ts), on
 * the same host the MCP server is reached at. Falls back to localhost.
 */
export function wikiBaseUrl(mcpUrl: string): string {
  try {
    const u = new URL(mcpUrl);
    return `${u.protocol}//${u.hostname}:3200`;
  } catch {
    return 'http://localhost:3200';
  }
}

/** Best-effort POST to the wiki viewer's `/api/refresh`. Never throws. */
async function refreshWikiViewer(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/refresh`, { method: 'POST' });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Handle `memberry project setup <path>`. `path` is positionals[1] (positionals[0]
 * is the `setup` sub-token). Drives a running server's ingestion (and optional wiki
 * compile) over /mcp. Returns 0 on success; sets a non-zero exit code with a clear
 * message on missing path / missing token / unreachable server / tool error.
 */
async function runProjectSetup(positionals: string[], flags: Flags): Promise<void> {
  const target = positionals[1];
  if (!target) {
    console.error('project setup: missing <path> (the project directory on the SERVER to bootstrap).');
    console.error('');
    printProjectUsage();
    process.exitCode = 1;
    return;
  }

  const url = resolveUrl(flags);
  const token = resolveToken(flags);
  if (!token) {
    console.error('project setup: no API token resolved. Pass --token or set MEMBERRY_API_TOKEN.');
    process.exitCode = 1;
    return;
  }

  const projectName = strFlag(flags, 'project-name');
  const projectTag = strFlag(flags, 'project-tag');
  const withWiki = flags['with-wiki'] === true;

  let session: McpSession;
  try {
    // 1. Handshake: initialize → notifications/initialized.
    console.log(`Connecting to MemBerry MCP server at ${url} ...`);
    session = await mcpInitialize(url, token);

    // 2. Enable the admin domain (berry_ingest_codebase is Tier-2 / admin).
    await mcpEnableDomain(session, 'admin');

    // 3. Run the full pipeline on the server's workspace.
    const ingestArgs: Record<string, unknown> = { path: target };
    if (projectName) ingestArgs.project_name = projectName;
    if (projectTag) ingestArgs.project_tag = projectTag;
    console.log(`Ingesting ${target} (berry_ingest_codebase) ...`);
    const ingestResult = await mcpCall(session, 'berry_ingest_codebase', ingestArgs);
    const ingestText = toolCallText(ingestResult);

    // Pull the headline counts back out of the returned summary.
    const resolvedProject = parseSummaryField(ingestText, 'Project') ?? projectName ?? '(server-detected)';
    const counts = {
      files: parseSummaryField(ingestText, 'Files indexed'),
      symbolsCreated: parseSummaryField(ingestText, 'Symbols created'),
      symbolsUpdated: parseSummaryField(ingestText, 'Symbols updated'),
      entities: parseSummaryField(ingestText, 'Entities bootstrapped'),
      semantics: parseSummaryField(ingestText, 'Semantic seeds'),
      modules: parseSummaryField(ingestText, 'Modules'),
      languages: parseSummaryField(ingestText, 'Languages'),
    };

    // 4. Optionally compile + serve the wiki.
    let wikiCompiled = false;
    let wikiRefreshed = false;
    let wikiSummary: string | undefined;
    if (withWiki) {
      // berry_compile is Tier-2 / wiki domain.
      await mcpEnableDomain(session, 'wiki');
      const compileArgs: Record<string, unknown> = {};
      if (projectTag) compileArgs.project_tag = projectTag;
      else if (projectName) compileArgs.project_tag = `project:${projectName}`;
      console.log('Compiling wiki (berry_compile) ...');
      const compileResult = await mcpCall(session, 'berry_compile', compileArgs);
      wikiSummary = toolCallText(compileResult);
      wikiCompiled = true;
      // Best-effort viewer refresh — non-fatal whether reachable or not.
      wikiRefreshed = await refreshWikiViewer(wikiBaseUrl(url));
    }

    // 5. Final summary.
    const wiki = wikiBaseUrl(url);
    console.log('');
    console.log('MemBerry project setup complete.');
    console.log(`  Project:   ${resolvedProject}`);
    if (projectTag) console.log(`  Tag:       ${projectTag}`);
    if (counts.languages) console.log(`  Languages: ${counts.languages}`);
    if (counts.files) console.log(`  Files:     ${counts.files}`);
    if (counts.symbolsCreated || counts.symbolsUpdated) {
      console.log(`  Symbols:   ${counts.symbolsCreated ?? '0'} created, ${counts.symbolsUpdated ?? '0'} updated`);
    }
    if (counts.entities) console.log(`  Entities:  ${counts.entities}`);
    if (counts.semantics) console.log(`  Semantics: ${counts.semantics}`);
    if (counts.modules) console.log(`  Modules:   ${counts.modules}`);
    console.log(`  MCP URL:   ${url}`);
    if (withWiki && wikiCompiled) {
      console.log(`  Wiki:      ${wiki}/wiki/_index ${wikiRefreshed ? '(viewer refreshed)' : '(compiled; viewer refresh skipped/unreachable)'}`);
    } else if (withWiki) {
      console.log(`  Wiki:      ${wiki}/wiki/_index`);
    }
  } catch (err) {
    if (err instanceof McpClientError) {
      console.error(`project setup: ${err.message}`);
    } else {
      console.error(`project setup: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = 1;
  }
}

/**
 * Entry. `positionals` is everything after `memberry project` (positionals[0] is the
 * subcommand, e.g. `setup`); `flags` are the parsed `--name [value]` options. Never
 * throws or crashes — unknown subcommands print usage and exit cleanly.
 */
export async function runProject(positionals: string[], flags: Flags): Promise<void> {
  if (flags['help'] === true) {
    printProjectUsage();
    return;
  }

  const sub = positionals[0] ?? '';
  switch (sub) {
    case 'setup':
      await runProjectSetup(positionals, flags);
      break;
    default:
      printProjectUsage();
      break;
  }
}
