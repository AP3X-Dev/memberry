---
id: Xra3E_LcfQlv0rZ0X67D7
session_id: session-20260609-auto-research-design
agent_id: default
task: Implement the auto-research skill in the skill jar
outcome: approved
created_at: "2026-06-10T04:00:12.731Z"
---

Implemented development/auto-research on branch skill/auto-research (3 commits: 6c7fbd6 skill+routing+indices, f2bc915 review fixes, c897b10 rewrap/qualify). Audit gate green (69 checks). Notable review learning: in placeholder-driven templates, explicitly separate scaffold-time tokens (filled at install) from run-time tokens (computed each cycle, e.g. <reset point>, <short sha>) — a blanket "replace every placeholder" instruction can make a literal scaffolder bake a fixed SHA into the reset path and wipe kept experiments. Also: log-then-reset ordering for crash rows (so the experiment sha is recorded), crash fixes must be committed for sha reproducibility, and state-enum fields need wired transitions or they rot.