# SEC-001B authenticated runtime binding design

Status: design freeze candidate; no runtime behavior, deployment, or live service is changed by this document.

Source custody: exact master `b69caf03c99d2ddb7c69a4429b622d966fd1d81d` (roadmap merge PR #51).

## Outcome and boundary

SEC-001A already supplies the strict `memberry.capability-policy` v1 parser and evaluator. SEC-001B will bind that contract to the authenticated HTTP MCP composition root. When the operator supplies an approved capability-policy set, every registered MCP tool must be denied before its handler and services run unless the authenticated session actor, tenant, requested scope, domain, tool, and operation exactly match a grant.

The packet is default-off and reversible: an absent capability-policy setting preserves the current runtime byte path; a present setting enables authorization for the entire HTTP/SSE tool surface; an empty set denies every tool. The setting does not enable domains, make a tenant-unsafe tool available, alter retrieval, create credentials, change persistence, or authorize deployment.

STDIO has no authenticated session identity and is therefore not silently exempted: starting STDIO while capability policies are configured must fail before connecting the transport.

## Frozen effect chain

| Hop | Existing or owned binding | Required behavior |
| --- | --- | --- |
| Configuration writer | Operator-owned `MEMBERRY_CAPABILITY_POLICIES_V1` | JSON array of exact SEC-001A policy objects. Unset means off; present-but-empty means on and deny all. No token, secret, or policy content is logged. |
| Supported Core seam | Narrow exports from `packages/core/src/index.ts` | Export only the SEC-001A constants, types, parser, request parser, evaluator, and contract error needed by MCP. Update the existing Core test that currently pins the contract as unwired. Deep imports and copied policy logic are forbidden. |
| Configuration store | New private `packages/mcp/src/capability-runtime.ts` parser | Reject more than 65,536 UTF-8 bytes before `JSON.parse`, reject more than 128 policies, apply exact SEC-001A parsing, and require unique `(tenantId, actorId)` pairs. Expose only a frozen lookup closure over private nested maps; no `Map` escapes. Reject malformed, duplicate, proxy/accessor, oversized, or unsupported data at startup. |
| Identity reader | `packages/mcp/src/server.ts:696-704` and `742-752` | Use only the actor and tenant resolved from the bearer token and frozen into the MCP session. Never accept actor or tenant from tool arguments. Existing follow-up session/token equality checks remain authoritative. |
| Policy reader | `registerAllTools` in `packages/mcp/src/server.ts:259-310` | Select one policy by exact authenticated `(tenant, actor)`. In enabled mode, a missing policy is a deny-all session, not a fallback. |
| Authorization gate | Real-`McpServer` method interposition in `packages/mcp` | In enabled HTTP sessions only, install one own `tool` method on the real per-session `McpServer` before any registration. The interposer captures the real prototype method, finds and wraps the final handler argument for every supported overload, and invokes the captured method with the real server receiver. All other methods, returned `RegisteredTool` handles, enable/disable state, and `sendToolListChanged()` stay on the real server. Unknown names, unsupported overloads, or a second installation fail before registration. Default-off registration receives the untouched server. |
| Existing containment gate | `packages/mcp/src/tools.ts:1465-1479` and `server.ts:286-303` | Capability grants never bypass the existing tenant-safe allowlist or cause single-tenant satellite packages to be registered in multi-tenant mode. Domain enablement remains presentation only, never permission. |
| Effect | Original package handler | Runs only after both existing containment and SEC-001B authorization allow it. |
| Evidence gate | New pure unit tests plus authenticated MCP server tests | Prove default-off compatibility, enabled missing-policy denial, exact allow, actor/tenant/project/tool/operation mismatch denial, dynamic-operation denial, zero callback on denial, all-tool matrix coverage, STDIO refusal, and no tenant-safety bypass. |

## Configuration contract

`MEMBERRY_CAPABILITY_POLICIES_V1` is a JSON array. Each element is parsed by `parseActorCapabilityPolicyV1`; the runtime does not define aliases, wildcards, roles, inheritance, administrative bypasses, coercion, or defaults.

The canonical variable is read through the existing `readEnv` compatibility
helper, so the legacy `AMP_CAPABILITY_POLICIES_V1` name receives the standard
one-time deprecation warning and is otherwise identical. An empty environment
string is absent/off under the existing helper; the JSON string `[]` is
present/on and deny-all.

Illustrative shape only:

```json
[
  {
    "contractId": "memberry.capability-policy",
    "contractVersion": "1.0.0",
    "actorId": "alice",
    "tenantId": "acme",
    "grants": [
      {
        "scope": { "kind": "project", "projectId": "project:memberry" },
        "domainId": "memory",
        "toolId": "berry_memory_read",
        "operation": "read"
      }
    ]
  }
]
```

The operator must use the same actor and tenant bytes produced by the existing token maps. Capability configuration never contains bearer tokens. Duplicate `(tenantId, actorId)` entries are rejected instead of merged.

The runtime freezes `CAPABILITY_RUNTIME_MAX_CONFIG_BYTES_V1 = 65_536` and
`CAPABILITY_RUNTIME_MAX_POLICIES_V1 = 128`. Tests cover byte and count values at
`N` and `N+1`; the byte gate performs a character-count precheck before UTF-8
measurement so an obviously oversized string is rejected before a second large
allocation.

Configured capability policies require bearer-token authentication. Combining a present policy setting with `MEMBERRY_ALLOW_UNAUTHENTICATED=true` is a startup error; an `anonymous` or caller-supplied identity is never accepted as capability authority. The existing generated-token path remains an authenticated `default` actor/tenant pair and therefore requires an exact `default` policy when authorization is enabled.

After the existing token maps are built and before the HTTP listener starts,
every reachable token-derived `(tenant, actor)` pair is validated by constructing
and parsing a fixed SEC-001A check request. This reuses SEC-001A's exact ASCII
identifier grammar and 200-byte actor/tenant limits instead of duplicating them.
An unrepresentable configured identity is a generic startup error that contains
neither token nor identity bytes. Policy-disabled mode retains the existing token
name compatibility unchanged.

## Effect-bound scope derivation

There is no generic project extractor. Project-looking arguments are not proof
that every handler effect is project-confined. The matrix therefore freezes two
scope rules:

- `exact-scope`: only the six memory-block tools may derive a project request.
  Their validated `scope` argument must be one exact SEC-001A
  identifier beginning with `project:` and is passed byte-for-byte to every
  downstream read/write filter. Missing, invalid, normalized, or non-project
  scope requires `{ kind: "tenant" }`. These tools have no second project/path/
  entity input whose effect can escape that value.
- `tenant-only`: every other tool always requests `{ kind: "tenant" }`, even if
  its arguments contain `scope`, `project_tag`, `tags`, `tag_scope`,
  `project_name`, an entity, a repository path, a campaign, or prose that looks
  project-scoped. A project grant cannot authorize it in SEC-001B.

This deliberately withholds project grants from `berry_grep`, `berry_store`, `berry_load`,
retrieval, research, architecture, code, wiki, and graph operations. Examples
that require tenant authority include `berry_braindump` and `berry_wiki_sync`
because they can compile `project_tag: 'all'`, `berry_code_index` because its
path and project tag are independent and the handler normalizes the tag, and
`berry_grep` because its Entity lane currently applies only a tenant filter, not
the supplied scope. Graph export also requires tenant authority because
filesystem output is not project-bound. Adding canonical
resource identifiers and compound-resource authorization belongs to SEC-003.

## Complete registered-tool matrix

The matrix is exhaustive for the 49 names in `AMPMCPServer.toolNames` at the frozen source. A source assertion must fail if a registered name is added, removed, or left without metadata. `domainId` and `toolId` comparisons are exact and case-sensitive.

| Domain | Tool | Operation | Scope rule |
| --- | --- | --- | --- |
| memory | `berry_load` | `read` | tenant-only |
| memory | `berry_store` | `create` | tenant-only |
| memory | `berry_memory_read` | `read` | exact-scope |
| memory | `berry_memory_insert` | `update` | exact-scope |
| memory | `berry_grep` | `read` | tenant-only |
| memory | `berry_memory_replace` | `update` | exact-scope |
| memory | `berry_memory_rewrite` | `update` | exact-scope |
| memory | `berry_memory_promote` | `update` | exact-scope |
| memory | `berry_memory_archive` | `delete` | exact-scope |
| temporal | `berry_timeline` | `read` | tenant-only |
| temporal | `berry_fact_diff` | `read` | tenant-only |
| admin | `berry_query` | `admin` | tenant-only |
| admin | `berry_consolidate` | `read` for `status` and `review` without a decision; `admin` for `run`, `dream`, or `review` with `approve`/`reject` | tenant-only |
| admin | `berry_bootstrap` | `create` | tenant-only |
| admin | `berry_resolve` | `read` | tenant-only |
| admin | `berry_ingest_codebase` | `create` | tenant-only |
| admin | `berry_provenance` | `read` | tenant-only |
| tools | `berry_tools` | `read` for `list`; `update` for `enable`/`disable` | tenant-only |
| retrieval | `berry_context` | `read` | tenant-only |
| retrieval | `berry_ask` | `read` | tenant-only |
| retrieval | `berry_feedback` | `update` | tenant-only |
| research | `berry_research_init` | `create` | tenant-only |
| research | `berry_research_log` | `create` | tenant-only |
| research | `berry_research_context` | `read` | tenant-only |
| research | `berry_research_tree` | `read` | tenant-only |
| research | `berry_research_contradictions` | `read` | tenant-only |
| research | `berry_research_consolidate` | `update` | tenant-only |
| arch | `berry_arch_register` | `update` | tenant-only |
| arch | `berry_arch_relate` | `create` | tenant-only |
| arch | `berry_arch_aspect` | `create` for `create`; `update` for `apply`; `delete` for `remove`; `read` for `list`/`get` | tenant-only |
| arch | `berry_impact` | `read` | tenant-only |
| arch | `berry_arch_drift` | `update` for `mark_fresh`; `read` for `check`/`check_all`/`list_stale` | tenant-only |
| arch | `berry_arch_context` | `read` | tenant-only |
| code | `berry_code_index` | `update` | tenant-only |
| code | `berry_code_search` | `read` | tenant-only |
| code | `berry_code_ast_grep` | `read` | tenant-only |
| code | `berry_code_symbols` | `read` | tenant-only |
| code | `berry_code_deps` | `read` | tenant-only |
| code | `berry_code_context` | `read` | tenant-only |
| code | `berry_code_watch` | `create` for `start`; `delete` for `stop`; `read` for `status` | tenant-only |
| wiki | `berry_compile` | `update` | tenant-only |
| wiki | `berry_ingest` | `create` | tenant-only |
| wiki | `berry_lint` | `read` | tenant-only |
| wiki | `berry_braindump` | `create` | tenant-only |
| wiki | `berry_wiki_sync` | `update` | tenant-only |
| graph | `berry_graph_report` | `read` | tenant-only |
| graph | `berry_graph_export` | `read` when `output_path` is absent; `create` when it is present | tenant-only |
| graph | `berry_pr_impact` | `read` | tenant-only |
| graph | `berry_pr_conflicts` | `read` | tenant-only |

Unknown tool names, unsupported interposer overloads, and unknown or incomplete
dynamic-action combinations are denied or rejected before the original handler.
For example, `berry_consolidate review` without `proposal_id` is denied before
the handler, while absence/presence of `decision` selects `read`/`admin`.
Tool annotations are not authorization inputs: they contain known semantic
mismatches such as `berry_feedback` being annotated read-only while it writes
feedback.

The exact enabled-mode denial result is:

```json
{
  "content": [{ "type": "text", "text": "**Error:** capability denied" }],
  "isError": true
}
```

No actor, tenant, project, tool, operation, policy, or token bytes appear in the
wire result or startup errors.

For the v1 operation vocabulary, `berry_memory_insert` and
`berry_memory_rewrite` are classified as `update` logical upserts: the same
operation grant covers their documented create-if-missing behavior. SEC-001B
does not perform a pre-effect existence read or split one public tool into
state-dependent permissions. This convention is explicit and receives tests;
changing it requires a versioned policy decision rather than inference in the
gate.

## Bound implementation scope

The first runtime packet is limited to these paths:

- `packages/core/src/index.ts` and
  `packages/core/src/__tests__/capability-policy.test.ts` for the narrow supported
  SEC-001A export seam and its updated pin.
- new `packages/mcp/src/capability-runtime.ts` for configuration parsing, private
  lookup, identity/request construction, effect-bound metadata, operation
  resolution, real-server interposition, and the denial result.
- `packages/mcp/src/server.ts` for startup configuration/identity validation,
  STDIO refusal, and installation on authenticated per-session HTTP servers
  before `registerAllTools`.
- new `packages/mcp/src/__tests__/capability-runtime.test.ts` plus the smallest
  additions to `packages/mcp/src/__tests__/server.test.ts` needed for real HTTP,
  SSE/Streamable identity, STDIO, containment, and default-off evidence.

No satellite registrar, public MCP schema, tool handler, service container,
persistence package, migration, workflow, deployment file, or feature default is
changed. If the real-server interposer cannot preserve existing registrars and
handles within this scope, the packet stops for a new design; it does not widen
all seven registrar signatures opportunistically.

## Required tests and promotion evidence

- Core seam tests: the narrow root export is present and no unrelated SEC-001A runtime behavior changes; the old unwired-export assertion is replaced, not weakened silently.
- Pure config tests: absent/off; empty/on; one policy; duplicate identity; malformed JSON; non-array; exactly 65,536/65,537 UTF-8 bytes; exactly 128/129 policies; hostile accessor/proxy inputs at the value parser boundary; private lookup immutability; no sensitive bytes in errors.
- Pure gate matrix: all 49 registered names covered exactly once; every dynamic action/argument combination covered; unknown name/action/combination denied; exact operation/domain/tool used; only the six exact-scope memory-block tools can derive a project request; every other project-looking input remains tenant-only.
- Zero-effect tests: a sentinel handler and service callback remain at zero for every denial class; exact allow invokes once and preserves arguments/result.
- Real-server interposition tests: exercise all registration overloads on an actual `McpServer`, preserve all returned handles, prove 49/49 original handlers are wrapped, prove an unknown 50th name cannot register, and prove `berry_tools` enable/disable still changes handles and calls the real server's `sendToolListChanged()`.
- HTTP MCP tests: two actors and two tenants prove exact policy selection, session identity custody, cross-actor/cross-tenant denial, project-grant confinement, missing-policy denial, and unchanged follow-up session/token rejection.
- Compatibility tests: unset configuration leaves existing single-tenant, multi-tenant, retrieval, and progressive-disclosure behavior unchanged.
- Containment test: a grant for a tenant-unsafe tool still cannot register or execute that tool in multi-tenant mode.
- Hosted gate: Node 20, Node 22, integration, and the live authenticated MCP evidence chain must pass on the exact PR head and again on the merge commit.

## Stop conditions

Stop and do not implement or promote if any of these is true:

- A tool cannot be assigned an exact operation without inspecting effects or validated arguments.
- Authorization would have to trust actor/tenant supplied in tool arguments, infer a project from free text/path/entity names, or treat domain enablement as permission.
- The wrapper can run after any handler, service, provider, filesystem, or database effect.
- Enabled mode permits a missing policy, unknown tool, unknown action, parser failure, or ambiguous scope.
- A capability grant would bypass the existing multi-tenant containment gates.
- Exact-head hosted evidence is unavailable, source custody drifts, or review finds a P0/P1.

## Rejected approaches

- Passing actor/tenant in tool arguments: forgeable and not authenticated session identity.
- Adding policy to the shared mutable service container: risks cross-session policy bleed and confuses dependency injection with authorization custody.
- Gating only Tier 1/core tools: leaves retrieval and single-tenant satellite effects outside the claimed boundary.
- Trusting MCP read-only/destructive annotations: annotations are hints and already disagree with actual effects.
- Treating `berry_tools enable` as a grant: presentation/discovery is not authorization.
- Default-allow for missing actor policies: turns configuration mistakes into privilege.
- Project inference from `project_name`, paths, entities, campaigns, or prose: aliases/coercion violate the exact SEC-001A model.
- Generic extraction from `scope`, `project_tag`, `tags`, or `tag_scope`: a matching label does not bind a handler's secondary path, entity, repository, or global publication effect.
- A plain `{ tool() }` facade cast to `McpServer`: it does not preserve the nominal SDK receiver or `berry_tools` notifications. Enabled mode interposes on the real per-session server instead.
- Deploying or flipping configuration in this packet: promotion evidence is not deployment authorization.

## Rollback and honest closure

Rollback is a normal reviewed revert of the SEC-001B merge commit. Removing the configuration returns the runtime to the explicitly preserved default-off compatibility path; it is not a security rollback plan for an environment that depends on authorization.

SEC-001B closes only authenticated runtime consumption of the existing exact capability model. It does not close JWT/OIDC (SEC-002), resource-schema authorization and canonical project identifiers (SEC-003), mutation audit (SEC-004), satellite tenant qualification (SEC-005), or G6.
