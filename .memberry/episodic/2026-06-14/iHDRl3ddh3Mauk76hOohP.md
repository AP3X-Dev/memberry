---
id: iHDRl3ddh3Mauk76hOohP
session_id: clean-room-ap3x-2026-06-13
agent_id: default
task: [project:ap3x] Scope and scale of the AP3X clean-room port
outcome: approved
created_at: "2026-06-14T02:18:46.320Z"
---

AP3X combines two sources into one self-branded TypeScript framework. Scale measured: swarms (Python, to port) = 214 files / ~74k LOC; pi (TS, reimplement natively) = ai 31k, agent-core 8k, coding-agent 50k, tui 12k LOC (~101k src). Total in-scope ~175k LOC. swarms layout: agents/ (14 files), structs/ (61 files = the swarm architectures), cli/, prompts/, schemas/, tools/, telemetry/, artifacts/, utils/. pi layout: packages ai/agent/coding-agent/tui each with src+test. Build order will be bottom-up: ap3x-ai -> ap3x-agent-core + AgentBackend interface -> swarms-port orchestration -> ap3x-tui/ap3x-cli. Local Node is v20 (target Node>=20, avoid Node-22-only APIs). Python 3.12 + tree-sitter-language-pack available for AST inventory extraction.