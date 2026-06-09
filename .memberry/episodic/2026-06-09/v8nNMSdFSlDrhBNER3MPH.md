---
id: v8nNMSdFSlDrhBNER3MPH
session_id: session-20260608-ag3ntic-morph
agent_id: mcp
task: [project:ag3ntic] P2.2 complete checkpoint — EmployeeRevision re-mint landed; next P2.3 constraints / F execution pipeline
created_at: "2026-06-09T00:51:31.065Z"
---

GOLDEN-PATH progress (branch morph/opt-hardening, NOT pushed). Suite 290→345 green. Autonomous linear execution.

COMMITS THIS SESSION (after baseline 8230fd1): e0f0bd0 (manifest +4 types,304), f002fd4 (briefs), 3b8cec1 (crm-mock+web-research,319), 0fff0e1 (8 capability YAMLs+seed loader,330), 9789e85 (3 templates+lifespan seeding,336), 8bcacd6 (EmployeeRevision re-mint §11.8,345).

P2.1 + P2.2 COMPLETE. P2.2 detail: new apps/api/platform_core/employees/revisions.py = compute_versioned_spec_projection + projection_hash + mint_employee_revision (dedup: non-versioned edit reuses current rev; versioned edit mints N+1). create_employee_from_spec delegates to it (removed hardcoded revision_number=1 + _spec_hash). operator/service.py accept_proposal now handles revise path (target_employee_id set → mint N+1, audit employee.revised) — removed the operator_proposal_revise_unsupported raise (golden step 22 / AC-15 unblocked). revision.spec_hash now stores the versioned-projection hash (no test pinned it). 9 tests in test_employee_revisions.py.

REMAINING (dependency order):
- F) MCP GATEWAY SHIM + mcpServers provisioning at session/new — THE execution pipeline (makes capabilities callable over ACP). BIGGEST item, real bottleneck for runnable golden path, needs FULL CONTEXT. Absent today: session_new gets mcpServers:[]; gateway decision-only; non-MCP backings (internal_api/hosted_api) must be fronted AS MCP tools by an MCP gateway server (untracked packages/mcp-server/ag3ntic_mcp is the natural home, extend it). Mocks (crm-mock/web-research REST) + manifests + templates are READY to be wired.
- H) P2.3 DB constraints — brief docs/superpowers/plans/briefs/p2.3-constraints.md. CRITICAL APPROACH NOTE: test DB builds schema via Base.metadata.create_all (NOT migrations; client-fixture init_db STAMPS head when tables exist). So SQLite cannot ALTER-add constraints. CORRECT APPROACH: put constraints in models __table_args__ (create_all includes them on SQLite at table-create) + a Postgres-targeted alembic migration (next rev 20260608_0004). Apply ONE constraint at a time, run suite, fix fixtures that insert violating rows. ~59 enum CHECKs = high fixture-breakage risk; the named UNIQUEs (uq_runtime_live_per_employee partial, ck_grant_target, uq_grant, uq_messages_seq partial, etc.) are higher-value/lower-risk — do those first. EmployeeRevision already has uq_revision_number; EmployeeTemplate model comments uq_template_slug (not yet added).
- I) P3 chat surface (gap item 2): chat module/service/context/schemas → router/SSE → UI. Plan PHASE 3 in docs/superpowers/plans/2026-06-08-golden-path.md.

DEFERRED/NOTES: helpdesk-mock + kb-mock services (Customer-Support only); ancillary template files (soul.md.j2 etc.); operator revise audit action = "employee.revised" (ensure any future audit_events.action enum CHECK includes it + "capability.seeded"). Untracked packages/mcp-server/ still uncommitted (deliberate per pyproject/test fences) — will matter for F.