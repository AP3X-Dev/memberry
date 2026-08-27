import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// EVAL-001 spec section 2.2.1 — render-grammar pin.
//
// EVAL-001 parses berry_context output with a fixed grammar to split code items
// from memory items. Exactly two code-item render sites are reachable through
// berry_context, and their render expressions are byte-identical apart from the
// receiver binding name:
//
//   packages/retrieval/src/assembler.ts  in assembleCandidateExecutionServed  (row.)
//   packages/retrieval/src/assembler.ts  in assembleRankedInternal            (r.)
//
// If one of them drifts, the grammar keeps matching the other, so keywordRecall
// still looks fine while noiseRate silently skews. That is what this file pins.
//
// NOT PINNED HERE, deliberately: packages/code/src/search.ts renders
// '### name (kind) — path:line' (no bold, no backticks) for berry_code_context
// (registered in packages/code/src/tools.ts). The EVAL-001 runner never calls
// that tool, so pinning it would couple EVAL-001 to a surface outside its scope.
// Note also that the spec misattributes that renderer to berry_code_search;
// berry_code_search returns JSON.stringify(...) in packages/code/src/tools.ts
// and renders no markdown at all.

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ASSEMBLER = resolve(ROOT, 'packages/retrieval/src/assembler.ts');
const CODE_TYPES = resolve(ROOT, 'packages/code/src/types.ts');

/** The pinned grammar EVAL-001 uses to recognise a code item. */
const CODE_ITEM = /^\*\*(?<name>.+?)\*\* \((?<kind>[a-z]+)\) — `(?<path>[^:`]+):(?<line>\d+)`/;

/**
 * The render template source, with the receiver binding name normalised to `X`.
 * This is a byte-level pin: both call sites must reduce to exactly this string.
 */
const TEMPLATE =
  "`**${X.name}** (${X.kind}) — \\`${X.file_path}:${X.start_line}\\`\\n\\`${X.signature}\\`" +
  "${X.doc_comment ? '\\n> ' + X.doc_comment.split('\\n')[0] : ''}`";

/** The same shape as TEMPLATE, as a function, so the grammar is tested against real output. */
type CodeRow = {
  name: string; kind: string; file_path: string; start_line: number;
  signature: string; doc_comment?: string;
};
const render = (X: CodeRow): string =>
  `**${X.name}** (${X.kind}) — \`${X.file_path}:${X.start_line}\`\n\`${X.signature}\`${X.doc_comment ? '\n> ' + X.doc_comment.split('\n')[0] : ''}`;

const assemblerSource = readFileSync(ASSEMBLER, 'utf8');

/** Every code-item render template in the assembler, in source order. */
const sites = [...assemblerSource.matchAll(/`\*\*\$\{(?:row|r)\.name\}[^\n]*?\}`(?=[;,]\n)/g)];

