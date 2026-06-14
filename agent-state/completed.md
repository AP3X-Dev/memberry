# Completed -- memberry-optimizer

> Durable record of finished work so a restart never re-does it. Enrich from references/state-templates.md.

| ID | Task | Cycle | Commit | Result |
|----|------|-------|--------|--------|
| OPT-01 | Gate ranked code-search channel on default tenant (close cross-tenant code leak) | 1 | `11d703c` | gate green: 1463 passed / 0 failed, build 0; security-reviewer PASS |
| OPT-02 | Bind SSE/Streamable sessions to creating tenant+actor; 403 on token mismatch | 2 | `20c7819` | gate green: 1465 passed / 0 failed (mcp 126), build 0; security-reviewer PASS |
| OPT-03 | Confine post-store re-index paths to ingest base (block arbitrary file read) | 3 | `9b0b029` | gate green: 1472 passed / 0 failed (code 114), build 0; security-reviewer PASS |
| OPT-04 | Validate extracted-fact predicate shape + value bounds (block graph poisoning) | 4 | `a47b124` | gate green: 1480 passed / 0 failed (core 321), build 0; security-reviewer PASS |
| OPT-05 | Redact JSON-quoted credentials in SECRET_ASSIGNMENT (core + graph allowlist) | 5 | `21c3462` | gate green: 1483 passed / 0 failed (core 323, graph 53), build 0; security-reviewer PASS |
| OPT-06 | No-dep ReDoS screen + 4k scan cap for berry_grep JS-side regex (interim; re2→B-01) | 6 | `7ce8c69` | gate green: 1488 passed / 0 failed (mcp 131), build 0; security-reviewer PASS |
| OPT-07 | Bounded tx timeout on grep =~ rawCypher path (Neo4j-side ReDoS backstop) | 7 | `7374e7a` | gate green: 1492 passed / 0 failed (neo4j 193), build 0; security-reviewer PASS |
| OPT-08 (+OPT-13) | Cap MCP request body size → HTTP 413 (memory-exhaustion DoS) | 8 | `27fc2e4` | gate green: 1495 passed / 0 failed (mcp 136), build 0; security-reviewer PASS |
| OPT-09 | Realpath symlink confinement for wiki validatePath + confineToDir | 9 | `28df712` | gate green: 1501 passed / 0 failed (wiki 282), build 0; security-reviewer PASS |
| OPT-10 | Fence untrusted evidence + untrusted-data guard in berry_ask synthesis | 10 | `b2f45d6` | gate green: 1504 passed / 0 failed (retrieval 141), build 0; security-reviewer PASS |
| OPT-11 | Fence+guard dream prompts + sanitize project_card before core-block persist | 11 | `c5f871d` | gate green: 1508 passed / 0 failed (core 327), build 0; security-reviewer PASS |
| OPT-12 | Apply redactSecrets on wiki ingest/braindump when MEMBERRY_REDACT_ON_INGEST | 12 | `cd2bae5` | gate green: 1513 passed / 0 failed (wiki 287), build 0; security-reviewer PASS |
| OPT-14 (+OPT-18) | Bound amp:signals Redis stream with approximate MAXLEN on XADD | 13 | `490c3d3` | gate green: 1514 passed / 0 failed (redis 69), build 0; reliability (no sec-review) |
| OPT-15 | Confine berry_ingest_codebase path to project root (mirror sibling code tools) | 14 | `b815f48` | gate green: 1518 passed / 0 failed (mcp 140), build 0; security-reviewer PASS |
| OPT-16 | Batch DeterministicAssembler per-step queries via UNWIND (6×T→6, output-identical) | 15 | `3855d00` | gate green: 1519 passed / 0 failed (retrieval 142), build 0; perf — output-identity verified |
| OPT-17 | Collapse EntityResolver.resolveExisting 3 sequential queries into 1 precedence-ranked query | 16 | `5b3127f` | gate green: 1523 passed / 0 failed (neo4j 197), build 0; perf — precedence preserved |
| OPT-19 | Release dedup key on failed store() so retries aren't swallowed (unmark + rollback) | 17 | `4c3853d` | gate green: 1526 passed / 0 failed (core 330), build 0; reliability (no sec-review) |
| OPT-20 (+OPT-65) | Read-through embedding cache wired into hot paths | 18 | `3c82078` | gate green: 1532 passed / 0 failed (core 336), build 0; perf — behavior-identical on miss |
| OPT-21 | Create-before-invalidate fact supersession (no data loss on mid-failure) | 19 | `c071375` | gate green: 1534 passed / 0 failed (core 338), build 0; reliability (no sec-review) |
| OPT-22 | Batch wiki episodic fetch into one UNWIND scan (E scans→1, results identical) | 20 | `a39fcfe` | gate green: 1537 passed / 0 failed (wiki 290), build 0; perf — result-identical |
| OPT-23 | Batch per-file symbol upserts into one UNWIND MERGE (N→1, graph-identical) | 21 | `17fc63d` | gate green: 1540 passed / 0 failed (code 117), build 0; perf — graph-identical |
| OPT-24 | Wire tenant/ingest env vars through docker-compose mcp service | 22 | `907ef57` | gate green: 1540 passed / 0 failed (config-only), build 0; ops |
| OPT-25 | In-function rel-type allowlist on invalidateRelationship (close latent injection sink) | 23 | `132426a` | gate green: 1543 passed / 0 failed (neo4j 200), build 0; security-reviewer PASS |
| OPT-26 | Namespace retrieval feedback boost keys by tenant (close cross-tenant ranking channel) | 24 | `2a49cbd` | gate green: 1547 passed / 0 failed (retrieval 146), build 0; security-reviewer PASS |
| OPT-27 | Namespace context-cache keys by tenant (+block-invalidation path) | 25 | `5f5b026` | gate green: 1557 passed / 0 failed, build 0; security-reviewer PASS |
| OPT-28 | Set HTTP slowloris timeouts (headers/request/keepAlive) | 26 | `5dfd81d` | gate green: 1560 passed / 0 failed (mcp 143), build 0; security-reviewer PASS |
| OPT-29 | Fail-closed multi-tenant binding: reject non-tenant tokens (MEMBERRY_ALLOW_DEFAULT_TENANT opt-out) | 27 | `fd8046d` | gate green: 1561 passed / 0 failed (mcp 144), build 0; security-reviewer PASS |
| OPT-30 (+OPT-38) | Validate token-pair parsing (length 4..4096) + warn on skipped/empty/zero-pair entries | 28 | `760254c` | gate green: 1571 passed / 0 failed (mcp 154), build 0; security-reviewer PASS |
| OPT-31 | Gate extraction-driven fact invalidation by confidence (protect established facts from untrusted contradictions) | 29 | `a941912` | gate green: 1576 passed / 0 failed (core 348), build 0; security-reviewer PASS |
| OPT-32 | Per-item evidence cap for berry_ask synthesis (one oversized memory can't dominate the prompt) | 30 | `d023c6a` | gate green: 1586 passed / 0 failed (retrieval 156), build 0; perf/hardening (verifier-only) |
| OPT-33 | Broaden secret redaction (Stripe/Bearer/escaped-quote/keywords) | 31 | `607f1ae` | gate green: 1592 passed / 0 failed (core 353), build 0; security-reviewer PASS |
| OPT-34 | Dedupe graph redactor to @memberry/core (fix github_pat_ export drift) | 31 | `607f1ae` | gate green: 1592 passed / 0 failed (graph 54), build 0; security-reviewer PASS |
| OPT-35 | Size guard for CodeIndexer parseFile (stat-and-skip > 2 MiB) | 32 | `5a46f84` | gate green: 1595 passed / 0 failed (code 120), build 0; hardening (verifier-only) |
| OPT-36 | Bound berry_store signals[] schema (target_id 500 / detail 2000 / array 50) | 33 | `929f202` | gate green: 1601 passed / 0 failed (mcp 160), build 0; security-reviewer PASS |
| OPT-37 | Shape-validate MEMBERRY_TENANT_DATASTORES (fail-closed, no silent localhost colocation) | 34 | `25f5b90` | gate green: 1609 passed / 0 failed (mcp 168), build 0; security-reviewer PASS |
| OPT-39 | Bound AmpTimelineSchema.limit to a positive int (+handler slice guard) | 35 | `dfaad0e` | gate green: 1615 passed / 0 failed (mcp 174), build 0; security-reviewer PASS |
| OPT-40 | Bound research secondary_metrics (z.record key/count/finite) + temporal timestamp .max(40) | 36 | `9d8f098` | gate green: 1625 passed / 0 failed (research 144, mcp 178), build 0; security-reviewer PASS |
| OPT-41 | Batch load() fact fetch into one round-trip (FactStore.getActiveBatch) | 37 | `640d572` | gate green: 1629 passed / 0 failed (neo4j 202, core 355), build 0; perf — output-identity proven by live-Neo4j integration test |
| OPT-42 | Batch staleness-decay writes into one UNWIND SET (FactStore.updateConfidenceBatch) | 38 | `782a0a5` | gate green: 1633 passed / 0 failed (neo4j 204, core 357), build 0; perf — same end-state (live-Neo4j integration test) |
| OPT-43 | Batch SOURCED_FROM edge MERGEs in FactStore.create (one UNWIND MERGE) | 39 | `7691296` | gate green: 1634 passed / 0 failed (neo4j 205), build 0; perf — graph-identical (live-Neo4j integration test) |
| OPT-44 | Inline EpisodicStore embedding into CREATE (one round-trip, mirrors SemanticStore) | 40 | `5190aae` | gate green: 1635 passed / 0 failed (neo4j 206), build 0; perf — persisted node identical (live-Neo4j) |
| OPT-45 | Batch tenant derivation (_deriveTenantFromEpisodes → EpisodicStore.getTenantsByIds) | 41 | `453eb1f` | gate green: 1637 passed / 0 failed (neo4j 207, core 358), build 0; perf — same derived tenant (live-Neo4j) |
| OPT-46 | findBySubjectPredicate predicate scan | 42 | (no code) | VERIFIED MITIGATED — premise false: fact_entity_id index (schema.ts:29) makes the query a NodeIndexSeek over one entity's facts, not a full scan; toLower(predicate) is a cheap post-filter. Prescribed normalized-predicate composite index needs a migration+backfill for marginal gain → declined (no speculative index churn). No change shipped; floor unchanged 1637. |
| OPT-47 | Single-flight stampede protection on load() (coalesce concurrent identical misses) | 43 | `b87aaf5` | gate green: 1639 passed / 0 failed (core 360), build 0; perf/reliability — single-call identical, concurrent misses coalesce, failure clears key |
| OPT-48 | Self-healing listPending (prune dangling proposal ids whose key expired) | 44 | `61d078d` | gate green: 1640 passed / 0 failed (redis 75), build 0; reliability — live proposals returned, dangling ids filtered+pruned (live-Redis) |
| OPT-49 | Embed CodeSearch query once per search() (shared vector across dense channels) | 45 | `17f92fd` | gate green: 1642 passed / 0 failed (code 122), build 0; perf — results identical (deterministic embed), parallelism preserved |
| OPT-72 | Bound EVERY rawCypher with a default tx timeout (close berry_query =~ DoS) + tighten grep 5000→2000 | 46 | `801ac19` | gate green: 1643 passed / 0 failed (neo4j 208), build 0; security-reviewer PASS — DoS closed, no bypass; test-contract update (OPT-07→OPT-72) judged strengthening not weakening |
