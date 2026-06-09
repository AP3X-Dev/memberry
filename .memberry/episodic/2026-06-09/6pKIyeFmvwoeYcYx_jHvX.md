---
id: 6pKIyeFmvwoeYcYx_jHvX
session_id: session-20260608-ag3ntic-morph
agent_id: mcp
task: HANDOFF / START HERE — continue Stage F (capability execution pipeline) autonomously, no human in the loop
outcome: approved
created_at: "2026-06-09T03:46:35.243Z"
---

HANDOFF for a fresh session to finish AG3NTIC golden-path Stage F (capability execution pipeline) AUTONOMOUSLY. The user has explicitly authorized full autonomous execution INCLUDING running Cerebro (192.168.0.25) — do NOT wait for a human. Operate in ultracode spirit (exhaustive, correct; use workflows for substantive/verification work).

== START ==
1. berry_load(task=this, tags=["project:ag3ntic"]). Read the two companion episodes: the Stage-F DESIGN DECISIONS episode and the VERIFIED CODE-CORRECTIONS episode, plus the IMPLEMENTATION PROGRESS (11/20) episode — they hold the exact contracts and gotchas. Read the plan: platform/docs/superpowers/plans/2026-06-08-golden-path-F-execution-pipeline.md.
2. session_id convention: session-YYYYMMDD-ag3ntic-morph. Every load/store tag project:ag3ntic.

== STATE ==
Repo: C:/Users/Guerr/Documents/AG3NTIC/platform, branch morph/opt-hardening (origin=Desktop pristine — NEVER push). 11/20 tasks committed (1e5d103..ac98d45). Full suite GREEN: `python -m pytest tests/ -q -p no:cacheprovider` = 374 passed. Cleanliness gate PASS (`bash scripts/cleanliness_gate.sh`). NOTE: the harness sometimes auto-backgrounds long pytest — read the temp output file or use `-k` slices + `timeout`.

== DONE == T5 endpoints+body_mode, T3 effective_tool_includes, T13 shim token, T6 complete_tool_call, T7+T19 seed YAML endpoints+delete_record critical, T14 hash-aware reseed, T4/T8/T2/T10 shim core (capabilities/shim.py + shim_names.py). All TDD, ruff-clean.

== REMAINING (build all in-process; order = waves D/E) ==
- T12 (DO FIRST, completes approve→execute correctness): in permission_gateway/service.py move the approved→executed transition + approval.executed emission OUT of intercept_tool_call's grant fast-path (~service.py 333-341) INTO complete_tool_call's success branch. Capture grant.approval_request_id and set it on the freshly-minted started ToolCall (~343) (today only the awaiting_approval row gets it ~441). MUST migrate 3 committed assertions pinning 'executed-at-re-issue': tests/test_resume_reissue.py::test_reissue_consumes_grant_and_finalizes_executed, ::test_reissue_with_reused_runtime_tool_call_id_consumes_grant, tests/test_tasks.py (~line 215 finalized=='executed'). After T12 the approval flips to executed only after complete_tool_call(success).
- T0: hermes_adapter.start_run records session.known_tool_names = await shim.resolve_employee_tool_names(...) on the _Session (for T11+T15).
- T11: tool_mapping.parse_capability_tool + gateway_bridge.decide auto-allow tools IN the per-run known-set (recompute via shim.resolve_employee_tool_names on decide's own session); unknown→native shell gate (default fail-closed). No double-gate. NEVER dot-split a display title to classify.
- T16: extend acp.AcpClient.session_load(session_id,*,mcp_servers=None) to send {sessionId,mcpServers} (today sends only {sessionId}, acp.py ~441-443); thread optional mcp_servers kw through _ensure_session→session_new AND session_load; start_run builds ONE shim mcpServers entry {url=settings.agent_runner_callback_base_url+/internal/mcp/{ws}/{emp}/{run_id}, headers: Authorization Bearer <sign_employee_shim_token>}; chat() passes none. The mcpServers wire-shape (type/url/headers nesting) is a one-line tunable to CONFIRM via the live probe.
- T15: hermes_adapter pump — suppress persisting tool.* run_events when the event's tool title is in session.known_tool_names (shim is sole tool.* producer for capability calls). Pump only has title/name — match by exact membership, never dot-split.
- T20: run_worker._resume_prompt carries verbatim (redact-safe) args; emit reissue_args_mismatch run_event on grant-miss re-park.
- T18: add config web_research_ssrf_resolve_dns: bool=True; pass resolve=settings.* in web_research/router.py fetch_page. WRINKLE: defaulting True would DNS-resolve example.com in the hermetic fetch tests under no-network CI → set the test env var false (conftest) OR skip resolve for cached seed URLs. Keep guard in the router only.
- T9 (LAST — see live caveat): capabilities/shim_transport.py — mcp.server.lowlevel.Server with @list_tools→shim.resolve_employee_tools, @call_tool→shim.execute_tool, reading+verifying the Bearer token (verify_employee_shim_token) and asserting token(ws,emp,run_id)==path; wrap in ONE StreamableHTTPSessionManager(stateless=True) entered in main.py lifespan; mount under /internal. Unit-test tools/list + an allow tools/call + token authn in-process via httpx ASGITransport. DoD must NOT claim in-code CORS exemption (app-wide CORSMiddleware applies; defer to ingress).
- T17 (after live-DB check): alembic uq_capability_version + uq_capability_slug, dedupe-then-constrain, no-op on clean DB.

== CEREBRO / LIVE (AUTHORIZED — do it yourself) ==
Use the `cerebro` skill for access. Discipline (blast-radius — Cerebro also runs the live /ag3ntic): run scripts/deploy_cerebro_release.py --dry-run FIRST; keep the isolated compose project `ag3ntic` at ~/projects/ag3ntic-morph, host ports web 8095/api 8096/minio 9110-9111; NEVER touch Nimbus/live /ag3ntic containers; spin a CONTAINED throwaway Hermes 0.14.0 container to answer the wire-shape questions BEFORE deploying the full branch. STOP and ask the user ONLY if access requires an interactive credential you cannot supply (SSH key prompt, registry login). 
LIVE PROBE QUESTIONS (answer via the contained Hermes probe, then adjust the isolated tunables in T16/T9): (a) does Hermes 0.14.0 emit request_permission for MCP tool calls or call them directly? (b) exact mcpServers wire entry shape in session/new (+ does session/load honor it)? (c) does it forward mcpServers[].headers verbatim per-request? — IF headers are init-only, the per-request bearer authn in T9 must move to init-time session binding → stateful transport (the one real rework fork; record a decision and proceed with the fallback). (d) stateless Streamable-HTTP conformance + protocol version. (e) post-approval byte-identical re-call of args so the grant matches.
GOLDEN-PATH SMOKE (F acceptance, run after the build is green + probe resolved): Sales-Researcher calls web_research.search + crm_mock.search_records → allow→backing→tool.completed+tool.executed audit; ask update_record → approval_required → run waiting_approval; approve → grant → session/load re-prompt re-issues → grant fast-path allow → shim executes → approval.executed+tool.completed AFTER result; delete_record never in tools/list. Nothing is 'F done' until this smoke passes.

== POLICY ==
Per-task TDD (failing test→impl→green), ruff-clean, commit per task (natural dev messages, NO AI/Claude/Co-Authored-By), run the relevant -k slice + the gateway/capability/adapter slices before each commit, full suite + cleanliness gate at wave boundaries. On an architecturally non-obvious fork (e.g. the header-forwarding one): record a decision via berry_store + proceed with the documented fallback — do NOT block waiting for the user. Update this handoff (berry_store) as tasks complete.