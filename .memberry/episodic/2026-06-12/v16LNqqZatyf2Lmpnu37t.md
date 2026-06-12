---
id: v16LNqqZatyf2Lmpnu37t
session_id: session-20260611-ag3ntic-morph
agent_id: default
task: B5 buttery-smooth live viewer upgrade (CDP screencast + proxy binary fix), deployed
created_at: "2026-06-12T04:58:56.133Z"
---

B5 (user: "I do want buttery-smooth") DONE + deployed on Cerebro, suite 1105 green.

SHIPPED: (1) runtimes/browser-worker/app/screencast.py — CDP screencast manager: Page.startScreencast (jpeg q70 1280x800) via context.new_cdp_session(page), frames base64-decoded into a per-run ScreencastBuffer (latest-frame + asyncio.Condition, seq counter), screencastFrameAck per frame, viewer refcount stops the cast when the last viewer leaves; GET /stream serves multipart/x-mixed-replace (mjpeg_part framing, 1s keepalive re-emit of the last frame on quiet pages; static page ≈1fps keepalive, active page = frame per paint). Seeds frame zero with page.screenshot so the panel shows content immediately. (2) viewer/service.stream_target + GET /viewer/stream relay: token-authed, httpx client.send(stream=True) → StreamingResponse(aiter_raw) with the client/upstream closed in the generator finally; 204 → UI falls back to polling. kind=screen has NO stream (scrot too slow; ffmpeg x11grab upgrade to the desktop image is the flagged path). (3) LiveFrame stream-first for web with poll fallback + 15s retry backoff (lastStreamFail ref prevents flicker loops). Browser image pinned sha256:5b0f9d85.

CRITICAL BUG FOUND+FIXED: apps/web/app/proxy/[...path]/route.ts buffered ALL non-SSE responses via `await resp.text()` — which TEXT-DECODES and corrupts binary. Sprint A inline artifact images through /proxy were broken (unverified visually; only curl-tested against :8096). Fix: passthrough branch (resp.body unbuffered) for text/event-stream, multipart/x-mixed-replace, image/*, audio/*, video/*, octet-stream, pdf (+Content-Disposition forward). LESSON: live-verify through the FULL user path (console proxy), not just the API origin.

DEPLOY GOTCHA: `docker compose up -d api` does NOT restart api when no env/config changed (bind-mounted code changes need `--force-recreate`).

Live-surfaces status: Sprint A done, Sprint B done incl. B5; Sprint C (interactive terminal: PTY + first WebSocket + governance model) NOT started — next up.