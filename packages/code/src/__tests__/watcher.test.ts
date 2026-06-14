// packages/code/src/__tests__/watcher.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { CodeWatcher, extractFilePaths, confineReindexPath } from '../watcher.js';
import type { IFileIndexer, ISymbolDeleter } from '../watcher.js';

// ─── extractFilePaths ───────────────────────────────────────────────────────

describe('extractFilePaths', () => {
  it('extracts paths from prose content', () => {
    const content = 'Modified packages/core/src/service.ts and packages/redis/src/cache.ts for the new feature';
    const paths = extractFilePaths(content);
    expect(paths).toContain('packages/core/src/service.ts');
    expect(paths).toContain('packages/redis/src/cache.ts');
  });

  it('extracts paths with various extensions', () => {
    const content = 'Updated src/index.ts, lib/utils.py, and cmd/server.go';
    const paths = extractFilePaths(content);
    expect(paths).toContain('src/index.ts');
    expect(paths).toContain('lib/utils.py');
    expect(paths).toContain('cmd/server.go');
  });

  it('extracts paths in quotes', () => {
    const content = 'File "packages/code/src/watcher.ts" was created';
    const paths = extractFilePaths(content);
    expect(paths).toContain('packages/code/src/watcher.ts');
  });

  it('deduplicates paths', () => {
    const content = 'Changed src/main.rs and then changed src/main.rs again';
    const paths = extractFilePaths(content);
    expect(paths).toHaveLength(1);
    expect(paths).toContain('src/main.rs');
  });

  it('returns empty for content without file paths', () => {
    const content = 'Decided to use event sourcing for the order pipeline.';
    const paths = extractFilePaths(content);
    expect(paths).toHaveLength(0);
  });

  it('does not match bare filenames without directory separators', () => {
    const content = 'The file index.ts was updated';
    const paths = extractFilePaths(content);
    expect(paths).toHaveLength(0);
  });

  it('extracts paths with @ in scoped package names', () => {
    const content = 'Refactored @memberry/core/src/service.ts';
    const paths = extractFilePaths(content);
    expect(paths).toContain('@memberry/core/src/service.ts');
  });

  it('handles tsx and jsx extensions', () => {
    const content = 'Updated components/App.tsx and views/Home.jsx';
    const paths = extractFilePaths(content);
    expect(paths).toContain('components/App.tsx');
    expect(paths).toContain('views/Home.jsx');
  });
});

// ─── confineReindexPath (path-traversal confinement) ─────────────────────────

