---
id: 1TzApR78py7ywK8G02I4D
session_id: session-20260614-003200
agent_id: default
task: Build @ap3x/swarms specialized swarms & builders (S5)
outcome: approved
created_at: "2026-06-14T07:34:17.907Z"
---

Implemented design unit S5 (specialized swarms & builders) in packages/swarms. Created 14 new files under src/structs: heavy-swarm, aop, auto-swarm-builder, spreadsheet-swarm, tree-swarm, cron-job, image-batch, planner-generator-evaluator, planner-worker-swarm, skill-orchestra, alt-swarms, autonomous-loop, subagent-registry, csv-agent-loader, dynamic-skills-loader. All exported from src/index.ts (alt-swarm names that collide with ./structs/topology prefixed alt*).

Key conventions confirmed for AP3X swarms structs: every orchestrator accepts AgentBackend[]; per-instance ids via uuidv7() in constructor (never import-time); typed AgentError subclasses; results funnel through historyOutputFormatter(conversation, outputType); structured LLM output via parseStructured<T> from ./structs/_shared with hand-rolled StructuredSchema validators (repo ships no zod); helper agents (director/judge/planner) built by caller-supplied factories so no hardcoded model literals; faux-backed Agent in tests via registerFauxProvider (each call gets a unique api so multiple coexist).

[BUG-TO-FIX] resolutions: (1) AOP queue named AopTaskQueue, planner queue named PlannerTaskQueue (distinct classes, verified by instanceof test). (2) AutoSwarmBuilder fully implemented; SWARM_TYPES is the single source of truth shared by SwarmRouterConfig validator and (future) factory keys; unknown swarmType coerced to 'auto' so configs are always constructible. (3) SpreadSheetSwarm per-instance default save path AND per-run fresh run id (no module-global uuid_hex captured at import). (4) PGE strict mode: default faithful (unscoreable eval → PASS), strict:true throws EvaluationParseError. (5) autonomous-loop bash guard reuses agent-core matchBlocklist + NodeExecutionEnv (cross-platform free).

NEW BUG FOUND+FIXED (class-of-error): uuidv7() leading hex is the millisecond timestamp, so `.slice(0,10)` of the front COLLIDES for ids minted in the same ms. PlannerTask newTaskId used slice(0,10) → two tasks got identical ids, Map deduped them, self-dependency deadlock hung the WorkerPool. Fixed to slice(-10) (random tail). Anywhere needing a short unique id from uuidv7 must use the random tail or agent-core shortId(), never the front slice.

Autonomous wiring: Agent.run/runFormatted detect maxLoops==='auto' and delegate to runAutonomous() which drives runAutonomousLoop (plan→execute→summarize) via a single-shot adapter (inAutonomousLoop guard prevents recursion). agent.ts imports ./structs/autonomous-loop (no cycle).

Results: npm run check exit 0 (biome clean + tsc strict); npm test 456/456 pass (425 existing + 31 new in test/structs-s5.test.ts); contamination-scan exit 0 (92 terms, no pi leak); npm run build -w @ap3x/swarms exit 0. COVERAGE.md Phase D S5 rows flipped to [x].

DEFERRALS: HeavySwarm 15-named-specialist prompt/schema asset tables ([-], small default set provided). AOP full MCP/HTTP server transport ([-], behind injectable AopServerTransport with InProcessAopTransport default).