---
id: mNrYcOsjrS95FtjsWSIqq
session_id: session-20260610-ag3ntic-s15
agent_id: default
task: Sprint S15 (WQ-17) execution: MCP-over-Docker capability library
outcome: approved
created_at: "2026-06-11T01:43:12.662Z"
---

Executed S15 on branch morph/sprint-s15 (worktree wt-s15, base 9d15d92). 9 commits, tasks 1-9 done test-first; task 10 close in progress. Key decisions: (1) ContainerResource.deployment_id made nullable (migration 20260610_0501, one file for the sprint, also adds capabilities.discovered_tools) - sidecars are workspace-scoped, owned by no deployment. (2) Worker network attach NOT needed: study showed only the api process dispatches tool calls (shim transport + test harness run in api; the worker drives Hermes over ACP and Hermes calls back into the api shim). The api self-container ref comes from new setting api_self_container (HOSTNAME fallback) and joins capability networks via new docker_client.connect_container_to_network. (3) D2 attach gate (capability_transport_unsupported for mcp_stdio) required converting ~10 PDP-only test fixtures from mcp_stdio to mcp_custom_container. (4) resume/restart paths also re-ensure sidecars (stop-side reap removes them); delete reaps sidecars AFTER the runtime-network reap + terminal transition so the capability network last-out check sees the runtime gone. (5) notes-mcp image built+smoked on Cerebro: image id/digest sha256:c5005384e354a79537bed60f741a051448c5c5e18228d7fcc6b2cbedf2bce2c5, pushed to localhost:5000/ag3ntic/notes-mcp (same digest), smoke initialize/tools-list/add_note/healthz all green in a throwaway container; scratch dir cleaned. NOTES_MCP_IMAGE_DIGEST env wired through settings into the seeder with re-pin-on-change logic.