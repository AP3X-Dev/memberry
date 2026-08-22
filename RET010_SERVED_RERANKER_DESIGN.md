# RET-010 Served Reranker Design Freeze

Status: proposed design freeze

Design base: `f55f61e2dca958627ed01766332d23f9d565c689`

Roadmap route: `RET-010 -> RET-006 material utility -> G2 Retrieval 2.0`

## 1. Decision

RET-010 promotes one bounded, local, deterministic, query-aware reranker into
the response path used by `berry_context` and `berry_ask`. It runs after ranked
fusion/MMR and deduplication and before token budgeting. Its result therefore
changes which evidence is actually returned under a tight budget; it is not a
shadow metric, identity provider, presentation-only reorder, or flag-only
promotion.

The promoted model is a frozen lexical BM25F-style scorer implemented inside
`@memberry/retrieval`. It makes no network call, reads no secret or mutable
global corpus, persists nothing, and maintains no cross-request cache. The
existing remote-provider seam remains unwired.

This packet can close RET-004 and RET-010 after implementation and hosted
qualification. It cannot close RET-006 or G2 by itself. RET-006 still requires
material task-success-per-token evidence, and the declared `+0.05`
Precision@5 gate remains unarmed until that evidence exists. RET-007 remains
parked under its additive-v3 owner stop/restart rule and is not changed here.

## 2. Current effect chain and the defect

The authority-bound serving chain on the design base is:

```text
authenticated HTTP identity
  -> tenant-bound retrieval container
  -> berry_context / berry_ask
  -> authenticated planner receipt
  -> tenant/project/time-bound candidate execution
  -> RRF/MMR fusion
  -> deduplication
  -> shadow-only identity observation
  -> token budgeting
  -> returned Markdown or synthesized answer evidence
```

`MEMBERRY_RERANKER_V1` currently treats absent/empty as disabled and accepts
only explicit `shadow`; explicit `disabled` and `served` are new RET-010 values.
Shadow uses `baseline-identity-v1`, observes the post-dedup list, and cannot
affect the response. The existing calibrated reranker contract already bounds
input, provider output, time, stable ties, and baseline fallback, but it is not
applied to serving.

There are two ranked assembly surfaces. The normal `assemble(... ranked)` path
is used by the registered lab adapter and legacy callers. The candidate-channel
path is the active authority-bound MCP route. Promoting only one would create a
benchmark/production split, so both must use the same provider and application
primitive.

The current `ranked-v1` trace proves that final output order equals its recorded
MMR order. A genuine post-MMR rerank cannot be represented honestly by that
schema. Served mode therefore requires `ranked-v2`; disabling trace, emitting a
`ranked-v1` trace for changed output, or silently falling back when trace is
requested is prohibited.

## 3. Frozen runtime modes

`MEMBERRY_RERANKER_V1` has exactly these meanings:

| Raw value | Mode | Response effect |
| --- | --- | --- |
| absent or empty | `disabled` | Existing synchronous paths and bytes remain unchanged |
| `disabled` | `disabled` | Existing synchronous paths and bytes remain unchanged |
| `shadow` | `shadow` | Existing identity observation only; response remains unchanged |
| `served` | `served` | Apply the frozen local model before budgeting |

Whitespace variants, case variants, and every other value fail startup with a
non-sensitive configuration error. Both `shadow` and `served` require
`MEMBERRY_QUERY_PLANNER_V1=1` and `MEMBERRY_CANDIDATE_CHANNEL_V1=1`; missing
prerequisites fail startup before tool registration. No endpoint, credential,
authorization header, or deployment setting is added.

`served` is allowed only for `auto` and `ranked`. Explicit `deterministic`
requests bypass it and retain byte-for-byte deterministic behavior.

The experiment registry entry is superseded in place: ID becomes
`retrieval-reranker-v1`, the same flag remains `MEMBERRY_RERANKER_V1`, control
remains `memberry-live-mcp`, default remains false, and rollback becomes:
`Set MEMBERRY_RERANKER_V1=disabled or unset it, then restart. Local reranking
is non-persistent; shadow observations remain content-free.` Bootstrap
regression evidence must reject the stale claims that the flag is shadow-only
or that every configured response is baseline-controlled.

## 4. Frozen provider and model

The implementation adds `packages/retrieval/src/served-reranker.ts` and exports
only its narrow construction and identity surface from the package root.

Provider identity is exactly:

```json
{
  "providerId": "memberry.local.lexical",
  "modelId": "bm25f-query-v1",
  "calibrationId": "fixed-blend-v1",
  "locality": "local"
}
```

The identity scorer used by shadow is rejected in served construction. The
served provider is stateless and batch-scoped: document frequencies are
computed only from the already authority-bound candidates for the current
request. No result, token, document frequency, or content is retained after the
request settles.

### 4.1 Tokenization

For query, title, and content independently:

1. Apply JavaScript `String.prototype.normalize('NFKC')` and lowercase.
2. Split on every character outside ASCII `[a-z0-9]`.
3. Drop empty tokens, one-character tokens, and tokens longer than 32 code
   units.
4. Drop this exact stopword set:
   `a, an, and, are, as, at, be, by, for, from, has, have, how, in, is, it,
   of, on, or, that, the, this, to, was, what, when, where, which, who, why,
   will, with`.
5. Retain at most the first 64 query tokens, 128 title tokens, and 2048 content
   tokens. Repetitions remain for term frequency. Query coverage uses the first
   occurrence of each query token, capped at 64 unique tokens.

No stemming, synonym expansion, source-type boost, ID boost, tenant/project
metadata, label, oracle field, or wall-clock input is allowed.

### 4.2 Score

For each retained query token `t`, over the current batch of `N` candidates:

```text
df(t)       = candidate count whose retained title or content contains t
idf(t)      = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
bm25(tf,L,A,b) = tf * 2.2 / (tf + 1.2 * (1 - b + b * L / max(A,1)))
term(t,d)   = idf(t) * (
                2.0 * bm25(title_tf, title_len, average_title_len, 0.30)
              + 1.0 * bm25(content_tf, content_len, average_content_len, 0.75)
              )
raw(d)      = sum term(t,d) for unique retained query tokens
lexical(d)  = raw(d) / (raw(d) + 4.0), or 0 when raw(d) is 0
coverage(d) = matched unique retained query tokens / unique query token count,
              or 0 for an empty retained query
phrase(d)   = 1 when the space-joined retained query-token sequence is nonempty
              and occurs in the space-joined retained title tokens or content
              tokens; otherwise 0
baseline(d) = clamp(original score, 0, 1)
score(d)    = clamp(
                0.15 * baseline(d)
              + 0.65 * lexical(d)
              + 0.15 * coverage(d)
              + 0.05 * phrase(d),
              0, 1)
calibrated(d) = round(score(d) * 1,000,000) / 1,000,000
```

All constants above are source constants, not environment settings. Every
intermediate must be finite. An empty query, empty candidate batch, invalid
input, non-finite intermediate, provider rejection, invalid response, or
deadline returns the exact baseline list.

`calibrated(d)` is the only score emitted by the provider. If rounding produces
negative zero it is canonicalized to positive `0`. It must be an exact finite
number in `[0,1]` with no more than six decimal places before serialization.
The millionth-place quantization is part of `calibrationId: fixed-blend-v1` and
reduces sensitivity to minor `Math.log` implementation differences; it is not
a mathematical guarantee at a half-micro boundary. Hosted tests are the hard
guard and require exact score bytes and order on Node 20 and Node 22; any
mismatch stops promotion.

The provider uses the existing canonical request/response serialization and
`executeCalibratedRerankV1` validation. The serving wrapper catches both
synchronous contract errors raised before a Promise exists and asynchronous
baseline outcomes. It never reconstructs candidates from provider output: only
the validated score and order are associated with the original in-process
`RetrievalResult` values. Equal scores retain baseline rank, then the existing
canonical key/code-unit tie-break. Input arrays, `RetrievalResult` objects, and
metadata are never mutated. A reranked result creates owned result records with
the original `id`, `source_type`, `title`, `content`, and metadata reference and
replaces only `score`; baseline fallback returns the original array order,
objects, metadata, and scores exactly.

The model is batch-scoped and therefore does not use
`createLocalRerankerProviderV1`, whose scorer is per-candidate. It constructs a
provider with `createRerankerProviderV1`; that provider parses the complete
canonical batch using `parseSerializedRerankerProviderRequestV1`, computes
batch document frequencies and average lengths, and emits bytes only through
`serializeRerankerProviderResponseV1`. Those parser/serializer helpers remain
internal to the retrieval package and are not added to the root export.

Before the served model is implemented, RET-010B hardens the shared canonical
contract in `packages/retrieval/src/reranker.ts`. Exactly the six helper-owned
array-write classes for dense input snapshots, parsed input candidates,
response-feasibility scores, parsed request candidates, serialized response
scores, and parsed response scores must construct every indexed entry with a
captured `Object.defineProperty` own enumerable writable configurable data
property. Safe null-prototype keyed writes remain unchanged. This hardening
protects every canonical local, HTTPS, shadow, and new served consumer; it is
not served-model-only behavior.

Direct shared-contract tests in
`packages/retrieval/src/__tests__/reranker.test.ts` install numeric setters on
`Array.prototype`, `Object.prototype`, and an inserted prototype-chain object
at indices `0` and `127` while exercising all six write classes. They require
zero setter callbacks, zero getter invocation, exact serialized bytes, exact
cardinality and order, and no dropped or substituted values. Any canonical
helper path that cannot satisfy those invariants stops RET-010B before served
model implementation.

## 5. Frozen application seam

One internal async primitive accepts query, a post-dedup
`readonly RetrievalResult[]`, and the configured served provider. It returns:

- outcome `reranked` with the same candidate identities/content/metadata
  represented by newly owned result records, validated calibrated scores, and
  provider order; or
- outcome `baseline` with the original order and original scores exactly.

The primitive runs immediately after `dedup(...)` and immediately before
`groupAndBudget(...)`. No post-budget reorder qualifies.

### 5.1 Normal ranked assembly

`UnifiedAssembler` accepts an optional immutable served-reranker dependency.
The existing constructor call shape remains valid. `assemble` and
`assembleTraced` await the shared application primitive only for ranked work.
Default-off has no additional asynchronous hop before its first existing await
and retains the current ordering, scores, Markdown, and `ranked-v1` trace.

### 5.2 Candidate-channel assembly

The existing synchronous `assembleCandidateExecution` remains the exact
disabled/shadow implementation. A separate async
`assembleCandidateExecutionServed` method performs the same receipt-derived
candidate construction, fusion/MMR, and dedup, then awaits the shared reranker
primitive before budgeting. It must not re-run retrieval or accept candidates
outside the supplied authority-bound execution.

`berry_context` awaits the served method for `auto|ranked` when mode is served.
`berry_ask` awaits it before passing context to `askFromContext`, so both the
answer prompt evidence and returned evidence list reflect the same reranked,
budgeted context. Shadow continues through the existing observer. Deterministic
continues through the existing synchronous path without a provider call.

One immutable, stateless provider instance may be process-shared by the shared
assembler/default container and tenant containers. It holds no mutable request,
candidate, score, token, document-frequency, or result cache; all batch state
is call-local and discarded at settlement. A spy-provider test must prove every
observed candidate already belongs to the authenticated execution's
tenant/project/time scope.

## 6. Ranked-v2 trace contract

`ranked-v2` preserves every `ranked-v1` channel, filter, RRF, candidate-window,
MMR, dedup, budget, terminal, and output invariant, and adds exactly one
post-MMR/pre-budget reranker stage.

The top-level `RetrievalTraceV1` object retains exactly its existing ten keys:
`schemaVersion`, `algorithmVersion`, `requestShape`, `complete`,
`incompleteReasons`, `candidates`, `events`, `resultOrder`,
`terminalExclusions`, and `replayStateDigest`. `algorithmVersion` adds exactly
`ranked-v2`; no optional root field is introduced.

The closed event union adds exactly one event kind. Its TypeScript/JSON shape is
one of these two exact records:

```ts
type RetrievalTraceRerankerCandidateV2 = {
  ref: string;
  baselineRank: number;
  calibratedScore: number;
  rerankedRank: number;
};

type RetrievalTraceRerankerBaselineCandidateV2 = {
  ref: string;
  baselineRank: number;
  rerankedRank: number;
};

type RetrievalTraceRerankerEventV2 =
  | {
      sequence: number;
      kind: 'reranker-stage';
      provider: {
        providerId: string;
        modelId: string;
        calibrationId: string;
        locality: 'local';
      };
      outcome: 'reranked';
      candidates: readonly RetrievalTraceRerankerCandidateV2[];
    }
  | {
      sequence: number;
      kind: 'reranker-stage';
      provider: {
        providerId: string;
        modelId: string;
        calibrationId: string;
        locality: 'local';
      };
      outcome: 'baseline';
      reason: 'not-reranked';
      candidates: readonly RetrievalTraceRerankerBaselineCandidateV2[];
    };
```

There is exactly one `reranker-stage` event in every `ranked-v2` trace,
including an empty-candidate baseline. It is ordered after all `mmr-round`
events and before all `ranked-output` events. Its `candidates` array contains
exactly the MMR-selected, deduplicated set, ordered by `baselineRank` ascending.
`baselineRank` is the dense `1..N` post-MMR/dedup input order, refs are unique,
and `rerankedRank` is a permutation of `1..N`. For `reranked`, scores are exact
six-decimal calibrated values in `[0,1]`, and sorting by calibrated score
descending, baseline rank ascending, then ref by code unit must reproduce every
`rerankedRank`. For `baseline`, `rerankedRank` must equal `baselineRank` and no
score key is legal.

`ranked-output` remains the only output event for both `ranked-v1` and
`ranked-v2`. In `ranked-v2` it is a checked echo of the post-reranker,
post-budget served order, not replay authority. `deterministic-output` remains
illegal for ranked algorithms. `ranked-v1` rejects `reranker-stage` and remains
byte compatible.

The new event and all nested candidate records are included in the existing
`replayStateDigest` because `events` already participates in `replayState(...)`.
`resultOrder` and `terminalExclusions` remain checked echoes outside that
digest, exactly as in the current schema. Canonical event priority becomes:
channel attempt, channel terminal, candidate filter, candidate score, MMR
round, reranker stage, ranked output, candidate terminal, stage failure. No
other event ordering changes.

`packages/retrieval/src/retrieval-explanation-view.ts` is the explanation-view
boundary for the new event. For each validated `reranker-stage` variant it
constructs a new null-prototype event record containing exactly that variant's
keys, a new null-prototype provider record containing exactly the four frozen
provider keys, a new owned candidate array populated with own data-property
definitions, and a new null-prototype record for every candidate. The
`reranked` copy preserves `sequence`, `kind`, `provider`, `outcome`, and every
candidate's `ref`, `baselineRank`, `calibratedScore`, and `rerankedRank`; the
`baseline` copy additionally preserves `reason: 'not-reranked'`, preserves each
candidate's three legal keys, and never synthesizes a score. No spread,
`Object.assign`, inherited getter/setter, or prototype-bearing input is trusted
to perform this copy. Explanation-view roundtrip and replay must therefore
preserve the complete validated event while exposing no query, title, content,
raw ID, tenant/project scope, secret, endpoint, exception, or provider response
bytes.

The reranker candidate array is capped at exactly 128 entries, matching
`RERANKER_MAX_CANDIDATES`. `HARD_LIMITS` splits the current overloaded array
cap into `genericArrayEntries: 8192` and `traceEvents: 8193`.
`canonicalizeValue` continues to use 8192 for every generic/nested array;
only top-level `trace.events`, event sequence validation, and the trace-event
preflight use 8193. Existing collector `maxEvents` continues to mean up to 8192
legacy events. For `ranked-v2`, exactly one additional non-configurable slot is
reserved for the mandatory `reranker-stage`, so a caller's existing event
budget is not consumed; total events are bounded by `maxEvents + 1 <= 8193`.
`ranked-v1` option/default behavior is unchanged. All existing candidate,
scalar-byte, record, field, depth, MMR, and aggregate-work limits remain
unchanged. Provider identity strings use the existing safe ASCII grammar and
128-byte-per-field bound and must equal the frozen served identity. No query,
title, content, raw ID, evidence ID, tenant/project name, secret, exception
text, endpoint, or provider response bytes enter the trace.

Replay for `ranked-v2` must:

1. reproduce and verify the `ranked-v1` candidate set through MMR and dedup;
2. verify the exact single event, exact keys, dense ranks, unique refs, exact
   set equality, bounds, provider identity, and canonical candidate ordering;
3. derive the post-reranker order from calibrated score/baseline rank/ref for
   `reranked`, or baseline rank for `baseline`, and verify every recorded
   `rerankedRank` against that derivation;
4. verify the existing token-budget filter/terminal events establish one
   included set and no candidate outside the post-reranker set;
5. derive presentation order exactly as `groupAndBudget`: traverse the
   post-reranker order after filtering to the included set, establish each
   `sourceType` group at its first included occurrence, retain within-group
   traversal order, then flatten groups in first-seen group order;
