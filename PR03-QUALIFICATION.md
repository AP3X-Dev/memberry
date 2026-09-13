# PR-03 implementation and qualification

Status: PR-03 implementation and disposable qualification COMPLETE on snapshot
`d61a4ba472002029bac8d537541708b9d17813ce` (2026-09-13). This document does not
qualify a production generation, deployment, hosted CI or paid provider.

## Final qualified snapshot

Source archive SHA-256 `d667ba727c20f2e2fed36d00fb980ddc66930963b7a94bfbff67144a7a0ade39`,
1,038 files/modes verified after extraction at `/home/cerebro/memberry-pr03-final-hRGZDE/source`.
Node 20.20.2 and 22.23.2 (Linux x64): both offline gates passed all 13 stages, each
4,241 workspace passes / 125 offline skips and 971 + 1,153 lab passes. Both live arms
passed 27 PR-01/02 Vitest cases plus 6 reconciliation cases and 23 PR-03 cases
(13 authority, 6 runtime, 4 Redis), both report validators green, zero skips.
Offline gates needed a quiet host: three earlier same-SHA attempts failed only on
3-5 s lab subprocess budgets (and one vitest worker RPC timeout with zero failed
tests) while other projects held load at 7-11; they passed at load 2.3-2.6.
Final clone is clean at this SHA; no qualification containers or networks remain.
Local evidence: `.release-gate-runs/d61a4ba472002029bac8d537541708b9d17813ce/`
(gate stage logs, live logs, tests.json, chain.log, source archive and manifests),
hashed in `.release-gate-runs/d61a4ba-evidence.sha256`.

## Implemented requirements

| Requirement | Implementation | Evidence to finalize |
|---|---|---|
| Immutable descriptor identity | Core descriptor schema, canonical serialization and SHA-256 | Descriptor/provider contract tests |
| Scoped cache identity and validation | Redis v2 envelopes, complete batch validation, scope forwarding | Unit and required disposable Redis tests |
| Separate embedding spaces | Per-generation, per-source-kind projection indexes | Required Neo4j lifecycle fixture |
| Interrupted migration safety | Bounded backfill, failures, current canonical input checks | Interruption, retry and source-race tests |
| Qualification and activation | Frozen replay, source inventory/epoch binding, pointer CAS | Replay rejection, concurrent activation tests |
| Serving isolation | Query, CodeSearch, runtime candidates, consolidation generation contexts | Actual Neo4j query/runtime tests plus code/core regressions |
| Query vector identity | Fingerprint propagation; recompute or disable on mismatch | Same-dimension foreign/unknown space tests |
| Rollback and retirement | Retained qualified generations; observation window; logical retirement | Disposable rollback and policy checks |
| Maintenance and readiness | Scoped operator JSON command, status counts, bounded catch-up | CLI checks and lifecycle/status tests |
| Legacy retirement | Old backfill scripts disabled; raw vector fixtures require explicit opt-in | Production constructor audit and regression suite |

## Diagnostic evidence

Initial preflight source `0f2b94ea37dd2721b411bc7fa75420b13e82ffe2`, archive
SHA-256 `d18b87c9018dec6c702b669a1c9698844b406dffce74105a2174f9ee867b3742`,
1,034 files and modes verified in an isolated clone.
Required Redis: four passed. Generation lifecycle: one passed, five failed.
The first failure was index compatibility metadata validation; downstream
lifecycle failures followed the interrupted setup. This failed diagnostic is
retained and cannot be used as qualification.

Local full build passed. Initial lint passed with 463 warnings and zero errors.
Focused descriptor/cache/factory/service/scope/query/code/runtime tests passed.
Second diagnostic snapshot `143e940d5bc236ca6d5f42e3e4c8497fd6d7e203` passed
9 authority and 4 Redis tests; runtime passed 5 of 6. The failing first plain-reader
settlement has no proven root cause. Current runtime fixture adds diagnostics.

Resume on 2026-09-13 (Decision 16) closed the runtime failure. Test 1 was a wrong
filter (`code.*-vector` channels have no runtime source spec). Test 2 was a cold
Cypher plan timeout, measured on disposable clones 67e9841/7d0fba7/50ba50a:
structured episodic query 10-27 ms cached; cold plan 1,400-2,260 ms sequential,
1,850-2,370 ms with concurrent channel planning; legacy text 677-743 ms, qualified
872-947 ms before hoisting the active-pointer guard, 740-879 ms after. Runtime live
fixture passed 6/6 on 50ba50a with plan warming in the fixture only. Evidence:
`.release-gate-runs/{67e98418...,7d0fba70...,50ba50a7...}/`.

Final snapshot c913e27: both Node 20/22 offline gates passed all 13 stages (4,241
workspace passes / 125 offline skips; 971 + 1,153 lab passes each). Node 22 live arm
passed 27 + 6 PR-01/02 and 23 PR-03 cases with both validators. Node 20 live arm
passed every case but the authority fixture's afterAll exceeded its 60 s budget under
host load 11 (48 sequential DROP INDEX, 21.2 s at load 5); the validator refused it.
Fixture budgets raised to 300 s (Decision 17); a fresh same-SHA matrix follows.

Current source adds an append-only replay ledger, bounded reads, status cap and
13 authority live cases; it is newer than both snapshots. Stop build passed;
10 authority units plus 4 inventory tests passed; six runtime live cases were
intentionally skipped in offline discovery. No current-source full matrix or
final live qualification has run. See the CURRENT RESTART AUTHORITY at the top
of RESEARCH-TO-PRODUCTION-HANDOFF.md for exact evidence paths and next commands.

## Evidence boundaries

- Default OpenAI model alias remains unpinned and cannot qualify a generation.
- Fixtures use deterministic synthetic providers; no live provider traffic.
- Generation inventory is bounded to 10,000 sources, 4,096 dimensions and 100
  requested IDs. Unsupported scopes fail closed.
- Historical dense reads are unavailable. Exact unscoped reads do not union
  projects. Symbols retain their existing default-tenant ownership model.
- Source capture can lead projection catch-up; stale projections cannot serve.
  No automatic paid-provider worker is enabled.
- Global health cannot certify every tenant/project generation. Use scoped status.
- Legacy opt-in tests retain historical compatibility evidence only.
- Cold-plan versus QUERY_TIMEOUT_MS is a pre-existing operational limit, not a
  PR-03 regression and not fixed here: the sealed 2,000 ms channel bound (RET-009)
  is charged for Cypher planning, dense channel queries plan cold in 0.7-2.4 s on a
  loaded 4-core host, and Neo4j replans on statistics drift, so a first call after
  restart or replan may settle the disclosed `timeout` degradation. Neo4j community
  has no query log to separate planning from execution. Deferred to PR-04/PR-06
  operational limits; no latency ceiling is claimed for PR-03.
- Production mutation, deployment, publication and worktree commits remain undone.

PR-04 through PR-08 remain separate unfinished work.
