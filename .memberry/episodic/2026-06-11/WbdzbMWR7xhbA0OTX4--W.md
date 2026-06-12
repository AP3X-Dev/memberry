---
id: WbdzbMWR7xhbA0OTX4--W
session_id: session-20260611-verify-dup-race
agent_id: default
task: Verifier pass on duplicate-race I-41 re-resolve bypass fix (opt/agent-assist-cr-hardening, uncommitted vs 7c2d6d1)
outcome: approved
created_at: "2026-06-11T12:14:42.825Z"
---

PASSED the maker's fix for the I-41 bypass (re-resolve retry arm marked FAILED without duplicate-race verify). Both PortalError arms in SubmissionService._submit_one now route through one helper _failed_or_verified_sent (src/engine/services/submission_service.py:480-517); verify condition, _mark_sent/_mark_failed calls, and log shapes are behaviorally identical to the old primary arm (empty context renders the exact old "Portal submit failed for session=..." text). New test test_duplicate_race_after_company_re_resolve_is_verified_sent confirmed red at HEAD (FAILED, capturing old line-370 bypass log) and green after. Full gate: 2553 passed / 0 failed / 4 skipped / 2 warnings, ruff 0, mypy --strict 0. Non-blocking observation: line 346 (fresh_meta is None branch of the PortalNotFoundError arm) still calls _mark_failed directly for a PortalError — cannot be a duplicate-race 400 (exc is always the 404; _is_duplicate_race requires PortalValidationError) so behavior is identical, but the helper docstring's "EVERY arm" invariant overstates, and a residual theoretical persist-then-404 FAILED-though-persisted (company discarded between backoff attempts, resolution unchanged) is outside the duplicate-race-gated verify design.