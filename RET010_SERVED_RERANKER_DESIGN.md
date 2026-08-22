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

`runDeterministicCiGate` completes every pre-existing registry, baseline, and
comparison gate first, including both existing G2 calls still bound to disabled
`memberry-retrieval-core-v1`, and then makes RET-010 development its last
operation. It launches `dev-gate.ts` in an isolated Node child process and does
no further comparison, import, or evidence work after that child; it only
propagates the child's exit status. The child entry module must clean and
validate the current-run output boundary before dynamically importing any
registered adapter, evaluation, model, dataset, oracle, or policy source. It
may statically import only Node platform modules and the minimal custody code
needed to perform that pre-import cleanup. Thus an earlier deterministic-gate
failure cannot execute served development work, while ordinary CI still never
exposes served bytes to holdout scoring.

The dev gate writes its complete public evidence surface only below the
isolated directory
`node_modules/.cache/memberry-lab/runs/ret010-development/`. A successful
directory contains exactly these five regular files and no tombstone:
`recall-lane.json`, `precision-lane.json`, `efficiency-interval.json`,
`aggregate-result.json`, and `custody-manifest.json`. A failed directory
contains exactly `failure-tombstone.json` and no success or partial file.

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
  `sourceCommit`, `modelBlob`, `providerContractBlob`, and `adapterBlob`,
  lowercase 64-hex `datasetDescriptorSha256`, `inputSha256`, `oracleSha256`,
  `devPolicySha256`, `recallLaneSha256`, `precisionLaneSha256`, and
  `efficiencyIntervalSha256`, the same unsigned 32-bit `seed`, `quality` with
  exactly finite `recallDelta`, `precisionDelta`, `efficiencyPoint`, and
  `efficiencyOneSidedLower`, `safety` with exactly the four finite leak/rate
  values above and every value `0`, `responseEffect` with exactly
  `sameCaseOrderAndSelectionChanged: true` and integer
  `qualifyingCaseCount` in `[1,20]`, and
  `passed: true`; the model, provider-contract, and adapter blobs are the Git
  blobs for `packages/retrieval/src/served-reranker.ts`,
  `packages/retrieval/src/reranker.ts`, and
  `bench/lab/adapters/memberry-retrieval-core.ts` respectively;
- `custody-manifest.json` has `schemaVersion: "1"`, `decision: "passed"`,
  lowercase 40-hex `gitCommit`, `nodeMajor` (`20|22`), exact full
  `nodeVersion` matching `^v(?:20|22)\.[0-9]+\.[0-9]+$`, decimal-string
  `workflowRunId`, positive-integer `workflowRunAttempt`, and lowercase 64-hex
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
component from that root through the cache, runs, output-parent, and staging-
parent directories with `lstat` and `realpath`. Every component must be a real
directory and not a symbolic link, junction, mount point, or other reparse
point; the canonical parent must have the exact expected component suffix
`node_modules/.cache/memberry-lab/runs`, not merely a string prefix. The gate
repeats this component-by-component check after creating any directory and
immediately before either rename or publication. Cleanup may remove only the
already-verified leaf output or leaf staging directory, without following a
link, and must revalidate the leaf and all ancestors immediately before
deletion. A link, reparse point, changed realpath, unexpected suffix, foreign
entry, or validation race fails closed before reading, deleting, or publishing
through that path.

At executable-boundary entry, after those checks and before any served import
or evaluation, the child removes every prior verified output and sibling
staging leaf. Publication creates the staging leaf exclusively, revalidates its
ancestors and newly created leaf, writes a complete bundle with exclusive file
creation, verifies exact regular-file allowlist and canonical bytes, revalidates
again, and atomically renames the staging leaf to the output leaf. It then
revalidates the published leaf and its complete ancestor chain. No recursive
operation may follow a link. Hosted Ubuntu tests use real POSIX symbolic links
at each ancestor and leaf and real race substitutions between validation,
creation, deletion, and rename; every case must leave foreign targets untouched
and publish no success receipt. Dependency-injected filesystem-status fixtures
independently classify Windows junctions and other reparse points and mount
points at every component, exercise each corresponding fail-closed branch, and
prove that none is treated as an ordinary directory. This fixture proof is
classification-contract evidence, not a Windows execution gate; requiring a
real Windows junction/reparse/mount execution gate needs a separate path,
workflow, and approval. Runtime operation on every platform still rejects real
symbolic links, junctions, mount points, and other reparse points.

