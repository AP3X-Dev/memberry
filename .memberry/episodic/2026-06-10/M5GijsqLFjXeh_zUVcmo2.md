---
id: M5GijsqLFjXeh_zUVcmo2
session_id: session-20260609-review-auto-research
agent_id: default
task: Final spec/quality review of auto-research skill (branch skill/auto-research, commit 6c7fbd6)
outcome: approved
created_at: "2026-06-10T03:50:09.697Z"
---

Reviewed git diff 8a946da..6c7fbd6 against the design spec and plan. Verdict: ready to merge. Audit gate green (69 checks, 0 failed); branch local-only (never pushed); skills.json description matches frontmatter verbatim (914 chars); plugin.json lists ./auto-research first; README row + Six-skills count correct; all spec sections covered (phases 0-5, driver loop, artifacts, untracked-ledger rationale, maker-neq-checker adaptation, 7 common mistakes, out-of-scope respected). One Important finding: driver-template.md's placeholder table lists 10 scaffold-time placeholders, but the templates use 13 more angle-bracket tokens (runtime values like <reset point>, <short sha>, <status>; plus scaffold-time <where in the harness>, <guidance...>) while the intro says 'Replace every <placeholder>' and the SKILL.md checklist demands 'zero unfilled <placeholders>' — a literal scaffolder could wrongly replace <reset point> with a fixed SHA, making every future discard reset to scaffold time and wiping kept experiments. Recommended one-sentence fix distinguishing scaffold-time (table) placeholders from per-cycle values. Minor: baseline-twice conditional in SKILL.md vs unconditional in harness-design.md; experiment-state Status enum has no instructed transitions; crash-row log/reset ordering differs between step 8 and Crashes section; no guidance for domains without a soft constraint; crash dumb-fix path doesn't say to commit the fix before re-running.