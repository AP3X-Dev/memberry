---
id: 9K82QD5obU4ngMdVrQRwc
session_id: session-20260613-231500
agent_id: default
task: Build S2 linear & graph orchestrators for @ap3x/swarms
created_at: "2026-06-14T06:21:49.751Z"
---

Implemented design unit S2 (linear & graph orchestrators) in packages/swarms/src/structs/. Files: agent-rearrange.ts (flow-DSL engine, the core all linear workflows build on), sequential-workflow.ts (facade over AgentRearrange), concurrent-workflow.ts, swarm-rearrange.ts, round-robin.ts, batched-grid-workflow.ts, graph-workflow.ts (hand-rolled DiGraph DAG engine). All exported from src/index.ts.

Key decisions: orchestrators accept AgentBackend[] (never a concrete runtime); per-instance ids in constructors; all returns funnel through historyOutputFormatter; typed AgentRunError on all error paths.

[BUG-TO-FIX] fixes applied: (1) AgentRearrange.removeAgent removes by NAME via filter (upstream indexed a list by name); (2) SequentialWorkflow drift loop capped at MAX_DRIFT_RERUNS=5; (3) ConcurrentWorkflow maxLoops now loops the fan-out N times accumulating into transcript (was a no-op); (4) SwarmRearrange.run THROWS typed AgentRunError (upstream returned String(e)); swarmArrange uses NAMED options object; H human node uses injected async callback (no stdin); (5) GraphWorkflow checkpoint key = crypto sha256(task).slice(0,16) hex; cycle-tolerant topo generations (trailing cycle layer, Tarjan SCC for simpleCycles); deterministic toSpec; multi-loop normalized to {loops, final}.

Test harness pattern: each faux agent gets its OWN registerFauxProvider with setResponses(array of 32 factories returning name-tagged replies) so concurrent fan-out never shares a queue. 52 new tests in test/structs.test.ts.

Results: npm run check exit 0 (biome + tsc strict); npm test 350 passed (298 prior + 52 new); contamination-scan exit 0; npm run build -w @ap3x/swarms exit 0. Flipped 7 S2 rows to [x] in COVERAGE.md Phase D.