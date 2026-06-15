---
id: N3nUk9KfbYXXgJIHZAqX6
session_id: session-20260613-205000
agent_id: default
task: Fix BUG-7: SessionInit.withTimeout() timer never cleared on success
outcome: approved
created_at: "2026-06-14T03:57:01.887Z"
---

Fixed BUG-7 in oni-core-cerebro. Root cause: SessionInit.withTimeout() created a setTimeout but never captured the handle or called clearTimeout when the promise resolved first. Fix: refactored withTimeout to capture handle in a let variable and attach .finally(() => clearTimeout(handle)) to the input promise — same pattern as hooks-engine.ts and safety-gate.ts. Added load-bearing regression test at src/harness/__tests__/session-init-timer-leak.test.ts. pnpm run verify exits 0: 321 test files / 1852 passed.