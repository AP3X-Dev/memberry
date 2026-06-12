---
id: AFNcREEte-oLqFGh6qc4t
session_id: session-20260611-093000
agent_id: default
task: Hardening loop cycle 4: bound the drain-agent OpenAI client (OPT-13)
outcome: approved
created_at: "2026-06-11T11:09:07.117Z"
---

Cycle 4 (9d287bf): _default_openai_client in llm_runners.py now takes optional timeout/max_retries; build_drain_runners passes timeout=float(config.drain_timeout_max) and max_retries=1 — replacing the openai SDK defaults of 600s timeout × 2 retries that could pin a daemon drain thread ~30 minutes on one hung HTTP call. Key facts: (1) the same shared client serves the LIVE rolling-notes tick, and NotesGenerator holds the per-session notes lock during the runner call — the bound shrinks that lock-pin from ~10 min to ~60s worst case; (2) notes-tick failures degrade gracefully (exception caught, last_emitted_index not advanced, delta rolls to next tick, session.notes never blanked); (3) one SDK retry kept deliberately because FormReviewer has no app-level retry — accuracy > latency; (4) build_vision_runner still builds an unbounded client (blocks a route thread, not a drain thread) — bound value deferred to the screenshot spec rather than guessed. Stage runners (pydantic-ai) need no client bound: they're asyncio-cancellable and gated by pipeline_tick_timeout_seconds / the OPT-2 sweep timeout.