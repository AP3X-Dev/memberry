---
id: Fe2l0nuqvZscFwcgGef0C
session_id: session-20260610-grillme
agent_id: default
task: Owner grill-me walkthrough resolving all 14 v2 gated decisions (docs/v2-rebuild-gated-decisions.md) and setting the pre-launch build order before the soft launch.
outcome: approved
created_at: "2026-06-10T19:05:01.677Z"
---

2026-06-10 grill-me session: owner resolved ALL 14 v2 gated decisions. Full record in memory/project_v2_prelaunch_decisions.md and docs/v2-rebuild-gated-decisions.md § Resolutions.

DECISIONS: (1) Journal ON, 7-day, UNENCRYPTED, raw stays local. (2) Eval data: reports/numbers only off-machine, raw transcripts never leave. (3) Keep polling (no retire). (4) Defer WebSocket entirely — no UI changes before launch. (5) Single-writer core = isolated SPIKE branch AFTER trade matcher; decide by hands-on test; baseline is final merge gate only. (6) Ship Phase 1 as-is, launch proceeds. (7) Hang recovery = detection-only + agent "Restart Assistant" Electron TRAY button (not frozen renderer) + PRE-KILL snapshot into Call History; no auto-kill until harness. (8) Submit-gate PRE-LAUNCH: drain_timeout_max=30s + facts-only "Finalization didn't complete — review the form before submitting"; notify only when review items exist; review-first kept. (9) Soft launch IS the instrumented run: 2-5 agents of 20-25, current clients, logging on; baseline emerges. (10) LOCK_STREAK tuned from baseline later. (11) REVERSED doc rec — build a dynamic runtime trade matcher (precision-first, deterministic+fuzzy, NO LLM, demote-and-flag), do NOT fix SOP data; pre-launch; bridge until portal authoring. (12) Pin Five9 join on first real call. (13) Send portal handoff doc now. (14) No SOP freeze; 30-min periodic sync + between-call reload-from-disk (never mid-call, reload-from-disk only); running app does NOT hot-reload today so this is new work.

WORKFLOW: all on branch v2-phase1-prelaunch off main; commit-only, no push/PR without approval. BUILD ORDER: journal -> trade matcher -> submit-gate -> hang-recovery -> SOP-sync -> send handoff doc; then single-writer spike in parallel; soft launch produces baseline.