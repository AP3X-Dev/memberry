# Retrieval trace live conformance

RET-001D verifies the opt-in `berry_context` trace at the real MCP composition
root. It does not implement, repair, or configure retrieval behavior.

The runner starts the source composition root twice against caller-owned,
loopback-only disposable Redis and Neo4j services. Single-default mode exercises
explicit deterministic, explicit ranked, and actual auto dispatch. Named-tenant
mode requests deterministic retrieval and proves the existing tenant guard
executes and reports ranked retrieval instead.

For every case, omitted and explicit-false `include_trace` calls must return one
identical Markdown block. The true call must return that unchanged Markdown plus
one canonical trace JSON block. The lab validates the production trace contract,
requires exact JSON-RPC request/response correlation, replays it, freezes the
ordinary response's exact ordered result IDs, and binds every traced Markdown
position to the corresponding trace result-order position and source type,
accounts for every planned channel and candidate terminal, checks hard bounds,
and scans for tokens, fixture content, and query text.

Run only with disposable services:

```bash
MEMBERRY_TRACE_LIVE_DISPOSABLE=true \
MEMBERRY_TRACE_LIVE_DEFAULT_TOKEN=fixture-default-token \
MEMBERRY_TRACE_LIVE_NAMED_TOKEN=fixture-named-token \
MEMBERRY_TRACE_LIVE_MCP_URL=http://127.0.0.1:3411 \
MEMBERRY_TRACE_LIVE_REDIS_URL=redis://127.0.0.1:6379 \
MEMBERRY_TRACE_LIVE_NEO4J_URI=bolt://127.0.0.1:7687 \
MEMBERRY_TRACE_LIVE_NEO4J_USER=neo4j \
MEMBERRY_TRACE_LIVE_NEO4J_PASSWORD=fixture-password \
MEMBERRY_TRACE_LIVE_REDIS_CONTAINER_ID=<64-hex-observed-container-id> \
MEMBERRY_TRACE_LIVE_REDIS_IMAGE_ID=<sha256-observed-image-id> \
MEMBERRY_TRACE_LIVE_NEO4J_CONTAINER_ID=<64-hex-observed-container-id> \
MEMBERRY_TRACE_LIVE_NEO4J_IMAGE_ID=<sha256-observed-image-id> \
MEMBERRY_TRACE_LIVE_EVIDENCE_PATH=/tmp/memberry-ret001d/evidence.json \
npm run bench:lab:retrieval-trace:live
```

Configuration rejects non-loopback URLs, embedded credentials, encoded URL
components, and missing disposable opt-in. HTTP reads, requests, startup, child
shutdown, trace size, graph fixture count, and Redis key scans are bounded.
Neo4j operations use native transaction timeouts and close their sessions before
cleanup continues. Redis uses its native command timeout on one ordered connection,
so cleanup and recount cannot overtake a delayed mutation. Abortable HTTP/body and
file operations cancel and drain before returning; child shutdown terminates and
drains the process. Exact run-owned graph nodes/relationships and an explicit run ownership Redis
key are removed after the composition roots stop; concurrent foreign Redis keys
are reported and never deleted. Cleanup, preflight, queries, response bodies,
git inspection, and evidence writes all have hard deadlines. Server output and
arbitrary backend errors are reduced to content-free diagnostic codes. The
uploaded manifest is accepted only from a clean worktree and is bound to the
observed runtime, safe configuration, live Redis/Neo4j versions, and immutable
container/image IDs inspected from the running services. Mutable workflow image
tags are never claimed as evidence identities. The manifest contains only counts, booleans,
algorithm identities, binding/replay digests, runtime metadata, and cleanup state; raw
traces, Markdown, IDs, queries, content, and credentials are excluded.
