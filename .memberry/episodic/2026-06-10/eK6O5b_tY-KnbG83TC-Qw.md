---
id: eK6O5b_tY-KnbG83TC-Qw
session_id: session-20260609-195500
agent_id: default
task: M0-T1: fix NODE_ENV security-bypass class in packages/config
outcome: approved
created_at: "2026-06-10T03:00:11.170Z"
---

Decision: getNodeEnv in packages/config/src/index.ts now fails closed — any set NODE_ENV that does not trim to exactly "development" or "test" resolves to "production" (covers staging/prod/Production/PRODUCTION/" production "/blank). Unset NODE_ENV still resolves to "development" because pnpm db:migrate and other scripts run in bare shells via tsx without --env-file. Chose to normalize the resolved runtime.nodeEnv (not just gate the hardening call) because nodeEnv also gates API auth (isApiAuthRequired), planned-SQL exposure, requiredValue dev defaults, and worker entrypoint mode. Trim-forgiveness for padded development/test is deliberate (CRLF env files) and introduces no bypass. Normalization documented in .env.example. Commit 81bcd61 on feature/productionization-self-pilot. Known residual: apps/portal reads process.env.NODE_ENV raw (portal-login cookie secure flag, demo-login-accounts, portal-live-mode) — not covered by this fix.