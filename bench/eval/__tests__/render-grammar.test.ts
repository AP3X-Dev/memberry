// EVAL-001 §2.2.1 — the extraction grammar is a PINNED CONTRACT.
//
// berry_context returns rendered markdown, not structured items, so `kind` and the
// doc-comment signal exist only inside the rendered line. Two render sites are
// reachable through berry_context and their expressions are byte-identical:
//
//   packages/retrieval/src/assembler.ts:651   (candidate-served)
//   packages/retrieval/src/assembler.ts:1145  (legacy)
//
// Both emit:
//   `**${name}** (${kind}) — \`${file_path}:${start_line}\`\n\`${signature}\`${doc ? '\n> ' + doc.split('\n')[0] : ''}`
//
// The fixtures below reproduce that expression verbatim for each site. If a render
// changes, this goes red and noiseRate is known-invalid rather than quietly wrong.

import { describe, expect, it } from 'vitest';

import { CODE_ITEM_GRAMMAR, isNoiseItem, isTestFileItem, parseCodeItems } from '../run-eval001.js';

interface Row {
  name: string; kind: string; file_path: string; start_line: number;
  signature: string; doc_comment?: string;
}

/** assembler.ts:651 — the candidate-served render expression, reproduced verbatim. */
function renderServed(row: Row): string {
  return `**${row.name}** (${row.kind}) — \`${row.file_path}:${row.start_line}\`\n\`${row.signature}\`${row.doc_comment ? '\n> ' + row.doc_comment.split('\n')[0] : ''}`;
}

/** assembler.ts:1145 — the legacy render expression, reproduced verbatim. */
function renderLegacy(r: Row): string {
  return `**${r.name}** (${r.kind}) — \`${r.file_path}:${r.start_line}\`\n\`${r.signature}\`${r.doc_comment ? '\n> ' + r.doc_comment.split('\n')[0] : ''}`;
}

const CLASS_ROW: Row = {
  name: 'UnifiedAssembler', kind: 'class',
  file_path: 'packages/retrieval/src/assembler.ts', start_line: 150,
  signature: 'class UnifiedAssembler', doc_comment: 'Composes the code, arch and memory planes.\nsecond line',
};
const VARIABLE_ROW: Row = {
  name: 'session', kind: 'variable',
  file_path: 'packages/core/src/__tests__/store.test.ts', start_line: 42,
  signature: 'session: () => session',
};

describe('EVAL-001 pinned render grammar', () => {
  for (const [site, render] of [['assembler.ts:651', renderServed], ['assembler.ts:1145', renderLegacy]] as const) {
    it(`extracts name/kind/path/line from the ${site} render`, () => {
      const match = CODE_ITEM_GRAMMAR.exec(render(CLASS_ROW).split('\n')[0]!);
      expect(match?.groups).toEqual(expect.objectContaining({
        name: 'UnifiedAssembler',
        kind: 'class',
        path: 'packages/retrieval/src/assembler.ts',
        line: '150',
      }));
    });

    it(`detects the doc-comment line in the ${site} render`, () => {
      const withDoc = parseCodeItems(render(CLASS_ROW));
      expect(withDoc).toHaveLength(1);
      expect(withDoc[0]!.hasDocComment).toBe(true);
      // Only the FIRST doc line is rendered.
      expect(withDoc[0]!.block).toContain('> Composes the code, arch and memory planes.');
      expect(withDoc[0]!.block).not.toContain('second line');

      const withoutDoc = parseCodeItems(render(VARIABLE_ROW));
      expect(withoutDoc).toHaveLength(1);
      expect(withoutDoc[0]!.hasDocComment).toBe(false);
    });

    it(`classifies test-file and bare-variable noise from the ${site} render`, () => {
      const [noisy] = parseCodeItems(render(VARIABLE_ROW));
      expect(isTestFileItem(noisy!.path)).toBe(true);
      expect(isNoiseItem(noisy!)).toBe(true);

      const [clean] = parseCodeItems(render(CLASS_ROW));
      expect(isNoiseItem(clean!)).toBe(false);
    });
  }

  it('renders identically at both sites, so one grammar covers both', () => {
    expect(renderServed(CLASS_ROW)).toBe(renderLegacy(CLASS_ROW));
    expect(renderServed(VARIABLE_ROW)).toBe(renderLegacy(VARIABLE_ROW));
  });

  it('flags a bare variable outside a test file as noise, and a documented one as clean', () => {
    const bare = parseCodeItems(renderServed({
      name: 'CACHE_TTL', kind: 'variable',
      file_path: 'packages/core/src/cache.ts', start_line: 7, signature: 'const CACHE_TTL = 60',
    }))[0]!;
    expect(isNoiseItem(bare)).toBe(true);

    const documented = parseCodeItems(renderServed({
      name: 'CACHE_TTL', kind: 'variable',
      file_path: 'packages/core/src/cache.ts', start_line: 7, signature: 'const CACHE_TTL = 60',
      doc_comment: 'Seconds a cached entry survives.',
    }))[0]!;
    expect(isNoiseItem(documented)).toBe(false);
  });

  it('parses several items out of one rendered response in order', () => {
    // renderMarkdown emits `<!-- id — path -->` then the item content then a blank line.
    const markdown = [
      '# Unified Context',
      '**Task:** how does the assembler work',
      '',
      '## Code',
      '',
      '<!-- code.fulltext-1 — packages/retrieval/src/assembler.ts -->',
      renderServed(CLASS_ROW),
      '',
      '<!-- code.fulltext-2 — packages/core/src/__tests__/store.test.ts -->',
      renderServed(VARIABLE_ROW),
      '',
    ].join('\n');
    const items = parseCodeItems(markdown);
    expect(items.map((item) => item.name)).toEqual(['UnifiedAssembler', 'session']);
    expect(items.map((item) => item.kind)).toEqual(['class', 'variable']);
    expect(items[0]!.hasDocComment).toBe(true);
    expect(items[1]!.hasDocComment).toBe(false);
  });

  // §2.2.1 trap: packages/code/src/search.ts:284 belongs to berry_code_search, a tool
  // EVAL-001 never calls. Pinning it would couple this eval to an out-of-scope surface.
  it('does NOT match the berry_code_search render at search.ts:284', () => {
    const foreign = '### UnifiedAssembler (class) — packages/retrieval/src/assembler.ts:150';
    expect(CODE_ITEM_GRAMMAR.test(foreign)).toBe(false);
    expect(parseCodeItems(foreign)).toEqual([]);
  });

  it('does NOT match a hyphen where the render uses an em dash', () => {
    expect(CODE_ITEM_GRAMMAR.test('**UnifiedAssembler** (class) - `packages/retrieval/src/assembler.ts:150`')).toBe(false);
  });
});
