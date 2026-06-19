// packages/mcp/src/__tests__/wiki-autorefresh.test.ts
//
// gap-15 (T10): the OPT-IN wiki autorefresh trigger must be GUARDED. The key
// safety property under test: with MEMBERRY_WIKI_AUTOREFRESH unset (the default),
// a store / bootstrap / ingest NEVER invokes the compiler — behavior is unchanged
// from T9. With it set AND the output dir present, a store schedules exactly one
// debounced full recompile, and bootstrap/ingest trigger an immediate one.
//
// The real WikiCompiler is NOT exercised here — we inject a mock recompile fn via
// configureWikiAutorefresh() and assert how/when it is called.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  configureWikiAutorefresh,
  isWikiAutorefreshEnabled,
  recompileWikiNow,
  resetWikiAutorefresh,
  resolveWikiOutputDir,
  scheduleWikiRecompile,
  WIKI_RECOMPILE_DEBOUNCE_MS,
  DEFAULT_WIKI_OUTPUT_DIR,
} from '../wiki-autorefresh.js';

// A real, existing dir so the dir-existence half of the guard passes when we want
// it to. Created once per case under the OS temp dir.
let outputDir: string;

function setEnv(autorefresh: string | undefined, dir: string | undefined): void {
  if (autorefresh === undefined) delete process.env['MEMBERRY_WIKI_AUTOREFRESH'];
  else process.env['MEMBERRY_WIKI_AUTOREFRESH'] = autorefresh;
  if (dir === undefined) delete process.env['MEMBERRY_WIKI_OUTPUT_DIR'];
  else process.env['MEMBERRY_WIKI_OUTPUT_DIR'] = dir;
}

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-autorefresh-'));
  resetWikiAutorefresh();
  setEnv(undefined, undefined);
});

