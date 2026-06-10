---
id: nwCJzH017sWch3DxmnzG2
session_id: session-20260609-201000
agent_id: default
task: M0-T2: production API auth enforcement for DEALERBOT_API_AUTH_REQUIRED
outcome: approved
created_at: "2026-06-10T03:17:03.718Z"
---

Decision: DEALERBOT_API_AUTH_REQUIRED disabling values (0/false/no/off) now fail loud at boot in production instead of disabling the HMAC auth preHandler. Implemented in apps/api/src/server.ts isApiAuthRequired (not packages/config) because that is the only layer reading the flag; flag evaluation hoisted from per-request to buildServer boot time so a bad value refuses to boot (index.ts calls buildServer at module top level, so the throw crashes startup). Tests pin production default (401 without key), boot refusal for all disabling spellings, explicit-enable enforcement, and unchanged dev defaults (apps/api/src/private-route-hardening.test.ts, new productionEnv fixture mirroring config.test.ts completeProductionEnv). Commit 4842a94. Sibling concerns found in class audit, not fixed: (1) shouldExposePlannedSql — DEALERBOT_EXPOSE_PLANNED_SQL=1 can still expose planned SQL in production (inverse hazard, same class); (2) /debug/config endpoint enabled in production by merely setting DEALERBOT_DEBUG_CONFIG_TOKEN, no production gate or token-strength check.