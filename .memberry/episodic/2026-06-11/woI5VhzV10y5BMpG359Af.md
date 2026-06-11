---
id: woI5VhzV10y5BMpG359Af
session_id: session-20260610-ag3ntic-ui
agent_id: default
task: Adopt the Paperclip × Tachi design handoff in the AG3NTIC console (chat anatomy, activity rail, takeover nav)
outcome: approved
created_at: "2026-06-11T04:14:50.652Z"
---

Fetched the user's "Paperclip × Tachi" design bundle (claude.ai/design handoff; Paperclip platform shell + Tachi comms layer) to C:\Users\Guerr\Documents\AG3NTIC\_design\paperclip-tachi and implemented its chat-relevant aspects on branch morph/ui-updates (commits ce5aa5b, 3a12dd7).

Decisions:
1. Chat anatomy now matches the merged design: slim breadcrumb bar replaces the chat header (title, session subtitle, live status, Profile link); Stop moved into the composer — the send button flips to a stop square while a run is in flight; accent (sage) user bubbles with ink text; date dividers carry time; flat tile (rounded-square) avatars app-wide; approval cards lost the risk edge stripe (letterspaced status pill + "Open in Approvals" link instead).
2. USER DECISION: the chat right rail is where browser-use and computer-use live views belong — "so we can see what the agent is doing there." Implemented as a 48px WEB/SCREEN rail docking resizable (380–900px) viewer panels (browser chrome + screen frame) with idle states, structured to bind to the Computer capability session feed later (components/ChatViewers.tsx).
3. Hard design rules (from the handoff chat transcripts): no side-of-panel highlight lines anywhere (edge-* CSS classes deleted); 5px scrollbars with no arrow buttons + auto-hide variant; main sidebar locks to its icon rail while /chat is open (no two competing sidebars).
4. Gold gate repointed: composer placeholder is now "Message <name>…" so gold.spec.ts step 10 locates it with /^Message /.
5. Verification approach worth reusing: stub control plane (_design/stub-cp.mjs, node http, fake SSE run incl. approval round-trip) + Playwright drive (_design/verify-chat.mjs) with cookie-injected session (ag3ntic_session/ag3ntic_ws via addCookies) — full visual pass without a live stack.

Known issue noticed (pre-existing): the console Markdown renderer italicizes mid-word underscores (deal_acme_reroof → "deal*acme*reroof" effect) — GFM only allows emphasis at word boundaries. Also: the user's C: drive hit 0 bytes free mid-build; .next was cleared to recover (~350MB free now).