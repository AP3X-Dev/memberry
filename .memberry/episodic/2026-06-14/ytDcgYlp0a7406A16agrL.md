---
id: ytDcgYlp0a7406A16agrL
session_id: session-20260613-cycle8-hunter
agent_id: default
task: Cycle 8 bug sweep: harness/loop/hooks,safety,types; harness/memory/extractor,prompter,types,fs-compat; swarm/self-improvement/*; prebuilt/*; graph.ts, logger.ts, injected.ts; models/http-error,types; swarm/mermaid,config
outcome: approved
created_at: "2026-06-14T04:17:28.565Z"
---

Cycle 8 sweep complete. Filed BUG-8: MemoryExtractor.consolidate() calls loadType('episodic') which excludes units already in the loaded Set from session match(). When agentLoop's initMemory calls match(), recent episodic units enter loaded. consolidate() then sees result.units.length < 3 and returns early without consolidating, even when 4+ sessions exist. Only triggered with autoConsolidate:true + memoryExtractor configured. Test bypasses by calling persistEpisodic directly (never adds to loaded). All other files in the sweep were clean. Coverage is now saturating.