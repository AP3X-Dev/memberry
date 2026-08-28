# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Two-stage retrieval pipeline.** A query planner and a candidate channel replace
  the single-shot retrieval path and feed an optional reranker. All three are
  default-off and gated independently: `MEMBERRY_QUERY_PLANNER_V1=1`,
  `MEMBERRY_CANDIDATE_CHANNEL_V1=1`, and
  `MEMBERRY_RERANKER_V1=disabled|shadow|served` (shadow and served both require the
  first two, and refuse to start without them). Retrieval latency is bounded with
  pinned degradation behaviour, the collection-size probe is bounded and backs off
  on failure, and the assembler packs the token budget three ways and keeps the best.
- **Second-pass multi-hop expansion** over the memory channel, default-off behind
  `MEMBERRY_MULTIHOP_EXPANSION_V1=1`.
- **Retrieval explanation view.** A stable, redaction-aware contract describing why
  a row was returned, surfaced through the retrieval tool layer.
- **Admission control on `store()`.** A versioned admission contract routes every
  incoming memory into one of five tiers — discard, working, episodic,
  semantic-candidate, protected — from safe facts and feature signals, with a shadow
  evaluation mode, a durable feature producer, and calibrated semantic confidence
  with hardened promotion corroboration. Staged behind
  `MEMBERRY_ADMISSION_ROUTING_V1` and `MEMBERRY_ADMISSION_SHADOW_ENABLED`.
- **Memory lifecycle.** A per-scope pass with sidecar retention, decay proposals, and
  reversible archive — `memberry lifecycle [--scope project:x] [--dry-run]` and
  `memberry lifecycle unarchive --id <id>` — gated by `MEMBERRY_LIFECYCLE_V1=live`.
  Adds an anti-entropy pass that repairs graph orphans and reclaims stale stream
  consumers (`MEMBERRY_LIFECYCLE_ANTIENTROPY=live`), Hebbian usage-modulated decay
  driven by drained retrieval feedback (`MEMBERRY_LIFECYCLE_HEBBIAN`), a
  deterministic risk advisor that gates risky proposals, and a fair keyset cursor for
  scheduling promotion candidates. Ships with a systemd service and timer.
- **Background consolidation and wiki publication.** The MCP server now drives the
  Episodic→Semantic pass on its own timers (`MEMBERRY_CONSOLIDATION_ENABLED`, on by
  default, plus interval/debounce/retry knobs) instead of waiting for someone to call
  `berry_consolidate`, and can recompile the served wiki after graph changes
  (`MEMBERRY_WIKI_AUTOREFRESH`, off by default).
- **Code-search relevance.** Code rows are served through the live candidate-channel
  composition, and `berry_context` now returns an explicit `code_plane` status
  (`served`/`no-results`/`unsupported`/`failed`, with a reason) whenever code was
  requested, instead of silently returning memory-only results. Indexed symbols get a
  dense embedding at index time, with `scripts/backfill-symbol-embeddings.mjs` for
  existing graphs, plus three default-off ranking flags: kind-aware ranking that sinks
  trivial symbols and test paths (`MEMBERRY_KIND_RANK_V1`), project-scoped code search
  that ranks code ahead of memory rows (`MEMBERRY_CODE_SCOPE_V2`), and a wider
  candidate window with BM25F reranking (`MEMBERRY_CODE_RERANK_V1`).
- **Read-through embedding cache** in front of the embedding provider, so repeated
  queries no longer re-hit the embeddings API. Cache failures fall through to the raw
  provider rather than failing the request.
- **Capability model.** A declarative per-actor capability policy contract bound to
  the MCP runtime, so tool calls are authorised before they execute
  (`MEMBERRY_CAPABILITY_POLICIES_V1`), backed by a durable Neo4j evidence-authority
  ledger — capture, adjudication, clearance, revocation, and read — on the retrieval
  evidence-eligibility path.
- **Logical multi-tenancy.** Every tenant-scoped read is filtered and every write
  stamped with `tenant_id`; tenants map from `MEMBERRY_TENANT_TOKENS`, optionally onto
  dedicated datastores via `MEMBERRY_TENANT_DATASTORES`. New `memberry tenant
  stats|export|delete --tenant <name>` admin surface for offboarding, erasure, and
  per-tenant backup. Legacy rows without `tenant_id` stay visible to the default
  tenant, so enabling this needs no data migration.
- **Setup and diagnostics CLI.** `memberry setup`, `memberry configure <claude|codex>`,
  `memberry project setup <path>`, and `memberry doctor`, plus install guides for
  local Docker, a remote server, and systemd.
