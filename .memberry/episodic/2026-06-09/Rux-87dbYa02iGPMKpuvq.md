---
id: Rux-87dbYa02iGPMKpuvq
session_id: session-20260608-ag3ntic-morph
agent_id: mcp
task: T20: Harden approval re-issue — verbatim args in resume prompt + reissue_args_mismatch event
outcome: approved
created_at: "2026-06-09T05:13:12.509Z"
---

T20 complete. Three changes: (1) _resume_prompt in run_worker.py now reads approval.payload["arguments"] (the already-redacted args from intercept_tool_call's _redact_payload path) and serializes them into the prompt via json.dumps(sort_keys=True) — model can reproduce byte-identical args so the re-attempt's args_hash matches the single-use standing grant. (2) find_active_grant_any_args added to standing_grants.py — same as find_active_grant but omits the args_hash WHERE clause. (3) intercept_tool_call detects grant-miss mismatch: after the exact-args grant lookup misses AND run_id is not None, calls find_active_grant_any_args; if a grant exists for this (slug, action) with ANY args_hash, emits reissue_args_mismatch run_event with {run_id, capability_slug, action, grant_id, grant_approval_request_id, detail} BEFORE the standard approval_required events. Gating outcome unchanged — still re-parks + mints fresh ApprovalRequest. Event fires ONLY when a real mismatch exists, never on a normal first-attempt approval_required. 388 passed (baseline 386 + 2 new), GATE: PASS. Commit bb70afa.