---
id: yg1CrMXjEMJierreoa15L
session_id: session-20260613-202900
agent_id: default
task: Fix BUG-6: LSPClient.clearAllWaiters() live-array mutation during for...of
outcome: approved
created_at: "2026-06-14T03:33:24.339Z"
---

Fixed BUG-6 in src/lsp/client.ts. Root cause: clearAllWaiters() iterated the live waiters array with for...of; w.resolve() synchronously called removeWaiter() → splice(), shifting remaining elements and causing every odd-indexed waiter to be skipped. Fix: snapshot with [...waiters] before iterating. Regression test at src/__tests__/regression/lsp-clear-all-waiters-mutation.test.ts confirmed load-bearing (2/2 fail without fix, 2/2 pass with fix). pnpm run verify exit 0, 320 test files passed.