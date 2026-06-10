---
id: cSMYPnmaXPhepAB2kpBf2
session_id: session-20260609-ag3ntic-phase-d
agent_id: default
task: [project:ag3ntic] Stage F Part 2 Phase D COMPLETE: live model-driven E2E through the per-employee shim — both GOLD runs passed; 3 live-only bugs found and fixed
outcome: approved
created_at: "2026-06-09T18:50:42.373Z"
---

Phase D executed end-to-end on Cerebro. DEPLOYED: morph/opt-hardening at e6c2696 (was dfeee30), SHIM_EXTERNAL_BASE_URL=http://192.168.0.25:8096 in ~/projects/ag3ntic-morph/.env. KEY DEPLOY FACT: api/worker get .env via compose env_file — baked at container CREATE, so `docker restart` does NOT pick up new env vars; must `docker compose --env-file .env -f infra/docker-compose.yml up -d api worker` (compose also needs --env-file for ${PORT} interpolation or api binds 8000 and collides — this is now fixed in scripts/deploy_cerebro_release.py).

RELAUNCH: provision short-circuits on a healthy runtime and `stopped→provisioning` is illegal — the only fresh-provision path is stop→delete→launch (delete_runtime has NO HTTP route; drove it via orchestrator functions in the api container). Delete wipes the employee volume: the demo's Hermes codex OAuth creds ($HERMES_HOME/auth.json) were destroyed. Re-authed via config.yaml model block {provider: custom, default: gpt-5.4, base_url: https://api.openai.com/v1} + custom_providers entry with the user's OpenAI key (avoided the host .codex-provider tokens — hermes warns refresh rotation would invalidate the platform's own codex session). Phase C injection preserves these keys on re-provision (merge keeps every non-mcp_servers key).

3 LIVE-ONLY BUGS (each invisible to the 435-test suite, found by the GOLD runs):
1. (0ecc942) ACP session/new REQUIRES mcpServers (empty list ok) — R5's removal was based on an inverted reading; live Hermes 0.14.0 rejects WITHOUT it ("Invalid params", pydantic field-required). session/load also requires cwd+mcpServers; session/resume requires cwd. All three fixed + tests now assert present-but-empty.
2. (8f231a5) Model guessed `query` for web_research.search; backing requires `q` → 422. Added query_params {name: required|optional} to InternalApiEndpoint manifests → advertised input schema; seed YAMLs declare q/url/q.
3. (69c7a27) uq_capability_version documented in models.py but NEVER created by the baseline migration, and register_capability inserted a duplicate (capability_id,'1.0.0') row per manifest-changing redeploy (live: 2 rows each for web_research/crm_mock). Fixed: upsert in register_capability + migration 20260609_0001 (dedupe keeping newest, re-point pins + latest_version_id, add constraint). Gate item #7 validated live: constraint now exists, 1 row per capability, 0 dangling pins.

GOLD RUN 1 (run_87063931983bb19f548bf772, succeeded): model called mcp_ag3ntic_web_research_search → tool.intercepted(allow)→tool.started→tool.completed; answer named the 3 seeded roofing companies. GOLD RUN 2 (run_c93f0668c62a03aae3f569f5, succeeded): update_record → tool.intercepted(approval_required) → approval.requested/pending → run waiting_approval → owner approved (apr_4ba662bf1f67d6465f30c6ca) → re-issue prompt → tool.intercepted(allow, standing grant) → executed ONCE → approval.executed. Gate #5 verified in DB: parked tcl_8e99742e... and re-issued tcl_1f78ddb5... share byte-identical args_hash 6159e4eb...; standing grant sg_d622... consumed; crm record deal_acme_reroof stage=negotiation.

FINAL: suite 440 passed (+5 tests), gate M12 PASS, temp API key ak_6a4be470420306be545966e0 deleted (401 verified), temp scripts cleaned. FOLLOW-UP: 33 pre-existing ruff findings (F401/E402, identical at 5742268) across untouched files — mechanical cleanup pending.