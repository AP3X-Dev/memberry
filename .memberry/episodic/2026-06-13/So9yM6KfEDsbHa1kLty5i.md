---
id: So9yM6KfEDsbHa1kLty5i
session_id: session-20260613-ag3ntic-morph
agent_id: default
task: Implement the AG3NTIC UI2 design (AG3NTIC.dc.html handoff) across the whole console, pixel-faithful, preserving all features.
outcome: approved
created_at: "2026-06-13T09:33:33.617Z"
---

Began the full console redesign to "AG3NTIC UI2" (the Claude-Design handoff bundle AG3NTIC.dc.html — bolt-style dark canvas, single teal accent #15c9b8, soft 14px corners, Onest font, monochrome avatars). Work is in worktree platform-infra-ui (branch wq23/infra-ui), apps/web ONLY. Handoff bundle extracted to C:/Users/Guerr/Documents/AG3NTIC/_design_src/ (README, chat1.md = design intent, AG3NTIC.dc.html, screens/*.png, support.js). Port plan: C:/Users/Guerr/Documents/AG3NTIC/_design_src/spec/PORT-PLAN.md.

APPROACH: re-skin in place — the app is class-based (globals.css .card/.btn/.side-item/.tabs/.list-row...), so re-pointing the :root token block flipped the whole app to teal/soft/Onest at once; then per-page structural work. All data wiring (lib/api,sse,types,format,server + TanStack Query + viewers) preserved.

DONE & BUILD-VALIDATED (next build green, TS clean):
- Foundation: globals.css token block re-pointed (kept Tachi var NAMES --bg-*/--fg-*/--accent*/--line*/--r-*/--font-* but re-valued to UI2; added DC aliases --bg/--panel/--card/--card2/--hover/--bd/--bd2/--txt*/--ac/--ac2/--acg/--teal/--accent-ink #04211d), Onest+JetBrains @import, DC keyframes (ag-drift1/2/3 etc.), and the mobile @media(<=860px) data-m scaffold.
- Shell: Sidebar.tsx rebuilt to DC (266px expanded / 64px rail, collapsed-by-DEFAULT via layout cookie default flip, sections Workspace/Team/System, org switcher+Pro, New-employee, user card) wired to REAL approvals badge/health/me/workspace + sign-out + chat rail-lock. Uses inline DC SVG glyphs.
- Home (/dashboard): full DC port (teal-nebula hero + work composer that routes to /chat, 4 stat cards, recent-activity, pending-approvals, team grid) on real employees/runs/approvals queries. This is the REFERENCE PATTERN other pages follow.
- AppContent: ported routes render in DC scroll model (no top page-bar); PORTED set = dashboard,tasks,approvals,employees,memory,budgets,settings,tools,vault.

IN FLIGHT: background Workflow wf_ff6f5dd6-11b porting 11 core pages (tasks, approvals, employees, profile, tools, toolDetail, library, memory, budgets, settings, NEW vault) with a feature-preservation verify stage.

REMAINING: integrate workflow output (add routes already pre-registered; build+fix), signature Chat screen (split/focus/tabs wrapping real EmployeeChat+ChatViewers+workspace.tsx+xterm — doing myself), Operator, gap pages (capabilities, skills, tools/custom, tools/library/[entryId], connect), mobile chrome (topbar/bottomnav/drawer), final verify. Decisions made: sidebar collapsed-default (design), Vault is a NEW /vault page, Capabilities/Skills to be folded/reskinned (not in DC nav).