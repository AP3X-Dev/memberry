# MemBerry Threat Model

This document is the security analysis behind [`SECURITY.md`](SECURITY.md). It
enumerates the assets MemBerry protects, the trust boundaries it sits across, the
threats against it (organized STRIDE-style), the mitigations that ship in the
code (with references), and an honest account of residual risk.

MemBerry is a Neo4j + Redis backed agent-memory system exposed over the Model
Context Protocol (MCP). Its **supported deployment model** is a single-operator,
single-trusted-host setup on loopback/private network with Bearer-token auth (see
`SECURITY.md`). Threats are assessed against that model; where a threat only
matters under a different model (e.g. mutually distrusting tenants on one
instance), that is called out explicitly.

---

## 1. Assets

| # | Asset | Why it matters |
|---|-------|----------------|
| A1 | **The memory graph** (episodic memories, semantic knowledge, temporal facts, entities, code symbols, memory blocks) in Neo4j | The product's core value and its accumulated, hard-to-reconstruct state. Loss or silent tampering corrupts every downstream agent decision. |
| A2 | **Secrets inside memory** | Agents may store text containing API keys, tokens, connection strings, or private keys. Once persisted these leak via DB access, backups, exports, and retrieval. |
| A3 | **Cross-project / cross-context data** | Memories for project A must not surface when working project B. Leakage corrupts context and can disclose one workstream's data to another. |
| A4 | **Infrastructure credentials** | `NEO4J_PASSWORD`, `REDIS_PASSWORD`/`REDIS_URL`, `OPENAI_API_KEY`, and the MCP API token(s) themselves. Compromise yields full read/write to A1–A3. |
| A5 | **The audit trail** (`:AuditLog`) | Integrity of the record of who changed what. Tampering hides abuse. |
| A6 | **Availability** of the MCP service and its datastores | Agents depend on memory at runtime; an outage degrades or blocks dependent workflows. |
| A7 | **The host / process** running the server | Path traversal, command injection, or code execution would compromise everything above. |

---

## 2. Trust boundaries

```
                          ┌─────────────────────────────────────────────┐
   (B1) MCP transport     │                MemBerry host                 │
  Agent ───HTTP/SSE/────► │  ┌────────────┐    (B3) DB protocol         │
  (B2)   Bearer token     │  │ MCP server │──bolt──► Neo4j  (A1,A5)     │
                          │  │  (tools)   │──resp──► Redis  (cache)      │
  Operator ──env/CLI────► │  └─────┬──────┘                             │
  (B4)                    │        │ (B5) outbound to OpenAI            │
                          └────────┼────────────────────────────────────┘
                                   ▼
                              OpenAI API (embeddings / extraction / synthesis)
```

The diagram traces the MCP request path. **B6** below is a second inbound
listener on the same host, not shown above.

- **B1 — MCP transport boundary.** Network edge between a calling agent and the
  server (`packages/mcp/src/server.ts`). Origin checks, Bearer auth, CORS, and
  the health-endpoint split live here.
- **B2 — The agent.** A semi-trusted caller. Even an authenticated, well-meaning
  agent can be steered by untrusted input (prompt injection) into issuing
  damaging tool calls, so tool-level controls matter independently of auth.
- **B3 — DB protocol boundary.** The server talks to Neo4j (Bolt) and Redis. The
  read-only Cypher posture (`packages/neo4j/src/query.ts`) and the READ-session
  enforcement live here.
- **B4 — The operator.** Trusted. Configures env/secrets and runs migrations.
  Operator misconfiguration is the dominant real-world risk class.
- **B5 — Outbound to OpenAI.** Memory content is sent to OpenAI for embeddings,
  fact extraction, and `berry_ask`/dream synthesis. Anything stored may transit
  this boundary.
- **B6 — Wiki viewer HTTP surface.** `startWikiViewer`
  (`packages/wiki/src/viewer.ts`) serves the compiled wiki on port `3200` from a
  second HTTP server with **no authentication and no origin check**. It reads
  compiled memory and, because both CLI entry points wire a Neo4j driver, also
  writes it back (`/api/edit`) and runs the hook installer
  (`/api/settings/hooks-install`). It binds all interfaces unless
  `MEMBERRY_WIKI_HOST` / `MEMBERRY_HOST` / `HOST` is set (`resolveWikiHost`), so
  the only control on this boundary is where the port is reachable from.

