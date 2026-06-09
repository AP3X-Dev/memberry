---
id: FFwU5Zbgxf1ipB2u_P7w0
session_id: session-20260608-ag3ntic-morph
agent_id: mcp
task: [project:ag3ntic] P2.1 COMPLETE checkpoint — catalog + templates + auto-seeding landed
created_at: "2026-06-09T00:38:07.006Z"
---

GOLDEN-PATH P2.1 COMPLETE (branch morph/opt-hardening, NOT pushed). Suite 290→336 green. Linear autonomous execution per user directive.

COMMITS THIS SESSION (after baseline 8230fd1):
- e0f0bd0 manifest.py +4 types (internal_api/hosted_api/browser_worker/mcp_custom_container) [304]
- f002fd4 recon briefs (docs/superpowers/plans/briefs/)
- 3b8cec1 crm-mock + web-research backing services (platform_core/crm_mock, /web_research; mounted /crm/v1, /research/v1) [319]
- 0fff0e1 8 capability YAMLs (packages/manifests/seed/capabilities/) + seed.py YAML loader (seed_manifests()) + register_capability derives status connect_required vs available [330]
- 9789e85 3 employee templates (packages/manifests/seed/employees/{sales-researcher,appointment-setter,customer-support}/ = template.yaml + §11.11 employee-spec.yaml) + employees/templates_seed.py + WIRED both seeders into main.py lifespan via _seed_catalog() [336]

KEY: the 3 template employee-spec.yaml were extracted verbatim from the already-validated dicts in tests/test_employee_spec.py (SALES_RESEARCHER/APPOINTMENT_SETTER/CUSTOMER_SUPPORT) — they pass validate_spec. Capability slugs in templates all resolve against the 8-cap catalog. image_digest in template specs is the §11.11 placeholder sha256:1*64 (resolve at launch). Seeding now runs at app startup (lifespan), idempotent — previously seed_builtin_capabilities ran only in tests.

DEFERRED (non-blocking, noted): ancillary template files (soul.md.j2, eval-cases.yaml, example-tasks.md, README.md); helpdesk-mock + kb-mock backing services (Customer-Support only); per-capability eval_cases seeding (eval_cases table is employee-scoped not capability-scoped — test_task lives in manifest metadata instead); alembic data migration for seeds (replaced by lifespan seeding by design).

REMAINING LINEAR PLAN (dependency order): F) MCP GATEWAY SHIM + mcpServers provisioning at session/new — THE execution pipeline that makes capabilities actually callable by the employee over ACP. THIS IS THE BIG ONE and the real bottleneck for a runnable golden path; absent today (session_new gets mcpServers:[]; gateway is decision-only; non-MCP backings must be fronted as MCP tools by an MCP gateway server — likely the untracked packages/mcp-server/ag3ntic_mcp, extended). Needs full context — best tackled fresh. G) P2.2 EmployeeRevision re-mint (§11.8) — brief at docs/superpowers/plans/briefs/p2.2-remint.md; bounded; new platform_core/employees/revisions.py + edits to runtime_orchestrator/service.py (remove hardcoded revision_number=1) + operator/service.py (replace operator_proposal_revise_unsupported raise). H) P2.3 DB constraints — brief p2.3-constraints.md; alembic migration (next rev = 20260608_0004); apply ONE constraint at a time, SQLite needs postgresql_where for partial indexes; the OTHER item that stalled last session. I) P3 chat surface.

NEXT ACTION: doing P2.2 (re-mint) now — bounded + committable.