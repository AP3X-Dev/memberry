// packages/core/src/__tests__/setup.test.ts
//
// Unit tests for `memberry setup` (OPT-14). execFileSync and process.platform are
// mocked so we never spawn a real bash. We cover:
//   - resolveRepoRoot: finds the root from a packages/ marker path; falls back to
//     process.cwd() when the marker is absent.
//   - runSetup win32 early-exit: prints WSL/Git-Bash guidance, never spawns bash.
//   - runSetup ENOENT (bash missing) vs. non-zero script exit are distinguished.
//   - the child's exit code is propagated.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

// execFileSync is a named ESM import in setup.ts, so we can't vi.spyOn the live
// binding (the module namespace isn't configurable). Mock the module instead and
// reconfigure the single execFileSync mock per-test. vi.hoisted keeps the mock fn
// available inside the hoisted vi.mock factory.
const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }));

import { resolveRepoRoot, runSetup } from '../cli/setup.js';

const ORIG_PLATFORM = process.platform;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}
function restorePlatform(): void {
  Object.defineProperty(process, 'platform', { value: ORIG_PLATFORM, configurable: true });
}

describe('setup: resolveRepoRoot', () => {
  afterEach(() => vi.restoreAllMocks());

  it('derives the repo root from the path above the first packages/ segment', () => {
    const sep = path.sep;
    const root = `${sep}home${sep}me${sep}memberry`;
    const here = `${root}${sep}packages${sep}core${sep}src${sep}cli${sep}setup.ts`;
    // Accept the fabricated candidate as the repo root (it isn't real on disk).
    vi.spyOn(fs, 'existsSync').mockImplementation((p: any) =>
      String(p) === path.join(root, 'scripts', 'setup.sh'),
    );
    expect(resolveRepoRoot(here)).toBe(root);
  });

  it('falls back to process.cwd() when the packages/ marker is absent', () => {
    // No packages/ marker → the only candidate is process.cwd(); we force that
    // candidate to validate so the fallback is deterministic regardless of CWD.
    const noMarker = `${path.sep}somewhere${path.sep}else${path.sep}file.ts`;
    vi.spyOn(fs, 'existsSync').mockImplementation((p: any) =>
      String(p) === path.join(process.cwd(), 'scripts', 'setup.sh'),
    );
    expect(resolveRepoRoot(noMarker)).toBe(process.cwd());
  });

  it('returns the first candidate (cwd) when nothing validates', () => {
    // import.meta path empty AND no scripts/setup.sh anywhere → best-guess is cwd.
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(resolveRepoRoot('')).toBe(process.cwd());
  });
});

describe('setup: runSetup', () => {
  let errSpy: any;
  let existsSpy: any;

  beforeEach(() => {
    execFileSyncMock.mockReset();
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Throwing exit so we can assert the code without unwinding into bash.
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit__${code ?? 0}`);
    }) as any);
    // Make the installer script always appear present so we exercise the spawn path.
    existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
  });

  afterEach(() => {
    restorePlatform();
    existsSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('on win32 prints WSL/Git-Bash guidance and never spawns bash', async () => {
    setPlatform('win32');
    execFileSyncMock.mockImplementation(() => {
      throw new Error('execFileSync must not be called on win32');
    });

    await expect(runSetup({})).rejects.toThrow('__exit__1');
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.flat().join('\n')).toMatch(/WSL or Git Bash/);
  });

  it('distinguishes ENOENT (bash missing) and prints the bash guidance', async () => {
    setPlatform('linux');
    execFileSyncMock.mockImplementation(() => {
      const e: any = new Error('spawn bash ENOENT');
      e.code = 'ENOENT';
      throw e;
    });

    await expect(runSetup({})).rejects.toThrow('__exit__1');
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls.flat().join('\n')).toMatch(/WSL or Git Bash/);
  });

  it('propagates the script exit code on a non-zero script exit (not ENOENT)', async () => {
    setPlatform('linux');
    execFileSyncMock.mockImplementation(() => {
      const e: any = new Error('script failed');
      e.status = 42; // child exited non-zero
      throw e;
    });

    await expect(runSetup({})).rejects.toThrow('__exit__42');
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it('runs to completion (no exit) when bash exits 0', async () => {
    setPlatform('linux');
    execFileSyncMock.mockReturnValue(Buffer.from(''));

    await expect(runSetup({})).resolves.toBeUndefined();
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    // Forwarded args start with scripts/setup.sh.
    const callArgs = execFileSyncMock.mock.calls[0];
    expect(callArgs[0]).toBe('bash');
    expect((callArgs[1] as string[])[0]).toBe('scripts/setup.sh');
  });

  it('forwards known string + boolean flags to scripts/setup.sh', async () => {
    setPlatform('linux');
    execFileSyncMock.mockReturnValue(Buffer.from(''));

    await runSetup({ mode: 'server', 'with-wiki': true, yes: true });
    const forwarded = execFileSyncMock.mock.calls[0][1] as string[];
    expect(forwarded).toContain('--mode');
    expect(forwarded).toContain('server');
    expect(forwarded).toContain('--with-wiki');
    expect(forwarded).toContain('--yes');
  });
});
