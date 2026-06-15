---
id: oFI1hTxMmtKWAOo_ttM-Y
session_id: session-20260613-225800
agent_id: default
task: Build @ap3x/swarms keystone: Agent class + concurrency primitives + ma_utils + concat + prompt library
outcome: approved
created_at: "2026-06-14T05:59:47.118Z"
---

Implemented Phase D keystone of @ap3x/swarms (branch build/ap3x-v1). Files: src/agent.ts (swarms Agent implementing AgentBackend over agent-core runAgentLoop/Conversation/historyOutputFormatter/SafeStateManager), src/multi-agent-exec.ts (runSingleAgent/runAgentsConcurrently[completion-order list, input-order dict]/runAgentsConcurrentlyAsync/batchedGridAgentExecution[input-order]/runAgentsWithDifferentTasks/batchAgentExecution[fixed 2-tuple]+BatchAgentExecutionError/getSwarmsInfo/getAgentsInfo; hand-rolled pLimit semaphore, no new dep), src/ma-utils.ts (aggregate/runAgent/findAgentByName[WeakMap cache fix]/createAgentMap/listAllAgents/setRandomModelsForAgents/talkToAgent), src/concat.ts (concatStrings + re-export historyOutputFormatter/OutputType), src/prompts/index.ts (versioned Prompt class + scaffolds), tsconfig.build.json (paths:{} so @ap3x/* resolve via dist).

KEY LEARNINGS:
1. agent-core AgentBackend.runStream? returns AgentEventStream (events + .result()), NOT AsyncIterable<string>. Implementing AgentBackend means runStream must return AgentEventStream via agentLoop(); put the swarms token-streaming on a separate streamTokens() method.
2. agent-core runAgentLoop counts EACH assistant turn as a loop; a tool cycle = toolUse turn + toolResult-continuation turn. With swarms maxLoops=1 + tools, must set runtime maxLoops = swarmsMaxLoops*2 so the tool cycle completes (otherwise final answer never produced). Loop still stops naturally when no tool calls.
3. ESM + verbatimModuleSyntax: no require(); import {availableParallelism, cpus} from "node:os".
4. faux provider: registerFauxProvider({models:[{id,contextWindow}]}); model carries random api so default streamSimple routes to it — no need to pass streamFn. setResponses/appendResponses queue scripted AssistantMessages. Error fallback: fauxAssistantMessage("",{stopReason:"error",errorMessage}).
5. Per-model context window: Conversation contextLength = model.contextWindow (drop hardcoded 16000). Per-instance id = `agent-${uuidv7()}`.
6. biome: single-line backtick strings flagged noUnusedTemplateLiteral — use double quotes. `cond && fn()` flagged useOptionalChain — use `fn?.() ?? false`. Run biome --write on BOTH src AND test dirs (package-scoped write covers test only if path includes test).

RESULTS: npm run check exit 0; npm test 298 passed (265 existing + 33 new); build exit 0; contamination-scan exit 0 (92 terms). COVERAGE Phase D flipped: Agent, Concurrency primitives, batchAgentExecution, Prompt class+library, configurable model defaults = [x]; ma_blocks/ma_utils = [~] (registry/loaders deferred). Deferred: maxLoops="auto" autonomous plan/execute loop (capped to 10 turns, no plan tooling), MCP execution (placeholder config only), long-tail domain personas, AgentRearrange/other orchestrators (other D-units).