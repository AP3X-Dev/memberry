---
id: XMDJN2x40zOB1nksL2muS
session_id: session-20260613-190700
agent_id: default
task: Fix BUG-3: createAgentNode retry-delay AbortSignal listener leak
outcome: approved
created_at: "2026-06-14T02:10:39.095Z"
---

Fixed BUG-3 in src/swarm/agent-node.ts (lines 209-229). Root cause: abort listener was an anonymous function passed to addEventListener; on the abort path { once: true } auto-removed it, but on the normal timer path the setTimeout callback had no reference to remove it. Fix: captured the listener in `let onAbort` and called removeEventListener inside the setTimeout callback before resolve(). Also simplified the early-abort guard to not call clearTimeout before the timer was created. Added regression test at src/__tests__/swarm/retry-delay-abort-listener-leak.test.ts. pnpm run verify exits 0 (317 files / 1844 passed).