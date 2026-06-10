---
id: NOTmwFGq4DCNxTvouo3J2
session_id: session-20260609-rebuild-assessment
agent_id: default
task: [project:amp] Rebuild roadmap implementation — Phases 0 and 1
outcome: approved
created_at: "2026-06-09T22:45:29.362Z"
---

[project:amp] Implemented rebuild Phases 0+1. Phase 0: baseline captured (suite ~1436 green; golden-set Recall@10 0.931, nDCG@10 0.847, MRR 0.903), Exhibit A bleed repro test added (scope-bleed.repro.test.ts — red on old code via two mechanisms: tag-blind byVector and ANY-match byScope), injection-telemetry schema landed unused (InjectionLogStore, migration 0005-injection-log, InjectionLogEntry types). Phase 1 structural tenancy: SemanticNode.scope column persisted at all Semantic CREATE sites (create/supersede/promote inherit scope via coalesce from old node/source episode; bootstrap seeds set projectTag); byScope/byVector take hard projectScope predicate (s.scope = $projectScope OR $projectScope IN s.tags) with vector over-fetch; AMPService.load computes requestedProjectScope (project:* wildcard = deliberate cross-scope) and re-guards every channel including graph expansion via inProjectScope post-filter; berry_grep episodic/semantic switched to scope-column filtering; migration 0006-structural-scope backfills+indexes Semantic/Episodic scope. Exit verified: bleed repro 5/5 green, quality gates identical to baseline, full suite green (one mcp grep fixture updated to new semantics). Deferred + documented: fact scoping (fact.scope is kind-string 'project', grep fact filter was already dead), Symbol/Component scope, EntityResolver scope-aware identity. Gotcha: migrations apply at next MCP bootstrap; running Cerebro server unscoped until restart. Docs: docs/rebuild-baseline-2026-06-09.md, docs/rebuild-progress.md (both gitignored).