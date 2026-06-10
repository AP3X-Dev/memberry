---
id: re02YliIBG8ZPY8LV3TRk
session_id: session-20260609-auto-research-fixes
agent_id: default
task: Fix six review findings in the auto-research skill templates
outcome: approved
created_at: "2026-06-10T03:54:09.112Z"
---

Applied six review fixes to development/auto-research/SKILL.md and development/auto-research/references/driver-template.md: (1) Clarified placeholder contract — scaffold-time vs run-time tokens, with explanatory paragraph and updated checklist item. (2) Made baseline-twice rule unconditional with guidance on fixed-seed vs noisy domains. (3) Wired Status transitions: setup at scaffold, baselined after Phase 4, running at launch, interrupted on harness self-stop. (4) Reordered integrity violation handling: restore harness → log crash row → then reset. (5) Added n/a skip for no-soft-constraint case in step 7. (6) Required commit/amend after crash fix so kept results stay reproducible from their logged sha. Audit: 69 checks, 0 failed.