---
id: OXwbXJY7qHw6FQyVzSWXi
session_id: 2026-06-10-dealerbot-productionization-self-pilot-a8a7cda
agent_id: default
task: Fresh-session handoff for DealerBot.AI productionization M0 hardening after local commit a8a7cda
outcome: approved
created_at: "2026-06-10T07:57:37.726Z"
---

DealerBot.AI handoff, 2026-06-10. Repo: C:\Users\Guerr\Desktop\DealerBot.AI. Branch: feature/productionization-self-pilot. Latest local commit: a8a7cda fix(api): harden production config and widget limits. Worktree was clean after commit; branch has no upstream configured, so nothing was pushed.

What shipped in a8a7cda: production config/API hardening and widget public-surface limits. packages/config now requires DEALERBOT_MODEL_API_KEY and DEALERBOT_EMBEDDING_API_KEY in production when model/embedding base URLs point at public providers, while allowing keyless private/internal self-hosted gateways. apps/api now refuses production boot for DEALERBOT_EXPOSE_PLANNED_SQL enabling values and weak/placeholder DEALERBOT_DEBUG_CONFIG_TOKEN values. Portal and widget-lab legacy sessions missing apiKeyKind now default to widget_public rather than admin_private. Widget config and site-parser-config GETs now share the widget fixed-window limiter by origin+dealer+IP; production widget preflight/origin checks fail closed if widgetOriginExecutor is missing; widget write routes have explicit 16 KiB Fastify bodyLimit and return PAYLOAD_TOO_LARGE on oversize bodies. Docs and .env.example were updated accordingly.

Verification before commit: focused regression passed 242 tests across packages/config/src/config.test.ts, apps/api/src/server.test.ts, apps/api/src/private-route-hardening.test.ts, and apps/portal/src/app/(portal)/portal-auth.test.ts. Full pnpm verify passed: TS_SOURCE_ONLY, lint, typecheck, and Vitest. Final test total was 1628 passed / 5 skipped; lint still has the pre-existing 5 Next <img> warnings.

Current docs/CONSOLIDATED-PRODUCTION-PLAN.md M0 state: dealerId tenant-membership chokepoint DONE; portal live auth DONE; unsalted SHA-256 migration DONE; production auth/planned-SQL/debug-token kill switches DONE; model/embedding key policy DONE; self-service trial rate limit DONE; widget config/read/body-limit row DONE; per-key role-loading fallback DONE. Remaining M0 rows to pick up: portal session rotation/revocation or documented kid scheme; API-key lifecycle CRUD/rotate/audit/cache/invite flow; widget embed hardening (frame-ancestors CSP from widget_origins, explicit-origin postMessage in frame variants, event.source check in served loader, server-side session binding to kill URL-hash session fixation); doc-reconciliation mini-pass. Good next bounded slice: widget embed hardening if continuing trust-boundary work, or API-key lifecycle if taking the larger F1 item.