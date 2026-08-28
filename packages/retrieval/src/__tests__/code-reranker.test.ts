// IDX-004 acceptance gate — spec §5, assertions S9 and S10 (the adapter half).
// The pipeline-order assertions S1-S8/S13-S16 live in packages/code, where the pipeline is.

import { describe, expect, it } from 'vitest';

import { createCodeRerankerV1 } from '../code-reranker.js';

interface Row {
  id: string;
  source_type: 'symbol' | 'semantic';
  name: string;
  kind: string;
  file_path: string;
  start_line: number;
  signature: string;
  doc_comment: string;
  score: number;
  content?: string;
}

function symbol(over: Partial<Row> & { id: string; name: string }): Row {
  return {
    source_type: 'symbol',
    kind: 'function',
    file_path: `src/${over.name}.ts`,
    start_line: 1,
    signature: '',
    doc_comment: '',
    // RRF scores are what actually arrive here — small, and nearly uniform.
    score: 0.016,
    ...over,
  };
}

describe('IDX-004 code reranker adapter', () => {
  it('S9 — returns a permutation: same ids, same length, order actually changed', async () => {
    const rerank = createCodeRerankerV1();
    const rows = [
      symbol({ id: 'a', name: 'unrelatedHelper', signature: 'function unrelatedHelper()' }),
      symbol({ id: 'b', name: 'alsoUnrelated', signature: 'function alsoUnrelated()' }),
      symbol({
        id: 'c',
        name: 'groupAndBudget',
        signature: 'function groupAndBudget(results, maxTokens)',
        doc_comment: 'Chooses which results to keep inside the token budget.',
      }),
    ];
    const out = await rerank('token budget packer chooses which results to keep', rows as never);

    expect(out).toHaveLength(rows.length);
    expect([...out].map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
    // The row that actually answers the query must not still be last.
    expect(out[0].id).toBe('c');
  });

  it('S10 — scores a semantic row on `signature`, where its text actually lives', async () => {
    const rerank = createCodeRerankerV1();
    // This is the real shape semanticVectorSearch emits: the memory prose is in `signature`,
    // `doc_comment` is hardcoded '', `content` is never populated, and `name` is a bare label.
    // If the adapter mapped content from doc_comment/content only, this row would score on an
    // empty string and could never win.
    const rows = [
      symbol({ id: 'sym', name: 'unrelatedHelper', signature: 'function unrelatedHelper()' }),
      symbol({
        id: 'mem',
        source_type: 'semantic',
        name: '[Semantic] abc123456789',
        kind: 'semantic',
        file_path: '',
        start_line: 0,
        signature: 'The consolidation coordinator batches episodes before promoting them.',
        doc_comment: '',
      }),
    ];
    const out = await rerank('consolidation coordinator batches episodes', rows as never);

    expect(out).toHaveLength(2);
    expect(out[0].id).toBe('mem');
  });

  it('S10b — an empty window is returned untouched', async () => {
    const rerank = createCodeRerankerV1();
    await expect(rerank('anything', [])).resolves.toEqual([]);
  });
});