afterEach(() => {
  resetWikiAutorefresh();
  setEnv(undefined, undefined);
  vi.useRealTimers();
  try {
    fs.rmSync(outputDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('wiki autorefresh guard (gap-15)', () => {
  it('DEFAULT (env unset) is a STRICT no-op: store schedule never calls the compiler', () => {
    vi.useFakeTimers();
    const recompile = vi.fn(async () => {});
    configureWikiAutorefresh({ recompile, outputDir });
    setEnv(undefined, outputDir); // dir exists, but flag is OFF

    expect(isWikiAutorefreshEnabled()).toBe(false);

    scheduleWikiRecompile();
    vi.advanceTimersByTime(WIKI_RECOMPILE_DEBOUNCE_MS * 5);
    expect(recompile).not.toHaveBeenCalled();
  });

  it('DEFAULT (env unset) is a strict no-op: immediate recompileWikiNow does not call the compiler', async () => {
    const recompile = vi.fn(async () => {});
    configureWikiAutorefresh({ recompile, outputDir });
    setEnv(undefined, outputDir);

    await recompileWikiNow();
    expect(recompile).not.toHaveBeenCalled();
  });

  it('off when flag set but output dir is MISSING (misconfig no-ops, not errors)', () => {
    const recompile = vi.fn(async () => {});
    const missing = path.join(outputDir, 'does-not-exist');
    configureWikiAutorefresh({ recompile, outputDir: missing });
    setEnv('true', missing);

    expect(isWikiAutorefreshEnabled()).toBe(false);
    scheduleWikiRecompile();
    expect(recompile).not.toHaveBeenCalled();
  });

  it('ENABLED (flag truthy + dir present): a store schedules exactly one debounced recompile', () => {
    vi.useFakeTimers();
    const recompile = vi.fn(async () => {});
    configureWikiAutorefresh({ recompile, outputDir });
    setEnv('true', outputDir);

    expect(isWikiAutorefreshEnabled()).toBe(true);

    scheduleWikiRecompile();
    expect(recompile).not.toHaveBeenCalled(); // debounced, not yet fired
    vi.advanceTimersByTime(WIKI_RECOMPILE_DEBOUNCE_MS);
    expect(recompile).toHaveBeenCalledTimes(1);
    expect(recompile).toHaveBeenCalledWith(outputDir);
  });

  it('a BURST of stores coalesces into ONE recompile (debounce)', () => {
    vi.useFakeTimers();
    const recompile = vi.fn(async () => {});
    configureWikiAutorefresh({ recompile, outputDir });
    setEnv('1', outputDir);

    scheduleWikiRecompile();
    vi.advanceTimersByTime(WIKI_RECOMPILE_DEBOUNCE_MS - 1);
    scheduleWikiRecompile();
    vi.advanceTimersByTime(WIKI_RECOMPILE_DEBOUNCE_MS - 1);
    scheduleWikiRecompile();
    expect(recompile).not.toHaveBeenCalled();
    vi.advanceTimersByTime(WIKI_RECOMPILE_DEBOUNCE_MS);
    expect(recompile).toHaveBeenCalledTimes(1);
  });

  it('ENABLED: recompileWikiNow invokes the compiler immediately (bootstrap/ingest path)', async () => {
    const recompile = vi.fn(async () => {});
    configureWikiAutorefresh({ recompile, outputDir });
    setEnv('on', outputDir);

    await recompileWikiNow();
    expect(recompile).toHaveBeenCalledTimes(1);
    expect(recompile).toHaveBeenCalledWith(outputDir);
  });

  it('is NON-FATAL: a throwing compiler does not reject recompileWikiNow', async () => {
    const recompile = vi.fn(async () => {
      throw new Error('boom');
    });
    configureWikiAutorefresh({ recompile, outputDir });
    setEnv('true', outputDir);

    await expect(recompileWikiNow()).resolves.toBeUndefined();
    expect(recompile).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no recompiler has been wired, even with the flag on', () => {
    vi.useFakeTimers();
    // No configureWikiAutorefresh() call ⇒ recompile is null.
    setEnv('true', outputDir);
    // Should not throw and should arm nothing.
    expect(() => scheduleWikiRecompile()).not.toThrow();
    vi.advanceTimersByTime(WIKI_RECOMPILE_DEBOUNCE_MS * 2);
    // Nothing to assert on a mock (there is none) — the contract is "no throw".
  });

  it('accepts common truthy spellings and rejects falsey ones', () => {
    // Configure so state.outputDir (the single source the guard checks) is the
    // real temp dir that exists — the guard no longer re-reads the env dir.
    const recompile = vi.fn(async () => {});
    configureWikiAutorefresh({ recompile, outputDir });
    for (const truthy of ['1', 'true', 'TRUE', 'yes', 'on']) {
      setEnv(truthy, outputDir);
      expect(isWikiAutorefreshEnabled()).toBe(true);
    }
    for (const falsey of ['', '0', 'false', 'no', 'off']) {
      setEnv(falsey, outputDir);
      expect(isWikiAutorefreshEnabled()).toBe(false);
    }
  });

  it('resolveWikiOutputDir honours MEMBERRY_WIKI_OUTPUT_DIR, else defaults to /app/wiki', () => {
    setEnv(undefined, undefined);
    expect(resolveWikiOutputDir()).toBe(DEFAULT_WIKI_OUTPUT_DIR);
    setEnv(undefined, '/custom/wiki/dir');
    expect(resolveWikiOutputDir()).toBe('/custom/wiki/dir');
  });
});

// OPT-18 — the dir-existence check must NOT re-stat on every store. The mount
// point doesn't appear/disappear during the process lifetime, so the guard
// resolves it ONCE and caches it. Spy statSync, fire N stores, assert the call
// count is bounded (independent of N).
describe('wiki autorefresh dir-check is cached, not per-store (OPT-18)', () => {
  it('statSync is called at most once across many store-path guard hits', () => {
    vi.useFakeTimers();
    const recompile = vi.fn(async () => {});
    configureWikiAutorefresh({ recompile, outputDir });
    setEnv('true', outputDir);

    const statSpy = vi.spyOn(fs, 'statSync');

    // Fire many store-triggered schedules (each calls the guard) plus direct
    // guard calls — the existence check is resolved once and reused.
    const N = 50;
    for (let i = 0; i < N; i++) {
      scheduleWikiRecompile();
      isWikiAutorefreshEnabled();
    }

    // Count ONLY stats of the configured output dir (ignore unrelated temp-dir
    // stats some environments make). Must be ≤ 1 regardless of N.
    const dirStats = statSpy.mock.calls.filter(([p]) => p === outputDir).length;
    expect(dirStats).toBeLessThanOrEqual(1);

    statSpy.mockRestore();
  });

  it('the default-OFF path performs ZERO stats (strict short-circuit before stat)', () => {
    const recompile = vi.fn(async () => {});
    configureWikiAutorefresh({ recompile, outputDir });
    setEnv(undefined, outputDir); // flag OFF

    const statSpy = vi.spyOn(fs, 'statSync');
    for (let i = 0; i < 20; i++) isWikiAutorefreshEnabled();
    const dirStats = statSpy.mock.calls.filter(([p]) => p === outputDir).length;
    expect(dirStats).toBe(0);
    statSpy.mockRestore();
  });
});

// OPT-19 — the recompile target and the guard's existence check must read ONE
// source (state.outputDir set at configure time), so they can never diverge.
// Pin that the dir handed to the recompiler == the dir whose existence gates it,
// and that flipping the env AFTER configure changes neither.
describe('wiki autorefresh output dir is single-sourced (OPT-19)', () => {
  it('recompiles the SAME dir the guard checks; env changes after configure are ignored', async () => {
    const recompile = vi.fn(async () => {});
    // Configure with the real (existing) temp dir as the single source.
    configureWikiAutorefresh({ recompile, outputDir });
    // Flag on; point the ENV at a DIFFERENT, non-existent dir to prove the guard
    // does not re-resolve from env — it uses state.outputDir.
    const divergent = path.join(outputDir, 'env-divergent-not-checked');
    setEnv('true', divergent);

    // Guard still true (state.outputDir exists), unaffected by the divergent env.
    expect(isWikiAutorefreshEnabled()).toBe(true);

    await recompileWikiNow();
    expect(recompile).toHaveBeenCalledTimes(1);
    // The recompile target is state.outputDir — the SAME dir the guard checked,
    // never the divergent env value.
    expect(recompile).toHaveBeenCalledWith(outputDir);
    expect(recompile).not.toHaveBeenCalledWith(divergent);
  });
});
