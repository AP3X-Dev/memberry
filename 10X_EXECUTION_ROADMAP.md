# MemBerry 10X Execution Roadmap

This is the canonical, tracked execution checklist for the MemBerry 10X program.
It is intentionally shorter and more operational than the detailed PRP and local
decision logs. Future sessions must resume from `NEXT ACTION` instead of
reconstructing or redesigning completed work.

The original detailed PRP remains in the local, gitignored workspace at
`docs/superpowers/specs/2026-08-14-memberry-10x-autonomous-prp.md` when that
workspace history is present. This tracked file is the portable execution
authority for sequencing and completion state. Evaluation-dataset activation
details remain in
[`bench/lab/ROADMAP.md`](bench/lab/ROADMAP.md).

## Checkbox rules

- `[x]` means the parent work package or gate met its acceptance criteria and
  merged with the required evidence.
- `[ ]` means open. A `(partial)` note means useful foundations exist but the
  parent package or gate is not closed.
- Test files, lines of code, review rounds, hardening packets, and subpackets do
  not count as roadmap completion by themselves.
- Only the root orchestrator updates this file, and only after a parent package,
  gate, terminal rejection, or active `NEXT ACTION` changes.

## Planning surface (reconciled 2026-08-26)

This file is the ONLY document that describes current program state. Everything
else is either design detail or a historical record.

- **Supporting design references** (durable detail, not plans):
  [`bench/lab/ROADMAP.md`](bench/lab/ROADMAP.md) for evaluation-dataset state and
  the CMP-006 licence blocker; `RET010_SERVED_RERANKER_DESIGN.md` (RET-010A–D
  promoted, E/F/parent open); `SEC001B_RUNTIME_BINDING_DESIGN.md` (implemented).
- **Run records** live in the gitignored `docs/` workspace, which is a nested
  private repo with no remote. `docs/agent-runs/run-state-*.md` files are
  autonomous-run RESTART ANCHORS, not plans — a cold session resumes from the
  matching run-state, then this file. Closed runs carry a superseding banner.
- **Full inventory and dispositions:** `docs/PLANNING-SURFACE-INVENTORY.md`
  (private workspace).
- If any other document appears to describe current state or a next action,
  it is stale — this file wins.

## Current program position

- **Last updated:** 2026-08-26
- **Exact remote master:** `2ad56a4fd4da15ee16e5729f4d0bb56f39faf488` (PR #111 —
  the RET-006 precision gate and its structural-ceiling pin)
- **Active critical-path phase:** Phase 2 — Retrieval 2.0. G2 is the only gate
  still open below the current work front: RET-010's holdout evaluation was
  never authorized or run, and RET-007 is parked blocked on indexing.
- **Highest phase started:** Phase 9
- **Closed phase gates:** G0, G1, G3
- **Open phase gates:** G2, G4 through G9, and GF
- **Program estimate:** approximately 35–40% complete
- **Measured retrieval-quality improvement:** still exactly zero. RET-007 v3 was
  tombstoned on a qualified holdout; RET-007 v4 measured control 28/60 vs
  candidate 30/60 on dev (+3.3 points, CI [-5.0, +11.7]) and did not pass. The
  lifecycle work that closed G3 improved noise load and calibration, not
  retrieval quality.
- **Deployment state:** Phase 3 packets are merged, deployed to Cerebro, and
  live-verified. The COD-010 slice is deployed with the Neuri code index at
  12,339 symbols. No Retrieval 2.0 capability-policy activation has been
  authorized.

## NEXT ACTION

The holdout-harness repair that this section previously demanded is DONE. Stage
receipts for pre-flight rejections merged (`9eae555`, `c7af25e`, `d43b646`,
`9f4b210`), and two authenticated development records landed (`3665d6d` from run
`32644686048`, `d39712a` from run `32647104086`). Three lanes are now open and
the sequencing decision is the owner's:

1. **G2 (Phase 2 close).** Obtain explicit owner authorization for one actual
   RET-010 holdout evaluation. Decide G2 from its permitted aggregate receipt
   and stop. This is the only thing standing between the program and a closed
   Phase 2; note that G2 would close on the reranker alone, with RET-004,
   RET-006, and RET-007 still open beneath it.
