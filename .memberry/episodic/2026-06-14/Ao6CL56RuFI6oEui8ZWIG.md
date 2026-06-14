---
id: Ao6CL56RuFI6oEui8ZWIG
session_id: session-20260613-hunt6
agent_id: default
task: Bug hunting sweep cycle 6: src/lsp, src/mcp, src/guardrails, src/agents, src/tools, src/config, src/platform
outcome: approved
created_at: "2026-06-14T03:27:51.127Z"
---

Cycle 6 sweep of oni-core-cerebro. Focused on src/lsp, src/mcp, src/guardrails, src/agents, src/tools, src/config, src/platform. Found 1 confirmed real bug: BUG-6 in LSPClient.clearAllWaiters() at src/lsp/client.ts:490-499. The for...of loop over a live DiagnosticsWaiter[] array mutates the array (via removeWaiter -> splice) during iteration, causing every other waiter to be skipped and its Promise to hang permanently. Fix: snapshot the array before iterating with [...waiters] as already done correctly in BackgroundAgentPlatform.notifyWaiters(). All other candidates (MCPClient lock patterns, piiFilter pipeline, BudgetTracker ordering, defineAgent maxTokens check, JsonFileLock, LSPManager spawning dedup, AuditLog eviction) were traced and ruled out as valid design or already-addressed issues.