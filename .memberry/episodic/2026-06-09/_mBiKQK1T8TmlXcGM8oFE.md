---
id: _mBiKQK1T8TmlXcGM8oFE
session_id: session-20260608-ag3ntic-stagef
agent_id: default
task: Stage F Part 2 — DEPLOY SUCCESS: Stage F live + healthy on Cerebro, catalog seeded, MCP shim mounted + auth-gating
outcome: approved
created_at: "2026-06-09T08:48:03.546Z"
---

Stage F Part 1 code is now DEPLOYED, HEALTHY, and RUNNING on the live Cerebro ag3ntic stack (branch morph/opt-hardening @ f9d7457, git-based deploy to non-git ~/projects/ag3ntic-morph via the cerebro remote + checkout -f). api up on 8096 ({"status":"ok","service":"ag3ntic-api","runtime_provider":"docker"}), worker up. Catalog auto-seeded on boot: all 11 capabilities now present (browser, computer, crm_mock, filesystem, gmail, google_calendar, helpdesk_generic, knowledge_base, schema_validate, shell, web_research) — previously only `shell`. 3 employee templates seeded. MCP shim LIVE: POST /internal/mcp/{ws}/{emp}/{run} with no token -> 401 and bad token -> 401 (the _ShimASGIApp pre-check), confirming the shim is mounted + auth-gating in production. Rollback images tagged ag3ntic-{api,worker,web}:pre-stagef.

DEPLOY surfaced + fixed FOUR real packaging/config gaps (NONE in Stage F logic; all uncommitted live-config drift / 'works in repo, breaks in container'):
1. 6c73a9a: mcp missing from apps/api/requirements.txt (image install source) -> api ModuleNotFoundError. Added mcp>=1.25,<2.
2. compose --env-file: `docker compose -f infra/docker-compose.yml` loads interpolation .env from infra/ (none there) so ${AG3NTIC_*_PORT:-9100/9101/8000/3000} defaulted and 9100/9101 collide with the Nimbus stack's minio. Must invoke `docker compose --env-file .env -f infra/docker-compose.yml`. (deploy_cerebro_release.py still hardcodes COMPOSE without --env-file AND health-gates 127.0.0.1:8000 not the 8096 host port AND defaults path ~/projects/ag3ntic not -morph — repo fix still TODO.)
3. 56bcb3c: seed.py parents[4] for packages/manifests/seed/capabilities IndexErrors at IMPORT in the /app container (only 4 parents), crashing _seed_catalog -> api exit(3). Also bind-mounted ../packages/manifests into api+worker (image build context is apps/api so it can't COPY repo-root packages/).
4. f9d7457: templates_seed.py had the SAME parents[4] bug (seed/employees) — full-class fix: new platform_core/seed_paths.resolve_seed_dir(*subparts) (upward search + AG3NTIC_SEED_MANIFESTS_DIR override, None if absent), used by both seed.py + templates_seed.py. Grepped all parents[N] in apps/api: only those two were buggy.

Diagnosis technique that worked: a one-off `docker compose --env-file .env -f infra/docker-compose.yml run --rm --no-deps -T api python - <<PYEOF` stepping through the lifespan (validate->init_db->bootstrap->_seed_catalog->build_shim_manager->manager.run) with try/except+traceback per step — uvicorn swallows the lifespan startup traceback (just exits 3 after alembic), so the per-step harness is how you see the real error.

NEXT (Part 2, still supervised): the live-probe gate proper — bind crm_mock+web_research to a running employee, start a real Hermes 0.14.0 run that calls a capability tool, and observe: does Hermes emit ACP request_permission for the MCP tool or call it directly; the exact mcpServers wire-shape it accepts on session/new + session/load; whether it forwards headers verbatim on every MCP request; whether the post-approve re-prompt re-calls byte-identical args (args_hash match). Then the golden-path smoke E2E-GOLD-01. The mcpServers entry wire-shape ({type:http,url,headers:Bearer}) is the key unvalidated assumption that may need a code change.