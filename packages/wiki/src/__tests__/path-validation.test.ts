// packages/wiki/src/__tests__/path-validation.test.ts
// Tests for path validation in wiki tool handlers (berry_ingest, berry_compile).
// Ensures directory traversal attacks are rejected.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { validatePath, getAllowedBaseDir, buildWikiToolHandlers, setWikiServiceInstances } from '../tools.js';
import type { IWikiCompiler, IIngestionService, IWikiLinter } from '../tools.js';
import type { IngestResult, CompileResult, LintResult } from '../types.js';

// ─── validatePath unit tests ─────────────────────────────────────────────────

describe('validatePath', () => {
  const baseDir = '/home/cerebro/projects/amp';

  it('accepts a path within the base directory', () => {
    const result = validatePath('/home/cerebro/projects/amp/docs/test.md', baseDir);
    expect(result).toBe('/home/cerebro/projects/amp/docs/test.md');
  });

  it('accepts the base directory itself', () => {
    const result = validatePath('/home/cerebro/projects/amp', baseDir);
    expect(result).toBe('/home/cerebro/projects/amp');
  });

  it('accepts a deeply nested path', () => {
    const result = validatePath('/home/cerebro/projects/amp/packages/wiki/src/tools.ts', baseDir);
    expect(result).toBe('/home/cerebro/projects/amp/packages/wiki/src/tools.ts');
  });

  it('rejects path outside via parent traversal', () => {
    expect(() => validatePath('/home/cerebro/projects/amp/../../../etc/passwd', baseDir))
      .toThrow('Path must be within allowed directory');
  });

  it('rejects an absolute path outside the base directory', () => {
    expect(() => validatePath('/etc/passwd', baseDir))
      .toThrow('Path must be within allowed directory');
  });

  it('rejects a sibling directory path', () => {
    expect(() => validatePath('/home/cerebro/projects/other-project/file.md', baseDir))
      .toThrow('Path must be within allowed directory');
  });

  it('rejects path that is a prefix but not a child (amp-evil vs amp)', () => {
    // /home/cerebro/projects/amp-evil starts with /home/cerebro/projects/amp
    // but is NOT inside it. The path.sep check catches this.
    expect(() => validatePath('/home/cerebro/projects/amp-evil/file.md', baseDir))
      .toThrow('Path must be within allowed directory');
  });

  it('rejects relative traversal from cwd', () => {
    expect(() => validatePath('../../../../etc/shadow', baseDir))
      .toThrow('Path must be within allowed directory');
  });

  it('normalizes path with redundant separators', () => {
    const result = validatePath('/home/cerebro/projects/amp///docs//test.md', baseDir);
    expect(result).toBe('/home/cerebro/projects/amp/docs/test.md');
  });

  it('normalizes path with dot segments', () => {
    const result = validatePath('/home/cerebro/projects/amp/./docs/./test.md', baseDir);
    expect(result).toBe('/home/cerebro/projects/amp/docs/test.md');
  });

  it('rejects path with mixed traversal after resolution', () => {
    expect(() => validatePath('/home/cerebro/projects/amp/docs/../../etc/passwd', baseDir))
      .toThrow('Path must be within allowed directory');
  });

  it('includes the base directory in the error message', () => {
    expect(() => validatePath('/etc/passwd', baseDir)).toThrow(baseDir);
  });

  it('includes the offending path in the error message', () => {
    expect(() => validatePath('/etc/passwd', baseDir)).toThrow('/etc/passwd');
  });
});

// ─── validatePath symlink confinement (realpath layer) ───────────────────────
//
// Lexical confinement alone passes a symlink that LIVES inside the base but
// TARGETS a file outside it (the path string is in-base; only realpath reveals
// the escape). These tests use a real temp base on disk so realpathSync resolves.

describe('validatePath symlink confinement', () => {
  // realpathSync normalizes macOS /var -> /private/var etc., so the base used in
  // assertions must match what the helper sees after its internal realpath.
  let base: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(path.join(tmpdir(), 'amp-wiki-confine-')));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('rejects a symlink inside the base that points to a file outside it', () => {
    // Secret file OUTSIDE the base; symlink INSIDE the base pointing at it.
    const outsideRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'amp-wiki-outside-')));
    try {
      const secret = path.join(outsideRoot, 'secret.md');
      writeFileSync(secret, '# leaked');
      mkdirSync(path.join(base, 'docs'), { recursive: true });
      const link = path.join(base, 'docs', 'link.md');
      try {
        symlinkSync(secret, link);
      } catch {
        // Symlink creation can fail without privileges (e.g. Windows). Skip.
        return;
      }
      // Lexically inside base, but realpath escapes -> must be rejected.
      expect(() => validatePath(link, base)).toThrow('Path must be within allowed directory');
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('accepts a legitimate real path inside the base', () => {
    mkdirSync(path.join(base, 'docs'), { recursive: true });
    const real = path.join(base, 'docs', 'real.md');
    writeFileSync(real, '# real');
    expect(validatePath(real, base)).toBe(real);
  });

  it('accepts a not-yet-existing output dir under the base (ENOENT fallthrough)', () => {
    // Compile output_dir may not exist yet; lexical confinement must still allow it.
    const notYet = path.join(base, 'wiki-out', 'nested');
    expect(validatePath(notYet, base)).toBe(notYet);
  });
});

