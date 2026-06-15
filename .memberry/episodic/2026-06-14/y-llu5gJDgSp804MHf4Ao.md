---
id: y-llu5gJDgSp804MHf4Ao
session_id: autonomous-ap3x-2026-06-13
agent_id: default
task: [project:ap3x] D7 — @ap3x/swarms tools/schemas/MCP layer (S7)
outcome: approved
created_at: "2026-06-14T08:44:01.291Z"
---

D7 (tools/schemas/MCP) committed 00dac5d, 522 tests, all four gates green (check/test/scan/build exit 0), independently verified. Key decision: the MCP client is HAND-ROLLED JSON-RPC — no @modelcontextprotocol/sdk dependency added. The upstream [BUG-TO-FIX] (validation/factory drift across streamable_http vs streamable-http spellings, stdio never handled, contradictory test contract) is closed with ONE coherent transport: a single discriminated union McpTransport {kind: "stdio"|"http"|"sse"} with a deterministic resolver (normalizeTransportName collapses legacy spellings; autoDetectTransport maps command→stdio, http(s)→streamable-http, ws(s)→sse). stdio is first-class via a spawned child process speaking newline-delimited JSON-RPC over stdin/stdout. The low-level McpTransportImpl is injectable via transportFactory, so tests cover both stdio and http through the one contract with an in-memory mock (no spawn/network). BaseTool bridges defineTool/plain-JSON-schema/TypeBox → openai/anthropic/generic provider schemas and delegates execution to agent-core executeToolCalls. Lazy id/timestamp factories (makeStep/makeManySteps) avoid uuidv7 same-ms collisions. Next: D8 = SwarmRouter unified 17-type factory + full-coverage parity smoke (the PRP parity gate), dispatched.