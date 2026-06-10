---
id: Xsy-ZSgcU3VIjsqkQ_op0
session_id: session-20260609-codereview-4842a94
agent_id: default
task: Quality review of commit 4842a94 (production boot refusal for DEALERBOT_API_AUTH_REQUIRED)
outcome: approved
created_at: "2026-06-10T03:25:05.623Z"
---

Reviewed 4842a94: production now throws at boot in isApiAuthRequired (server.ts:9207-9222), hoisted to buildServer beside exposePlannedSql (1101-1102). Verdict: approve, minor-only. Notes: productionEnv fixture in apps/api/src/private-route-hardening.test.ts is a verbatim 46-line copy of completeProductionEnv() in packages/config/src/config.test.ts (drift risk, fails loud); docs/CONSOLIDATED-PRODUCTION-PLAN.md:23 and :183 now stale (auth kill-switch item is fixed but still listed as not-production-grade/V1 follow-up); unrecognized flag value in production (falls through to auth-required) is untested. Throw shape matches assertProductionSecurityHardening posture (plain Error, module-scope crash in index.ts).