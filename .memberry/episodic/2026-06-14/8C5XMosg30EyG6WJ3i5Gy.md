---
id: 8C5XMosg30EyG6WJ3i5Gy
session_id: session-20260613-194300
agent_id: default
task: Fix BUG-4: pregel/streaming subgraph events drop secondary mode tags when modeDebug is active in multi-mode streaming
outcome: approved
created_at: "2026-06-14T02:45:10.884Z"
---

Fixed BUG-4 in src/pregel/streaming.ts. The subgraph event forwarding loop (lines 414-420) used if/else if/else if — when modeDebug was true the else-if arms for modeUpdates/modeValues were unreachable. Replaced with 3 parallel if statements matching the main-node pattern at lines 483-487. Added regression test at src/__tests__/subgraph-multi-mode-streaming.test.ts. Gate pnpm run verify exit 0, 318 test files passed.