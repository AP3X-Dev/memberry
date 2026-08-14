---
name: memberry-setup
description: Use when bootstrapping, repairing, or updating MemBerry persistent memory for a code project, including project config, codebase ingestion, graph/entity setup, code indexing, memory blocks, retrieval checks, stable tag vocabulary, canonical entity mapping, and wiki readiness verification for Codex or Claude Code.
---

# MemBerry setup

Bootstrap through one-shot ingestion, then verify every downstream surface.

## Prepare

1. Read the nearest `AGENTS.md`, then `CLAUDE.md`, `GEMINI.md`, or `.cursorrules`; preserve unrelated instructions.
2. Scan manifests, README, source structure, and recent git history. Derive project identity, workload profile, major entities, stable tags, recall priorities, sensitive-data exclusions, and three to five low-confidence priors.
3. Generate one `session-{YYYYMMDD}-{HHMMSS}` ID.

## Write project config

Use this shape:

```markdown
## MemBerry Memory

Project: <name>
Description: <one line>
Domain: <domain>
Project Tag: project:<kebab-name>
Workload Profile: <coding|research|operations|mixed>

Entities:
- <human-readable entity>

Canonical Entity IDs:
- <project-name>: <resolved-id>

Stable Tags:
- <reusable non-project tag>

Recall Priorities:
- <approved decisions or active architecture>

Store Policy:
- Classify durable knowledge and verify every returned episode.

Data Exclusions:
- Secrets, credentials, raw customer data, routine diffs.

Priors:
- <low-confidence observation>
```

Keep names readable, but resolve and record at least the project Entity ID. Re-resolve ambiguous module names at store time. Use the stable tag vocabulary rather than inventing synonyms per session.

## Ingest and verify

1. Enable `admin`; prefer `berry_ingest_codebase` with a server-visible confined path. Use `berry_bootstrap` plus explicit code indexing only when one-shot ingestion is unavailable.
2. Query the project Entity, canonical IDs, containment, scoped episodes, and semantics. Enable `graph` and run `berry_graph_report`.
3. Enable `code`; verify a known symbol and non-zero project results.
4. Call scoped `berry_load` and `berry_context` for a known module or prior.
5. Store one linked setup summary using canonical IDs, project scope, stable tags, and `memory_type: "architecture"`; verify its episode and `REFERENCES` edge.
6. Verify `/readyz`, wait for automatic publication, and inspect the portal, project, recent, decisions, and patterns pages. Manual compile/lint/refresh is recovery-only.
7. Run `node skills/memberry/scripts/validate-project-config.mjs <instruction-file>` when the validator is available.

An empty Decisions or Patterns page can be correct. Approved decisions promote automatically; patterns/conventions require independently corroborated recurring evidence.

## Recovery

Fail closed on path confinement, scope/tenant ambiguity, missing entity identity, or unavailable MCP. Diagnose readiness and the first incomplete lifecycle stage before manual recovery; never fabricate successful setup.
