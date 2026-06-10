---
id: GYvsF4zILgNIrQn1z5JDL
session_id: session-20260609-130500
agent_id: default
task: V2 rebuild — hang detection (observe-only) + SOP↔probing coverage diagnostic with real findings
outcome: approved
created_at: "2026-06-10T05:51:42.137Z"
---

Commits 8991569 + 93e631c on v2-rebuild-spec (19 total, 2468 tests green). (1) Hang detection, observation-only: python-backend.js compares loop-served /health vs thread-served /health/live every 5s; 12 consecutive /health failures (~60s) with /health/live still answering = loop hang → ERROR log + one facts-only Notification per incident ("form on screen is preserved", no prescriptions per alerts-facts-only); recovery re-arms; both-probes-dead stays silent (crash territory, exit handler owns it); monitor is long-lived and inert while pythonProcess is null so respawn backoff windows can't false-positive. Deliberately NO kill — grace windows stay gated on CIC Harness validation. Closes the last observation hole in the frozen-UI chain.

(2) SOP↔probing trade coverage diagnostic (Phase 3 prep, §5.6 acceptance surface, zero runtime change): ProbingQuestionsLoader joins on EXACT (trade, job_type) keys, so trade-string spelling drift silently loads zero probing questions. tools/eval/sop_coverage.py buckets every SOP trade string vs probing_questions.json. REAL PROD FINDINGS the SOP owner should fix (or the gated compiler-normalization will absorb): "Generators" vs "Generator" in Bonsby + IAQMedics + LaPlante (the exact spec-named bug); SIX clients use "Electric" where probing has "Electrical" (BlueValley, Bonsby, ChampionAndNash, IAQMedics, PSI, StephenKDenny) — electrical probing NEVER loads for them today; LaPlante's Heat Pumps / Solar / "All (Existing customers)" trades have no probing sets at all. The "Electric"→"Electrical" class is bigger than the spec's Generators example and is NOT fixable by case/plural normalization alone (electric ≠ electrical even normalized) — needs either SOP data fixes or an alias map in the compiler.