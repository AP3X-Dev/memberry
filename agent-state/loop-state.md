# Loop State — memberry-optimizer

## Current Objective

Harden then optimize MemBerry by clearing the audit-derived backlog one item per cycle, security-first, every fix gate-verified green against the full test suite with no regression. Source of every item: the 2026-06-13 multi-agent audit (full per-item evidence/impact/fix in `docs/amp-hardening-audit-2026-06-13.md`, matched by task title).

## Execution model (READ THIS — the loop is split across two machines)

- **Edit here:** this local clone `C:/Users/Guerr/amp-opt` (branch `opt/memberry-hardening`). The maker edits with native tools.
- **Test on cerebro:** the suite needs the live Neo4j+Redis, so it runs in the **isolated** clone `cerebro:~/projects/amp-opt` (also on `opt/memberry-hardening`, deps installed). The live MCP/wiki services run from `~/projects/amp` on `master` and must never be disturbed.
- **Sync = git:** push the local commit to `origin` (the live repo; opt branch is not checked out there, so pushing it is safe), then the test clone fetches + `reset --hard` to it. `origin` for THIS clone = `cerebro@192.168.0.25:/home/cerebro/projects/amp`.

## Verification Commands

The gate. Each must exit 0 to pass. Tests run in the cerebro test clone with the **auth env stripped** (the prod `.env` sets `MEMBERRY_API_TOKEN`, which makes 3 `server.test.ts` cases spuriously 401 — strip it or the gate lies).

