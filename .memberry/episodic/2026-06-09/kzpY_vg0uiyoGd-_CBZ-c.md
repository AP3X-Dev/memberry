---
id: kzpY_vg0uiyoGd-_CBZ-c
session_id: session-20260608-ag3ntic-morph
agent_id: mcp
task: [project:ag3ntic] T9 kickoff: design verified for stateless MCP shim transport mount
outcome: approved
created_at: "2026-06-09T05:39:38.814Z"
---

[project:ag3ntic] Starting Stage F Task T9 — mount ONE stateless StreamableHTTP MCP shim at /internal/mcp/{ws}/{emp}/{run_id} with Bearer token authn (folds in T1 run_id resolver). Verified design from reading the code:

- resolve_employee_tools returns list[ShimTool] (a frozen dataclass with name/description/input_schema), NOT mcp.types.Tool as the task hint claimed — so the @list_tools handler must MAP ShimTool -> mcp.types.Tool(name, description, inputSchema).
- execute_tool(session, *, workspace_id, employee_id, run_id, tool_name, arguments, http_client) -> ShimToolResult(ok,status,content,error,...). @call_tool maps it to MCP content / isError.
- verify_employee_shim_token(token) -> {workspace_id, employee_id, run_id} | None. Source of truth for identity.
- Inside a lowlevel Server handler, the Starlette Request is reachable via server.request_context.request (the StreamableHTTP transport sets ServerMessageMetadata(request_context=Request(scope,receive)) on EVERY message; the lowlevel Server copies it onto RequestContext.request). So Bearer token = server.request_context.request.headers['authorization'].
- StreamableHTTPSessionManager(stateless=True) must be entered ONCE via `async with shim_manager.run():` in the lifespan — it owns a task group keyed to that loop. Mount at /internal/mcp/{ws}/{emp}/{run_id} via a Starlette Route (Mount can't carry path params), delegating to shim_manager.handle_request(scope,receive,send). Path params are captured for an assert-equal-to-claims defense-in-depth check ONLY; claims are the primary read.
- json_response=True needed so an in-process httpx client gets a synchronous JSON body (not SSE).
- http_client seam: production = httpx.AsyncClient() reaching settings.agent_runner_callback_base_url (default http://api:8000) for backing routers; test = httpx.AsyncClient(ASGITransport(app=api), base_url=http://api:8000). Inject via app.state factory the lifespan sets by default and the test can override.
- TEST DRIVER: use mcp.client streamable_http_client(url, http_client=httpx.AsyncClient(ASGITransport(app), headers={Authorization: Bearer <tok>})) + mcp.ClientSession to do the full MCP handshake. asgi_lifespan is NOT installed, so run the app lifespan manually via app.router.lifespan_context(app) inside ONE asyncio.run so shim_manager.run() shares the MCP client's event loop.

Baseline: HEAD 8bf1293, branch morph/opt-hardening, 404 tests pass, packages/mcp-server/ still untracked.