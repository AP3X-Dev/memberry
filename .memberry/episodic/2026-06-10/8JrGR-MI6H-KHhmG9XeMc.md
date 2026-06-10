---
id: 8JrGR-MI6H-KHhmG9XeMc
session_id: session-20260609-130500
agent_id: default
task: V2 rebuild — Phase 1 entry bug fixes (respawn holes) + build gate assessment
outcome: approved
created_at: "2026-06-10T04:35:00.813Z"
---

Committed 1f410e9 on v2-rebuild-spec: the three ungated Phase 1 supervisor fixes. (1) Code-0 hole: python-backend.js respawns on ANY unexpected exit, not just non-zero — OS kills and clean-looking sys.exit(0) used to leave the app engine-less forever. (2) I-28: updatePortalEnv changed to MERGE semantics (replace would drop AI keys/dataDir on a bearer-only update — it had ZERO callers before, so semantics change was free); pushAuthTokenToBackend is the single choke point all three rotation paths funnel through (refresh timer, submit-401 retry, mid-shift re-auth) and now calls updatePortalEnv({accessToken}) BEFORE the PUT, unconditionally — a crash-respawn is exactly when the running engine wasn't reachable. (3) I-27: setOnRespawnOnline now runs the restartBackendForMemory resync template (stopPolling, clear currentSopSessionId/lastCompletedSopSessionId, polling.resetSopVersion, renderer reload) — but renderer reload ONLY when idle; mid-call/awaiting-submit the filled form exists only in the renderer, so it posts a facts-only Notification instead (per alerts-state-facts-only). Tests: node-vm harness with capturing fake timers + fake spawn EventEmitter children for python-backend.js; source-level pins for main.js (the established idiom for the monolith).

Build-state conclusion: everything autonomously completable in the spec is now done (Phase P 10/10, Phase 0 6/6, P1 entry fixes). Remaining phases are gated: §7.1/§7.2 owner sign-offs (journal retention/DPAPI/corpus scrubbing), polling retirement + lock deletion hit the user's confirm-before-replacing-functionality rule, Phase 2/3 exit gates need Phase-0 BASELINE NUMBERS that only real instrumented shifts + a real-key replay run can produce, hang-kill grace windows are a destructive-action design call gated on the CIC Harness kill -9 suite (separate repo).