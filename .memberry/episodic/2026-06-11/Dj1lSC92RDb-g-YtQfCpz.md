---
id: Dj1lSC92RDb-g-YtQfCpz
session_id: session-20260611-ag3ntic-sprint-derivation
agent_id: default
task: Derive Phase 3: compile the remaining residue into WQ-20 + sprint S18
outcome: approved
created_at: "2026-06-11T07:26:06.294Z"
---

Phase 3 derived (user-directed, 2026-06-11): WQ-20 "Conformance & residue closure" added to PLAN.md §3 with full launch brief S18 in SPRINTS.md; committed as 87de00d on branch morph/ui-skills-budgets (cut from integration head dd82833, strictly ahead — merges forward cleanly). WQ-10 closed (basePath decided root-subdomain; CORS rides go-live; rest folded into WQ-20).

S18 core tasks (verified anchors): (1) errors.py _CATEGORY_SPECS sets operator_can_fix:true on PERMISSION_DENIED/APPROVAL_REQUIRED — sec-33 §33.1 rows 3-4 say NO for both (real deviation found during derivation; budget_exceeded is an S17 extension, keep per its design doc); (2) CapabilityVersion status 'active' → spec's 'published|yanked' (sec-16 §16.4) + CHECK migration, suggested head 20260611_0801 on 20260610_0701; (3) scope fence beyond marketplace in register_capability (~service.py:152) — system reserved to seeder, workspace bind consistency; (4) body-size caps (NONE exist today; sec-25 T21 names control, no values — suggest 1MiB default, 413 request_too_large); (5) inline hermes_run_executor (runs.py~694) never calls run_preamble (~655) — preamble parity; (6) live ModelProviders carry no config["pricing"] (keys input_cents_per_mtok/output_cents_per_mtok) so operator costs book estimated; (7) legacy stored-spec heal via §11.8 re-mint (S15 seeder-heal precedent, scripts/heal_legacy_specs.py); (8) support bundle is synchronous, zero log capture vs sec-26 §26.13 async OperatorJob-style + 24h redacted logs; (9) D1 idle eviction sweep evict_idle_chat_sessions() clearing runtime_session_key (~7200s) — re-open also re-delivers S16 preamble. Stretch: sidecar restart re-ensure sweep, Hermes-native skill/SOUL.md delivery (probe-gated), session/load re-issue. Out (deliberate): CORS (go-live), CI wiring, retro-booking pre-S17 runs.

Launch with: "Execute Sprint S18 from platform/docs/SPRINTS.md". After S18 only the go-live ledger (§4 + BLOCKERS.md) remains.