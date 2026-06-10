---
id: 8poNVmaDEeajnUujj08Em
session_id: session-20260609-ag3ntic-morph
agent_id: default
task: Stage F Part 2 R4 — live de-risk of the per-employee shim against real Hermes 0.14.0 on Cerebro
outcome: approved
created_at: "2026-06-09T15:03:25.043Z"
---

R4 DE-RISK PASSED (live on Cerebro). dfeee30 (per-employee shim) DEPLOYED to the live morph stack — pushed via `git push cerebro morph/opt-hardening`, `git checkout -f` on server (~/projects/ag3ntic-morph now at dfeee30), `docker restart ag3ntic-api-1 ag3ntic-worker-1` (bind-mounted apps/api). api healthy on 8096 ({"status":"ok"}); lifespan did NOT crash.

Test target: employee emp_8940c6de179980dcb572e6f9 (slug hermes-demo) in workspace wsp_65af44e194692baac5f5efae (slug demo), container employee-demo-hermes-demo. Bindings: shell, crm_mock, web_research (all attached).

PROVEN LIVE:
1. Minted a per-employee token server-side: docker exec ag3ntic-api-1 python -c "from platform_core.auth.security import sign_employee_shim_token as s; print(s(ws, emp, ttl=3600))".
2. From INSIDE the employee container (no curl; used /opt/hermes-agent/bin/python + httpx + mcp): GET /api/health=200 (employee net reaches host-published 8096 — gate #2 ✓); a real MCP initialize+tools/list against /internal/mcp/{ws}/{emp} returned exactly the 7 bound tools (crm_mock.{create_note,get_record,search_records,update_record}, shell.run_command, web_research.{fetch_page,search}) with crm_mock.delete_record CORRECTLY ABSENT (excluded+critical-deny). So per-employee token authn + the run_id-less mount + resolve_employee_tools + the StreamableHTTP json_response wire all work live (gate #4 ✓).
3. Wrote the Phase-C config artifact into the container's $HERMES_HOME/config.yaml (mcp_servers.ag3ntic = {url, headers:{Authorization: "Bearer <inline token>"}, enabled: true}) and ran Hermes's OWN client: `hermes mcp list` parsed it; `hermes mcp test ag3ntic` → "✓ Connected (72ms)", "Authorization: Bear***c62b" (Hermes FORWARDS the inline Bearer — gate #3 ✓), "✓ Tools discovered: 7". Then RESTORED config.yaml to pristine (model: only) from the .bak — demo container left clean.

CONCLUSION: the exact config.yaml shape is correct, INLINE token works (no .env), Hermes connects + forwards the header + discovers tools. With R1's per-session reload, launch-time config injection (Phase C) is fully de-risked. NOT yet validated live: model-driven tool EXECUTION + the approval/re-issue flow (resolve_active_run on a real run → gateway allow/approval → backing dispatch) — that's the Phase D E2E; exhaustively covered by in-process tests for now.