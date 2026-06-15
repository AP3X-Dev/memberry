---
id: ufV1kS0FSjbJmaxwOsfv8
session_id: session-20260613-ag3ntic-infra-ui
agent_id: default
task: Build Infrastructure UI (WQ-23 Task 16) for AG3NTIC console — proposals inbox + resources tab, approval gating, secret-safety, nav wiring
outcome: approved
created_at: "2026-06-13T10:29:01.670Z"
---

Built the Infrastructure Service UI (WQ-23 / Task 16) in platform-infra-ui/apps/web (AG3NTIC UI2 design). Files: lib/types.ts (+InfrastructureProposal, DockerPlan, InfrastructureResource, AuthMe, SecretRequirement, ApprovalRequirements); new components/infrastructure/InfraViews.tsx (shared views + computeApproveGate); new app/(app)/infrastructure/page.tsx (tabbed Proposals/Resources, right-side detail drawer); nav wiring in Sidebar.tsx + MobileChrome.tsx + navIcons.tsx (added "infra" glyph = stacked-layers/server to BOTH the shared GLYPH map and Sidebar's local GLYPH map) + AppContent.tsx PORTED set + globals.css (added ag-drawer-r right-side keyframe); e2e/infrastructure.spec.ts (4 tests, mirrors tools-library.spec proxy-stub pattern).

Key implementation facts:
- /auth/me returns { id, email, name, role, memberships[] } (per-workspace role). Used id for self-approval check, role available for owner gating.
- Approval gating (computeApproveGate): decidable only from proposed|ready (else "already actioned"); validation_errors non-empty → disable + render errors; currentUserId===requested_by → disable "Another admin must approve your request."; approval_requirements.critical===true → "Approve (owner)" label + "Requires an owner to approve". Server is source of truth — accept/reject/withdraw 403/409 render via errorEnvelope (ErrorEnvelopeView), drawer stays alive.
- Secret safety: secret_requirements render as "mint {kind}"/"resolve {ref}" LABELS only, no value, no reveal control. Minted env keys tagged "· secret" (value never in payload).
- List query polls refetchInterval 20s; detail 20s; resources 30s.
- Resources tab: read route may not exist — retry:false, 404/not_found/request_failed → honest "Resource read API not available yet" empty state; drift badge when status==='drift'||health==='missing'.
- Drawer uses a route-less openId state (deep state, scrim + ag-drawer-r animation).

Verification: npm run build PASSED (/infrastructure route registered), tsc --noEmit clean, playwright --list shows 4 tests. No ESLint config in repo (lint not part of gate).