---

## 3. Threats and mitigations (STRIDE)

### 3.1 Spoofing / Authentication (B1, B2)

**T-S1 — Unauthenticated access to memory.**
*Mitigation:* Bearer token required by default. Token resolution fails closed: if
no token is configured and the explicit opt-out is not set, the server generates
a random `randomUUID()` token rather than serving unauthenticated
(`server.ts`, `startSSE`). `MEMBERRY_ALLOW_UNAUTHENTICATED=true` is the
only way to disable auth and logs a warning.

**T-S2 — Token brute force / timing side channel.**
*Mitigation:* Tokens are matched in constant time with `timingSafeEqual`
(`actorForToken`, `server.ts`), guarded by a length pre-check.
*Residual:* No rate limiting / lockout on repeated failed auth (see R-DoS).

**T-S3 — Cross-site request from a browser context.**
*Mitigation:* Origin allowlist (`isOriginAllowed`, `server.ts`) restricts
browser origins to localhost; non-localhost origins get `403` on both preflight
and the actual request. CORS echoes the specific origin, never `*`.
*Residual:* Requests with no `Origin` (all non-browser MCP clients) are allowed by
origin policy and gated only by the token — correct for the threat (CSRF needs a
browser) but means the token is the sole control for direct clients.

**T-S4 — Actor impersonation in the audit trail.**
*Mitigation:* Named tokens bind a token to an actor identity (`MEMBERRY_API_TOKENS`
→ `tokenToActor`), so audit/attribution reflects which key was used.
The mapping is threaded all the way through: each session resolves
`actorFor(req)` and passes it into `registerAllTools`, which builds a
`ServiceContainer` carrying that actor (`coreContainerForTenant`, `tools.ts`), so
`berry_store` stamps `agent_id = <authenticated actor>` and the audit append uses
that same value (`AMPService.store`, `core/src/service.ts`).
*Residual:* `mcp` remains as the fallback identity when auth is disabled or the
actor cannot be resolved, so attribution is only as strong as the token
configuration.

### 3.2 Tampering / Write-path integrity (B2, B3, B6)

**T-T1 — Unauthorized graph mutation via raw Cypher.**
*Mitigation:* Defense in depth in `query.ts`. `validateReadOnlyCypher` strips
strings/comments/params, NFKC-normalizes to defeat homoglyph evasion, rejects
stacked statements, blocks `SHOW`/`USE`, blocks all mutating keywords
(`CREATE/MERGE/SET/DELETE/DETACH/REMOVE/DROP/FOREACH/LOAD`), and blocks stored-
procedure `CALL` (allowing only read-only `CALL { … }` subqueries). Independently,
`rawCypher` runs in a `defaultAccessMode: READ` session so Neo4j rejects any write
even if validation were bypassed.

**T-T2 — Writes when the deployment should be frozen.**
*Mitigation:* `MEMBERRY_READONLY=true` rejects `berry_store`
(`AMPService.store`, `service.ts`) and all block writes via `_assertWritable()`
(`blocks.ts`), wired through `services-factory.ts`.

**T-T3 — Lost-update / concurrent block clobber.**
*Mitigation:* `MemoryBlockService.replace` uses an optimistic-concurrency check
(`_persistWithVersionCheck`, `blocks.ts`): it re-reads and compares `updated_at`,
throwing on concurrent modification. Block size is capped (`MAX_BLOCK_SIZE`).
*Residual:* The check is best-effort against the Redis copy, not a transactional
compare-and-swap across both stores.

**T-T4 — Audit trail tampering.**
*Mitigation:* The audit store is append-only by construction — no update/delete
API (`audit.ts`) — and a unique-id constraint is enforced via migration
`0002-audit-log`.
*Residual:* An actor with direct Neo4j credentials (A4) can still alter
`:AuditLog` nodes out-of-band; integrity holds only against the MCP surface.

