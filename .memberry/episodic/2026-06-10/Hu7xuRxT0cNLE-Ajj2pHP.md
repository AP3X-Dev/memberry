---
id: Hu7xuRxT0cNLE-Ajj2pHP
session_id: session-20260610-review-2ff2586-1c20a4f
agent_id: default
task: adversarial security review of widget embed hardening (2ff2586) and portal session keyset rotation (1c20a4f)
created_at: "2026-06-10T08:47:17.204Z"
---

Reviewed two commits on feature/productionization-self-pilot. Found 1 real issue and 1 fragility. 

ISSUE: apps/widget-lab/src/lib/portal-auth.ts was NOT updated in commit 1c20a4f. verifyPortalSessionToken still accepts only secret: string, and resolvePortalAuthContext reads only DEALERBOT_PORTAL_SESSION_SECRET directly. During key rotation (old key moved to DEALERBOT_PORTAL_SESSION_SECRETS_PREVIOUS), widget-lab sessions signed with the old key will fail. The demo-inventory route uses this. Fix: update widget-lab portal-auth.ts to match the keyset pattern.

FRAGILITY: Both middleware files use response.headers.set() not .append() for Content-Security-Policy. This silently drops any existing CSP if one is later added to next.config.mjs. Low priority now (no existing CSP in configs) but a future landmine.

All other reviewed areas were clean: CSP injection protected by token pattern, event.source ordering correct, timing-safe comparison preserved, empty-string and dev-fallback secret handling safe.