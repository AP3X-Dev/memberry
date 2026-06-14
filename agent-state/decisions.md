# Decisions -- memberry-optimizer

> Choices made and their rationale (the file-based fallback for what MemBerry
> would otherwise remember). Enrich from references/state-templates.md.

| Decision | Rationale | Cycle |
|----------|-----------|-------|
| Loop edits in local clone `C:/Users/Guerr/amp-opt`; gate runs in isolated `cerebro:~/projects/amp-opt`; never touch `~/projects/amp` (live services) or `master`. | Tests need live Neo4j+Redis (on cerebro) but the live MCP/wiki services run from `~/projects/amp` on master and must not be disturbed. Sync via `git push origin opt` → test clone `fetch + reset --hard`. | 0 |
| Gate MUST strip auth env before `npm test`: unset MEMBERRY_API_TOKEN/_API_TOKENS/_TENANT_TOKENS/_TENANT_DATASTORES/_ALLOW_UNAUTHENTICATED + AMP_* twins after sourcing `.env`. | The prod `.env` sets MEMBERRY_API_TOKEN; 3 `server.test.ts` cases don't clear the canonical var, so an inherited token makes them spuriously fail 401. Stripping yields the true green (1461 baseline → 1463 after OPT-01). | 0 |
| Interim tenant-isolation pattern: gate tenant-reachable channels on `isDefaultTenant(tenant)` rather than stamping nodes. | Symbol nodes (and some entity reads) aren't tenant-stamped yet; gating the channel for non-default tenants closes the leak with a minimal diff. Durable fix (stamp nodes + tenantWhere) tracked as follow-up (OPT-67). | 1 |
