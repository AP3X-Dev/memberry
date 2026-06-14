// packages/code/src/__tests__/parser.size-guard.test.ts
//
// OPT-35: parseFile reads + tree-sitter-parses the whole file with no size
// guard, unlike the structural-search path (2 MB cap). A multi-MB generated /
// minified / mislabeled-binary file can blow up parse time and memory. parseFile
// now stat-and-skips files over MEMBERRY_MAX_PARSE_FILE_BYTES, returning an empty
// ParsedFile so the caller indexes nothing for that file.
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, expect, it, afterEach } from 'vitest';
import { parseFile } from '../parser.js';

const ENV = 'MEMBERRY_MAX_PARSE_FILE_BYTES';

describe('parseFile size guard (OPT-35)', () => {
  afterEach(() => {
    delete process.env[ENV];
  });

  async function writeTs(contents: string): Promise<{ dir: string; filePath: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'amp-parser-size-'));
    const filePath = join(dir, 'mod.ts');
    await writeFile(filePath, contents, 'utf-8');
    return { dir, filePath };
  }

  const SRC = 'export function hello(): string { return "hi"; }\n';

  it('skips a file over the cap, returning an empty ParsedFile', async () => {
    process.env[ENV] = '10'; // tiny cap → the file (>10 bytes) is skipped
    const { dir, filePath } = await writeTs(SRC);
    try {
      const parsed = await parseFile(filePath, 'typescript');
      expect(parsed.symbols).toEqual([]);
      expect(parsed.relations).toEqual([]);
      expect(parsed.imports).toEqual([]);
      expect(parsed.file_path).toBe(filePath);
      expect(parsed.language).toBe('typescript');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('parses normally when the file is within the cap', async () => {
    process.env[ENV] = String(10 * 1024 * 1024); // generous cap
    const { dir, filePath } = await writeTs(SRC);
    try {
      const parsed = await parseFile(filePath, 'typescript');
      expect(parsed.symbols.some((s) => s.name === 'hello')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uses the 2 MB default when the override is unset/invalid (small file still parses)', async () => {
    for (const bad of [undefined, '0', '-5', 'abc']) {
      if (bad === undefined) delete process.env[ENV];
      else process.env[ENV] = bad;
      const { dir, filePath } = await writeTs(SRC);
      try {
        const parsed = await parseFile(filePath, 'typescript');
        expect(parsed.symbols.some((s) => s.name === 'hello')).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
});
