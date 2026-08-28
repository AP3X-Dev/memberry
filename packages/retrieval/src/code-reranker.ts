import type { CodeReranker, CodeSearchResult } from '@memberry/code';

import { RERANKER_DEFAULT_TIMEOUT_MS } from './reranker.js';
import { applyServedRerankerV1, createServedRerankerProviderV1 } from './served-reranker.js';
import type { RetrievalResult } from './types.js';

/**
 * The reranker scores `title` and `content` with BM25F.
 *
 * Where the text actually lives, verified per channel: symbol rows carry `signature` and
 * `doc_comment`; `semanticVectorSearch` puts the memory text in `signature` and hardcodes
 * `doc_comment: ''`. NO channel populates `content` — it is optional on CodeSearchResult and
 * exists for other callers. Hence `signature` leads the join: it is the only field guaranteed
 * to carry text for BOTH source types.
 */
function toRetrievalResult(row: CodeSearchResult): RetrievalResult {
  return {
    id: row.id,
    source_type: row.source_type,
    title: row.name,
    content: [row.signature, row.doc_comment, row.content].filter(Boolean).join('\n'),
    score: row.score,
    metadata: {},
  };
}

/**
 * IDX-004: adapts the served BM25F reranker to the code plane. Lives here, not in
 * `packages/code`, because `@memberry/retrieval` depends on `@memberry/code` and not the other
 * way round — code declares the `CodeReranker` shape, retrieval implements it, and
 * `packages/mcp` wires the two together.
 *
 * Returns a permutation of `rows`, or `rows` unchanged if the reranker declined.
 *
 * NOTE this constructs a served provider OUTSIDE the `rerankerMode === 'served'` prerequisite
 * gate in bootstrap. That is intended — the code plane's use is governed by
 * MEMBERRY_CODE_RERANK_V1, not by the memory plane's reranker mode — but it does mean the two
 * planes can disagree about whether reranking is on.
 */
export function createCodeRerankerV1(): CodeReranker {
  // Latched, not per-call. A declined rerank is otherwise INDISTINGUISHABLE from a successful
  // one: same shape, same length, no error, nothing in any log. This repo already had to ship a
  // vector-index guard because a channel "reported SUCCESS with nothing in any log" — do not add
  // a second instance of that failure mode. Latching keeps it to one line per process.
  let declinedWarned = false;
  const provider = createServedRerankerProviderV1();

  return async (query, rows) => {
    if (rows.length === 0) return rows;
    const byId = new Map(rows.map((row) => [row.id, row]));
    const applied = await applyServedRerankerV1(query, rows.map(toRetrievalResult), provider);

    if (applied.outcome !== 'reranked') {
      if (!declinedWarned) {
        declinedWarned = true;
        console.error(
          '[memberry-code] IDX-004 rerank declined (baseline outcome) — code search is returning '
          + `fused order for ${rows.length} candidates. Commonly the `
          + `${RERANKER_DEFAULT_TIMEOUT_MS}ms provider timeout. Logged once per process.`,
        );
      }
      return rows;
    }

    const out: CodeSearchResult[] = [];
    for (const result of applied.results) {
      const row = byId.get(result.id);
      if (row) out.push(row);
    }
    // Unreachable by construction, and deliberately NOT given a warning like the branch above:
    // on the 'reranked' outcome `applied.results.length === rows.length`, and rrfFusion dedupes
    // by id, so every `byId.get` hits. Kept as a total-function guard, not a live path — if it
    // ever fires the reranker broke its own contract and the fused order is the safe answer.
    return out.length === rows.length ? out : rows;
  };
}
