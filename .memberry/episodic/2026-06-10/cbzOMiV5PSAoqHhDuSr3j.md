---
id: cbzOMiV5PSAoqHhDuSr3j
session_id: session-20260609-130500
agent_id: default
task: V2 rebuild — compiled must-book predicates on the SOP artifact
outcome: approved
created_at: "2026-06-10T06:03:10.471Z"
---

Commit d871abf on v2-rebuild-spec (21 total, 2476 tests green): CompiledSop.must_book added. Shape: CompiledMustBook{offering, uses_cic_standard, rules} where offering is DERIVED from data — custom / cic_standard / custom_plus_cic / not_offered (real prod data shows the memory's three states are actually four: BlueValley et al. have BOTH useCICStandardEmergencies=true AND customConditions, i.e. custom_plus_cic; all 8 prod clients opt into the CIC list). Each CompiledMustBookRule carries trade, condition text, citable source_path ("mustBook.customConditions.{i}.conditions.{j}" — provably present in the artifact's source-path index, pinned by test), and the compile-time grounding classifications requires_only_system + condition_requests_degraded_cooling imported from util/must_book_grounding.py (the single source of truth per the must-book-grounding-unified memory). Transcript-side evidence stays runtime via must_book_condition_grounded — the compiler only evaluates condition-side semantics. Still unwired: panel + alert gate keep deriving from raw SOP until the gated swap. Real mustBook wire shape for reference: {_agentInstruction, useCICStandardEmergencies: bool, customConditions: [{trade, jobType, servicePriority, conditions: [str]}], bookingWorkflow: [...]}.