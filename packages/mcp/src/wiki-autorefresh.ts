// packages/mcp/src/wiki-autorefresh.ts
//
// gap-15 (T10): OPT-IN auto-refresh of the served wiki (the gap-3 wiki service on
// port 3200) after the MCP graph changes.
//
// WHY THIS EXISTS
// ───────────────
// The wiki viewer (packages/wiki/src/viewer.ts) `fs.watch`es its output dir and
// rebuilds its in-memory cache when `.md` files change. When the MCP server and
// the wiki viewer share the same output directory (a docker named volume mounted
// at /app/wiki in BOTH services — see docker-compose.yml), MCP can re-materialize
// the wiki and the viewer picks the new files up automatically. This module is
// the MCP-side trigger that recompiles after stores / bootstrap / ingest.
//
// STRICT DEFAULT NO-OP
// ────────────────────
// Everything here is gated behind MEMBERRY_WIKI_AUTOREFRESH being truthy AND the
// output dir existing. When the env is unset (the default), every entry point is
// a zero-work no-op: no compiler is constructed, no timer is armed, no dir is
// stat'd beyond the cheap guard. Behavior is therefore UNCHANGED from T9 by
// default. The feature must be explicitly opted into.
//
// FULL RECOMPILE (all projects), not scoped
// ─────────────────────────────────────────
// WikiCompiler.compile() does `rm -rf <outputDir>` then rebuilds. A *scoped*
// recompile (single project_tag) would wipe the whole dir but only re-emit ONE
// project — every other project's pages would vanish until the next full build.
// So refresh ALWAYS compiles ALL projects (project_tag omitted → 'all'). The
// whole-dir rebuild is atomic from the reader's perspective in the sense that a
// reader never ends up with a *partial set of projects*: the viewer's fs.watch
// debounces and re-reads the directory after the burst of writes settles.
//
// SINGLE-WRITER CAVEAT
// ────────────────────
// The wiki service self-builds at startup (its `build` command compiles then
// serves), so it works with autorefresh OFF. When autorefresh is ON, BOTH the
// wiki service (once, at startup) and MCP (on every refresh event) can write the
// shared dir. There is therefore a brief two-writers-at-startup window. This is
// tolerable because each writer performs a FULL whole-dir recompile (never a
// partial project set) and the viewer's fs.watch re-reads after writes settle; a
// reader may momentarily 404 a page mid-rebuild but never sees a structurally
// inconsistent project set. We deliberately do NOT make the wiki compose command
// conditional on the env var (compose can't express that cleanly).

import fs from 'node:fs';
import { readEnv } from '@memberry/core';

/** Default shared output dir — the path the wiki viewer serves inside the container. */
export const DEFAULT_WIKI_OUTPUT_DIR = '/app/wiki';

/**
 * Debounce window for store-triggered recompiles. A burst of stores (e.g. an
 * agent storing several episodes in quick succession) collapses into ONE
 * recompile fired this many ms after the LAST store. Kept small enough to feel
 * live, large enough to coalesce a burst.
 */
export const WIKI_RECOMPILE_DEBOUNCE_MS = 3000;

/** Injected recompile fn: compile ALL projects into `outputDir`. Resolves on success. */
export type WikiRecompileFn = (outputDir: string) => Promise<unknown>;

interface AutorefreshState {
  /** Injected full-recompile function (wraps WikiCompiler.compile). Null until configured. */
  recompile: WikiRecompileFn | null;
  /** Resolved output dir (env override or DEFAULT_WIKI_OUTPUT_DIR). The single
   *  source of truth for BOTH the recompile target and the guard's existence
   *  check — they can never diverge. */
  outputDir: string;
  /** Cached result of stat-ing `outputDir` (does it exist as a directory?).
   *  Resolved ONCE (lazily, on first guard call, or eagerly at configure time)
   *  and reused thereafter — the mount point doesn't appear/disappear during the
   *  process lifetime, so the per-store hot path never re-stats. */
  dirExists: boolean | null;
  /** Pending debounce timer for store-triggered recompiles. */
  timer: ReturnType<typeof setTimeout> | null;
  /** True while a recompile is in flight (so a debounce fire doesn't overlap one). */
  inFlight: boolean;
  /** A store landed while a recompile was in flight — recompile once more after it. */
  rerunQueued: boolean;
}

const state: AutorefreshState = {
  recompile: null,
  outputDir: DEFAULT_WIKI_OUTPUT_DIR,
  dirExists: null,
  timer: null,
  inFlight: false,
  rerunQueued: false,
};

/**
 * Stat `state.outputDir` ONCE and cache the result. Subsequent calls return the
 * cached value (no syscall). The mount point doesn't appear/disappear during the
 * process lifetime, so a single resolution is correct and keeps the store hot
 * path free of a per-store `statSync`.
 */
