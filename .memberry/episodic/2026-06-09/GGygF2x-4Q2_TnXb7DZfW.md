---
id: GGygF2x-4Q2_TnXb7DZfW
session_id: session-20260609-ag3ntic-morph
agent_id: default
task: Stage F Part 2 Phase C — orchestrator launch-time Hermes config injection
outcome: approved
created_at: "2026-06-09T15:18:40.528Z"
---

PHASE C DONE (committed 5742268 on morph/opt-hardening; NOT yet deployed). Suite 435 green, ruff clean, gate M12 PASS. TDD throughout.

NEW: platform_core/capabilities/shim_launch.py (pure builders, 9 tests):
- employee_shim_url(ws, emp) = (settings.shim_external_base_url or settings.api_base_url).rstrip('/') + /internal/mcp/{ws}/{emp}.
- build_employee_shim_token(ws, emp) = sign_employee_shim_token(ws, emp, ttl=settings.shim_token_ttl_seconds) (long-lived per-employee).
- build_employee_mcp_config(existing_yaml, *, shim_url, token) → yaml.safe_load-merge mcp_servers["ag3ntic"]={url, headers:{Authorization:"Bearer <inline token>"}, enabled:true} into existing config, PRESERVING model: block; tolerates None/""/non-dict existing (starts fresh). Inline token (no .env) — proven live in R4.

NEW: docker_client.write_text_file(name, path, content) — base64-encodes content into the exec argv and `printf %s '<b64>' | base64 -d > '<path>'` via exec_output (no put_archive; socket-proxy allows EXEC; container read_only except rw HERMES_HOME). Raises DockerError on non-zero.

WIRED: orchestrator._inject_employee_shim_config(container, ws, emp) reads existing config via exec_output(['cat', HERMES_CONFIG_PATH]) (missing→""), builds merged, writes it. Called from provision_employee AFTER the health gate, guarded `if employee.runtime == "hermes"`, BEST-EFFORT (try/except → log.warning; a write hiccup never fails an otherwise-healthy launch). HERMES_CONFIG_PATH = /home/hermes/.hermes/config.yaml. Added pyyaml>=6,<7 to requirements.txt (was transitive via uvicorn[standard]).

Test: test_runtime_orchestrator.test_provision_injects_shim_mcp_config — FakeDocker now stubs exec_output (cat→model: yaml) + write_text_file (records); asserts one write to .../config.yaml with model: preserved + mcp_servers.ag3ntic url/Bearer/enabled.

NEXT — Phase D (live, model-driven): deploy 5742268 (push cerebro + checkout -f + restart api/worker; SET SHIM_EXTERNAL_BASE_URL=http://192.168.0.25:8096 in the Cerebro .env first so the employee net can reach the shim — currently "" would fall back to api_base_url which may be wrong for the employee net). Re-launch hermes-demo (or a fresh employee) → confirm provision wrote config.yaml with the ag3ntic entry. Mint a temp API key server-side (bootstrap key STALE) → drive a GOLD run with a prompt that makes the model call web_research.search → watch tool.intercepted→started→completed; then crm_mock.update_record → approval_required → approve → re-issue executes once (validates the execution+approval path R4 didn't, + gate items #5/#7). Then fix scripts/deploy_cerebro_release.py (--env-file .env, health-gate 8096, default path ~/projects/ag3ntic-morph).