---
id: CwLCQVb5VuUxOx8FOFMc_
session_id: session-20260613-182700
agent_id: default
task: Fix BUG-2: SwarmSnapshotStore eviction guard off-by-one
outcome: approved
created_at: "2026-06-14T01:30:28.978Z"
---

Fixed BUG-2 in src/swarm/snapshot.ts. Root cause: after inserting into this.snapshots (line 95), the eviction guard `if (this.snapshots.size >= MAX_SNAPSHOTS)` fired at size==100 (== MAX_SNAPSHOTS), immediately evicting the oldest entry and capping effective capacity at 99. Fix: changed `>=` to `>` on line 98. One-character change. No tests asserted the 99 behavior. pnpm run verify passed: 316 test files / 1842 tests / exit 0.