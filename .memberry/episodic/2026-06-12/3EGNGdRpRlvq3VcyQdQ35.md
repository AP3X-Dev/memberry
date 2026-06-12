---
id: 3EGNGdRpRlvq3VcyQdQ35
session_id: session-20260611-ag3ntic-morph
agent_id: default
task: Correct branch/deploy convention for the platform fork
created_at: "2026-06-12T01:45:11.912Z"
---

CORRECTION to the stale 'morph/opt-hardening' convention. Reality of the platform/ git repo (C:\Users\Guerr\Documents\AG3NTIC\platform): `origin` = the pristine Desktop original (C:\Users\Guerr\Desktop\AG3NTIC) — NEVER push to origin. Local `main` is the morph INTEGRATION line (371+ commits ahead of origin/main). There is NO morph/opt-hardening branch anywhere (local/cerebro/origin). `cerebro` remote = cerebro@192.168.0.25:/home/cerebro/projects/ag3ntic-morph; `cerebro/main` == local main (d44b69d) and IS the deploy target. Workflow going forward: feature work on morph/* branches off main, merged into main, deployed by pushing main to cerebro. CLAUDE.md (at the AG3NTIC root, not under platform/ git) was updated to reflect this. Current feature work for the browser capability is on branch `morph/browser-capability` (spec committed at platform/docs/superpowers/specs/2026-06-11-ag3ntic-browser-capability-design.md).