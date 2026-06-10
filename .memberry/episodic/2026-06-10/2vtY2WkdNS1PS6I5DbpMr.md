---
id: 2vtY2WkdNS1PS6I5DbpMr
session_id: session-20260609-205000
agent_id: default
task: T4 trial-signup rate limit + T5 api-key role loading investigation
outcome: approved
created_at: "2026-06-10T03:58:19.761Z"
---

T4 DONE (commit b6d07ec on feature/productionization-self-pilot): POST /v1/self-service/trials now rate-limited per client IP via the same fixed-window mechanism as the widget write limiter. New env DEALERBOT_TRIAL_SIGNUP_RATE_LIMIT_PER_MINUTE (default 5/min, documented in .env.example). Generic primitives renamed: FixedWindowRateLimiter, createFixedWindowRateLimiter, consumeFixedWindowRateLimit, applyRateLimitHeaders, sendRateLimitResponse; widget wrappers kept. T5 NEEDS_CONTEXT: api-auth.ts SELECT omits user_role/user_id which mapApiKeyRow reads, so private keys default to admin role — but the api_keys table (packages/db/migrations/0001_foundation.sql:187-200) has NO user_role or user_id columns and no FK to users; no migration 0002-0010 adds them. Adding the columns to the SELECT would break auth at runtime against the real schema. Fix requires a schema decision (migration + provisioning semantics) — this is the deferred F1 api-key-lifecycle work in BLOCKERS/CONSOLIDATED-PRODUCTION-PLAN line 189, which itself offers the alternative of formally accepting kind-derived roles until F1 lands.