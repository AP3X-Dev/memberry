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

## Current program position

- **Last updated:** 2026-08-22
- **Exact remote master:** `8fbaa24f2302ab185e868cfbcd661ce14a768512`
- **Active critical-path phase:** Phase 2 — Retrieval 2.0; RET-010A through
  RET-010D are promoted, the RET-010E verification design is promoted, and the
  fresh thirteen-path RET-010E implementation is active
- **Highest phase started:** Phase 9
- **Closed phase gates:** G0, G1
- **Open phase gates:** G2 through G9 and GF
- **Program estimate:** approximately 20–25% complete
- **Measured retrieval-quality improvement:** exactly zero so far
- **Deployment state:** no deployment or capability-policy activation was
  authorized or performed by the current Retrieval 2.0 or SEC-001 work

## NEXT ACTION

1. Complete the fresh RET-010E implementation from exact master `8fbaa24f` in
   exactly the frozen thirteen paths. Use one maker plus independent
   specification and hostile/security checkers; preserve both rejected
   implementation worktrees unchanged.
2. Promote only zero-P0/P1 implementation bytes through a retained branch, PR,
   exact-head Node 20/22 and integration/live CI, normal merge, and exact
   post-master CI. Ledger only P2 findings that cannot affect evidence truth,
   security, tenant isolation, holdout blindness, executable feasibility,
   custody, thresholds, or measured outcomes.
3. Run one decisive hosted development qualification. If the frozen metric,
   safety, isolation, source, custody, or reproducibility gate rejects, preserve
   the evidence and stop model iteration instead of redesigning the instrument.
4. If development qualifies, complete RET-010F from independently authenticated
   hosted evidence, commit the canonical approval record, then dispatch the one
   authorized holdout and decide G2 from its measured aggregate evidence.
5. Keep RET-007 v2 permanently frozen. Keep deployment, activation, threshold
   changes, sealed holdout inspection, new credentials/permissions, destructive
   Git, tenant/data mutation, and live-service changes out of scope.

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
  `8fbaa24f`; exact-head CI `32564371580` passed, and post-master CI
  `32564828382` closed on exact-SHA attempt 2 after attempt 1 hit an unrelated
  transient wiki-viewer port collision.
- [ ] Implement and qualify RET-010E in the frozen thirteen paths on Node 20 and
  Node 22. `(active: fresh worktree at exact master 8fbaa24f)`
- [ ] Close RET-010F by independently authenticating the hosted development
  evidence and committing the canonical approval record.
- [ ] Close RET-010: qualify and independently approve the real served reranker.
  A shadow-mode flag or identity provider does not satisfy this item; the
  parent remains open until RET-010E and RET-010F close.
- [ ] Arm the previously declared G2 improvement threshold only when the
  qualifying capabilities exist.
- [ ] Pass G2: Recall@10 not below baseline, Precision@5 materially improved,
  stale/contamination zero, and task-success-per-token improved with confidence
  bounds.

### Retrieval escape conditions

- If LAB-013 control qualification rejects, do not mutate v2. Mark it
  unqualified, move active delivery to G3 or G6, and require a separate owner
  decision before any additive v3 instrument.
- If two genuine RET-007 capability hypotheses fail dev, mark RET-007 blocked
  and advance another independent roadmap lane.
- Do not create another lab packet merely because a candidate failed.
- Never lower thresholds, alter a frozen holdout, inspect sealed per-case
  outcomes, or manufacture a weaker control.

## Topological route to the final gate

```text
COMPLETED BOUNDED DETOUR: SEC-001 authenticated capability binding
PARKED: RET-007 until a separate additive-v3 owner decision
NOW
  -> fresh thirteen-path RET-010E implementation
  -> implementation review, PR, and exact post-master CI
  -> one decisive hosted development qualification
  -> RET-010F authenticated approval record
  -> one authorized holdout
  -> G2 Retrieval 2.0
       |-> Lane A: G3 lifecycle -> G5 temporal -> G7 reliability
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
- [ ] RET-004 — Calibrated reranker provider interface `(partial: served
  provider/reranker foundations exist; hosted qualification remains open)`
- [x] RET-005 — Contradiction/stale/dedup post-filter
- [ ] RET-006 — Token-budget evidence optimizer `(partial: budget evidence
  advanced; material utility gate remains open)`
- [ ] RET-007 — Query decomposition for multi-hop tasks `(blocked: LAB-013 v2
  control rejected; additive v3 requires a separate owner decision)`
- [x] RET-008 — Tenant-scoped learned routing and feedback
- [x] RET-009 — Caching, timeout, and provider fallback
- [ ] RET-010 — Real reranker promotion into the served response path
  `(partial: RET-010A through RET-010D and the RET-010E verification design are
  promoted; RET-010E implementation is active; RET-010F and measured holdout
  evidence remain open)`
- [ ] G2 — Retrieval holdout quality and safety gate

## Phase 3 — Admission and lifecycle intelligence

- [x] MEM-001 — Admission policy interfaces and shadow scorer
- [ ] MEM-002 — Salience/novelty/durability/sensitivity features `(partial)`
- [ ] MEM-003 — Tier routing and policy configuration
- [ ] MEM-004 — Confidence calibration and evidence diversity
- [ ] MEM-005 — Fair keyset candidate scheduling
- [ ] MEM-006 — Per-scope budgets, compaction, archive, and decay
- [ ] MEM-007 — Anti-entropy graph and queue repair
- [ ] MEM-008 — Risky-proposal advisor policy
- [ ] G3 — Lifecycle quality, calibration, and self-healing gate

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
9. **RET-010 fast path:** promotion blocks on P0/P1. Record non-safety P2
   findings in implementation acceptance instead of reopening the design; one
   hosted development qualification and one authorized holdout decide the
   route. A frozen-gate failure stops iteration rather than changing the
   instrument, thresholds, or sealed evidence.

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