2. **IDX-001 (the structural bet).** Index-time structure — Phase A first. This
   is the measured prerequisite for RET-007 and, per Findings 3 and 4, the lane
   most likely to move retrieval quality off zero. Entry below at the Phase 3
   tail.
3. **COD-010b.** Spec APPROVED and previously parked behind the RET-007 v4
   campaign; that campaign has ended, so the lane is released. Restores the code
   service under the live candidate-channel composition — `runtime-candidate-channel.ts`
   drops `include_code`, so mixed requests still render `Code: unavailable
   (candidate-channel)` under the live flags. Re-ground the base against current
   master before implementing; line numbers have drifted.

Standing scope exclusions, unchanged: keep RET-007 v2 and v3 permanently frozen;
keep deployment, activation, threshold changes, sealed holdout inspection, new
credentials/permissions, destructive Git, tenant/data mutation, and live-service
changes out of scope unless separately authorized.

## Confirmed context-engine incident — Neuri code plane

Live read-only audit on 2026-08-22 confirmed that this is a real product/setup
failure, not merely an unhelpful agent answer:

- Cerebro MemBerry was confirmed at `1052232f`, 159 commits behind roadmap master,
  then separately upgraded on 2026-08-22 to exact CI-green `844aeb0`. The upgrade
  removed version drift but did not itself repair the remaining incident classes.
- The live graph contains 34,504 `Symbol` nodes but zero with
  `project_tag = project:neuri`; the represented projects are Hermes Agent,
  MemBerry, AG3NTIC, and legacy unscoped files.
- `berry_context(include_code=true, include_memory=false)` returned zero sources
  and a successful-looking empty code trace instead of an actionable unsupported
  status.
- The mixed code+memory request returned semantic summaries only, without saying
  that current code evidence was unavailable.
- The same mixed request with tracing enabled returned the opaque public error
  `Retrieval trace validation failed`.
- `berry_tools enable code` reported success, but Codex still received no callable
  `berry_code_search`, `berry_code_symbols`, or `berry_code_context` schema. The
  server's tool-list notification contract is therefore not sufficient for every
  supported client.

