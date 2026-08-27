// packages/code/src/watcher.ts
// Background file watcher that keeps the symbol graph fresh as source files change.

import { watch, stat } from 'fs';
import { readFile } from 'fs/promises';
import { createHash } from 'crypto';
import { extname, resolve, sep } from 'path';
import type { FSWatcher } from 'fs';
import { isRealpathWithinBase, getAllowedBaseDir } from '@memberry/core';
import { LANGUAGE_EXTENSIONS, isTestPath } from './types.js';

// ─── Injected interfaces ───────────────────────────────────────────────────

/** Subset of CodeIndexer needed by the watcher. */
export interface IFileIndexer {
  indexFile(filePath: string, language: string): Promise<unknown>;
}

/** Subset of SymbolStore needed for file deletion cleanup. */
export interface ISymbolDeleter {
  deleteByFile(filePath: string): Promise<number>;
}

// ─── Configuration ──────────────────────────────────────────────────────────

export interface CodeWatcherOptions {
  /** Debounce delay per file in milliseconds. Default: 3000 (3 seconds). */
  debounceMs?: number;
  /** File extensions to watch. Default: all LANGUAGE_EXTENSIONS keys. */
  extensions?: string[];
  /** Directory/file patterns to exclude. Default includes node_modules, dist, .git, etc. */
  excludePatterns?: string[];
  /** Whether to skip test files (*.test.ts, *.spec.ts, etc.). Default: true. */
  skipTests?: boolean;
}

const DEFAULT_DEBOUNCE_MS = 3000;

const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs'];

const DEFAULT_EXCLUDE_PATTERNS = [
  'node_modules', 'dist', '.git', 'vendor', '__pycache__', 'build',
  'coverage', '.next', '.venv', 'venv', 'env', '.env', 'target',
  '.amp', '.lab', '.yggdrasil', '.codebase', '.nyc_output',
];

// ─── File path extraction ───────────────────────────────────────────────────

/**
 * Extract file paths from prose content (e.g., episode content from berry_store).
 * Matches common file path patterns containing path separators and known extensions.
 */
