---
id: oZbH5MoGVD_CgXEoHaBtO
session_id: session-20260608-ag3ntic-morph
agent_id: mcp
task: Apply three T20 follow-up improvements and amend HEAD commit on morph/opt-hardening
outcome: approved
created_at: "2026-06-09T05:22:05.306Z"
---

Amended commit bb70afa → ce0121e (parent 88cfd07) on morph/opt-hardening. Three changes applied:
1. service.py reissue_args_mismatch event payload now includes current_args_hash (args_h variable, the re-attempt's SHA-256) and grant_args_hash (_mismatch_grant.args_hash). Both are safe to log — non-reversible digests.
2. test_resume_reissue.py stale comment fixed: was 'should be 2: original + new', now accurately says the original is approved and only the freshly-minted re-park approval is pending (count == 1).
3. run_worker.py: moved `import json as _json` from inside _resume_prompt's conditional to module top-level as plain `import json`; updated usage from _json.dumps to json.dumps.
4. Extended test_reissue_args_mismatch_emits_event_and_reparks to also assert mismatch_event.payload contains current_args_hash and grant_args_hash, and that they differ.
388 passed, cleanliness gate PASS.