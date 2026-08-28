# MemBerry Evaluation Lab

The lab is the permanent measurement spine for MemBerry changes. It preserves the
pre-lab quality results as an immutable control, runs deterministic protected
scenarios in pull requests, and provides a fail-closed adapter for disposable live
MCP environments.

## Evidence tiers

| Mode | Purpose | What it proves |
|---|---|---|
| `fixture` | Frozen BM25/recency controls | Evaluator and gate sensitivity |
| `proxy` | Fast candidate inner loop | Deterministic behavior of the proxy only |
| `live` | MCP + Redis + Neo4j integration | The exercised production path |

Admission-policy evidence is a sibling structural suite, not a retrieval
adapter. Its registered fixture systems execute the real `AMPService.store`,
`AdmissionShadowRuntime`, trusted admission preprocessor, parser, and baseline
policy with deterministic in-memory persistence. Its fidelity is reported
exactly as `production-core / fixture-persistence`; it does not claim live Neo4j
or MCP coverage.

MEM-001D2 is registered separately as
`composition-root / live-disposable-persistence`. It starts the real MCP
composition root in default-off and enabled modes, enters through Streamable
HTTP `berry_store`, and uses direct Neo4j only as a scorer-side oracle and exact
fixture cleanup boundary. It does not relabel the structural suite or claim
durable retry, healing, history completeness, or production readiness.

Proxy scores are never labeled as live MemBerry results. An unsupported capability,
adapter failure, and a real zero score are separate outcomes. Empty responses fail
the joint recall and answer-coverage gates and cannot earn stale/isolation credit.

## Reading the scores

Lab scores are normalized from `0` to `1`; multiply by 100 for a percentage.
Higher is better except for rates named `leak`, `duplicate`, or `unknown`, where
`0` is ideal.

The current migrated retrieval report shows `answerCoverage = 0.8461538462` for
both the scope-aware BM25 control and the MemBerry proxy. That is `11 / 13`, or
84.615% of required answer units retrieved across 13 probes. More concretely, ten
probes were fully covered, two were half-covered, and one returned no answer. It
does **not** mean live MemBerry is 84.6% accurate, and it currently shows no lift
over this control (`delta = 0`).

| Metric | Plain-English meaning | Current proxy | Current control |
|---|---|---:|---:|
| Answer coverage / Recall@K | Required answer evidence retrieved | 0.8462 | 0.8462 |
| Precision@K | Fraction of returned items that were relevant | 0.5513 | 0.5513 |
| Reciprocal rank | How near the top the first relevant item appeared | 0.8846 | 0.8846 |
| nDCG@K | Overall relevance ordering quality | 0.8352 | 0.8352 |
| Stale leak rate | Returned items known to be stale | 0 | 0 |
| Isolation leak rate | Returned items from a forbidden project/tenant | 0 | 0 |

“Without MemBerry” must be named precisely:

- **No-memory control:** the agent receives no stored evidence. This is not yet
  part of the required migrated suite and will be added to comparison work.
- **Scope-aware BM25 control:** a simple lexical memory retriever with scope/time
  filtering. This is the current control shown above.
- **MemBerry proxy:** a deterministic inner-loop stand-in, not the live platform.
- **Live MemBerry:** real MCP, Neo4j, and Redis. The current live smoke proves
  wiring/isolation only; it is not yet a scored live retrieval comparison.

The external benchmark activation plan, including the future no-memory and live
comparisons, is tracked in [ROADMAP.md](ROADMAP.md).

## Data safety

- Committed fixtures are synthetic and attest that they contain no real user memory,
  credentials, customer data, or secrets.
- Adapter-visible inputs and scorer-only oracle labels live in separate files.
- External datasets are downloaded only through the registry-driven acquisition
  command. Unknown licenses, missing hashes, or unreviewed data fail closed.
- The live adapter is read-only unless `MEMBERRY_LAB_ALLOW_WRITES=true` is set.
  Writes use unique `project:memberry-eval-*` scopes and a visible
  `MEMBERRY_LAB_ID` marker.
- The public MCP API has no safe broad reset. The live adapter therefore does not
  claim cleanup capability and never deletes graph data. Disposable test stores are
  the preferred live environment.

