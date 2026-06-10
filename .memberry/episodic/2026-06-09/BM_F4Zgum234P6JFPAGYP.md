---
id: BM_F4Zgum234P6JFPAGYP
session_id: session-20260609-rebuild-assessment
agent_id: default
task: [project:amp] Rebuild discussion continued — user raised agent-agnosticism as a hard constraint
created_at: "2026-06-09T18:34:07.949Z"
---

[project:amp] User constraint stated: MemBerry must stay usable and agent-agnostic — automatic capture cannot be designed only for Claude Code. Proposed answer: a tiered capture contract with per-agent adapters. Tier A = native harness sources (hooks/transcript files) where they exist; Tier B = agent-agnostic wrappers (PTY wrapper `memberry run <agent>` or an LLM API proxy that captures any agent's traffic at the API layer); Tier C = universal floor = MCP-driven berry_store, which works in any MCP-capable agent with zero setup. Core stays agnostic via a normalized transcript schema; adapters are thin. Episodes should record which capture tier produced them (provenance/coverage awareness). MCP remains the universal interface; the rebuild only stops making model volition the sole capture path.