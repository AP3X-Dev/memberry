---
id: -SOKN6X3HOEx0Ddq8OCXe
session_id: session-20260613-ag3ntic-autonomy
agent_id: default
task: Plan R-GOV-3/4/5/7: autonomy levels, accept-path hardening, Permissions tab, shadow mode
created_at: "2026-06-13T14:22:53.969Z"
---

Investigated R-GOV-3/4/5/7 anchors for the autonomy/accept-hardening/Permissions-tab/shadow-mode work-area.

KEY FINDINGS:
- PDP evaluate() at permission_gateway/service.py:225-291 resolves verdict via capabilities.service.effective_tool_actions(capability, {"permission_policy": policy}) where policy = current EmployeeRevision.permission_policy. The risk floor (never raise high/critical to allow) lives in effective_tool_actions at capabilities/service.py:391. The "mutating" flag IS already emitted per action (capabilities/service.py:400; manifest ActionPolicy.mutating default True at capabilities/manifest.py:103). This is the ONE place to add an autonomy overlay — POST effective_tool_actions, the autonomy tier adjusts the per-action default verdict bounded by manifest floor.
- Type-level maker!=checker pattern to replicate lives in infrastructure/service.py:667 authorize_infra_decision (actor must be 'user'; self-approval decided_by==requested_by forbidden; role floor admin/owner). Constants: _HUMAN_ACTOR_TYPE='user' (line 592), _INFRA_DECISION_FLOOR='admin' (588), ROLE_RANK from auth.deps (line 35). Called from infrastructure/proposals.py:363 accept_proposal.
- tools/install_proposals.py:224 accept_proposal hardcodes actor_type='user' and takes only actor_user_id — NO maker!=checker, NO actor_type, NO requested_by. ToolInstallProposal model (models.py:486) HAS created_by_actor_type/created_by_actor_id/requested_by columns already. Router tools/proposals_router.py:145 gates min_role='admin' only.
- operator/service.py:1582 accept_proposal mints Employee+EmployeeRevision; records actor_type='user' if actor_user_id else 'operator'. OperatorProposal model (models.py:1056) has NO requested_by/created_by column — the maker is OperatorJob.created_by (models.py:1048). No type-level self-approval/human-only check on this path.
- effective_tool_actions read surface: capabilities/router.py GET /employees/{id}/capabilities -> _serialize_employee_bindings (193) passes permission_policy into serialize_binding (capabilities/service.py:656) which returns effective_tool_actions. Permissions tab is a PURE read over this existing endpoint.
- Frontend tabs at apps/web/app/(app)/employees/[id]/page.tsx:62-68 (overview|skills|artifacts|activity). Add "permissions".
- Workspace approval_defaults: workspaces/router.py:183 PATCH /settings (owner-only) merges body.approval_defaults into workspace.settings; _settings_view at 157. WorkspaceSettingsUpdate schema at workspaces/schemas.py:14. This is where the workspace-default autonomy tier goes.
- EmployeeSpec pydantic at employees/spec.py:360; permission_policy persisted from spec.permissions via revisions.py:237. No autonomy field anywhere yet (grep clean). record_audit at events.py:158.