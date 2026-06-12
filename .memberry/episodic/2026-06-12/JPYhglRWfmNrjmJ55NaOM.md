---
id: JPYhglRWfmNrjmJ55NaOM
session_id: session-20260611-ag3ntic-morph
agent_id: default
task: Merge + deploy the browser capability to Cerebro and verify end-to-end
created_at: "2026-06-12T03:13:44.815Z"
---

DONE — browser (ag3ntic-browser) capability is LIVE on Cerebro and verified end-to-end.

Merged morph/browser-capability into main (merge 179a26e). Built ag3ntic/browser-capability on Cerebro, pushed to localhost:5000, pinned BROWSER_CAPABILITY_IMAGE_DIGEST in ~/projects/ag3ntic-morph/.env (final digest sha256:26c6c545b1f7cbc360a10d4a464376c5745f4c929e0cc7532203c2a72b226326), recreated api/worker, applied Alembic 20260611_1001 (run_downloads). Seeded capability: type=browser_worker, pinned. The platform launched sidecar mcp-demo-browser (capability network ag3ntic_capability_wsp_65af44e194692baac5f5efae), health gate passed, and search_web returned real results over the network.

KEY FIX during deploy: DuckDuckGo's html/lite endpoint 403s datacenter/headless traffic — switched search_web to BING (server-side HTML, headless-tolerant) + Accept-Language header; added a Bing ck/a redirect URL unwrapper so results carry real target URLs (better usability + browse_url egress-checks the real host). Image smoke verified: /healthz ok (Chromium launches), egress guard blocks 169.254.169.254, Bing search returns clean results.

CAVEAT — git sync: the deploy host worktree (~/projects/ag3ntic-morph) is DIRTY with the user's concurrent UI WIP (apps/web/app/globals.css modified, apps/web/e2e/chat-composer.spec.ts untracked), which BLOCKS `git push cerebro main` (receive.denyCurrentBranch=updateInstead refuses a dirty tree). So the host git stays at 179a26e while local main has the Bing+unwrap commits; I delivered those to the host via scp of runtimes/browser-worker/app/*.py and built from there. The RUNNING IMAGE is correct, but host git ≠ deployed source. To reconcile: user commits/stashes their web WIP on the host, then pull/reset host main to local main. The user's WIP was never touched.

NOTE on the live viewer / image reality: the chat right-rail browser/screen viewer renders the COMPUTER capability's screen, and its live-stream backend is NOT wired (UI shell only) — so "No live browser session" shows even when computer.open_url/screenshot succeed. The browser capability is HEADLESS (text/search/download), no screen. User asked (option C) to ALSO build: (1) live viewer of browser/computer in the side panel, (2) agent sharing screenshots/documents inline in chat, (3) a live interactive terminal — a separate multi-feature epic to design next.