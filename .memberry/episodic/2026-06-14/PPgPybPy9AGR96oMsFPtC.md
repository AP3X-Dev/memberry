---
id: PPgPybPy9AGR96oMsFPtC
session_id: session-20260613-S3
agent_id: default
task: Build @ap3x/swarms S3 orchestrators (hierarchical/router/voting/MoA)
created_at: "2026-06-14T06:27:17.642Z"
---

Starting S3 build for @ap3x/swarms. Conventions confirmed: no zod in repo (hand-roll validation like concat.ts/graph-workflow). AgentBackend.run returns AgentRunResult (coerce via finalText -> resultToString helper, present in agent-rearrange.ts/round-robin.ts). AgentError hierarchy from @ap3x/agent-core (AgentRunError/AgentInitializationError etc). Conversation + historyOutputFormatter + OutputType from @ap3x/agent-core. uuidv7 from agent-core. Faux provider: registerFauxProvider().setResponses([factories]), getModel(), unregister(). Tests register one faux provider per agent. contamination fingerprint is about 'pi' tokens, NOT swarms. No hardcoded model literals (gpt/claude/gemini) - make defaults configurable. Backend name resolved via name??agentName. Files to build in src/structs/: hierarchical-swarm, hierarchical-structured-communication, hybrid-hierarchical-cluster, multi-agent-router, model-router, agent-router, majority-voting, mixture-of-agents, self-moa-seq, topology. Append to index.ts. Do NOT build SwarmRouter.