6. require `ranked-output`, `resultOrder`, and actual served context order to
   equal that derived grouped/budgeted presentation order.

Missing, duplicate, foreign, non-finite, out-of-range, inconsistent, extra-key,
or non-canonical reranker data invalidates the trace. `include_trace=true` never
changes reranking behavior. Disabled and shadow use `ranked-v1`; successful or
fallback served attempts use `ranked-v2`.

## 7. Evaluation binding and gates

The current required CI always loads and scores both G2 holdout lanes on every
pushed head. Therefore the existing `memberry-retrieval-core-v1` registration
must remain bound to disabled production behavior throughout model
implementation and development qualification. Pointing that identity at served
behavior before approval is a P0 custody failure.

Qualification uses three distinct registered adapter identities implemented by
one adapter module and one production assembler/application path:

| Adapter ID | Pre-promotion binding | Purpose |
| --- | --- | --- |
| `memberry-retrieval-core-v1` | disabled | Existing required holdout candidate; remains disabled throughout RET-010 |
| `memberry-retrieval-core-disabled-v1` | disabled | Development control |
| `memberry-retrieval-core-served-v1` | served | Development candidate and, only after approval, frozen holdout candidate |

`memberry-retrieval-core.ts` exposes one private factory parameterized only by
the exact adapter ID and `disabled|served`. Both development arms construct the
same fixture persistence, scope filter, `UnifiedAssembler`, query, candidate
list, token budget, and output projection. The only difference is that the
served arm supplies the exact exported promoted provider to the shared
post-dedup/pre-budget primitive. The two distinct IDs satisfy
`compareAdapters`' unequal-ID invariant; no BM25 proxy is the RET-010 control.

The adapter exposes the actual response presentation order by flattening
`context.sections` and each section's `items` in returned order, then applying
the requested result limit. It does not sort by score or ID and does not
reconstruct pre-group reranker order. Thus interleaved source types and
equal-score cutoffs are measured exactly as returned by production
`groupAndBudget`, for both disabled and served arms.

The lab owns fixture persistence and scope filtering only. It may not copy the
model, substitute scores, inspect an oracle inside an adapter, or implement a
benchmark-only ranker. Adapter output remains ID and score only.

### 7.1 Holdout-inaccessible development lane

A model-independent packet first freezes a new registered development dataset,
`memberry-ret010-dev-v1`, at `bench/lab/datasets/ret010/v1/dev`. It contains
exactly 20 one-probe scenarios: 10 whose sole dimension is `recall` and whose
query limit is exactly 10, followed by 10 whose sole dimension is `precision`
and whose query limit is exactly 5. Every scenario is split `dev`. Scenario and
probe IDs are unique. Fixtures include current relevant evidence, lexical/topic
distractors, and explicit tenant/project/stale/out-of-corpus sentinels; oracles
name only in-corpus relevant/required/stale/forbidden IDs. The corpus must be
authored, independently checked for label correctness and non-derivation, and
promoted before the model/provider packet begins. Neither author nor checker
may read or derive from G2 holdout inputs/oracles.

A new `bench/lab/ret010/load-dev.ts` has no dataset/split parameter and contains
exactly one dataset identifier: `memberry-ret010-dev-v1`. It loads that
descriptor, requires `split === 'dev'`, requires the exact 10/10 dimension and
limit counts above, requires every selected input and oracle record to be
`dev`, requires their resolved paths to remain under the registered
`bench/lab/datasets/ret010/v1/dev` root, and rejects any second descriptor or
artifact. It does not import `datasets/load-suite.ts` and contains no G2 or
holdout dataset ID/path.

`bench/lab/ret010/dev-gate.ts` can receive scenarios only from that loader. It
calls `compareRegisteredAdapters` twice with exact IDs
`memberry-retrieval-core-disabled-v1` and
`memberry-retrieval-core-served-v1` and exact `splits: ['dev']`: once with only
the 10 Recall@10 scenarios and once with only the 10 Precision@5 scenarios.
Mixing the two `k` values in one comparison is forbidden. It then forms one
cross-lane efficiency vector by concatenating recall-lane paired probes sorted
by `(scenarioId, probeId)` followed by precision-lane paired probes sorted by
the same keys, and calls the existing `pairedEfficiencyInterval` once on that
exact 20-probe vector. It writes aggregate-only lane reports, interval, and
manifest below `node_modules/.cache/memberry-lab/runs`; neither per-case oracle
labels nor result IDs are published.

The dependency/binding test reads the complete static graph of `load-dev.ts`
and `dev-gate.ts` before execution and fails on `memberry-g2`, `holdout`,
`datasets/g2`, `loadG2HoldoutScenariosForScoring`, `datasets/load-suite`, a
variable dataset ID/split, an unregistered adapter, a mixed-k comparison, fewer
or more than 10 probes per lane, or any output field carrying
scenario/probe/query/result/oracle IDs. This is a reviewed source boundary, not
an operating-system sandbox claim.

`runDeterministicCiGate` completes only the pre-existing registry, baseline, and
comparison gates, including both existing G2 calls still bound to disabled
`memberry-retrieval-core-v1`. It never imports, launches, or otherwise invokes
`dev-gate.ts` and can never create or reserve a RET-010 evaluation root. The
workflow's exact fail-fast Bash block invokes the baseline first and invokes
`dev-gate.ts run` directly only after the baseline succeeds. The direct child
entry module must validate the
output boundary and exclusively create the current run/attempt/Node-major
evaluation root before dynamically importing any registered adapter,
evaluation, model, dataset, oracle, or policy source. It may statically import
only Node platform modules and the minimal custody code
needed to perform that pre-import containment and exclusive creation. Thus an
earlier baseline failure terminates the Bash block before any served development
work, and only the final direct command can create authoritative evidence,
while ordinary CI still never exposes served bytes to holdout scoring.

The dev gate writes its complete evidence surface only below one evaluation
root whose name is deterministically scoped by the raw validated workflow run
ID, workflow attempt, and matrix Node major. Both hosted identifiers must be
canonical positive decimal strings matching `^[1-9][0-9]*$`; coercion,
normalization, signs, whitespace, zero, and leading zeroes reject. The exact
evaluation-root basename is derived without transformation as
`ret010-development-run-${workflowRunId}-attempt-${workflowRunAttempt}-node-${nodeMajor}`,
yielding the path
`node_modules/.cache/memberry-lab/runs/ret010-development-run-<run-id>-attempt-<attempt>-node-<20|22>/`.
The gate creates that leaf directory once with an exclusive, non-recursive
operation. Its pre-existence, a creation race, or any entry at that path is a
custody contradiction: the gate fails closed and leaves the entry untouched.
There is no shared public output leaf. A completed successful evaluation root
contains exactly these five regular files and no tombstone:
`recall-lane.json`, `precision-lane.json`, `efficiency-interval.json`,
`aggregate-result.json`, and `custody-manifest.json`. A completed failed
evaluation root contains exactly `failure-tombstone.json` and no success or
partial file. The evaluator holds all success records in memory until the
evaluation and policy decision are complete, then creates every record with an
exclusive file-create operation. A failure before success publication may
create only the closed tombstone, also exclusively. A failure during file
publication leaves an immutable partial root that the finalizer rejects; no
code repairs, replaces, removes, or publishes it.

All six record types are closed; extra or missing keys reject. Keys appear in
the order listed below, nested records follow their listed order, and arrays
are forbidden:

- each lane file has `schemaVersion: "1"`, `lane`
  (`recall-at-10|precision-at-5`), the exact `datasetId`, `split: "dev"`, exact
  `controlAdapterId` and `candidateAdapterId`, `scenarioCount: 10`,
  `probeCount: 10`, exact `k` (`10|5`), `control`, `candidate`, `delta`, integer
  `qualifyingCaseCount` in `[0,10]`, and `passed: true`; each arm has exactly
  `recallAtK`, `precisionAtK`,
  `staleLeakRate`, `isolationLeakRate`, `duplicateRate`, and
  `unknownResultRate`, finite in `[0,1]`, while `delta` has exactly
  `recallAtK` and `precisionAtK`, finite in `[-1,1]`;
- `efficiency-interval.json` has `schemaVersion: "1"`,
  `metric: "task-success-per-1k-tokens"`, `outcome: "measured"`,
  `pairedProbes: 20`, `resamples: 2000`, `level: 0.95`, unsigned 32-bit
  `seed`, and finite `point`, `lower`, `upper`, and `oneSidedLower`;
- `aggregate-result.json` has `schemaVersion: "1"`, `decision: "passed"`,
  the exact `datasetId`, `split: "dev"`, exact `controlAdapterId` and
  `candidateAdapterId`, exact four-key `providerIdentity`, lowercase 40-hex
  `sourceCommit`, `modelBlob`, `providerContractBlob`, `adapterBlob`, and
  `statisticsBlob`,
  lowercase 64-hex `datasetDescriptorSha256`, `inputSha256`, `oracleSha256`,
  `devPolicySha256`, `recallLaneSha256`, `precisionLaneSha256`, and
  `efficiencyIntervalSha256`, the same unsigned 32-bit `seed`, `quality` with
  exactly finite `recallDelta`, `precisionDelta`, `efficiencyPoint`, and
  `efficiencyOneSidedLower`, `safety` with exactly the four finite leak/rate
  values above and every value `0`, `responseEffect` with exactly
  `sameCaseOrderAndSelectionChanged: true` and integer
  `qualifyingCaseCount` in `[1,20]`, and
  `passed: true`; the model, provider-contract, adapter, and statistics blobs
  are the Git
  blobs for `packages/retrieval/src/served-reranker.ts`,
  `packages/retrieval/src/reranker.ts`, and
  `bench/lab/adapters/memberry-retrieval-core.ts`, and `bench/lab/stats.ts`
  respectively;
- `custody-manifest.json` has `schemaVersion: "1"`, `decision: "passed"`,
  lowercase 40-hex `gitCommit`, `nodeMajor` (`20|22`), exact full
  `nodeVersion` matching `^v(?:20|22)\.[0-9]+\.[0-9]+$`, canonical positive
  decimal-string `workflowRunId` and `workflowRunAttempt`, each matching
  `^[1-9][0-9]*$` exactly with no coercion or leading zero, and lowercase 64-hex
  `recallLaneSha256`, `precisionLaneSha256`, `efficiencyIntervalSha256`, and
  `aggregateResultSha256`;
- `failure-tombstone.json` has `schemaVersion: "1"`, `decision: "failed"`,
  `failureClass` (`harness|infrastructure|model|metric|safety|custody`),
  `stage` (`source-integrity|registry|load-dev|recall-comparison|precision-comparison|efficiency|quality-policy|safety-policy|response-effect|artifact`),
  and the same exact `gitCommit`, `nodeMajor`, `nodeVersion`, `workflowRunId`,
  and `workflowRunAttempt` custody keys. It contains no exception text or
  caller-controlled value.

Every file is the UTF-8, no-BOM byte sequence `JSON.stringify(record) + "\n"`
using the exact key order above, with finite `-0` normalized to `0`; the reader
reconstructs those bytes and rejects any whitespace, ordering, encoding, or
newline variant. SHA-256 is over those exact file bytes. Filenames and bytes
may not contain scenario, probe, query, result, or oracle IDs, labels, per-case
outcomes, timestamps, platform, filesystem paths, or dataset/oracle contents.
The Node 20 and Node 22 executions must produce byte-identical
`aggregate-result.json` and therefore the same SHA-256; node/run/attempt data
exists only in the node-specific manifest or tombstone.

All output operations start at the repository root and validate every path
component from that root through the cache and `runs` parent directories with
`lstat` and `realpath`. Every component must be a real directory and not a
symbolic link, junction, mount point, or other reparse point; the canonical
parent must have the exact expected component suffix
`node_modules/.cache/memberry-lab/runs`, not merely a string prefix. The gate
repeats this component-by-component check after creating any directory and
immediately before each exclusive creation, read, or copy. The evaluation root,
the later upload leaf, and every file below either are created exclusively; the
protocol never uses an absent-check followed by creation, rename publication,
quarantine, replacement, recursive deletion, or cleanup of a pre-existing
entry. Any pre-existing, partial, foreign, linked, reparsed, mounted, or raced
entry; changed realpath or identity; unexpected suffix; or exclusive-create
collision fails closed. The disposable hosted runner is the cleanup boundary:
contradictory bytes remain untouched for diagnosis and can never become an
approval artifact.

Hosted Ubuntu tests establish real POSIX symbolic links and foreign entries at
each ancestor and leaf before execution and require every static contradiction
to remain untouched and expose no upload path. Dynamic identity, path, or byte
mutation fixtures are limited to the `beforeUploadPathOutput` seam and the
individual validations performed during the final whole-bundle sweep; every
such mutation must fail that sweep and expose no `upload_path`.
Dependency-injected filesystem-status fixtures
independently classify Windows junctions and other reparse points and mount
points at every component, exercise each corresponding fail-closed branch, and
prove that none is treated as an ordinary directory. This fixture proof is
classification-contract evidence, not a Windows execution gate; requiring a
real Windows junction/reparse/mount execution gate needs a separate path,
workflow, and approval. Runtime operation on every platform still rejects real
symbolic links, junctions, mount points, and other reparse points.

The executable boundary catches every synchronous throw, rejected promise,
late internal failure, and nonzero internal outcome. If no record has yet been
created, it may exclusively create the closed current-run
`failure-tombstone.json`. It never overwrites a record or alters a partial or
successful root. It then writes exactly the fixed value-free message
`RET010_DEV_GATE_FAILED` plus LF to stderr and exits nonzero; it never rethrows
or logs the cause. No cause, name, message, stack, path, scenario, probe, query,
result, oracle, adapter/provider output, or caller-controlled value may reach
stdout, stderr, the tombstone, or any other artifact. If the filesystem or an
earlier partial write prevents exclusive tombstone creation, the executable
boundary uses the same fixed message and nonzero exit and leaves the root
untouched; the finalizer rejects it and exposes no upload path. Sentinel tests
inject unique values through every failure
stage, thrown value, rejected value, error field, path, and fixture field and
require that none occurs in captured console bytes or any published byte. This
exclusive immutable-leaf protocol replaces and supersedes all earlier cleanup,
quarantine, replacement, rename-publication, rethrow, or unconditional-upload
wording.

`bench/lab/ret010/dev-gate.ts` implements the development-bundle reader/verifier
once behind the one production CLI mode
`node bench/lab/ret010/dev-gate.ts verify-hosted <40-lowercase-head> <canonical-run-id>`,
and RET-010F must use that exact command. Immediately before launch, with no
intervening command, RET-010F runs a trusted system/PATH `git` preflight with
`shell: false`, ignored stdin, and separate bounded stdout/stderr pipes. Every
Git child receives a freshly constructed environment that first removes every
inherited key whose ASCII-case-folded name begins `GIT_`, then sets exactly
`GIT_NO_REPLACE_OBJECTS=1`, `GIT_NO_LAZY_FETCH=1`,
`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null` on POSIX or
`GIT_CONFIG_GLOBAL=NUL` on Windows, `GIT_OPTIONAL_LOCKS=0`, and
`GIT_TERMINAL_PROMPT=0`; ordinary non-Git OS environment is preserved. Every
Git command begins with the exact common arguments `--no-replace-objects
--no-optional-locks -c core.fsmonitor=false -c core.untrackedCache=false` before
its subcommand and accepts no caller Git argument, config, path, ref, or
environment extension.

Before the existing proof, the preflight requires exact
`git rev-parse --show-object-format` stdout `sha1\n`, exact
`git rev-parse --is-shallow-repository` stdout `false\n`, and empty exact
`git for-each-ref --format=%(refname) refs/replace` stdout. It enumerates local
configuration only with the same hardened Git environment/arguments, rejects
any `extensions.partialClone` key, any `remote.<name>.promisor` whose Git-boolean
value is true, and any `remote.<name>.partialCloneFilter` key, and rejects a
missing promised object rather than fetching it. No preflight command may make
a network or lazy-fetch attempt. It then
requires exact `git rev-parse HEAD` stdout to be the requested lowercase
40-hex HEAD plus LF; exact `git status --porcelain=v1 --untracked-files=all`
stdout to be empty; and exact
`git ls-tree -z HEAD -- bench/lab/ret010/dev-gate.ts` stdout to be one and only
one NUL-terminated record `100644 blob <40-lowercase-hex><TAB>bench/lab/ret010/dev-gate.ts<NUL>`.
Using a component-contained no-follow handle, it requires the working script to
be a regular non-link/non-reparse/non-mount file, reads its pinned bytes, and
requires byte equality with exact no-shell
`git cat-file blob HEAD:bench/lab/ret010/dev-gate.ts`. It independently computes
Git SHA-1 over `"blob " + decimalByteLength + NUL + exactBytes` and requires the
result to equal the `ls-tree` blob ID. Every command must exit zero with its
required exact channels and every acquired handle must close successfully; the
next and only command is then the exact plain-Node launch above.