**T-T5 — Poisoned / adversarial memory content (prompt injection at rest).**
*Partial mitigation:* Project-scope enforcement limits which memories a scoped
query returns; confidence/decay and consolidation down-weight unreinforced
claims; abductive (dream) facts are rendered as `[hypothesis]` and rank lower.
*Residual:* MemBerry does not sanitize the *semantics* of stored prose. Malicious
or wrong content stored by a caller can later be retrieved and influence an agent.
This is inherent to a memory system and is mitigated operationally (trust the
callers, scope tightly), not by the store.

**T-T6 — Unauthenticated writes through the wiki viewer (B6).**
*Acknowledged:* Port `3200` accepts `POST /api/edit` (reconciles edited markdown
back into Neo4j through `WikiEditReconciler` and recompiles the portal),
`POST /api/refresh`, `POST /api/settings/hooks-tuning`, and
`POST /api/settings/hooks-install` (runs the hook installer against the viewer's
working directory). None of them checks a token or an origin, and the reconciler
writes with its own Neo4j driver rather than through `AMPService`, so
`MEMBERRY_READONLY` does not reach this path either.
*Residual:* No code-level control exists on this boundary. Anyone who can reach
`3200` can rewrite compiled memory in the graph and change hook configuration on
the host. Keep the port on loopback (`MEMBERRY_WIKI_HOST=127.0.0.1`, or the
compose publish address `MEMBERRY_PUBLISH_HOST=127.0.0.1`).

### 3.3 Information disclosure — cross-tenant & secrets (B2, B3, B5, B6)

**T-I1 — Cross-project leakage.**
*Mitigation:* Mandatory project tagging on store (`resolveProjectTag`,
`service.ts`), tag/entity-scoped retrieval in `load`/`byScope` (`query.ts`), and
scope filters in `berry_grep` (`tools.ts`). Fuzzy-warns on near-duplicate tags to
prevent accidental fragmentation/cross-write.
*Residual:* This is **logical** isolation over one shared graph, not a DB tenant
boundary. A caller can omit/override the scope on a *read*, and `berry_query`
bypasses scoping entirely (see T-E1).

**T-I2 — Secrets persisted in memory then disclosed.**
*Mitigation:* `MEMBERRY_REDACT_ON_INGEST=true` redacts high-signal secret shapes
(`redact.ts`) before hashing/embedding/persistence, so they never enter the store.
A second, independent redaction + property allowlist + XSS-escape pass runs at the
graph-export boundary (`packages/graph/src/allowlist.ts`,
`packages/graph/src/snapshot.ts`) so reports/exports/HTML maps never emit secrets
even if ingest redaction was off.
Full `.memberry/` memory exports are a different, sensitive backup surface. They
remain gitignored, and the snapshot CLI refuses legacy Git-publishing flags
before exporting; versioned backups belong in a separate private destination.
*Residual:* Redaction is conservative pattern matching, opt-in on ingest, and not
a guarantee — novel secret shapes or secrets split across lines can slip through.

**T-I3 — Disclosure to the LLM provider (B5).**
*Acknowledged:* Embeddings, fact extraction, and `berry_ask`/dream synthesis send
memory content to OpenAI. There is no on-prem inference path; operators must
accept this boundary or run with `OPENAI_API_KEY` unset (embeddings disabled,
lexical/fulltext retrieval only — `bootstrap.ts`, `service._vectorSearch`).

**T-I4 — Health endpoint info leak.**
*Mitigation:* `/healthz` is intentionally unauthenticated and carries no secrets
and no memory content. `/readyz` requires auth (the `/healthz` handler returns
before the auth gate; `/readyz` sits after it — `statusPayload`, `server.ts`).
*Residual:* The `/healthz` payload is wider than liveness. Alongside service
name, transport, session counts, `auth_required`, and uptime it embeds
`consolidation_automation` (`getConsolidationAutomationHealth`,
`packages/mcp/src/consolidation-coordinator.ts`), whose per-worker snapshot
carries `running_scope` and `queued_scopes` — project scope names — plus the
worker's last internal error string and `limitation` text. Any unauthenticated
caller who can reach the port learns which projects are being consolidated and
reads raw operational error text. Moving `consolidation_automation` behind the
auth gate would cost nothing operationally, since `/readyz` already returns it
authenticated; until then, network reach is the control.

