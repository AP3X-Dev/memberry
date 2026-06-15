---
id: 6WcNbuSRgXET-uxCuEUqt
session_id: session-20260614-014700
agent_id: default
task: D8: unified SwarmRouter factory + parity smoke test for @ap3x/swarms
outcome: approved
created_at: "2026-06-14T08:58:22.216Z"
---

Completed D8 (final unit of Phase D, @ap3x/swarms). Created packages/swarms/src/structs/swarm-router.ts (SwarmRouter class) + packages/swarms/test/integration-d8.test.ts (parity gate). Exported from index.ts.

Key design decisions:
- Factory dispatch is a single `switch(type)` over ConcreteSwarmType (= Exclude<SwarmType,"auto">) with a `never`-exhaustiveness default, PLUS a parallel `SWARM_FACTORY_KEYS` table typed `as const satisfies Record<ConcreteSwarmType, true>`. This closes the validate/factory drift BUG-TO-FIX: dropping/adding a type fails to COMPILE (verified by temporarily deleting the RoundRobin key → TS1360). SWARM_TYPES is imported from auto-swarm-builder.ts, never redefined.
- "auto" resolution: when bossFactory supplied, delegate to AutoSwarmBuilder (generateRouterConfig:true) to pick a concrete swarmType; coerce "auto"/unknown back to fallback. Without bossFactory, deterministically resolves to SequentialWorkflow (documented rule; AutoSwarmBuilder needs an LLM boss).
- RoundRobin maps to exported class RoundRobinSwarm (struct round-robin.ts).
- BatchedGridWorkflow is the ONE struct whose run takes string[] (one task per agent), not a single string — router special-cases it via a BuiltSwarm = RunnableSwarm | BatchedGridWorkflow union and fans the single task across the agent pool. Returns list-of-lists.
- Router default outputType changed to "dict" (NOT dict-all-except-first): dict-all-except-first does slice(2), so a 2-message run like a single MultiAgentRouter handoff yields []. "dict" never drops leading messages.
- Helper-agent factories (bossFactory/aggregatorFactory/consensusFactory/directorFactory/judgeFactory/chairmanFactory/memberFactory/debateFactory/heavyFactory/plannerFactory) keep router free of model literals. HelperAgentFactory = (systemPrompt, role?) => AgentBackend.
- GroupChat requires >=2 agents advertising supports("forcedTool") — native Agent provides it; faux test uses fauxScript with a respond() JSON {score,message}.

Parity smoke test drives `for (const t of SWARM_TYPES) it(t, ...)` and asserts SWARM_TYPES.length===17 and factoryKeys===concrete types. 18 tests (17 types + 1 coverage assertion).

Gates ALL pass: npm run check=0, npm test=0 (540 tests: pre-existing 522 + 18 new), contamination-scan=0 (92 terms), npm run build (swarms + all)=0. No export-name prefixing needed. Updated clean-room/COVERAGE.md S8 row to [x].