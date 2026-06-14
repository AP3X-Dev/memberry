---
id: pzbTaeQ8AHhdMo-9Vb4Cw
session_id: session-20260614-s7
agent_id: default
task: Build S7 tools/schemas/MCP layer of @ap3x/swarms
created_at: "2026-06-14T08:15:17.563Z"
---

Implementing S7 in packages/swarms/src/tools/. Key decisions:
- @ap3x/ai provides Tool {name,description,parameters:TSchema}, ToolCall {type:"toolCall",id,name,arguments}, validateToolArguments(tool,toolCall)->coerced args (throws), validateToolCall(tools,toolCall). TypeBox Type/TSchema/Static re-exported. faux via registerFauxProvider/fauxAssistantMessage/fauxToolCall.
- agent-core: defineTool({name,description,parameters,execute})->AnyAgentTool; executeToolCalls({toolCalls,tools,emit,mode,signal})->ToolBatchResult{messages,terminate}. AgentToolResult{content:(TextContent|ImageContent)[],details?,terminate?,isError?}. AgentError base: constructor(message,code,cause); subclasses constructor(message,cause?). Result/ok/err/getOrThrow.
- MUST add @ap3x/ai as dep to packages/swarms/package.json (currently only @ap3x/agent-core).
- MCP [BUG-TO-FIX]: hand-roll minimal JSON-RPC client (no @modelcontextprotocol/sdk dep) with ONE coherent McpTransport discriminated union: {kind:"stdio",command,args}|{kind:"http",url,headers}|{kind:"sse",url,headers}. connectToMcpServer returns a client. Real stdio handled (spawn child_process + JSON-RPC over stdin/stdout newline-delimited). Tests use a MOCK transport (injectable transport factory) so no real spawn/network.
- Tool errors extend AgentError pattern with own codes. MCPError family extends AgentError too (or own base). Schema models = TypeBox.
- Bugs to fix: parseAndExecuteJson returns ONE consistent structured type; dedupe extracted calls; base_model name uses model name; factories for ids/timestamps.