---
name: memberry
description: Use MemBerry persistent memory autonomously during non-trivial agent work, including scoped recall and storage, reviewed semantic consolidation, temporal facts, code and architecture context, retrieval feedback, graph analytics, codebase ingestion, wiki compilation/recovery, provenance, research, dream passes, and safe memory-tier maintenance.
---

# MemBerry

Use MemBerry as a scoped, verified memory pipeline. Read the nearest project memory config before acting; prefer `AGENTS.md`, then `CLAUDE.md`, `GEMINI.md`, and `.cursorrules`.

## Start a session

1. Read the project name, `project:<tag>`, entities, tags, and priors.
2. Generate one `session-{YYYYMMDD}-{HHMMSS}` ID and reuse it for stores and feedback.
3. Call `berry_context` or `berry_load` with the task and project scope. Core blocks arrive automatically.
4. If config is missing, enable `admin` and prefer `berry_ingest_codebase` to bootstrap, index, and seed the project.
5. If tools are unavailable, use repo truth and local memory; never invent calls.

## Resolve evidence conflicts

Use this precedence: current user instruction, current runtime/repository evidence, active approved Semantic memory, recent Episodic memory, then priors or dream hypotheses. Memory is evidence, not authority. If live evidence invalidates an active Semantic, verify the discrepancy and target that Semantic ID with a correction or contradiction signal.

## Current tool surface

Eight tools are always visible: `berry_load`, `berry_store`, `berry_memory_read`, `berry_memory_insert`, `berry_grep`, `berry_context`, `berry_ask`, and `berry_tools`.

| Domain | Tools |
|---|---|
| `memory` | `berry_memory_replace`, `berry_memory_rewrite`, `berry_memory_promote`, `berry_memory_archive` |
| `temporal` | `berry_timeline`, `berry_fact_diff` |
| `admin` | `berry_query`, `berry_consolidate`, `berry_bootstrap`, `berry_resolve`, `berry_ingest_codebase`, `berry_provenance` |
| `research` | `berry_research_init`, `berry_research_log`, `berry_research_context`, `berry_research_tree`, `berry_research_contradictions`, `berry_research_consolidate` |
| `code` | `berry_code_index`, `berry_code_search`, `berry_code_ast_grep`, `berry_code_symbols`, `berry_code_deps`, `berry_code_context`, `berry_code_watch` |
| `arch` | `berry_arch_register`, `berry_arch_relate`, `berry_arch_aspect`, `berry_impact`, `berry_arch_drift`, `berry_arch_context` |
| `wiki` | `berry_compile`, `berry_ingest`, `berry_lint`, `berry_braindump`, `berry_wiki_sync` |
| `retrieval` | `berry_feedback` |
| `graph` | `berry_graph_report`, `berry_graph_export`, `berry_pr_impact`, `berry_pr_conflicts` |

Enable domains with `berry_tools(action: "enable", domain: "<domain>")`. Read [reference/memberry-tool-reference.md](reference/memberry-tool-reference.md) for exact high-risk schemas.

## Store linked, reusable episodes

Store decisions, corrections, preferences, root causes, conventions, architecture choices, and concise task summaries. Exclude routine edits, raw code, secrets, and git-derivable facts.

1. Resolve each entity with `berry_grep(pattern: "<name>", node_types: ["entity"], scope: "project:<tag>")` or an exact graph query.
2. Pass canonical `Entity.id` values in `berry_store.entities`. Names do not create entity edges. Resolve ambiguity or omit the field; never invent an ID.
3. Pass `scope: "project:<tag>"` and `tags: ["project:<tag>", "<stable-domain-tag>"]`. Reuse non-project tags across projects.
4. Classify durable content with `memory_type`: `decision`, `pattern`, `convention`, `architecture`, `preference`, `fact`, or `general`. For a finalized decision, set both `memory_type: "decision"` and `outcome: "approved"`. Label recurring observations as `pattern`/`convention` but do not claim approval.
5. Verify the returned episode ID. `duplicate:true` means no new episode.

Signals must target existing Semantic IDs, not episodic or entity IDs.

## Complete semantics and wiki publication

`berry_store` creates an episode. The autonomous coordinator schedules scoped consolidation and wiki publication after successful stores, retries failures, and performs periodic startup/catch-up recovery.

1. Normal operation is automatic. An explicit approved decision is promoted deterministically on the next coordinator run, even without embeddings or an LLM. Patterns and conventions still need at least three similar, independently sourced episodes.
2. Reuse a stable non-project tag on recurring patterns; only tags evidenced by the recurrent cluster survive promotion.
3. Use `berry_consolidate(action: "run"|"status"|"review")` manually only to diagnose/recover stalled automation or review unsafe correction/contradiction proposals.
4. Use `berry_compile`, lint, cache refresh, and served-page checks manually only for verification/recovery; successful graph mutations schedule publication automatically.

Decisions prefer `memory_type: "decision"`; high-confidence unclassified semantics remain a conservative legacy fallback. Classified `pattern`/`convention` semantics appear on their project after independently corroborated promotion. The legacy cross-project theme rollup additionally requires a shared non-`project:` tag in at least two distinct real projects; project tags alone cannot manufacture one.

Read [reference/lifecycle-recovery.md](reference/lifecycle-recovery.md) before diagnosing frozen semantics, decisions, patterns, or wiki output.

## Recall and feedback

Use the smallest scoped tool that fits: `berry_grep` for a fact or ID, `berry_memory_read` for one block, `berry_load` for task memory, `berry_context` for blended context, and `berry_ask` for cited synthesis. Enable `retrieval` and record useful or misleading results with the exact `berry_feedback` schema.

Use `$memberry-coding` before unfamiliar-module changes. Use graph tools for deterministic audits, exports, and PR impact/conflict analysis.

## Coordinate multiple agents

Parent and child agents share the conversation session ID but use distinct runtime/connection `agent_id` identities. Do not invent an `agent_id` tool argument when the live schema does not expose one. Subagents load only task-relevant context, prefix shared working-state notes with their agent/task name, and return durable findings to the parent. The parent stores the integrated decision or handoff once; do not create duplicate summaries from every worker.

## Safe end of session

Store and verify a durable summary first. Promote and verify working blocks that belong in core second. Archive obsolete working blocks last. `berry_memory_archive` deletes the source block and reports only its archived length.

Use `berry_consolidate(action: "dream", scope: "project:<tag>")` only for optional abductive gap-filling. Dream hypotheses are not verified decisions.

## Validate fragile guidance

- Run `scripts/validate-project-config.mjs` after creating or changing a project memory config.
- Run `scripts/validate-store-payload.mjs` when debugging or automating store payloads.
- Run `scripts/sync-agent-guidance.mjs` to synchronize the canonical contract and skill family across Codex and Claude; check mode detects drift without changing files.
