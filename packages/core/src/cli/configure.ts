// packages/core/src/cli/configure.ts
//
// `memberry configure <claude|codex>` — point an agent at a running MemBerry server
// (write the MCP client config, wire hooks, etc.). The full implementation lands
// in a follow-up task; this is a clean, non-crashing placeholder with a stable
// signature for that task to fill in.

type Flags = Record<string, string | boolean>;

const TARGETS = ['claude', 'codex'] as const;
type ConfigureTarget = (typeof TARGETS)[number];

function printConfigureUsage(): void {
  console.log('Usage: memberry configure <claude|codex> [options]');
  console.log('');
  console.log('Point an agent at a running MemBerry server (MCP client config + hooks).');
  console.log('  claude    configure Claude Code (settings.json + hooks)');
  console.log('  codex     configure Codex (.codex/config.toml + context)');
  console.log('');
  console.log('Options:');
  console.log('  --help    show this message');
}

/**
 * Entry. `positionals` is everything after `memberry configure` (so positionals[0]
 * is the target agent); `flags` are the parsed `--name [value]` options.
 *
 * Follow-up task fills the body per target. Until then this validates the target,
 * prints usage, and exits cleanly — it never throws or crashes.
 */
export async function runConfigure(positionals: string[], flags: Flags): Promise<void> {
  if (flags['help'] === true) {
    printConfigureUsage();
    return;
  }

  const target = positionals[0] as ConfigureTarget | undefined;
  if (!target || !TARGETS.includes(target)) {
    printConfigureUsage();
    return;
  }

  console.log(`memberry configure ${target}: this command is being finalized — see \`memberry configure --help\`.`);
}