**T-I5 — Path traversal in file-reading tools.**
*Mitigation:* `berry_ingest` / `berry_braindump` / `berry_wiki_sync` resolve and
validate every input path against `MEMBERRY_INGEST_ALLOW_DIR` (default cwd) and
reject paths escaping the base (`validatePath`, `packages/wiki/src/tools.ts`).

**T-I6 — Compiled memory readable without auth on the wiki viewer (B6).**
*Acknowledged:* The viewer serves the whole compiled wiki — every project's
articles, decisions, and semantics — plus `/api/graph/*` exports and a settings
page, to any caller that can open port `3200`. There is no token check, no
origin check, and no project scoping: the compose service compiles with
`project_tag: 'all'`. The write side of the same surface is T-T6.
*Residual:* Restricting reach is the only control. This is the surface most
likely to be published by accident, because the bind default is all interfaces
and the port is easy to forward for convenience.

### 3.4 Denial of service / Availability (B1, A6)

**T-D1 — Unbounded query/result cost.**
*Mitigation:* Raw Cypher result sets are capped (`MAX_RAW_CYPHER_LIMIT = 100`,
`normalizeRawCypherLimit`), `berry_query` limit is schema-capped at 100, audit
queries cap at 500, and tool inputs are length-bounded by Zod schemas
(`tools.ts`). Block size is capped (`MAX_BLOCK_SIZE`). Every raw Cypher
execution carries a server-side transaction timeout
(`MEMBERRY_RAW_CYPHER_TIMEOUT_MS`, default 15s — `defaultRawCypherTimeoutMs`,
`neo4j/src/query.ts`; the grep path passes a tighter explicit bound). At the HTTP
layer, request bodies are capped at 1 MB (`MEMBERRY_MAX_BODY_BYTES`) and
slow-client receive timeouts bound header and body reads (headers 20s, request
30s, keep-alive 10s — `server.ts`).
*Residual:* No global request-rate limiting and no per-actor quota. The
query-time budget covers the raw Cypher path only: scoped read, retrieval, and
vector/fulltext queries run with no transaction timeout, so a
trusted-but-abusive or compromised actor can still drive load (many requests,
expensive traversals within the limit). Acceptable under the single-operator
model; would need attention for shared deployments.

**T-D2 — Resource exhaustion via failed-auth spam.** No lockout/backoff on
repeated bad tokens. Loopback/private-network exposure is the compensating control.

**T-D3 — Hung shutdown / stuck connections.**
*Mitigation:* Graceful shutdown closes transports and datastore connections within
a bounded timeout (`MEMBERRY_SHUTDOWN_TIMEOUT_MS`, default 5s) and force-closes
idle/all connections on timeout (`closeSSEHandle`, `settleWithin`, `server.ts`).

**T-D4 — Background work failures degrading the request path.**
*Mitigation:* Fact extraction is fire-and-forget with bounded retries
(`_extractFactsBackground`, `service.ts`); audit append, cache invalidation, and
graph expansion are best-effort and never fail the user operation.
*Residual:* In-process retry only — fact-extraction durability across a crash is
work in progress; a process restart mid-extraction loses that enrichment (the
episode itself is already persisted).

### 3.5 Elevation of privilege / Scope escape (B2, B3)

**T-E1 — Reading across all projects via the admin domain.**
*Mitigation/Acknowledged:* `berry_query`/`rawCypher` is **read-only** (T-T1) but
**not project-scoped** — it can read any node in the graph. It is treated as an
administrative/diagnostic tool and is **disabled by default** behind the `admin`
progressive-disclosure domain (`registerAllTools` disables all Tier-2 tools;
`berry_tools` enables on demand — `server.ts`, `tools.ts`). An agent must
explicitly enable `admin` to use it.
A per-actor capability model ships behind `MEMBERRY_CAPABILITY_POLICIES_V1`:
when it is set, each `(tenant, actor)` carries an explicit grant set of
scope/domain/tool/operation (`ActorCapabilityGrantV1`,
`core/src/capability-policy.ts`) and a per-session runtime interposer denies
every ungranted call (`installCapabilityRuntimeInterposerV1`,
`mcp/src/capability-runtime.ts`, installed per session in `server.ts`).
`berry_tools` carries capability metadata like every other tool, so enabling a
domain is itself a gated operation. The runtime refuses to start alongside
`MEMBERRY_ALLOW_UNAUTHENTICATED=true` and on the stdio transport, neither of
which has a per-session actor to key a policy on.
*Residual:* Capability policies are **off by default**. With the variable unset
there is no interposer, and any authenticated caller *can* enable the admin
domain — progressive disclosure is context hygiene and least surprise, not an
authorization boundary.

