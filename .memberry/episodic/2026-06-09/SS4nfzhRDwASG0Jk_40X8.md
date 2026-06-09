---
id: SS4nfzhRDwASG0Jk_40X8
session_id: session-20260608-ag3ntic-morph
agent_id: mcp
task: [project:ag3ntic] P2.1 progress checkpoint: manifest extension + mock services landed
created_at: "2026-06-09T00:15:41.661Z"
---

GOLDEN-PATH P2.1 PROGRESS (branch morph/opt-hardening, NOT pushed). Linear execution per user directive (autonomous, no questions). Baseline was 290 green @ 8230fd1.

COMMITTED THIS SESSION:
- e0f0bd0 feat(capabilities): extended CapabilityManifest (manifest.py) with 4 new discriminated types — mcp_custom_container, internal_api, hosted_api, browser_worker — + runtime sub-models + new rule SPEC_HOSTED_API_ENDPOINTS_INCOMPLETE. Existing 4 types (mcp_stdio/mcp_streamable_http/computer/builtin) + risk floors untouched. (304 green)
- f002fd4 docs: recon briefs at platform/docs/superpowers/plans/briefs/ (p2.1-*.md spec-grounded; exec-A/B/C code-grounded execution-path recon).
- 3b8cec1 feat(capabilities): first-party crm-mock + web-research backing services (platform_core/crm_mock/, platform_core/web_research/), mounted at app root (/crm/v1, /research/v1). crm-mock = deterministic workspace-keyed in-memory CRM seeded w/ Acme Roofing + 2 open deals. web-research = deterministic search + SSRF-guarded fetch_page. (319 green)

KEY FACTS LEARNED (verified in code, override the spec/briefs):
1. Real manifest validator = discriminated union; the spec's 7-type vocab maps onto these. mcp_stdio == spec's mcp_stdio_container (kept, not renamed).
2. EXECUTION PATH GAP (the real bottleneck): gateway is DECISION-ONLY (intercept_tool_call returns allow/deny, never executes). Employee executes its OWN tools via MCP servers handed to session/new. BUT hermes_adapter.py:325/327 call session_new() with NO mcp_servers → acp.py:434 sends mcpServers:[] → ZERO capabilities reach an employee over ACP today. Non-MCP backings (internal_api/hosted_api) can't return a result to the employee mid-prompt over ACP → they must be fronted AS MCP tools by an MCP gateway server (the untracked packages/mcp-server / ag3ntic_mcp is the natural home). The "MCP Gateway shim" = build that gateway MCP server + the mcpServers-provisioning at session/new. This is FOUNDATIONAL and absent.
3. eval_cases table is EMPLOYEE/REVISION-scoped, not capability-scoped → do NOT seed per-capability eval_cases; carry test_task in manifest metadata.
4. seed_builtin_capabilities is called ONLY in tests today (no production seeding wired). DECISION: keep ORM idempotent seeders in seed.py, extend to load YAMLs, add templates_seed.py, wire into LIFESPAN (not an alembic data migration). Alembic reserved for P2.3 schema constraints (next free rev = 20260608_0004).

REMAINING LINEAR PLAN: C) author 8 capability YAMLs (packages/manifests/seed/capabilities/) + refactor seed.py to load YAML + parametrized validation/idempotency test [IN PROGRESS — this is the unit that stalled last session; de-risked now by the proven validator]. D) 3 employee templates + templates_seed.py. E) wire seeding into lifespan. F) MCP gateway shim server + mcpServers provisioning at session/new (the big execution piece). G) P2.2 EmployeeRevision re-mint. H) P2.3 DB constraints (alembic). I) P3 chat surface. Type mapping for the 8 seeds: filesystem→mcp_stdio, browser→browser_worker, web_research/crm_mock/helpdesk_generic/knowledge_base→internal_api, gmail/google_calendar→hosted_api, computer→computer(exists).