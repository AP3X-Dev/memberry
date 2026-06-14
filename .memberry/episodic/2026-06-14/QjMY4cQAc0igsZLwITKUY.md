---
id: QjMY4cQAc0igsZLwITKUY
session_id: session-20260613-172500
agent_id: default
task: Fix BUG-1: AgentPool dispose() during retry sleep leaves runOnSlot coroutine permanently hung
outcome: approved
created_at: "2026-06-14T00:25:46.201Z"
---

Fixed BUG-1 in src/swarm/pool.ts. Root cause: dispose() cleared the setTimeout but never called the promise's resolve(), leaving the await in runOnSlot unsettled permanently. Fix: added _retryResolvers Set to track resolve functions; dispose() now calls each resolver after clearTimeout; coroutine checks _disposed after waking from sleep and throws immediately. Gate: pnpm run verify exited 0 (316 test files, 1842 tests passed).