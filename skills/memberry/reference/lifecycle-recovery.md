# Lifecycle recovery

When updates appear frozen, locate the first failed stage.

1. Verify a non-duplicate episode exists with the expected scope, tags, embedding, and entity edges.
2. Confirm `berry_store.entities` contained canonical IDs.
3. Check `memory_type` and `outcome`. An explicit approved decision needs neither an embedding nor an LLM; patterns/conventions require at least three related embedded episodes, independent sources, and an LLM.
4. Inspect coordinator health/readiness, queued scopes, retries, and last success/error before manually running consolidation.
5. Manual approval is only expected for intentionally review-only correction, contradiction, supersede, or decay proposals.
6. Query the resulting Semantic and its `PROMOTED_FROM` provenance.
7. For decisions, verify `memory_type: "decision"` and confidence `>= 0.7`; unclassified high-confidence rows are legacy fallback only.
8. For patterns, verify `memory_type` is `pattern`/`convention` and stable non-project tags survived recurrent evidence. Project-local classified patterns render immediately after promotion; only the legacy cross-project theme rollup requires the tag in two distinct real projects.
9. Compile with `project_tag: "all"`, lint, refresh the viewer cache, and inspect served contents.

The autonomous coordinator is the normal path: successful stores schedule consolidation and publication, startup/periodic catch-up recovers missed work, and bounded retries self-heal transient failures. Use manual compile/refresh only after automation reports stale, exhausted, or degraded publication.

After fixing an env or mount error, restart MCP, compile all projects explicitly, request `POST /api/refresh`, and fetch `/wiki/_index`, `/wiki/_decisions`, `/wiki/_patterns`, and `/wiki/_recent`.

Before archiving a working block, store and verify a durable summary, then promote and verify anything that belongs in core. Archive last because it deletes the source and returns only `archived_length`.
