---
id: OA10TnlJaNZJt_q_SiKQE
session_id: session-20260609-merge-analysis
agent_id: default
task: Reconcile SCRAPER->PROD merge for tool-gateway + scrape-worker-composition slice files
created_at: "2026-06-10T04:42:25.438Z"
---

Merge analysis of SCRAPER (feat/scraper-self-learning-optimization) into PROD (feature/productionization-self-pilot), fork-base efc2ea8, for 4 slice files:

1. packages/agent/src/tool-gateway.ts — MERGE-AS-IS. PROD added AppointmentRequestWorkflowHook machinery + timezone + primaryUnitTitle/SourceUrl (orig lines 155-690). SCRAPER added imageUrls field through ShopperAgentInventoryUnit type (line 48), toWidgetPanelUnit, buildUnitDetailsQuery, mapSearchResultUnit, mapUnitDetailsRow (lines 635-795). Hunk ranges fully disjoint with >50-line gaps. NO double-registered tool, NO diverged signature — the "gateway" is a typed method object, not a register() registry; SCRAPER altered no methods, only data types/mappers. NOTE: SCRAPER's mapSearchResultUnit reads unit.imageUrls from InventorySearchResultUnit, so that type (in repository/search module, another slice) must also gain imageUrls.

2. packages/agent/src/tool-gateway.test.ts — MERGE-AS-IS. SCRAPER lines 3-157, PROD lines 474-710. Disjoint.

3. apps/worker/src/scrape-worker-composition.ts — HAND-MERGE REQUIRED. SCRAPER rewrote ~342 lines (Firecrawl->DealerCrawl rename w/ alias export createConfiguredFirecrawlAdapterFactory=createConfiguredDealerCrawlAdapterFactory, field adjudicator, API discovery/replay caching). PROD made 2 small edits both landing in SCRAPER-rewritten zones: (a) resolvePostgresPoolTuning() spread into createPostgresPoolExecutor (also adds import from @dealerbot/db; resolvePostgresPoolTuning exists only on PROD's db package, survives via merge target) — SCRAPER kept bare max:5; (b) logger passthrough onto BullMQ workerInput (workerInput.logger). CRITICAL: SCRAPER independently added logger? to CompositionInput and wired it into scheduler loop + runtimeInput but NOT into the BullMQ workerInput. PROD's workerInput.logger plumbing must be re-applied on top of SCRAPER's rewrite or scrape-worker logging regresses silently.

4. apps/worker/src/agent-worker-composition.test.ts — MERGE-AS-IS (verify type union). PROD +683-line CRM/workflow test block at line 157 + testConfig edits at scheduler(229)/secrets(247: signingSecretsByRef). SCRAPER testConfig edits at services.dealercrawl(182) + models.inventoryFieldAdjudication(214). Disjoint by ~10 lines. Merged DealerBotConfig must contain union of all fields from both config-package sides for fixture to typecheck.