function resolveDirExists(): boolean {
  if (state.dirExists === null) {
    try {
      state.dirExists = fs.statSync(state.outputDir).isDirectory();
    } catch {
      // Dir missing / not stat-able ⇒ treat as absent (non-fatal).
      state.dirExists = false;
    }
  }
  return state.dirExists;
}

/**
 * Resolve the configured output dir from env (MEMBERRY_WIKI_OUTPUT_DIR), falling
 * back to /app/wiki. Read lazily so tests can flip the env per-case.
 */
export function resolveWikiOutputDir(): string {
  const raw = readEnv('MEMBERRY_WIKI_OUTPUT_DIR');
  return raw && raw.trim() !== '' ? raw.trim() : DEFAULT_WIKI_OUTPUT_DIR;
}

/**
 * The opt-in guard. Returns true ONLY when MEMBERRY_WIKI_AUTOREFRESH is truthy
 * AND `state.outputDir` (the SAME dir the recompile targets) exists as a
 * directory. Unset/false env ⇒ false ⇒ every caller is a strict no-op (the key
 * safety property) — the truthiness check short-circuits BEFORE any stat, so the
 * default-OFF path is zero-syscall. The dir check (cached after the first call)
 * means a misconfigured deployment (env on, no shared volume) also no-ops rather
 * than erroring, without re-stat-ing on every store.
 */
export function isWikiAutorefreshEnabled(): boolean {
  const flag = readEnv('MEMBERRY_WIKI_AUTOREFRESH');
  if (!isTruthy(flag)) return false; // strict short-circuit: no stat when OFF
  return resolveDirExists();
}

function isTruthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/**
 * Wire the real recompiler. Called once from bootstrap.ts with a closure over a
 * `new WikiCompiler(driver)` (the driver is only available in bootstrap). Until
 * this is called, scheduleWikiRecompile/recompileWikiNow are inert even if the
 * env is on — they have nothing to invoke (logged once, non-fatal).
 */
export function configureWikiAutorefresh(opts: { recompile: WikiRecompileFn; outputDir?: string }): void {
  state.recompile = opts.recompile;
  // Resolve the output dir from a SINGLE source here. Both the recompile target
  // (state.outputDir) and the guard's existence check read this same value, so
  // they can never diverge. Falls back to the env-resolved dir when omitted.
  state.outputDir = opts.outputDir ?? resolveWikiOutputDir();
  // Re-prime the cached existence check against the (possibly new) outputDir.
  state.dirExists = null;
}

/** Test seam: clear timer + injected fn so suites don't leak across cases. */
export function resetWikiAutorefresh(): void {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.recompile = null;
  state.outputDir = DEFAULT_WIKI_OUTPUT_DIR;
  state.dirExists = null;
  state.inFlight = false;
  state.rerunQueued = false;
}

/**
 * DEBOUNCED full recompile — the hook for the high-frequency store path.
 * No-op (returns immediately, arms no timer) unless autorefresh is enabled and a
 * recompiler has been wired. A burst of calls collapses into one recompile fired
 * WIKI_RECOMPILE_DEBOUNCE_MS after the last call. Fire-and-forget; never throws
 * into the caller (the store() path must not be perturbed by wiki refresh).
 */
export function scheduleWikiRecompile(): void {
  if (!state.recompile || !isWikiAutorefreshEnabled()) return; // strict no-op by default
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    void runRecompile();
  }, WIKI_RECOMPILE_DEBOUNCE_MS);
  // Unref so a pending refresh timer never keeps the process alive on shutdown.
  if (typeof state.timer.unref === 'function') state.timer.unref();
}

/**
 * IMMEDIATE full recompile — the hook for low-frequency, setup-time events
 * (berry_bootstrap / berry_ingest_codebase) where the caller wants the wiki to
 * reflect the new project right away. Awaitable, but always resolves (non-fatal):
 * a recompile failure is logged, never propagated. No-op unless enabled + wired.
 */
export async function recompileWikiNow(): Promise<void> {
  if (!state.recompile || !isWikiAutorefreshEnabled()) return; // strict no-op by default
  await runRecompile();
}

/**
 * Run exactly one recompile, serializing against any in-flight one. If a refresh
 * is requested while one is running, we set rerunQueued and re-fire once after,
 * so the final graph state is always reflected without overlapping rm -rf passes.
 */
async function runRecompile(): Promise<void> {
  if (!state.recompile) return;
  if (state.inFlight) {
    state.rerunQueued = true;
    return;
  }
  state.inFlight = true;
  try {
    await state.recompile(state.outputDir);
  } catch (err: unknown) {
    // Non-fatal: a failed wiki refresh must never break stores or setup.
    console.error(
      '[memberry-mcp] wiki autorefresh recompile failed (non-fatal):',
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    state.inFlight = false;
    if (state.rerunQueued) {
      state.rerunQueued = false;
      await runRecompile();
    }
  }
}
