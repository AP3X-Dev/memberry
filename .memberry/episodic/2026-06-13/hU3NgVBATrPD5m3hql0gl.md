---
id: hU3NgVBATrPD5m3hql0gl
session_id: session-20260612-ag3ntic-wq23-impl
agent_id: default
task: WQ-23 Task 2 (reap_orphans registry-claim, D11) + pre-existing datetime bug finding
outcome: approved
created_at: "2026-06-13T06:05:49.881Z"
---

WQ-23 Task 2 DONE (commit 69f8509 impl + 2d130a2 checker tests). Generalized reap_orphans carve-out: added tracked_infra = LIVE (deleted_at IS NULL) container_resources rows WHERE container_kind NOT IN ('employee','mcp'), with a parallel `if name in tracked_infra: continue` branch placed after the mcp/runtime-liveness guards and before the workspace/grace reap. Adversarial veto-review confirmed safe across false-protect (container_kind is NOT NULL on both backends; only 2 ContainerResource writers, both excluded), false-reap (name match by construction via server-side docker_name + grace window), cross-tenant (workspace.slug globally unique + embedded in every container name — same basis as the shipped tracked_sidecars carve-out), and ordering (protect-only continue, can only be more conservative). Maker≠checker: separate checker authored 6 tests (1 RED driver + 5 regression guards incl. the employee-orphan trap), implementer made green without touching them.

FINDING (pre-existing, NOT WQ-23, flag for coordinator): apps/api/platform_core/tools/mcp_library_sync.py:196 `age = (_utc_now() - source.last_sync_completed_at).total_seconds()` raises TypeError 'can't subtract offset-naive and offset-aware datetimes' in cross-suite runs (test test_worker_sweep_invokes_reconcile_runtimes in test_runtime_reconcile_sweep.py fails when polluted by a prior test that persists a naive last_sync_completed_at; passes in isolation). This is MCP-library-catalog code added earlier on branch spec/docker-mcp-catalog-sync, not infra code. Fix = normalize last_sync_completed_at to aware (e.g. _as_utc) before subtracting. Matters for the final full-suite green gate (Task 18 done-criteria).