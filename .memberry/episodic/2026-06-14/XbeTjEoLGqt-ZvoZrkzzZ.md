---
id: XbeTjEoLGqt-ZvoZrkzzZ
session_id: session-20260614-ag3ntic-channels
agent_id: default
task: Implement Channels work-area R-CHN-1/2/3 (shared channel gateway, webhook intake, cron sweep) per IMPLEMENTATION-PLAN.md T1-T10 on branch morph/phase-d.
outcome: approved
created_at: "2026-06-14T07:51:29.707Z"
---

Implemented the AG3NTIC Channels work-area (R-CHN-1/2/3, PRP §7.7), tasks T1-T10, on branch morph/phase-d. All three adapters ride the single tasks.runs.start_run spine (L4: no Hermes HTTP run API).

KEY FACTS / DECISIONS:
- Channels migration is apps/api/alembic/versions/20260613_2901_channels.py with revision="20260613_2901", down_revision="20260613_2801" (the plan's stated 20260612_1101 down_revision was STALE; real head was 20260613_2801). Single head confirmed. NO schedules cron index created — ix_schedules_next already covers the cron-sweep query.
- New tables: channel_bindings (chn prefix), channel_messages (gwm dedupe ledger, unique on provider+external_event_id). New additive column employees.webhook_token_version (mirrors shim_token_version).
- DEDUPE is race-safe: ChannelMessage row inserted+committed BEFORE start_run; concurrent re-delivery loses the unique-constraint INSERT race (IntegrityError → no-op).
- Cron (R-CHN-3): create_schedule now ACCEPTS valid cron (enabled=True + next_run_at via croniter), rejects invalid with code schedule_cron_invalid. schedule_cron_sweep is GATED at sweep-time: no-ops unless settings.cron_sweep_enabled (default False) or settings.is_production. Cursor advanced ONLY on success, only inside the sweep; busy employee (CapabilityUnavailable) skipped without advancing/counting. Wired into worker.sweep_once after stale_run_sweep.
- Webhook (R-CHN-2): hidden per-employee webhook Schedule, invariant-guarded cron=None/enabled=False/next_run_at=None so cron sweep can NEVER select it; dispatched via run_schedule_now. Endpoint /channels/webhooks/{employee_id} at app root, double-gated source_ip_allowed (403) + verify_employee_webhook_token (401) + token_version>=employees.webhook_token_version.
- Gateway (R-CHN-1): thin apps/channel-gateway/ Socket-Mode container on control+runtime ONLY (never docker_proxy — L1), POSTs /channels/dispatch signed with channel_gateway_secret HMAC. The api owns the reply: inbound.await_and_reply tails runbus.subscribe_events server-side (NOT the auth-gated SSE) and posts via slack_client (graceful no-op if no credential).
- New config: slack_signing_secret, channel_gateway_secret, webhook_token_ttl_seconds, cron_sweep_enabled (default False).
- Routers: channels_router into /api/v1 loop; channels_internal_router + channels_webhook_router at app root (out of /api/v1).

CONSEQUENCE: T8 lifting the cron rejection broke two pre-existing tests in tests/test_tasks.py (they asserted schedule_cron_unsupported 422); updated them to the new contract (invalid cron → schedule_cron_invalid; valid cron accepted+enabled). The SPEC registry rule SPEC_SCHEDULE_CRON_AT_MVP (employees spec validator) is a DIFFERENT layer, untouched and still passing.

GATES: tests/test_channels*.py = 23 passed; full channel suite + extensions = 41 passed; alembic single head 20260613_2901; ruff clean on platform_core/worker.py/main.py + test files; cleanliness_gate.sh M12 PASS; worker+main import clean (croniter was already installed in the env). NOTE: alembic upgrade head on SQLite dies at baseline 20260607_0001 (documented pre-existing SQLite ALTER-constraint limitation, conftest uses create_all) — the channels migration's offline SQL is clean and SQLite-compatible (create_table/create_index/add_column only); Postgres applies the full chain.