The executable boundary catches every synchronous throw, rejected promise,
late internal failure, and nonzero internal outcome. It removes any current
partial or success leaf and atomically publishes the closed current-run
`failure-tombstone.json` bundle. It then writes exactly the fixed value-free
message `RET010_DEV_GATE_FAILED` plus LF to stderr and exits nonzero; it never
rethrows or logs the cause. No cause, name, message, stack, path, scenario,
probe, query, result, oracle, adapter/provider output, or caller-controlled
value may reach stdout, stderr, the tombstone, or any other artifact. If the
filesystem itself prevents safe tombstone publication, the verified leaves are
left absent, the same fixed message and nonzero exit are used, and artifact
upload fails for missing files. Sentinel tests inject unique values through
every failure stage, thrown value, rejected value, error field, path, and
fixture field and require that none occurs in captured console bytes or any
published byte. This replaces and supersedes any earlier rethrow wording.

`bench/lab/ret010/dev-gate.ts` implements the development-bundle reader/verifier
once behind a value-free custody CLI mode, and RET-010F must use that exact
mode; no second parser, permissive JSON path, console transcription, or
manifest-only shortcut is allowed. Given the two extracted matrix artifacts,
the verifier requires
exactly two success bundles and exactly the Node-major set `{20,22}`, with no
tombstone, extra file, duplicate major, contradictory record, or third
manifest. For every record it parses the closed shape, reconstructs the
canonical UTF-8/no-BOM/one-LF bytes, requires byte equality, and recomputes
every file SHA-256, Git blob, dataset descriptor, input, oracle, policy, lane,
interval, aggregate, and manifest digest. It loads the unchanged
`dev-policy.json` and independently re-evaluates only that policy's declared
metric, safety, efficiency, and seed-rule thresholds rather than trusting
`passed` or `decision` fields. It joins their mirrored values across the policy,
reports, and aggregate, and joins provider/adapter/model identity, source
commit, workflow run ID, attempt, and digests across the reports, aggregate,
and both manifests. Separately from policy evaluation, it independently
validates the hard-coded RET-010E custody invariant: it recomputes aggregate
`qualifyingCaseCount` as the exact sum of the two lane counts, requires the sum
to be in `[1,20]`, and derives
`sameCaseOrderAndSelectionChanged === true` only from that positive sum. It
never accepts independent any-order-change and any-selection-change facts as a
qualification receipt. Both manifests must name the
same exact lowercase source commit, workflow run ID, and attempt; their full
Node versions must match their distinct majors; both must bind the same
byte-identical aggregate and aggregate digest. Any mismatch or contradiction
rejects the entire pair.

Before the child imports executable evaluation or model code, it requires
`git rev-parse HEAD` to be exactly 40 lowercase hexadecimal characters, requires
both tracked and untracked status to be empty, and compares raw working-tree
bytes with `git cat-file blob HEAD:<path>` for every one of the twelve RET-010E
paths plus these immutable, directly security-critical dependencies:
`bench/lab/stats.ts`, `bench/lab/baselines/canonical.ts`,
`bench/lab/datasets/hash.ts`, `packages/retrieval/src/served-reranker.ts`,
`packages/retrieval/src/reranker.ts`, and
`packages/retrieval/src/assembler.ts`. Missing paths, non-blob entries, mode
drift, byte drift, submodules, and untracked content reject. The same HEAD,
status, path modes, and byte comparisons run again after evaluation and
immediately before publication. These six paths are verification dependencies
already promoted by earlier packets, not mutable RET-010E scope; the RET-010E
tracked implementation ceiling remains exactly twelve.

