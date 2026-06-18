// packages/core/src/cli/project.ts
//
// `memberry project <subcommand>` — per-project setup and management. The first
// subcommand is `project setup <path>`, which scaffolds MemBerry config for a
// target project directory. The full implementation lands in a follow-up task;
// this is a clean, non-crashing placeholder that already dispatches on the
// sub-token (mirroring `extraction`/`tenant`) so the body has a stable shape.

type Flags = Record<string, string | boolean>;

function printProjectUsage(): void {
  console.log('Usage: memberry project <subcommand> [options]');
  console.log('');
  console.log('Subcommands:');
  console.log('  setup <path>    scaffold MemBerry config for the project at <path>');
  console.log('');
  console.log('Options:');
  console.log('  --help          show this message');
}

/**
 * Handle `memberry project setup <path>`. `path` is positionals[1] (positionals[0]
 * is the `setup` sub-token). Follow-up task fills the body. Until then it reports
 * cleanly and exits 0.
 */
async function runProjectSetup(positionals: string[], _flags: Flags): Promise<void> {
  const target = positionals[1] ?? '';
  const where = target ? ` for ${target}` : '';
  console.log(`memberry project setup${where}: this command is being finalized — see \`memberry project --help\`.`);
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
