---
id: ngEkY1ID1NuiO0XcNDOzT
session_id: session-20260613-hunt-cycle1
agent_id: default
task: Bug discovery sweep cycle 1 for oni-core-cerebro
created_at: "2026-06-14T00:21:58.879Z"
---

Swept swarm, hitl, coordination, checkpointers. Found 3 bugs: BUG-1 (medium) AgentPool retryDelayMs + dispose() causes permanent hang in pool.ts:262-266; BUG-2 (low) SwarmSnapshotStore off-by-one eviction in snapshot.ts:95-99, effective cap 99 not 100; BUG-3 (low) createAgentNode retry-delay AbortSignal listener leak in agent-node.ts:209-222. No bugs in hitl, coordination, or checkpointers. Pool retry timer disposal is the most actionable fix.