---
id: M1UmZw1hP1gk0LMWYYR4P
session_id: session-20260614-000400
agent_id: default
task: Build S4 GROUP-CHAT/DEBATE/COUNCIL/SOCIAL orchestrators of @ap3x/swarms
outcome: approved
created_at: "2026-06-14T07:04:30.927Z"
---

Implemented design unit S4 in packages/swarms/src/structs: groupchat.ts (GroupChat + RESPOND_TOOL/DECIDE_PROMPT/extractArgs), llm-council.ts, council-as-judge.ts (EVAL_DIMENSIONS + EvaluationError/DimensionEvaluationError/AggregationError), debate-with-judge.ts, one-on-one-debate.ts (oneOnOneDebate fn + OneOnOneDebate class), social-conversations.ts (10 classes), multi-agent-debates.ts (barrel re-exporting all 11), social-algorithms.ts, advisor-swarm.ts. 37 new tests in test/structs-s4.test.ts; total 425 pass.

Key decisions/patterns: (1) BackendCapability union in @ap3x/agent-core is closed and cannot be modified (other-package rule) — so the swarms Agent.supports param was widened to `BackendCapability | "forcedTool"` and GroupChat probes supports("forcedTool") via a structural cast; a backend returning false throws AgentRunError with a clear message. The AP3X-native Agent returns true. (2) All orchestrators take AgentBackend[] and build helper agents via caller-supplied factories (no hardcoded model literals) — same pattern as MajorityVoting/MultiAgentRouter. (3) GroupChat decision works in one Agent turn: faux emits fauxToolCall("respond",{score,message}); extractArgs reads the toolCall block from AgentRunResult.messages. Unknown 'respond' tool returns "Tool not found"(terminate=true) so the loop stops after capturing the toolCall message. (4) SocialAlgorithms [BUG-TO-FIX]: replaced SIGALRM with AbortController+setTimeout race (timeout aborts signal AND rejects so a hung callable can't block); dropped global monkey-patch for a per-agent instrumented backend wrapper; removeAgent removes by name and throws AgentNotFoundError. (5) TrialSimulation [BUG-TO-FIX]: witnessTestimony initialized to "" and cross phase guards missing testimony (no NameError). Biome: single-line prompt template literals trigger noUnusedTemplateLiteral — use double-quoted strings; forEach without index triggers noForeach — use for...of/entries().