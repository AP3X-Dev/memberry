---
id: z2QwPXHaWRhFswqRnFwIP
session_id: session-20260613-ag3ntic-morph
agent_id: default
task: Root-cause failing Playwright e2e spec apps/web/e2e/chat-viewers.spec.ts (3 tests) after re-skin commit 65c3afd
created_at: "2026-06-13T23:41:42.333Z"
---

Root-caused chat-viewers.spec.ts (3 failing tests) against re-skinned EmployeeChat.tsx/ChatViewers.tsx. The re-skin (65c3afd "Re-skin every console surface") REPLACED the old 48px vertical ChatRail (.rail-btn / .rail-btn-active, WEB/SCREEN/TERM) + auto-opening ViewerPanel architecture with an always-visible tabbed workspace (Overview/Computer/Browser/Files/Terminal/Artifacts) rendered alongside the thread. EmployeeChat.tsx no longer imports ChatRail or ViewerPanel (both still exist in ChatViewers.tsx but are DEAD/unused — cleanliness-gate violation). DOM snapshot confirms chat renders fine; default tab=Overview; the tool.intercepted chip even renders ("browser · browse_url running…").

(1) :7 browser-rail-auto-open and (2) :111 computer-rail-auto-open are real-ui-regression vs test intent: auto-open was DELIBERATELY removed — EmployeeChat.tsx line 865-867 comment: "No auto-open: the viewer is opt-in ... auto-popping it on every tool call was intrusive." Placeholders "No live browser session"/"No active computer session" only render when user clicks the Browser/Computer tab. .rail-btn-active class + WEB/SCREEN labels are gone. needs_user_decision (user's fresh re-skin): either restore auto-open (UI edit) or rewrite tests to click tabs (drops auto-open coverage).

(3) :215 terminal is stale-test-selector ONLY: interactive command flow ("Type a shell command" input + "Run" button) survives in the Terminal tab's activity-tail TerminalChrome; the whole submit→/runs POST→startTerminalStream→entries flow works. Sole drift = tab label "TERM" → "Terminal". Fix: getByRole("button",{name:"TERM",exact:true}) → name:"Terminal". The "> echo hello"/"run started"/"hello from shell" assertions all still pass with new UI.