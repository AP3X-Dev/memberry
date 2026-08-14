---
name: memberry-coding
description: Use MemBerry code, architecture, impact, drift, and durable-memory context during coding work. Trigger for unfamiliar modules, bug fixes, refactors, code review, implementation planning, dependency analysis, architecture changes, or resumptions where prior project decisions and known failure modes should inform the work.
---

# MemBerry coding

Ground coding decisions in current repository evidence and durable project context.

## Before editing

1. Read the nearest `## MemBerry Memory` config and reuse its project scope, stable tags, canonical IDs, and session ID.
2. Call scoped `berry_context` for the task. Use a small token budget for a localized fix and a larger budget only for cross-module design.
3. Before calling an on-demand tool, inspect its currently exposed schema and send the smallest valid argument object. Never infer parameters from a remembered example or the tool name.
4. Enable `code`; call `berry_code_context` for unfamiliar implementation areas. Use `berry_code_search`, `berry_code_symbols`, `berry_code_deps`, or `berry_code_ast_grep` for the narrow question.
5. Enable `arch` for cross-boundary work. Call `berry_arch_context`; use `berry_impact` before risky changes and `berry_arch_drift` when the recorded model may be stale.
6. Inspect actual files, signatures, tests, and runtime state. Repository/runtime evidence outranks recalled memory.

## During work

- Use recalled decisions as constraints only after they agree with current evidence.
- When a retrieved node materially helps or misleads, enable `retrieval` and record `berry_feedback` with its result ID, original query, session ID, and source type.
- If current evidence invalidates an active Semantic, verify it, then store a correction or contradiction signal targeting that Semantic ID. Never signal an episodic/entity ID or fabricate a target.
- For parallel work, share the parent session ID, use a distinct runtime/connection `agent_id`, load only task-relevant context, and prefix working-state notes with the agent/task name. Do not invent an `agent_id` argument when the live tool schema does not expose one.
- Keep routine code state in git and tests, not durable memory.

## Store only what survives the diff

Store a durable episode only for:

- a finalized decision and rationale;
- a user correction or preference;
- a reusable bug root cause or failed approach;
- a convention or recurring pattern observation;
- a lasting architecture boundary, interface, or operational constraint;
- a concise handoff with accomplished work, verification, and open items.

Choose the narrowest truthful classification:

- `decision` with `outcome: "approved"` for a finalized product or technical choice;
- `general` for one verified bug root cause, failed approach, or reusable troubleshooting lesson;
- `architecture` for a lasting boundary, interface, dependency, or operational constraint;
- `pattern` or `convention` only for recurring behavior supported by independent observations, with no outcome;
- `preference` for a durable user or team rule;
- `fact` for an externally verified proposition.

A single bug fix is not a pattern. Resolve canonical Entity IDs, include exact project scope and stable tags, validate the live tool schema, then verify the returned episode.

Use `../memberry/scripts/validate-store-payload.mjs` when constructing or debugging a store payload outside MCP.

## Finish

Run the repository's decisive verification. Store and verify one integrated handoff when durable knowledge changed. Let autonomous consolidation and wiki publication run normally; inspect readiness, provenance, and served content only when verification or recovery requires it.
