---
id: oAoNngN3NzTSDNeuGwYgc
session_id: session-20260609-103000
agent_id: default
task: Read-only portal contract audit (7 agents, both repos): assistant assumptions vs customer-portal code; handoff doc for portal dev + assistant-side action list committed
outcome: approved
created_at: "2026-06-09T20:28:26.082Z"
---

Portal contract audit results (1 BLOCKER, 24 RISK, 41 INFO). Docs committed on v2-rebuild-spec: docs/portal-integration-audit-2026-06-09.md (our actions) + docs/portal-handoff-requests-2026-06-09.md (sendable to portal dev, no portal changes by us), commit 1478f05.

BLOCKER: portal AMS key transform rewrites useCICStandardEmergencies→useCicStandardEmergencies (and lowercases byTrade keys) → our ClientSOP reads flag as absent → defaults TRUE → clients that opted OUT of CIC standard emergencies get them surfaced anyway. Fix ours: dual-casing accept + audit all acronym keys + portal-shaped fixture test.

TOP RISKS (ours): cold boot never tries refresh-token exchange (access 2h, refresh NEVER expires portal-side) → daily browser+OTP logins for nothing; token file write not atomic vs Doorkeeper rotation grace; no mid-shift AI-key rotation path (Deepgram dies→frozen Listening, OpenAI fails rest of shift — wire 401s→refetch service_tokens→live PUT); service_tokens returns 200+token:null when credentials unseeded (we'd misdiagnose as network); HttpSopSource unparsed-normalization bug would blank EVERY SOP if wired as runtime source; missing-playbook-ROW companies still 500 and ≥5 consecutive aborts our sync pass; duplicate-race 400 "already been taken" marks delivered submission FAILED (fix: verify via GET /api/v1/call_submissions?since= which EXISTS); CompanyResolver caches discarded companies (unscoped index, dup names last-wins); JSON:API plural type mismatch ("companies" vs singular) makes inbound-number lookup + list_clients dead vs prod, mock green-washes it; 403 absent from error taxonomy; no recording matcher exists ANYWHERE ("Georgi's cron" fictional) and we send zero Five9 ids — but portal call:{} jsonb persists all three CallData ids today with no portal change; join target = recording_groups.call_id (unique), not recordings.

GOOD NEWS / STALE BELIEFS KILLED: empty playbooks 200 now; companies slugged; flat-payload submit drift RESOLVED (bff4a79); Escalation submits work TODAY (portal validates no jsonb content — the coordination blocker never existed); GET call_submissions read-back exists; companies#show returns company+playbook one-shot; GET /api/v1/profile exists unused; Rack::ETag conditional GET works today; installer endpoint POST /downloads/agent_assist exists (browser-session auth only — affects updater plan); no API rate limiting (only Devise web login 15/5min/IP + Turnstile → stagger shift-start browser logins); 'read' scope suffices for writes; no 'agent' scope exists (role not scope).

PORTAL HANDOFF (notated, their side): key-transform preservation, missing-row playbook 500, duplicate-race rescue, kept-scoped companies index, InboundNumber.active scope references nonexistent column (latent 500), service_tokens 503-on-unseeded + confirm prod credentials seeded (api_secret not api_key), non-agent OAuth → unrescued 500, Doorkeeper app row flags to confirm (confidential=false/trusted=true/redirect cic-assistant://oauth/callback), recording matcher design notes, swagger/docs-site drift FYI.

Memory files updated: project_desktop_portal_call_submission_drift (RESOLVED), project_portal_prod_state (2026-06-09 supersedes 04-28 probe), project_five9_session_id_join (join target pinned to recording_groups.call_id).