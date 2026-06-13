---
id: eI_qcXAhzMX-OkzFdtnSL
session_id: session-20260612-104500
agent_id: default
task: Optimization/hardening pass on the Sentry telemetry surface (verify correctness)
outcome: approved
created_at: "2026-06-13T03:08:42.262Z"
---

Ran a 4-agent adversarial audit + maker→separate-verifier hardening cycle on the Sentry surface (commit 04cfed6 on main, unpushed). Verifier (optimizer-verifier subagent) returned PASS after independently re-running the gate: ruff clean, mypy --strict clean, 2621 passed/1 skipped (up from 2611), node checks green.

KEY FINDING (Critical, fixed): exception frame-locals AND breadcrumb.data bypassed the FR-39 key scrub, and frame-local capture is INDEPENDENT of send_default_pii in sentry-sdk 2.62 — so a CIC API key (client constructor arg) or customer transcript (mid-extraction local) could egress to Sentry. Fix: include_local_variables=False at init (PII isn't key-shaped, can't be pattern-scrubbed, so drop capture entirely) + replaced surgical before_send/before_breadcrumb with a recursive _scrub_value walk (depth cap 8) covering all surfaces as defense-in-depth for secrets.

Other fixes: (1) llm_span/LlmSpan now guard every set_data via _safe_set + span-creation try/except → _NoopSpan fallback, so a Sentry failure can't break extraction/drain (demote-and-flag principle); caller exception still propagates + marks span error. (2) Electron applyAgentIdentity(null) now CLEARS instead of no-op — a fresh sign-in whose profile fetch fails could otherwise inherit/mis-attribute the previous agent (clearAgentIdentity is a hoisted fn decl, no recursion). (3) get_agent_id snapshots _agent_user before its 3 reads (concurrent sign-in race). (4) retry_count preserves genuine requests==0. Added Node-side vm-harness tests for CIC_SENTRY_* spawn-env threading (the producer side had zero coverage — the exact surface that broke 14 tests before).

DELIBERATELY NOT FIXED (surfaced to user): (a) Cached-token under-pricing — drain agents use prompt caching but _decode_json_response drops prompt_tokens_details.cached_tokens, so both span estimate AND record_chat (JSONL) over-price gpt-5.5 cached input at 10x; pre-existing drain-path gap, fixing correctly needs touching record_chat in 4 agents. (b) Token-double-count in naive sum(gen_ai.usage.total_tokens): pydantic-ai integration emits its own invoke_agent+model-request spans with gen_ai.usage.*, plus our cic.llm_invocation mirror = 2-3 copies; inherent to the integration, mitigated by op-filter dashboard guidance (documented in record_usage + handoff). Cost ($) sum is safe — only our spans carry estimated_cost_usd. (c) Per-invocation span cost vs per-session JSONL ledger is intended decoupling (same pricing fn, different scopes), not drift — reframed the docstring.