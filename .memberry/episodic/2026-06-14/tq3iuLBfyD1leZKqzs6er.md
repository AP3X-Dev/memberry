---
id: tq3iuLBfyD1leZKqzs6er
session_id: session-20260613-audit
agent_id: default
task: Audit retrieval/ranking hot-path performance in MemBerry
created_at: "2026-06-14T03:33:13.485Z"
---

Retrieval hot-path perf audit findings (verified against working tree at C:/Users/Guerr/amp-audit):

1. No query-embedding cache on retrieval path. createCoreServices (services-factory.ts:132) wires the RAW OpenAIEmbedding into CodeSearch, UnifiedAssembler, and intent.ts. The Redis EmbeddingCache exists but is only used by AMPService.store (service.ts:445) and _getEmbedding (service.ts:755). Every embed() on the retrieval path is a fresh OpenAI round-trip with no cache.

2. Duplicate embed of identical query in CodeSearch.search (search.ts:45-50): vectorSearch(query) (line 200) and semanticVectorSearch(query) (line 296) each independently call embedding.embed(query) for the SAME string -> 2 OpenAI calls per code search when include_semantics:true (berry_code_context/buildContext path).

3. Cross-module duplicate embed on auto-strategy ranked path: assemble() calls classifyIntent(task) which embeds task (when rules miss), then assembleRanked calls codeLayer.search(task) -> vectorSearch embeds task again. Same string, no shared cache.

4. intent.classifyByEmbedding (intent.ts:229) recomputes l2Norm(exemplarVec) for all ~29 exemplars on every non-rules query; exemplar VECTORS are cached (WeakMap) but their norms are not. ~29x1536 redundant ops/query.

5. fusion.ts entity_boosts loop (lines 51-63): per fused entry x up to 50 boost entries, each doing String.includes() on content+title -> ~3000 substring scans per ranked query. Bounded, lower severity.

NOT findings (existing defenses adequate): mmrDiversify is capped at 200 candidates with early-exit (scoring.ts:283,336); expandQuery is pure/synchronous with no LLM round-trip (expand.ts) -- the suspected expandQuery LLM cost does not exist.