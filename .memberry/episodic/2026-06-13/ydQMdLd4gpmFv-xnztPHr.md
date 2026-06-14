---
id: ydQMdLd4gpmFv-xnztPHr
session_id: session-20260612-ag3ntic-wq23-impl
agent_id: default
task: WQ-23 remediation — fixed all 14 cross-task defects from the final adversarial sweep
outcome: approved
created_at: "2026-06-13T12:17:19.056Z"
---

After the final adversarial sweep found 14 cross-task integration defects, ALL were fixed (commits 3142ece, fc78ec3, 4634879, e232f07, c9ac332, 44a02b6). Root cause of the headline cluster: per-task pieces were sound but the SEAM wiring authority/ownership into the live accept/execute/reclaim chain was never built.

F1 (3142ece, H1/H2/H3/M2/M4): the authority gate was DEAD CODE on the live accept path — self-approval succeeded end-to-end (requested_by==decided_by==api_key.user_id by default). Fixed: accept_proposal now calls service.authorize_infra_decision (self-approval forbidden, agent can't decide, owner-for-critical via is_critical_infra_change) + service.record_infra_signoff (ApprovalRequest) before stamping accepted; router threads decider_actor_type="user"; folded L1 (imageless recreate refused). A separate checker authored test_infra_accept_authority.py (519aa54) BEFORE the fix — maker≠checker preserved. Existing accept tests updated to seed an authorized non-self decider.
F2 (fc78ec3, H4): reclaim_volume deleted by raw name with no ownership check → cross-tenant destruction. Fixed: resolve-or-refuse by (workspace_id, docker_name) live row; data_bearing derived from the ROW's exposed_by, not the caller arg; removed the caller data_bearing param.
F3 (4634879, H7): operator.tool_read audit logged raw secret_env/env (short plaintexts bypass value-pattern redaction). Fixed: whole-field scrub of secret_env/env in run_tool; AND reject a bare-string secret_env value at the builder (it would be stored as the mint kind = a proposal-body leak).
F4 (e232f07, H5): attach_network proposals false-completed a no-op (volume_network_changes never consumed). Fixed: execute_proposal routes attach proposals to a dedicated path that connects consumers + updates the members allow-list + audits infra_resource.network_attached, fail-loud on error.
F5 (c9ac332, H6): a resource_slug collision in _step_register poisoned the session and crashed _fail with PendingRollbackError. Fixed cleanly by PREVENTION: registry.get_infrastructure_resource_by_slug → _step_register ADOPTS an existing live resource instead of re-INSERTing (true idempotent resume). (Fighting the async-flush poison in _fail was the wrong layer.)
F6 (44a02b6, M3): the reconciler dangling pass false-flagged employee data volumes + runtime/capability networks (ag3ntic.managed but not infra rows) every sweep. Fixed: _NON_INFRA_KINDS carve-out (skip ag3ntic.kind in {employee,volume,runtime-network,mcp,sidecar,capability}); infra resources carry no ag3ntic.kind so true orphans still flag.

STATE: 38 WQ-23 commits on branch spec/docker-mcp-catalog-sync, tree clean, 208 infra tests green, app boots, NOT pushed. cerebro/main diverged (at 5a40168, the user's UI work). Deploy still needs: alembic round-trip on Postgres, Task 18 Cerebro smoke run, Task 16 web UI (handoff doc written), and a merge of spec branch with the diverged cerebro/main.