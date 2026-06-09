---
id: 0wQ1reoWWXqi3N-LQt-U9
session_id: session-20260608-ag3ntic-golden-path
agent_id: mcp
task: [project:ag3ntic] planning: sequenced golden-path implementation plan (no code)
outcome: approved
created_at: "2026-06-08T21:46:49.909Z"
---

[project:ag3ntic] Wrote platform/docs/superpowers/plans/2026-06-08-golden-path.md — a dependency-ordered, code-grounded plan to make the 22-step Sales-Researcher golden path (sec-31 E2E-GOLD-01) runnable. Covers gap-analysis critical path items 1-8+11 in 5 phases.

KEY CODE FINDINGS that shaped sequencing (verified by reading, not docs):
- SSE already works server-side: tasks/router.py GET /runs/{id}/events does correct backfill(Postgres run_events)+live-tail(Redis runbus)+Last-Event-ID+dedupe+terminal-break; test_runs_sse_live.py passes. The frontend is the ONLY streaming blocker: apps/web/lib/api.ts:16 and app/proxy/[...path]/route.ts:63 both buffer with await .text(); rg EventSource|ReadableStream=0. So item 1 (proxy passthrough) is P1, unblocks everything.
- Chat surface absent at every layer (no platform_core/chat, no /chat/sessions routes, employee page is a bare run textarea) BUT the spine is reusable: runs.start_run(conversation_id=...) ACP-dispatches and emits chat.* events already streamed by /runs/{id}/events. Plan reuses it — does NOT fork the run/permission path.
- ALL ORM models exist (Conversation, Message w/ sequence, IdempotencyKey, Credential, CredentialGrant, EmployeeTemplate). Gap is wiring/routers/services/DB-constraints, not schema.
- DB-level constraints almost entirely ABSENT: baseline migration 20260607_0001 has ONE create_unique_constraint (uq_employee_operator) + indexes only; no CHECKs, no ck_grant_target, no uq_runtime_live_per_employee despite model comments saying "in migration" (gap 14/Q4).
- Idempotency accepted-but-ignored: routers declare the header then drop it; IdempotencyKey never instantiated; no middleware. Web proxy DOES forward the header (route.ts:40).
- Operator is synchronous, single freeform JSON parse, propose/accept only — no tool-loop, no §19.7 validator, no reject/revise/save-draft. accept_proposal raises operator_proposal_revise_unsupported for revision-into-existing-employee (gap 11 blocker).
- create_employee_from_spec hardcodes revision_number=1; no §11.8 re-mint helper.
- capabilities/seed.py = [schema_validate, computer] only; employee_templates empty; no packages/manifests/seed/; no crm-mock/web-research first-party services.
- credentials/router.py is model-key only; rg code_verifier|oauth/callback=0.

DECISIONS: (1) Resolve sec-20.4 vs sec-21.2.6 SSE contract drift by returning stream_url=/runs/{run_id}/events (proven path) AND adding a thin /chat/sessions/{sid}/events alias that delegates to the same generator. (2) Golden-path approval demo (steps 18-20) falls back to crm_mock.update_record (high/approval_required) so it's provable with zero external OAuth account per sec-30.4.4.

PHASES: P1 SSE passthrough (CP, first). P2 parallel: 2.1 seeds+templates+mock services (CP), 2.2 revision re-mint §11.8 (CP for step 22), 2.3 DB constraints (guardrail). P3 chat module→router(15s heartbeat,stream_token,message_delta/complete)→UI (CP, needs P1+P2.1). P4 parallel: 4.1 OAuth PKCE connect, 4.2 Idempotency-Key middleware (full-class, all Idem✔ routes). P5: 5.1 reject/revise/save-draft verbs (needs P2.2), 5.2 operator tool-loop+§19.7 validator (needs P2.1+P4.1).

TOP RISKS: Hermes ACP per-turn chat contract is ASSUMPTION-TO-VALIDATE (persona persistence + delta shape — probe pinned build); Next.js Response(body) needs Node runtime+anti-buffering headers; seed image_digest placeholders must be real-pinned and crm-mock/web-research services must actually exist; late DB constraints can break fixtures; validator over-strictness if freshness-proof plumbing not wired; idempotency must cover the full class not just launch.