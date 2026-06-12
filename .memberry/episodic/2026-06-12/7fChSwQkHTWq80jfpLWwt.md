---
id: 7fChSwQkHTWq80jfpLWwt
session_id: session-20260611-ag3ntic-morph
agent_id: default
task: Sprint C interactive terminal — built, deployed, live-verified; live-surfaces epic complete
created_at: "2026-06-12T05:21:46.110Z"
---

SPRINT C (interactive terminal) DONE + deployed on Cerebro; suite 1110 green. The full live-surfaces epic (A inline artifacts, B+B5 live viewer w/ CDP screencast, C terminal) is now shipped.

ARCHITECTURE: human-driven PTY = docker exec tty=True into the EMPLOYEE'S RUNTIME CONTAINER (works for every employee, no capability dependency, no image rebuild). New docker_client primitives exec_attach_tty (returns sock+exec_id+close; raw PTY bytes, no demux) + exec_resize. platform_core/terminal/service.py: session registry (in-process; api restart drops sessions — flagged MVP limit), reader thread→asyncio.Queue (drop-oldest on full), ≤512KB transcript tail persisted via persist_run_artifact(kind=document, capability_slug='terminal') on close, audited terminal.session_opened/closed, one session per employee, 10-min idle reap. Router: manager+ via authorize_workspace_role; SSE stream (terminal.data base64 frames + 15s heartbeats + terminal.closed control frame), POST input (≤8KB)/resize, DELETE close. KEY TRANSPORT DECISION: NO WebSocket — the console's /proxy is a Next ROUTE HANDLER which cannot proxy WS upgrades, and the no-backend-origin principle stands; duplex = SSE down + POST up (works through the existing proxy passthrough). UI: @xterm/xterm + @xterm/addon-fit (npm, package-lock), LivePty in ChatViewers.tsx (dynamic import for SSR safety, xterm CSS from node_modules OK in app router), full-mode TerminalChrome = live PTY, dock mode unchanged.

LIVE ACCEPTANCE: resumed the paused HVAC Lead Gen, opened a session via the service in-container: real bash prompt hermes@employee-demo-hvac-lead-gen, `echo hello-from-pty $((6*7))` → 'hello-from-pty 42', audits [session_opened, session_closed], artifact terminal-<id>.log 264 bytes. Paused the employee back afterward (state restored).

GIT: the user's checkout switched to branch MCPToolingUpdates mid-build AGAIN — caught by the pre-commit branch check (the saved lesson works). Resolution pattern that avoids touching the user's working tree: `git fetch . <their-branch>:main` fast-forwards main IN PLACE (no checkout), then push main to cerebro. Used twice; safe when their branch == main + my commits only.