`dev-gate.ts`, despite its suffix, is
valid plain Node 20 and Node 22 CommonJS: only Node built-ins, `require`,
`module.exports`, and an explicitly invoked async `main` are permitted. It has
no ESM syntax, TypeScript-only syntax, JSX, decorator, top-level await,
`import.meta`, loader, or loader flag. The `verify-hosted` branch uses only Node
built-ins and executable definitions in that same file; before or during
verification it never loads `tsx`, imports, executes, or compiles another source,
uses `eval`/dynamic code, or invokes a model or evaluation implementation. Its
only additional repository-file access is the closed pinned read-only allowlist
below; those read bytes are evidence, never imported, executed, or compiled. The
development workflow's separate `run` command may retain its frozen `tsx`
invocation.

At entry, production `verify-hosted` requires `process.execArgv` to be exactly
the empty array and `process.argv` to contain exactly the runtime-owned Node
executable path, the invoked `bench/lab/ret010/dev-gate.ts` script path,
`verify-hosted`, HEAD, and run ID in that order. It rejects any missing, extra,
or reordered element and rejects the presence, including an empty value, of
`NODE_OPTIONS` or `NODE_PATH`. These entry checks do not claim to detect or undo
a malicious preload or other mutation that occurred before JavaScript entry.

The mode hard-codes repository `AP3X-Dev/memberry`, uses only the operator's
existing authenticated `github.com` CLI session, and owns every acquisition.
The token itself is not asserted to be read-only; least use here is enforced by
issuing only the fixed GET requests below. It accepts no
caller REST or ZIP transcript, extracted path/root, token, authorization header,
endpoint, origin, repository, owner, job/artifact ID, artifact name, attempt,
page number, redirect, or session override; it creates no authentication and
requests no new credential or permission. No second parser, permissive JSON
path, console transcription, or manifest-only shortcut is allowed.
`verify-hosted` is the sole executable parser and verifier for raw REST
metadata, artifact-service archives, ZIP structure, extracted bundle roots,
completion markers, manifests, every source/payload/workflow/job join, all
threshold and custody decisions, and the canonical approval-record bytes.
RET-010F does not implement or invoke a second internal-evidence parser.

This boundary explicitly trusts the fresh RET-010F host environment, the
system/PATH-selected `git`, `node`, and `gh` executables, the OS process launcher,
the CLI's default existing session/configuration and frozen absolute config root,
DNS, TLS, kernel, the external
preflight's verified `dev-gate.ts` bytes, and any same-UID process action before
verifier entry. The already-running verifier cannot attest itself or those
pre-entry roots. RET-010F must run from a fresh trusted environment or stop.
RET-010E adds no attestation, clean-room launcher, new executable-discovery
mechanism, path pinning scheme, or protection against a hostile same-UID
pre-entry actor.

The verifier validates its HEAD argument against `^[0-9a-f]{40}$` and its run-ID
argument against `^[1-9][0-9]*$`. Before acquiring a token it enumerates every
environment key as an own ASCII string, folds each ASCII letter to uppercase,
and rejects any two raw keys that fold to the same name. Only after that complete
collision check does it apply denials to the folded names. It rejects every
folded name beginning `GH_` or `GITHUB_`—explicitly including
`GH_CONFIG_DIR`—plus exact folded names `HTTP_PROXY`,
`HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`,
`NODE_TLS_REJECT_UNAUTHORIZED`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_OPTIONS`,
`NODE_PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, and
`DYLD_LIBRARY_PATH`, each even when its value is empty. Thus mixed-case spellings
and case-fold collisions reject before any denial can be bypassed. It preserves ordinary OS
configuration environment needed by the trusted system executables rather than
constructing a new home/config/session. It starts system/PATH executable `gh`
with `shell: false`, stdin ignored, stdout and stderr as separate pipes, and the
exact argv `auth token --hostname github.com`. It never runs login, refresh, or
any configuration-writing command. The child has one 30,000 ms deadline from
spawn through stdout/stderr EOF; the deadline never resets. A missing executable,
spawn failure, timeout, signal, nonzero exit, or malformed output rejects, and
the verifier never retries.

`HOME`, `APPDATA`, and `XDG_CONFIG_HOME` are not denied. At RET-010F entry, the
checker freezes the applicable variables and one absolute, lexically and
physically resolved trusted GitHub CLI config root: on POSIX it is absolute
`XDG_CONFIG_HOME/gh` when `XDG_CONFIG_HOME` is set, otherwise absolute
`HOME/.config/gh`; on Windows it is absolute `APPDATA/GitHub CLI`. A missing,
non-absolute, unresolvable, changed, or platform-contradictory required binding
rejects. RET-010F passes the same frozen ordinary environment to the immediate
Node launch; `verify-hosted` recomputes the same absolute root at entry and
requires the underlying variables and resolved root to remain byte-for-byte
unchanged immediately before spawning `gh`. These trusted host values are never
CLI arguments, verifier-factory inputs, transport descriptors, outputs, or
caller-selected paths. `GH_CONFIG_DIR` remains forbidden, so the CLI uses only
the frozen default root. The honest token-scope and host-trust limitations above
remain unchanged.

Successful token stdout is exactly 1 through 4,096 visible ASCII bytes
(`0x21..0x7e`) followed by one LF and EOF: the stdout collector's fixed maximum
is 4,097 bytes total. Receipt of byte 4,098 terminates the child immediately.
Receipt of the first stderr byte also terminates it immediately. After either
limit/failure trigger, define `drainDeadline = min(triggerMonotonicTime + 5000
ms, spawnMonotonicTime + 30000 ms)`. If the overall deadline is already
exhausted, the owner force-terminates immediately. After the trigger it discards
rather than buffers every subsequent stdout/stderr byte. At `drainDeadline` it
force-terminates if needed and performs exactly one disposal attempt. The
operation never completes after the original 30,000 ms deadline, which never
resets. CR, space or other whitespace, BOM, NUL/control/non-ASCII byte,
empty token, a 4,097th token byte before the LF, missing/extra LF, second line,
trailing byte, or any stderr rejects.

The application owns exactly one mutable token `Buffer`, strips only the one LF,
and in `finally` makes a best-effort `fill(0)` on that buffer before releasing
its reference. Runtime, child-process, HTTP, and TLS implementations may retain
copies outside that application buffer, so this is not a zeroization guarantee.
The enforceable guarantee is that no token byte is intentionally logged, emitted
on any success/failure channel, written to a file, persisted, returned, or sent
to the artifact redirect; it is used only in the fixed authenticated GitHub API
Authorization headers during its one in-memory ownership lifetime.

During `verify-hosted`, the application's direct repository working-tree
source/data reads are closed to exactly these thirteen paths and no other such
filesystem path; trusted `git` may read its own object database to serve the
fixed tree/blob commands:

1. `bench/lab/ret010/dev-gate.ts`
2. `packages/retrieval/src/served-reranker.ts`
3. `packages/retrieval/src/reranker.ts`
4. `packages/retrieval/src/assembler.ts`
5. `bench/lab/adapters/memberry-retrieval-core.ts`
6. `bench/lab/stats.ts`
7. `bench/lab/baselines/canonical.ts`
8. `bench/lab/datasets/hash.ts`
9. `bench/lab/registry/datasets.json`
10. `bench/lab/ret010/load-dev.ts`
11. `bench/lab/datasets/ret010/v1/dev/input.jsonl`
12. `bench/lab/datasets/ret010/v1/dev/oracle.jsonl`
13. `bench/lab/ret010/dev-policy.json`

For each allowlisted path, the verifier repeatedly validates every ancestor and
component, requires the trusted Git tree to contain exactly one `100644 blob`
entry at HEAD, and rejects a symlink, junction, reparse point, mount point
(including a same-device bind mount), non-regular file, alias, alternate path,
or component substitution. It opens the working file with a no-follow handle,
requires size at most `4,194,304` bytes and the thirteen-file aggregate at most
`33,554,432` bytes, and compares the pinned working bytes to exact no-shell
trusted-Git `cat-file blob HEAD:<path>` bytes. Over the same pinned working bytes
it computes raw SHA-256 and Git SHA-1 over
`"blob " + decimalByteLength + NUL + bytes`, requiring that SHA-1 to equal the
tree entry. It retains the pinned bytes and handle through every source-derived
join. Immediately before success stdout, it performs a final `fstat`, reread,
byte-equality, raw-SHA-256, and Git-SHA-1/tree equality check on all thirteen
handles together, then requires exactly one successful close attempt per handle
before output. Any unavailable no-follow/component/mount classification, size,
read, Git, hash, final-check, or close condition fails value-free. None of these
bytes is imported, executed, compiled, or exposed as a path/content channel.

The only authenticated metadata requests are fixed GETs to the completed run at
`https://api.github.com/repos/AP3X-Dev/memberry/actions/runs/<run-id>`, jobs at
that endpoint plus `/jobs?per_page=100&page=<n>`, artifacts at that endpoint
plus `/artifacts?per_page=100&page=<n>`, and a selected archive redirect at
`https://api.github.com/repos/AP3X-Dev/memberry/actions/artifacts/<artifact-id>/zip`.
Every metadata GET has exactly these headers and no cookie or extra authority:
`Authorization: Bearer <memory-token>`, `Accept:
application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `User-Agent:
memberry-ret010-receipt-verifier/1`, and `Accept-Encoding: identity`.
Each run, jobs-page, artifacts-page, and authenticated artifact-API request has
one 30,000 ms deadline from request start through complete response EOF. No
request retries, and no redirect, byte arrival, page, or phase resets a deadline.

Each run/jobs/artifacts metadata response must be status `200`, not a redirect,
have no raw `Location` or `Content-Encoding`, reach complete EOF, and contain at
most `8,388,608` body bytes. It has exactly one raw `Content-Type`, whose value
is `application/json` or `application/json; charset=utf-8`. Repeated or
conflicting raw `Content-Type`, `Content-Length`, `Transfer-Encoding`,
`Location`, or `Link` fields reject. If `Content-Length` is present, it is one
canonical nonnegative safe-decimal integer and equals the complete body length;
it cannot coexist with `Transfer-Encoding`. If transfer encoding is present, it
is exactly one `chunked` field and complete decoding/EOF is required.

The selected artifact API GET uses the same authenticated metadata headers and
must return exactly `302`, exactly one absolute raw `Location`, no raw
`Set-Cookie`, `Content-Encoding`, or `Transfer-Encoding`, and exactly zero raw
body bytes through EOF. `Content-Length` is absent or occurs exactly once as the
canonical value `0`. Repeated or conflicting raw Location, length, cookie,
encoding, or transfer fields reject.
Its redirect URL must be absolute HTTPS, contain
no userinfo or fragment, use no port or default port `443`, and resolve only to
public, nonprivate addresses; private, loopback, link-local, reserved, multicast,
unspecified, mixed-public/private, or resolution-changing destinations reject.
The verifier performs exactly one redirect GET with one 120,000 ms deadline
from request start through complete EOF, and pins the validated host and
public address through TLS. That GET has only `User-Agent:
memberry-ret010-receipt-verifier/1`, `Accept: application/octet-stream`, and
`Accept-Encoding: identity`: no authorization, cookie, API-version header,
GitHub session, or other metadata header crosses the redirect.

The redirect response must be status `200`, have no redirect or raw `Location`,
`Set-Cookie`, or `Content-Encoding`, reach complete EOF, and contain at most
`67,108,864` bytes. Repeated/conflicting length, transfer, location, cookie, or
encoding fields reject. A present `Content-Length` is one canonical nonnegative
safe-decimal integer equal to the complete bytes and cannot coexist with the
single allowed `Transfer-Encoding: chunked`. No second redirect, retry, or
deadline reset is allowed. The verifier authenticates the complete service bytes against the
selected artifact-service digest before inspecting any ZIP byte.

From those authenticated acquisitions the verifier itself owns extraction into
fresh exclusive roots and constructs the only approved bundle roots. It requires
exactly two marked success upload leaves and exactly the Node-major set
`{20,22}`, with no tombstone, extra file, duplicate major, contradictory
record, third manifest, or missing/invalid completion marker. It verifies each
marker's exact allowlist and payload digest map before trusting any payload. For
every record it parses the closed shape, reconstructs the canonical
UTF-8/no-BOM/one-LF bytes, requires byte equality, and recomputes every present
file SHA-256, Git blob, dataset descriptor, input, oracle, policy, lane,
interval, aggregate, manifest, and exact-byte `completionMarkerSha256`. It reads
only the pinned allowlisted repository bytes above and implements all parsing,
canonicalization, hashing, and threshold logic with Node built-ins and constants
in its own already-running CommonJS file. It requires every canonical record's
source and policy identities and digests to equal the independently derived
values and reapplies the frozen thresholds rather than trusting `passed` or
`decision` fields. It
recomputes source-bound lane and aggregate arithmetic, validates the stored
interval shape and thresholds, and requires exact stored-seed equality across
the interval, aggregate, both Nodes, and approval. Because the intentionally
sealed per-case paired vector is absent from every published record, the verifier
does not and cannot independently reconstruct that vector, prove that the stored
seed is the output of the policy's vector-derived seed rule, derive that seed,
or recompute the bootstrap interval. It instead verifies that the policy still
declares the frozen rule, verifies the exact source-bound statistics
implementation identity, and validates the canonical stored seed/interval joins.
It joins their mirrored values across the policy,
reports, and aggregate, and joins provider/adapter/model identity, source
commit, canonical positive-decimal workflow run ID and attempt,
basename-only `uploadLeafName` binding, and digests across the
reports, aggregate, both manifests, and both markers. Separately from policy
evaluation, it independently
validates the hard-coded RET-010E custody invariant: it recomputes aggregate
`qualifyingCaseCount` as the exact sum of the two lane counts, requires the sum
to be in `[1,20]`, recomputes the aggregate-contract boolean from that bounded
positive sum, requires stored
`sameCaseOrderAndSelectionChanged === true` to equal it, and joins both values through the
lane, aggregate, manifest, marker, Node, source, and approval contracts. It never
accepts independent any-order-change and any-selection-change facts as a
qualification receipt. Exact pinned source binds the provenance of the
evaluator's same-probe conjunction computation. The aggregate-only lane/result
records cannot independently prove the unpublished per-probe conjunctions or
paired vector, derive or prove the vector-derived seed, or recompute the stored
bootstrap interval; the verifier makes no such claim. Both manifests must name the
same exact lowercase source commit, workflow run ID, and attempt; their full
Node versions must match their distinct majors; both must bind the same
byte-identical aggregate and aggregate digest. Any mismatch or contradiction
rejects the entire pair.

On success, the verifier exits zero, writes nothing to stderr or any log
channel, and writes exactly one closed approval record to stdout. The stdout
bytes are UTF-8 without BOM and exactly `JSON.stringify(record) + "\n"`; there
is one record, one terminal LF, and no leading, trailing, diagnostic, or
progress byte. The top-level keys occur in this exact order:
`schemaVersion`, `decision`, `source`, `development`, `node20`, `node22`,
`workflowRunId`, `workflowRunAttempt`. `schemaVersion` is exactly `"1"` and
`decision` is exactly `"approved"`.

`source` is closed and has keys in this exact order: `gitCommit`, `modelBlob`,
`providerContractBlob`, `adapterBlob`, `statisticsBlob`, `providerIdentity`.
The first five values are lowercase 40-hex Git object identities, and
the derivation is frozen: `modelBlob` is the pinned
`packages/retrieval/src/served-reranker.ts` Git blob, `providerContractBlob` is
the pinned `packages/retrieval/src/reranker.ts` Git blob, `adapterBlob` is the
pinned `bench/lab/adapters/memberry-retrieval-core.ts` Git blob, and
`statisticsBlob` is the pinned `bench/lab/stats.ts` Git blob, all at
`gitCommit`. The independently pinned `assembler.ts`, `canonical.ts`,
`datasets/hash.ts`, `datasets.json`, `load-dev.ts`, input, oracle, policy, and
self bytes must simultaneously remain at that same commit and satisfy every
derived join below; omission from the closed stdout shape does not make them
optional evidence.
The frozen statistics identity is Git blob
`8840c2dd159837e9f26cdd9644162095bbae0bea` and raw-byte SHA-256
`2ff0eaa1a6608c7e640a8833257fa23f86aed686cb37c4fefa5325a842391644`.
The frozen policy identity is Git blob
`eed832c23638cdc05f0318b475a6b159ca357996` and exact raw-byte SHA-256
`1d5ca94ab459f538088de784c39ccdc862a605fc13f65d2639b73db7f42dc7df`.
Production verification requires all four literals against the same pinned
bytes used for parsing and joining; the policy SHA-256 is exactly
`development.devPolicySha256`.
`providerIdentity` is closed and
has keys in this exact order with these exact values: `providerId:
"memberry.local.lexical"`, `modelId: "bm25f-query-v1"`, `calibrationId:
"fixed-blend-v1"`, and `locality: "local"`.

`development` is closed and has keys in this exact order:
`datasetDescriptorSha256`, `inputSha256`, `oracleSha256`, `devPolicySha256`,
`seed`, `aggregateResultSha256`. Every `Sha256` value is lowercase 64-hex and
`seed` is a JSON integer in `[0,4294967295]`. `node20` and `node22` are each
closed with keys in this exact order: `nodeVersion`,
`custodyManifestSha256`, `completionMarkerSha256`, `artifactName`, `artifactId`,
`artifactServiceSha256`. The Node 20 version matches
`^v20\.[0-9]+\.[0-9]+$`; the Node 22 version matches
`^v22\.[0-9]+\.[0-9]+$`. Every manifest, marker, and service digest is lowercase
64-hex. Each `artifactId` is a canonical positive decimal string matching
`^[1-9][0-9]*$`, produced only by the raw REST numeric normalization below.
The top-level `workflowRunId` and `workflowRunAttempt` are the pair's common
canonical positive decimal strings matching `^[1-9][0-9]*$`, without coercion
or leading zeroes and produced by the same normalization from the completed-run
REST response before equality with marker/manifest strings. After validating
those common strings, `node20.artifactName`
must equal exactly
`memberry-ret010-development-node-20-${workflowRunId}-${workflowRunAttempt}` and
`node22.artifactName` must equal exactly
`memberry-ret010-development-node-22-${workflowRunId}-${workflowRunAttempt}`.
The top-level `node20` record must precede `node22`; swapping the records or
their identities rejects even if their values are otherwise internally
consistent.

The dataset digest domain is independent and exact. The verifier parses the
pinned `bench/lab/registry/datasets.json` bytes with duplicate-key detection at
every nesting depth, validates the registry's closed own-data schema while
allowing unrelated valid dataset entries, and selects exactly one descriptor
whose ID is `memberry-ret010-dev-v1`. Missing, duplicate-ID, accessor,
prototype/inherited, noncanonical, or extra descriptor data rejects. It rebuilds
that selected descriptor in the registry schema's declared key order and defines
`datasetDescriptorSha256` as SHA-256 of exactly the UTF-8/no-BOM bytes
`JSON.stringify(closedDescriptor)`, with no terminal LF. No ambient serializer,
source JSON whitespace, or property insertion order participates in the domain.

The selected descriptor must bind exactly the allowlisted dev input and oracle
paths, roles, `hashMode: "text-lf"`, normalized sizes, and hashes. For each file,
the verifier strictly decodes its pinned bytes as UTF-8, replaces every CRLF and
remaining lone CR with LF, re-encodes UTF-8, and hashes those exact normalized
bytes; those values are `inputSha256` and `oracleSha256` and their normalized
lengths must equal the descriptor sizes. `devPolicySha256` is SHA-256 of the
exact pinned `dev-policy.json` bytes with no newline or text normalization. The
verifier duplicate-key parses and closed-validates those policy bytes, requires
the exact frozen schema/thresholds/seed-rule identities, and joins the four
derived SHA-256 values, four source blobs, remaining pinned dependency blobs,
provider identity, dataset ID/split/adapter IDs, lane/aggregate records,
manifests, markers, and both Node receipts. No per-case input/oracle content,
scenario/probe/result identity, or holdout byte is emitted or accepted through
stdout, stderr, logs, approval, or artifacts.

The only accepted hosted artifact API/service `digest` representation is a JSON
string matching `^sha256:[0-9a-f]{64}$` byte for byte. The verifier rejects a missing
prefix, repeated prefix, uppercase hexadecimal, whitespace, base64, a bare
digest, any other algorithm, or a missing/non-string service value. The
canonical Node record stores only the exact 64-hex suffix as
`artifactServiceSha256`. It pins the complete downloaded archive, recomputes
SHA-256 over its exact artifact-service bytes, and requires that suffix before
reading even a ZIP signature, header, name, directory, or compression field and
before allocating an extraction root. Each extracted marker and manifest must
then bind that Node's exact payload hashes to
the common `development.aggregateResultSha256`; both aggregate payloads must be
byte-identical. Thus the service digest binds downloaded container bytes, the
marker binds extracted payload bytes, and the manifest plus common aggregate
bind both Node receipts to one development result.

Every numeric identity consumed from a raw REST artifact, workflow-run, or job
response—including artifact ID, workflow run ID, run attempt, job ID, and every
nested/cross-resource copy used in a join—passes one frozen conversion. The raw
response is decoded with duplicate-key detection; the selected raw value must
have `typeof value === "number"`, `Number.isSafeInteger(value) === true`, and
`value > 0`. The converter then calls `value.toString(10)` exactly once and names
that string `result`. It requires `result` to match `^[1-9][0-9]*$`,
`Number(result) === value`, and
`Number(result).toString(10) === result`. Only `result` may be stored,
joined, compared, or emitted afterward. Code may never call `String()` on an
unvalidated raw REST value or compare an unnormalized numeric identity.

Fractional, zero, negative, string, null, unsafe, overflow-rounded, missing,
duplicate, or contradictory identities reject the entire receipt. A safe JSON
number written in exponent form is intentionally normalized to its one plain
canonical decimal string when it represents a positive safe integer; the
approval record never preserves exponent or fractional notation. The maximum
accepted raw value is `Number.MAX_SAFE_INTEGER`; any mathematical integer at or
above `Number.MAX_SAFE_INTEGER + 1`, including one rounded by the JSON number
parser, rejects. When the later holdout reads stored approval strings, it
accepts only `^[1-9][0-9]*$` and rejects leading-zero, exponent, fractional,
signed, whitespace, or other nondecimal forms without numeric coercion.

The authenticated raw GitHub REST responses are the actual workflow-run object
and actual jobs/artifacts supersets acquired under the fixed production contract
above, not caller transcripts or synthetic already-selected records. The run
object and every sequential collection page are decoded from raw bytes with
duplicate-key detection before property selection. Required properties are
validated without rejecting documented or unrelated superset properties.
The completed-run response has no `Link` field.

For each jobs/artifacts collection the verifier fetches page 1 first and
requires raw `total_count` to be a safe nonnegative JSON integer. It computes
`lastPage = max(1, ceil(total_count / 100))` and rejects `total_count > 1000` or
`lastPage > 10` before issuing another page request. It then fetches each exact
page `1..lastPage` sequentially once. Every page repeats the same raw
`total_count`; each nonfinal page contains exactly 100 collection records and
the final page contains exactly
`total_count - 100 * (lastPage - 1)` records, so zero total means page 1 contains
zero and a positive multiple of 100 means the final page contains 100.

Each page has at most one raw `Link` field. Its parser accepts only the relation
names `next`, `first`, `prev`, and `last`. Every comma-separated relation has
exactly one angle-bracketed absolute target followed by exactly one parameter,
the literal quoted form `rel="<one-name>"`; an unquoted value, multiple relation
tokens, an unknown/case-variant name, an extra parameter, an extra target,
duplicate relation, empty member, or alternate syntax rejects. A single
`rel="next"` relation is present if and only if another page is required and
targets exactly HTTPS origin `https://api.github.com`, the same hard-coded
repository/run collection path, and only canonical query keys
`per_page=100&page=<current+1>`; it is absent on the final page. Duplicate raw
fields, a cycle, gap, repeat, page 0 or 11, alternate query/path/origin keys, and
contradictory `first`, `prev`, or `last` relations reject. Any present `first`,
`prev`, or `last` target must use that same exact origin/path/query form and the
mathematically correct page 1, previous page, or `lastPage`. After the final
page, the accumulated record count and the count of unique normalized record
IDs must each equal `total_count`.
The verifier never stops because selected records appeared early.

