---
id: vQt7jidZsDBoE0fSUi4IH
session_id: session-20260608-ag3ntic-morph
agent_id: mcp
task: opt session 13: remove vestigial AG3NTIC_GATEWAY_URL / AG3NTIC_AMP_URL from employee env
outcome: approved
created_at: "2026-06-08T12:04:46.117Z"
---

Hardening item #13 (dead-code) DONE, commit 10f5148 on morph/opt-hardening. _employee_env in apps/api/platform_core/runtime_orchestrator/orchestrator.py no longer renders AG3NTIC_GATEWAY_URL=http://permission-gateway:7100 or AG3NTIC_AMP_URL=http://memberry-api:7200 into the employee container env. Root cause: both were write-only vestiges of the deleted in-loop safety gate + memory sidecar — no permission-gateway/memberry-api service exists in the per-workspace runtime network, and a repo-wide scan confirmed nothing reads either var. Gating happens entirely control-plane-side (worker -> ACP adapter -> gateway_bridge -> PDP), so the employee container needs no outbound gateway/memory URL. Convention reinforced: the employee env (PRP §15.7) is minimal/internal-only; remove dead sidecar config rather than leave it beside live code. TDD: new tests/test_runtime_orchestrator.py::test_employee_env_drops_vestigial_sidecar_urls exercises the pure _employee_env renderer with a minimal spec stand-in (no DB/docker harness needed). Suite 241 -> 242 passed; cleanliness gate PASS. Mode B full-class scan: the only remaining permission-gateway hit is the FastAPI router TAG string in permission_gateway/router.py (legitimate control-plane route prefix, not a sidecar URL) — class clean. Next TODO is item #14 (AcpClient._read_loop silently drops non-JSON protocol lines, runtime_adapter/acp.py).