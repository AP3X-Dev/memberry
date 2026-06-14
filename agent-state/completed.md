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
