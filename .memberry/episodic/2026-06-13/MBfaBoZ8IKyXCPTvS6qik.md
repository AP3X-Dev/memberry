---
id: MBfaBoZ8IKyXCPTvS6qik
session_id: autonomous-ag3ntic-roadmap-2026-06-13
agent_id: default
task: Deploy Phase A (WQ-A) to Cerebro and run the E2E-GOLD post-deploy gate
created_at: "2026-06-13T23:40:29.191Z"
---

Phase A (morph/phase-a @ eb279cb) was DEPLOYED to Cerebro: FF-merged to local main, pushed to cerebro (updateInstead), recreated api/worker (note: api runs `uvicorn main:app` with NO --reload and worker `python worker.py` — `docker compose up -d` sees unchanged infra config and does NOT restart, so an explicit `restart api worker` is REQUIRED to reload bind-mounted source after a source-only deploy), rebuilt web (--build). Stack healthy: api boot gate passed, /api/health 200, web serving 307, worker up. Phase A added no Alembic migration.

The E2E-GOLD post-deploy gate came back RED (8 of 16 Playwright tests fail, incl. gold.spec.ts the 22-step golden path). ROOT-CAUSED to a PRE-EXISTING issue, NOT Phase A: base-main commit 65c3afd "Re-skin every console surface to the new design" (2026-06-13, ancestor of base 12467ec) rewrote 21 web files (+7648/-1785) changing MARKUP across every console page (settings, EmployeeChat +684, ChatViewers, tools, tools/library, tools/[slug]) while the e2e tests were not updated — so the tests' selectors/text drifted. Proven on the keystone: gold step 3 locates `.field` (real form-field class, globals.css:348 + components/ui.tsx Field) but the re-skinned settings "Connect a key" form renders inline-styled divs with no .field class → locator matches 0 → 600s timeout; the DOM snapshot shows the form actually renders fine. Phase A never touched settings/gold.spec/tools/infrastructure. So Phase A is clean; the e2e suite broke at the re-skin and was never caught (prior "E2E-GOLD green twice" predates the re-skin, on the retired opt-hardening lineage).

Operational gotcha (confirmed): running scripts/e2e_gold.sh CONCURRENT with docker builds on the 15GB Cerebro box thrashes it into swap (3.4GB swapped) → broad ~15-17s render timeouts + golden-path 10-min hang. Run E2E-GOLD clean (no concurrent builds); a clean re-run still reproduced the same 8 failures, which is how we separated real/reproducible (selector drift) from environmental.

User decision: root-cause + fix the e2e suite so the gate is genuinely green BEFORE continuing to WQ-B. Fix approach: per-spec classify stale-selector (fix test) vs real re-skin regression (fix UI, flag to user) vs seed-gap; update accordingly; re-run e2e to green. A live e2e stack (project ag3ntic-e2e, api :18096 web :18095, bootstrap ws + api_key) is kept up for ground-truth probing.