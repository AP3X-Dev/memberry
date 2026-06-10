---
id: tU30TZF7rY-s3opYwz1HV
session_id: session-20260610-ag3ntic-morph
agent_id: default
task: [project:ag3ntic] alignment: untracked packages/mcp-server resolved as vestigial
outcome: approved
created_at: "2026-06-10T08:06:18.953Z"
---

[project:ag3ntic] Session-start alignment (2026-06-10). Verified state matches PLAN.md: branch morph/opt-hardening at 212c3f4 ("docs: close out sprint status"), sprints S0–S6 done, S7 (observability/self-healing) and S8 (console auth + API breadth) open. Resolved an earlier open question: the untracked packages/mcp-server/ag3ntic_mcp package — once flagged (P2.1/P2.2 episodes) as the "natural home" for the MCP gateway shim — was NOT the path taken. The live per-employee shim landed tracked at apps/api/platform_core/capabilities/shim*.py (Stage F Part 2 redesign). The untracked package is a legacy Nimbus-era MCP server (depends on packages/sdk-python, which does not exist in the morph tree) and is now a cleanliness candidate for deletion, pending user confirmation since it is untracked work nobody committed.