It selects the one requested completed workflow run by repository, exact HEAD,
canonical run ID, and attempt; then exactly one successful job named `unit (20)`
and exactly one named `unit (22)` from that run/attempt; then exactly one artifact
named `memberry-ret010-development-node-20-${workflowRunId}-${workflowRunAttempt}`
and exactly one corresponding Node 22 artifact. Other jobs and artifacts are
allowed. A second exact-name match, a matching name on another run/attempt, an
ambiguous renamed matrix job, or any missing, stale, duplicate, contradictory,
or cross-resource selected identity rejects. Node major is derived only from
those two exact frozen job and artifact names, never from a caller label.

After authenticating the service digest, the verifier applies this exact
GitHub-compatible ZIP32 profile. The complete archive is at most 64 MiB
(`67,108,864` bytes), uses one disk, contains exactly one ZIP32 EOCD ending at
EOF, and has zero archive comment, entry comment, and local or central extra
field bytes. ZIP64 sentinels/records, encryption, multi-disk fields, prefixes,
suffixes, and unparsed data reject. Every local and central version-needed field
is exactly decimal `20`. Every central version-made-by field is exactly `0x0014`
(DOS 2.0) or `0x0314` (Unix 2.0), and every internal attribute field is `0`.
For DOS, external attributes are exactly `0` or archive bit `0x20`. For Unix,
the upper 16-bit mode is exactly regular-file type `0100000` plus permissions
from `0000..0777`, with no other type or special bit, and the lower attributes
are exactly `0` or archive bit `0x20`.

Each entry uses method `0` or `8`; its local and central names, methods, and
flags always match exactly. Flags
contain only optional UTF-8 bit `0x0800` and optional data-descriptor bit
`0x0008`. When bit `0x0008` is clear, no descriptor exists and the local CRC-32,
compressed size, and uncompressed size equal the central values. When it is
set, all three local CRC/size fields are zero, are not compared to the nonzero
central fields, and cannot be an alternate authority; the central fields plus
the validated descriptor are the sole CRC/size authority. The descriptor starts
immediately after the compressed range. If its first little-endian word is signature
`0x08074b50`, only the exact 16-byte signed ZIP32 form is accepted; otherwise
only the exact 12-byte unsigned form is accepted. An unsigned entry whose actual
CRC-32 equals `0x08074b50` is ambiguous and rejects. Every accepted descriptor's
CRC-32 and two sizes equal the central values exactly.

The only entries are exactly these six root ASCII regular filenames, once each:
`recall-lane.json`, `precision-lane.json`, `efficiency-interval.json`,
`aggregate-result.json`, `custody-manifest.json`, and `upload-complete.json`.
Directories, links, device/special types, non-ASCII names, nested or empty
components, alternate separators, aliases, and extra entries reject. Each
uncompressed entry is at most `2,000,000` bytes and the aggregate uncompressed
size is at most `12,000,000` bytes. CRC-32 and sizes have the bit-specific
authority above; no generic local/central equality is imposed when the
descriptor bit is set. Each central local-header offset must equal the parser-
derived start byte of its corresponding local header; names and derived local
starts are unique. Every local header, compressed-data
range, optional descriptor, central record, central-directory range, and EOCD
range is in bounds, pairwise nonoverlapping, and accounts for every archive byte
exactly once. Inflation is bounded by the declared per-entry and aggregate
limits, must end at the exact declared output length, and must match the exact
central CRC-32. Any integer overflow, ambiguous range, overlap, gap, duplicate,
contradiction, overrun, underrun, or trailing compressed output rejects.

Only after that exhaustive authenticated walk may the verifier size-bound,
inflate, pin in memory, canonicalize, and parse the root-level
`upload-complete.json`. It then exclusively creates beneath a fresh
verifier-owned parent one directory named by the validated marker
`uploadLeafName`, which must match `^ret010-upload-[0-9a-f]{64}$`, and extracts
every allowlisted root entry into that directory. Thus extraction reconstructs
and preserves the marker-bound upload leaf instead of flattening the payloads
into a caller root, renaming the leaf, or accepting a caller-selected extracted
directory. For every file the verifier retains the
pinned archive source and exclusive no-follow destination handle together,
reconstructs and authenticates the source entry bytes, then rereads the pinned
destination and requires exact byte equality with that source before trusting a
digest. The CRC, canonical digest, and pinned destination comparison all apply
to the exact same bounded source bytes.

Across every RET-010E evaluator, finalizer, hosted verifier, and fixture reader,
each file, directory, child-process pipe, HTTP body/response stream, or socket
handle the code explicitly acquires has exactly one lexical owner. That owner
makes exactly one close/disposal attempt on every exit path,
including when the attempt fails; ownership is never copied, a failed close is
never retried, and no second cleanup layer closes the same handle. Every
required close/disposal attempt must complete successfully before verifier success stdout
or a finalizer structured-output write begins. A close-attempt failure converts
the operation to its fixed value-free failure after all other owners have made
their one close/disposal attempt. No exception, secondary close error, handle identity,
or caller value changes the frozen sentinel, and no success record or
`upload_path` is emitted unless all required closes succeeded. The one standard
structured-output append occurs only after that point; its own short, failed,
partial, or close failure still makes the step fail under the output-channel
rules below.

This success record contains only the frozen source, model, provider, adapter,
and statistics blob identity,
development dataset/input/oracle/policy/seed evidence, common aggregate digest,
distinct Node 20/22 versions, manifest/marker digests, derived artifact names,
canonical artifact IDs, artifact-service digests, and common run ID/attempt
required by `approved-dev.json`. Paths; scenario, probe, query,
result, or oracle IDs; labels; per-case facts; timestamps; artifact paths;
exception names/messages/stacks; and extra top-level or nested keys are
forbidden. RET-010F may write these exact stdout bytes as the approval record;
it may not add, drop, reorder, or reserialize a field.

On any verifier failure, stdout is exactly empty, stderr is exactly the UTF-8,
no-BOM byte sequence `RET010_DEV_RECEIPT_VERIFY_FAILED\n`, and the process exits
nonzero. All verifier logs, diagnostics, exception paths, and failure channels
are value-free; no caller-controlled or bundle-derived value may accompany or
replace that sentinel.

`dev-gate.ts` exports exactly the testable construction boundary
`createVerifyHostedVerifier({ transport })`. The supplied transport receives
only closed request descriptors internally constructed by the verifier after
argument, repository, identity, endpoint, page, header, and redirect policy
validation; it cannot accept a caller URL, header map, token, ID, page, archive
path, or transcript. Hermetic transport, pagination, raw-response, ZIP, bundle,
and lifecycle matrices import that factory in-process with a recording fake.

Production `main` always constructs the one fixed GitHub-CLI/session transport.
It has no transport selector through an argument, environment key, inherited fd,
path, module/preload hook, global, or mutable export. Subprocess fixtures are
limited to `node --check bench/lab/ret010/dev-gate.ts` under both Node 20 and 22,
the exact plain-Node command and `process.execArgv === []`/`process.argv`
grammar, proof of the fixed production binding, invalid/missing/extra arguments,
the forbidden entry environment, and the fixed success/failure channel contract.
They invoke no loader or `--import` flag and never claim to substitute a fake
authenticated session in a production subprocess. Source-binding checks reject
ESM, TypeScript-only, JSX, decorator, top-level-await, `import.meta`, loader,
dynamic-code, or verify-hosted executable/import/compile cross-file dependencies;
they allow only the closed pinned read-only evidence list above. The first
real positive production CLI execution is the later authorized RET-010F run,
not an implementation test.

In-process failure matrices cover every missing, extra, reordered, duplicated,
non-canonical, wrong-Node, wrong-run, wrong-attempt, wrong-source, wrong-policy,
wrong-digest, tombstone, partial, stale, unmarked, and contradictory bundle or
hosted-metadata variant. They explicitly cover each wrong/derived artifact name,
zero/signed/leading-zero/non-decimal/duplicate artifact ID, malformed or
mismatched service digest representation, swapped Node record order, Node
major/full-version disagreement, run/attempt disagreement, duplicate artifact,
and cross-artifact name/ID/digest/download/manifest/marker substitution. Every
failure produces the exact closed failure result that `main` maps to empty
stdout, the fixed stderr sentinel, and nonzero exit. Injected sentinel values may
occur in neither channel. Serializer/encoder/logging/stdout-sink matrices reject
a second record, BOM, wrong key order, partial JSON, missing/extra LF, and any
success byte on stderr or a log channel.

The hostile raw-response matrix applies independently to every run, attempt,
job, artifact, and nested reference identity. It accepts
`Number.MAX_SAFE_INTEGER` and requires stored string `"9007199254740991"`; it
rejects `Number.MAX_SAFE_INTEGER + 1`, raw larger integer literals that the JSON
number parser rounds, fractions, zero, negatives, strings, null, missing or
duplicate keys, and contradictory copies. A raw safe exponent-form number such
as `1e3` is accepted only as canonical stored string `"1000"`; exponent notation
never reaches stdout. Cross-run, cross-job, and cross-artifact substitutions
must reject even when each individual number is otherwise valid. Separate
approval-reader fixtures reject stored leading-zero, exponent, fraction,
signed, whitespace, hexadecimal, or other nondecimal strings without coercion.

The in-process factory matrix is executable and complete rather than parser-only:
each row uses the exact `verify-hosted <head> <run-id>` semantic inputs with no
transcript path, URL, artifact/job ID, page, token, or ZIP input, and the
recording transport proves the verifier internally created every closed request
descriptor. Production-binding subprocess rows independently reject every
attempt to route those descriptors to a fake.

