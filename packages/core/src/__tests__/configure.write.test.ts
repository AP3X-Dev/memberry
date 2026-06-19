// packages/core/src/__tests__/configure.write.test.ts
//
// Coverage for the `memberry configure --write` filesystem path (OPT-13). The pure
// config-shape/merge helpers are unit-tested in configure.test.ts; here we drive
// runConfigure end-to-end against a real tmpdir, exercising the file writes,
// idempotency, the invalid-JSON refusal, and the unknown-target exit.
//
// Injection seam: configureClaude/configureCodex resolve their target files via
// claudeConfigPath()/codexConfigPath(), which default to os.homedir(). We point
// HOME at a tmpdir by stubbing os.homedir — no behavior change to configure.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runConfigure } from '../cli/configure.js';

let tmpHome: string;
let homedirSpy: any;
let logSpy: any;
let errSpy: any;
let exitSpy: any;

const URL1 = 'http://localhost:3101/mcp';

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memberry-cfg-'));
  homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  // Throw on exit so we can assert it fired without actually killing the runner.
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__exit__${code ?? 0}`);
  }) as any);
});

afterEach(() => {
  homedirSpy.mockRestore();
  logSpy.mockRestore();
  errSpy.mockRestore();
  exitSpy.mockRestore();
  vi.restoreAllMocks();
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const claudeFile = (): string => path.join(tmpHome, '.claude', 'settings.json');
const codexFile = (): string => path.join(tmpHome, '.codex', 'config.toml');

describe('configure --write: Claude (JSON)', () => {
  it('writes the merged mcpServers.memberry entry with type:http + Bearer header', async () => {
    await runConfigure(['claude'], { write: true, url: URL1, token: 'mbry_abc' });

    const written = JSON.parse(fs.readFileSync(claudeFile(), 'utf-8'));
    expect(written.mcpServers.memberry).toEqual({
      type: 'http',
      url: URL1,
      headers: { Authorization: 'Bearer mbry_abc' },
    });
  });

  it('is idempotent: a second --write produces deep-equal content (no duplication)', async () => {
    await runConfigure(['claude'], { write: true, url: URL1, token: 'mbry_abc' });
    const first = fs.readFileSync(claudeFile(), 'utf-8');
    await runConfigure(['claude'], { write: true, url: URL1, token: 'mbry_abc' });
    const second = fs.readFileSync(claudeFile(), 'utf-8');
    expect(second).toBe(first);
    expect(Object.keys(JSON.parse(second).mcpServers)).toEqual(['memberry']);
  });

  it('preserves other settings already in the file', async () => {
    fs.mkdirSync(path.dirname(claudeFile()), { recursive: true });
    fs.writeFileSync(claudeFile(), JSON.stringify({ model: 'opus', mcpServers: { other: { url: 'x' } } }), 'utf-8');
    await runConfigure(['claude'], { write: true, url: URL1, token: 'mbry_abc' });
    const written = JSON.parse(fs.readFileSync(claudeFile(), 'utf-8'));
    expect(written.model).toBe('opus');
    expect(written.mcpServers.other).toEqual({ url: 'x' });
    expect(written.mcpServers.memberry.type).toBe('http');
  });

  it('refuses to clobber a malformed existing JSON file (exit 1, file untouched)', async () => {
    fs.mkdirSync(path.dirname(claudeFile()), { recursive: true });
    fs.writeFileSync(claudeFile(), '{ this is not: valid json ', 'utf-8');

    // runConfigure catches the readJsonFile throw and calls process.exit(1) (our
    // spy turns that into a throwing sentinel).
    await expect(runConfigure(['claude'], { write: true, url: URL1, token: 'mbry_abc' })).rejects.toThrow('__exit__1');

    // The malformed file was NOT overwritten.
    expect(fs.readFileSync(claudeFile(), 'utf-8')).toBe('{ this is not: valid json ');
    expect(errSpy.mock.calls.flat().join('\n')).toMatch(/not valid JSON — refusing to overwrite/);
  });
});

describe('configure --write: Codex (TOML)', () => {
  it('writes the [mcp_servers.memberry] block with url + bearer_token_env_var', async () => {
    await runConfigure(['codex'], { write: true, url: URL1 });
    const toml = fs.readFileSync(codexFile(), 'utf-8');
    expect(toml).toContain('[mcp_servers.memberry]');
    expect(toml).toContain(`url = "${URL1}"`);
    expect(toml).toContain('bearer_token_env_var = "MEMBERRY_API_TOKEN"');
  });

  it('is idempotent: a second --write does not duplicate the block', async () => {
    await runConfigure(['codex'], { write: true, url: URL1 });
    const first = fs.readFileSync(codexFile(), 'utf-8');
    await runConfigure(['codex'], { write: true, url: URL1 });
    const second = fs.readFileSync(codexFile(), 'utf-8');
    expect(second).toBe(first);
    expect(second.split('[mcp_servers.memberry]').length - 1).toBe(1);
  });
});

describe('configure: unknown target', () => {
  it('triggers process.exit(1) on an unknown target', async () => {
    await expect(runConfigure(['nonsense'], {})).rejects.toThrow('__exit__1');
    expect(errSpy.mock.calls.flat().join('\n')).toMatch(/unknown target "nonsense"/);
  });

  it('triggers process.exit(1) when the target is missing', async () => {
    await expect(runConfigure([], {})).rejects.toThrow('__exit__1');
    expect(errSpy.mock.calls.flat().join('\n')).toMatch(/missing target/);
  });
});
