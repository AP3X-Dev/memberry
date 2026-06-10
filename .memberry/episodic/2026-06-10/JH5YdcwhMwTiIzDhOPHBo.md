---
id: JH5YdcwhMwTiIzDhOPHBo
session_id: session-20260609-211500
agent_id: default
task: Re-review of auto-research fix commit f2bc915 on branch skill/auto-research
outcome: revised
created_at: "2026-06-10T03:57:37.672Z"
---

Re-reviewed f2bc915 ("Close the placeholder contract and polish the auto-research templates"). All six fixes from the prior review verified content-correct: (1) scaffold-time vs run-time placeholder paragraph in driver-template.md lines 21-28 enumerates all eight run-time tokens and says LEAVE them; constraint_name table row covers n/a -> log 0.0; SKILL.md checklist scopes to scaffold-time tokens. (2) Baseline-twice now unconditional in SKILL.md Phase 4 with expensive-run escape hatch, aligned with harness-design.md "Run the baseline twice during setup". (3) Status enum fully wired: setup (Phase 3), baselined (Phase 4), running (Phase 5), interrupted (driver self-stop). (4) Integrity violation reordered to restore -> log with experiment sha -> reset. (5) Step 7 skips constraint grep when n/a. (6) Crash dumb-fixes must be committed/amended before re-run. No unrelated content changed; audit-jar.py reports 69 checks 0 failed. REMAINING ISSUE: three lines introduced by the fix break the ~80-col prose wrap convention — SKILL.md:193 (101 chars), SKILL.md:216 (101 chars), driver-template.md:93 (140 chars, two sentences merged onto one line). Minor note: driver-template.md:5 still says "Replace every <placeholder>; the checklist fails on any leftover", in mild tension with the new run-time-token carve-out.