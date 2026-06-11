---
id: N9d9HHr4RDyT0aCiwqB8n
session_id: session-20260610-pre-launch-impl
agent_id: default
task: Implement v2 pre-launch build order on v2-phase1-prelaunch (commit-only)
outcome: approved
created_at: "2026-06-10T19:43:00.337Z"
---

Implementing the 5-item pre-launch build order from episode Fe2l0nuqvZscFwcgGef0C (all 14 decisions resolved 2026-06-10). Branch v2-phase1-prelaunch, TDD, ruff+mypy+pytest green per commit, no push.

DONE:
- db9e95f: committed the resolved decisions doc.
- 853aa27 (item #1 Journal ON): spawn env sets CIC_JOURNAL_ENABLED=1 + CIC_JOURNAL_RETENTION_DAYS=7 (guarded so explicit env wins, like the liveness probe); engine retention default 30→7. Tests: tests/electron/test_python_backend_journal_env.py + config test.
- 4a014df (item #2 Trade matcher): new src/engine/skills/trade_matcher.py resolve_trade() — deterministic, precision-first, LLM-free (exact→normalized→alias{electric:electrical}→unambiguous-fuzzy@0.86→unmatched). Shared by sop_compiler.evaluate_sop (richer TradeJoin statuses alias/fuzzy) AND ProbingQuestionsLoader.for_classification (resolves missed exact key when resolve_trades flag on; unresolvable trade flagged once, full-SOP fallback never blanks). Gated on existing CIC_SOP_COMPILER_ENABLED; ACTIVATED in spawn env so the 6 Electric + 3 Generators clients load probing at soft launch. NOTE: that flag also turns on boot SOP-compilation (observability-only) — coupling is intentional per "behind the existing flag."

REMAINING: #3 submit-gate (drain_timeout_max 75→30s + facts-only ceiling notification, normal-path notify only when review items exist), #4 hang-recovery (tray Restart Assistant + pre-kill snapshot), #5 SOP sync (PeriodicSopSync 3600→1800s + between-call disk reload). #6 send portal handoff doc = external.

main.js is tested via SOURCE-LEVEL PINS (test_main_respawn_resync.py idiom), not behavioral — use that for the tray button + notification. Full pytest ~90-140s; 2508 passing after item #2.