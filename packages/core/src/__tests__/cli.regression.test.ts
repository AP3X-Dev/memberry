// packages/core/src/__tests__/cli.regression.test.ts
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const CLI_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../cli.ts'),
  'utf-8',
);

describe('cli.ts regression', () => {
  it('BUG-0002: must not use execSync with interpolated strings (shell injection)', () => {
    // Before the fix, runSnapshot() used execSync(`git commit -m "${message}"`)
    // which allowed shell command injection via $(…) or backtick substitution.
    // The fix replaced all execSync calls with execFileSync using array arguments.

    // Verify no execSync usage with template literals or string concatenation
    const execSyncWithTemplate = /execSync\s*\(\s*`/;
    const execSyncWithConcat = /execSync\s*\(\s*['"][^'"]*['"]\s*\+/;
    const execSyncWithVariable = /execSync\s*\(\s*[a-zA-Z]/;

    expect(CLI_SOURCE).not.toMatch(execSyncWithTemplate);
    expect(CLI_SOURCE).not.toMatch(execSyncWithConcat);
    expect(CLI_SOURCE).not.toMatch(execSyncWithVariable);

    // Additionally verify execSync is not imported at all (only execFileSync should be)
    const importsExecSync = /import\s*\{[^}]*\bexecSync\b[^}]*\}\s*from\s*['"]child_process['"]/;
    expect(CLI_SOURCE).not.toMatch(importsExecSync);
  });

  it('snapshot commit force-adds the requested path so ignored .amp exports can be committed', () => {
    expect(CLI_SOURCE).toContain("execFileSync('git', ['add', '-f', snapshotPath]");
  });

  it('snapshot commit only checks and commits the requested snapshot path', () => {
    expect(CLI_SOURCE).toContain("execFileSync('git', ['diff', '--cached', '--quiet', '--', snapshotPath]");
    expect(CLI_SOURCE).toContain("execFileSync('git', ['commit', '-m', message, '--', snapshotPath]");
  });

  it('wires the setup/configure/project/doctor spine into the dispatcher', () => {
    // Source-pin the new top-level command tokens so the dispatcher can't silently
    // lose them. Their full behavior lands in follow-up tasks; the routing is here.
    for (const token of ["case 'setup'", "case 'configure'", "case 'project'", "case 'doctor'"]) {
      expect(CLI_SOURCE, `cli.ts must handle ${token}`).toContain(token);
    }
  });

  it('delegates the new commands to their modules', () => {
    expect(CLI_SOURCE).toContain('await runSetup(flags)');
    expect(CLI_SOURCE).toContain('await runConfigure(positionals, flags)');
    expect(CLI_SOURCE).toContain('await runProject(positionals, flags)');
    expect(CLI_SOURCE).toContain('await runDoctor(flags)');
  });
});