**Partially repaired as of 2026-08-25 (COD-010 slice, PR #94, deployed).** Two of
the six findings are closed: Neuri is indexed at 12,339 `Symbol` nodes tagged
`project:neuri`, and `berry_code_search` returns live-repo symbols that hit the
held-out regression evidence (`pieces_catalog.py`, `ApiIntegrationAction`, and the
relevant tests); the 10,428 stale audit-day clone rows were deleted. Silent empty
code traces are gone — `berry_context` now states code-plane status per response
as `served (K of N)` or `unavailable (reason)`.

**Still open.** Mixed code+memory requests under the live flags
(`MEMBERRY_QUERY_PLANNER_V1=1`, `MEMBERRY_CANDIDATE_CHANNEL_V1=1`,
`MEMBERRY_RERANKER_V1=served`) render `Code: unavailable (candidate-channel)`,
because `runtime-candidate-channel.ts` has no code option and drops
`include_code`. COD-010b closes this. Until it does, a Neuri answer may cite
`berry_code_search` results directly, but must treat a mixed `berry_context`
request as carrying **no** code evidence, use repository inspection as authority,
and label retrieved semantic nodes as historical context only. A semantic-only
answer must never count as code-context success.

The exact held-out regression is the integration-Library discovery incident. Given
the original diagnosis request, MemBerry must retrieve and cite the current Build
Hermes catalog handler, Tools integration handler, integrations HTTP endpoint,
Google Calendar action manifest, and relevant tests; it must identify the MCP-versus-
piece catalog split or explicitly report which required evidence is missing.

## Immediate Retrieval 2.0 exit checklist

- [x] Bind G2 evidence to the real production retrieval adapter (LAB-010/011).
- [x] Freeze scorer-separated multi-hop v1 (LAB-012).
- [x] Reject RET-007 v1 approach 1 honestly: control `1.0`, candidate `1.0`,
  delta `0`, interval `[0,0]`; holdout unopened; PR #49 closed unmerged.
- [x] Author candidate-blind, non-saturated multi-hop v2 instrument (LAB-013).
- [x] Merge LAB-013 instrument-only PR #50 as `d984c6b`; no qualification or
  capability claim.
- [x] Pass exact-merge post-master CI (`32440317151`): Node 20, Node 22,
  integration, artifacts, and cleanup all succeeded.
- [x] Execute the exact-source joined Node 20+22 LAB-013 control qualification
  as run `32441685712` against `d984c6b`; both nodes agreed and the sole
  authoritative output was a `control-headroom-rejected` tombstone (SHA-256
  `862b6134c10172888b5f6274596d974f2466c9f32d6f1683e61532295fa1e4d1`).
- [x] Record the terminal headroom result: dev control `5/20` (`25%`), holdout
  control `3/20` (`15%`); holdout low and medium strata had no successes.
- [x] Freeze LAB-013 permanently after rejection. No candidate was registered
  or executed, and no production capability was changed.
- [x] Apply the declared escape condition: do not run either RET-007 v2
  hypothesis or the v2 candidate holdout; park RET-007 pending a separate owner
  decision on any additive v3 instrument and advance the independent G6 lane.
- [x] Complete the bounded SEC-001 detour: strict SEC-001A contract commit
  `660b2d26`, SEC-001B design merge `a43a3da`, runtime merge `3c623e8`, and exact
  runtime post-master CI `32469628048` all passed without deployment or policy
  activation. G6 and the remaining SEC packages stay open independently.
- [x] Promote RET-010A through RET-010D: qualification instrument, ranked-v2
  model, real served-response wiring, and runtime composition.
- [x] Promote the RET-010E verification design through PR #68 as merge
  `8fbaa24f`, the fast-path roadmap through PR #69 as `6793fe7f`, and the final
  executable CommonJS boundary through PR #70 as exact master `844aeb0`.
- [x] Implement and qualify RET-010E in the frozen thirteen paths on Node 20 and
  Node 22. `(merged and qualified by CI 32627897999)`
- [x] Close RET-010F by independently authenticating the hosted development
  evidence and committing the canonical approval record as `f8627b8`.
- [x] Close RET-010: qualify and independently approve the real served reranker.
  A shadow-mode flag or identity provider does not satisfy this item; the
  parent remains open until RET-010E and RET-010F close.
- [x] Arm the previously declared G2 improvement threshold only when the
  qualifying capabilities exist.
- [x] Repair the holdout harness so it emits content-free stage-classified
  failure receipts. `(9eae555 pre-flight stage receipts, c7af25e fallback
  receipts off the structured output path, d43b646 fully-qualified dispatch ref
  comparison, 9f4b210 holdout-only split count; authenticated development
  records 3665d6d from run 32644686048 and d39712a from run 32647104086)`
- [ ] Obtain explicit owner authorization for one actual holdout evaluation.
  `(the live blocker on G2 — nothing technical is outstanding)`
- [ ] Pass G2: Recall@10 not below baseline, Precision@5 materially improved,
  stale/contamination zero, and task-success-per-token improved with confidence
  bounds. `(READ THIS BEFORE DISPATCHING THE HOLDOUT. "Precision@5 materially
  improved" is pre-registered as +0.05 over the immutable baseline's 0.4000.
  Measured 2026-08-25, precision@5 on the golden set is capped at 0.4667 by how
  few relevant docs its queries carry, so the criterion asks for 75% of all
  reachable headroom. Confirm the holdout instrument does not share that
  structure before spending the one shot — if it does, G2's precision clause is
  close to unmeasurable and the gate would reject a genuinely better ranker.)`

### Retrieval escape conditions

- If LAB-013 control qualification rejects, do not mutate v2. Mark it
  unqualified, move active delivery to G3 or G6, and require a separate owner
  decision before any additive v3 instrument.
- If two genuine RET-007 capability hypotheses fail dev, mark RET-007 blocked
  and advance another independent roadmap lane. `(This limit was deliberately
  superseded for the v4 campaign by explicit owner authorization on 2026-08-25;
  v4 then failed dev honestly and RET-007 is now blocked on indexing. The limit
  is back in force — reviving RET-007 before IDX-001 needs a fresh owner
  decision.)`
- Do not create another lab packet merely because a candidate failed.
- Never lower thresholds, alter a frozen holdout, inspect sealed per-case
  outcomes, or manufacture a weaker control.

## Topological route to the final gate

```text
COMPLETED: SEC-001 capability binding; RET-010A-F; Phase 3 (MEM-002..008,
          MEM-006H) -> G3 CLOSED 2026-08-25; COD-010 fail-loud slice
TERMINAL:  RET-007 v1 (saturated), v2 (no control headroom), v3 (dev rejected)
PARKED:    RET-007 v4 — measured, blocked on indexing, resumes after IDX-001
NOW (owner picks the order; these do not block each other)
  -> G2: one authorized RET-010 holdout -> decide Retrieval 2.0 and stop
  -> IDX-001 Phase A: index-time structure, the measured prerequisite for RET-007
  -> COD-010b: code service under the live candidate-channel composition
       |-> Lane A: G3 CLOSED -> G5 temporal -> G7 reliability
       |-> Lane B: G4 Git-native coding memory
       |-> Lane C: G6 security/tenancy -> G9 operations UI
       `-> Lane D: G8 agent behavior
                -> Phase 10 comparisons and release audit
                -> GF final release gate
```

After G1, independent lanes are permitted. A blocker in Retrieval 2.0 must not
freeze G3, G6, or G8 indefinitely.

## Phase 0 — Control and execution spine

- [x] CTL-001 — Immutable baseline manifest
- [x] CTL-002 — Feature-flag and experiment registry
- [x] CTL-003 — Autonomous run state
- [x] CTL-004 — Benchmark/release gates in CI
- [x] G0 — Reproducible baseline, isolated candidate, resumable state

## Phase 1 — Minimum viable evaluation spine

- [x] LAB-001 — Versioned lab contracts and registries
- [x] LAB-002 — Baseline and candidate adapters
- [x] LAB-003 — Deterministic metrics engine
- [x] LAB-004 — Run manifest and artifact writer
- [x] LAB-005 — PR comparison gate
- [x] LAB-006 — Dataset acquisition and license registry
- [x] LAB-007 — Temporal/isolation scenario expansion
- [x] G1 — Reproducible comparison with regression enforcement

## Phase 2 — Retrieval 2.0

- [x] RET-001 — Secret-safe retrieval trace model
- [x] RET-002 — Entity/scope/time-aware query planner
- [x] RET-003 — Multi-channel candidate contract
- [x] RET-004 — Calibrated reranker provider interface `(closed 2026-08-25 on
  its PRP acceptance, "local and remote implementations; baseline fallback
  preserved": createLocalRerankerProviderV1, createHttpsRerankerProviderV1 with
  https-only endpoint validation, and baselineIdentityRerankerScoreV1 all live in
  packages/retrieval/src/reranker-providers.ts and are bound by named RET-004B
  tests. Verified at 6d2c6f7 in node:20 on cerebro: reranker + reranker-shadow +
  served-reranker + quality.regression = 66/66 pass. The "hosted qualification"
  this line previously demanded was RET-010's, and it closed with approval record
  f8627b8.)`
- [x] RET-005 — Contradiction/stale/dedup post-filter
- [ ] RET-006 — Token-budget evidence optimizer `(partial, and the acceptance is
  now measured rather than vague. PRP acceptance is "precision/context utility
  improves without Recall@10 regression"; the pre-registered arming rule in
  bench/lab/baselines is precisionAt5 minImprovement 0.05, armed: false,
  armsWith: RET-006 — so a candidate must reach 0.45 against the immutable
  baseline's 0.4000. MEASURED 2026-08-25 at 6d2c6f7: precision@5 = 0.4000,
  recall@10 = 0.9306, and the STRUCTURAL CEILING of precision@5 on this
  12-query golden set is 0.4667, because 8 of the 12 queries have so few
  relevant docs that they already sit at their own cap. The +0.05 the rule
  demands is therefore 75% of all headroom that exists, reachable only by
  fixing three of the four queries that have any. WARNING before anyone tries:
  the golden set is the regression instrument, not a held-out one — tuning the
  ranker until precision@5 clears 0.45 on the same 12 queries that define the
  threshold is measuring on train, and would be the same selection-inflation
  error the RET-007 campaign spent four attempts avoiding. Closing RET-006
  honestly needs either a mechanism gain that shows up somewhere other than
  this set, or a golden set with more relevant docs per query. A regression
  guard at precisionAt5 0.39 plus a pinned ceiling test now exists on branch
  feat/ret006-precision-gate.)`
- [ ] RET-007 — Query decomposition for multi-hop tasks `(v4 measured and
  parked 2026-08-25 — BLOCKED ON INDEXING, resume after IDX-001; see the
  Phase 3 tail RETURN POINT and docs/agent-runs/advisor-log-2026-08-25-ret007v4.md
  Findings 3 and 4; source preserved at tag archive/ret007-query-decomposition)`
- [x] RET-008 — Tenant-scoped learned routing and feedback
- [x] RET-009 — Caching, timeout, and provider fallback
- [x] RET-010 — Real reranker promotion into the served response path
  `(reconciled 2026-08-25 — this line contradicted the exit checklist above,
  which already recorded RET-010E qualified by CI 32627897999 and RET-010F
  closed as approval record f8627b8. The specific evidence wins. The one
  outstanding holdout is a G2 GATE item, not a RET-010 item; RET-010's own
  acceptance is the served reranker, and it is served.)`
- [ ] G2 — Retrieval holdout quality and safety gate

## Phase 3 — Admission and lifecycle intelligence

- [x] MEM-001 — Admission policy interfaces and shadow scorer
- [x] MEM-002 — Salience/novelty/durability/sensitivity features `(live feature
  producer PR #96; holdout corpus PR #97; custodian seal PR #98)`
- [x] MEM-003 — Tier routing and policy configuration `(PR #91 tier routing;
  PR #95 live routing inside the shadow write path)`
- [x] MEM-004 — Confidence calibration and evidence diversity `(PR #92; ECE
  111‰, maxGap 143‰, Brier 20‰, report identity 130ebf01…)`
- [x] MEM-005 — Fair keyset candidate scheduling `(PR #93)`
- [x] MEM-006 — Per-scope budgets, compaction, archive, and decay `(PR #99)`
- [x] MEM-006H — Usage-modulated (Hebbian) decay `(PR #102)`: retrieval hits and helpful
  feedback strengthen a memory (slow/reset its decay, decay-class promotion
  eligible); memories never retrieved decay faster and sink to archive first.
  Depends on MEM-002 durability features + MEM-006 decay engine; today decay
  is purely time-based (volatile 14d / stable 90d / permanent 365d) and only
  explicit reinforcement signals raise confidence — mere use changes nothing.
- [x] MEM-007 — Anti-entropy graph and queue repair `(PR #100)`
- [x] MEM-008 — Risky-proposal advisor policy `(PR #101)`
- [x] G3 — Lifecycle quality, calibration, and self-healing gate `(CLOSED
  2026-08-25, owner-ratified. All four clauses PASS at 52aa9d6 on an isolated
  seeded corpus: noise load sidecar −55.0% and active memory −15.2% with 25
  review-gated decay proposals and zero protected losses; durable Recall@10
  1.0→1.0 byte-identical pre/post; calibration report reproduced exactly;
  self-heal 15/15 fault injection against real Redis with zero unsafe
  mutations. Evidence pack docs/agent-runs/g3-evidence-2026-08-25.md plus
  -raw/. Packets 9/9 merged, deployed, and live-verified; ratchet 3351→3579.)`
- [ ] IDX-001 — Index-time structure: write-time extraction plus local-model
  backfill. Plan at docs/agent-runs/packet-plan-idx-001-local-llm-indexing.md.
  Phase A (atomic facts as additional retrieval keys) is measurable on today's
  instruments and comes first; Phase B (entity graph, aliases, project-scoped
  identity) needs a NEW graph-carrying instrument version — lab scenarios carry
  no entity fields today, so budget that apparatus cost before Phase B, not
  after. Ships with the D-DOCS agent-guidance deliverable in the same change as
  the schema.
- [ ] RETURN POINT: RET-007 multi-hop — resume AFTER IDX-001, not before.
  Measured 2026-08-25 (advisor log Findings 3 and 4): the query-time mechanism
  now recovers the withheld second hop in 13 of 14 calib scenarios, up from 0,
  but cannot decide WHEN to fire — every text-only gate signal tried was
  degenerate (fired 45/45, or 0/45, or cut the wrong cases). Deciding requires
  knowing whether two memories are linked, which is a property of the index and
  does not exist at query time. With a working gate the same mechanism scores
  35/45 against a control of 22.
  On return, expect to REPLACE rather than tune: given recorded links you
  traverse them instead of guessing a bridge from capitalised tokens and
  re-querying, and Phase A may remove the need entirely for the scenarios it
  makes reachable in pass 1. Keep the lexical second pass as the fallback for
  memories the index never covered (pre-schema memories, absent agent extras,
  backfill lag). Do NOT raise the scorer's K to convert the near-misses at
  positions 11-12; that moves the goalposts and voids every recorded number.
  Work preserved on branch research/aug25-multihop (best keep f23438b; best
  mechanism 62eb486) with the calib harness at bench/lab/multihop/tune-calib-v4.ts.

## Phase 4 — Git-native coding memory

- [ ] COD-001 — Repository/branch/worktree/commit identity `(partial)`
- [ ] COD-002 — Stable symbol identity and relocation mapping
- [ ] COD-003 — Code-bound memory provenance
- [ ] COD-004 — Drift-driven confidence and invalidation
- [ ] COD-005 — Git/PR/CI/test connector contracts
- [ ] COD-006 — Branch-merge knowledge reconciliation
- [ ] COD-007 — Multi-repository dependency graph
- [ ] COD-008 — Pre-edit and post-verification context pipeline
- [ ] COD-009 — Directory-scoped managed-agent context
- [ ] COD-010 — Code-index readiness and fail-loud context assembly. A scoped code
  request returns repository root, indexed commit/branch, index time, file/symbol/
  test counts, exclusions, watcher/error state, and drift; zero code cannot be
  silently replaced by semantic memory. `(partial: the fail-loud slice merged as
  PR #94 c4cd671, deployed, post-master CI 32724618129 green — berry_context now
  states code-plane status per response as "served (K of N)" or "unavailable
  (reason)", and Neuri is indexed at 12,339 symbols. KNOWN GAP closing in
  COD-010b: mixed requests under the live flags still render "Code: unavailable
  (candidate-channel)". CORRECTED 2026-08-25 after re-grounding against master —
  an earlier version of this line blamed runtime-candidate-channel.ts and would
  have sent an implementer to the wrong file. That file does lack a code option,
  but its per-channel "unavailable" is a candidate-channel FAILURE CODE that
  never reaches the rendered line, and two existing pins
  (runtime-candidate-channel.test.ts:103 and :207) would block a fix attempted
  there. include_code is actually dropped at tools.ts:517, where executeOptions
  is built with only includeArchitecture and includeMemory; the fix belongs in
  the assembler's assembleCandidateExecutionServed, which is what the approved
  spec says. Note also that berry_context now has TWO served call sites
  (tools.ts:523-526 multihop, :528-531 non-multihop) — patching one leaves the
  bug alive under the other flag combination. COD-010b spec APPROVED at
  docs/agent-runs/specs/2026-08-25-cod010b-code-service.md, implementation
  unstarted — the lane it was parked behind has ended.)`
- [ ] COD-011 — Current worktree and dirty-overlay context. Responses distinguish
  canonical, branch, worktree, dirty, deployed, and unrepresented bytes and attach
  resolvable path/symbol/line/commit anchors.
- [ ] G4 — Private coding-task improvement gate

## Phase 5 — Bitemporal semantics and ontology

- [ ] TMP-001 — Bitemporal schema and compatibility reader `(partial)`
- [ ] TMP-002 — Late/out-of-order event reconciliation
- [ ] TMP-003 — Relationship-level bitemporal history
- [ ] TMP-004 — Future-effective changes
- [ ] TMP-005 — Versioned ontology registry
- [ ] TMP-006 — Online migration and rollback tooling
- [ ] G5 — Temporal QA, provenance, and rollback gate

## Phase 6 — Identity, tenancy, privacy, and providers

- [x] SEC-001 — Actor/tenant/project capability model `(SEC-001A contract
  `660b2d26`; SEC-001B design/runtime merges `a43a3da` and `3c623e8`; exact
  post-master run `32469628048` green; default-off and not activated)`
- [ ] SEC-002 — JWT/OIDC verifier interface
- [ ] SEC-003 — Per-tool and resource authorization
- [ ] SEC-004 — Uniform mutation audit
- [ ] SEC-005 — Tenant-qualify satellite domains
- [ ] SEC-006 — Dedicated tenant datastore and wiki routing
- [ ] SEC-007 — Quotas, rate limits, and backpressure
- [ ] SEC-008 — Secret/PII admission policy
- [ ] SEC-009 — Retention/export/hold/delete workflow
- [ ] SEC-010 — Local/provider-neutral inference stack
- [ ] Investigate the observed project-scoped `berry_context` result that mixed
  in another project's architecture; keep it separate from G2 unless an
  isolation review escalates it.
- [ ] G6 — Adversarial tenant/authz/privacy/provider gate

## Phase 7 — Reliability and scale

- [ ] OPS-001 — End-to-end OpenTelemetry and correlation `(partial)`
- [ ] OPS-002 — SLO metrics and readiness policy
- [ ] OPS-003 — Fault-injection harness
- [ ] OPS-004 — Mutation journal and anti-entropy replay
- [ ] OPS-005 — Backup verification and restore drill
- [ ] OPS-006 — Load generator and dataset synthesizer
- [ ] OPS-007 — Backpressure, fairness, and index tuning
- [ ] OPS-008 — Rolling upgrade and migration rehearsal
- [ ] OPS-009 — Deployed-version and project-index inventory readiness. Readiness
  reports source commit/image, per-project symbol inventory, last successful index,
  and code-plane degradation; semantic scope without a code index is partial setup.
- [ ] G7 — SLO/RPO/RTO, scale, and fault-survival gate

## Phase 8 — Skills and agent behavior

- [ ] AGT-001 — Live-schema-derived skill contracts
- [ ] AGT-002 — Cross-client guidance source model
- [ ] AGT-003 — Behavioral agent harness
- [ ] AGT-004 — Hook/context-floor hardening
- [ ] AGT-005 — Procedural-memory proposal workflow
- [ ] AGT-006 — Pre-compact and session-end automation
- [ ] AGT-007 — Actionable error and recovery contracts
- [ ] AGT-008 — Progressive-disclosure optimization
- [ ] AGT-009 — Cross-client progressive-disclosure compatibility. Codex, Claude,
  Gemini, and Hermes must either receive newly enabled callable schemas in-turn or
  use one permanently visible typed gateway; reporting enabled while tools remain
  undefined fails the client harness.
- [ ] G8 — Agent adherence and reduced-intervention gate

## Phase 9 — Human trust and operations UI

- [x] UI-001 — Retrieval explanation view
- [ ] UI-002 — Temporal/provenance/confidence timeline
- [ ] UI-003 — Unified proposal review and preview
- [ ] UI-004 — Tenant/project pipeline health
- [ ] UI-005 — Tenant-qualified atomic wiki publication
- [ ] UI-006 — Retrieval replay and incident export
- [ ] G9 — Tenant-safe explanation, review, recovery, and audit gate

## Phase 10 — Comparison and release candidate

- [ ] CMP-001 — Local Graphiti adapter
- [ ] CMP-002 — Local/self-hosted Mem0 adapter
- [ ] CMP-003 — Local Letta adapter
- [ ] CMP-004 — Local Cognee adapter
- [ ] CMP-005 — Managed adapters when credentials exist `(optional)`
- [ ] CMP-006 — Full LongMemEval/LoCoMo/DMR suite
- [ ] CMP-006A — Pin and approve LongMemEval/LoCoMo source data
- [ ] CMP-006B — Frozen loaders, splits, scorers, and acquisition replay
- [ ] CMP-006C — Execute no-memory, BM25, proxy, and live comparison
- [ ] CMP-007 — Private coding-memory benchmark
- [ ] REL-001 — Release-candidate audit across G2 through G9
- [ ] REL-002 — Independent hostile program review
- [ ] REL-003 — PR, operator handoff, decision ledger, and rollback runbook
- [ ] GF — All mandatory evidence complete; default-off until human-reviewed
  release/deployment

## Rejected approaches — do not repeat

- **G2 proxy evidence:** the original G2 lanes measured a small BM25 proxy, not
  production retrieval. LAB-010/011 corrected the binding.
- **LAB-012 as capability evidence:** v1 is saturated by construction. It may
  remain as a regression instrument but cannot prove a positive RET-007 delta.
- **RET-007 v1 approach 1:** post-retrieval bridge multipliers changed no strict
  top-10 outcomes. Do not rerun it against LAB-012 or weaken that policy.
- **LAB-013 v2 control:** exact-source joined Node 20/22 qualification rejected
  control headroom (dev 25%, holdout 15%; holdout low/medium had zero
  successes). Do not mutate v2, run a v2 candidate, or treat the tombstone as
  infrastructure failure.
- **RET-007 v3:** the instrument qualified on holdout (0.55, strata 4/3, 3/4,
  4/2) and the candidate was rejected on dev (0.85, high stratum 6/0). Terminal
  — tombstoned via PR #104. Do not revive the v3 mechanism or re-run it.
- **RET-007 v4 query-time multi-hop:** instrument (PR #108) and candidate
  (PRs #109/#110) both merged and honestly measured; dev gave control 28/60 vs
  candidate 30/60, +3.3 points, CI [-5.0, +11.7] — FAILS. Follow-on calib
  investigation drove second-hop recovery from 0/14 to 13/14 but could not build
  a firing gate from text alone. Do not tune this further at query time; the
  missing signal is index-side. See the RETURN POINT below.
- **Flag-only reranker promotion:** the current reranker is shadow-only and the
  wired baseline provider is identity. A flag flip cannot improve served order.
- **Endless evaluator repair:** a candidate failure is not permission to build a
  new dataset, change thresholds, or inspect sealed per-case outcomes.

## Operating rules that prevent another stalled phase

1. **Headroom first:** qualify the control before candidate code is authorized.
2. **Capability before another lab packet:** after a frozen qualified instrument,
   the next change must affect production behavior or explicitly block the
   capability.
3. **Two-hypothesis limit:** after two genuine dev capability failures, stop the
   packet and advance another independent lane.
4. **Parent-level progress only:** report closed work packages, gates, and
   measured behavior—not test counts, subpackets, or review activity.
5. **One active item per lane:** the root orchestrator owns sequencing and
   prevents overlapping edits.
6. **Risk-proportional review:** full maker/checker/hosted evidence for production
   capability and security boundaries; one static checker plus hosted rerun for
   narrow test/registry corrections.
7. **No phase monopoly:** after G1, a blocked G2 packet cannot prevent safe,
   dependency-ready work in G3, G6, or G8.
8. **No silent replanning:** source drift or a concrete P0/P1 may change the
   route; difficulty, boredom, or a new session may not.
9. **RET-010 fast path:** implementation promotion blocks on P0/P1. Record
   non-safety P2 findings in implementation acceptance instead of reopening the
   promoted design; one hosted development qualification and one authorized
   holdout decide the route. A frozen-gate failure stops iteration rather than
   changing the instrument, thresholds, or sealed evidence.

## New-session restart protocol

Every new session must do exactly this before proposing work:

1. Read this file completely.
2. Read `AGENTS.md` and the authoritative PRP only for the active package's
   detailed acceptance criteria.
3. Fetch and verify `origin/master`, open PRs, active worktrees, and the run named
   under `NEXT ACTION`.
4. If repository state matches this file, resume the exact next unchecked item.
5. If it does not match, update factual identity/state first; do not redesign the
   roadmap.
6. Preserve all entries under `Rejected approaches` and `Retrieval escape
   conditions`.
7. Update this file only when a parent package, gate, terminal rejection, or
   active `NEXT ACTION` changes.