// ─── getAllowedBaseDir tests ──────────────────────────────────────────────────

describe('getAllowedBaseDir', () => {
  const originalEnv = process.env['AMP_INGEST_ALLOW_DIR'];

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['AMP_INGEST_ALLOW_DIR'] = originalEnv;
    } else {
      delete process.env['AMP_INGEST_ALLOW_DIR'];
    }
  });

  it('returns AMP_INGEST_ALLOW_DIR when set', () => {
    process.env['AMP_INGEST_ALLOW_DIR'] = '/opt/amp-data';
    expect(getAllowedBaseDir()).toBe('/opt/amp-data');
  });

  it('falls back to cwd when AMP_INGEST_ALLOW_DIR is not set', () => {
    delete process.env['AMP_INGEST_ALLOW_DIR'];
    expect(getAllowedBaseDir()).toBe(path.resolve(process.cwd()));
  });

  it('resolves relative AMP_INGEST_ALLOW_DIR to absolute', () => {
    process.env['AMP_INGEST_ALLOW_DIR'] = './data';
    const result = getAllowedBaseDir();
    expect(path.isAbsolute(result)).toBe(true);
  });
});

// ─── Tool handler integration tests ─────────────────────────────────────────

describe('buildWikiToolHandlers path validation', () => {
  const mockCompiler: IWikiCompiler = {
    compile: vi.fn(async () => ({
      articles_compiled: 0,
      indexes_generated: 0,
      links_resolved: 0,
      backlinks_rendered: 0,
      output_dir: '/tmp/wiki',
    } as CompileResult)),
  };

  const mockIngestion: IIngestionService = {
    ingest: vi.fn(async () => ({
      source_id: 'src-test',
      entities_created: 0,
      entities_linked: 0,
      claims_stored: 0,
      citations_created: 0,
    } as IngestResult)),
  };

  const mockLinter: IWikiLinter = {
    lint: vi.fn(async () => ({
      checks: {},
      total_issues: 0,
      summary: 'Clean',
    } as LintResult)),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setWikiServiceInstances({
      wikiCompiler: mockCompiler,
      ingestionService: mockIngestion,
      wikiLinter: mockLinter,
    });
  });

  describe('berry_ingest', () => {
    it('rejects source_path outside allowed directory', async () => {
      const handlers = buildWikiToolHandlers();
      await expect(handlers.berry_ingest({
        source_path: '/etc/passwd',
        source_type: 'article',
        project_tag: 'project:test',
      })).rejects.toThrow('Path must be within allowed directory');
      expect(mockIngestion.ingest).not.toHaveBeenCalled();
    });

    it('rejects source_path with directory traversal', async () => {
      const handlers = buildWikiToolHandlers();
      await expect(handlers.berry_ingest({
        source_path: '../../../etc/shadow',
        source_type: 'article',
        project_tag: 'project:test',
      })).rejects.toThrow('Path must be within allowed directory');
      expect(mockIngestion.ingest).not.toHaveBeenCalled();
    });

    it('allows source_path within cwd', async () => {
      const handlers = buildWikiToolHandlers();
      const validPath = path.join(process.cwd(), 'docs', 'test-file.md');
      await handlers.berry_ingest({
        source_path: validPath,
        source_type: 'article',
        project_tag: 'project:test',
      });
      expect(mockIngestion.ingest).toHaveBeenCalledTimes(1);
    });
  });

  describe('berry_compile', () => {
    it('rejects output_dir outside allowed directory', async () => {
      const handlers = buildWikiToolHandlers();
      await expect(handlers.berry_compile({
        project_tag: 'project:test',
        output_dir: '/tmp/evil-output',
      })).rejects.toThrow('Path must be within allowed directory');
      expect(mockCompiler.compile).not.toHaveBeenCalled();
    });

    it('rejects output_dir with directory traversal', async () => {
      const handlers = buildWikiToolHandlers();
      await expect(handlers.berry_compile({
        project_tag: 'project:test',
        output_dir: '../../tmp/evil',
      })).rejects.toThrow('Path must be within allowed directory');
      expect(mockCompiler.compile).not.toHaveBeenCalled();
    });

    it('allows output_dir within cwd', async () => {
      const handlers = buildWikiToolHandlers();
      const validDir = path.join(process.cwd(), 'output', 'wiki');
      await handlers.berry_compile({
        project_tag: 'project:test',
        output_dir: validDir,
      });
      expect(mockCompiler.compile).toHaveBeenCalledTimes(1);
    });
  });
});