**T-E2 — Privilege via shared process state.**
*Mitigation:* Every SSE and Streamable-HTTP session gets its own `McpServer` and
its own `ServiceContainer`, bound to the request's tenant and authenticated actor
(`coreContainerForTenant` via `registerAllTools` — `server.ts`, `tools.ts`).
Tenants listed in `MEMBERRY_TENANT_DATASTORES` are bound at boot to a container
backed by their own Neo4j/Redis (`setTenantContainer`, `bootstrap.ts`), which is
genuine physical isolation.
*Residual:* For every other tenant the per-session container wraps the *same*
shared service instances (`{ ...defaultContainer, tenantId, actor }`), separated
by `tenant_id` filtering rather than by datastore identity — logical, not
physical. The satellite tool packages (research/arch/code/wiki/graph) still use
their own `setXServiceInstances` module singletons and remain process-global,
which is why those domains are withheld from tenant sessions rather than served.

**T-E3 — Host compromise via tool input.**
*Mitigation:* No `eval`/shell execution on user input in the core paths; file I/O
is path-validated (T-I5); Cypher is parameterized in scoped queries and
validated+READ-boxed in the raw path.

---

## 4. Residual risks / known limitations

These are accepted or in-progress limitations operators should weigh against
their deployment model. None contradict the controls above; they bound them.

1. **Shared service instances behind per-session containers.** Each session does
   get its own `ServiceContainer` bound to its tenant and actor, but unless the
   tenant is listed in `MEMBERRY_TENANT_DATASTORES` that container wraps the same
   process-wide service instances and one datastore identity, separated only by
   `tenant_id` filtering. The satellite tool packages are still module
   singletons. Logical isolation, not a physical multi-tenant boundary.

2. **`berry_query` is read-only but not project-scoped.** The admin raw-Cypher
   tool can read across all projects in the graph. It is disabled by default and
   intended as an admin/diagnostic tool; enabling the `admin` domain is not gated
   per-actor.

3. **Progressive disclosure is not authorization, and the capability model is
   opt-in.** Disabled-by-default domains reduce context clutter and accidental
   use, but they do not restrict anyone: with
   `MEMBERRY_CAPABILITY_POLICIES_V1` unset — the default — any authenticated
   caller can enable any domain, including `admin`. Configuring policies gives a
   real per-actor grant model (T-E1); nothing enables it for you.

4. **Audit covers the store path, not every mutation.** The append-only audit log
   currently records the `berry_store` write. Block-level and admin mutations are
   not yet uniformly audited.

5. **Tenant isolation is logical (enforced), not physical.** Opt-in multi-tenant
   mode (`MEMBERRY_TENANT_TOKENS`) binds each session to a tenant and ENFORCES a
   `tenant_id` filter on every exposed memory read/write (semantics, facts,
   blocks, grep), with a default-deny tool surface and an adversarial cross-tenant
   test. This is logical isolation over one shared Neo4j + Redis — strong enough
   for cooperative multi-tenancy, but not a physical (per-database) boundary.
   Residual gaps: raw Cypher (`berry_query`) and the not-yet-tenant-scoped
   satellite domains (code/arch/wiki/graph/research) are *withheld* from tenant
   sessions rather than leaked — `berry_context`/`berry_ask` are tenant-scoped
   and are served, with `berry_context` forced to the `ranked` strategy for named
   tenants; the Redis block cache is tenant-namespaced
   (`amp:block:<tenant>:…`, `redis/src/blocks.ts`) and used for every tenant, but
   the `default` tenant still shares one keyspace with legacy rows that carry no
   `tenant_id`. Highly-sensitive or regulated
   tenants should use a dedicated deployment (the per-session `ServiceContainer`
   seam supports routing a tenant to its own datastore).