## Common commands

```bash
# Protected temporal, stale, project, and tenant comparison
npm run bench:lab

# Contract, metric, adapter, registry, acquisition, and gate tests
npm run bench:lab:test

# Verify registry metadata and the immutable pre-lab baseline
npm run bench:lab:validate
npm run bench:lab:baseline:verify

# Mandatory deterministic CI comparison
npm run bench:lab:ci
```

The deterministic CI command also runs all 11 admission structural dev/holdout
cases offline under the Node 20/22 unit matrix. It hard-gates scenario coverage,
baseline outcome/write parity, observation/safe-facts/policy/delivery accuracy at
`1`, and content/scope leakage at `0`.

The CLI also supports `--suite protected|retrieval|all`,
`--split dev|holdout|all`, `--run-id`, and `--output`. The migrated retrieval suite
retains known baseline weaknesses honestly; use it for comparison evidence rather
than weakening its oracle until it turns green.

## Live smoke test

Run this only against an explicitly disposable service stack:

```bash
MEMBERRY_LAB_TENANT_ID=lab \
MEMBERRY_LAB_API_TOKEN=lab-test-token \
MEMBERRY_LAB_MCP_URL=http://127.0.0.1:3101 \
MEMBERRY_LAB_ALLOW_WRITES=true \
npm run bench:lab:live
```

The command fails when any opt-in setting is absent. It stores one uniquely marked
synthetic fact and verifies the exact episodic record through scoped `berry_grep`,
which works without an embedding provider. This smoke proves MCP/database wiring
and isolation; scored live queries still use `berry_load` and must report the real
retrieval result. The adapter also confirms it does not claim destructive cleanup.

## Admission live composition evidence

Run this only with caller-owned disposable Redis and Neo4j services bound to
loopback. All opt-ins and credentials are separate from ordinary deployment
variables:

```bash
MEMBERRY_ADMISSION_LIVE_ALLOW_WRITES=true \
MEMBERRY_ADMISSION_LIVE_DISPOSABLE=true \
MEMBERRY_ADMISSION_LIVE_API_TOKEN=fixture-token \
MEMBERRY_ADMISSION_LIVE_MCP_URL=http://127.0.0.1:3311 \
MEMBERRY_ADMISSION_LIVE_REDIS_URL=redis://127.0.0.1:6379 \
MEMBERRY_ADMISSION_LIVE_NEO4J_URI=bolt://127.0.0.1:7687 \
MEMBERRY_ADMISSION_LIVE_NEO4J_USER=neo4j \
MEMBERRY_ADMISSION_LIVE_NEO4J_PASSWORD=fixture-password \
MEMBERRY_ADMISSION_LIVE_EVIDENCE_PATH=/tmp/memberry-admission-live/evidence.json \
npm run bench:lab:admission:live
```

The runner rejects non-loopback endpoints plus non-root paths, URL credentials,
percent encoding, query strings, and fragments; generates unique tenant/project/session/content
fixtures, and does not inherit arbitrary parent environment secrets into either server process. It proves one default-off
Episodic with no sidecar; one enabled, correctly scoped, content-free linked
sidecar; no duplicate/invalid-store mutation; and truthful authenticated
readiness limitations. Before either store, it requires both authenticated
`/readyz` and a read-only `berry_tools:list` transaction through Streamable HTTP
`/mcp`. The production server's legacy "SSE server" startup label describes the
shared HTTP listener, which serves `/mcp`, `/readyz`, and the legacy `/sse` route;
it is not accepted as transport proof. Readiness and every Streamable HTTP
response are time- and byte-bounded, remote bodies are never copied into failure
diagnostics, and the transport probe must return the exact nonempty tenant-domain
registry. Exact unique fixture scopes are deleted in `finally` and
zero residual Episodic/AdmissionObservation/auto-created project Entity counts
are recorded. Non-auto or externally managed Entity nodes are never deleted. Redis and
container teardown remain the caller's responsibility and are labeled as such
in the evidence instead of being implied by graph cleanup.

