---
id: jO_vi5CJcYnJkB2oAOneM
session_id: autonomous-ag3ntic-roadmap-2026-06-13
agent_id: default
task: Repair the E2E-GOLD gate (4 root causes) so it is genuinely green post-deploy
created_at: "2026-06-14T01:06:42.936Z"
---

The post-deploy E2E-GOLD red (8/16) was FOUR independent, pre-existing causes — none from Phase A's feature work — all surfaced only because the gate finally ran on Cerebro (the SQLite pytest suite + ruff + tsc + the diff verifier were all blind to them):

1. RE-SKIN SELECTOR DRIFT (commit 65c3afd "Re-skin every console surface", base main): inline-styled markup + data-m markers replaced the .field/.row/.row-link/.card classes; status pills title-cased (Draft/Untested/Active); memory composer + infra "Secret requirements" collapse by default; chat WEB/SCREEN/TERM rails became opt-in tabs (Browser/Computer/Terminal); tool cards became card-wide role=link (no nested Details anchor); /tools link is "Browse library"; library search placeholder "Search integrations…"; library card dropped its badge row. FIX: updated the gold/chat-viewers/infrastructure/tools-detail/tools-library selectors to match (no UI change — user directive "match the UI, don't change design").

2. PHASE-A IDEMPOTENCY BUG (commit 6bbb76a) — PROD-BREAKING: chat-send uses run_idempotent(scope="chat.send") but ck_idempotency_keys_scope (migration 20260609_0003) allowed only 8 of the ~20 scopes the code uses → CheckViolation → 500 on Postgres for every chat send (the console always sends an Idempotency-Key). FIX: migration 20260613_2301 rebuilds the CHECK with the full union; deployed to prod (pg_dump first). KEY LESSON: the SQLite test DB is built from models.py create_all and carries NO migration CHECK constraints, so pytest can never catch a scope/allowlist drift — smoke idempotency on Cerebro PG. Keep the allowlist in sync with every new run_idempotent scope.

3. E2E RUNTIME NON-DETERMINISM: tasks/runs.py _ensure_hermes_runtime unconditionally hotboots the employee runtime before the acp_eligible check. On Cerebro the pinned image localhost:5000/ag3ntic-hermes-employee IS pullable (the ag3ntic-registry container), so the runtime launches healthy → run routes to the ACP worker and hangs "queued" (gold step 11). A non-pullable image instead makes launch fail and LEAKS sha256/docker-socket-proxy into user-facing runtime events (gold step 21 AC-24). FIX: new setting runtime_hotboot_enabled (default True; prod unchanged); the gate sets RUNTIME_HOTBOOT_ENABLED=false (added to scripts/e2e_gold.sh write_env) so runs always take the inline executor seam — the gate's documented "never launches runtimes". GOLD CANNOT pass on Cerebro without this flag.

4. RECONCILER FK NOISE (WQ-23): the e2e worker's infra_reconciler sees the prod stack's Docker networks (shared daemon) and FK-violates writing a drift audit for a foreign workspace. CAUGHT by worker.py:101 ("best-effort; never abort the sweep"), so non-blocking — left as cleanup backlog.

Fast e2e debug loop used: keep ONE live e2e stack up (compose project ag3ntic-e2e, api :18096 web :18095), scp edited *.spec.ts to the Cerebro checkout, run `npx playwright test e2e/<spec> --project=chromium` against it (~seconds). gold mutates workspace state, so re-runs need a fresh DB (compose down -v + up; re-read /tmp/ag3ntic-e2e-bootstrap.json for the new ws + api_key). Branch morph/e2e-reskin-reconcile: b51d78f (idempotency + initial selectors), b97ead4 (hotboot flag + approvals), c8bc794 (chat-viewers + tools adaptations).