---
id: buKnXfjRRFRi86nuhRV2a
session_id: session-20260608-ag3ntic-morph
agent_id: mcp
task: [project:ag3ntic] decision: Stage F execution-pipeline synthesis — verified contested code facts across 6 probes
outcome: approved
created_at: "2026-06-09T01:28:56.944Z"
---

[project:ag3ntic] Stage F (capability execution pipeline) lead-architect synthesis. Re-verified the facts where the 6 adversarial probes disagreed:

1. ToolCall.status enum (models.py:621-623) = intercepted|started|completed|denied|failed|awaiting_approval. There is NO 'executed' status. complete_tool_call MUST set status='completed' on success (not 'executed' as CTX/locked-design text wrongly said). 'executed' is the approval_requests status only.

2. crm_mock body shapes are OPPOSITE: create_note `body: str = Body(..., embed=True)` wants {"body": "<str>"}; update_record `fields: dict = Body(...)` (NO embed) wants the raw dict as the whole body. A single generic remaining-args-as-object body double-wraps update_record (silent no-op write). Fix = per-endpoint body_mode hint in the manifest endpoints map, OR normalize update_record to embed=True. Chose per-endpoint body_mode hint (minimal, no router change risk) but allow normalization as alternative.

3. effective_tool_actions (service.py:263-285) iterates permissions only, does NOT apply tool_filter.include/exclude — so building the shim tools/list from it EXPOSES delete_record (CRITICAL). Need a new exclude-aware effective-include resolver.

4. NO uniqueness constraints exist for capabilities/capability_versions (grep of alembic = 0 matches; model docstrings lines 382/403 are aspirational). Re-register spam is silent — hash-aware reseed guard is MANDATORY not optional.

5. acp.session_load(session_id) (acp.py:441-443) sends ONLY {sessionId} — no mcp_servers param. Resume path (_ensure_session line 322) re-presents no toolset. Must extend session_load signature.

6. run_id is None-able everywhere in intercept_tool_call; when None the Run is NOT parked (service.py:483) and approval re-issue strands. Shim MUST resolve run_id (CRITICAL) — thread via per-run shim mount/header.

7. Approval grant fast-path emits approval.executed at PDP-DECISION time (service.py:333-341) BEFORE any execution — premature for the shim-executes model; must defer to complete_tool_call success.

8. web_research endpoints (search, fetch_page) do NOT take workspace_id; crm_mock endpoints all DO. workspace_id injection must be per-endpoint/tenant-aware not blanket.

LOCKED: shim = ONE stateless StreamableHTTPSessionManager at parameterized /internal/mcp/{ws}/{emp} with HMAC bearer token authn; transport-free shim CORE (resolve/bind/PDP/dispatch/complete) unit-testable via httpx ASGITransport NOW (Part 1); live Hermes wire-shape + double-gating + retry-id are Part 2 (supervised Cerebro).