Positive rows prove only the four hard-coded endpoint shapes are requested,
authentication is present, pages are sequential with `per_page=100`, unrelated
jobs/artifacts are tolerated on all pages, selected records may appear after
page one, safe exponent-form raw identities normalize, artifact downloads use
the selected normalized API IDs, and the two exact leaves are reconstructed.
Authentication rows set every forbidden environment key above independently to
empty and nonempty values, including mixed-case and arbitrary `GH_`/`GITHUB_`
suffixes and all LD/DYLD/Node/proxy/TLS keys; cover ASCII-uppercase folding,
every two-key fold collision, non-ASCII key rejection, and denial only after a
complete collision pass; prove system/PATH `gh`, `shell: false`, ignored
stdin, separate output pipes, exact argv, ordinary environment preservation, and
no login/refresh/config write; and cover missing executable, spawn error, timeout,
signal, nonzero, token lengths 0/1/4,096/4,097, total stdout bounds 4,097/4,098,
first stderr byte termination, bounded 5,000 ms drain/force termination, exactly
one disposal, visible-ASCII
endpoints, space and every whitespace/control class, CR/LF/BOM/non-ASCII,
missing/extra newline, second line, trailing byte, token logging/persistence,
one owned mutable Buffer, best-effort `fill(0)` in `finally`, honest runtime/TLS
copy limits, the exact 30,000 ms spawn-to-EOF deadline with no reset/retry,
and any token/header/cookie leak to the redirect.

Metadata response rows cover exact request headers; status `200`, redirect and
raw `Location`; encoded/truncated/non-EOF bodies at `8,388,608` and `8,388,609`;
both allowed content types and every spelling/charset/extra-parameter variant;
duplicate/conflicting raw type/length/transfer/location/Link fields; missing,
leading-zero/signed/whitespace/unsafe/mismatched length; length plus transfer;
and transfer other than one `chunked`; they also freeze each 30,000 ms request-
through-EOF deadline and no retry/reset. Artifact redirect rows cover exact
`302`, Location cardinality, forbidden Set-Cookie/encoding/transfer, absent or
canonical-zero length, zero body versus any body byte, and every
relative/non-HTTPS/userinfo/fragment/nondefault-port/private/loopback/link-local/
reserved/multicast/unspecified/mixed or rebinding destination. Download rows
prove exactly one sanitized GET, public-address pinning, exact three headers,
status `200`, no second redirect/retry, no auth/session/API-version/cookie leak,
no `Set-Cookie`/encoding, complete EOF at `67,108,864` and `67,108,865`, and all
length/transfer inconsistencies, with the exact 120,000 ms request-through-EOF
deadline and no reset.

Pagination rows cover totals `0`, `1`, `99`, `100`, `101`, `999`, `1000`, and
`1001`; unsafe/fractional/negative/string/null/missing/duplicate totals; exact
page cardinality and final remainder; stable totals; unique normalized IDs;
at-most-one raw Link; next present exactly when required and absent finally;
correct optional first/prev/last; unknown/case-variant/multitoken/unquoted/empty
relations, extra relation parameters or targets, duplicate relations, wrong
origin/repository/run/path/query key, page 0/11, duplicate header, cycle, gap,
repeat, unstable order/total,
early/late termination, extra or missing record, and appearance of both selected
records before the required final page. Other hostile rows cover every caller
override, duplicate JSON key at every nesting depth/page, renamed jobs,
duplicate selected matches, and cross-run/job/artifact substitution. A service-
digest mismatch paired with malformed ZIP must trip an ordering witness proving
no ZIP byte was inspected first.

ZIP rows exercise archive lengths `67,108,864` and `67,108,865`, entry lengths
`2,000,000` and `2,000,001`, aggregate lengths `12,000,000` and `12,000,001`,
version-needed 19/20/21, both exact made-by values and every other host/version,
internal attributes, DOS external `0`/`0x20` and other bits, Unix regular modes
at permissions `0000`/`0777` plus directory/link/device/special/type bits and
lower-attribute variants, both allowed methods, every allowed flag combination
and forbidden bit. Every row checks local/central name/method/flag equality.
Descriptor rows cover bit-clear absence and local CRC/size equality; bit-set
local zeroes, central-plus-descriptor sole authority, immediate placement, exact
signed/unsigned forms, every length/value mismatch, and ambiguous unsigned CRC
`0x08074b50`. Remaining rows
cover ZIP64/multi-disk, EOCD placement/count, comments/extras, ASCII names/types,
each central offset versus its parser-derived local start, duplicate names/starts,
overlap/gap/prefix/suffix, bounded inflate under/overrun, CRC mismatch, marker
leaf substitution, extraction collision, and source/destination byte mismatch.
Source-evidence rows independently cover every one of the thirteen exact read
paths; missing/extra/alias paths; mode other than `100644`; tree cardinality;
symlink/junction/reparse/mount and same-device bind classifications; unavailable
no-follow support; component substitution before each operation; file sizes
`4,194,304`/`4,194,305`; aggregate sizes `33,554,432`/`33,554,433`; working/Git
byte mismatch; Git blob-header length, SHA-1, and raw SHA-256 mismatch; mutation
before the final simultaneous `fstat`/reread; and each close failure. Dataset
rows cover duplicate keys at every depth, zero/one/two selected descriptors,
closed canonical descriptor order/domain, unrelated valid descriptors,
input/oracle path/role/text-lf normalized-size/hash joins, invalid UTF-8, CRLF,
lone CR, and exact policy-byte hashing. Independent constants use the frozen
statistics/policy blob and SHA-256 literals above; one-byte mutations and every
path/blob/raw-hash swap reject. Threshold rows use every exact independent
boundary literal frozen in section 7.2 rather than implementation predicates.
External-launch rows record the exact no-shell `git` argv/channel sequence,
fresh environment stripping every inherited mixed-case `GIT_*` key, the exact
six replacement environment bindings, both POSIX `/dev/null` and Windows `NUL`
config branches, and the exact common hardening arguments on every command.
They reject replacement refs, a shallow repository, non-SHA-1 object format,
local `extensions.partialClone`, true `remote.*.promisor`, any remote partial-
clone filter, a missing promisor object, any lazy-fetch or network attempt, a
lying fsmonitor, enabled/stale untracked cache, global/system config injection,
an inherited Git environment value, a wrong null device, or an omitted/reordered
hardening argument. They also record the frozen POSIX and Windows GitHub CLI
config-root derivations, mixed-case `GH_CONFIG_DIR` denial, preservation of
`HOME`/`APPDATA`/`XDG_CONFIG_HOME`, and root/binding immutability through `gh`
spawn. The positive rows then require the
lowercase requested HEAD equality, empty porcelain-v1 all status, one exact
NUL-terminated `100644 blob` tree record, no-follow regular working-script bytes,
`cat-file` equality, blob-header SHA-1 equality, successful close, no intervening
command, and the immediately following exact plain-Node argv. Dirty/untracked,
uppercase/malformed HEAD, extra/missing tree records, mode/path/type drift,
working/tree byte drift, incorrect blob length/hash, any stderr/nonzero exit, or
an inserted command rejects before Node launch.
Resource-lifecycle rows inject
failure after every file/directory/child-pipe/metadata-body/redirect-body/socket
acquisition and on every close/disposal attempt, assert one owner and exactly
one attempt per acquired resource with no retry, and require all
attempts successful before the canonical approval. Every negative row has no
approval bytes and the one fixed value-free failure surface.

Before the child imports executable evaluation or model code, it requires
`git rev-parse HEAD` to be exactly 40 lowercase hexadecimal characters, requires
both tracked and untracked status to be empty, and compares raw working-tree
bytes with `git cat-file blob HEAD:<path>` for every one of the thirteen RET-010E
paths plus these immutable, directly security-critical dependencies:
`bench/lab/stats.ts`, `bench/lab/baselines/canonical.ts`,
`bench/lab/datasets/hash.ts`, `packages/retrieval/src/served-reranker.ts`,
`packages/retrieval/src/reranker.ts`, and
`packages/retrieval/src/assembler.ts`. Missing paths, non-blob entries, mode
drift, byte drift, submodules, and untracked content reject. The same HEAD,
status, path modes, and byte comparisons run again after evaluation and
immediately before evaluator record creation; the finalizer independently
reacquires them before upload-leaf creation, before marker creation, and in the
final post-injection whole-bundle sweep followed only by the required successful
close attempts and output. These
six paths are verification dependencies
already promoted by earlier packets, not mutable RET-010E scope; the RET-010E
tracked implementation ceiling remains exactly thirteen.

RET-010F invokes the production `verify-hosted <head> <run-id>` mode after the
run has completed; that mode alone acquires, parses, and verifies immutable
hosted workflow metadata and archives through the existing authenticated
session. The paged jobs and artifacts collections may contain unrelated
records; the exact selected set is one `unit (20)` job, one `unit (22)` job, and
the two exact derived RET-010 artifacts, with no duplicate selected match. The
parent workflow conclusion and the conclusions of those two selected matrix
jobs must all be `success`, and their repository,
HEAD, canonical run ID and attempt, job Node major, artifact names, canonical
artifact IDs, and exact service digests must match the two downloaded upload
leaves, their completion markers, and their manifests. For each Node, the verifier
joins the immutable artifact API metadata to the repository and exact HEAD, the
one successful matrix job, expected derived artifact name, artifact ID, raw
`sha256:<64-lowercase-hex>` service digest, recomputed downloaded-byte digest,
marker, manifest, payload digest map, and common aggregate. It then joins the
Node 20 and Node 22 receipts to one run/attempt and the same byte-identical
aggregate. Before any equality or map/set key operation, every raw REST run,
attempt, job, artifact, and nested reference identity is converted by the frozen
safe-integer procedure above; all subsequent joins use only canonical decimal
strings. No unvalidated number or raw JSON notation survives into comparison or
the approval record. A
failed or cancelled parent, a failed or cancelled matrix job, a stale attempt,
or any missing, duplicate, stale, malformed, cross-run, cross-job, cross-Node,
or cross-artifact identity/substitution can never authorize `approved-dev.json`.
Within each matrix job the RET-010 development evaluation is invoked directly,
not through `bench/lab/baselines/ci-gate.ts`, as the final authoritative workflow
command before finalization. The baseline test process must never import, spawn,
or invoke `dev-gate.ts`, so it cannot precreate, reserve, collide with, or mutate
the authoritative evaluation root. The conditionally selected artifact
publication is terminal. Its always-running finalizer may succeed only for one exact,
complete current-identity success bundle or one exact, complete current-identity
tombstone bundle in that job's exclusive evaluation root. It then creates a
separate cryptographically unpredictable upload leaf, copies and verifies the
canonical payload under exclusive creation, and writes its completion marker
last. A partial, stale, contradictory, foreign, raced, or unverifiable
evaluation or upload leaf makes the finalizer fail without exposing a path, so
no artifact upload is attempted. A success artifact remains provisional until
`verify-hosted` proves the parent and both jobs successful and RET-010F reviews
its canonical approval result. The verifier records the common
aggregate digest plus both manifest digests, both recomputed exact-byte
`completionMarkerSha256` values, both expected artifact names, canonical
artifact IDs and service digests, both full versions, and the common run ID and
attempt; neither a lone manifest, a leaf without
its valid last-written marker, nor console output may substitute.

### 7.2 RET-010 development qualification

Use only declared development inputs and development oracle. Freeze source
bytes, provider identity, coefficients, adapter identity, corpus digest, input
digest, oracle digest, seed, Node version, and result digest before any holdout
run.

The development candidate must satisfy all of:

- Recall@10 is not below the frozen disabled production-path control.
- Precision@5 improves by at least `0.05` over that control.
- stale/current inversion, tenant/project contamination, duplicate, unknown,
  and out-of-corpus rates remain zero.
- task-success-per-token point delta is positive and its paired one-sided 95%
  bootstrap lower bound is at least zero using the repository's frozen paired
  bootstrap method and seed.
- at least one individual response-path probe both reverses baseline order and
  changes selected evidence under a tight token budget.

`dev-gate.ts` owns a separate closed, hard-coded RET-010E custody invariant; it
is not a `dev-policy.json` field and cannot be supplied or changed through a
policy, registry, environment value, or caller input. For each probe, the gate
computes one qualifying boolean as the conjunction of that probe's
order-reversal measurement and that same probe's selected-evidence change
measurement before any lane or cross-lane aggregation. Each lane's
`qualifyingCaseCount` is the count of its ten per-probe conjunctions; the
aggregate count is the exact sum of those two lane counts, and the invariant's
only qualification receipt is exactly
`responseEffect: { sameCaseOrderAndSelectionChanged: true,
qualifyingCaseCount: N }` with integer `N` in `[1,20]`. Lower-level order and
selection measurements may exist only transiently to compute each conjunction;
they are not published and cannot independently satisfy the gate. The
fail-closed bundle verifier recomputes the two-lane count sum, enforces its
`[1,20]` range, recomputes and matches the aggregate-contract boolean, and rejects any mirror/join or
aggregate-contract disagreement. Pinned exact source proves which same-probe
conjunction implementation produced the aggregate, but the aggregate-only bytes
cannot independently prove the unpublished per-probe facts. Tests must include a
negative vector in which one probe changes order and a different probe changes
selection: every per-probe conjunction is false, the qualifying count is zero,
and the gate and verifier must both reject it.

`dev-policy.json` is a closed schema-v1 record that pins the two adapter IDs,
dataset ID, split `dev`, lane counts `10/10`, Recall@10 minimum delta `0`,
Precision@5 minimum delta `0.05`, all four existing maximum safety rates—stale
leak, isolation leak, duplicate, and unknown result—to `0`, and the
exact cross-lane order above. The 20-probe efficiency interval must be
`measured`, with point delta strictly above `0`, one-sided 95% lower bound at
least `0`, 2000 paired resamples, minimum 10 paired probes, and the repository's
vector-derived seed rule. Extra or missing keys reject. This existing policy
schema contains no response-effect conjunction, response-effect receipt, or
qualifying-count field and RET-010E must not modify it.

Verifier tests freeze independent expectation literals rather than importing,
deriving, or copying the implementation predicates. Recall delta `-0.001`
rejects while `0` and `0.001` accept. Precision delta `0.049` rejects while
`0.05` and `0.051` accept. Efficiency point is strict: `-0.001` and `0` reject,
while `0.001` accepts. Efficiency one-sided lower `-0.001` rejects while `0`
and `0.001` accept. Every safety value first has domain `[0,1]`: `-0.001`
rejects as out of domain, `0` accepts, and `0.001` rejects the zero maximum.
Response-effect count `0` rejects, `1` and `20` accept, and `21` rejects. At
exact design base `48b6a462895b5c0629efa44493c5f917dd58ba57`, the independently
verified source-literal fixtures use exactly statistics blob
`8840c2dd159837e9f26cdd9644162095bbae0bea` with SHA-256
`2ff0eaa1a6608c7e640a8833257fa23f86aed686cb37c4fefa5325a842391644`
and policy blob `eed832c23638cdc05f0318b475a6b159ca357996` with SHA-256
`1d5ca94ab459f538088de784c39ccdc862a605fc13f65d2639b73db7f42dc7df`.
Any one-byte mutation, Git/raw-hash swap, path/blob swap, or value copied from
the implementation under test rejects and cannot update an expectation.

If this development gate fails, reject the model without opening or changing
the holdout oracle. Thresholds, corpus, scenarios, and seed may not be weakened
after seeing results. A different model or coefficient set is a new version and
requires a new design/hash and fresh development declaration.

The development workflow may be rerun only for an unrelated infrastructure or
harness failure after an independent exact-SHA ruling. A metric/model failure
is a model rejection, not a rerun condition. No served-holdout binding may be
committed until an independent reviewer approves the exact model bytes and the
exact aggregate development receipt.

### 7.3 One-shot holdout qualification

Ordinary CI never points either existing G2 holdout call at
`memberry-retrieval-core-served-v1` during RET-010. RET-010A originally creates
`.github/workflows/ret010-holdout-qualification.yml` as the disabled-by-default
harness workflow before model work; RET-010E later modifies that existing file
as the thirteenth path in its closed implementation ceiling to add the finalized
publication contract below. It exists before approval but is never automatically
invoked. It has only a
`workflow_dispatch` trigger, `contents: read`, no environment/secrets, no write
permission, and exact string inputs `qualification_sha` and
`approval_digest`. It checks out that exact 40-lowercase-hex SHA with
`persist-credentials: false`, verifies `git rev-parse HEAD`, installs/builds,
and invokes exactly
`node --import tsx bench/lab/ret010/holdout-gate.mts run` under Node 20 and Node
22. It cannot run on `push`, `pull_request`, or `schedule`; `master` selects the
committed workflow, while only the joined immutable `qualification_sha`
authorizes checkout and qualification bytes.

