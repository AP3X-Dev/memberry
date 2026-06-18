// packages/wiki/src/__tests__/cli-lint.test.ts
// gap-17: the wiki CLI `lint` command and the MCP `berry_lint` handler share a
// single formatter (formatLintReport). These tests assert:
//   1. DEFAULT (summaryOnly falsy) emits per-issue detail lines —
//      `[ISSUES] <check> (N)` headers, `  [ERROR|WARN|INFO] <message>` issues,
//      and `    Suggestion: ...` lines.
//   2. summaryOnly:true suppresses all detail, leaving only the terse summary +
//      total (the legacy CLI behavior).
//   3. Passing checks render `[PASS] <check>`.
//   4. The MCP berry_lint handler produces the same output as
//      formatLintReport(result) — i.e. the two surfaces do not drift.

import { describe, it, expect, vi } from 'vitest';
import { formatLintReport } from '../lint.js';
import { buildWikiToolHandlers, createWikiContainer } from '../tools.js';
import type { LintResult, IWikiLinter } from '../index.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function lintResultWithIssues(): LintResult {
  return {
    checks: {
      orphan_pages: {
        check: 'orphan_pages',
        passed: false,
        issues: [
          {
            severity: 'warning',
            entity: 'EnemyAI',
            message: 'Entity "EnemyAI" (component) has no semantic knowledge about it',
            suggestion: 'Add claims about this entity via berry_store or berry_ingest',
          },
        ],
      },
      contradictions: {
        check: 'contradictions',
        passed: false,
        issues: [
          {
            severity: 'error',
            entity: 'sem-123',
            message: 'Semantic "Auth uses JWT..." has 2 contradiction signals (confidence: 0.6)',
            suggestion: 'Review and resolve this contradiction — the claim may be outdated or wrong',
          },
        ],
      },
      low_confidence: {
        check: 'low_confidence',
        passed: true,
        issues: [],
      },
    },
    total_issues: 2,
    summary: 'Ran 3 checks: 1 passed, 2 with issues (2 total issues)',
  };
}

// ─── formatLintReport — default (detailed) ───────────────────────────────────

describe('formatLintReport — default (detailed)', () => {
  it('emits per-issue detail lines with severity, message, and suggestion', () => {
    const out = formatLintReport(lintResultWithIssues());

    // Check header with issue count
    expect(out).toContain('[ISSUES] orphan_pages (1)');
    expect(out).toContain('[ISSUES] contradictions (1)');

    // Severity-prefixed, indented issue messages
    expect(out).toContain('  [WARN] Entity "EnemyAI" (component) has no semantic knowledge about it');
    expect(out).toContain('  [ERROR] Semantic "Auth uses JWT..." has 2 contradiction signals (confidence: 0.6)');

    // Suggestion lines
    expect(out).toContain('    Suggestion: Add claims about this entity via berry_store or berry_ingest');
    expect(out).toContain('    Suggestion: Review and resolve this contradiction');
  });

  it('renders passing checks as [PASS] <check> with no issue lines', () => {
    const out = formatLintReport(lintResultWithIssues());
    expect(out).toContain('[PASS] low_confidence');
  });

  it('includes the overall summary and total at the end', () => {
    const out = formatLintReport(lintResultWithIssues());
    expect(out).toContain('Ran 3 checks: 1 passed, 2 with issues (2 total issues)');
    expect(out).toContain('Total issues: 2');
  });

  it('maps info severity to the [INFO] prefix', () => {
    const result: LintResult = {
      checks: {
        missing_links: {
          check: 'missing_links',
          passed: false,
          issues: [{ severity: 'info', message: 'A and B co-occur', suggestion: undefined }],
        },
      },
      total_issues: 1,
      summary: 'Ran 1 checks: 0 passed, 1 with issues (1 total issues)',
    };
    const out = formatLintReport(result);
    expect(out).toContain('  [INFO] A and B co-occur');
  });

  it('omits the Suggestion line when an issue has no suggestion', () => {
    const result: LintResult = {
      checks: {
        contradictions: {
          check: 'contradictions',
          passed: false,
          issues: [{ severity: 'error', message: 'Check failed: boom' }],
        },
      },
      total_issues: 1,
      summary: 'Ran 1 checks: 0 passed, 1 with issues (1 total issues)',
    };
    const out = formatLintReport(result);
    expect(out).toContain('  [ERROR] Check failed: boom');
    expect(out).not.toContain('Suggestion:');
  });
});

// ─── formatLintReport — summaryOnly ──────────────────────────────────────────

describe('formatLintReport — summaryOnly', () => {
  it('prints only the terse summary + total, suppressing all detail', () => {
    const out = formatLintReport(lintResultWithIssues(), { summaryOnly: true });

    expect(out).toBe('Ran 3 checks: 1 passed, 2 with issues (2 total issues)\nTotal issues: 2');

    // No per-issue detail leaks through
    expect(out).not.toContain('[ISSUES]');
    expect(out).not.toContain('[PASS]');
    expect(out).not.toContain('[WARN]');
    expect(out).not.toContain('[ERROR]');
    expect(out).not.toContain('Suggestion:');
  });
});

// ─── CLI lint handler parity (driven with a stub lint result) ────────────────
//
// The CLI `lint` command prints `formatLintReport(result, { summaryOnly })`.
// We can't easily boot the full CLI (Neo4j connection), so we model exactly
// what the command does: lint() then format. This proves default-detail vs
// --summary-only behavior end-to-end against the formatter the CLI calls.

describe('CLI lint formatting (stubbed lint result)', () => {
  function runCliLintFormat(result: LintResult, summaryOnly: boolean): string {
    // Mirrors cli.ts `lint` case: console.log(formatLintReport(result, { summaryOnly }))
    return formatLintReport(result, { summaryOnly });
  }

  it('DEFAULT prints full issue detail', () => {
    const out = runCliLintFormat(lintResultWithIssues(), false);
    expect(out).toContain('[ISSUES] orphan_pages (1)');
    expect(out).toContain('  [WARN] Entity "EnemyAI"');
    expect(out).toContain('    Suggestion: Add claims');
  });

  it('--summary-only prints terse counts only', () => {
    const out = runCliLintFormat(lintResultWithIssues(), true);
    expect(out).not.toContain('[ISSUES]');
    expect(out).toContain('Total issues: 2');
  });
});

// ─── MCP berry_lint shares the same formatter (no drift) ─────────────────────

describe('berry_lint handler uses the shared formatLintReport', () => {
  it('produces exactly formatLintReport(result) for the lint output', async () => {
    const fixture = lintResultWithIssues();
    const stubLinter: IWikiLinter = {
      lint: vi.fn(async () => fixture),
    };
    const handlers = buildWikiToolHandlers(createWikiContainer({ wikiLinter: stubLinter }));

    const res = await handlers.berry_lint({ project_tag: 'project:test' });
    const text = res.content[0].text;

    expect(text).toBe(formatLintReport(fixture));
    // Sanity: it carries the detail, not just the summary
    expect(text).toContain('[ISSUES] orphan_pages (1)');
    expect(text).toContain('  [ERROR] Semantic "Auth uses JWT...');
  });
});
