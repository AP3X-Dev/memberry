---
id: 7E_hpR6-Lrrt3S7yrPjZw
session_id: session-20260608-ag3ntic-morph
agent_id: mcp
task: opt session: harden decide_approval so a failing resume handler cannot roll back the committed approval decision (backlog item #2)
outcome: approved
created_at: "2026-06-08T10:04:35.410Z"
---

Root cause + fix for PermissionGateway decide_approval (apps/api/platform_core/permission_gateway/service.py). The immutable approve/deny decision (the _guard status flip + the ApprovalDecision row + audit/run events) was written, then _RESUME_HANDLER was invoked, and ONLY THEN was session.commit() called. Because the resume handler ran inside the same uncommitted transaction, any exception it raised (e.g. standing_grants insert failure, a _advance conflict on deny->failed, or a DB hiccup) propagated out of decide_approval before the commit, rolling back the entire unit -- reverting the approval from approved/denied back to pending_user_review and dropping the approval_decisions row. This violates foundation 5.2 decision immutability: an approval decision, once committed, must not be undone by best-effort un-parking. It also 500'd the HTTP approve and silently reverted it to pending.

Fix (the established pattern in this file): commit the decision FIRST, then run the un-park best-effort -- call _RESUME_HANDLER in its own try/except followed by a second session.commit(); on exception, session.rollback() + log.warning and continue (the run stays parked for the sweeper/worker to recover). This mirrors the pre-existing best-effort publish_resume block right below it. request_changes never un-parks. Convention: in decide_approval (and similar decide-then-side-effect flows) the authoritative decision commit and the best-effort un-park/signal MUST be separate transactions.

Verification: 2 new tests in tests/test_resume_reissue.py register a throwing resume handler, call decide_approval (approve + deny), and re-read the ApprovalRequest from a FRESH session asserting status stays approved/denied with exactly 1 approval_decisions row. Full suite tests/ = 219 passed (was 217). Cleanliness gate PASS. Commit 869bc4b on morph/opt-hardening. NOTE on tooling: on this Windows box, running pytest piped through tail/Select-Object can appear to hang because output is buffered until the pipe closes and the harness auto-backgrounds it; redirect to a file (> file 2>&1) and tail the file instead -- do not launch multiple concurrent pytest processes.