After RET-010F alone invokes the authenticated production verifier and reviews
its development artifact/hosted-metadata result, it is the only stage allowed to write
`bench/lab/ret010/approved-dev.json`; a separate approval-record commit then
adds exactly the verifier's reviewed canonical success-stdout bytes. The record
schema and byte form are the closed contract frozen in section 7.1: approved
development source and model/provider/adapter/statistics identities, frozen
dataset/input/oracle/policy/seed evidence, common aggregate digest, distinct
Node 20/22 versions, manifest/marker digests, exact derived artifact names,
canonical artifact IDs, artifact-service digests, and the common canonical run
ID and attempt. The artifact values are verifier-authenticated workflow evidence
and fields in the corresponding frozen Node record; RET-010F does not separately
parse or verify them. The run
ID and attempt are the exact strings frozen in the two markers and manifests,
never coerced numbers. The
model/provider/adapter/statistics bytes must be unchanged from the named dev source
commit; the only intervening path may be that approval record.

The workflow accepts a dispatch only on branch `master`, binds exactly
`RET010_HOLDOUT_QUALIFICATION_SHA: ${{ inputs.qualification_sha }}` and
`RET010_HOLDOUT_APPROVAL_DIGEST: ${{ inputs.approval_digest }}`, and provides no
second input channel. Before model or holdout import, `holdout-gate.mts` reads
the raw bytes at `GITHUB_EVENT_PATH` with duplicate-key detection and requires:
`GITHUB_EVENT_NAME === "workflow_dispatch"`; `GITHUB_REPOSITORY ===
"AP3X-Dev/memberry"`; `GITHUB_REF === "refs/heads/master"`; raw event
`repository.full_name === "AP3X-Dev/memberry"`; raw event `ref === "master"`;
the raw event's exact two input strings equal their one named environment
bindings; and
`rawEvent.inputs.qualification_sha === RET010_HOLDOUT_QUALIFICATION_SHA ===
GITHUB_SHA === git rev-parse HEAD`. The joined SHA must match
`^[0-9a-f]{40}$`, and the checkout must be detached at that exact commit. It
requires `RET010_HOLDOUT_APPROVAL_DIGEST` to match `^[0-9a-f]{64}$` and equal
the canonical SHA-256 of that exact committed approval record, verifies
the committed approval bytes and declared digests, verifies the exact approved
development source lineage and all named model/provider/adapter/statistics
blobs, verifies
the frozen qualification inputs named by that committed approval, and then
loads the existing G2 scorer-only holdout lanes. It never downloads or receives
a development artifact, reads a completion marker, queries hosted workflow/job
metadata, or writes/revises the approval record. Acquisition and internal-
evidence verification belong only to `verify-hosted`; RET-010F only launches,
reviews, and writes its accepted stdout bytes. It validates the expanded committed Node records' closed
shape, Node 20-then-Node 22 order, artifact-name derivation, artifact-ID grammar,
service-digest grammar, common run/attempt, approved source lineage, and declared
digest bindings without requiring the expired development artifacts or live
artifact API. Its approval parser accepts run ID, attempt, and artifact IDs only
as already-canonical `^[1-9][0-9]*$` strings and never converts a stored number,
exponent, leading-zero, or other notation. It makes two separate uniform-k comparisons—existing 10-probe
Recall@10, then existing 10-probe Precision@5—with exact registered IDs
`memberry-retrieval-core-disabled-v1` and
`memberry-retrieval-core-served-v1` with
`bench/lab/ret010/holdout-policy.json`. That closed schema-v1 policy pins split
`holdout`, two lane counts `10/10`, Recall@10 and Precision@5 minimum deltas
`0`, and all four existing maximum safety rates to `0`. Project/tenant
contamination maps to isolation leak and out-of-corpus output maps to unknown
result; no fifth metric is invented. It concatenates the two sorted
paired-probe vectors in the same recall-then-precision order as development;
the resulting 20-probe efficiency interval must be `measured`, with point
delta and one-sided 95% lower bound both at least `0`, 2000 resamples, minimum
10 paired probes, and the same vector-derived seed rule. It deliberately does
not arm or claim the later material `+0.05` G2 threshold. The gate writes the
closed aggregates and custody identity only inside its single canonical receipt;
scenario/probe/query/result/oracle IDs, labels, and per-case outcomes are
forbidden. The automatic `bench:lab:ci` continues to evaluate disabled
`memberry-retrieval-core-v1`, so no push or PR can accidentally invoke this
lane.

Each holdout matrix job freezes the evaluator step ID `ret010_holdout_gate` and
the immediately following finalizer step ID `ret010_holdout_finalize`. The
finalizer has exact condition `if: ${{ always() }}` and receives the evaluator
outcome only through
`RET010_HOLDOUT_GATE_OUTCOME: ${{ steps.ret010_holdout_gate.outcome }}`. Exact
`success` accepts only one complete current-identity holdout success bundle;
exact `failure` accepts only one newly exclusively created current-identity
holdout tombstone. `cancelled`, `skipped`, missing, empty, extra, duplicated, or
contradictory outcomes, a success/tombstone mismatch, and every partial or stale
root reject without a structured path output. Filesystem contents never upgrade
the bound outcome.

The two exact commands are
`node --import tsx bench/lab/ret010/holdout-gate.mts run` and
`node --import tsx bench/lab/ret010/holdout-gate.mts finalize`; neither accepts
an argument. There is no `RET010_HOLDOUT_RECEIPT_PATH` or other caller path. Each
mode independently validates `RUNNER_TEMP`, repository, HEAD, full Node version,
Node major, workflow run ID, and attempt, then derives the only evaluation root
as
`<validated-RUNNER_TEMP>/memberry-ret010-holdout/runs/ret010-holdout-run-${workflowRunId}-attempt-${workflowRunAttempt}-node-${nodeMajor}`
and the only receipt as its child `holdout-receipt.json`. The evaluator
exclusively creates that file; a collision or partial write remains untouched
and is not repairable evidence.

The success receipt is closed and ordered exactly:
`schemaVersion`, `decision`, `gitCommit`, `nodeMajor`, `nodeVersion`,
`workflowRunId`, `workflowRunAttempt`, `approvalSha256`, `datasetId`, `split`,
`controlAdapterId`, `candidateAdapterId`, `recall`, `precision`, `efficiency`,
`safety`. Its fixed values are `schemaVersion: "1"`, `decision: "passed"`,
`datasetId: "memberry-g2-holdout-holdout"`, `split: "holdout"`, control
`memberry-retrieval-core-disabled-v1`, and candidate
`memberry-retrieval-core-served-v1`. `gitCommit` matches `^[0-9a-f]{40}$`;
`nodeMajor` is exactly `20|22`; `nodeVersion` matches that exact major;
`workflowRunId` and `workflowRunAttempt` are canonical positive-decimal strings;
and `approvalSha256` matches `^[0-9a-f]{64}$`. `recall` and `precision` are each closed and
ordered `scenarioCount`, `probeCount`, `k`, `metric`, `control`, `candidate`,
`delta`: both counts are exactly `10`; recall is `k: 10`, `metric:
"recallAtK"`; precision is `k: 5`, `metric: "precisionAtK"`; control and
candidate are finite in `[0,1]`, delta is finite in `[-1,1]`, equals exact
canonical candidate minus control, and is at least `0`.

`efficiency` is closed and ordered `outcome`, `pairedProbes`, `resamples`,
`level`, `seed`, `point`, `lower`, `upper`, `oneSidedLower`, with exact
`"measured"`, `20`, `2000`, `0.95`, an unsigned 32-bit seed, finite values,
`lower <= point <= upper`, `oneSidedLower <= point`, and both `point` and
`oneSidedLower` at least `0`. `safety` is closed and ordered `staleLeakRate`,
`isolationLeakRate`, `duplicateRate`, `unknownResultRate`, each exactly `0`.

The failure receipt is closed and ordered exactly `schemaVersion`, `decision`,
`failureClass`, `stage`, `gitCommit`, `nodeMajor`, `nodeVersion`,
`workflowRunId`, `workflowRunAttempt`, with exact `schemaVersion: "1"`,
`decision: "failed"`; `failureClass` is exactly one of
`harness|infrastructure|model|metric|safety|custody`; and `stage` is exactly one
of
`source-integrity|approval|load-holdout|recall-comparison|precision-comparison|efficiency|quality-policy|safety-policy|artifact`.
Its commit, Node, version, run, and attempt fields use the same exact grammars
and current hosted identities as the success arm.
No receipt arm permits an extra/missing/reordered key, array, path, exception,
per-case identity/outcome, label, timestamp, or caller-controlled value.
Both arms' exact bytes are UTF-8 without BOM,
`JSON.stringify(closedRecord) + "\n"`, in the top-level and nested order above,
with finite `-0` normalized to `0`; any whitespace, spelling, ordering, encoding,
or newline variant rejects. The receipt SHA-256 and completion marker bind those
exact bytes.

The evaluator writes stdout exactly empty on success and failure. Success has
empty stderr and exit zero; any failure writes only the UTF-8/no-BOM bytes
`RET010_HOLDOUT_GATE_FAILED\n` to stderr after all close attempts and exits
nonzero. Its logs, exceptions, and every other channel are empty and value-free.
The finalizer likewise has empty stdout/stderr/logs on success and exits zero
only after its structured output succeeds; any failure emits only
`RET010_HOLDOUT_FINALIZE_FAILED\n` on stderr after all close attempts, emits no
successful `upload_path`, and exits nonzero.

The holdout finalizer uses the same exclusive no-follow publication,
simultaneous source/destination pinning, exact canonical completion-marker,
marker-last, whole-bundle final-sweep, value-free failure, and handle-close
rules frozen for the development finalizer, with a distinct cryptographically
unpredictable holdout upload leaf named
`ret010-holdout-upload-<64-lowercase-hex>` and matching
`^ret010-holdout-upload-[0-9a-f]{64}$`; one exclusive-creation collision fails
closed. Its
sole intentional value-bearing output is `upload_path`, emitted only after the
completion marker and every source/destination byte and identity pass the final
sweep. The terminal upload uses the same pinned upload-artifact action and
settings, uploads exactly
`${{ steps.ret010_holdout_finalize.outputs.upload_path }}`, and has the exact
authorization predicate
`if: ${{ always() && steps.ret010_holdout_finalize.outcome == 'success' && steps.ret010_holdout_finalize.outputs.upload_path != '' }}`.
Nothing follows it. A partial structured-output write from a failed finalizer
cannot authorize upload. The artifact name is exactly
`memberry-ret010-holdout-node-${{ matrix.node-version }}-${{ github.run_id }}-${{ github.run_attempt }}`.
The completion marker is `upload-complete.json`, is created last, and uses the
same closed identity fields and canonical-byte rules as the development marker,
except its `uploadLeafName` has the exact holdout grammar above.
For either holdout union arm its allowlist is exactly
`["holdout-receipt.json","upload-complete.json"]` and its closed payload map
contains only `holdoutReceiptSha256`; `bundleKind` must equal `success` or
`failure` consistently with the bound outcome and receipt decision. The
finalizer size-bounds, pins, canonicalizes, and validates the receipt before
copy, pins source and destination together, requires their bytes equal, and
revalidates both plus the last-written marker before the required successful
close attempts and output.

Holdout tests execute the exact `run` and `finalize` CLIs and do not merely call
policy or serialization helpers. The only injected-scorer surface is a sealed
test-fixture branch on inherited file descriptor 3. It is selected only when
`RET010_HOLDOUT_TEST_FIXTURE === "1"`, `NODE_ENV === "test"`,
`GITHUB_ACTIONS` is exactly absent (any present value, including empty,
`"false"`, or `"true"`, rejects), every production event/approval/session binding is
absent, and fd 3 is the one readable inherited fixture pipe. The complete fd 3
payload is at most `65,536` bytes including exactly one terminal LF followed by
EOF. It must be canonical UTF-8 without BOM or CR; invalid encoding, whitespace
variation, duplicate key, a second record/LF, or any trailing byte rejects. Its
bytes must equal `JSON.stringify(the closed record in the order below) + "\n"`.

The fd 3 record is closed with exact top-level key order `schemaVersion`,
`recall`, `precision` and exact `schemaVersion: "1"`. Each lane is an array of
exactly ten distinct, non-shared ordinary own-property records. Every record has
this exact key order: `scenarioId`, `probeId`, `controlMetric`,
`candidateMetric`, `controlCoverage`, `controlTokens`, `candidateCoverage`,
`candidateTokens`, `staleLeakRate`, `isolationLeakRate`, `duplicateRate`,
`unknownResultRate`. Recall IDs are exactly ordinal pairs
`fixture-recall-01`/`fixture-probe-01` through
`fixture-recall-10`/`fixture-probe-10`; precision IDs are exactly
`fixture-precision-01`/`fixture-probe-01` through
`fixture-precision-10`/`fixture-probe-10`, in that order.

Metric, coverage, and safety values are finite JSON numbers in `[0,1]`.
Token values are safe JSON integers in `[0,1000000]`. Coercion and `-0` reject.
The module exports the pure test boundary
`validateHoldoutFixtureRecord(value)`. It performs no filesystem, environment,
network, clock, random, model, oracle, or holdout access. JSON production input
cannot encode a JavaScript Proxy. For ordinary object graphs the validator
rejects accessor properties, non-ordinary or inherited/prototype data
properties, extra/missing/reordered keys, duplicate or shared object identities,
wrong ordinals, observable mutation/reentrancy, and cross-lane reuse; and returns a newly owned, deeply immutable
closed record so mutation of the caller's graph cannot change validated bytes or
later arithmetic. The production fd 3 fixture parser sends its duplicate-aware
canonical decoded value through this exact validator, then sends only the
returned closed record through the real production aggregation and policy path.
The record permits no aggregate, delta, qualifying count, seed, interval,
receipt, path, approval, dataset/oracle, endpoint, module, credential, exception,
or production identity. It owns fd 3 and makes its one close attempt under the
universal handle rule.

The shared production aggregation path—not a fixture-supplied aggregate—derives
each lane's control and candidate metric as the arithmetic mean of its ten
records, derives each delta, and derives each of the four safety rates as the
arithmetic mean across all twenty nonnegative record values (therefore each must
be zero). It forms the 20-pair task-success-per-
token vector in recall-then-precision ordinal order from coverage and token
fields, and calls the production `pairedEfficiencyInterval` exactly once. The
fixture cannot supply or override an aggregate, delta, seed, interval, policy
decision, or receipt field.

Beyond the selector and `NODE_ENV`, the only six fixture identity/environment
keys are `RET010_HOLDOUT_TEST_RUNNER_TEMP`,
`RET010_HOLDOUT_TEST_GIT_COMMIT`, `RET010_HOLDOUT_TEST_RUN_ID`,
`RET010_HOLDOUT_TEST_RUN_ATTEMPT`, `RET010_HOLDOUT_TEST_APPROVAL_SHA256`, and,
for finalize only, `RET010_HOLDOUT_TEST_GATE_OUTCOME`. Their corresponding
production keys `RUNNER_TEMP`, `GITHUB_SHA`, `GITHUB_RUN_ID`,
`GITHUB_RUN_ATTEMPT`, `RET010_HOLDOUT_APPROVAL_DIGEST`, and
`RET010_HOLDOUT_GATE_OUTCOME` must all be absent. The fixture modes apply the production
commit/digest/positive-decimal/Node/outcome grammars, derive the receipt path
internally beneath the validated isolated test runner root, require that root
fresh and exclusively owned, and accept only the same closed success/failure
outcome mapping; no caller receipt path is introduced.

Production `run` requires the fixture selector absent and rejects a readable fd
3; the workflow never sets the selector or inherits fd 3, and its binding tests
freeze both facts. Before selecting the fixture branch, the module imports no G2
loader, scorer, oracle, model, adapter, approval, or filesystem fixture path.
After selecting it, the fixture branch is statically and dynamically incapable
of importing or reading the real holdout dataset/oracle or making network calls;
tests make those imports, reads, and calls throw and require zero attempts. Thus
the production workflow cannot select test scoring and the executable hostile
matrix consumes zero real-holdout bytes.

The complete positive matrix proves exact 10+10 unique scenario/probe
cardinality, recall-then-precision 20-pair ordering, the frozen
seed/resample/interval arithmetic, every cross-file mirror join, the exact
HEAD/event/input SHA join, canonical success publication, and exactly one
successful close attempt per handle for both Nodes. The negative matrix
independently covers every missing, duplicate, extra, reordered, or cross-lane
scenario/probe identity; all policy, seed, count, arithmetic, digest,
source-lineage, approval, event, repository, ref, input, `GITHUB_SHA`, and HEAD
mismatches; evaluator success/failure/throw and each finalizer outcome
contradiction; partial/tombstone/marker/allowlist and source/destination
mutation; every handle acquisition/close-attempt failure; fixture selection
under any production identity, readable production fd 3, fixture-mode
real-holdout import/read/network access; malformed, partial, failed, or extra
structured output; and attempted upload under each failed conjunction. Every
negative row is non-approving and invokes no uploader.

