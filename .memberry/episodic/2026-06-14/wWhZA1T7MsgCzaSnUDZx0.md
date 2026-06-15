---
id: wWhZA1T7MsgCzaSnUDZx0
session_id: session-20260613-ag3ntic-morph
agent_id: default
task: [project:ag3ntic] WQ-C (reliability) finish gate — maker≠checker verifier verdict + fix
created_at: "2026-06-14T06:07:04.601Z"
---

WQ-C (employee lifecycle reliability: redeploy engine R-EMP-3, ACP health-gate R-EMP-4, employee-volume backup tier R-EMP-5, CI rewrite) passed its maker≠checker verifier (run on Sonnet, different model than the maker). VERDICT PASS: all four hard laws intact — L1 redeploy_runtime touches only docker_client (no docker SDK); L2 redeploy is a deterministic POST-approval lifecycle verb (manager+, idempotency scope `runtime.redeploy`, never mints EmployeeRevision nor calls approval/proposal paths); L3 single state-machine + audit chain, sole reconciler; L4 ACP liveness via `hermes acp --check` over docker exec, no Hermes HTTP run API. Migration 20260613_2701 (widens ck_idempotency_keys_scope CHECK for runtime.redeploy) confirmed in the real dir apps/api/alembic/versions/ with single head via `alembic heads`. One MINOR fixed (commit 3101bfa): redeploy_runtime was the only lifecycle verb missing the `employee is None` guard — a vanished employee row would AttributeError on employee.current_revision_id AFTER the `starting` transition (outside the DockerError/ValidationError handler) and strand the runtime; added a fail-closed guard `runtime_redeploy_employee_missing` up front + a regression test asserting no docker churn and unchanged status. Re-gate green: orchestrator suite 39, ruff clean, cleanliness M12 14/14. Lesson reinforced: the cross-model verifier catches what runnable gates structurally cannot (it independently re-ran `alembic heads`), and it flagged a genuine consistency gap the gates were blind to.</content>
<scope>project:ag3ntic</scope>
<outcome>approved</outcome>
<tags>project:ag3ntic, morph, reliability, runtime, verifier, deployment</tags>
<entities>RuntimeInstance, Hermes, platform, Operator</entities>
</invoke>
