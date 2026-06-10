---
id: 6-d6I-xu4XeYdF4nW0yWJ
session_id: session-20260609-rebuild-assessment
agent_id: default
task: [project:amp] Rebuild discussion — user raised distributed deployment constraint (server on Cerebro, agents on other machines)
created_at: "2026-06-09T18:36:29.628Z"
---

[project:amp] User constraint stated: MemBerry runs centrally on the Cerebro home server while agents often run on other machines (e.g. user's local laptop), so capture and recall cannot assume same-host filesystem access. Proposed architecture: collector pattern (like OpenTelemetry) — MemBerry server on Cerebro owns storage, extraction LLM calls, consolidation, wiki; exposes one network API boundary (MCP over streamable HTTP + token auth, building on existing MEMBERRY_API_TOKENS). Each agent machine runs a thin local collector installed via something like `memberry connect <url> --token`: does Tier A/B capture locally (transcripts, hooks, wrappers), normalizes events, store-and-forwards to the server with a local queue for offline tolerance. Reads degrade gracefully via a small local cache of core blocks. Episodes stamped with machine + agent + capture tier. This replaces the current weaker pattern of per-machine full stacks pointing DB credentials at a remote Neo4j, and makes the storage engine an invisible server-side detail.