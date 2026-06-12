---
id: 1ZPMg-lAkJp3fdY5NTqPv
session_id: session-20260611-ag3ntic-morph
agent_id: default
task: Viewer 500-storm + frozen chat: root causes, fixes, and verified-for-real protocol
created_at: "2026-06-12T06:27:42.243Z"
---

USER-REPORTED (angry, justified): viewer frame/stream endpoints 500-storming, chat required manual refresh to see replies, approval cards only on the Approvals page. Demanded real testing before "ready" claims.

ROOT CAUSES: (1) the api joins per-workspace capability networks ONLY at sidecar ensure (sidecars.py _ensure_one connects the api container) — a force-recreated api loses ALL attachments; tools self-healed via the shim's lazy re-ensure but the viewer endpoints had no healing and no error handling → httpx.ConnectError ('No address associated with hostname') → unhandled 500 storm. (2) The chat UI was 100% SSE-dependent: assistant messages materialize ONLY on read, and approval cards populated ONLY from live approval.* events — any dropped stream = frozen thread + invisible parked approvals (the user's computer.run_python approval sat 10+ min unseen). (3) My deploy guard initially counted waiting_approval as blocking — parked runs are deploy-safe by design (resume recovery), only queued/running/cancelling should block.

FIXES (commits 3dc2cb8 + a7de40d, deployed + verified): viewer fetch_frame/stream re-ensure the sidecar once on connect failure and return 204 on any remaining failure (never 500); EmployeeChat convergence poll — every 5s re-read session history (triggers lazy materialization server-side, lands replies) + this employee's pending approvals (inline ApprovalCard appears regardless of SSE health), with a message-fingerprint guard so polling never yanks scroll; pending approvals also loaded on mount.

VERIFICATION PROTOCOL ACTUALLY RUN (the new bar before claiming ready): minted a real viewer token in-container; via the published port: cold frame after api force-recreate → 200 + real 1280x800 PNG (self-heal from detached network), warm frame 200, kind=web with no run → 204, garbage token → 401, then docker rm -f mcp-demo-computer → next frame → sidecar relaunched (Up 4s) + 200 PNG. Durable follow-up flagged: a Playwright UI e2e (login → chat → viewer/approval) in apps/web/e2e.

ARCH NOTE for future: consider attaching the api to capability networks in compose/launch instead of only at sidecar-ensure; the lazy re-ensure covers it functionally but the first request after recreate pays the relaunch latency.