RET-010F additionally verifies immutable hosted workflow metadata after the run
has completed: the parent workflow conclusion and the conclusions of exactly
the Node 20 and Node 22 matrix jobs must all be `success`, and their repository,
HEAD, run ID, attempt, and artifact identities must match the two bundles. A
failed or cancelled parent, a failed or cancelled matrix job, a stale attempt,
or a success bundle from any other run/attempt can never authorize
`approved-dev.json`. Within each matrix job the deterministic-gate process is
the final executable gate and its artifact publication is terminal. If that
job fails or is cancelled before a valid current-run success publication, its
always-running finalizer removes any verified stale/success leaf and may upload
only a tombstone bearing that job's current commit/run/attempt identity; if it
cannot safely do so, no artifact is uploaded. A success artifact remains
provisional until RET-010F proves the parent and both jobs successful. RET-010F
records the common aggregate digest plus both manifest digests, versions, run
ID, and attempt; neither a lone manifest nor console output may substitute.

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
fail-closed bundle verifier recomputes the aggregate count and boolean from the
two canonical lane counts and rejects disagreement. Tests must include a
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
`memberry-retrieval-core-served-v1` during RET-010. Before model implementation,
a separate harness-only packet adds
`.github/workflows/ret010-holdout-qualification.yml` to master. It has only a
`workflow_dispatch` trigger, `contents: read`, no environment/secrets, no write
permission, and exact string inputs `qualification_sha` and
`approval_digest`. It checks out that exact 40-lowercase-hex SHA with
`persist-credentials: false`, verifies `git rev-parse HEAD`, installs/builds,
and runs `bench/lab/ret010/holdout-gate.mts` under Node 20 and Node 22. It cannot
run on `push`, `pull_request`, `schedule`, or a mutable branch ref.

After development approval, a separate approval-record commit adds exactly
`bench/lab/ret010/approved-dev.json`. The closed record names the approved dev
source commit, model/provider/adapter Git blob hashes, aggregate dev receipt
SHA-256, both Node 20 and Node 22 custody-manifest SHA-256 values, full Node
versions, shared workflow run ID, workflow attempt, frozen
policy/dataset/input/oracle/seed digests, and decision `approved`. The
model/provider/adapter bytes must be unchanged from the named dev source
commit; the only intervening path may be that approval record.

`holdout-gate.mts` requires `qualification_sha === HEAD`, requires
`approval_digest` to equal the canonical SHA-256 of that exact record, verifies
all named blobs/digests, and then loads the existing G2 scorer-only holdout
lanes. It makes two separate uniform-k comparisons—existing 10-probe
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
not arm or claim the later material `+0.05` G2 threshold. The gate writes
only closed aggregate reports and custody manifests to the workflow artifact;
scenario/probe/query/result/oracle IDs, labels, and per-case outcomes are
forbidden. The automatic `bench:lab:ci` continues to evaluate disabled
`memberry-retrieval-core-v1`, so no push or PR can accidentally invoke this
lane.

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

The RET-010E tracked path ceiling is twelve. It consumes the experiment
registry truth already promoted with RET-010D and must not rewrite that entry.

The workflow change is limited to the existing Node-matrix
`Evaluation-lab deterministic gate`, one value-free finalizer immediately
after it, and one terminal upload step. No other step may follow the upload.
The deterministic-gate step runs RET-010 last in its isolated child as frozen
in section 7.1. The finalizer uses only the custody boundary (it must not import
evaluation, adapters, model code, datasets, policies, or oracles), runs with
`if: always()`, and binds the leaf to the current HEAD/run/attempt. It preserves
a success bundle only when the immediately preceding deterministic-gate step
succeeded and the bundle has that exact current identity; otherwise it safely
replaces any verified leaf with the current-run tombstone. A cancelled job that
cannot execute the finalizer has no approving artifact because RET-010F rejects
its job conclusion and any stale identity.

The terminal upload uses
`actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02`,
`if: always()`, `if-no-files-found: error`, `include-hidden-files: true`, and
`retention-days: 14`. Its exact artifact name is
`memberry-ret010-development-node-${{ matrix.node-version }}-${{ github.run_id }}-${{ github.run_attempt }}`;
it uploads only
`node_modules/.cache/memberry-lab/runs/ret010-development/`. No existing upload
surface, workflow trigger, job dependency, permission, environment, secret, or
configuration value changes. Ordinary CI still never imports or invokes the
holdout gate and keeps both existing G2 calls bound to disabled
`memberry-retrieval-core-v1`. The binding tests prove the RET-010 child is last,
the finalizer and upload ordering is exact, every failure/cancellation path is
non-approving, and no step can upload a stale success leaf.

### RET-010F — independently approved development receipt

- `bench/lab/ret010/approved-dev.json` (new, only after exact-byte and
  aggregate-receipt approval)

The independent RET-010F checker must invoke the single fail-closed bundle
reader/verifier frozen in section 7.1 against exactly the two downloaded
matrix artifacts and the completed hosted-workflow metadata. It may write the
closed approval record only after that verifier returns the fully joined,
policy-recomputed Node 20/22 result. RET-010F adds only the approval JSON; it
does not add or modify a reader, schema, policy, workflow, model, or evaluation
path. Any need to change verifier bytes starts a separately reviewed RET-010E
revision and new hosted run.

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