Subprocess fd 3 rows are limited to executable byte, duplicate-key/schema,
cardinality/ordinal, numeric-value, derived-arithmetic, and environment/channel
behavior. They cover payload sizes `65,536` and `65,537`, early EOF, missing
or extra LF, second record, trailing byte, BOM/CR/invalid UTF-8/whitespace,
duplicate keys at every depth, top/lane/record key order and extras, schema
variants, lane counts 9/10/11, every wrong/duplicate/reordered/cross-lane ordinal
ID, finite-number and `-0` boundaries, token values `-1`, `0`, `1000000`, `1000001`, fractional,
string, null, and unsafe integer, plus every individually forbidden aggregate,
delta, seed, interval, receipt, path, approval, dataset, oracle, endpoint,
module, and credential field. Environment rows cover each allowed fixture key,
every extra RET010/GitHub identity or fixture-input key, each production counterpart alone and combined, production
`GITHUB_ACTIONS` absent as the sole accepted state and present as empty/false/
true/arbitrary rejection states, missing/readable fd 3 in each mode, stale/nonexclusive test
roots, identity grammars, and all closed outcomes. Positive witnesses assert the
derived lane means/safety values, exact recall-then-precision vector, and exactly
one call to the production interval helper while all real holdout loaders,
oracles, files, and networks remain at zero calls.

Separate in-process tests call `validateHoldoutFixtureRecord(value)` directly
with accessor-bearing, inherited-property, non-ordinary-prototype, Proxy, shared-
identity, cross-lane-reuse, reentrant, thrown-trap, and mutation-during/after-
validation graphs. Every accessor/trap throw or reentrant/observable mutation is
caught and mapped to the fixed sanitized failure, never rethrown or logged; the
tests prove a single owned immutable returned graph and prove later caller
mutation cannot alter canonical fixture bytes or derived arithmetic. The design
does not claim universal detection of a behaviorally transparent Proxy, and
subprocess tests make no claim that JSON bytes can carry JavaScript accessor,
prototype, Proxy, shared-identity, or post-parse mutation semantics.

One explicitly authorized dispatch on the exact approval-record SHA is the
qualification event. Its required Node 20 and Node 22 jobs are reproducibility
executions of the same frozen event, not two model-selection trials. The run ID,
attempt, SHA, inputs, and artifacts are preserved. The workflow and script do
not claim an operating-system one-use primitive; one-shot custody is enforced
by exact dispatch authorization and audit. No rerun or second dispatch is
allowed for a metric/model/safety failure. In that case preserve the result,
keep automatic holdout binding disabled, mark RET-010 blocked, and require an
owner decision plus genuinely new independently declared development evidence.
An unrelated infrastructure/harness failure may be rerun only after an
independent exact-SHA and exact-run ruling.

After a successful qualification, the exact served bytes may be promoted.
Ordinary CI still keeps the G2 adapter disabled until the later RET-006/G2
packet. Any source/model/policy drift invalidates the qualification and starts
a new development declaration; it cannot reuse the holdout outcome.

RET-010 promotion requires no regression in every already-armed comparison
rule, both Node 20/22 unit matrices, full integration/live evidence, exact
default-off parity, and the disposable served-response proof below. It may then
close RET-004 and RET-010 only.

### 7.4 RET-006 and G2 closure

After RET-010 is promoted on master, a separate RET-006 packet freezes and
independently reviews the material task-success-per-token threshold and
confidence policy, changes the ordinary G2 candidate binding from disabled
`memberry-retrieval-core-v1` to already-qualified
`memberry-retrieval-core-served-v1`, and arms
`comparison-policy.json.g2Thresholds.precisionAt5` without changing its
declared `minImprovement: 0.05`. G2 closes only when:

- Recall@10 is not below baseline;
- Precision@5 improves by at least `0.05`;
- stale/contamination/duplicate/unknown safety rates are zero; and
- task-success-per-token materially improves with the frozen confidence bound.

A RET-010 runtime pass is not G2 closure. RET-007 remains parked and is neither
run nor counted as a prerequisite.

## 8. Required evidence

### 8.1 Model and contract

- same candidates with different queries can produce different orders;
- a controlled lower-baseline exact match outranks a higher-baseline
  distractor;
- title/content/query changes affect score, not IDs or metadata;
- equal scores retain deterministic baseline/key ties on Node 20 and Node 22;
- exact 0/1 and N/N+1 token/candidate/string/aggregate bounds;
- hostile arrays, accessors, proxies, Unicode, non-finite values, invalid
  provider bytes, throw, rejection, timeout, and late settlement fail closed;
- identity provider cannot be constructed as served;
- fallback returns exact original order, scores, objects, and Markdown.

### 8.2 Assembly and tools

- normal ranked and candidate-channel paths call the same application
  primitive at post-dedup/pre-budget;
- a tight budget changes evidence membership, not just display order;
- real `berry_context` Markdown order changes in served mode;
- real `berry_ask` synthesis input, citations, and returned evidence all use
  the same changed context;
- explicit deterministic, disabled, and shadow outputs remain exact;
- served-provider call count is zero for deterministic, disabled, and shadow
  response work; shadow still executes its existing identity provider only in
  the non-response-affecting coordinator;
- provider input is a subset of the exact authority-bound execution and cannot
  add a foreign candidate;
- parallel tenant containers cannot observe each other's candidates or state.

### 8.3 Trace

- canonical `ranked-v2` serialize/parse/replay and N/N+1 bounds;
- replayed served order equals context/Markdown order;
- replay derives interleaved-source grouping from reranker order, included set,
  and candidate source type; it does not trust output events as authority;
- fallback `ranked-v2` proves unchanged baseline order;
- malformed, duplicate, missing, foreign, or reordered reranker events reject;
- `ranked-v1` fixtures and replay remain byte compatible;
- half-micro score boundaries, quantized ties, equal-score cutoff, and
  interleaved source types are identical on Node 20/22;
- trace and explanation output contain no source content, raw IDs, scope names,
  query, secret sentinel, exception, or endpoint.

### 8.4 Composition and hosted evidence

The authenticated disposable MCP composition test starts separate disabled and
served servers over the real transport with fake local persistence and fake LLM
only. It proves:

- the same authority-bound candidate set returns a different, expected
  `berry_context` order and tight-budget membership in served mode;
- `berry_ask` sends only served evidence to the fake LLM and returns matching
  citations/evidence;
- foreign-tenant/project and out-of-time candidates never reach the provider,
  response, trace, or fake LLM;
- provider failure returns the exact disabled response;
- deterministic responses remain byte-identical;
- unset configuration remains default-off compatible;
- cleanup completes and no external network or credential is used.

All substantive execution is hosted. Required exact-head evidence is Node 20,
Node 22, full unit/integration, scoped resolver, authenticated planner,
candidate channel, live MCP, admission composition, retrieval trace, registered
production-adapter lab evidence, and the declared development/holdout custody
manifests.

## 9. Implementation packets and file boundary

The design document is promoted alone before implementation. Implementation is
then split into independently reviewable commits on a fresh exact-master
worktree. This list is closed: every allowed tracked path is enumerated below;
runtime artifacts under `node_modules/.cache` are untracked evidence only.

### RET-010A — workflow and development instrument, promoted before model work

- `.github/workflows/ret010-holdout-qualification.yml` (new)
- `bench/lab/datasets/ret010/v1/dev/input.jsonl` (new)
- `bench/lab/datasets/ret010/v1/dev/oracle.jsonl` (new)
- `bench/lab/registry/datasets.json`
- `bench/lab/ret010/load-dev.ts` (new)
- `bench/lab/ret010/dev-policy.json` (new)
- `bench/lab/ret010/holdout-policy.json` (new)
- `bench/lab/ret010/__tests__/load-dev.test.ts` (new)
- `bench/lab/ret010/__tests__/workflow-binding.test.ts` (new)

This packet contains no model/provider or served adapter and cannot affect the
existing holdout lane. It must reach green master before model work begins.

### RET-010B — model and ranked-v2 contract

- `packages/retrieval/src/reranker.ts`
- `packages/retrieval/src/__tests__/reranker.test.ts`
- `packages/retrieval/src/served-reranker.ts` (new)
- `packages/retrieval/src/index.ts`
- `packages/retrieval/src/trace.ts`
- `packages/retrieval/src/runtime-trace.ts`
- `packages/retrieval/src/retrieval-explanation-view.ts`
- `packages/retrieval/src/__tests__/served-reranker.test.ts` (new)
- `packages/retrieval/src/__tests__/trace.test.ts`
- `packages/retrieval/src/__tests__/assembler.traced.test.ts`
- `packages/retrieval/src/__tests__/retrieval-explanation-view.test.ts`
- `packages/retrieval/src/__tests__/retrieval-explanation-wiring.test.ts`

The RET-010B tracked path ceiling is twelve, raised from ten solely for the
shared canonical-helper hardening and its direct contract tests above. The
`reranker.ts` hardening and `reranker.test.ts` proof precede served-model work;
the remaining RET-010B scope, formula, identities, limits, gates, and packet
boundaries are unchanged.

### RET-010C — served assembly and tools

- `packages/retrieval/src/assembler.ts`
- `packages/retrieval/src/tools.ts`
- `packages/retrieval/src/__tests__/assembler.test.ts`
- `packages/retrieval/src/__tests__/runtime-candidate-channel.test.ts`
- `packages/retrieval/src/__tests__/tools.test.ts`
- `packages/retrieval/src/__tests__/query-input-boundary.test.ts`
- `packages/retrieval/src/__tests__/retrieval-explanation-wiring.test.ts`

The RET-010C tracked path ceiling is seven, raised from six solely to advance
the prior RET-010B construction-only phase-boundary assertion after intentional
served response wiring. The revised
`retrieval-explanation-wiring.test.ts` contract must continue to prove that
`applyServedRerankerV1`,
`parseSerializedRerankerProviderRequestV1`, and
`serializeRerankerProviderResponseV1` remain absent from the package root.
`assembler.ts` must not construct a served provider and must contain exactly
one production invocation of `applyServedRerankerV1`. `tools.ts` must neither
construct a served provider nor import or invoke `applyServedRerankerV1`.
The stale blanket prohibition on `ranked-v2` is removed because RET-010C
intentionally selects ranked-v2 inside the assembler for configured served
attempts. No provider construction, application primitive, or model logic may
move into the tool layer.

### RET-010D — runtime composition and disposable proof

- `packages/mcp/src/bootstrap.ts`
- `packages/mcp/src/__tests__/bootstrap.regression.test.ts`
- `packages/mcp/src/__tests__/runtime-candidate-channel.live.test.ts`
- `packages/mcp/src/__tests__/runtime-candidate-channel-live-evidence.test.ts`
- `packages/mcp/src/__tests__/runtime-candidate-channel-live-evidence.ts`
- `bench/lab/retrieval-trace/contract.ts`
- `bench/lab/retrieval-trace/live-conformance.ts`
- `bench/lab/retrieval-trace/__tests__/contract.test.ts`
- `bench/lab/retrieval-trace/__tests__/live-conformance.test.ts`
- `bench/lab/registry/experiments.json`

The RET-010D tracked path ceiling is ten. Runtime composition and its registry
truth advance atomically: the existing reranker experiment entry is
superseded in place with ID `retrieval-reranker-v1`, flag
`MEMBERRY_RERANKER_V1`, control `memberry-live-mcp`, `defaultEnabled: false`,
and the exact rollback text frozen in section 3. Bootstrap regression evidence
must reject the previous experiment ID, any claim that the flag is
shadow-only, and the stale rollback claim that every configured response is
baseline-controlled.

### RET-010E — production-path development evaluation

- `.github/workflows/ci.yml`
- `.github/workflows/ret010-holdout-qualification.yml` (created by RET-010A;
  modified by RET-010E)
- `bench/lab/adapters/memberry-retrieval-core.ts`
- `bench/lab/registered-adapters.ts`
- `bench/lab/registry/systems.json`
- `bench/lab/baselines/ci-gate.ts`
- `bench/lab/ret010/dev-gate.ts` (new)
- `bench/lab/ret010/holdout-gate.mts` (new)
- `bench/lab/__tests__/memberry-retrieval-core.test.ts`
- `bench/lab/__tests__/registered-adapters.test.ts`
- `bench/lab/baselines/__tests__/ci-gate-binding.test.ts`
- `bench/lab/ret010/__tests__/dev-gate.test.ts` (new)
- `bench/lab/ret010/__tests__/holdout-gate.test.ts` (new)

The RET-010E tracked path ceiling is thirteen. It consumes the experiment
registry truth already promoted with RET-010D and must not rewrite that entry.

In `.github/workflows/ci.yml`, the workflow change is limited to the existing Node-matrix
`Evaluation-lab deterministic gate`, one finalizer immediately after it, and
one terminal upload step. The finalizer's logs, stdout, stderr, and all failure
channels are fixed and value-free. Its sole intentional value-bearing success
output is the structured `upload_path` frozen below; it emits no other
value-bearing output. No other step may follow the upload. The second workflow
path is limited to the independently frozen holdout job/finalizer/upload contract
in section 7.3.
The deterministic-gate step has the unique stable step ID
`ret010_development_gate`, exact `shell: bash`, and this exact run block:

```bash
set -euo pipefail
npm run bench:lab:ci
node --import tsx bench/lab/ret010/dev-gate.ts run
```

The fail-fast Bash semantics prevent the direct evaluator from running if the
baseline command fails; the direct `dev-gate.ts run` invocation is the final
authoritative command. `bench/lab/baselines/ci-gate.ts` and its nested baseline
tests must never import, spawn, or invoke `dev-gate.ts`; only the direct final
workflow command may create the authoritative evaluation root. The finalizer
has the unique stable step ID `ret010_finalize`,
uses only the custody boundary (it must not import evaluation, adapters, model
code, datasets, policies, or oracles), and has the exact condition
`if: ${{ always() }}`. Its only gate-status input is the one exact fixed env
binding
`RET010_DEVELOPMENT_GATE_OUTCOME: ${{ steps.ret010_development_gate.outcome }}`.
It accepts no gate outcome through an argument, second environment key, file,
console text, inferred filesystem state, job status, or caller-selected value.
Both step IDs must occur exactly once in the job.

The finalizer first derives the one expected run/attempt/Node-major evaluation
root from validated hosted values; it never accepts a caller-supplied path. It
reacquires the repository source identity and runtime identity after evaluation:
exact lowercase HEAD, clean tracked and untracked status, frozen path modes and
bytes, matrix Node major and full Node version, workflow run ID, and workflow
run attempt. It then repeats component-by-component no-follow containment and
applies one closed outcome-to-bundle mapping. Exact outcome `success` accepts
only the exact five-file current-root success bundle and rejects any tombstone.
Exact outcome `failure` accepts only one newly and exclusively created
current-root `failure-tombstone.json` and rejects every success or partial file.
Outcomes `cancelled` and `skipped`, a missing or empty outcome, any extra value,
duplicate binding, success/tombstone mismatch, failure/success mismatch, or any
other contradiction reject without mutation and expose no output. Filesystem
contents can never upgrade or reinterpret the authoritative bound outcome.

The finalizer pins the evaluation-root identity and all expected regular files
as one bundle, opens every source file without following links, reconstructs
each closed record's canonical bytes, recomputes every required digest, and
retains the complete identity-and-byte snapshot through publication. It creates
a separate upload leaf directly below the validated `runs` parent with an exact
basename `ret010-upload-<64-lowercase-hex>`, where the suffix is 32 bytes from
the Node cryptographic random generator. Directory creation is one exclusive,
non-recursive operation; a collision fails closed rather than trying another
name. The generated basename itself must match
`^ret010-upload-[0-9a-f]{64}$` exactly. Each payload file is copied from its
pinned canonical bytes into the new leaf with exclusive no-follow file
creation. The finalizer retains open no-follow handles and immutable identity
snapshots for the upload directory and every destination payload, so the source
root/files and destination root/files are pinned simultaneously before marker
creation. It rereads each pinned destination through its retained handle and
requires exact byte-for-byte equality with the corresponding pinned source, in
addition to canonical-byte and digest equality. It revalidates the
repository/runtime identity, evaluation root,
every source path and open source handle, upload directory, every destination
path and open destination handle, destination allowlist, canonical bytes, and
every digest as one bundle. Any identity change at any point fails closed and
leaves the partial upload leaf untouched.

Every evaluator/finalizer archive, ancestor, directory, source, destination,
marker, and temporary handle follows the single-owner, exactly-one-close-
attempt rule above on success, rejection, throw, cancellation observation, and
structured-output failure. All attempts must succeed before output; any close
error is a finalizer failure with the fixed value-free sentinel and no successful
`upload_path`.

The final write inside the upload leaf is an exclusively created
`upload-complete.json`. It is a closed canonical record with keys in this exact
order: `schemaVersion: "1"`, `decision: "complete"`, `bundleKind`
(`success|failure`), lowercase 40-hex `gitCommit`, `nodeMajor` (`20|22`), exact
full `nodeVersion`, canonical positive decimal-string `workflowRunId` and
`workflowRunAttempt` each matching `^[1-9][0-9]*$`, exact basename-only
`uploadLeafName` matching `^ret010-upload-[0-9a-f]{64}$`, exact ordered
`allowlist`, and closed `payloadSha256`. `uploadLeafName` is the generated leaf
basename only, contains no separator or parent path, and must equal the basename
used to derive the finalizer's already-contained destination path. The marker's
run ID, attempt, and Node major must equal the raw hosted identity values; the
finalizer re-derives
`ret010-development-run-${workflowRunId}-attempt-${workflowRunAttempt}-node-${nodeMajor}`
from those exact marker strings and requires byte equality with the pinned
evaluation-root basename.

