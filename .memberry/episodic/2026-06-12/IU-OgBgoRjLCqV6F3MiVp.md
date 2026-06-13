---
id: IU-OgBgoRjLCqV6F3MiVp
session_id: session-20260612-104500
agent_id: default
task: Trace Sentry events by signed-in agent (user attribution)
outcome: approved
created_at: "2026-06-12T23:52:01.661Z"
---

Sentry user attribution shipped (commit 3a4e049). Owner constraint: sign-in is the ONLY identity moment. Design: main.js fetches GET /api/v1/profile (email/name/tag; tag = on-wire agent_id like "gnaydev") right after a bearer exists — boot-with-stored-token path (parallel with AI-creds fetch, before engine spawn) and handleAuthCallback (before the mid-shift/cold-start branch). applyAgentIdentity pins it three ways: (1) Sentry.setUser in Electron main — renderer events are captured through the main process scope (node.captureEvent in @sentry/electron main/ipc.js), so both pages inherit with no renderer code; (2) CIC_SENTRY_USER JSON in the engine spawn env via setSentryEnv (covers respawns); (3) optional user object on PUT /portal/auth-token (SentryAgentUser model, extra=forbid) for mid-shift sign-in when the engine is already running — engine route calls observability.set_sentry_user. Bare rotations omit user and never clear a pinned identity; logout calls clearAgentIdentity (setUser(null) + env reset) and the engine restarts unauthenticated anyway. Engine parses CIC_SENTRY_USER defensively (_parse_sentry_user: only id/email/username string fields forwarded; junk dropped with warning, never blocks reporting). Gotcha fixed en route: observability.py had no module-level logger (helpers take logger params) — _parse_sentry_user needed logging.getLogger(__name__) added. Verified live: boot log shows "Sentry user pinned (username=gnaydev)" against the real portal. 2602 tests green.