export function extractFilePaths(content: string): string[] {
  const regex = /(?:^|\s|['"`(])((?:[\w.@/-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs))\b/g;
  const paths = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    paths.add(match[1]);
  }
  return [...paths];
}

// ─── Path confinement ─────────────────────────────────────────────────────────

/**
 * Returns the base directory that re-index paths must be confined to.
 * Delegates to the shared @memberry/core helper (single source of truth) so the
 * confinement base — MEMBERRY_INGEST_ALLOW_DIR if set, otherwise the process
 * working directory — is identical across the wiki, code, and mcp packages.
 * Exported name is kept stable for existing importers (code/src/index.ts).
 */
export function getReindexBaseDir(): string {
  return getAllowedBaseDir();
}

/**
 * Confine an extracted (untrusted) file path to `base`.
 *
 * Stored episode content is fully untrusted, so paths it mentions must not be
 * allowed to escape the project root and pull arbitrary source files (e.g.
 * `../../../../etc/secrets/config.py`, `/home/user/.ssh/known.py`) into the
 * queryable symbol graph.
 *
 * Returns the resolved absolute path if it is within `base`, or `null` if the
 * path escapes (lexically or via symlink). Callers must drop `null` results.
 *
 * Confinement layers:
 *   1. Lexical: `resolve(base, p)` must equal `base` or start with `base + sep`
 *      (trailing-sep prefix check so a sibling like `${base}EVIL` cannot pass).
 *      This rejects `..` escapes and absolute paths outside the base.
 *   2. Symlink: if the resolved path exists, its realpath (and the base's
 *      realpath) must still satisfy the same prefix check, defeating a symlink
 *      inside the base that points outside it.
 */
export function confineReindexPath(p: string, base?: string): string | null {
  const baseDir = base ?? getReindexBaseDir();
  const resolved = resolve(baseDir, p);

  // Layer 1: lexical confinement.
  if (resolved !== baseDir && !resolved.startsWith(baseDir + sep)) {
    return null;
  }

  // Layer 2: symlink confinement via the shared core helper (OPT-74). This now
  // resolves the NEAREST EXISTING ANCESTOR when the target doesn't exist yet, so
  // a symlinked ancestor of a not-yet-created leaf can't escape (the old
  // ENOENT→lexical-allow fallthrough). Defeats a symlink at any level in/under
  // the base, including the base reached through a symlink.
  if (!isRealpathWithinBase(resolved, baseDir)) {
    return null;
  }

  return resolved;
}

// ─── CodeWatcher ────────────────────────────────────────────────────────────

export class CodeWatcher {
  private watchers = new Map<string, FSWatcher>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // OPT-59: per-file SHA-256 of the last-INDEXED content, to skip the expensive
  // re-parse when a change event fires for content that did not actually change
  // (no-op editor saves, touches, reverts coalesced within the debounce window).
  private lastIndexedHash = new Map<string, string>();
  // OPT-68: for untrusted-origin (queued) paths, the confinement base captured at
  // queue time. reindexFile re-validates confinement against it right before the
  // read, closing the TOCTOU between OPT-03's queue-time check and the debounced
  // read (a symlink swapped into the base within the window must not redirect the
  // read). Absent for fs-watcher events (trusted root) → those stay unconfined here.
  private confineBaseByPath = new Map<string, string>();
  private debounceMs: number;
  private extensions: Set<string>;
  private excludePatterns: Set<string>;
  private skipTests: boolean;

  constructor(
    private indexer: IFileIndexer,
    private symbolDeleter: ISymbolDeleter,
    options?: CodeWatcherOptions,
  ) {
    this.debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.extensions = new Set(options?.extensions ?? DEFAULT_EXTENSIONS);
    this.excludePatterns = new Set(options?.excludePatterns ?? DEFAULT_EXCLUDE_PATTERNS);
    this.skipTests = options?.skipTests ?? true;
  }

  /**
   * Start watching a directory for file changes.
   * Returns a cleanup function that stops watching this specific path.
   */
  watch(rootPath: string): () => void {
    const absRoot = resolve(rootPath);

    if (this.watchers.has(absRoot)) {
      // Already watching this path
      return () => this.stopOne(absRoot);
    }

    try {
      const watcher = watch(absRoot, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        this.handleFileEvent(absRoot, filename);
      });

      watcher.on('error', (err: Error) => {
        const code = (err as NodeJS.ErrnoException).code;
        // EPERM and ENOSPC are common on Linux when hitting inotify limits
        if (code === 'EPERM' || code === 'ENOSPC' || code === 'EACCES') {
          console.error(`[code-watcher] Watcher error on ${absRoot} (${code}): ${err.message}`);
        } else {
          console.error(`[code-watcher] Watcher error on ${absRoot}: ${err.message}`);
        }
      });

      this.watchers.set(absRoot, watcher);
      console.error(`[code-watcher] Watching ${absRoot}`);
    } catch (err) {
      console.error(
        `[code-watcher] Failed to start watching ${absRoot}:`,
        err instanceof Error ? err.message : err,
      );
    }

    return () => this.stopOne(absRoot);
  }

  /** Stop all watchers and clear all pending debounce timers. */
  stopAll(): void {
    for (const [watchedPath, watcher] of this.watchers) {
      watcher.close();
      console.error(`[code-watcher] Stopped watching ${watchedPath}`);
    }
    this.watchers.clear();

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.confineBaseByPath.clear();
  }

  /** Get list of currently watched root paths. */
  getWatchedPaths(): string[] {
    return [...this.watchers.keys()];
  }

  /** Get count of pending debounced re-index operations. */
  getPendingCount(): number {
    return this.debounceTimers.size;
  }

  /**
   * Queue a file for re-indexing (debounced).
   * Used by the post-store hook to re-index files mentioned in episode content.
   *
   * `confineBase` (OPT-68): when the path originates from UNTRUSTED content, the
   * caller passes the confinement base it validated the path against at queue
   * time; reindexFile re-validates against it just before reading, so a symlink
   * swapped into the base during the debounce window can't redirect the read out
   * of the base. Omit for trusted callers (no read-time re-confinement).
   */
  queueReindex(filePath: string, confineBase?: string): void {
    const abs = resolve(filePath);
    if (!this.shouldTrackPath(abs)) return;
    if (confineBase !== undefined) this.confineBaseByPath.set(abs, confineBase);
    this.debouncedReindex(abs);
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private stopOne(absRoot: string): void {
    const watcher = this.watchers.get(absRoot);
    if (watcher) {
      watcher.close();
      this.watchers.delete(absRoot);
      console.error(`[code-watcher] Stopped watching ${absRoot}`);
    }

    // Clear any pending timers for files under this root
    for (const [filePath, timer] of this.debounceTimers) {
      if (filePath.startsWith(absRoot)) {
        clearTimeout(timer);
        this.debounceTimers.delete(filePath);
        this.confineBaseByPath.delete(filePath);
      }
    }
  }

  private handleFileEvent(rootPath: string, filename: string): void {
    const fullPath = resolve(rootPath, filename);
    if (!this.shouldTrackPath(fullPath)) return;
    this.debouncedReindex(fullPath);
  }

  private shouldTrackPath(filePath: string): boolean {
    const ext = extname(filePath);
    if (!this.extensions.has(ext)) return false;

    const parts = filePath.split(/[/\\]/);
    for (const part of parts) {
      if (this.excludePatterns.has(part)) return false;
    }

    if (this.skipTests && isTestPath(filePath)) return false;

    return true;
  }

  private debouncedReindex(filePath: string): void {
    // Cancel any existing timer for this specific file
    const existing = this.debounceTimers.get(filePath);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      this.reindexFile(filePath).catch((err) => {
        console.error(
          `[code-watcher] Re-index failed for ${filePath}:`,
          err instanceof Error ? err.message : err,
        );
      });
    }, this.debounceMs);

    this.debounceTimers.set(filePath, timer);
  }

  private async reindexFile(filePath: string): Promise<void> {
    // OPT-68: consume the queue-time confinement base for this path (untrusted
    // origin). Re-validated below, right before any read.
    const confineBase = this.confineBaseByPath.get(filePath);
    this.confineBaseByPath.delete(filePath);

    // Check if file still exists (it might have been deleted)
    const exists = await new Promise<boolean>((res) => {
      stat(filePath, (err) => res(!err));
    });

    if (!exists) {
      // File was deleted — remove its symbols from the graph
      console.error(`[code-watcher] File deleted, removing symbols: ${filePath}`);
      this.lastIndexedHash.delete(filePath); // OPT-59: drop stale hash on delete
      try {
        await this.symbolDeleter.deleteByFile(filePath);
      } catch (err) {
        console.error(
          `[code-watcher] Failed to clean up symbols for deleted file ${filePath}:`,
          err instanceof Error ? err.message : err,
        );
      }
      return;
    }

    // OPT-68: re-confine UNTRUSTED-origin paths at read time (TOCTOU close). The
    // existence check above (and the realpath inside confineReindexPath) follow
    // symlinks, so a component swapped to a symlink pointing outside the base
    // within the debounce window is rejected HERE, before parseFile/readFile.
    if (confineBase !== undefined && confineReindexPath(filePath, confineBase) === null) {
      console.error(`[code-watcher] dropped re-index path that escaped the base at read time: ${filePath}`);
      this.lastIndexedHash.delete(filePath);
      return;
    }

    const ext = extname(filePath);
    const language = LANGUAGE_EXTENSIONS[ext];
    if (!language) return;

    // OPT-59: whole-file content-hash short-circuit. Identical content yields
    // identical symbols, so indexFile would make zero graph changes — skip the
    // tree-sitter re-parse entirely. The hash is recorded only AFTER a successful
    // index, so a failed index (or a read race) re-tries on the next event; the
    // watcher is debounced + eventually-consistent, so a change racing the index
    // fires its own follow-up event that re-indexes the latest content.
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      // Couldn't read (race/permission) — fall through to indexFile, which handles it.
      console.error(`[code-watcher] Re-indexing ${filePath}`);
      await this.indexer.indexFile(filePath, language);
      return;
    }
    const hash = createHash('sha256').update(content).digest('hex');
    if (this.lastIndexedHash.get(filePath) === hash) {
      return; // unchanged since last index — nothing to do
    }

    console.error(`[code-watcher] Re-indexing ${filePath}`);
    // T5/gap-11: the watcher carries NO project context — indexFile is called
    // without a projectTag (undefined). upsertSymbols COALESCEs on match, so a
    // context-free reindex PRESERVES each symbol's existing stored project_tag
    // rather than clearing it.
    await this.indexer.indexFile(filePath, language);
    this.lastIndexedHash.set(filePath, hash);
  }
}