- **Real-query retrieval evaluation.** A mined, hand-selected question set with a
  frozen selection rule, a published baseline, and a held-out opens list, runnable
  against a live MCP server (`bench/eval/`).
- Versioned evaluation lab with immutable baseline manifests, hidden dev/holdout
  oracles, anti-gaming metrics, explicit fixture/proxy/live evidence, deterministic
  comparison gates, and atomic run artifacts.
- Fail-closed external dataset registry and acquisition workflow with license,
  privacy, revision, size, and SHA-256 requirements.
- Opt-in live MCP evaluation adapter and disposable Redis/Neo4j integration smoke.

### Changed

- **Relicensed from BUSL-1.1 to MIT.** A `LICENSE` file was added and the root plus
  every workspace manifest now declares `"license": "MIT"`.
- **Canonical `amp` names renamed to `memberry`, with legacy fallbacks.** The default
  memory-export directory is now `./.memberry` (falling back to `./.amp` when only
  that exists), and settings resolve from `~/.config/memberry/settings.json` (falling
  back to `~/.config/amp/settings.json`). `AMP_*` env vars still work but log a
  one-time deprecation warning, and `amp://` URIs are still accepted. New writes
  always go to the canonical name or path. See `guides/migration-from-amp.md`.
- The evaluation-lab deterministic gate replaced the standalone `npm run bench:quality`
  step in CI. The same quality control still runs, inside `npm run bench:lab:ci`.

### Fixed

- The startup vector-index coverage guard reported `Fact` as under-covered on every
  boot, so the server always logged `DEGRADED MODE` and the warning carried no
  signal. Nothing reads `fact_embedding`, so the guard now checks only the labels
  whose embeddings a retrieval channel actually queries — `Symbol`, `Semantic`,
  `Episodic`.

### Removed

- Superseded MemBench and hard-coded LongMemEval prototype runners. Their control
  bytes and metrics remain reproducible from the immutable baseline commit.

## [0.1.0] - 2026-06-07

First tagged release. MemBerry is a persistent, cross-session memory system for AI
agents: a Neo4j knowledge graph (episodic + semantic memory, temporal facts,
entities, code symbols, audit log) with a Redis cache/stream layer, exposed to
agents over the Model Context Protocol with progressive tool disclosure.

### Added

- **Durable fact-extraction queue.** `store()` enqueues extraction jobs to a Redis
  Stream; a long-lived consumer drains them with retry, dead-lettering, and
  crash recovery (XAUTOCLAIM). Admin surface via `memberry extraction status|replay`.
- **Schema migration runner.** Ordered, idempotent migrations tracked on a
  `SchemaVersion` node, plus vector-index dimension drift detection. The embedding
  dimension is configurable with `MEMBERRY_EMBEDDING_DIM`.
- **Safety & tenancy controls.** `MEMBERRY_READONLY` (reject all writes),
  `MEMBERRY_REDACT_ON_INGEST` (strip secrets before persistence), an append-only
  audit trail, and per-actor API tokens (`MEMBERRY_API_TOKENS`) compared in
  constant time.
- **Injectable service container.** The MCP tool layer takes an explicit
  `ServiceContainer`, enabling per-instance isolation (legacy global injection
  retained for compatibility).
- **Self-contained packaging.** Docker Compose provisions both Redis and Neo4j
  with env-driven passwords and managed volumes; multi-stage Dockerfile; one-command
  `npm run setup` and `npm run smoke`.
- **Memory-quality benchmark gate.** A deterministic, infra-free Recall/MRR/nDCG
  golden-set eval (`npm run bench:quality`) wired into CI.
- **Security documentation.** `SECURITY.md` and `THREAT-MODEL.md`.

### Changed

- **No-API-key mode degrades safely.** Without an embedding key, vector search is
  disabled and retrieval falls back to deterministic lexical + fulltext ranking,
  instead of querying the vector index with zero vectors (which returned results
  in arbitrary order).
- **Raw Cypher is read-enforced.** `berry_query` runs in a server-enforced READ
  transaction; the validator now NFKC-normalizes input and rejects stacked
  statements, on top of the existing read-only keyword checks.

### Fixed

- `berry_provenance` was silently disabled because the second bootstrap injection
  pass nulled the provenance service.
- `tsconfig.build.json` never compiled `packages/wiki`, and the Dockerfile omitted
  the `wiki`/`graph` workspace manifests — a from-build run could fail at import.

[0.1.0]: https://github.com/AP3X-Dev/memberry/releases/tag/v0.1.0
