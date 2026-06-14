---
id: k40nUWTbmShB-YhU28Jnt
session_id: session-20260613-ag3ntic-morph
agent_id: default
task: Re-skin the Operator screen of the AG3NTIC console to the AG3NTIC UI2 (DC) design, preserving all logic.
outcome: approved
created_at: "2026-06-13T10:07:11.338Z"
---

Reskinned platform-infra-ui/apps/web/app/(app)/operator/page.tsx to the AG3NTIC UI2 (DC) design. Presentation-only change; all logic preserved (operator conversation load/restore, job POST /operator/jobs propose, reply vs proposal branch, JobTimeline events query, accept flow POST /operator/proposals/{id}/accept minting the employee, newThread).

Design changes: switched OLD Tachi tokens (--fg-*/--line/--accent/--bg-1/font-display) to UI2 aliases (--bg/--card/--bd/--txt/--ac/--ac2/--accent-ink/--acg/--teal). Cards now 14px (--card/--bd) instead of radius-6 --bg-1. Added a teal OperatorMark (DC sparkle chip, IconSpark, rgba(21,201,184,.14) bg) for the Operator identity — the one teal-tinted chip per the DC slice; message avatars elsewhere stay monochrome. Removed the unused Avatar import. New SpecPreview component renders the DC employee preview tile (monochrome avatar AV_GRAD linear-gradient(145deg,#26262e,#17171c) + initial) + a Summary rows panel (Model/Autonomy/Tools/Budget) read defensively from proposal.spec; the full raw proposal JSON is preserved verbatim inside a DC <details> disclosure ("Full proposal"). Accept button is now the DC primary (background var(--ac), color var(--accent-ink), boxShadow 0 6px 20px -6px var(--acg), 42px). Composer send button uses --ac/--accent-ink.

/operator stays full-bleed via AppContent.tsx app-content-flush (NOT added to PORTED set). Shared ChatPrimitives UserMsg/TypingRow reused unchanged (old token names still alias to identical values in globals.css). npm run build passes clean (TypeScript ok, 21 pages, /operator route present).