The production composition root does not wire AMPService's optional legacy
project-Entity seam, so both stores require an exact project Entity count of zero.
Cleanup still defensively deletes and residual-counts only an exact auto-created
fixture Entity in case that production wiring changes; numeric-only count failure
codes expose episode/observation/project-Entity drift without IDs or content.

The tenant-token fixture intentionally activates logical multi-tenant mode. In
that mode the production composition root marks shared consolidation/wiki
automation unhealthy and returns HTTP 503 from `/readyz` to expose the unsupported
cross-tenant lifecycle path. The runner accepts 503 only when the authenticated
body carries that exact disabled/default-worker limitation plus closed admission-shadow
and counter shapes. Because this fixture always enables tenant-token mode, HTTP 200
is a status mismatch even when paired with an otherwise exact unhealthy body. Evidence
projects only the enumerated shadow fields and records the validated 503/class; unrelated 503s retry
within the startup bound, while 401, 403, 404, 500, and other stable failures stop
immediately with body-free numeric diagnostic codes.

## Retrieval trace live conformance

RET-001D is a separately registered composition-root proof for the opt-in
`berry_context` trace. Against disposable loopback Redis and Neo4j, it exercises
deterministic, ranked, actual auto, and named-tenant forced-ranked dispatch over
Streamable HTTP. Omitted/false requests must retain the one-block ordinary path;
true must add exactly one canonical, replayable, content-free trace after unchanged
Markdown. JSON-RPC responses must correlate exactly, and every exact ordered
Markdown result position is bound to the trace result order. The runner removes only exact
run-owned fixtures, never concurrent Redis keys, and emits a clean-worktree,
runtime/config-bound sanitized manifest with live service versions and inspected
immutable container/image identities. See
[retrieval-trace/README.md](retrieval-trace/README.md).

## Adding a scenario

1. Put memories and query text in an `*-inputs.ts` or `input.jsonl` file.
2. Put relevance, required, stale, and forbidden IDs in the paired scorer-only
   oracle file.
3. Assign `dev` or `holdout`; never tune candidate logic against holdout labels.
4. Declare only capabilities the scenario genuinely requires.
5. Add hand-calculated metric expectations and one deliberate-regression test.
6. Update the dataset registry hash and data-policy attestation.

Adapters receive only `IngestRequest` and `QueryRequest`; the runner owns all oracle
data. New candidates must have a distinct identity and implementation from the
frozen control.

## Artifacts and reproducibility

Each comparison records the source and baseline commits, dirty state, normalized
dataset/config hashes, seed, runtime, execution identities, exclusions, capability
gaps, and metric deltas. Diagnostic configuration is recursively secret-redacted.
The report, manifest, and JSON comparison publish as one immutable directory rename;
an existing run ID is never overwritten.

The pre-lab baseline is locked under `baselines/` and verified from Git object bytes,
so later dead-code cleanup does not erase the evidence needed to reproduce it.

Deferred external benchmark work is governed by [ROADMAP.md](ROADMAP.md), not by
an informal TODO. LongMemEval and LoCoMo remain fail-closed until its activation
packets and approvals are complete.

## Layout

```text
bench/lab/
  admission/    production-core structural runner and registered fixture systems
  admission-features/ MEM-002 feature-label evaluation boundary and blinded-holdout
                packets (own README)
  adapters/     frozen controls, proxy candidate, opt-in live MCP adapter
  baselines/    immutable pre-lab manifest, lock, comparison policy
  contracts/    versioned retrieval and sibling structural evidence contracts
  datasets/     synthetic input/oracle splits and registry-driven acquisition
  eval001/      pinned render-grammar test for the EVAL-001 runner
  fixtures/     committed protected and migrated behavioral scenarios
  golden-v2/    tombstoned RET-GOLDEN-V2 calibration record (never built)
  multihop/     RET-007 multi-hop instruments v1-v4: policy, generators, calibration
  registry/     datasets, systems, metrics, and default-off experiments
  ret010/       served-reranker development gate — invoked by name in CI (ci.yml:65)
  retrieval-trace/ opt-in MCP trace conformance and disposable live evidence
  ROADMAP.md    deferred dataset activation packets and acceptance gates
  __tests__/    golden metrics, hostile regressions, contract boundaries
```
