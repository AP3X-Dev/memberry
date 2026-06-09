---
id: uuisrcBHh7B6mFIuRkwHi
session_id: session-20260608-ag3ntic-morph
agent_id: mcp
task: Stage F execution-pipeline: control-plane core + execution engine implemented (11/20 tasks), full suite green
outcome: approved
created_at: "2026-06-09T02:15:42.941Z"
---

Stage F (capability execution pipeline) implementation — checkpoint on branch morph/opt-hardening. Full test suite GREEN: 374 passed (baseline was ~345; +29 new tests, zero regressions). Plan: platform/docs/superpowers/plans/2026-06-08-golden-path-F-execution-pipeline.md.

COMMITTED (11 of 20 tasks, each TDD + ruff-clean, commits 1e5d103..ac98d45):
- T5 (1e5d103): InternalApiRuntime.endpoints map + InternalApiEndpoint{method,path,body_mode(none|object|embed|raw),body_field} + _endpoints_cover_actions validator on InternalApiManifest. manifest.py.
- T3 (8787212): capabilities/service.effective_tool_includes(capability,binding=None) — exclude-aware tool surface (manifest∪binding include − exclude ∩ permissions − deny-verdict). Drops delete_record.
- T13 (bb9765a): auth/security.sign_employee_shim_token(ws,emp,run_id,*,ttl)/verify_employee_shim_token → {workspace_id,employee_id,run_id}. base64url JSON payload + HMAC (_sign_shim, domain label 'ag3ntic-employee-shim-token:').
- T6 (49d00a7): permission_gateway/service.complete_tool_call(session,*,workspace_id,run_id,tool_call_id,success,result_summary,error,duration_ms,...) -> bool. started→completed|failed (NOT 'executed'), tool.completed|tool.failed via append_run_event, tool.executed audit, idempotent (guarded UPDATE WHERE status='started'), fail-closed on run_id None. Does NOT yet finalize the approval (that is T12).
- T7+T19 (fc9d84d): crm_mock + web_research seed YAMLs gained endpoints blocks (block-style, brace-paths QUOTED to satisfy YAML); crm_mock.delete_record reconciled high→critical. body_mode: create_note=embed/body, update_record=raw/fields.
- T14 (d260102): seed.seed_builtin_capabilities hash-aware (manifest_hash via validate_manifest→model_dump(exclude_none)→canonical json; skip-on-equal, re-register-on-change via upserting register_capability). seed.manifest_hash exported.
- T4/T8/T2/T10 (ac98d45): NEW capabilities/shim.py (transport-decoupled CORE) + shim_names.py (tool_name/parse_tool_name, split on first dot). resolve_employee_tools→list[ShimTool], resolve_employee_tool_names→set[str] (the per-run known-set source); bind_request(endpoint,*,base_path,args,workspace_id)->(method,url,params,json) — fills url-encoded {placeholders}, DROPS workspace_id from args (tenancy), embed/raw/object/none bodies, base=settings.agent_runner_callback_base_url; execute_tool(...) gates via intercept_tool_call then allow→bind+http_client.request+complete_tool_call / deny→MCP error / approval_required→approval_pending(no dispatch) / idempotent_replay→no re-dispatch; _runtime_tool_call_id=sha256(run_id|slug|action|args_hash). Tests use httpx ASGITransport against a minimal FastAPI(crm_mock+web_research routers).

REMAINING (9 tasks — see plan waves D/E + Part 2):
- T12: defer approved→executed + approval.executed from intercept grant fast-path (service.py ~333-341) INTO complete_tool_call success; thread grant.approval_request_id onto the started ToolCall (intercept only sets it on the awaiting_approval row today, ~441). MUST migrate 3 committed assertions that pin 'executed-at-re-issue': test_resume_reissue.py::test_reissue_consumes_grant_and_finalizes_executed (~190/194), ::test_reissue_with_reused_runtime_tool_call_id_consumes_grant (~272/274), test_tasks.py (~215 finalized=='executed').
- T0: record per-run known-capability-tool-name set on the _Session in hermes_adapter.start_run (via shim.resolve_employee_tool_names) for T11+T15.
- T11: tool_mapping.parse_capability_tool + gateway_bridge.decide auto-allow tools IN the known-set (shim gates them); unknown→native shell gate. No double-gate.
- T16: extend acp.session_load(session_id,*,mcp_servers=None) (today sends only {sessionId}); thread optional mcp_servers through _ensure_session→session_new AND session_load; start_run builds ONE shim mcpServers entry (signed token header + api-origin url, run_id in path/claim); chat() passes none.
- T15: suppress in-runtime pump tool.* for capability calls matched against session.known_tool_names (pump only has display title — do NOT dot-split).
- T20: _resume_prompt carries verbatim (redact-safe) args; emit reissue_args_mismatch on grant-miss re-park.
- T18: web_research_ssrf_resolve_dns setting (WRINKLE: flipping default to resolve=True breaks hermetic example.com fetch tests under no-network CI — test env must set it False or guard cached URLs before resolve).
- T9 (transport): mount ONE StreamableHTTPSessionManager(stateless=True) at /internal/mcp/{ws}/{emp}/{run_id} with token authn; lowlevel Server list_tools/call_tool delegate to shim core.
- T17 (Part2/live): uq_capability_version + uq_capability_slug migration after live-DB dedupe check.
PART 2 LIVE GATE (supervised Cerebro, NOT autonomous): Hermes-0.14.0 request_permission-on-MCP behavior, mcpServers wire shape in session/new+load, header forwarding, stateless transport conformance, byte-identical post-approval re-call, /internal network policy, golden-path smoke. Nothing 'F done' until the golden-path smoke passes.