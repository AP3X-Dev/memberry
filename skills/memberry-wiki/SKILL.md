---
name: memberry-wiki
description: Use for MemBerry wiki compilation, source ingestion, graph linting, brain dumps, editable wiki round-trips, served-viewer refresh, atomic publication health, or diagnosis of missing decisions, patterns, semantics, recent changes, and stale wiki pages.
---

# MemBerry wiki

Enable `wiki` and use its five tools deliberately: `berry_compile`, `berry_ingest`, `berry_lint`, `berry_braindump`, and `berry_wiki_sync`.

## Normal path

Graph mutations schedule a debounced full publication automatically. Verify `/readyz` publication state and served content; do not add routine manual compile steps.

- Use `berry_ingest` for confined source documents and verify created Source/Semantic IDs.
- Use `berry_braindump` for human-authored context; prefer `compile: false` because integrated publication follows graph mutation.
- Use `berry_wiki_sync` to reconcile anchored edits into corrections/new memory; verify the mutation and automatic publication.
- Use `berry_lint` for project graph quality.
- Use `berry_compile(project_tag: "all")` only for explicit verification or recovery. Scoped output is not the served cross-project generation.

## Verify graph to viewer

1. Query expected Semantic IDs, `memory_type`, provenance, project scope, and active entity links.
2. Confirm `/readyz` is healthy and dirty/published versions converge.
3. Fetch the portal, project page, `_recent`, `_decisions`, and `_patterns`; confirm expected text or IDs, not only HTTP 200.
4. If publication is stale/exhausted, correct the dependency/env/mount, let durable retry recover, then use a full compile and cache refresh only if necessary.

Decisions require applied classified semantics, with conservative legacy fallback. Project patterns/conventions render after independently corroborated promotion. Only the legacy cross-project theme rollup requires a shared non-project tag across two real projects. Recent episodes alone do not prove semantic promotion.

Atomic generations keep the previous complete wiki live during compilation. Treat recurring watcher, pointer, lock, generation, or publication-counter errors as lifecycle faults rather than papering them over with repeated compiles.
