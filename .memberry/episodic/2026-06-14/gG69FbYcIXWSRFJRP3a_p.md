---
id: gG69FbYcIXWSRFJRP3a_p
session_id: session-20260614-ag3ntic-morph
agent_id: default
task: [project:ag3ntic] WQ-D (reach) shipped + deployed to Cerebro
outcome: approved
created_at: "2026-06-14T08:48:25.009Z"
---

WQ-D (reach) of the AG3NTIC autonomous roadmap is FULLY SHIPPED and deployed to Cerebro on 2026-06-14. main is at 62a6fc0; prod alembic head is 20260613_2901.

Three work-areas, all green: (1) R-INF-2 shared-storage volume mount into employees — a new gated infra "mount_shared_storage" proposal/executor that binds named volumes into employee runtimes via a single _shared_mount_binds source threaded into all three orchestrator run_container sites, plus a remount_employee redeploy verb; data-bearing targets are floored owner-critical. (2) Channels R-CHN-1/2/3 — a new platform_core/channels package (Slack inbound over a thin channel-gateway Socket-Mode terminator that holds no Docker and is off the docker_proxy net; channel inbound rides the SINGLE run spine chat.send_message->start_run; race-safe dedupe via uq_channel_message_event inserted before start_run; webhook intake; cron-scheduled runs). (3) R-CAP-2 app-container->capability bridge — app_capability.py turns an approved app ContainerResource into a gated mcp_custom_container capability; operator can only DRAFT a ToolInstallProposal (expose_app_as_capability), the existing R-GOV-3 maker!=checker accept path registers; HTTP transport (T8) is human-gated/deferred.

Both maker!=checker verifiers (run on Sonnet, different model than the Opus author) returned PASS with 0 blockers/0 majors; all four hard laws verified intact. Finish gate: full suite 1496 passed exit 0; ruff + cleanliness M12 clean. Migration chain is now 2601->2701(WQ-C)->2801(R-INF-2)->2901(Channels), single head verified. E2E-GOLD-01 post-deploy: 16/16 + audit rows.

KEY DEPLOY LESSON: WQ-D added a NEW Python dependency (croniter, for the R-CHN-3 cron sweep). The standard source-only Cerebro deploy (docker compose ... restart api worker) does NOT pip-install new deps — a plain restart would have crash-looped api/worker on ModuleNotFoundError. When a phase adds a requirements.txt/pyproject dep, the deploy MUST rebuild the image: docker compose --env-file .env -f infra/docker-compose.yml -f infra/docker-compose.override.yml up -d --build api worker (the --build invalidates the pip layer and recreates the containers; the entrypoint still runs alembic upgrade head). Always grep the phase diff for requirements.txt/pyproject.toml changes before choosing restart vs rebuild. The new channel-gateway compose service was intentionally NOT started (no Slack creds yet) by excluding it from the build/up list; the api-side webhook+internal+cron intake is what ships.

NEXT: WQ-E (insight & breadth) — Memory scopes (R-MEM-1..5), Observability KPIs (R-OBS-2/3/4), Skills/cockpit/Hermes viewer/cleanup. WQ-E items are UI-bearing, so deploys WILL need a web rebuild. New migrations chain off 2901.