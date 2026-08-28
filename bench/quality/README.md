# bench/quality — memory-quality CI gate

Deterministic, infra-free retrieval-quality benchmark. Scores MemBerry's real ranking path
(lexical + RRF + MMR, no vector embeddings) over a committed golden set and reports
**Recall@k, MRR, nDCG@k** plus conflict / knowledge-update metrics. Exits non-zero on any
threshold failure, so it gates in CI without an OpenAI key or a live Neo4j/Redis. The
standalone `npm run bench:quality` step left the `unit` job in `a40755c`, but the control
itself did not leave CI: the deterministic lab gate runs it inside `npm run bench:lab:ci`
(`.github/workflows/ci.yml`, "Evaluation-lab deterministic gate"), and
`packages/retrieval/src/__tests__/quality.regression.test.ts` asserts every
`QUALITY_THRESHOLDS` entry — `recallAt10`, `ndcgAt10`, `mrr`, `precisionAt5`,
`intentAccuracy` — on each `npm test`. A threshold miss still fails the build. Run
`npm run bench:quality` locally when you want the full report rather than a pass/fail.

- `eval.ts` — the runnable gate. Thin wrapper over
  `packages/retrieval/bench/quality-eval.ts` (reuses its corpus, labels, ranking, and
  metrics — no duplication). Run with `npm run bench:quality`.
- `RESULTS.md` — measured baseline numbers, the thresholds, the threshold rationale, and
  the exact commands.
- `last-run.json` — runtime metrics snapshot (gitignored; written on each run).

```bash
npm run bench:quality          # run the gate
npx tsx bench/quality/eval.ts  # direct
npx tsx bench/quality/eval.ts --json
```
