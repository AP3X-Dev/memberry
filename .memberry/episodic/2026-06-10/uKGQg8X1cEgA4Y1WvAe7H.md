---
id: uKGQg8X1cEgA4Y1WvAe7H
session_id: session-20260609-204000
agent_id: default
task: Replace unsalted SHA-256 dealer-admin password hashing with salted scrypt + legacy rehash
outcome: approved
created_at: "2026-06-10T03:46:45.606Z"
---

Dealer-admin password hashing fixed on feature/productionization-self-pilot (commit d5214d4). Decision: repo-wide single password-hash convention = scrypt:N=16384,r=8,p=1:&lt;base64url salt&gt;:&lt;base64url 64-byte hash&gt; (mirrors portal seed format; packages/agent cannot import from apps/portal so format is mirrored, not imported). Legacy rows are sha256:&lt;64hex&gt;; verifyDealerAdminPassword accepts them timing-safe and returns needsRehash; buildDealerAdminPasswordRehashMutation emits parameterized UPDATE users guarded by previous hash (plan/execute separation, planned mode skips rehash). Portal login (authenticatePortalLogin) opportunistically rehashes legacy hashes in a try/catch so login never blocks on the rehash write. Class audit: api-auth.ts uses HMAC-SHA256+pepper for API keys (fine); buildInviteTokenHash, embeddings cache key, meta-catalog-sync content hash, meta-events CAPI PII hashing are all non-password uses. All suites green: agent 272, portal 267, api 232 tests; check:ts-source clean.