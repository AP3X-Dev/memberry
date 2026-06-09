---
id: ubrG4mL_bvtxlj5a6TcGD
session_id: session-20260608-ag3ntic-morph
agent_id: mcp
task: [project:ag3ntic] T9 DONE: stateless MCP shim transport mounted at /internal/mcp with token authn
outcome: approved
created_at: "2026-06-09T06:19:27.953Z"
---

[project:ag3ntic] Stage F Task T9 (capstone of Part 1) COMPLETE. Created apps/api/platform_core/capabilities/shim_transport.py, modified apps/api/main.py, added tests/test_shim_transport.py. Commit d90c730 on morph/opt-hardening (parent 8bf1293). Full suite 409 passed (404 baseline + 5 new). Gate M12 PASS. Ruff clean. packages/mcp-server/ still untracked.

ARCHITECTURE (what future sessions need):
- shim_transport.py is ONLY the MCP-SDK adapter: a module-level lowlevel mcp Server with @list_tools->resolve_employee_tools and @call_tool->execute_tool. resolve_employee_tools returns ShimTool dataclasses (NOT mcp.types.Tool — the task hint was wrong), so the handler maps ShimTool->mcp_types.Tool(name, description, inputSchema). ShimToolResult is mapped to mcp_types.CallToolResult: completed->JSON text + structuredContent isError=False; denied/approval_pending/error->isError=True text. No business logic duplicated.
- IDENTITY (security): the Bearer token from request headers is the SOLE source of truth. _verify_identity: missing/invalid/expired token -> ShimAuthError(401); validly-signed token whose (ws,emp,run_id) != captured mount path -> ShimAuthError(403) (defense in depth). The CLAIMS drive all downstream calls, never the path. run_id is hard-required (verify returns None without it) so a None/unresolved run_id can never execute (fail closed).
- HEADERS inside a lowlevel handler: _server.request_context.request is the Starlette Request (the StreamableHTTP transport sets ServerMessageMetadata(request_context=Request(scope,receive)) on every message). request.headers['authorization'] -> token.
- TWO identity checks: (1) a raw-ASGI pre-check (_ShimASGIApp.__call__) returns a real HTTP 401/403 BEFORE the MCP handshake (clean wire status for callers/tests that never finish the handshake); (2) the authoritative re-check inside the MCP handlers. 
- KEY GOTCHA #1: StreamableHTTPSessionManager.run() is SINGLE-USE per instance. The test suite re-enters the app lifespan per test, so I build_shim_manager() FRESH each lifespan entry and store it on app.state.shim_manager; the route reads it from app.state. Do NOT make the manager a module singleton entered in the lifespan — second lifespan entry raises RuntimeError 'run() can only be called once'.
- KEY GOTCHA #2: Starlette Route treats a plain function endpoint as func(request)->response (consumes the body). To delegate raw scope/receive/send to the session manager with path params, the endpoint must be a CALLABLE INSTANCE (class with __call__), which Route treats as a raw ASGI app. Route (not Mount) so path params land in scope['path_params'].
- KEY GOTCHA #3: json_response=True on the manager so an in-process httpx client gets a synchronous JSON body, not SSE.
- http_client SEAM: production default httpx.AsyncClient(base_url=settings.agent_runner_callback_base_url) set in the lifespan on app.state.shim_http_client; a test sets its own ASGI-backed client BEFORE entering the lifespan (the lifespan only seeds a default if None). execute_tool uses it to reach the in-process crm_mock/web_research backing routers.
- TEST DRIVER: mcp.client streamable_http_client(url, http_client=ASGI-backed httpx client with Bearer header) + mcp.ClientSession; app lifespan run manually via app.router.lifespan_context(app) inside ONE asyncio.run so shim_manager.run()'s task group shares the MCP client's loop (asgi_lifespan is NOT installed). Wrapped every RPC in asyncio.wait_for(timeout=10) + ClientSession read_timeout so a rejected/unanswered request fails fast instead of HANGING the suite (the original tests hung the runner). Negative tests assert EXACT 401/403 via a direct httpx POST of an initialize body to the mount path.

FLAGGED FOR PART 2 (unchanged from plan): /internal ingress + app-wide permissive CORS exclusion is network-policy (live-probe gate #6); Streamable-HTTP wire conformance vs real Hermes (JSON-vs-SSE, stateless no Mcp-Session-Id, whether Hermes forwards mcpServers[].headers verbatim on every request — gate #3/#4); golden-path live smoke (gate #8).