describe('confineReindexPath', () => {
  // realpathSync normalizes macOS /var -> /private/var etc., so the base used in
  // assertions must match what the helper sees after its internal realpath.
  let base: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'amp-confine-')));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('accepts an in-base relative path and returns its resolved absolute form', () => {
    const out = confineReindexPath('src/service.ts', base);
    expect(out).toBe(resolve(base, 'src/service.ts'));
  });

  it('accepts an in-base absolute path', () => {
    const inside = resolve(base, 'pkg/index.ts');
    expect(confineReindexPath(inside, base)).toBe(inside);
  });

  it('drops a relative `..` traversal escape', () => {
    expect(confineReindexPath('../../etc/passwd', base)).toBeNull();
  });

  it('drops a relative path that climbs out then back to a sibling', () => {
    expect(confineReindexPath('../sibling/secret.ts', base)).toBeNull();
  });

  it('drops an absolute path outside the base', () => {
    // Use a path that resolves outside base on every platform.
    const outside = resolve(base, '..', 'totally-outside', 'secrets.py');
    expect(confineReindexPath(outside, base)).toBeNull();
  });

  it('drops a sibling directory that shares the base as a string prefix', () => {
    // `${base}EVIL` starts with `base` lexically but is NOT inside `base + sep`.
    expect(confineReindexPath(base + 'EVIL/secret.ts', base)).toBeNull();
  });

  it('drops a symlink inside the base that points to a file outside it', () => {
    // Create a secret file OUTSIDE the base and a symlink INSIDE the base to it.
    const outsideRoot = realpathSync(mkdtempSync(join(tmpdir(), 'amp-outside-')));
    try {
      const secret = join(outsideRoot, 'secret.ts');
      writeFileSync(secret, 'export const KEY = "leak";');
      mkdirSync(join(base, 'src'), { recursive: true });
      const link = join(base, 'src', 'link.ts');
      try {
        symlinkSync(secret, link);
      } catch {
        // Symlink creation can fail without privileges (e.g. Windows). Skip.
        return;
      }
      // Lexically inside base, but realpath escapes -> must be dropped.
      expect(confineReindexPath(link, base)).toBeNull();
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('OPT-74: drops a not-yet-existing leaf under a symlinked ANCESTOR', () => {
    // A planted symlink DIRECTORY inside the base points outside; a path being
    // created under it (leaf does not exist yet) must NOT escape — pre-OPT-74 the
    // ENOENT→lexical-allow fallthrough let it through.
    const outsideRoot = realpathSync(mkdtempSync(join(tmpdir(), 'amp-outside-anc-')));
    try {
      const evil = join(base, 'evil');
      try {
        symlinkSync(outsideRoot, evil);
      } catch {
        return; // symlink creation needs privileges on some platforms — skip
      }
      // base/evil → outsideRoot; base/evil/sub/new.ts doesn't exist.
      expect(confineReindexPath(join(base, 'evil', 'sub', 'new.ts'), base)).toBeNull();
      // sanity: a genuinely in-base not-yet-existing leaf is still accepted.
      expect(confineReindexPath('src/created-later.ts', base)).toBe(resolve(base, 'src/created-later.ts'));
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });
});

// ─── CodeWatcher ────────────────────────────────────────────────────────────

describe('CodeWatcher', () => {
  let mockIndexer: IFileIndexer;
  let mockDeleter: ISymbolDeleter;
  let watcher: CodeWatcher;

  beforeEach(() => {
    mockIndexer = {
      indexFile: vi.fn().mockResolvedValue({ symbols_created: 1, symbols_updated: 0, relations_created: 0 }),
    };
    mockDeleter = {
      deleteByFile: vi.fn().mockResolvedValue(3),
    };
  });

  afterEach(() => {
    if (watcher) watcher.stopAll();
  });

  it('creates with default options', () => {
    watcher = new CodeWatcher(mockIndexer, mockDeleter);
    expect(watcher.getWatchedPaths()).toEqual([]);
    expect(watcher.getPendingCount()).toBe(0);
  });

  it('creates with custom options', () => {
    watcher = new CodeWatcher(mockIndexer, mockDeleter, {
      debounceMs: 100,
      extensions: ['.ts'],
      excludePatterns: ['dist'],
      skipTests: false,
    });
    expect(watcher.getWatchedPaths()).toEqual([]);
  });

  it('stopAll clears timers', () => {
    watcher = new CodeWatcher(mockIndexer, mockDeleter, { debounceMs: 100 });
    // Queue a re-index (via the public API)
    watcher.queueReindex('/tmp/test/src/foo.ts');
    expect(watcher.getPendingCount()).toBe(1);

    watcher.stopAll();
    expect(watcher.getPendingCount()).toBe(0);
  });

  it('queueReindex ignores unsupported extensions', () => {
    watcher = new CodeWatcher(mockIndexer, mockDeleter, { debounceMs: 100 });
    watcher.queueReindex('/tmp/test/README.md');
    expect(watcher.getPendingCount()).toBe(0);
  });

  it('queueReindex accepts supported extensions', () => {
    watcher = new CodeWatcher(mockIndexer, mockDeleter, { debounceMs: 100 });
    watcher.queueReindex('/tmp/test/src/service.ts');
    expect(watcher.getPendingCount()).toBe(1);
  });

  it('queueReindex ignores excluded directories like watcher file events', () => {
    watcher = new CodeWatcher(mockIndexer, mockDeleter, { debounceMs: 100 });

    watcher.queueReindex('/tmp/test/node_modules/pkg/index.ts');
    watcher.queueReindex('/tmp/test/dist/bundle.js');

    expect(watcher.getPendingCount()).toBe(0);
  });

  it('queueReindex ignores test files by default like watcher file events', () => {
    watcher = new CodeWatcher(mockIndexer, mockDeleter, { debounceMs: 100 });

    watcher.queueReindex('/tmp/test/src/service.test.ts');
    watcher.queueReindex('/tmp/test/src/__tests__/service.ts');

    expect(watcher.getPendingCount()).toBe(0);
  });

  it('queueReindex accepts test files when skipTests is disabled', () => {
    watcher = new CodeWatcher(mockIndexer, mockDeleter, { debounceMs: 100, skipTests: false });

    watcher.queueReindex('/tmp/test/src/service.test.ts');

    expect(watcher.getPendingCount()).toBe(1);
  });

  it('OPT-59: skips the re-index (no re-parse) when file content is unchanged', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'amp-watch-hash-')));
    const file = join(dir, 'svc.ts');
    writeFileSync(file, 'export const a = 1;');
    watcher = new CodeWatcher(mockIndexer, mockDeleter, { debounceMs: 10 });
    const indexFile = mockIndexer.indexFile as ReturnType<typeof vi.fn>;
    const waitUntil = async (pred: () => boolean, ms = 1500): Promise<void> => {
      const start = Date.now();
      while (!pred() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 10));
    };

    try {
      // First event for never-seen content → indexes once.
      watcher.queueReindex(file);
      await waitUntil(() => indexFile.mock.calls.length === 1);
      expect(indexFile).toHaveBeenCalledTimes(1);

      // Second event, identical content → short-circuited (no re-parse/index).
      watcher.queueReindex(file);
      await new Promise((r) => setTimeout(r, 250)); // generous: would have indexed in ~30ms
      expect(indexFile).toHaveBeenCalledTimes(1);

      // Content actually changes → re-index runs again.
      writeFileSync(file, 'export const a = 2;');
      watcher.queueReindex(file);
      await waitUntil(() => indexFile.mock.calls.length === 2);
      expect(indexFile).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('multiple rapid queueReindex calls for same file only produce one pending', () => {
    watcher = new CodeWatcher(mockIndexer, mockDeleter, { debounceMs: 500 });
    watcher.queueReindex('/tmp/test/src/service.ts');
    watcher.queueReindex('/tmp/test/src/service.ts');
    watcher.queueReindex('/tmp/test/src/service.ts');
    expect(watcher.getPendingCount()).toBe(1);
  });

  it('different files create separate pending entries', () => {
    watcher = new CodeWatcher(mockIndexer, mockDeleter, { debounceMs: 500 });
    watcher.queueReindex('/tmp/test/src/a.ts');
    watcher.queueReindex('/tmp/test/src/b.ts');
    watcher.queueReindex('/tmp/test/src/c.py');
    expect(watcher.getPendingCount()).toBe(3);
  });

  it('debounce fires after delay and calls indexer', async () => {
    watcher = new CodeWatcher(mockIndexer, mockDeleter, { debounceMs: 50 });

    // Create a real file so the stat check passes
    const { writeFileSync, mkdirSync, rmSync } = await import('fs');
    const tmpDir = '/tmp/amp-watcher-test-' + Date.now();
    mkdirSync(tmpDir + '/src', { recursive: true });
    const testFile = tmpDir + '/src/test.ts';
    writeFileSync(testFile, 'export const x = 1;');

    try {
      watcher.queueReindex(testFile);
      expect(watcher.getPendingCount()).toBe(1);

      // Wait for debounce to fire
      await new Promise((r) => setTimeout(r, 100));

      expect(watcher.getPendingCount()).toBe(0);
      expect(mockIndexer.indexFile).toHaveBeenCalledWith(
        expect.stringContaining('test.ts'),
        'typescript',
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('handles deletion by calling symbolDeleter when file does not exist', async () => {
    watcher = new CodeWatcher(mockIndexer, mockDeleter, { debounceMs: 50 });

    // Queue a re-index for a file that does not exist
    watcher.queueReindex('/tmp/nonexistent-file-abc123.ts');

    // Wait for debounce to fire
    await new Promise((r) => setTimeout(r, 100));

    expect(mockDeleter.deleteByFile).toHaveBeenCalledWith(
      expect.stringContaining('nonexistent-file-abc123.ts'),
    );
    expect(mockIndexer.indexFile).not.toHaveBeenCalled();
  });

  // ─── OPT-68: read-time re-confinement (TOCTOU close) ──────────────────────
  it('OPT-68: a queued (untrusted) in-base path still indexes when confineBase is given', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'amp-watch-confine-ok-')));
    const target = join(base, 'svc.ts');
    writeFileSync(target, 'export const a = 1;');
    watcher = new CodeWatcher(mockIndexer, mockDeleter, { debounceMs: 10 });
    const indexFile = mockIndexer.indexFile as ReturnType<typeof vi.fn>;
    const waitUntil = async (pred: () => boolean, ms = 1500): Promise<void> => {
      const start = Date.now();
      while (!pred() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 10));
    };
    try {
      // Legit path within the base, queued WITH its confinement base → indexed
      // (read-time re-confinement passes; behaviour identical to the unconfined path).
      watcher.queueReindex(target, base);
      await waitUntil(() => indexFile.mock.calls.length === 1);
      expect(indexFile).toHaveBeenCalledTimes(1);
      expect(indexFile).toHaveBeenCalledWith(target, expect.any(String));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('OPT-68: rejects a post-queue symlink swap that escapes the confinement base', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'amp-watch-confine-evil-')));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'amp-watch-secret-')));
    const secret = join(outside, 'secret.ts');
    writeFileSync(secret, 'export const STOLEN = 1;');
    const target = join(base, 'svc.ts');
    watcher = new CodeWatcher(mockIndexer, mockDeleter, { debounceMs: 10 });
    const indexFile = mockIndexer.indexFile as ReturnType<typeof vi.fn>;
    const waitUntil = async (pred: () => boolean, ms = 1500): Promise<void> => {
      const start = Date.now();
      while (!pred() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 10));
    };
    try {
      // 1. Initially a legit in-base file → indexes once.
      writeFileSync(target, 'export const a = 1;');
      watcher.queueReindex(target, base);
      await waitUntil(() => indexFile.mock.calls.length === 1);
      expect(indexFile).toHaveBeenCalledTimes(1);

      // 2. Attacker swaps the in-base path to a symlink pointing OUTSIDE the base
      //    (the TOCTOU window between queue-time confinement and the read). The
      //    read-time re-confinement must reject it — the secret is never indexed.
      rmSync(target);
      try {
        symlinkSync(secret, target);
      } catch {
        return; // symlink creation needs privileges on some platforms — skip
      }
      watcher.queueReindex(target, base);
      await new Promise((r) => setTimeout(r, 250)); // generous: would have indexed in ~30ms
      expect(indexFile).toHaveBeenCalledTimes(1); // NOT called again for the escaped path
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