- **Sync (from local clone):** `git -C /c/Users/Guerr/amp-opt push -f origin opt/memberry-hardening`
- **Build + Test (the gate, on cerebro):**
  ```
  ssh cerebro@192.168.0.25 'cd ~/projects/amp-opt && git fetch -q origin opt/memberry-hardening && git reset --hard -q FETCH_HEAD && set -a && . ./.env && set +a && unset MEMBERRY_API_TOKEN MEMBERRY_API_TOKENS MEMBERRY_TENANT_TOKENS MEMBERRY_TENANT_DATASTORES MEMBERRY_ALLOW_UNAUTHENTICATED AMP_API_TOKEN AMP_API_TOKENS AMP_ALLOW_UNAUTHENTICATED && npm test'
  ```
  (`npm test` runs `npm run build` (tsc -b, must be clean) then every workspace's vitest.)
- **Focused single-package (faster maker self-check):** append `--workspace @memberry/<pkg>` to `npm test` in the same env.

## Metric Vector & Ratchet Floors

Baseline measured 2026-06-13 on `master` (d2d8850) with the clean-auth env above.

| Metric | Command | Baseline | Floor (running best) | Direction |
|--------|---------|----------|----------------------|-----------|
| Tests passing | `npm test` (sum of "N passed") | 1461 | 1634 | up-only |
| Tests failing | `npm test` | 0 | 0 | must-be-0 |
| Build/typecheck | `npm run build` exit code | 0 | 0 | must-be-0 |
| Tests skipped | `npm test` (sum "N skipped") | 16 | 16 | down-preferred (informational) |

Per-package baseline (passed): core 313 · neo4j 191 · redis 68 · mcp 124 · research 138 · arch 56 · code 107 · retrieval 136 · wiki 276 · graph 52.

A net new test added by a fix RAISES the passing floor — advance it. A drop in the passing count or any failing test is a REJECT unless the session entry carries a one-line waiver (e.g. "removed 2 tests pinning a deleted dead path — intentional").

## Open Tasks (priority-ordered: CRIT → HIGH → MED → LOW → INFO; within a tier, security before perf)

Match each row's title to its full entry in `docs/amp-hardening-audit-2026-06-13.md` for complete impact + recommendation + reachability + evidence before implementing. "Evidence-req: confirm-before-removing" means reproduce the destructive claim (re-grep for dynamic/string/reflection refs) before deleting/dropping anything.

Known duplicates (fix once, mark the twin COMPLETED as no-op): **OPT-08 ≡ OPT-13** (readJsonBody body cap), **OPT-14 ≡ OPT-18** (amp:signals stream trim).

| ID | Sev | Task | Status | Files | Acceptance (exits 0) | Evidence-req |
|----|-----|------|--------|-------|----------------------|----|
| OPT-01 | CRIT | berry_ask/berry_context (ranked) leak another tenant's indexed code via the un-tenant-filtered code-search channel | ✅ DONE (c1) | packages/retrieval/src/assembler.ts:301-321; packages/code/src/search.ts | DONE: gated channel on isDefaultTenant(tenant) in assembleRanked + 2 tests. Verifier PASS 1463/0; security-reviewer PASS (single chokepoint, satellite code tools withheld from tenants). |  |
| OPT-02 | HIGH | Multi-tenant SSE/Streamable sessions not bound to the authenticating token — any valid token can drive another tenant's session | ✅ DONE (c2) | packages/mcp/src/server.ts:435-525 | DONE: sessionIdentity map binds {tenant,actor} at creation; /messages + /mcp follow-ups 403 on mismatch + 2 tests. Verifier PASS 1465/0 (mcp 126); security-reviewer PASS (both dispatch paths guarded, no empty-binding window). |  |
| OPT-03 | HIGH | Untrusted stored episode content triggers arbitrary source-file reads into the graph (post-store re-index hook, no path confinement) | ✅ DONE (c3) | packages/mcp/src/bootstrap.ts:238-253; packages/code/src/watcher.ts; packages/code/src/indexer.ts | DONE: confineReindexPath (lexical prefix + realpath symlink layers, base=MEMBERRY_INGEST_ALLOW_DIR??cwd) applied in the store hook, drop+log, never throws; +7 tests. Verifier PASS 1472/0 (code 114); security-reviewer PASS (fully closed on Linux; TOCTOU→OPT-68). | confirm-before-removing |
| OPT-04 | HIGH | extractFacts trusts LLM predicates/values — injected content mints arbitrary active/deductive facts (graph poisoning) | ✅ DONE (c4) | packages/core/src/extract.ts:35-57,61-71,90-119 | DONE: validateFactResponse drops facts whose predicate isn't snake_case `^[a-z][a-z0-9_]{0,40}$` or whose subject/object empty/>200 chars (covers all 3 extractFacts call sites incl. consolidation) +8 tests. Chose format-validation over brittle allowlist; status-clamp deferred→OPT-70. Verifier PASS 1480/0 (core 321); security-reviewer PASS. | confirm-before-removing |
| OPT-05 | HIGH | redactSecrets misses JSON-quoted credentials ("password":"value") | ✅ DONE (c5) | packages/core/src/redact.ts:32-33,42-48 | DONE: broadened SECRET_ASSIGNMENT to optional-quoted keys + quoted/bare values (bounded, no ReDoS, no sibling over-match); synced graph/allowlist.ts copy; +3 tests (core+graph). Verifier PASS 1483/0 (core 323, graph 53); security-reviewer PASS. Residuals→OPT-33/34. |  |
| OPT-06 | HIGH | berry_grep compiles attacker regex with new RegExp + .test/.exec on untrusted content — event-loop ReDoS | ✅ DONE (c6, interim) | packages/mcp/src/tools.ts:562-568,619-620,685,730,752,781; packages/mcp/src/safe-regex.ts | DONE (no-dep interim): safe-regex.ts assertSafeRegex rejects nested-quantifier / quantified-alternation / repetition>1000 BEFORE compile (single chokepoint guarding all 5 JS exec sites) + capScanText 4k on every scanned value; +5 tests. Verifier PASS 1488/0 (mcp 131); security-reviewer PASS (lowered cap 50k→4k per review). ROBUST fix re2 → Blocked B-01. |  |
| OPT-07 | HIGH | berry_grep passes raw user regex into Cypher =~ with no transaction timeout — Neo4j-side ReDoS | ✅ DONE (c7) | packages/mcp/src/tools.ts:574,588-596,677,701,720,744,773 | DONE: rawCypher gained optional timeoutMs → {timeout: neo4j.int()} (only when set; default callers byte-identical); grep =~ path passes GREP_QUERY_TIMEOUT_MS=5000 on all 5 node types +4 tests. Verifier REJECT→fix (pre-existing arity test updated)→PASS 1492/0 (neo4j 193); security-reviewer PASS. Residuals (berry_query =~ unbounded; soft guard)→OPT-72. |  |
| OPT-08 | MED | readJsonBody buffers the entire request body with no size limit — memory-exhaustion DoS | ✅ DONE (c8) | packages/mcp/src/server.ts:371-380 | DONE: 1MB cap (env MEMBERRY_MAX_BODY_BYTES) via Content-Length early-reject + streaming backstop (throws before buffering over-cap chunk) → typed err → HTTP 413; +3 tests. Verifier PASS 1495/0 (mcp 136); security-reviewer PASS (peak≤cap+1chunk, all 3 CL vectors 413). Residual /messages SDK body→OPT-73. |  |
| OPT-09 | MED | Ingest/viewer path confinement does not resolve symlinks (realpath missing) — symlink escapes allow-dir | ✅ DONE (c9) | packages/wiki/src/tools.ts:144-159; packages/wiki/src/viewer.ts:1787-1800 | DONE: realpath Layer-2 (target+base) added to validatePath + confineToDir (replicated, no wiki→code dep; ENOENT→lexical fallthrough; contracts preserved) +6 tests. Verifier PASS 1501/0 (wiki 282; RED-confirmed symlink tests ran on Linux); security-reviewer PASS (all 3 uses + every confineToDir serve site). Residual ancestor/TOCTOU→OPT-74. |  |
| OPT-10 | MED | berry_ask synthesizes over untrusted memory with no instruction-guarding, returns raw answer (stored prompt injection) | ✅ DONE (c10) | packages/retrieval/src/assembler.ts:68-164 | DONE: ASK_SYSTEM_PROMPT untrusted-data guard + each evidence item fenced <<<EVIDENCE n>>> + stripEvidenceFences anti-forgery (covers open/close, ci, ws-tolerant, ReDoS-safe) +3 tests. Scoped to berry_ask (berry_context doesn't LLM-synthesize). Verifier PASS 1504/0 (retrieval 141); security-reviewer PASS. Residual output-side filtering→OPT-75. |  |
| OPT-11 | MED | Dream project_card written verbatim into a core block injected into every session (second-order prompt injection) | ✅ DONE (c11) | packages/core/src/dream.ts:242-269 | DONE: fenced+guarded BOTH dream prompts (hypothesis+card) + stripFactFences anti-forgery + sanitizeCard (strips fences + neutralizes injection-openers) BEFORE core-block persist +4 tests. Verifier REJECT→test-mock fix (non-gap entity fires 1 chat call; respond-by-content mock)→PASS 1508/0 (core 327); security-reviewer PASS. Residual undelimited block-injection→OPT-76, extract.ts unfenced→OPT-77. |  |
| OPT-12 | MED | berry_ingest/berry_braindump persist untrusted content verbatim, bypassing MEMBERRY_REDACT_ON_INGEST | ✅ DONE (c12) | packages/wiki/src/ingest.ts:41-196,282-300 | DONE: IngestionService.redactOnIngest flag (default MEMBERRY_REDACT_ON_INGEST==='true', mirrors service.ts/factory) redacts verbatim body (before extraction) + each claim.content; exported redactSecrets from core index +5 tests. (Source nodes persist no body.) Verifier PASS 1513/0 (wiki 287; .env doesn't set flag→no interaction); security-reviewer PASS. Residual structural fields→OPT-78. |  |
| OPT-13 | MED | (≡OPT-08) MCP /mcp POST body reader buffers entire request, no cap | ✅ DONE (c8, no-op) | packages/mcp/src/server.ts:371-380,439-446 | COVERED by OPT-08: /mcp POST reads its body through the now-capped readJsonBody before the SDK is invoked, so the /mcp Streamable path is bounded. (Only /messages SDK-read path remains → OPT-73.) |  |
| OPT-14 | MED | Redis amp:signals stream grows unbounded — XADD no MAXLEN, consumer only XACKs | ✅ DONE (c13) | packages/redis/src/streams.ts:29-42,53-98 | DONE: approximate MAXLEN ~ SIGNALS_STREAM_MAXLEN (10_000, env-overridable) on the signals XADD; MAXLEN-alone (no XDEL-after-XACK — multi-consumer-group-unsafe); consumer/ack semantics unchanged +1 test. Verifier PASS 1514/0 (redis 69). Nit: raw process.env vs readEnv (non-blocking). Episodic-buffer cap→OPT-79. |  |
| OPT-15 | MED | berry_ingest_codebase path arg has no confinement, unlike sibling code tools | ✅ DONE (c14) | packages/mcp/src/tools.ts:951-960 | DONE: confine args.path before scan/index (resolve + baseDir=cwd + startsWith(base+sep), byte-identical to sibling code tools) +4 tests. Verifier PASS 1518/0 (mcp 140; RED-confirmed by reverting guard); security-reviewer PASS (only fs-path input; confined before any read). Residual lexical-only symlink→OPT-74. |  |
| OPT-16 | MED | DeterministicAssembler ~6 sequential queries per target entity, each own session (N+1) | ✅ DONE (c15) | packages/retrieval/src/deterministic.ts:50-155,220-347 | DONE: 5 per-step UNWIND batches (6×T→6 queries) + CALL{} subqueries to preserve per-target LIMIT 10 + aspect UNION dedup; target order driven by JS loop (output byte-identical) +1 batching test. Verifier(self): PASS 1519/0 — all existing deterministic output-identity tests held, NO assertions loosened (targetName mock col additive). Perf item (no sec-review). |  |
| OPT-17 | MED | EntityResolver.resolveExisting 3 sequential round-trips per call on every fact hot path | ✅ DONE (c16) | packages/neo4j/src/entity-resolver.ts:60-118 | DONE (safe non-migration): collapsed 3 sequential queries (exact/CI/alias) into 1 precedence-ranked query (CASE rank + ORDER BY rank,created_at LIMIT 1); matchType derived in TS; 3→1 round-trips; precedence/trim/create-on-miss preserved +4 tests. Verifier PASS 1523/0 (neo4j 197). Indexed name_lower migration deferred→OPT-80 (needs approval). |  |
| OPT-18 | MED | (≡OPT-14) amp:signals stream never trimmed | ✅ DONE (c13, no-op) | packages/redis/src/streams.ts:29-42,53-98 | COVERED by OPT-14 (MAXLEN ~ on the signals XADD bounds the stream). | confirm-before-removing |
| OPT-19 | MED | Dedup key set before persistence with no rollback — a failed store() permanently swallows the memory for 24h | ✅ DONE (c17) | packages/core/src/service.ts:435-484 | DONE: DedupChecker.unmark releases the key; store() wraps persistence in try/catch → unmark-then-rethrow original error (mark stays before persist → TOCTOU/BUG-0020 intact); +3 tests. Verifier PASS 1526/0 (core 330; RED-confirmed). Reliability (no sec-review). |  |
| OPT-20 | MED | Retrieval/code/intent embed via raw OpenAIEmbedding — Redis EmbeddingCache exists but never wired in | ✅ DONE (c18) | packages/core/src/services-factory.ts:132,174,235,302 | DONE: CachingEmbeddingProvider (read-through embed + batch-misses-only + cache-error fallthrough) wraps OpenAIEmbedding with the existing EmbeddingCache; injected into shared core.embedding (all 4 consumers) +6 tests. Subsumes OPT-65. Verifier PASS 1532/0 (core 336; behavior-identical on miss). Perf (no sec-review). |  |
| OPT-21 | MED | Fact invalidate + create-replacement is two separate transactions; a failure between them invalidates a fact with no successor (data loss) | ✅ DONE (c19) | packages/core/src/service.ts:680-686 | DONE: reordered create-before-invalidate (replacement w/ supersedes_fact_id created first, then old invalidated) → mid-failure leaves BOTH active (recoverable) instead of losing the only fact; end-state identical +2 tests. Verifier PASS 1534/0 (core 338). Single-tx atomic supersession→OPT-81. Reliability (no sec-review). |  |
| OPT-22 | MED | fetchEpisodicsForEntity unindexed full :Episodic substring scan, once/twice per entity on compile | ✅ DONE (c20) | packages/wiki/src/queries.ts:215-240 | DONE: batched fetchEpisodicsForEntities (one UNWIND :Episodic scan + per-name CALL{} preserving CONTAINS-OR-:MODIFIED predicate, DISTINCT, ORDER created_at DESC, LIMIT 20); compile Phase-1 E scans→1 (result-identical) +3 tests. Verifier PASS 1537/0 (wiki 290). Phase-2 double-call→OPT-58. Perf (no sec-review). |  |
| OPT-23 | MED | indexFile one round-trip per changed symbol (sequential findByCompositeKey + create/update) | ✅ DONE (c21) | packages/code/src/indexer.ts:144-214 | DONE: SymbolStore.upsertSymbols — one UNWIND MERGE (ON CREATE=create props incl vectors, ON MATCH=update subset, transient __upsert_created removed before RETURN → graph-identical); indexFile collects changed→1 batched upsert (N→1); content-hash skip preserved +3 tests. Verifier PASS 1540/0 (code 117). Relation-edge N+1→OPT-82. Perf (no sec-review). |  |
| OPT-24 | MED | docker-compose mcp omits MEMBERRY_TENANT_TOKENS/_DATASTORES/_INGEST_ALLOW_DIR — isolation can't be enabled via shipped compose | ✅ DONE (c22) | docker-compose.yml:72-89; .env.example | DONE: wired all 3 vars into the mcp env block (${VAR:-} opt-in defaults, 6-space map syntax) + INGEST_ALLOW_DIR container-path/volume-mount note in compose + .env.example pointer. Names verified vs readEnv call sites. Config-only → suite green 1540/0 (verified). Ops (no sec-review). |  |
| OPT-25 | LOW | invalidateRelationship() interpolates relType into Cypher with no in-function allowlist (latent injection sink) | ✅ DONE (c23) | packages/neo4j/src/temporal-edges.ts:53-68 | DONE: module-level VALID_REL_TYPES allowlist (19 metachar-free types incl ABOUT) + throw before interpolation/session.run; doc-comment now enforced-invariant; no dep cycle (local set) +3 tests. Verifier PASS 1543/0 (neo4j 200; RED-confirmed); security-reviewer PASS (sink enforced pre-interpolation). Residual: relation-store remove fail-open + allowlist dup→OPT-83. |  |
| OPT-26 | LOW | Global feedback boost keys mix tenant entity names — one tenant skews another's ranking | ✅ DONE (c24) | packages/retrieval/src/feedback.ts:18-21,31-46,52-82 | DONE: per-tenant key helpers (default→legacy keys zero-cold-start, named→amp:feedback:<tenant>:*); recordFeedback/getBoosts/inferUsage take tenantId; real tenant threaded at assembler getBoosts + berry_feedback recordFeedback +4 tests. Verifier PASS 1547/0 (retrieval 146); security-reviewer PASS (single chokepoint, not spoofable). Residual non-tenant-token→DEFAULT = OPT-29. |  |
| OPT-27 | LOW | Context-cache dependency sets keyed by naked scope/node-id — one tenant's write evicts another's cache | ✅ DONE (c25) | packages/redis/src/cache.ts:29-38,42-54,56-68 | DONE: per-tenant ctx+dep-set keys (default→legacy, named→amp:*:<tenant>:*); tenantId threaded at service.ts load/store/fact-extraction AND the block-invalidation path (CacheInvalidator/_invalidateContext/factory) so a tenant's block edit evicts its OWN bucket +10 tests. Verifier REJECT(test-setup)→fix→PASS; +block-path extension PASS 1557/0. Consolidation cache tenant gap→OPT-84. |  |
| OPT-28 | LOW | HTTP server sets no headersTimeout/requestTimeout — slowloris DoS | ✅ DONE (c26) | packages/mcp/src/server.ts:382-543 | DONE: keepAliveTimeout=10s/headersTimeout=20s/requestTimeout=30s (down from Node 300s) env-overridable + Math.max(req,headers) clamp; SSE unaffected (request-receipt not response-duration) +3 tests. Verifier PASS 1560/0 (mcp 143); security-reviewer PASS. Residual conn-count/flood limit→OPT-85. |  |
| OPT-29 | LOW | Multi-tenant: non-tenant tokens authenticate but silently fall back to default tenant | ✅ DONE (c27) | packages/mcp/src/server.ts:312-322,361-389,397-411 | DONE: isAuthorized fail-closed — in multiTenantMode a token that authenticates but isn't in tokenToTenant is 401'd (refactored tenantFor→bearerToken/tenantForToken helpers; single chokepoint above every tenant-bearing path); MEMBERRY_ALLOW_DEFAULT_TENANT=true restores the legacy fallback; wired the flag through docker-compose+.env.example +1 test (fail-closed + opt-in + tenant-token positive control). Verifier PASS 1561/0 (mcp 144); security-reviewer PASS (no bypass, escape hatch grants no new exposure, constant-time preserved, fail-closed default). Residuals→OPT-86/87. |  |
| OPT-30 (+OPT-38) | LOW | Token parsing splits on ',' and ':' with no escaping/validation — tokens with those chars silently corrupt | ✅ DONE (c28) | packages/mcp/src/server.ts:85-145 (parseTokenPairs + MIN/MAX consts), token-map call sites | DONE: extracted exported parseTokenPairs(raw,varName,onValid) — validates token length [4..4096], WARNS (never silently) on every malformed/empty/out-of-range entry AND on a non-empty var yielding zero valid pairs (subsumes OPT-38); behavior-identical accept path for valid pairs; never logs a token value; documented the unescapable ','/' :' constraint in .env.example +10 unit tests. Verifier PASS 1571/0 (mcp 154); security-reviewer PASS (no leak, fail-open partial-safe + warned, bounds clear tok-bob=7). Residuals→OPT-88/89. |  |
| OPT-31 | LOW | Consolidation re-extracts facts via the same unvalidated predicate path on autoApply with no human gate | ✅ DONE (c4+c29) | packages/core/src/consolidation.ts:16-36,533-600 | DONE: predicate-shape half via OPT-04; c29 added the confidence gate — an established existing fact (confidence >= MEMBERRY_FACT_PROTECT_CONFIDENCE, default 0.75) is only auto-invalidated by a contender ≥ its confidence, else the contender is held `tentative` (established fact stays active). factProtectConfidence() clamps [0,1]; predicate-only log (subject/object never logged). +5 tests. Verifier PASS 1576/0 (core 348); security-reviewer PASS (threat closed; extractFacts emits no confidence so contender pins 0.5 → inflation bypass unreachable; tentative+inductive can't auto-activate). Residuals→OPT-90/91/92. |  |
| OPT-32 | LOW | berry_ask evidence items have no per-item length cap — one oversized memory dominates the synthesis prompt | ✅ DONE (c30) | packages/retrieval/src/assembler.ts:85-122 (cap helpers), ask() | DONE: per-item char cap (MEMBERRY_ASK_MAX_EVIDENCE_ITEM_CHARS, default 4000) applied in formatEvidenceItem AFTER fence-strip, with a visible `…[truncated N chars]` marker; ask() computes cap once + passes it. Within-cap output byte-identical; fence-strip-before-cap preserved (anti-forgery intact). +9 unit +1 ask() integration test. Verifier PASS 1586/0 (retrieval 156). Perf/hardening (not security-tagged). |  |
| OPT-33 | LOW | redactSecrets misses AWS secret keys, Bearer tokens, Stripe keys, generic high-entropy — PLUS (found in OPT-05 review): escaped-quote tail leak re-exposes adjacent secrets (`"password":"a\"b","next":"LEAKED"`); `Authorization: Bearer xxx` not matched (auth\b ≠ Authorization); keys pwd/private_key/passphrase/credential not in keyword list | ✅ DONE (c31) | packages/core/src/redact.ts:16-68 | DONE: added Stripe (sk_/rk_ live/test) + BEARER_TOKEN patterns; quoted-value capture now spans `\"` escapes ((?:\\.|(?!\2)[^\\])*) — closes tail/adjacent-key leak; keyword list +pwd/passphrase/private_key/secret_key/credential(s)/aws_secret_access_key/aws_session_token; Authorization:Bearer via dedicated matcher. Generic high-entropy + standalone AWS secret intentionally deferred (FP risk)→OPT-93. +5 tests. Verifier PASS 1592/0 (core 353; prose/sibling/conn-string regressions all held); security-reviewer PASS (ReDoS-safe 1.6-2.8ms, Bearer leak-free). Residual→OPT-94. |  |
| OPT-34 | LOW | Graph export redaction omits github_pat_ fine-grained PAT the core redactor catches (drift confirmed in OPT-05 review: allowlist.ts SECRET_PATTERNS lacks core's github_pat_ entry → PAT redacted at ingest but LEAKS at export). Dedup would have prevented the SECRET_ASSIGNMENT drift too. | ✅ DONE (c31) | packages/graph/src/allowlist.ts:17-27,104 | DONE: deleted the drifted duplicate SECRET_PATTERNS/SECRET_ASSIGNMENT/redactSecrets/redactValue; now imports + re-exports them from @memberry/core (graph already deps core; no cycle — core never imports graph). Export path inherits every core pattern incl github_pat_ + all OPT-33 additions → drift permanently eliminated (single source of truth). +1 graph test (github_pat_/Stripe/Bearer redacted at export). Verifier PASS 1592/0 (graph 54; barrel+snapshot.ts resolve via re-export); security-reviewer PASS (old graph copy was a strict subset of core). |  |
| OPT-35 | LOW | CodeIndexer.parseFile reads+parses files with no size guard (structural-search 2MB cap not applied) | ✅ DONE (c32) | packages/code/src/parser.ts:92-130 | DONE: parseFile stat-and-skips files > MEMBERRY_MAX_PARSE_FILE_BYTES (default 2 MiB) BEFORE reading, returning an empty ParsedFile (graceful skip, not throw); stat failure falls through to readFile (original error preserved); maxParseBytes() clamps to default on unset/0/neg/NaN. Covers both tree-sitter + extractor paths. +3 tests. Verifier PASS 1595/0 (code 120; 7 existing parser tests unaffected; indexer-safe on empties). Hardening (not security-tagged). |  |
| OPT-36 | LOW | berry_store signals[] schema: target_id/detail unbounded, no array cap | ✅ DONE (c33) | packages/mcp/src/tools.ts:284-300 | DONE: target_id .max(500), detail .max(2000), array .max(50) on the signals schema; exported AmpStoreSchema for direct Zod bound testing. Enforced at the MCP boundary (server.tool compiles the shape → validates before handler). +6 tests. Verifier PASS 1601/0 (mcp 160); security-reviewer PASS (worst case ~125KB/store under OPT-08 1MB cap; ALSO closes the per-entry SIZE surface of the amp:signals Redis stream that OPT-14 bounded by count only → ~25MB ceiling). Residuals→OPT-95/96. |  |
| OPT-37 | LOW | MEMBERRY_TENANT_DATASTORES parsed but not shape-validated — non-object silently maps a tenant onto localhost defaults | ✅ DONE (c34) | packages/mcp/src/bootstrap.ts:63-130,435-447 | DONE: extracted exported pure parseTenantDatastores(raw) — Zod-validates (required neo4jUri/neo4jPassword/redisUrl non-empty; .strict rejects typo'd keys; explicit non-object/array/null guard catches the char-iteration footgun) and THROWS at startup on any malformed input instead of silently colocating a tenant on the shared localhost store; returns {} for unset. Error messages name the key path only (zod branch). +8 tests. Verifier PASS 1609/0 (mcp 168; valid-input loop byte-identical); security-reviewer PASS (sole consumer, no bypass, fail-closed). Residuals→OPT-97/98. |  |
| OPT-38 | LOW | (≡OPT-30) MEMBERRY_TENANT_TOKENS/_API_TOKENS: malformed pairs silently dropped — can silently disable multi-tenant | ✅ DONE (c28, covered) | packages/mcp/src/server.ts (parseTokenPairs) | COVERED by OPT-30: parseTokenPairs logs a per-entry skip warning AND a "ZERO valid name:token pairs" warning when a non-empty var yields nothing — the silent-drop / silent-disable path is closed. (Follow-up OPT-89 adds an even louder "multi-tenant NOT enabled" line.) |  |
| OPT-39 | LOW | AmpTimelineSchema.limit allows negative/zero; handler slices raw | ✅ DONE (c35) | packages/mcp/src/tools.ts:403-410,1197-1217 | DONE: added .positive() to AmpTimelineSchema.limit (was .int().max(100) only — limit:0 fell through to "all", limit:-n did slice(0,-n) dropping the tail); hardened handler to slice only for a positive number; exported AmpTimelineSchema for Zod bound testing. +6 tests. Verifier PASS 1615/0 (mcp 174); security-reviewer PASS (boundary rejects 0/neg/frac/over-cap; NaN/Infinity safe; consistent w/ AmpQuerySchema). Residuals→OPT-99 (timeline() upstream has no LIMIT → unlimited path unbounded), OPT-100 (fact_diff from/to unvalidated). |  |
| OPT-40 | LOW | Research/temporal schemas: unbounded z.record() and unbounded ISO strings | ✅ DONE (c36) | packages/research/src/tools.ts:131-157; packages/mcp/src/tools.ts:258-273 | DONE: ResearchLogSchema.secondary_metrics → z.record(z.string().min(1).max(100), z.number().finite()).refine(≤50 entries) (bounds key length/count + rejects NaN/Infinity that JSON.stringify silently turned to null); AmpLoadSchema.temporal.{as_of,from,to} → .max(40) (NOT .datetime() — contract accepts date-only AND full ISO). Exported both schemas. +10 tests. Verifier PASS 1625/0 (research 144, mcp 178); security-reviewer PASS (no Cypher injection — bound params; .finite() a real correctness win). Residual (fact_diff parity)→OPT-100. |  |
| OPT-41 | LOW | AMPService.load fans out one getActive per entity (resolve 3q + fetch) — multiplicative round-trips | ✅ DONE (c37) | packages/neo4j/src/fact.ts (getActiveBatch); packages/core/src/service.ts:63-74,275-289 | DONE: FactStore.getActiveBatch resolves per-entity (unchanged precedence) then fetches ALL ids' active facts in ONE round-trip (UNWIND distinct ids → per-id OPTIONAL-MATCH+ordered collect), returning FactNode[][] in input order, each IDENTICAL to getActive(name) (same per-mode filter + ORDER BY valid_at). load() prefers it (FactLayer.getActiveBatch? optional → fallback for mocks). O(2N)→O(N resolves + 1 fetch). +integration identity test (ran on LIVE Neo4j, deep-equals per-entity union across modes) +2 wiring tests. Verifier PASS 1629/0 (neo4j 202, core 355); output-identity proven. Resolve-batching residual→OPT-101. |  |
| OPT-42 | LOW | Fact staleness pass: nested getActive + per-fact updateConfidence loop (N+1 writes) | ✅ DONE (c38) | packages/core/src/service.ts:741-779; packages/neo4j/src/fact.ts (updateConfidenceBatch) | DONE: staleness loop accumulates {id, decayed-confidence} across entities and writes ONE FactStore.updateConfidenceBatch (UNWIND SET) instead of N per-fact updateConfidence. Decay formula max(0.1,conf*0.9) + ≥2-coverage gate + predicate-mention check + changedFactScopes all unchanged → end-state confidences identical (one shared updated_at). FactLayer.updateConfidenceBatch? optional → per-fact fallback for mocks. +2 wiring +2 live-Neo4j integration tests. Verifier PASS 1633/0 (neo4j 204, core 357); same end-state proven. (Per-entity getActive reads here still N — separate from the WRITE batch; minor, not filed.) |  |
| OPT-43 | LOW | FactStore.create links SOURCED_FROM one episode at a time | ✅ DONE (c39) | packages/neo4j/src/fact.ts:66-77 | DONE: replaced the per-episode MERGE loop with one UNWIND $episodeIds MATCH+MERGE inside the same create tx (graph-identical: missing Episodic skipped exactly as the loop did; atomic with CREATE/FACT_ABOUT/SUPERSEDES; non-empty guard). +1 live-Neo4j integration test (2 existing linked, missing id skipped). Verifier PASS 1634/0 (neo4j 205); graph-identical proven. |  |
| OPT-44 | LOW | EpisodicStore.create writes embedding in a second round-trip | pending | packages/neo4j/src/episodic.ts:9-52 | inline embedding into CREATE like SemanticStore; suite green |  |
| OPT-45 | LOW | _deriveTenantFromEpisodes fetches episodes one-by-one (N+1) | pending | packages/core/src/consolidation.ts:475-497 | batched UNWIND projection of tenant_id; suite green |  |
| OPT-46 | LOW | findBySubjectPredicate filters toLower(predicate) with no predicate index | pending | packages/neo4j/src/fact.ts:334-357 | store normalized predicate property + composite index; suite green |  |
| OPT-47 | LOW | No single-flight/stampede protection on load() — concurrent identical misses each re-run full fan-out + embedding | pending | packages/core/src/service.ts:225-408 | in-process single-flight map (and/or short Redis lock) coalescing concurrent misses; test; suite green |  |
| OPT-48 | LOW | PENDING_SET accumulates dangling proposal IDs (keys expire 7d, ids never removed) | pending | packages/redis/src/proposals.ts:15-39 | self-healing listPending (srem missing) or derive via SCAN; suite green |  |
| OPT-49 | LOW | CodeSearch.search embeds the same query twice per call | pending | packages/code/src/search.ts:45-50,200,296 | embed once, pass down (or rely on OPT-20 cache); suite green |  |
| OPT-50 | LOW | Auto-strategy ranked path embeds the query twice across modules, uncached | pending | packages/retrieval/src/assembler.ts:210,303-308 | install OPT-20 cache or thread the computed vector; suite green |  |
| OPT-51 | LOW | RRF feedback boost is O(entries×boostEntities) substring scan | pending | packages/retrieval/src/fusion.ts:51-63 | tokenize each candidate once into a Set + short-circuit empty boosts; suite green |  |
| OPT-52 | LOW | Dream hypothesis dedup check runs OUTSIDE the per-entity serializer, defeating the dedup invariant | pending | packages/core/src/dream.ts:190-208 | move dedup read inside serialize() critical section; test; suite green |  |
| OPT-53 | LOW | store() persists episode + edges across many sessions with no transaction — partial-write corruption | pending | packages/core/src/service.ts:484-524 | one tx for CREATE + edge MERGEs (createWithLinks), or compensating cleanup; suite green |  |
| OPT-54 | LOW | _generateProposals issues N sequential semantic.getById round-trips in a loop | pending | packages/core/src/consolidation.ts:309-330 | batch getByIds (one MATCH WHERE id IN $ids); suite green |  |
| OPT-55 | LOW | CodeIndexer.indexProject indexes files strictly serially, no bounded concurrency | pending | packages/code/src/indexer.ts:82-127 | bounded concurrency pool (p-limit 8-16) under maxConnectionPoolSize; suite green |  |
| OPT-56 | LOW | ExtractionConsumer re-enqueues retry before acking original — duplicate jobs on crash window | pending | packages/core/src/extraction-consumer.ts:99-113 | ack before enqueue, or XCLAIM in-place retry; suite green |  |
| OPT-57 | LOW | Wiki viewer re-renders full markdown on every request, no rendered-HTML cache | pending | packages/wiki/src/viewer.ts:1844-1913 | rendered-HTML cache keyed by path(+mtime) in WikiCache, invalidated by scheduleCacheRebuild; suite green |  |
| OPT-58 | LOW | Wiki compiler calls fetchEpisodicsForEntity twice per entity; Phase-1 result discarded | pending | packages/wiki/src/compile.ts:319-336 | reuse Phase-1 entityEpisodicMap in Phase 2; suite green | confirm-before-removing |
| OPT-59 | LOW | Code watcher re-parses entire file on every change even when unchanged (no file-level content-hash) | pending | packages/code/src/indexer.ts:132-148 | whole-file SHA-256 short-circuit before parseFile; suite green |  |
| OPT-60 | LOW | Full ~650-line CSS concatenated into every wiki HTML response instead of a cacheable stylesheet | pending | packages/wiki/src/viewer.ts:188-204,807-1457 | serve CSS from /assets/wiki.css with Cache-Control, link it; suite green |  |
| OPT-61 | LOW | HTTP listen opens only after serial bootstrap (~60 schema stmts one round-trip at a time) | pending | packages/mcp/src/bootstrap.ts:96-393; server.ts | parallelize independent CREATE IF NOT EXISTS (Promise.all / multi-stmt tx); suite green |  |
| OPT-62 | LOW | HTTP server binds 0.0.0.0; listen() takes no host; systemd HOST=0.0.0.0 never read | pending | packages/mcp/src/server.ts:540-543 | read MEMBERRY_HOST (default 127.0.0.1), pass to listen; document 0.0.0.0 opt-in; suite green | confirm-before-removing |
| OPT-63 | LOW | No .dockerignore: full context (node_modules,.git,wiki,.memberry,docs,.audit) sent to daemon | pending | (repo root, missing) | add .dockerignore; acceptance = file present + build still works; suite green |  |
| OPT-64 | LOW | Dockerfile HEALTHCHECK start-period (20s) shorter than cold DB warm-up + serial bootstrap | pending | Dockerfile:70-72; docker-compose.yml | raise start-period to 60-90s or split liveness/readiness; suite green |  |
| OPT-65 | INFO | Query embeddings in code search + intent classification bypass EmbeddingCache | ✅ DONE (c18, subsumed) | packages/code/src/search.ts:200,296 | COVERED by OPT-20: CodeSearch + intent classifier consume the shared core.embedding, now the cached read-through wrapper. |  |
| OPT-66 | INFO | Intent classifier recomputes exemplar L2 norms every query despite caching vectors | pending | packages/retrieval/src/intent.ts:216-235,247-251 | precompute+cache exemplar norms alongside vectors; suite green |  |
| OPT-67 | LOW | DeterministicAssembler entity/aspect/semantic queries are NOT tenant-filtered — rely on tools.ts:147 routing guard, not data-layer isolation (defense-in-depth gap; not a live leak). Mirrors the query.ts byEntity/byTag/expandByGraph unscoped-read class. | pending | packages/retrieval/src/assembler.ts:402-412; packages/retrieval/src/deterministic.ts; packages/neo4j/src/query.ts:142,163,356,418 | thread tenantId into DeterministicAssembler + add tenantWhere to its queries (and to byEntity/byTag/byEntityWithFacts/expandByGraph); test proves a tenant can't read another tenant's entities even if routed to deterministic; suite green. Source: found verifying OPT-01. |  |
| OPT-68 | LOW | TOCTOU in re-index confinement: reindexFile re-checks existence after the 3s debounce but does NOT re-confine/realpath, so a symlink swapped into the base within the window could redirect the read past OPT-03's queue-time check. | pending | packages/code/src/watcher.ts (reindexFile ~221-247); packages/code/src/indexer.ts:132-172 | re-confine (or lstat/O_NOFOLLOW) inside reindexFile before parseFile reads; test proves a post-queue symlink swap is rejected; suite green. Source: found security-reviewing OPT-03. Low: needs local write to base within 3s. |  |
| OPT-69 | LOW | extract.ts predicate format-check runs BEFORE normalizePredicate, so space-form synonym predicates the synonym map anticipates ("depends on", "runs on", "built with") get dropped at extraction instead of normalized. | pending | packages/core/src/extract.ts:48-66; packages/core/src/service.ts:907-967 | normalize/space→snake the predicate (or apply the synonym map) BEFORE the shape regex, so legit space-form predicates normalize instead of dropping; test pins a space-form predicate survives+normalizes; suite green. Source: found verifying OPT-04. |  |
| OPT-70 | MED | In-shape fact poisoning remains: a legit-shaped predicate (is_admin, password_is) + ≤200-char values still mints an authoritative active/deductive fact from untrusted content. The real fix is provenance-based clamping. | pending | packages/core/src/service.ts:646-651,658-678; packages/core/src/extract.ts | clamp extraction-origin facts to status=tentative (and/or capped confidence) until corroborated by an independent episode, then promote — closes OPT-04's primary residual without false-dropping. Adjust the active/deductive test contract intentionally (waiver). Source: security-reviewing OPT-04. |  |
| OPT-71 | LOW | Dream-minted abductive hypothesis facts bypass validateFactResponse; via reinforcement promotion (service.ts:646-648) an attacker who also stores a corroborating episode can launder an unvalidated dream predicate into a deductive fact. | pending | packages/core/src/dream.ts:190-208; fact.create call ~202 | apply the same isSaneFact predicate-shape check to dream hypotheses before fact.create; test pins a non-sane dream predicate is dropped; suite green. Source: security-reviewing OPT-04. |  |
| OPT-72 | MED | berry_query's raw `=~` runs server-side with NO tx timeout (OPT-07 only timed the grep path), so a catastrophic `=~` in a user berry_query is unbounded on the shared Neo4j; also the grep 5s bound is loose for a shared instance. | pending | packages/mcp/src/tools.ts:883 (berry_query rawCypher call); packages/neo4j/src/query.ts | apply a generous DEFAULT tx timeout to ALL rawCypher calls (so no raw path is ever unbounded; berry_query gets e.g. 10-15s), and tighten the grep `=~` timeout from 5000→~2000ms; tests assert both; suite green. Source: security-reviewing OPT-07. |  |
| OPT-73 | LOW | /messages SSE POST body is NOT size-capped — transport.handlePostMessage(req,res) lets the MCP SDK read the body itself, bypassing OPT-08's readJsonBody cap (the /mcp Streamable path IS capped). Residual unbounded-body vector on the SSE path. | pending | packages/mcp/src/server.ts:~642 (handlePostMessage) | bound the /messages body (capped pass-through stream wrapper around req before handPostMessage, or a Content-Length pre-check 413), or document/configure the SDK's own limit; test asserts an over-cap /messages body is rejected; suite green. Source: security-reviewing OPT-08. |  |
| OPT-74 | MED | Path-confinement (confineReindexPath OPT-03, validatePath/confineToDir OPT-09) only realpaths the FULL target; a symlinked ANCESTOR of a not-yet-existing leaf (e.g. compile output_dir to be created under a planted symlink dir) isn't caught (ENOENT→lexical fallthrough), and a check→use TOCTOU window remains (callers pass original args path downstream). | pending | packages/code/src/watcher.ts (confineReindexPath); packages/wiki/src/tools.ts (validatePath); packages/wiki/src/viewer.ts (confineToDir) | realpath the NEAREST EXISTING ANCESTOR and re-assert prefix (lexically join the non-existent tail), in the shared confinement pattern; for read/serve, prefer open-then-fstat / O_NOFOLLOW to shrink TOCTOU; tests pin a symlinked-ancestor escape rejected; suite green. Source: security-reviewing OPT-03 + OPT-09 (supersedes/absorbs OPT-68's TOCTOU note). |  |
| OPT-75 | LOW | berry_ask returns the raw LLM answer unfiltered — no output-side check that a (jailbroken-through-the-fence) answer didn't leak other evidence or echo injected instructions. OPT-10 fenced the INPUT; this is the OUTPUT-side residual. | pending | packages/retrieval/src/assembler.ts (ask → parseAskResponse ~193) | add a lightweight output sanity/leak check on the synthesized answer (e.g. flag/strip if it echoes the system-prompt guard text or content not present in cited evidence); test pins it; suite green. Defense-in-depth only (jailbreak can't be fully prevented at prompt level). Source: security-reviewing OPT-10. |  |
| OPT-76 | MED | Core memory blocks (incl. the dream project_card) are injected into every agent session via renderBlocksMarkdown as `### name\n<content>` with NO untrusted-data delimiter — the full fix for the OPT-11 second-order channel (OPT-11 mitigates at generation+sanitize, not at injection). | pending | packages/core/src/service.ts:811-837 (renderBlocksMarkdown), 291-302 | wrap auto-generated/untrusted-derived core blocks in a session-level untrusted-data fence + guard so the agent treats injected block content as data, not directions; test pins the fence; suite green. Source: security-reviewing OPT-11. |  |
| OPT-77 | LOW | extract.ts FACT_EXTRACTION_PROMPT feeds untrusted content.slice(0,4000) into the LLM user message with NO fence/guard (lower risk: JSON-mode structured-triple output + OPT-04 validateFactResponse downstream, so worst case is a malicious triple that gets dropped). Consistency gap vs OPT-10/OPT-11. | pending | packages/core/src/extract.ts:127-136 | mirror the untrusted-data fence + guard on the extraction prompt (the content is data to extract triples from, never instructions); test pins it; suite green. Source: security-reviewing OPT-11. |  |
| OPT-79 | LOW | amp:episodic-buffer Redis stream has no MAXLEN on add — partially self-bounding via flush() XDEL, but events for never-flushed sessions accumulate unbounded. Also: SIGNALS_STREAM_MAXLEN uses raw process.env not the readEnv helper (minor consistency). | pending | packages/redis/src/streams.ts (EpisodicBuffer.add ~; SIGNALS_STREAM_MAXLEN ~24) | add a matching MAXLEN ~ safety cap to the episodic-buffer XADD; optionally route SIGNALS_STREAM_MAXLEN through readEnv for consistency; test pins bounded growth; suite green. Source: implementing/verifying OPT-14. |  |
| OPT-80 | LOW | (deferred enhancement, needs approval) EntityResolver CI/alias resolution still does a toLower(e.name) scan + alias-array scan unservable by the entity_name index — make it index-backed. | pending | packages/neo4j/src/entity-resolver.ts; packages/neo4j/src/schema.ts + migrations.ts | add persisted :Entity.name_lower property + index (and lowercased-alias index), rewrite resolveExisting to equality-match name_lower; REQUIRES a schema migration + backfill of name_lower on existing nodes → HUMAN APPROVAL before running. Source: implementing OPT-17. |  |
| OPT-81 | LOW | Fact supersession is now create-before-invalidate (OPT-21) but still TWO transactions — a benign transient two-active window exists until both commit; a single Neo4j tx would make it fully atomic. | pending | packages/neo4j/src/fact.ts; packages/core/src/service.ts | add FactStore.createAndInvalidate(newFact, oldId, invalidAt) doing both writes in one tx+session; service uses it on the contradiction path; test pins atomicity (no two-active window); suite green. Source: implementing OPT-21. |  |
| OPT-82 | LOW | CodeIndexer relation resolution (resolveRelation per SYMBOL_CALLS/IMPORTS/INHERITS edge) is still per-edge N+1 — each does an ordered OPTIONAL MATCH fallback with the rel-type interpolated. | pending | packages/code/src/indexer.ts:176-191; packages/code/src/resolver.ts | batch relation resolution per rel-type (UNWIND $edges grouped by type, or apoc.merge.relationship) without changing edge-resolution results; test pins identical edges + fewer round-trips; suite green. Source: implementing OPT-23. |  |
| OPT-83 | LOW | Consistency: arch/relation-store.ts remove() is fail-OPEN (silently no-ops on a non-allowlisted type) vs create() which throws — asymmetric; and the rel-type allowlists are duplicated across 3 packages (arch VALID_RELATION_TYPES, code VALID_SYMBOL_RELS, neo4j VALID_REL_TYPES) with no shared source of truth. | pending | packages/arch/src/relation-store.ts:51; packages/code/src/indexer.ts:249; packages/neo4j/src/temporal-edges.ts:28 | make remove() throw on bad type (match create); optionally centralize the allowlists into one shared const; tests; suite green. Source: security-reviewing OPT-25. Not a vuln (all sinks guarded) — consistency only. |  |
| OPT-84 | LOW | consolidation.ts invalidateByNodeId(id) calls drop the tenant → DEFAULT bucket, so on supersede/decay a NAMED tenant's context cache isn't evicted (within-tenant stale read; no cross-tenant eviction since it only touches DEFAULT). Background/global process — no per-tenant request context, so genuinely harder than OPT-27's request-path threading. | pending | packages/core/src/consolidation.ts:377,378,398,458 | derive the affected node's tenant (from the semantic/fact node's tenant_id) and pass it to invalidateByNodeId; or invalidate across tenant buckets for a shared node; test; suite green. Source: security-reviewing OPT-27. |  |
| OPT-85 | LOW | OPT-28 bounds per-connection receive TIME but not concurrent connection COUNT — a slowloris opening many sub-30s connections, or a connection flood, still pressures the accept queue/pool. | pending | packages/mcp/src/server.ts (createServer/listen); deploy (reverse proxy) | set httpServer.maxConnections to a sane cap and/or document a reverse-proxy connection-limit + rate-limit in front; test asserts the cap is set; suite green. Source: security-reviewing OPT-28. |  |
| OPT-78 | LOW | Redaction (store + ingest paths) only covers content/task fields — structural free-text fields (title, tags, entity/claim names) persist verbatim, so a secret pasted into a title/tag/entity name is not masked even with MEMBERRY_REDACT_ON_INGEST on. | pending | packages/wiki/src/ingest.ts (title/tags/about); packages/core/src/service.ts:421-430 | when redactOnIngest, also redactSecrets the title (at minimum) + tags on both ingest and store paths; test pins a secret in a title is masked; suite green. Source: security-reviewing OPT-12. |  |
| OPT-86 | LOW | Actor-label quirk: when ONE token string is both MEMBERRY_API_TOKEN and a tenant token, server.ts:331 (apiToken block, runs AFTER the tenant loop at 298-311) overwrites its actor from the tenant name back to 'default'. Tenant isolation is unaffected (it IS a tenant token → fail-closed passes, tenant_id correct) — only the actor label/attribution is wrong. | pending | packages/mcp/src/server.ts:318-335 | guard `tokenToActor.set(apiToken,'default')` with `if (!tokenToActor.has(apiToken))` (mirror the pattern at line 308 so a tenant-mapped actor isn't clobbered); test pins the actor label survives; suite green. Source: security-reviewing OPT-29. Not a vuln — attribution only. |  |
| OPT-87 | LOW | (informational, defense-in-depth) In fail-closed mode isAuthorized runs TWO sequential constant-time sweeps (actorForToken then tenantForToken), so total wall-time can distinguish a valid-non-tenant token from an invalid token. Both are rejected 401; not an escalation (attacker already holds a valid global token). | pending | packages/mcp/src/server.ts:397-411 | if ever tightened, collapse to a single token→{actor,tenant} resolution sweep so the two reject classes are time-indistinguishable; test/bench optional. Source: security-reviewing OPT-29. Low/informational. |  |
| OPT-88 | LOW | (doc nit) parseTokenPairs splits on the FIRST ':' (indexOf), so a TOKEN may legally contain ':' after the first one (e.g. "alice:tok:with:colons" → token "tok:with:colons"). The OPT-30 doc comment + .env.example say tokens "may not contain ',' or ':'", which is over-strict — only the NAME truly cannot contain ':', and ',' is forbidden in both halves. | pending | packages/mcp/src/server.ts (parseTokenPairs doc ~108); .env.example (API_TOKENS + TENANT_TOKENS notes) | correct the doc to: name may not contain ':' or ','; token may not contain ',' (but MAY contain ':' after the first). Doc-only; no code change. Source: security-reviewing OPT-30. |  |
| OPT-89 | LOW | When a NON-EMPTY MEMBERRY_TENANT_TOKENS yields zero valid pairs, multi-tenant mode silently flips OFF (reverting to single-tenant + disengaging OPT-29 fail-closed). Today this shares the generic parseTokenPairs "ZERO valid pairs" warning; an explicit "multi-tenant mode NOT enabled" line would make the fail-open transition unmissable. | pending | packages/mcp/src/server.ts:312 (multiTenantMode) and the TENANT_TOKENS parse site | after parsing, if MEMBERRY_TENANT_TOKENS was non-empty but tokenToTenant.size===0, log an explicit "[memberry] WARNING: MEMBERRY_TENANT_TOKENS set but multi-tenant mode is NOT enabled (no valid tenant tokens)"; test; suite green. Source: security-reviewing OPT-30. |  |
| OPT-90 | LOW | _disputeRelatedFacts (consolidation contradiction-driven supersede path) calls factLayer.dispute(active.id) on every matching active fact with NO confidence gate — so untrusted-extracted content can mark an ESTABLISHED fact `disputed`. Soft/reversible (no invalid_at, no supersession, recoverable via corroborate) so not a full OPT-31 defeat, but a parallel ungated degradation path. | pending | packages/core/src/consolidation.ts:585-607 (_disputeRelatedFacts) | extend the OPT-31 confidence gate to the dispute path: don't dispute an established fact (confidence >= protect) from a lower-confidence extraction; test; suite green. Source: security-reviewing OPT-31. |  |
| OPT-91 | LOW | (defense-in-depth, ties OPT-70) OPT-31's gate compares contender confidence to the established fact's; today extractFacts emits NO per-fact confidence so the contender always pins to 0.5 (bypass unreachable), but if a future extractFacts returns attacker-influenced confidences the `newConfidence >= current.confidence` clause could be passed to auto-invalidate. Clamp extraction-origin contenders (status tentative and/or capped confidence) regardless. | pending | packages/core/src/consolidation.ts:533-600; packages/core/src/extract.ts | clamp/mark extraction-origin contender facts so they can never auto-invalidate on confidence alone; converges with OPT-70 provenance-based clamping. test; suite green. Source: security-reviewing OPT-31. |  |
| OPT-92 | LOW | consolidation._extractAndStoreFacts calls findBySubjectPredicate(subject, predicate) with NO tenant arg (the ConsolidationNeo4jLayer.fact interface omits the tenant param), unlike the service path (service.ts passes factTenant). In multi-tenant deployments this background reconciliation is not tenant-scoped — a contradiction in one tenant's content could match/affect another tenant's fact. Pre-existing, orthogonal to OPT-31. | pending | packages/core/src/consolidation.ts:142-146 (interface), 522-525,594-597; packages/neo4j/src/fact.ts (findBySubjectPredicate) | thread tenant (derive via _deriveTenantFromEpisodes) into findBySubjectPredicate on the consolidation fact path; test proves cross-tenant facts aren't matched; suite green. Source: security-reviewing OPT-31. |  |
| OPT-93 | INFO | (accepted-limitation, document) redactSecrets has no generic high-entropy detector and does not catch a STANDALONE AWS secret access key (40-char base64 value with no keyword) — both are inherent false-positive / indistinguishable-from-base64 minefields, deliberately deferred per the module's "conservative, don't mangle prose" posture. Keyed AWS secrets ARE caught via the aws_secret_access_key assignment keyword (OPT-33). | pending | packages/core/src/redact.ts | document the accepted limitation in the module doc-comment; only revisit with a concrete leak class + a low-FP, context-gated entropy heuristic. Source: security-reviewing OPT-33. |  |
| OPT-94 | LOW | Minor over-redaction (availability, errs safe): prose of the form `token: <word>` / `secret: <word>` / `auth: <word>` masks the single following word via the SECRET_ASSIGNMENT bare-value branch, e.g. `token: an opaque value` → `token: [REDACTED] opaque value`. Inherent to keyword-assignment redaction; never leaks, only over-masks one word. | pending | packages/core/src/redact.ts:41-42 | optionally require a credential-shaped bare value (min length / charset) before masking, or only mask when REDACT_ON_INGEST AND the value looks secret; weigh against leak-safety. Low. Source: security-reviewing OPT-33. |  |
| OPT-95 | LOW | Parallel array-length gap (same class as OPT-36): agent-input arrays lack a .max() length cap — AmpStoreSchema.entities[]/tags[] (per-element .max(500) but unbounded length), AmpLoadSchema.entities[]/tags[], AmpResolveSchema, AmpBootstrapSchema.about[]/tags[]/entities[]/semantic_seeds[] (some inner z.string() also lack per-element .max()). Bounded overall only by OPT-08's 1MB body cap. | pending | packages/mcp/src/tools.ts:260-261,276,279,312-344 | add .max(N) array-length caps (+ missing inner .max()) across these agent-input schemas, mirroring OPT-36; tests; suite green. Source: security-reviewing OPT-36 + OPT-40. |  |
| OPT-96 | LOW | Defense-in-depth: SignalStream.publish XADDs signal fields (target_id/detail) verbatim with no length assertion at the Redis layer — it relies entirely on the upstream Zod cap, so a non-MCP caller of service.store() could still write an oversized stream entry. | pending | packages/redis/src/streams.ts:42-52 (SignalStream.publish) | add a belt-and-braces truncate/assert on target_id+detail length in publish() so the Redis layer self-protects regardless of caller; test; suite green. Source: security-reviewing OPT-36. |  |
| OPT-97 | LOW | parseTenantDatastores' invalid-JSON branch interpolates JSON.parse's err.message into the thrown error; V8 echoes a source snippet on some syntax errors, so a malformed (operator-authored) MEMBERRY_TENANT_DATASTORES with an unquoted secret could leak a PARTIAL secret into startup logs. Operator-self-inflicted, logs-only, partial — but the OPT-37 docstring's "never echoed into logs" overstates the invalid-JSON branch. | pending | packages/mcp/src/bootstrap.ts:111-113,100-101 | replace the interpolated err.message with a generic "not valid JSON (parse error)" (drop/redact the underlying snippet) AND tighten the docstring. Source: security-reviewing OPT-37. |  |
| OPT-98 | LOW | parseTenantDatastores validates non-empty strings but NOT URL scheme, so a typo'd-but-non-empty neo4jUri/redisUrl (e.g. `bolt://wrong-host`, or a wrong scheme) passes validation and points a tenant at an unintended store. The silent-localhost-fallback (OPT-37) is fully fixed; this is a narrower typo-resilience gap. | pending | packages/mcp/src/bootstrap.ts:85-92 (TenantDatastoreSchema) | add a scheme refinement (.url() or a bolt://|neo4j:// / redis://|rediss:// regex) on neo4jUri/redisUrl; test; suite green. Source: security-reviewing OPT-37. |  |
| OPT-99 | LOW | FactStore.timeline() runs `MATCH (f:Fact)…RETURN f ORDER BY f.valid_at` with NO LIMIT clause and maps every record, so the berry_timeline UNLIMITED path (absent/0/negative limit — the latter two now route to "return all" post-OPT-39) returns ALL facts for an entity with no absolute ceiling — a large-response vector for a high-cardinality entity. OPT-39's .max(100) only bounds the explicit-limit path. | pending | packages/neo4j/src/fact.ts:237-244 (timeline) | add an absolute hard cap to the timeline query (Cypher LIMIT, e.g. 500/1000) or clamp facts.length in the handler's return-all path; test; suite green. Source: security-reviewing OPT-39. |  |
| OPT-101 | LOW | OPT-41 batched the load() fact FETCH but resolution is still per-entity (N parallel resolveExisting). Batching the resolve too (one query returning top-1 entity per name with the OPT-17 exact>CI>alias precedence) would take load() facts to ~2 round-trips total, but faithfully replicating EntityResolver precedence in one UNWIND query is divergence-prone. Pairs with OPT-80 (indexed name_lower migration, needs approval). | pending | packages/neo4j/src/entity-resolver.ts (add resolveExistingBatch); packages/neo4j/src/fact.ts (getActiveBatch uses it) | add EntityResolver.resolveExistingBatch(names) preserving exact precedence + trim; getActiveBatch uses it; test proves batch resolve === per-name resolveExisting; suite green. Source: implementing OPT-41. |  |
| OPT-100 | LOW | AmpFactDiffSchema.from/to are bare UNBOUNDED z.string() (no length cap, no format) — the SAME timestamp-DoS vector OPT-40 fixed in AmpLoadSchema.temporal, feeding the SAME fact.diff() Cypher sink (parameterized, so no injection — DoS+correctness only). Reconfirmed by the OPT-40 review as a direct parity gap. | pending | packages/mcp/src/tools.ts (AmpFactDiffSchema ~419-420) | apply .max(40) parity to from/to (mirror OPT-40 temporal); optionally a lenient `.regex(/^\d{4}-\d{2}-\d{2}/)` + from≤to handler assert; test; suite green. Source: security-reviewing OPT-39/OPT-40. |  |

## Completed Tasks

| ID | Task | Cycle | Commit | Result |
|----|------|-------|--------|--------|
| OPT-01 | Gate ranked code channel on default tenant (close cross-tenant code leak) | 1 | `11d703c` | gate green 1463 passed / 0 failed; security-reviewer PASS |
| OPT-02 | Bind SSE/Streamable sessions to creating tenant+actor; 403 on token mismatch | 2 | `20c7819` | gate green 1465 passed / 0 failed (mcp 126); security-reviewer PASS |
| OPT-03 | Confine post-store re-index paths to ingest base (block arbitrary file read) | 3 | `9b0b029` | gate green 1472 passed / 0 failed (code 114); security-reviewer PASS |
| OPT-04 | Validate extracted-fact predicate shape + value bounds (block graph poisoning) | 4 | `a47b124` | gate green 1480 passed / 0 failed (core 321); security-reviewer PASS |
| OPT-05 | Redact JSON-quoted credentials in SECRET_ASSIGNMENT (core + graph allowlist) | 5 | `21c3462` | gate green 1483 passed / 0 failed (core 323, graph 53); security-reviewer PASS |
| OPT-06 | No-dep ReDoS screen + 4k scan cap for berry_grep JS-side regex (interim; re2→B-01) | 6 | `7ce8c69` | gate green 1488 passed / 0 failed (mcp 131); security-reviewer PASS |
| OPT-07 | Bounded tx timeout on grep =~ rawCypher path (Neo4j-side ReDoS backstop) | 7 | `7374e7a` | gate green 1492 passed / 0 failed (neo4j 193); security-reviewer PASS |
| OPT-08 (+OPT-13) | Cap MCP request body size → HTTP 413 (memory-exhaustion DoS) | 8 | `27fc2e4` | gate green 1495 passed / 0 failed (mcp 136); security-reviewer PASS |
| OPT-09 | Realpath symlink confinement for wiki validatePath + confineToDir | 9 | `28df712` | gate green 1501 passed / 0 failed (wiki 282); security-reviewer PASS |
| OPT-10 | Fence untrusted evidence + untrusted-data guard in berry_ask synthesis | 10 | `b2f45d6` | gate green 1504 passed / 0 failed (retrieval 141); security-reviewer PASS |
| OPT-11 | Fence+guard dream prompts + sanitize project_card before core-block persist | 11 | `c5f871d` | gate green 1508 passed / 0 failed (core 327); security-reviewer PASS |
| OPT-12 | Apply redactSecrets on wiki ingest/braindump when MEMBERRY_REDACT_ON_INGEST | 12 | `cd2bae5` | gate green 1513 passed / 0 failed (wiki 287); security-reviewer PASS |
| OPT-14 (+OPT-18) | Bound amp:signals Redis stream with approximate MAXLEN on XADD | 13 | `490c3d3` | gate green 1514 passed / 0 failed (redis 69); reliability item (no sec-review) |
| OPT-15 | Confine berry_ingest_codebase path to project root (mirror sibling code tools) | 14 | `b815f48` | gate green 1518 passed / 0 failed (mcp 140); security-reviewer PASS |
| OPT-16 | Batch DeterministicAssembler per-step queries via UNWIND (6×T→6, output-identical) | 15 | `3855d00` | gate green 1519 passed / 0 failed (retrieval 142); perf — output-identity verified |
| OPT-17 | Collapse EntityResolver.resolveExisting 3 sequential queries into 1 precedence-ranked query | 16 | `5b3127f` | gate green 1523 passed / 0 failed (neo4j 197); perf — precedence preserved |
| OPT-19 | Release dedup key on failed store() so retries aren't swallowed (unmark + rollback) | 17 | `4c3853d` | gate green 1526 passed / 0 failed (core 330); reliability (no sec-review) |
| OPT-20 (+OPT-65) | Read-through embedding cache wired into hot paths | 18 | `3c82078` | gate green 1532 passed / 0 failed (core 336); perf — behavior-identical on miss |
| OPT-21 | Create-before-invalidate fact supersession (no data loss on mid-failure) | 19 | `c071375` | gate green 1534 passed / 0 failed (core 338); reliability (no sec-review) |
| OPT-22 | Batch wiki episodic fetch into one UNWIND scan (E scans→1, results identical) | 20 | `a39fcfe` | gate green 1537 passed / 0 failed (wiki 290); perf — result-identical |
| OPT-23 | Batch per-file symbol upserts into one UNWIND MERGE (N→1, graph-identical) | 21 | `17fc63d` | gate green 1540 passed / 0 failed (code 117); perf — graph-identical |
| OPT-24 | Wire tenant/ingest env vars through docker-compose mcp service | 22 | `907ef57` | gate green 1540 passed / 0 failed (config-only); ops |
| OPT-25 | In-function rel-type allowlist on invalidateRelationship (close latent injection sink) | 23 | `132426a` | gate green 1543 passed / 0 failed (neo4j 200); security-reviewer PASS |
| OPT-26 | Namespace retrieval feedback boost keys by tenant (close cross-tenant ranking channel) | 24 | `2a49cbd` | gate green 1547 passed / 0 failed (retrieval 146); security-reviewer PASS |
| OPT-27 | Namespace context-cache keys by tenant (+block-invalidation path) | 25 | `5f5b026` | gate green 1557 passed / 0 failed; security-reviewer PASS |
| OPT-28 | Set HTTP slowloris timeouts (headers/request/keepAlive) | 26 | `5dfd81d` | gate green 1560 passed / 0 failed (mcp 143); security-reviewer PASS |
| OPT-29 | Fail-closed multi-tenant binding (reject non-tenant tokens; MEMBERRY_ALLOW_DEFAULT_TENANT opt-out) | 27 | `fd8046d` | gate green 1561 passed / 0 failed (mcp 144); security-reviewer PASS |
| OPT-30 (+OPT-38) | Validate token-pair parsing (length 4..4096) + warn on skipped/empty/zero-pair entries | 28 | `760254c` | gate green 1571 passed / 0 failed (mcp 154); security-reviewer PASS |
| OPT-31 | Gate extraction-driven fact invalidation by confidence (protect established facts) | 29 | `a941912` | gate green 1576 passed / 0 failed (core 348); security-reviewer PASS |
| OPT-32 | Per-item evidence cap for berry_ask synthesis | 30 | `d023c6a` | gate green 1586 passed / 0 failed (retrieval 156); perf/hardening (verifier-only) |
| OPT-33 | Broaden secret redaction (Stripe/Bearer/escaped-quote/keywords) | 31 | `607f1ae` | gate green 1592 passed / 0 failed (core 353); security-reviewer PASS |
| OPT-34 | Dedupe graph redactor to core (fix github_pat_ export drift) | 31 | `607f1ae` | gate green 1592 passed / 0 failed (graph 54); security-reviewer PASS |
| OPT-35 | Size guard for CodeIndexer parseFile (stat-and-skip > 2 MiB) | 32 | `5a46f84` | gate green 1595 passed / 0 failed (code 120); hardening (verifier-only) |
| OPT-36 | Bound berry_store signals[] schema (500/2000/array 50) | 33 | `929f202` | gate green 1601 passed / 0 failed (mcp 160); security-reviewer PASS |
| OPT-37 | Shape-validate MEMBERRY_TENANT_DATASTORES (fail-closed) | 34 | `25f5b90` | gate green 1609 passed / 0 failed (mcp 168); security-reviewer PASS |
| OPT-39 | Bound AmpTimelineSchema.limit to a positive int (+handler slice guard) | 35 | `dfaad0e` | gate green 1615 passed / 0 failed (mcp 174); security-reviewer PASS |
| OPT-40 | Bound research secondary_metrics + temporal timestamp schemas | 36 | `9d8f098` | gate green 1625 passed / 0 failed (research 144, mcp 178); security-reviewer PASS |
| OPT-41 | Batch load() fact fetch into one round-trip (FactStore.getActiveBatch) | 37 | `640d572` | gate green 1629 passed / 0 failed (neo4j 202, core 355); perf — output-identity proven (live-Neo4j integration test) |
| OPT-42 | Batch staleness-decay writes (FactStore.updateConfidenceBatch) | 38 | `782a0a5` | gate green 1633 passed / 0 failed (neo4j 204, core 357); perf — same end-state (live-Neo4j integration test) |
| OPT-43 | Batch SOURCED_FROM edge MERGEs in FactStore.create | 39 | `7691296` | gate green 1634 passed / 0 failed (neo4j 205); perf — graph-identical (live-Neo4j integration test) |

## Failed Attempts

| ID | Task | What Failed | Lesson |
|----|------|-------------|--------|
| (none yet) | | | |

## Already Done — Do Not Re-Audit

- Prior hardening pass (`docs/amp-hardening-handoff-2026-05-29.md`): project/tenant scope isolation across retrieval/arch/code tools; amp_grep parameterized through ScopedQuery.rawCypher; raw amp_query blocks SHOW/USE + mutations + stored procs, bounds subquery, caps 100 rows; token-budget skip-oversized; readyz/healthz; SSE shutdown bounding; snapshot pathscoping; EntityResolver.trim().
- In-flight hardening committed as `d2d8850` (loop base): Cypher injection audit logging (injection-log.ts) + query scope enforcement (scope-bleed.repro + query-scope-enforcement tests).
- Audit-confirmed already-mitigated (do not re-open): generated session token uses crypto.randomUUID and is the documented dev fallback; EpisodicBuffer.flush XRANGE is bounded by design per the verifier — re-confirm only if that code changes.

## Blocked — Needs User Decision

| ID | Item | Conflict / question | Raised (cycle) | Status |
|----|------|---------------------|----------------|--------|
| B-01 | Add `re2` runtime dependency for robust ReDoS-proof grep (OPT-06 follow-up) | OPT-06 shipped a no-dep INTERIM (shape screen + 4k scan cap). It does NOT catch polynomial ReDoS (`a*a*c`) or lookaround/backref blowups — those are bounded only by the 4k cap. The robust fix is `re2` (Google's linear-time, non-backtracking engine) at the `new RegExp` chokepoint, which makes catastrophic backtracking impossible and lets us drop the heuristic's false-rejections. COST: native addon (node-gyp / prebuilt binaries) → needs build toolchain in the Docker image or a libc-correct prebuilt; adds an install/build step. **NEEDS HUMAN APPROVAL to add the dependency.** | 6 | NEEDS USER DECISION |

## Current Rules

- One backlog item in flight per cycle (Mode A) + unlimited small adjacent Mode-B discovery fixes. Smallest diff that passes the gate.
- The maker NEVER verifies its own work. A separate verifier re-runs the gate on cerebro and can REJECT. Security items (OPT-01..07, 09, 10–12, 15, 25–31, 33–34, 36–40) additionally get a security-reviewer pass.
- Never weaken/skip/delete a test to go green. A wrong test is a logged backlog item.
- For `confirm-before-removing` items: reproduce the destructive claim (re-grep dynamic/string/reflection refs) before deleting/dropping; if not reproducible, mark IN PROGRESS "unconfirmed" and skip.
- STOP and write to Blocked when an item changes a public MCP tool schema, the Neo4j graph schema, an on-disk format (wiki/export), or an env-var contract in a breaking way; or when intent is ambiguous; or when it is clearly multi-cycle (split it).
- Do NOT add a runtime dependency (e.g. `re2` for OPT-06) without a Blocked entry for human approval first — it changes the install/Docker surface.
- Never touch `~/projects/amp` (live services) or `master` directly. All work is on `opt/memberry-hardening`.

## Next Run Instructions

Start cycle 40 at **OPT-44** (PERF/N+1 — EpisodicStore.create writes the embedding in a SECOND round-trip (CREATE node, then a separate SET f.embedding), unlike SemanticStore which inlines it. Inline the embedding into the CREATE so episode creation is one round-trip. `packages/neo4j/src/episodic.ts:9-52` — re-locate create() + the separate embedding SET; mirror SemanticStore's inline pattern (check how SemanticStore.create does it); PERF → verifier-only, confirm node + embedding identical to before; watch the embedding-absent case stays a no-op). Then OPT-45 (_deriveTenantFromEpisodes one-by-one episode fetch → batched UNWIND projection of tenant_id; consolidation.ts:475-497), OPT-46 (findBySubjectPredicate toLower(predicate) scan → normalized predicate prop + composite index — MAY NEED A SCHEMA MIGRATION → if so, file Blocked, don't run unattended), OPT-47 (single-flight/stampede on load), OPT-48 (PENDING_SET dangling proposal ids), OPT-49/50 (double query embed → OPT-20 cache or thread vector), OPT-51+ … down the table. Still-open follow-ups: OPT-86–101. SEE Blocked B-01 (re2). GATE-CMD: `| tee /tmp/x.log | tail` INSIDE the ssh single-quotes (decisions.md c35). If IN PROGRESS, recover partial work or revert to the last gate-green commit first.

## Session History

### Cycle 1 — 2026-06-13
- Commit: `11d703c` OPT-01: gate ranked code channel on default tenant (close cross-tenant code leak)
- Item: OPT-01 — COMPLETED
- Mode B: 1 discovery (DeterministicAssembler entity queries not tenant-filtered — defense-in-depth, not a live leak) → added as OPT-67
- Verifier: PASS (1463 passed, 0 failed, build exit 0; retrieval 138) | Security-reviewer: PASS (single chokepoint; satellite code tools withheld from tenant sessions; no new hazard)
- Metrics: passing 1461→1463 (floor 1463); skipped 16
- Next: OPT-02

### Cycle 2 — 2026-06-13
- Commit: `20c7819` OPT-02: bind SSE/Streamable sessions to creating tenant+actor; 403 on token mismatch
- Item: OPT-02 — COMPLETED
- Mode B: clean sweep (no new findings; the binding is the single chokepoint)
- Verifier: PASS (1465 passed, 0 failed, build exit 0; mcp 124→126) | Security-reviewer: PASS (both /mcp + /messages dispatch paths identity-checked before forwarding; bindings set atomically with map insertion; no empty-binding window; auth-off no-isolation documented)
- Metrics: passing 1463→1465 (floor 1465); skipped 16
- Next: OPT-03

### Cycle 3 — 2026-06-13
- Commit: `9b0b029` OPT-03: confine post-store re-index paths to ingest base (block arbitrary file read)
- Item: OPT-03 — COMPLETED
- Mode B: 1 discovery (TOCTOU between confine and reindexFile read) → added as OPT-68 (LOW)
- Verifier: PASS (1472 passed, 0 failed, build exit 0; code 107→114) | Security-reviewer: PASS (all escape vectors closed — .., abs, ${base}EVIL prefix, symlink-realpath on both sides; hook is sole untrusted entry; base resolves to systemd WorkingDirectory)
- Metrics: passing 1465→1472 (floor 1472); skipped 16
- Next: OPT-04

### Cycle 4 — 2026-06-13
- Commit: `a47b124` OPT-04: validate extracted-fact predicate shape + value bounds (block graph poisoning)
- Item: OPT-04 — COMPLETED (format-validation chosen over brittle allowlist; covers all 3 extractFacts sites incl. consolidation, so OPT-31's predicate half is done)
- Mode B: 3 discoveries → OPT-69 (normalize-before-shape-check, LOW), OPT-70 (provenance/tentative clamp for in-shape poisoning, MED), OPT-71 (dream-hypothesis predicate validation, LOW)
- Verifier: PASS (1480 passed, 0 failed, build exit 0; core 313→321) | Security-reviewer: PASS (instruction-smuggling predicates + oversized values dropped, no false-drops; residuals → OPT-70/71)
- Metrics: passing 1472→1480 (floor 1480); skipped 16
- Next: OPT-05

### Cycle 5 — 2026-06-13
- Commit: `21c3462` OPT-05: redact JSON-quoted credentials in SECRET_ASSIGNMENT (core + graph allowlist)
- Item: OPT-05 — COMPLETED
- Mode B: residuals folded into existing items — OPT-33 (escaped-quote tail leak, Bearer-header, pwd/private_key keys) + OPT-34 (github_pat_ export drift confirmed)
- Verifier: PASS (1483 passed, 0 failed, build exit 0; core 321→323, graph 52→53) | Security-reviewer: PASS (JSON gap closed both paths, no ReDoS, no prose false-positives, harmless over-redaction of booleans)
- Metrics: passing 1480→1483 (floor 1483); skipped 16
- Next: OPT-06 (ReDoS — re2 dep needs a Blocked row; ship no-dep interim)

### Cycle 6 — 2026-06-13
- Commit: `7ce8c69` OPT-06: no-dep ReDoS screen + 4k scan cap for berry_grep JS-side regex (interim)
- Item: OPT-06 — COMPLETED (interim; robust re2 fix filed as Blocked B-01 for human approval)
- Mode B: lowered MAX_SCAN_TEXT_LEN 50k→4k mid-cycle (security-reviewer found polynomial ReDoS still stalls within 50k); re-ran full gate green
- Verifier: PASS (1488 passed, 0 failed, build exit 0; mcp 126→131) | Security-reviewer: PASS (exponential shapes + unbounded input closed; residual poly/lookaround → re2 B-01; recommended + applied the 4k cap)
- Metrics: passing 1483→1488 (floor 1488); skipped 16
- Next: OPT-07

### Cycle 7 — 2026-06-14
- Commit: `7374e7a` OPT-07: bounded tx timeout on grep =~ rawCypher path (Neo4j-side ReDoS backstop)
- Item: OPT-07 — COMPLETED
- Mode B: 1 discovery → OPT-72 (MED: berry_query =~ still unbounded; default-timeout-on-all-rawCypher + tighten grep to 2s)
- Verifier: REJECT then PASS — first run found a pre-existing mcp test (tools.test.ts:826/835) asserting the exact 3-arg shape of the non-regex grep rawCypher call; updated those two assertions to expect the new 4th arg (undefined) — a signature update, not a weakening — re-ran gate GREEN (1492 passed, 0 failed; neo4j 191→193, mcp 132→134) | Security-reviewer: PASS (5s timeout bounds server-side ReDoS, READ-only preserved, clean error surface; residuals→OPT-72/B-01)
- Metrics: passing 1488→1492 (floor 1492); skipped 15
- Next: OPT-08

### Cycle 8 — 2026-06-14
- Commit: `27fc2e4` OPT-08: cap MCP request body size → HTTP 413 (closes dup OPT-13)
- Item: OPT-08 — COMPLETED; OPT-13 marked DONE (no-op, /mcp body goes through the capped readJsonBody)
- Mode B: 1 discovery → OPT-73 (LOW: /messages SSE POST body not capped — SDK-read)
- Verifier: PASS (1495 passed, 0 failed, build exit 0; mcp →136; server.test.ts 14→17) | Security-reviewer: PASS (peak buffered ≤ cap+1 chunk; honest/chunked/lying Content-Length all 413; no crash from req.destroy; env-override hardened)
- Metrics: passing 1492→1495 (floor 1495); skipped 16
- Next: OPT-09

### Cycle 9 — 2026-06-14
- Commit: `28df712` OPT-09: realpath symlink confinement for wiki validatePath + confineToDir
- Item: OPT-09 — COMPLETED
- Mode B: 1 discovery → OPT-74 (MED: symlinked-ancestor-of-not-yet-existing-leaf + TOCTOU across all confinement helpers; absorbs OPT-68's TOCTOU note)
- Verifier: PASS (1501 passed, 0 failed, build exit 0; wiki 276→282; RED-confirmed: reverting the realpath layer → 2 symlink-test failures, so the tests genuinely run on Linux) | Security-reviewer: PASS (symlink-escape closed for ingest/compile/viewer; every confineToDir serve site covered; lexical-first so swallowing realpath errors never bypasses)
- Metrics: passing 1495→1501 (floor 1501); skipped 16
- Next: OPT-10

### Cycle 10 — 2026-06-14
- Commit: `b2f45d6` OPT-10: fence untrusted evidence + untrusted-data guard in berry_ask synthesis
- Item: OPT-10 — COMPLETED
- Mode B: 1 discovery → OPT-75 (LOW: output-side leak/echo filtering of the synthesized answer)
- Verifier: PASS (1504 passed, 0 failed, build exit 0; retrieval 138→141; RED-confirmed naked-injection format before change) | Security-reviewer: PASS (sound data/instruction separation; strip regex covers open+close, ci, ws-tolerant, ReDoS-safe; additive — citation/answer-format preserved; confirmed dream=OPT-11 is the remaining free-text untrusted→LLM gap, extraction adequately covered by OPT-04)
- Metrics: passing 1501→1504 (floor 1504); skipped 16
- Next: OPT-11

### Cycle 11 — 2026-06-14
- Commit: `c5f871d` OPT-11: fence+guard dream prompts + sanitize project_card before core-block persist
- Item: OPT-11 — COMPLETED
- Mode B: 2 discoveries → OPT-76 (MED: wrap core blocks as untrusted data at session injection — full second-order fix), OPT-77 (LOW: extract.ts FACT_EXTRACTION_PROMPT still unfenced). Note: sanitizeCard opener-1 regex is O(n²) but defended by maxTokens:400 output cap (latent, no fix needed).
- Verifier: REJECT then PASS — first run: 2 of 4 new tests failed (non-gap entity mod-b fires only the card chat call, not hypothesize; positional mocks mis-sequenced). Maker fixed tests with respond-by-content mockImplementation (dream.ts untouched). Re-run GREEN 1508/0 (core 323→327) | Security-reviewer: PASS (input fenced both paths; sanitizeCard correctly pre-persist; regexes don't over-match)
- Metrics: passing 1504→1508 (floor 1508); skipped 16
- Next: OPT-12

### Cycle 12 — 2026-06-14
- Commit: `cd2bae5` OPT-12: apply redactSecrets on wiki ingest/braindump when MEMBERRY_REDACT_ON_INGEST
- Item: OPT-12 — COMPLETED (LAST security backlog item; OPT-01..12 all done)
- Mode B: 1 discovery → OPT-78 (LOW: structural fields title/tags not redacted on either path)
- Verifier: PASS (1513 passed, 0 failed, build exit 0; wiki 282→287; prod .env doesn't set the flag → no env interaction) | Security-reviewer: PASS (all persisted untrusted content covered: body redacted before extraction + per-claim; Source persists no body; consistent with store path; default-off preserved)
- Metrics: passing 1508→1513 (floor 1513); skipped 16
- Next: OPT-14 (optimization tier)

### Cycle 13 — 2026-06-14
- Commit: `490c3d3` OPT-14: bound amp:signals Redis stream with approximate MAXLEN on XADD (closes OPT-18)
- Item: OPT-14 — COMPLETED; OPT-18 marked DONE (no-op dup)
- Mode B: 1 discovery → OPT-79 (LOW: episodic-buffer stream MAXLEN cap + readEnv consistency for SIGNALS_STREAM_MAXLEN)
- Verifier: PASS (1514 passed, 0 failed, build exit 0; redis 68→69; RED-confirmed) | reliability item — no security-reviewer needed
- Metrics: passing 1513→1514 (floor 1514); skipped 16
- Next: OPT-15

### Cycle 14 — 2026-06-14
- Commit: `b815f48` OPT-15: confine berry_ingest_codebase path to project root (mirror sibling code tools)
- Item: OPT-15 — COMPLETED
- Mode B: clean sweep (residuals already tracked in OPT-74)
- Verifier: PASS (1518 passed, 0 failed, build exit 0; mcp 136→140; RED-confirmed by reverting the guard) | Security-reviewer: PASS (confined before any fs read; byte-identical to sibling code tools; args.path the only fs input)
- Metrics: passing 1514→1518 (floor 1518); skipped 16
- Next: OPT-16

### Cycle 15 — 2026-06-14
- Commit: `3855d00` OPT-16: batch DeterministicAssembler per-step queries via UNWIND (6×T→6, output-identical)
- Item: OPT-16 — COMPLETED (first non-trivial perf refactor)
- Mode B: clean sweep
- Verifier (run by orchestrator — the dispatched verifier backgrounded the gate and ended without a verdict): PASS — gate 1519 passed / 0 failed, build exit 0; retrieval 141→142; ALL existing deterministic output-identity tests held (no failures), and NO assertions were removed/loosened in deterministic.test.ts (targetName mock column is additive). Perf item — no security-reviewer.
- Metrics: passing 1518→1519 (floor 1519); skipped 16
- Next: OPT-17

### Cycle 16 — 2026-06-14
- Commit: `5b3127f` OPT-17: collapse EntityResolver.resolveExisting 3 sequential queries into 1 precedence-ranked query
- Item: OPT-17 — COMPLETED (safe non-migration 3→1 collapse)
- Mode B: 1 discovery → OPT-80 (LOW, deferred/needs-approval: indexed name_lower migration for index-backed CI/alias resolution)
- Verifier: PASS (1523 passed, 0 failed, build exit 0; neo4j 193→197; precedence exact>CI>alias preserved via CASE rank; existing entity-resolver contract tests held) | perf item — no security-reviewer
- Metrics: passing 1519→1523 (floor 1523); skipped 16
- Next: OPT-19

### Cycle 17 — 2026-06-14
- Commit: `4c3853d` OPT-19: release dedup key on failed store() so retries aren't swallowed
- Item: OPT-19 — COMPLETED
- Mode B: clean sweep
- Verifier: PASS (1526 passed, 0 failed, build exit 0; core 327→330; RED-confirmed: reverting service.ts+dedup.ts fails the 2 behavioral tests; BUG-0020 TOCTOU regression intact; mark stays before persist) | reliability item — no security-reviewer
- Metrics: passing 1523→1526 (floor 1526); skipped 16
- Next: OPT-20

### Cycle 18 — 2026-06-14
- Commit: `3c82078` OPT-20: read-through embedding cache (wire dormant EmbeddingCache into hot paths)
- Item: OPT-20 — COMPLETED; OPT-65 marked DONE (subsumed — code/intent share the cached wrapper)
- Mode B: clean sweep (no production embedding site constructed outside services-factory)
- Verifier: PASS (1532 passed, 0 failed, build exit 0; core 330→336; RED-confirmed; behavior-identical on cache miss; cache errors fall through to inner) | perf item — no security-reviewer
- Metrics: passing 1526→1532 (floor 1532); skipped 16
- Next: OPT-21

### Cycle 19 — 2026-06-14
- Commit: `c071375` OPT-21: create-before-invalidate fact supersession (no data loss on mid-failure)
- Item: OPT-21 — COMPLETED
- Mode B: 1 discovery → OPT-81 (LOW: single-tx atomic supersession to remove the benign transient two-active window)
- Verifier: PASS (1534 passed, 0 failed, build exit 0; core 336→338; RED-confirmed; end-state contract intact; error still propagates via non-fatal handler) | reliability item — no security-reviewer
- Metrics: passing 1532→1534 (floor 1534); skipped 16
- Next: OPT-22

### Cycle 20 — 2026-06-14
- Commit: `a39fcfe` OPT-22: batch wiki episodic fetch into one UNWIND scan
- Item: OPT-22 — COMPLETED
- Mode B: clean sweep (Phase-2 double-call already tracked in OPT-58)
- Verifier: PASS (1537 passed, 0 failed, build exit 0; wiki 287→290; result-identity verified — same predicate + per-name CALL{} LIMIT; RED-confirmed) | perf item — no security-reviewer
- Metrics: passing 1534→1537 (floor 1537); skipped 16
- Next: OPT-23

### Cycle 21 — 2026-06-14
- Commit: `17fc63d` OPT-23: batch per-file symbol upserts into one UNWIND MERGE
- Item: OPT-23 — COMPLETED
- Mode B: 1 discovery → OPT-82 (LOW: batch relation-edge resolution N+1)
- Verifier: PASS (1540 passed, 0 failed, build exit 0; code 114→117; graph-identity verified — ON CREATE=create props, ON MATCH=update subset, marker removed before RETURN, content-hash skip preserved; RED-confirmed) | perf item — no security-reviewer
- Metrics: passing 1537→1540 (floor 1540); skipped 16
- Next: OPT-24

### Cycle 22 — 2026-06-14
- Commit: `907ef57` OPT-24: wire tenant/ingest env vars through docker-compose mcp service
- Item: OPT-24 — COMPLETED (last MED; all CRIT/HIGH/MED now done)
- Mode B: clean sweep
- Verifier (orchestrator inline — config-only YAML, no source): YAML valid (python safe_load), 3 vars present with ${VAR:-} + names match readEnv call sites; full gate re-run green 1540/0 (unchanged — config-only). Ops item — no security-reviewer.
- Metrics: passing 1540 (floor 1540, unchanged — no new tests); skipped 16
- Next: OPT-25 (LOW tier begins)

### Cycle 23 — 2026-06-14
- Commit: `132426a` OPT-25: in-function rel-type allowlist on invalidateRelationship
- Item: OPT-25 — COMPLETED
- Mode B: 1 discovery → OPT-83 (LOW consistency: relation-store remove fail-open asymmetry + 3-way allowlist duplication)
- Verifier: PASS (1543 passed, 0 failed, build exit 0; neo4j 197→200; RED-confirmed by removing guard). NOTE: the dispatched verifier mis-summed the total as 1689 (verbose-reporter artifact); orchestrator re-ran and confirmed authoritative 1543/0 from per-package final lines. | Security-reviewer: PASS (sink enforced before interpolation; allowlist metachar-free incl ABOUT; no dep cycle; latent/LOW correct)
- Metrics: passing 1540→1543 (floor 1543); skipped 16
- Next: OPT-26

### Cycle 24 — 2026-06-14
- Commit: `2a49cbd` OPT-26: namespace retrieval feedback boost keys by tenant
- Item: OPT-26 — COMPLETED
- Mode B: residual folded into existing OPT-29 (non-tenant-token→DEFAULT also pollutes the shared feedback bucket; fail-closed closes both)
- Verifier: PASS (1547 passed, 0 failed, build exit 0; retrieval 142→146; default back-compat intact; RED-confirmed) | Security-reviewer: PASS (channel closed for named tenants; single key chokepoint; tenant server-resolved/not spoofable; default-bucket only reachable by the OPT-29 misconfig path)
- Metrics: passing 1543→1547 (floor 1547); skipped 16
- Next: OPT-27

### Cycle 25 — 2026-06-14
- Commit: `5f5b026` OPT-27: namespace context-cache keys by tenant (+block-invalidation path)
- Item: OPT-27 — COMPLETED (cache.ts + service.ts + block path)
- Mode B: 1 discovery → OPT-84 (LOW: consolidation invalidateByNodeId drops tenant → named-tenant stale read; background process, no request tenant context)
- Verifier: REJECT (new within-tenant test had a polluted setup — node-dep set retained a stale member from the prior scope-invalidation, faithful to real Redis; fixed test to use a distinct node id) → PASS 1552/0. Security-reviewer: PASS on diff but flagged the block-mutation path drops tenant (regression OPT-27 introduced) → extended the fix to thread tenant through CacheInvalidator/_invalidateContext/factory (+5 block tests) → gate PASS 1557/0.
- Metrics: passing 1547→1557 (floor 1557); skipped 16
- Next: OPT-28

### Cycle 26 — 2026-06-14
- Commit: `5dfd81d` OPT-28: set HTTP slowloris timeouts
- Item: OPT-28 — COMPLETED
- Mode B: 1 discovery → OPT-85 (LOW: connection-count/flood limiting — per-connection time bounded but not count)
- Verifier: PASS (1560 passed, 0 failed, build exit 0; mcp 140→143; RED-confirmed; SSE+shutdown intact) | Security-reviewer: PASS (slowloris 300s→30s; SSE not killed; clamp+env validation sound)
- Metrics: passing 1557→1560 (floor 1560); skipped 16
- Next: OPT-29

### Cycle 27 — 2026-06-14
- Commit: `fd8046d` OPT-29: fail-closed tenant binding for non-tenant tokens
- Item: OPT-29 — COMPLETED
- Change: in multiTenantMode, isAuthorized now 401s a token that authenticates (global MEMBERRY_API_TOKEN / per-actor MEMBERRY_API_TOKENS) but isn't a tenant token — closing the silent DEFAULT-tenant fallback flagged by the OPT-26/27 reviews. Refactored tenantFor→bearerToken+tenantForToken helpers (constant-time preserved); MEMBERRY_ALLOW_DEFAULT_TENANT=true restores the legacy fallback; flag wired through docker-compose + .env.example.
- Mode B: wired the new opt-in flag through compose + .env.example (adjacent config consistency, no new backlog). 2 review residuals filed → OPT-86 (actor-label quirk: one token both API+tenant → actor relabeled 'default'), OPT-87 (informational two-sweep timing).
- Verifier: PASS (1561 passed, 0 failed, build exit 0; mcp 143→144; commit fd8046d confirmed; diff confined, test purely additive) | Security-reviewer: PASS (isAuthorized sole chokepoint above every tenant path; no bypass; escape hatch grants no new exposure; fail-closed default; constant-time preserved; edge cases sound)
- Metrics: passing 1560→1561 (floor 1561); skipped 8 (verifier counted 8 pre-existing skips; informational, no regression)
- Next: OPT-30

### Cycle 28 — 2026-06-14
- Commit: `760254c` OPT-30 (+OPT-38): validate token-pair parsing; warn on skipped/empty/zero-pair entries
- Item: OPT-30 — COMPLETED (also closes OPT-38 — the silent-drop / silent-multi-tenant-disable path)
- Change: extracted exported parseTokenPairs(raw,varName,onValid) replacing the two inline MEMBERRY_API_TOKENS / MEMBERRY_TENANT_TOKENS split loops. Validates token length [4..4096], logs a console.error warning for every malformed/empty/out-of-range entry AND for a non-empty var that yields zero valid pairs. Accept path for well-formed pairs is byte-identical (split on ',', first ':', trim, non-empty); tenant→actor seeding preserved. Never logs a token value (only entry index + non-secret name). Documented the unescapable ','/' :' constraint in .env.example.
- Mode B: folded OPT-38 in (same parse path). 2 review residuals filed → OPT-88 (doc over-strict: token may contain ':' after the first), OPT-89 (explicit "multi-tenant NOT enabled" log when TENANT_TOKENS set but no valid pairs).
- Verifier: PASS (1571 passed, 0 failed, build exit 0; mcp 144→154; +10 new unit tests; diff confined+additive; no token logged) | Security-reviewer: PASS (no secret leakage on any log path; behavior-equivalent for valid pairs; fail-open is partial-config-safe + loudly warned; MIN=4 clears the 7-char tok-bob; MAX=4096 fits JWTs)
- Metrics: passing 1561→1571 (floor 1571); skipped 8
- Next: OPT-31

### Cycle 29 — 2026-06-14
- Commit: `a941912` OPT-31: gate extraction-driven fact invalidation by confidence
- Item: OPT-31 — COMPLETED (predicate-shape half was OPT-04/c4; c29 adds the invalidation gate)
- Change: in consolidation._extractAndStoreFacts, the different-object contradiction branch no longer always invalidates the existing active fact. An ESTABLISHED fact (confidence >= MEMBERRY_FACT_PROTECT_CONFIDENCE, default 0.75, clamped [0,1]) is auto-invalidated only by a contender at least as confident; otherwise the contender is created `tentative` (supersedes link kept) and the established fact is LEFT ACTIVE for corroboration/review. Auto-invalidate path is byte-identical when the gate allows it. Held-branch log prints only the OPT-04-validated predicate (subject/object never logged). Documented the var in .env.example.
- Mode B: clean — 3 review residuals filed → OPT-90 (gate the sibling _disputeRelatedFacts path), OPT-91 (clamp extraction-origin contender confidence; converges with OPT-70), OPT-92 (consolidation findBySubjectPredicate not tenant-scoped).
- Verifier: PASS (1576 passed, 0 failed, build exit 0; core 348; +5 tests; auto path unchanged, only the held branch is new) | Security-reviewer: PASS (threat closed — extractFacts emits no per-fact confidence so contender pins 0.5, inflation bypass unreachable; held tentative+inductive fact cannot auto-activate: corroborate is abductive-only and findBySubjectPredicate is active-status-only; threshold robust; log-safe)
- Metrics: passing 1571→1576 (floor 1576); skipped 8
- Next: OPT-32

### Cycle 30 — 2026-06-14
- Commit: `d023c6a` OPT-32: per-item evidence cap for berry_ask synthesis
- Item: OPT-32 — COMPLETED
- Change: berry_ask now caps each retrieved evidence item to MEMBERRY_ASK_MAX_EVIDENCE_ITEM_CHARS (default 4000) before concatenating into the synthesis prompt, so one oversized memory can't dominate or crowd out the rest. Cap is applied in formatEvidenceItem AFTER the OPT-10 fence-strip (anti-forgery preserved); over-cap items get a visible `…[truncated N chars]` marker. Within-cap output is byte-identical to before. Exported the cap helpers for direct unit testing.
- Mode B: clean sweep — no new findings.
- Verifier: PASS (1586 passed, 0 failed, build exit 0; retrieval 146→156; +9 unit +1 ask() integration; within-cap byte-identical; fence-strip-before-cap confirmed; new required param has only the two updated callers) — perf/hardening item, not security-tagged, so verifier-only per the rules.
- Metrics: passing 1576→1586 (floor 1586); skipped 8
- Next: OPT-33

### Cycle 31 — 2026-06-14
- Commit: `607f1ae` OPT-33 broaden secret redaction + OPT-34 dedupe graph redactor to core (closed together — coupled)
- Items: OPT-33 + OPT-34 — both COMPLETED
- Change: (OPT-33) core/redact.ts gained Stripe (sk_/rk_ live/test) + Bearer-token patterns; the quoted-value capture now spans `\"` escapes so a value with an embedded escaped quote (and the adjacent key) is no longer leaked; keyword list broadened (pwd/passphrase/private_key/secret_key/credential(s)/aws_secret_access_key/aws_session_token); Authorization:Bearer handled by a dedicated matcher. (OPT-34) graph/allowlist.ts deleted its drifted duplicate patterns and now imports+re-exports redactSecrets/redactValue from @memberry/core — the export path inherits every core pattern (incl github_pat_ which was leaking at export), so the drift is permanently gone (single source of truth, no dep cycle).
- Mode B: closed the coupled pair in one cycle (OPT-34's dedup is the mechanism that makes OPT-33's coverage reach the export path). 2 review residuals filed → OPT-93 (high-entropy/standalone-AWS deferred — accepted limitation to document), OPT-94 (minor over-redaction of one word after a credential keyword — availability, errs safe). Generic high-entropy intentionally NOT implemented (FP risk).
- Verifier: PASS (1592 passed, 0 failed, build exit 0; core 348→353, graph 53→54; all existing redact regressions held — prose/JSON-sibling/conn-string; dedup wired, barrel+snapshot.ts resolve, no cycle) | Security-reviewer: PASS (escaped-quote fix correct, ReDoS-safe 1.6-2.8ms on pathological inputs, Bearer leak-free across tab/multispace/lowercase/newline, old graph copy was a strict subset of core)
- Metrics: passing 1586→1592 (floor 1592); skipped 8
- Next: OPT-35

### Cycle 32 — 2026-06-14
- Commit: `5a46f84` OPT-35: size guard for CodeIndexer parseFile
- Item: OPT-35 — COMPLETED
- Change: parseFile now stat-and-skips files larger than MEMBERRY_MAX_PARSE_FILE_BYTES (default 2 MiB) before reading them into memory, returning an empty ParsedFile (graceful skip, not throw) — so a multi-MB generated/minified/mislabeled-binary file can't blow up tree-sitter parse time/memory. Mirrors the structural-search 2 MB cap. A stat failure falls through to readFile so the original error is preserved; the guard covers both the tree-sitter and extractor (SQL/HCL/MCP) paths.
- Mode B: clean sweep — no new findings.
- Verifier: PASS (1595 passed, 0 failed, build exit 0; code 117→120; +3 tests; 7 existing parser tests unaffected; guard before readFile, empty shape matches interface, indexer consumes arrays via length/for-of/map → safe on empties) — hardening item, not security-tagged, verifier-only.
- Metrics: passing 1592→1595 (floor 1595); skipped 8
- Next: OPT-36

### Cycle 33 — 2026-06-14
- Commit: `929f202` OPT-36: bound berry_store signals[] schema
- Item: OPT-36 — COMPLETED
- Change: AmpStoreSchema.signals[] gained target_id .max(500), detail .max(2000), and .max(50) on the array — every other string field was already bounded; signals were the gap, so a single store could attach an unbounded signal payload. Exported AmpStoreSchema so the bounds are unit-testable via Zod. Enforced at the MCP boundary (server.tool compiles the shape and validates before the handler).
- Mode B: clean — 2 review residuals filed → OPT-95 (same array-length-cap gap on entities[]/tags[]/bootstrap arrays), OPT-96 (SignalStream.publish belt-and-braces length assert at the Redis layer).
- Verifier: PASS (1601 passed, 0 failed, build exit 0; mcp 154→160; +6 tests; diff = 3 .max() + export, existing signals test unaffected) | Security-reviewer: PASS (all 3 vectors capped; ~125KB/store worst case under OPT-08's 1MB body cap; ALSO closes the per-entry SIZE surface of the amp:signals Redis stream that OPT-14 bounded by count only — ~25MB ceiling; enforced at MCP boundary; export purely additive)
- Metrics: passing 1595→1601 (floor 1601); skipped 8
- Next: OPT-37

### Cycle 34 — 2026-06-14
- Commit: `25f5b90` OPT-37: shape-validate MEMBERRY_TENANT_DATASTORES (fail-closed)
- Item: OPT-37 — COMPLETED
- Change: extracted an exported pure parseTenantDatastores(raw) that JSON.parses then Zod-validates the tenant→datastore map. Required neo4jUri/neo4jPassword/redisUrl (non-empty); .strict() rejects typo'd keys; an explicit non-object/array/null guard catches the old char-iteration footgun (a JSON string was iterated char-by-char, mapping bogus tenants onto localhost). Any malformed input now THROWS at startup instead of silently colocating a tenant on the shared localhost store. Unset/empty → {}. Error messages name the key path only (zod branch).
- Mode B: clean — 2 review residuals filed → OPT-97 (invalid-JSON branch interpolates JSON.parse's message which can echo a partial secret to startup logs — drop it + fix docstring), OPT-98 (validates non-empty string but not URL scheme — a typo'd-but-non-empty URI passes).
- Verifier: PASS (1609 passed, 0 failed, build exit 0; mcp 160→168; +8 tests; valid-input loop body byte-identical; bootstrap.regression unaffected) | Security-reviewer: PASS (silent-colocation hole closed on the ONLY consumer path, no bypass; valid/unset unaffected; .strict catches typos that would have dropped to localhost). Found the OPT-97 invalid-JSON log-echo residual.
- Metrics: passing 1601→1609 (floor 1609); skipped 8
- Next: OPT-39 (OPT-38 already covered by OPT-30)

### Cycle 35 — 2026-06-14
- Commit: `dfaad0e` OPT-39: bound AmpTimelineSchema.limit to a positive int
- Item: OPT-39 — COMPLETED
- Change: AmpTimelineSchema.limit gained .positive() (was .int().max(100) only — limit:0 fell through the handler's truthy check to "return all", and a negative limit did tl.facts.slice(0,-n) silently dropping the LAST n facts). Hardened the handler to slice only for a positive number (defense-in-depth for direct callers). Exported AmpTimelineSchema for Zod bound testing.
- Mode B: clean — 2 review residuals filed → OPT-99 (timeline() upstream Cypher has NO LIMIT, so the unlimited path returns all facts uncapped — large-response vector), OPT-100 (AmpFactDiffSchema.from/to unvalidated z.string()). Also caught a PROCESS bug (gate-cmd tee ran locally not on cerebro) — fix recorded in decisions.md.
- Verifier: PASS (1615 passed, 0 failed, build exit 0; mcp 168→174; +6 tests; valid positive limit unchanged, only 0/negative behavior fixed) | Security-reviewer: PASS (boundary rejects 0/neg/frac/over-cap; NaN/Infinity can't pass .int() and are harmless on a direct call; now consistent with AmpQuerySchema convention; export additive; tenant isolation intact)
- Metrics: passing 1609→1615 (floor 1615); skipped 8
- Next: OPT-40

### Cycle 36 — 2026-06-14
- Commit: `9d8f098` OPT-40: bound research secondary_metrics + temporal timestamp schemas
- Item: OPT-40 — COMPLETED (closes the input-validation cluster OPT-36/37/39/40)
- Change: (research) ResearchLogSchema.secondary_metrics z.record(z.number()) → z.record(z.string().min(1).max(100), z.number().finite()).refine(≤50 entries) — bounds key length + count + rejects NaN/Infinity (which JSON.stringify had silently turned to null at the store layer). (mcp) AmpLoadSchema.temporal.{as_of,from,to} unbounded z.string() → .max(40); deliberately NOT .datetime() since the documented contract accepts date-only ("2025-06-01") AND full ISO. Exported both schemas for direct Zod testing.
- Mode B: corrected gate command (tee inside ssh quotes) — clean remote count this cycle. Review residuals map to existing items: enriched OPT-100 (fact_diff from/to is the exact unbounded-length parity gap, apply .max(40)) and OPT-95 (added AmpResolveSchema). No new IDs.
- Verifier: PASS (1625 passed, 0 failed, build exit 0; research 138→144, mcp 174→178; +10 tests; 2-arg z.record compiles; store-layer secondary_metrics tests unaffected) | Security-reviewer: PASS (all 3 secondary_metrics sub-vectors bounded; temporal .max(40) closes DoS with NO Cypher injection — values are bound $params, never interpolated; .finite() converts silent NaN→null corruption into an explicit error)
- Metrics: passing 1615→1625 (floor 1625); skipped 8
- Next: OPT-41 (perf/N+1 cluster begins)

### Cycle 37 — 2026-06-14
- Commit: `640d572` OPT-41: batch load() fact fetch into one round-trip
- Item: OPT-41 — COMPLETED (first of the perf/N+1 cluster)
- Change: added FactStore.getActiveBatch — resolves each entity name per-entity (unchanged precedence) then fetches ALL resolved entities' active facts in ONE Cypher round-trip (UNWIND distinct ids → per-id OPTIONAL MATCH + ordered collect inside CALL{}), returning FactNode[][] in input order, each byte-identical to getActive(name) (same per-mode filter, same ORDER BY valid_at, same tenant clause, same mapFactNode). load() prefers getActiveBatch when present (FactLayer.getActiveBatch? optional → existing mocks fall back to the per-entity fan-out). Collapses the load fact path from O(2N) to O(N resolves + 1 fetch). The dedup+rank loop is untouched, and rankFacts' stable sort preserves the (unchanged) deduped order → output-identical.
- Mode B: clean — 1 residual filed → OPT-101 (batch the per-entity resolve too; pairs with OPT-80's indexed name_lower migration which needs approval).
- Verifier: PASS (1629 passed, 0 failed, build exit 0; neo4j 200→202, core 353→355; +4 tests). OUTPUT-IDENTITY proven by a LIVE-Neo4j integration test (confirmed not skipped, 3 ways) asserting getActiveBatch(names) deep-equals [getActive(name),...] across current/historical/evolution + empty + duplicate + unknown-entity. Perf bar met: green AND output-identical.
- Metrics: passing 1625→1629 (floor 1629); skipped 8
- Next: OPT-42

### Cycle 38 — 2026-06-14
- Commit: `782a0a5` OPT-42: batch staleness-decay writes into one UNWIND SET
- Item: OPT-42 — COMPLETED
- Change: the store() staleness pass now accumulates every {id, decayed-confidence} across all mentioned entities and writes them in ONE FactStore.updateConfidenceBatch (UNWIND SET) instead of one updateConfidence per stale fact (N+1). Decay formula (max(0.1,conf*0.9)), the ≥2-facts coverage gate, the predicate-mention check, and changedFactScopes tracking are all unchanged — only the write is batched, so end-state confidences are identical (all decayed rows share one updated_at). FactLayer.updateConfidenceBatch? is optional → per-fact fallback for layers/mocks without it.
- Mode B: clean — noted the per-entity getActive READS in this same loop are still N (separate from the WRITE batch this item targets); minor, not filed.
- Verifier: PASS (1633 passed, 0 failed, build exit 0; neo4j 202→204, core 355→357; +4 tests). SAME-END-STATE proven: live-Neo4j integration test asserts updateConfidenceBatch persists the new confidences; wiring test asserts exact 0.5→0.45 decay, mentioned-predicate fact NOT decayed, batch preferred over per-fact.
- Metrics: passing 1629→1633 (floor 1633); skipped 8
- Next: OPT-43

### Cycle 39 — 2026-06-14
- Commit: `7691296` OPT-43: batch SOURCED_FROM edge MERGEs in FactStore.create
- Item: OPT-43 — COMPLETED
- Change: replaced the per-episode `for` loop (one MERGE round-trip per source episode, inside the create tx) with a single UNWIND $episodeIds MATCH+MERGE. Graph-identical — each id still requires the Episodic to exist (missing → no row → no edge, exactly as the loop skipped it); runs in the SAME create tx (atomic with CREATE/FACT_ABOUT/embedding/SUPERSEDES); non-empty guard mirrors the loop's zero-iteration case.
- Mode B: clean sweep — no new findings.
- Verifier: PASS (1634 passed, 0 failed, build exit 0; neo4j 204→205; +1 live-Neo4j integration test asserting exactly the 2 existing episodes are linked + the missing id skipped). Graph-identical proven.
- Metrics: passing 1633→1634 (floor 1634); skipped 8
- Next: OPT-44
