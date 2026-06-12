---
id: -wF2Py6f-lFG0Ubl85flP
session_id: session-20260611-082000
agent_id: default
task: Investigate why the OpenAI bill rose over the past two days (2026-06-10/11) after running optimization loops
outcome: approved
created_at: "2026-06-11T15:26:34.605Z"
---

Cost investigation (2026-06-11): The overnight "optimization loop" (branch opt/agent-assist-cr-hardening, 12 cycles, agent-assist-optimizer) is a CLAUDE-driven CODE-hardening loop, NOT an OpenAI eval loop. Its verifier gate runs only `pytest -q` (with OPENAI_API_KEY='sk-ci-dummy'), `ruff check`, and `mypy --strict` every cycle — so it made ZERO live OpenAI calls. Its cost billed Anthropic/Claude (maker+verifier subagents + 6-agent audit), not OpenAI. Result: +34 tests (2522→2556), warnings 2→0, all 12 cycles verified; loop terminal pending Blocked item B-1 (mid-shift OpenAI key rotation never reaches pydantic-ai stage runners).

The ONLY live-OpenAI event in the window was the Phase 0 accuracy baseline (commit 5432cfd, ran 2026-06-10 05:09–05:16 UTC): 1 corpus entry, 3 samples, ~60 calls total (18 Stage1 + 12 Stage2 uncached + 6 Stage2 cache-hits + 15 Stage3-filter + 15 Stage3-probing), logged in eval_runs/datadir/metrics/stage_latency.jsonl. It ran on the repo-default gpt-5.5 for Stages 1+2 (gpt-4o-mini for Stage 3) → ≈ $1.20–$1.25 total.

Key cost lever: gpt-5.5 = $5/$30 per 1M (priciest). Per estimate_call_cost.py, a live 5-min call costs $0.495 on gpt-5.5 Stage2 vs $0.362 gpt-5.4 vs $0.262 gpt-5.4-mini vs $0.250 gpt-4o-mini. FR-19 Stage-2 lock caches repeat matches (6/18 were cache hits in the baseline) — the bound on live cost.

Any genuinely high OpenAI bill predates this work — it traces to the 2026-03-31→04-01 model-comparison research sessions (docs/cost-analysis-and-benchmarks.md: 12+ experiments across gpt-4o/gpt-4o-mini/gpt-5.4 family/GLM-5/MiniMax/6 OpenRouter models, 32-chunk + 27-chunk batches that hit 429s). MemBerry has zero experiment nodes from the past two days; the hardening loop tracked to the agent-state/ spine instead.