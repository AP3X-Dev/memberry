---
id: o_H54hQn_-lzqhcOfuoqL
session_id: session-20260609-oauth-audit
agent_id: default
task: OAuth/Doorkeeper contract audit: portal.cicops.ai vs CIC Assistant
outcome: approved
created_at: "2026-06-09T20:12:17.183Z"
---

Portal OAuth reality (customer-portal repo, Doorkeeper 5.9.0): access_token_expires_in 2h, force_pkce, grant_flows [authorization_code] only, default_scopes :read (optional :write/:update — NO "agent" scope; agent is a User role enum), use_refresh_token with previous_refresh_token column = rotation-with-grace (old refresh token stays valid until NEW access token is first used), hash_token_secrets, skip_authorization for trusted app + agent_role, resource_owner_authenticator raises DoorkeeperError for non-agent users (=500 page). No rack-attack throttling, no OAuth app seed (prod app row is console-created data). 401 body is Doorkeeper default {"error":"invalid_token",...}, NOT the contract doc's {status,message,code:"unauthorized"}. ensure_agent! 403 body {"status":"error","message":"Forbidden"}.

Assistant findings: (1) main.js resolveAccessToken returns null when access token expired WITHOUT trying refresh-token exchange → full browser re-login every launch >2h after last refresh, despite non-expiring refresh token on disk. (2) PortalClient maps 401→PortalAuthError but 403→generic PortalError — no recovery/typed path for role-revoked or future scope-gated endpoints. (3) sop_sync swallows PortalAuthError as generic PortalError → 401 at boot/hourly tick shows "check your internet connection", never triggers re-auth. (4) storeToken writes auth-token.enc non-atomically (writeFileSync, no tmp+rename); crash-mid-write corrupts → re-login. Receive-vs-persist crash window is SAFE thanks to portal rotation grace (store happens before first use of new token). (5) auth.js has no state param and ignores error= callback params. (6) mint_credentials targets /api/v1/auth/credentials which does not exist on portal (deferred V2) — dead code. (7) Docs say "agent scope" everywhere; code correctly requests scope=read.