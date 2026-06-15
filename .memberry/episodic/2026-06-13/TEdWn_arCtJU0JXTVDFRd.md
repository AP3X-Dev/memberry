---
id: TEdWn_arCtJU0JXTVDFRd
session_id: session-20260613-ag3ntic-morph
agent_id: default
task: [project:ag3ntic] Plan R-EMP-3/4/5 + CI: upgrade-roll redeploy verb, ACP health gate, employee Hermes-home volume backup, CI wiring
outcome: approved
created_at: "2026-06-13T14:21:43.925Z"
---

[project:ag3ntic] Planned the R-EMP-3/4/5 + CI work-area. Verified anchors: orchestrator.py provision_employee short-circuits on healthy at lines 548-549; resume_runtime 784-860; restart_runtime recreate branch fires only when probe is None (container gone) at 1225-1252; delete_runtime keep_volume at 1049-1092; _health_gate docker-inspect stub at 256-279; _probe_runtime_features has 'hermes acp --check' at 285-324. router.py has launch/stop/pause/resume/restart/archive/delete verbs - NO redeploy. service.py has launch_employee/restart_employee_runtime. revisions.py mint_employee_revision advances existing_employee.current_revision_id. RuntimeInstance.image_digest (models.py:367)=current container digest; .revision_id (358)=provisioned revision; Employee.current_revision_id (287)=latest minted. Redeploy detect = runtime.revision_id != employee.current_revision_id OR image_digest mismatch. worker.sweep_once calls poll_runtime_health then reconcile_runtimes (worker.py:81-86); _poll_one uses container_health inspect only - ACP check belongs here. smoke_backup_restore.py covers PG+MinIO+Qdrant only. CI workflow production-readiness.yml references scripts/audit_production_readiness.py which DOES NOT EXIST. Tests at repo-root tests/, FakeDocker harness. Runbook references stale branch morph/opt-hardening (now main).