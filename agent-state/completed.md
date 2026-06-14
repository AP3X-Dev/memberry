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
