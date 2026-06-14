---
id: a7GExivAk3l0GhrXEGVs8
session_id: session-20260613-ag3ntic-morph
agent_id: default
task: Plan one-shot skills + employee cockpit + Hermes UI viewer + API_SERVER cleanup (R-SKL-2/3, R-UX-4/5)
created_at: "2026-06-13T14:44:24.433Z"
---

Plan grounded for the one-shot-skills/cockpit/Hermes-viewer work area. Verified anchors:
- Run preamble chain: skills/service.compose_run_preamble (pure) ← compose_preamble_for_employee ← tasks/runs.run_preamble ← run_worker.execute_acp_run (line ~210, gates on `prompt is None` so resume re-issue gets NO preamble) → RunStartRequest.preamble (base.py) → hermes_adapter.start_run (line ~462, applies ONLY when session.fresh after session/new). Inline fallback path: hermes_run_executor builds `wire_prompt = preamble + prompt` at runs.py:845.
- One-shot design: add `one_shot_skill` to run.input (chat ChatMessageIn.content sibling). compose_run_preamble takes `skills` list of objects with .slug/.name/.instructions — a one-shot is just an extra ad-hoc skill-like object appended. Must thread through run_preamble→RunStartRequest.preamble (both worker AND inline). Recorded redaction-fenced on run.started event payload as preamble_chars + one_shot ref (NEVER full text); store the one-shot text on run.input (redacted via events._redact_payload).
- Cockpit: employee detail page apps/web/app/(app)/employees/[id]/page.tsx has Tab type (overview|skills|artifacts|activity). Data already exists: Permissions←GET /employees/{id}/tools (effective_tool_actions, capabilities/router.py:637); Config/Model←GET /employees/{id}/spec (revision spec.runtime.model); Sessions←GET .../chat/sessions; Cron/Triggers←GET .../schedules (tasks/router.py:307, manual-only MVP, cron rejected); Memory←memory router; Skills←existing tab.
- Hermes viewer (R-UX-5): viewer relay pattern in viewer/router.py (token+frame+stream, viewer/service.py). Dashboard is `hermes dashboard` :9119 (NOT :8642), FastAPI /api/*, NOT installed in image (only uvicorn) — needs fastapi added. HARD: dashboard config view exposes model api_key — must redact.
- API_SERVER cleanup: orchestrator.py:201-204 sets API_SERVER_ENABLED/HOST/PORT/MODEL_NAME env; orchestrator.py:632 sets runtime.api_base_url=http://{container}:8642; spec.py:142 ApiServer model (default 8642); operator/prompt.py:142 emits api_server in spec; models.py:365 RuntimeInstance.api_base_url column. NONE are CONSUMED (only set/stored) — :8642 has no server (contract: no /v1/runs, no :8642). Decision: PRUNE the env + prompt mention; KEEP the column/spec field (revision immutability + spec schema stability) but stop populating api_base_url.
- Latest alembic head: 20260612_1101_infrastructure (revises 20260612_1001). No migration needed unless adding a run column for one-shot (input JSON suffices — no migration).