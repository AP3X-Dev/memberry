---
id: LLKtR1pkjUuhwj4BuW8xE
session_id: session-20260613-200500
agent_id: default
task: Fix BUG-5: pregel/streaming Command.send from send-dispatched nodes silently dropped
outcome: approved
created_at: "2026-06-14T03:06:14.925Z"
---

Fixed BUG-5 in src/pregel/streaming.ts. The send-dispatch Command branch (lines 149-154) handled result.update and result.goto but omitted result.send. Added `if (result.send) nextSends.push(...result.send.map((s) => ({ node: s.node, args: s.args })));` after nextNodes.push(...gotos) — mirrors the main-node path exactly (line 456). Regression test at src/__tests__/regression/send-command-chained-sends.test.ts verifies a send-dispatched worker returning Command({ send: [new Send("finisher")] }) causes finisher to execute. Gate: pnpm run verify exit 0 — 319 test files / 1848 passed.