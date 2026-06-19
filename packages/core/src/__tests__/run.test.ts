// packages/core/src/__tests__/run.test.ts
//
// Unit test for `memberry run` (OPT-16): on Windows, agent shims (codex/npx/npm)
// are .cmd/.bat files that node can't exec directly, so spawn must pass
// shell:true there (and shell:false on posix). spawn, the core services factory,
// and materializeContext are all mocked — nothing real is launched.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// vi.hoisted keeps the mock fn available inside the hoisted vi.mock factory.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('../services-factory.js', () => ({
  createCoreServices: () => ({ close: async () => {} }),
}));
vi.mock('../cli/adapters/materialized.js', () => ({
  materializeContext: async () => {},
}));

import { runRunCommand } from '../cli/run.js';

const ORIG_PLATFORM = process.platform;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}
function restorePlatform(): void {
  Object.defineProperty(process, 'platform', { value: ORIG_PLATFORM, configurable: true });
}

/** A fake child that swallows the exit/error listeners so runRunCommand resolves. */
function fakeChild(): any {
  return { on: vi.fn() };
}

describe('run: spawn shell option (OPT-16)', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockReturnValue(fakeChild());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    restorePlatform();
    vi.restoreAllMocks();
  });

  it('passes shell:true on win32 so .cmd/.bat shims launch', async () => {
    setPlatform('win32');
    await runRunCommand(['--agent', 'codex', '--', 'codex', 'exec']);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe('codex');
    expect(args).toEqual(['exec']);
    expect(opts.shell).toBe(true);
    expect(opts.stdio).toBe('inherit');
  });

  it('passes shell:false on posix', async () => {
    setPlatform('linux');
    await runRunCommand(['--agent', 'codex', '--', 'codex', 'exec']);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, , opts] = spawnMock.mock.calls[0];
    expect(opts.shell).toBe(false);
  });
});
