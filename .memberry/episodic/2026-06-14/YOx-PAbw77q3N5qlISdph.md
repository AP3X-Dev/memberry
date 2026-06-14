---
id: YOx-PAbw77q3N5qlISdph
session_id: clean-room-ap3x-2026-06-13
agent_id: default
task: [project:ap3x] Throttle parallel analysis agents to avoid server rate limiting
outcome: approved
created_at: "2026-06-14T02:36:06.615Z"
---

Firing 14 token-heavy clean-room analysis agents in a single parallel() barrier triggered transient server-side rate limiting ("Server is temporarily limiting requests, not your usage limit") that killed 7 of 14 agents after retries. Each agent reads thousands of LOC and reasons heavily (~2.17M subagent tokens across the wave). Fix: throttle heavy fan-out to ~2-3 concurrent via sequential batches inside the workflow (for-loop of parallel() chunks), not one big parallel(). Successful sections persisted to disk survived; only the failed units needed re-running. **Why:** large bursts of heavy agents hit provider rate limits even when under the account usage cap. **How to apply:** for any workflow dispatching many token-heavy subagents (analysis/audit/review fan-out), chunk into batches of 2-3 and await each batch before the next.