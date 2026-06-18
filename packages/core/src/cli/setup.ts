// packages/core/src/cli/setup.ts
//
// `memberry setup` — the one-command stack bootstrapper. This is a thin, faithful
// wrapper around the canonical guided installer at <repoRoot>/scripts/setup.sh:
// it locates the repo root, verifies the script exists, then shells out to bash
// with every flag the user passed forwarded verbatim. The shell script remains
// the single source of truth for the install flow; this command just makes it
// reachable as `memberry setup` (and gives Windows users a clear next step).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Flags forwarded to scripts/setup.sh verbatim. Boolean flags pass as `--name`;
 * string flags pass as `--name value`. Anything the script doesn't recognize it
 * rejects itself (with --help) — we don't try to second-guess its surface here.
 */
const FORWARDED_FLAGS = [
  'mode',
  'with-wiki',
  'workspace',
  'yes',
  'db-only',
  'reconfigure',
  'configure-claude',
  'configure-codex',
  'token-from-env',
  'print-env-snippets',
] as const;

type Flags = Record<string, string | boolean>;

/**
 * Resolve the repo root that owns scripts/setup.sh.
 *
 * Primary strategy: derive it from this module's own location. At runtime the CLI
 * runs from source under tsx (…/packages/core/src/cli/setup.ts), so the repo root
 * is the path above the first `${sep}packages${sep}` segment. We fall back to a
 * `dist` build location for completeness, then finally to process.cwd().
 *
 * We never trust a single guess: the caller verifies scripts/setup.sh exists at
 * the resolved root before exec, and tries the cwd fallback if it doesn't.
 */
export function resolveRepoRoot(): string {
  const candidates: string[] = [];

  try {
    const here = fileURLToPath(import.meta.url); // …/packages/core/src/cli/setup.ts (or /dist/…)
    const marker = `${path.sep}packages${path.sep}`;
    const idx = here.indexOf(marker);
    if (idx !== -1) candidates.push(here.slice(0, idx));
  } catch {
    // import.meta.url unavailable (shouldn't happen under Node16 ESM) — fall through.
  }

  candidates.push(process.cwd());

  for (const root of candidates) {
    if (fs.existsSync(path.join(root, 'scripts', 'setup.sh'))) return root;
  }
  // Nothing matched — return the best guess (first candidate) so the caller can
  // emit a precise "script not found at <path>" message.
  return candidates[0] ?? process.cwd();
}

/** Rebuild the bash flag list from parsed flags, forwarding only known options. */
function forwardedArgs(flags: Flags): string[] {
  const args: string[] = [];
  for (const name of FORWARDED_FLAGS) {
    const value = flags[name];
    if (value === undefined) continue;
    if (value === true) {
      args.push(`--${name}`);
    } else if (typeof value === 'string') {
      args.push(`--${name}`, value);
    }
  }
  return args;
}

/**
 * Entry. Shells out to scripts/setup.sh with the user's flags. On Windows (or any
 * platform without bash) we can't run the script directly, so we print a clear
 * path forward and exit non-zero rather than failing obscurely.
 */
export async function runSetup(flags: Flags): Promise<void> {
  if (flags['help'] === true) {
    printSetupUsage();
    return;
  }

  const repoRoot = resolveRepoRoot();
  const scriptPath = path.join(repoRoot, 'scripts', 'setup.sh');

  if (!fs.existsSync(scriptPath)) {
    console.error(`memberry setup: could not find the installer script at ${scriptPath}.`);
    console.error('Run this command from inside the MemBerry repository.');
    process.exit(1);
  }

  // Windows / no-bash: scripts/setup.sh is a bash script and needs a POSIX shell.
  if (process.platform === 'win32') {
    console.error('`memberry setup` runs scripts/setup.sh (bash). On Windows, run it under WSL or Git Bash, or use `docker compose --profile app up -d --build` directly.');
    process.exit(1);
  }

  const args = ['scripts/setup.sh', ...forwardedArgs(flags)];
  try {
    execFileSync('bash', args, { stdio: 'inherit', cwd: repoRoot });
  } catch (err: unknown) {
    // execFileSync throws with the child's exit status on a non-zero exit, and
    // with an ENOENT-style error when bash itself is missing. Surface both clearly.
    const status = (err as { status?: number } | null)?.status;
    const code = (err as { code?: string } | null)?.code;
    if (code === 'ENOENT') {
      console.error('`memberry setup` runs scripts/setup.sh (bash). On Windows, run it under WSL or Git Bash, or use `docker compose --profile app up -d --build` directly.');
      process.exit(1);
    }
    // Propagate the script's own exit code so CI/automation sees the real failure.
    process.exit(typeof status === 'number' ? status : 1);
  }
}

function printSetupUsage(): void {
  console.log('Usage: memberry setup [options]');
  console.log('');
  console.log('Stands up the full MemBerry stack (Neo4j + Redis + MCP server) via Docker by');
  console.log('shelling out to scripts/setup.sh. All flags below are forwarded verbatim:');
  console.log('  --mode local|server     local-only (127.0.0.1) or LAN/server (0.0.0.0) access');
  console.log('  --with-wiki             also start the wiki viewer (port 3200)');
  console.log('  --workspace             configure the current workspace');
  console.log('  --yes                   non-interactive; accept all defaults');
  console.log('  --db-only               start only Neo4j + Redis (run the server yourself)');
  console.log('  --reconfigure           re-run the wizard even if .env already exists');
  console.log('  --configure-claude      wire Claude Code hooks after setup');
  console.log('  --configure-codex       wire Codex context after setup');
  console.log('  --token-from-env        reuse an existing MEMBERRY_API_TOKEN from the env');
  console.log('  --print-env-snippets    print client env snippets at the end');
  console.log('');
  console.log('On Windows, run scripts/setup.sh under WSL or Git Bash, or use');
  console.log('`docker compose --profile app up -d --build` directly.');
}