6. **No JWT/OIDC / no fine-grained authz.** Authentication is static Bearer
   tokens (single or per-actor named). There is no token expiry, no OIDC
   integration, and no per-resource authorization beyond project-tag scoping on
   the scoped read/write paths. Rotation/revocation requires editing env and
   restarting.

7. **No rate limiting or per-actor quotas.** Result sizes, input lengths, request
   bodies, and receive timeouts are capped, and raw Cypher carries a transaction
   timeout — but request rate, concurrency, and the cost of scoped/retrieval
   queries are not bounded. A compromised or abusive trusted actor can still
   cause load (T-D1, T-D2).

8. **Secret redaction is best-effort and opt-in.** `MEMBERRY_REDACT_ON_INGEST`
   uses conservative patterns; the export-boundary pass is a backstop but neither
   guarantees zero secret leakage. Do not deliberately store credentials.

9. **Memory content is sent to OpenAI** for embeddings/extraction/synthesis unless
   `OPENAI_API_KEY` is unset (which disables embeddings and falls back to lexical
   retrieval). There is no on-prem inference path today.

10. **In-process retry for fact extraction.** Background enrichment is not yet
    durable across a process crash; the episode is persisted but its extracted
    facts may be lost on an ill-timed restart. Durability work is in progress.

11. **Stored prose is not semantically sanitized.** A memory system inherently
    returns what was stored; poisoned/incorrect content can later influence an
    agent. Mitigated by trusting callers and scoping tightly, not by the store.

12. **The wiki viewer has no authentication.** Port `3200` reads all compiled
    memory and accepts writes (`/api/edit`, `/api/settings/hooks-install`) with
    no token and no origin check, is unaffected by `MEMBERRY_READONLY`, and binds
    all interfaces by default. It ships in the bundled compose stack. Network
    placement is the whole of the control (T-I6, T-T6).

13. **Both HTTP listeners bind all interfaces by default.** Neither the MCP
    server nor the wiki viewer restricts itself to loopback unless the operator
    sets a host (`MEMBERRY_HOST` / `MEMBERRY_WIKI_HOST`), or runs under compose,
    where `MEMBERRY_PUBLISH_HOST` defaults to `127.0.0.1`. A systemd or
    `npm start` deployment that sets neither is LAN-reachable.

---

## 5. Summary of controls → assets

| Control | Reference | Protects |
|---------|-----------|----------|
| Bearer auth, fail-closed token resolution, constant-time compare | `mcp/src/server.ts` | A1–A5 |
| Origin allowlist + scoped CORS | `mcp/src/server.ts` | A1–A3 |
| `/healthz` unauth vs `/readyz` auth split | `mcp/src/server.ts` | A4 |
| Read-only Cypher validation + READ-session enforcement | `neo4j/src/query.ts` | A1, A5 |
| `MEMBERRY_READONLY` write rejection | `core/src/service.ts`, `core/src/blocks.ts` | A1 |
| Ingest-time + export-time secret redaction, export allowlist/escape | `core/src/redact.ts`, `graph/src/allowlist.ts` | A2 |
| Append-only audit log + unique-id migration | `neo4j/src/audit.ts`, `neo4j/src/migrations.ts` | A5 |
| Mandatory project-tag scoping + scoped retrieval | `core/src/service.ts`, `neo4j/src/query.ts` | A3 |
| Path validation against allow-dir | `wiki/src/tools.ts` | A7 |
| Progressive disclosure (admin/destructive disabled by default) | `mcp/src/tools.ts`, `mcp/src/server.ts` | A1 (context hygiene) |
| Per-actor capability policies (opt-in, `MEMBERRY_CAPABILITY_POLICIES_V1`) | `core/src/capability-policy.ts`, `mcp/src/capability-runtime.ts` | A1–A3, A5 |
| Result/input caps, optimistic concurrency, graceful shutdown | `neo4j/src/query.ts`, `core/src/blocks.ts`, `mcp/src/server.ts` | A6 |
