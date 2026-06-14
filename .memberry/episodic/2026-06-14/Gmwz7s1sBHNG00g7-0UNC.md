---
id: Gmwz7s1sBHNG00g7-0UNC
session_id: session-20260614-s7
agent_id: default
task: Completed S7 tools/schemas/MCP layer of @ap3x/swarms
outcome: approved
created_at: "2026-06-14T08:37:22.676Z"
---

S7 COMPLETE. Files created in packages/swarms/src/tools/: errors.ts, schemas.ts, base-tool.ts, parse-execute.ts, tool-registry.ts, mcp-client.ts, handoff.ts, index.ts. Test: packages/swarms/test/tools-s7.test.ts (37 tests). Added @ap3x/ai dep to packages/swarms/package.json.

MCP [BUG-TO-FIX] fix: ONE coherent McpTransport discriminated union {kind:"stdio"|"http"|"sse"}. normalizeTransportName collapses streamable_http/streamable-http/streamablehttp drift. autoDetectTransport: command->stdio, http(s)->streamable-http, ws(s)->sse, stdio://|empty->stdio. resolveTransport maps loose TMCPConnection to exactly one union member; stdio requires command, http/sse require url (else MCPValidationError). stdio IS handled: createStdioImpl spawns child_process + newline-delimited JSON-RPC over stdin/stdout. McpTransportImpl seam is injectable (transportFactory) so tests mock both stdio+http in-memory (no spawn/network). Hand-rolled JSON-RPC, NO @modelcontextprotocol/sdk dependency added.

Other bugs fixed: parseAndExecuteJson returns ONE consistent ParseExecuteResult{results,summary,hadError}; extractToolCalls dedupes (by id or name+args); collect-per-call partial-failure semantics standardized across BaseTool exec + multi-MCP fan-out; lazy makeStep/makeManySteps/makeAgentChatCompletionResponse factories (uuidv7 + Date.now); Step.time numeric.

Errors extend AgentError: BaseToolError/MCPError pass valid AgentErrorCode to super (agent_tool / agent_mcp_*) but carry granular toolCode/mcpCode field (AgentError.code union is closed, can't widen).

Index export: SWARM_TYPES collided with auto-swarm-builder -> aliased as TOOL_SWARM_TYPES. All schema models T-prefixed (no collision).

Gates: npm run check exit 0, npm test 522 pass (485 prior + 37 new), contamination-scan exit 0, build -w @ap3x/swarms exit 0. COVERAGE.md Phase D S7 6 rows flipped to [x].