describe('EVAL-001 render grammar', () => {
  it('has exactly two code-item render sites, in the two functions berry_context reaches', () => {
    expect(sites).toHaveLength(2);

    // Located by enclosing declaration rather than by line number, so unrelated
    // edits above them do not churn this test. Currently :496 and :1018.
    const served = assemblerSource.search(/^ {2}async assembleCandidateExecutionServed\(/m);
    const ranked = assemblerSource.search(/^ {2}private async assembleRankedInternal\(/m);
    expect(served).toBeGreaterThan(-1);
    expect(ranked).toBeGreaterThan(served);

    expect(sites[0]!.index).toBeGreaterThan(served);
    expect(sites[0]!.index).toBeLessThan(ranked);
    expect(sites[1]!.index).toBeGreaterThan(ranked);
  });

  it('renders both sites from a byte-identical template', () => {
    const normalised = sites.map((site) => site[0].replace(/\b(?:row|r)\b/g, 'X'));
    expect(normalised[0]).toBe(TEMPLATE);
    expect(normalised[1]).toBe(TEMPLATE);
    expect(normalised[0]).toBe(normalised[1]);
  });

  it('separates name and location with U+2014 EM DASH', () => {
    for (const site of sites) {
      const dash = /\}\) (.) \\`\$\{/.exec(site[0])?.[1];
      expect(dash?.codePointAt(0)).toBe(0x2014);
      expect([...Buffer.from(dash!, 'utf8')]).toEqual([0xe2, 0x80, 0x94]);
    }
    expect(TEMPLATE.codePointAt(TEMPLATE.indexOf('\u2014'))).toBe(0x2014);
    expect(CODE_ITEM.source).toContain('\u2014');
  });
});

describe('EVAL-001 grammar against real rendered output', () => {
  const cases: Array<{ label: string; row: CodeRow; path: string; line: string }> = [
    {
      label: 'relative path',
      row: {
        name: 'assembleRanked', kind: 'method', file_path: 'packages/retrieval/src/assembler.ts',
        start_line: 908, signature: 'async assembleRanked(task: string)',
        doc_comment: 'Rank and assemble.\nSecond line dropped.',
      },
      path: 'packages/retrieval/src/assembler.ts', line: '908',
    },
    {
      // Load-bearing: the live corpus is ingested from /workspace/memberry/...
      label: 'POSIX absolute path',
      row: {
        name: 'berry_context', kind: 'function', file_path: '/workspace/memberry/packages/mcp/src/tools.ts',
        start_line: 42, signature: 'function berry_context(): void', doc_comment: 'Blended context.',
      },
      path: '/workspace/memberry/packages/mcp/src/tools.ts', line: '42',
    },
    {
      label: 'structural extractor kind',
      row: {
        name: 'aws_s3_bucket.logs', kind: 'resource', file_path: 'infra/main.tf',
        start_line: 7, signature: 'resource "aws_s3_bucket" "logs"', doc_comment: 'Log bucket.',
      },
      path: 'infra/main.tf', line: '7',
    },
    {
      label: 'no doc comment',
      row: {
        name: 'SparseVector', kind: 'interface', file_path: 'packages/code/src/types.ts',
        start_line: 80, signature: 'interface SparseVector',
      },
      path: 'packages/code/src/types.ts', line: '80',
    },
  ];

  for (const { label, row, path, line } of cases) {
    it(`matches ${label}`, () => {
      const groups = CODE_ITEM.exec(render(row))?.groups;
      expect(groups).toMatchObject({ name: row.name, kind: row.kind, path, line });
    });
  }

  it('emits the doc-comment line only when there is a doc comment', () => {
    expect(render(cases[0]!.row)).toContain('\n> Rank and assemble.');
    expect(render(cases[0]!.row)).not.toContain('Second line dropped.');
    expect(render(cases[3]!.row)).not.toContain('\n> ');
  });

  // Documented limitation, pinned so it is not rediscovered in the field: a
  // Windows absolute path does NOT match. The drive-letter colon terminates
  // (?<path>[^:`]+) and there is no backtrack, so \d+ faces '\Users...'.
  // Harmless today (the corpus is ingested with POSIX paths); if that ever
  // changes, this test is where the grammar gets widened.
  it('does NOT match a Windows absolute path', () => {
    const windows = render({
      name: 'main', kind: 'function', file_path: 'C:\\Users\\dev\\memberry\\src\\main.ts',
      start_line: 1, signature: 'function main(): void',
    });
    expect(windows).toContain('C:\\Users\\dev');
    expect(CODE_ITEM.exec(windows)).toBeNull();
  });
});

describe('EVAL-001 kind vocabulary', () => {
  it('keeps every SymbolKind lowercase single-word ASCII, so [a-z]+ has no gap', () => {
    const source = readFileSync(CODE_TYPES, 'utf8');
    const union = /export type SymbolKind =([\s\S]*?);/.exec(source)?.[1];
    expect(union).toBeDefined();

    const kinds = [...union!.replace(/\/\/[^\n]*/g, '').matchAll(/'([^']*)'/g)].map((m) => m[1]!);
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds).toContain('resource');
    for (const kind of kinds) {
      expect(kind, `SymbolKind '${kind}' is not matched by [a-z]+`).toMatch(/^[a-z]+$/);
      expect(CODE_ITEM.exec(render({
        name: 'x', kind, file_path: 'a/b.ts', start_line: 1, signature: 'x',
      }))?.groups?.kind).toBe(kind);
    }
  });
});
