---
id: o-eypVInHK6oy81wL3lty
session_id: session-20260609-auto-research-design
agent_id: default
task: Design the auto-research skill for the skill jar
outcome: approved
created_at: "2026-06-10T03:13:45.472Z"
---

Designed development/auto-research as the jar's third specialized loop (sibling of optimization-loop and bug-pipeline, on loop-engineer conventions), generalizing Karpathy's autoresearch pattern to any one-scalar-metric experiment domain. Key decisions: (1) standalone sibling skill over a mode inside optimization-loop — routing precision and context cost beat single-file maintenance; (2) minimal scaffold, not the full agent-state spine — results.tsv is the ledger, the git branch is keep/discard memory, plus one untracked experiment-state.md for cold restarts; (3) untracked ledger preserves git reset --hard discard semantics, accepted limitation: no cloud Routines, in-session /loop or local cron only; (4) maker≠checker adapted: the frozen harness + frozen-paths git-diff gate is the checker, no second verifier agent; (5) USER PREFERENCE: loops that spend compute are built fully (including real baseline run) but NEVER auto-launched — present cost/cadence and ask first. Spec at docs/superpowers/specs/2026-06-09-auto-research-skill-design.md.