---
id: czsvnRjmzVbu22WIzZOf8
session_id: session-20260611-093000
agent_id: default
task: Hardening loop cycle 9: duplicate-race verify-then-SENT closed on both submit arms (OPT-8)
outcome: approved
created_at: "2026-06-11T12:16:35.148Z"
---

Cycle 9 (8b52acb): the duplicate-race "FAILED though persisted" live-risk note was HALF-stale — I-39 verify-then-SENT was already implemented and tested on the primary submit arm (submission_service: _is_duplicate_race + _verify_landed with skew-padded since window; 6 tests incl. never-guess-on-readback-error). The adversarial verifier REJECTED the maker's "fully implemented" conclusion by finding the I-41 company-re-resolve retry arm bypassed the verify: stale company id → 404 → re-resolve → inner attempt persists but returns 5xx → backoff retry → Rails uniqueness 400 → marked FAILED unconditionally. Fixed in-cycle: both portal-failure arms now route through one _failed_or_verified_sent helper (the same drift-proofing shape as util/must_book_grounding — shared predicate so arms can't diverge), new I-41×I-39 composition test proven red at HEAD in a throwaway worktree. Loop lesson: adversarial verification of EVIDENCE cycles is as valuable as for code cycles — a plausible "fully done" verdict from the maker was wrong. Residual accepted: persist-then-404 with unchanged re-resolution (not a dup-400 carrier) stays FAILED by design.