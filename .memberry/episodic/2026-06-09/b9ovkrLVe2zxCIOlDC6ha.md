---
id: b9ovkrLVe2zxCIOlDC6ha
session_id: session-20260609-103000
agent_id: default
task: Write V2 rebuild handoff for a fresh-context session to run the development loop
outcome: approved
created_at: "2026-06-09T21:26:53.867Z"
---

HANDOFF — V2 rebuild, 2026-06-09. Spec phase complete, implementation not started.

Branch v2-rebuild-spec (off main @6241cbb), 3 doc commits: 867518e (spec), 1478f05 (portal audit+handoff docs), 2313f29 (portal audit folded into spec). Pre-existing uncommitted changes (package.json/pyproject.toml/rep-guide HTML) are NOT ours.

Single source of truth: docs/v2-rebuild-architecture-spec.md — §4 invariant registry I-1..I-45 is binding; §8 phasing P/0/1/2/3/4. Companions: docs/portal-integration-audit-2026-06-09.md (our side), docs/portal-handoff-requests-2026-06-09.md (portal dev's side).

START ORDER: (1) Phase P = portal contract fixes on the CURRENT system, 10 ordered items in §8; item 1 is the only BLOCKER (useCICStandardEmergencies key-casing reverts opted-out clients to CIC-standard-ON — dual-casing parse + acronym-key audit + portal-shaped fixtures). (2) Phase 0 = measurement (golden corpus, replay runner, agent-edit-rate baseline, Stage 2 error taxonomy, latency histograms) — gate for all accuracy work, parallelizable with P. Then Phase 1 resilience slice (the real 10x + frozen-UI fix), 2 single-writer core, 3 SOP compiler, 4 experiments.

GUARDRAILS: work on v2-rebuild-spec; commit-only, never push/PR without per-action approval; NEVER touch C:\Users\Guerr\Desktop\customer-portal (other dev owns it; needs go in handoff-requests doc); run ruff+mypy+pytest before claiming green; TDD with portal-shaped fixtures mandatory; verify keys vs real src/data/sops/*.json; demote-and-flag never reject; evidence-only must-book; no runtime domain enums.

Memory file project_v2_rebuild_handoff.md written + indexed in MEMORY.md. A continuation prompt was handed to the user to paste into a cleared session.