For `bundleKind: "success"`, `allowlist` is exactly
`["recall-lane.json","precision-lane.json","efficiency-interval.json","aggregate-result.json","custody-manifest.json","upload-complete.json"]`
and `payloadSha256` is a closed object with exactly these lowercase 64-hex
properties in this order: `recallLaneSha256`, `precisionLaneSha256`,
`efficiencyIntervalSha256`, `aggregateResultSha256`, and
`custodyManifestSha256`, each bound to its corresponding payload filename. For
`bundleKind: "failure"`, `allowlist` is exactly
`["failure-tombstone.json","upload-complete.json"]` and `payloadSha256` is a
closed object containing exactly one lowercase 64-hex property,
`failureTombstoneSha256`. The two shapes are a closed discriminated union; a
missing, extra, reordered, wrong-kind, or wrong-file digest rejects.

The marker's exact bytes are UTF-8 without BOM,
`JSON.stringify(closedRecord) + "\n"`, in the field and nested-property order
above; any whitespace, ordering, encoding, newline, type, or spelling variant
rejects. Thus the marker binds the HEAD, Node major and full version, run ID,
attempt, unpredictable leaf basename, exact artifact allowlist, and digest of
every other artifact file without a self-digest cycle. The finalizer retains an
open no-follow marker handle and pins the marker identity immediately after its
exclusive last-in-leaf creation. It recomputes
`completionMarkerSha256 = SHA-256(exact upload-complete.json bytes)` and then
invokes the single deterministic `beforeUploadPathOutput` injection seam.
Immediately after that seam, it performs the last read-only whole-bundle sweep
of repository/runtime
identity, the evaluation directory, all source paths and handles, the upload
directory, all destination payload paths and handles, the marker path and
handle, exact allowlist, every canonical byte sequence, every payload digest,
and `completionMarkerSha256`. After that sweep passes, every handle owner makes
its one close attempt and every attempt must succeed. Only then does the
finalizer use the standard hosted structured-output channel to write the exact contained leaf
path as the `upload_path` step output. That value must equal the frozen validated
`runs` parent joined with the exact marker-bound `uploadLeafName`; any other
path, basename, encoding, output key, or channel rejects. `upload_path` is the
sole intentional value-bearing output. It emits no path, digest, or other
value-bearing output before the final structured-output write begins. A short,
partial, malformed, wrongly encoded, wrong-channel, or otherwise failed write
to `GITHUB_OUTPUT` makes `ret010_finalize` fail even if bytes were accepted by
the channel.

This protocol contains portable path collision, link, reparse, mount, and
substitution races at the evidence boundary. It is not a sandbox against a
hostile process running concurrently as the same operating-system identity;
the disposable isolated hosted runner, least-privilege workflow, exact-source
checks, and `verify-hosted`'s downloaded-byte verification invoked and reviewed
by RET-010F are explicit
parts of that trust boundary. A cancellation or any contradiction prevents a
successful finalizer, exposes no upload path, and remains non-approving under
the verifier's workflow-conclusion checks. Identity, path, or byte mutation after
the final sweep has completed is explicitly outside this portable verifier: it
is the hostile same-UID post-verification window, including the interval after
structured output and before or during the uploader's read. No executable
fixture claims to close that operating-system race. RET-010F's independent
launch and review of `verify-hosted` leaves that sole verifier's download and
exact-byte, marker, allowlist, digest, workflow, and job verification the
approval boundary for whatever bytes the uploader actually stored; RET-010F
does not repeat it. Any post-sweep substitution remains non-approving.

The terminal upload uses
`actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02`,
the exact condition
`if: ${{ always() && steps.ret010_finalize.outcome == 'success' && steps.ret010_finalize.outputs.upload_path != '' }}`,
`if-no-files-found: error`, `include-hidden-files: true`, and
`retention-days: 14`. Its exact artifact name is
`memberry-ret010-development-node-${{ matrix.node-version }}-${{ github.run_id }}-${{ github.run_attempt }}`;
the matrix values used by this expression are exactly the canonical major
strings `20` and `22`, so the rendered names equal the two frozen Node-record
derivations above.
it uploads only `${{ steps.ret010_finalize.outputs.upload_path }}`. No pre-existing
unrelated upload surface, workflow trigger, job dependency, permission,
environment, secret, or configuration value changes. Ordinary CI still never
imports or invokes the
holdout gate and keeps both existing G2 calls bound to disabled
`memberry-retrieval-core-v1`.

Upload authorization is the conjunction of a successful `ret010_finalize`
outcome and the exact previously validated `upload_path`; neither fact alone is
sufficient. Therefore a short or partial failed write that happens to leave a
parseable `upload_path` fragment cannot authorize the uploader because the
finalizer outcome is not `success`. The protocol makes no rollback, truncation,
or post-failure absence claim about bytes already accepted by `GITHUB_OUTPUT`.

Binding tests require exactly one `ret010_development_gate`, exactly one
`ret010_finalize`, the exact single
`RET010_DEVELOPMENT_GATE_OUTCOME: ${{ steps.ret010_development_gate.outcome }}`
binding and no second outcome channel, the exact always-running finalizer
expression, exact outcome-and-nonempty-output upload expression, exact
`upload_path` input, the pinned action and frozen upload settings,
finalizer-before-upload ordering, and upload as the terminal step. They reject
missing/duplicate step IDs, a renamed or caller-selected binding, a direct job
status binding, a second status input, and any upload path not sourced exactly
from the finalizer output. They also freeze the matrix major strings and reject
an artifact-name expression or rendered name that cannot equal the canonical
Node 20/22 receipt derivation. Executable custody fixtures prove both closed
branches: a deterministic-gate failure that
exclusively wrote a canonical current tombstone makes `ret010_finalize` create
and fully verify a fresh upload leaf containing exactly that tombstone and its
last-written completion marker; success creates exactly the five payloads and
marker. Outcome fixtures cover success/success, failure/current-tombstone,
success/tombstone mismatch, failure/success mismatch, `cancelled`, `skipped`,
missing, empty, duplicate, and extra outcomes; only the first two matching rows
may expose `upload_path`. Identity/schema fixtures reject run ID or attempt `0`,
leading zeroes, sign, whitespace, numeric coercion, transformed evaluation
basenames, a marker-derived evaluation basename mismatch, path-valued or stale
`uploadLeafName`, any basename outside
`^ret010-upload-[0-9a-f]{64}$`, either wrong `payloadSha256` union arm, and every
missing, extra, reordered, misspelled, wrong-kind, or wrong-digest marker field.
Static fixtures pre-place evaluation-root collisions, random-leaf collisions,
partial roots, partial upload leaves, foreign entries, and
links/reparse/mount classifications before the finalizer starts. Dynamic
identity, path, and byte mutation fixtures exist only at
`beforeUploadPathOutput` and during the component validations of the immediately
following final whole-bundle sweep. At those two surfaces they mutate the source
bundle, upload directory, each destination payload, marker, and
repository/runtime identity independently and in combination; every stale
handle/path, non-canonical byte, or recomputed digest mismatch must fail the
sweep, leave `upload_path` absent, make the terminal upload predicate false, and
invoke no uploader.

Actual structured step-output fixtures are limited to output-write failure,
malformed structured-output encoding or channel, partial output write, and
proof that pre-output failures never attempt the output write. They do not
inject an identity, path, or byte mutation after the final sweep. Every
output-channel fault must make `ret010_finalize` fail, make the conjunctive
terminal predicate false, and invoke no uploader even when an injected partial
write leaves a parseable fragment. The fixtures make no rollback or absence
assertion for the output channel. Each static or permitted
dynamic contradiction remains untouched, makes `ret010_finalize` fail, and
places no stale or partial byte in the artifact sink. Every failure or
cancellation path is non-approving. The excluded hostile same-UID
post-verification window is judged only by the `verify-hosted` result that
RET-010F launches and reviews against the verifier's independently downloaded
artifact bytes.

### RET-010F — independently approved development receipt

- `bench/lab/ret010/approved-dev.json` (new, only after exact-byte and
  aggregate-receipt approval)

The independent RET-010F checker must complete the exact external trusted-Git
HEAD/status/tree/working-byte/cat-file/blob-SHA preflight frozen in section 7.1
and, with no intervening command, launch the single fail-closed production
command `node bench/lab/ret010/dev-gate.ts verify-hosted <40-lowercase-head> <canonical-run-id>`.
That mode, not RET-010F, acquires and duplicate-key parses the immutable hosted
metadata, downloads and authenticates the two archives, verifies ZIPs and bundle
roots, validates markers/manifests/payloads/source, performs every identity and
digest join, applies thresholds/custody rules, and serializes the canonical
approval record. RET-010F performs none of those internal evidence operations
and has no second REST, archive, ZIP, extraction, marker, manifest, join,
threshold, or approval serializer/parser.

RET-010F requires the child to exit exactly zero, stderr to contain exactly zero
bytes, and stdout to contain exactly one verifier-produced canonical
UTF-8/no-BOM approval record with exactly one terminal LF and no other byte. It
reviews that result under maker/checker separation, then writes the stdout bytes
byte-for-byte as `bench/lab/ret010/approved-dev.json`; it does not parse,
reserialize, extend, drop, reorder, or transcribe a field. Those external
preflight, exact launch, channel/cardinality requirement, review, and byte copy
are RET-010F's complete responsibilities. RET-010F remains the sole authorized
invoker/reviewer of the acquisition-verifier mode and sole writer of the
approval JSON, but `verify-hosted` remains the sole executable evidence parser
and verifier. RET-010F adds only the approval JSON and does not add or modify a
reader, schema, policy, workflow, model, or evaluation path. Any need to change
verifier bytes starts a separately reviewed RET-010E revision and new hosted
run.

The later holdout gate consumes only the committed expanded approval record,
its artifact-name/ID/service-digest receipts, declared payload digests, approved
source lineage, and frozen qualification inputs. It never repeats or substitutes
the `verify-hosted` acquisition/internal verification or RET-010F approval
write, and remains valid after development artifact expiry.

This Decision 34 boundary incorporates and supersedes Decisions 28-33 and every
older clause that could be read to authorize caller-provided REST/ZIP bytes,
caller-selected extraction or holdout receipt paths, unauthenticated or
caller-selected GitHub acquisition, synthetic preselected production metadata,
exact-two total jobs/artifacts rather than exact selection from bounded paged
supersets, vague or unbounded ZIP parsing, ZIP inspection before service-digest
authentication, flattened archive extraction, nested baseline invocation of the
authoritative development gate, independent recomputation of an unpublished
paired vector/seed/interval, a production-reachable scorer fixture, multi-owner
or retried handle cleanup, an unfinalized holdout upload, loss of the RET-010A
workflow history, or a twelve-path RET-010E ceiling. Those readings are deleted:
only the authenticated `verify-hosted` acquisition, exact fail-fast direct
command, aggregate-honest, single-owner, sealed-fd3-test-only,
always-finalized, exact thirteen-path contracts above are authoritative.

Decision 34 additionally replaces every contrary reading that assigns RET-010F
a second executable hosted-evidence parser/verifier, claims aggregate-only bytes
independently prove unpublished per-probe conjunctions/vector/seed/interval,
allows ambient Git replacement/config/promisor/shallow/fsmonitor/lazy-fetch
state into the external preflight, or treats the default GitHub CLI config root
as caller input or allows it to change before `gh` spawn. Those readings are
deleted. The sole `verify-hosted` parser/verifier, aggregate-honest response-
effect claim, hardened fresh-environment Git preflight, frozen trusted config
root, and RET-010F preflight/launch/channel-review/byte-copy-only contracts above
are authoritative.

Decision 32 additionally replaces every contrary reading that would let
RET-010F launch without the immediate trusted-Git self-byte preflight, claim the
running verifier can attest its own pre-entry roots, forbid all repository reads
or permit an open-ended read/import/execute surface, hash unpinned or unjoined
source/data/policy bytes, derive test expectations from implementation
predicates, claim guaranteed token zeroization or allow unbounded token pipes,
apply environment denials before ASCII case-fold collision rejection, permit any
present `GITHUB_ACTIONS` fixture value, or claim universal transparent-Proxy
detection. Those readings are deleted. The external no-intervening-command
launch check, thirteen-path pinned read-only evidence allowlist, exact source and
dataset/policy domains/literals, independent threshold boundaries, bounded
best-effort token handling, folded environment policy, absent-only fixture
binding, and honest ordinary-object/Proxy boundary above are authoritative.

Decision 31 additionally replaces every contrary reading that would require a
`tsx`/ESM/TypeScript loader for approval verification, let `verify-hosted`
import, execute, or compile another source or evaluation dependency, tolerate exec arguments or
Node/preload environment hooks, claim pre-entry hostile-code detection, attest
or replace the stated RET-010F host trust roots, call `gh` with a shell or vague
stdio/deadline semantics, call the GitHub transport with retries or resettable
deadlines, accept a framed or nonempty artifact-redirect body, parse permissive
Link relations, make bit-set local ZIP CRC/size fields co-authoritative, treat a
central ZIP offset as self-authenticating, use bare holdout test identity keys,
claim JavaScript object-hostility coverage through JSON subprocess bytes, or
bypass the one pure fixture validator before production aggregation. Those
readings are deleted; the exact plain-Node, transport, ZIP, six-key fixture, and
split in-process/subprocess contracts above are authoritative.

Four Decision 29 readings are explicitly replaced: generic "existing session"
or safe-download wording is replaced by the exact no-shell `gh auth token` and
two-hop header/response transport; generic pages `1..10`/Link exhaustion is
replaced by total-derived exact pagination; the loose ZIP32/descriptor/type
profile is replaced by the exact version, attribute, descriptor, and numeric
profile; and fake-session production subprocess or vague fd3 scorer wording is
replaced by the in-process verifier factory plus the exact sealed raw-lane fd3
schema. No contrary portion of those four clauses survives.

Decision 34 authorizes this design-file correction only. It authorizes no
implementation, staging, commit, CI, GitHub REST call, artifact download,
RET-010F approval write, real holdout read or dispatch, deployment, activation,
threshold change, credential creation/use beyond the future existing
authenticated `github.com` CLI session, or permission change.

The later RET-006/G2 packet may change
`bench/lab/baselines/comparison-policy.json` and the ordinary G2 binding only
under its own design and approval; those changes are not RET-010 scope.

No other workflow, graph/store schema, persistence, planner, candidate
executor, feedback weight, remote provider, dependency, lockfile, deployment,
or configuration activation is in scope. If implementation requires any path
not listed above, stop and revise/reapprove this design before editing it.

## 10. Independent gates and custody

Each packet requires maker/checker separation, exact base and changed-path
custody, byte hashes, clean diff checks, and explicit commit/push/promotion
approval. A packet cannot self-approve. Hosted failures are preserved and may
not be rerun without a new independent ruling.

Before merging RET-010, the checker must verify that:

- the provider identity and formula exactly match this document;
- both serving paths use the same primitive and the lab uses that path;
- default-off and deterministic paths do not acquire unintended effects;
- ranked-v2 replay proves rather than asserts the applied order;
- no holdout oracle entered implementation or model selection;
- all required exact-head checks are green.

After every merge, verify ordered merge parents, byte identity, retained
feature branch, remote master, and a full exact-merge post-master workflow.

## 11. Stop conditions

Stop implementation or promotion on any of:

- candidate creation, scope widening, cross-tenant cache/state, remote call,
  secret/config dependency, persistence, or external side effect;
- reranking after budgeting, response-only sorting, benchmark-only ranking, or
  different production/lab model logic;
- identity scoring, unchanged served evidence, or no tight-budget membership
  change;
- served mode without planner/candidate prerequisites or on deterministic work;
- `ranked-v1` emitted for changed output, trace bypass, weakened replay, or
  content/scope/query leakage;
- formula, identity, bound, corpus, oracle, seed, threshold, or coefficient
  drift after declaration;
- development gate failure, holdout access before approval, any armed metric
  regression, nonzero isolation/stale/duplicate/unknown rate, or missing
  confidence evidence;
- unreviewed path expansion, source/base drift, P0/P1 finding, or irreproducible
  Node 20/22 output.

Two genuinely different frozen model versions failing the development gate
blocks RET-010 and requires an owner decision; it does not authorize threshold
weakening or holdout inspection.

## 12. Rollback and activation

Code ships default-off. Rollback is setting the already-controlled mode to
`disabled` or reverting the merge; no data migration or cleanup is required.
This design authorizes no deployment, live-service mutation, credential use,
configuration activation, destructive data action, direct-master push, force
push, or branch deletion.
