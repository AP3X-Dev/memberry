# Evaluation Lab Roadmap

This file tracks evaluation-lab work that is intentionally deferred but must not
be forgotten. A blocked dataset remains visible here and in
`registry/datasets.json`; it must never be treated as an executed benchmark, an
unsupported zero, or a silently skipped gate.

## LAB-013 candidate-blind multi-hop v2 instrument

**Instrument status:** candidate-blind v2 bytes and contracts are authored from
exact `origin/master` `a90d8a91aa0ec5f10796938798537aafc2ed0b9c` and await
independent review. Static syntax, JSON, raw-byte, corpus-order, and allowlist
checks are complete; no local substantive test, build, typecheck, adapter run,
control run, candidate run, or deployment has been performed. No candidate
adapter, candidate source, candidate result, control result, or holdout semantic
outcome was used to author or order the scenarios.

**CI admission status:** both unqualified v2 dataset descriptors are deliberately
`requiredInCi: false`, so the generic required-dataset CI route cannot treat an
unqualified instrument as an executable required comparison. Hosted run
`32437689875` remains red evidence and is not reinterpreted or replaced by this
registry correction. The instrument remains reachable through its dedicated
loader/scorer/qualification tests and the explicit manual control-qualification
workflow. Enabling generic required-CI execution requires a future, separately
reviewed capability-aware gate that can supply the correct registered arms and
joined qualification authority without weakening scorer custody.

**Public order-seed commitment (recorded before scenario bytes):** the frozen
ASCII seed is `memberry-lab013-v2-order-2026-08-20`. Its SHA-256 commitment is
`8a405c6921dc3e5790f0df6054620099ed98bf54767637229c5544f2e54e241a`.
For every scenario, each memory receives a neutral slot ID fixed independently
of its label, content, role, and any system result. Its corpus-order key is the
lowercase hexadecimal SHA-256 of the UTF-8 bytes of
`seed + "\n" + scenario_id + "\n" + neutral_slot_id`; memories are sorted by
that key ascending with neutral slot ID as the only tie-breaker. This derivation
is frozen for v2 and exists solely to make order reproducible while preventing
label-, content-, control-, or candidate-dependent ordering.

External session/tool evidence observed `ROADMAP.md` as the sole changed path
before the v2 dataset directory existed, and a later observation saw the v2 data
bytes. That external evidence supports the chronology attestation above; Git
metadata does not cryptographically or independently prove the chronology.

The v2 instrument must be qualified by an independently executed production
control receipt created before any candidate exists. Qualification is aggregate
and fail-closed: both dev and sealed holdout must have strict two-hop success in
`[0.30, 0.70]`, and every predefined low/medium/high distractor-density stratum
must contain both a success and a failure. Windows authoring does not execute
that control. Holdout oracles and semantic outcomes remain scorer-custodian-only;
only closed aggregate qualification may leave custody.

The pinned control is registered adapter `memberry-retrieval-core-v1`, class
`production-core-fixture-adapter`, with truthful adapter `executionMode:
fixture`; GitHub-hosted Linux is the separate execution environment, not adapter
fidelity. The qualification workflow requires its dispatch workflow-ref SHA and
requested source SHA to be identical before checkout. Immediately after exact
checkout and before dependency installation, a no-package preflight proves the
LAB-012 base ancestry, frozen 15-path LAB-013 envelope, approved
control/runner/registry Git blobs, and candidate absence. Installation uses
`npm ci --ignore-scripts`, then a clean-checkout check rejects tracked or
untracked mutation before the runner can dynamically import the control,
registered loader, or scorer-custody dataset graph. The runner independently
rehashes all four artifacts before control execution.

Immutable-SHA-pinned GitHub actions run Node 20 and Node 22; each instantiates
only that registered control and runs it once over dev and once over sealed
holdout with distinct split qualification run IDs. No comparison report or
second arm is constructed. Each matrix output is a distinct evidence-only kind
that the scorer rejects as authority. An always-running final custodian job
downloads exactly both closed evidence artifacts and requires both jobs and
both qualifications to be green, with identical workflow/source identity,
control identity, artifact bindings, and dev/holdout split plus stratum
aggregates. Only that join emits the authoritative
`lab013-control-qualification` kind accepted by the scorer. Missing, rejected,
or divergent evidence leaves an uploaded authoritative rejection tombstone and
fails the join. All evidence and authority include exact `workflowRefSha` equal
to `executedSourceSha`; they contain no scenario, probe, query, result,
required-fact, per-case digest, internal bootstrap seed, or raw error.

Any later candidate comparison is planned as fixture-mode registered evidence.
Its control run ID need not equal a qualification run ID; instead the scorer
binds the exact adapter/mode/artifacts and requires its recomputed split control
aggregate to equal the qualified split aggregate without exposing per-case data.

**Frozen v2 artifact manifest (canonical raw LF, no BOM):**

- Dev input: SHA-256 `7ea7b54899bf5e99905487d71da503667425ecff85aaa2d2c954640aa708d7d0`, 84,500 bytes.
- Dev scorer oracle: SHA-256 `25f9969a48ea4f30561e5bbd857aab10c3cb87422295842006e427dcbac70d64`, 4,860 bytes.
- Holdout input: SHA-256 `c4484005b4e0349da4018ec2ab6a4e3278fdbde3a964eb9fedad4f5ca1a68bc1`, 84,238 bytes.
- Holdout scorer oracle: SHA-256 `58a68db01cf237e0153c5055bab172483c4cb5e66363bfa3c721b2d45214cfb1`, 4,860 bytes.

These v2 bytes, order, labels, policy, and scorer are immutable after review;
any change requires additive v3 artifacts. Control headroom remains explicitly
unqualified until the bound hosted independent production-control receipt exists.

### Multi-hop v3 (RET-007 additive instrument) — control headroom rejected

The additive v3 instrument (`bench/lab/multihop/policy-v3.ts`, `generate-v3.ts`,
`qualify-control-v3.ts`, `.github/workflows/ret007-v3-control-qualification.yml`,
datasets under `bench/lab/datasets/multihop/v3/`) interpolates difficulty between
the saturated v1 exam and the over-hard v2 exam under pre-registered knob bounds
measured from the v2 dev bytes. Difficulty was tuned only against a disposable
public `calib` split (15 probes); `dev` and `holdout` (20 probes each) were then
generated once from the frozen knobs and hash-sealed in `MULTIHOP_V3_FREEZE`. A
three-split byte-reproduction test binds the committed bytes to the committed
knobs. Base commit `52aa9d6c880b7a29a99fe5c2537d9e76589af3c6`; merged at
`cb7309d1714f2050184fc780cebc5d4c7bbe0afa`.

The single authoritative hosted qualification, run `32812460464` at
`cb7309d1714f2050184fc780cebc5d4c7bbe0afa` (the only run of that workflow),
returned `control-headroom-rejected` with Node 20 and Node 22 agreeing.
Authoritative receipt SHA-256
`ac97e72d0efb6f2307b36804168477e09987d33f4371bf3ac172cebf6e6f709e`. Closed
aggregates: holdout control 11/20 (0.55) with successes and failures in every
stratum; dev control 17/20 (0.85), high-density stratum 6/0. The calib split
(8/15) predicted the holdout well; the dev split drew an easier domain block, and
at 20 probes per split the cross-split sampling variance exceeds the band's
tolerance.

The v3 bytes, knobs, policy, and scorer are frozen as a read-only record. No
recalibration, dev regeneration, v4 instrument, or re-dispatch is authorized
without an explicit owner decision. RET-007 strike accounting is unchanged: one
capability hypothesis spent (v1); v2 and v3 are both instrument failures, and no
candidate has yet run against a qualified non-saturated multi-hop instrument.

## Admission shadow evidence

`MEM-001D1` is the offline structural packet. It exercises the production core
store and admission runtime with deterministic fixture persistence, physical
dev/holdout input-oracle separation, exact hard metrics, and content-free atomic
artifacts through `npm run bench:lab:ci`.

`MEM-001D2` remains deferred. It must add disposable live Neo4j/MCP structural
evidence and hosted artifacts without relabeling D1 as live, weakening the
offline gate, or touching production data.

## External memory benchmark activation

**Roadmap target:** Phase 10, work package `CMP-006`, after phase gates G2
(Retrieval 2.0) and G5 (bitemporal semantics) pass.

**Current status:** blocked by design.

| Dataset | Registry ID | Current blocker | Activation constraint |
|---|---|---|---|
| LongMemEval-S Cleaned | `longmemeval-s-cleaned` | Upstream revision, artifact digest, and data review are unresolved | Do not enable until exact source bytes are pinned and reviewed |
| LoCoMo | `locomo10` | Non-commercial license approval, upstream revision, artifact digest, and data review are unresolved | Explicit human approval is required before any non-commercial dataset use |

### CMP-006A — Pin and approve source data

For each dataset, complete all of the following in one reviewable change:

- Pin an immutable upstream revision and immutable artifact URL.
- Record exact normalized size and SHA-256 from independently acquired bytes.
- Verify license identifier, source, and intended usage. LoCoMo's non-commercial
  terms require an explicit recorded approval; autonomous execution cannot infer it.
- Complete the privacy/data-policy review for personal data, secrets, customer
  data, retention, cache location, redistribution, and required exclusions.
- Record every rejected or excluded case with a reason; no silent exclusions.
- Change registry acquisition status from `blocked` only when every required
  field is concrete and its evidence is reviewable.

### CMP-006B — Build frozen dataset execution

- Add versioned input and scorer-only oracle loaders without exposing labels to
  candidate adapters.
- Freeze dev and holdout splits, transformations, prompts, scorer versions, and
  exclusion manifests. Hash both original and derived artifacts.
- Run the same accepted bytes and scenarios through control and candidate systems.
- Add negative tests for checksum mismatch, missing license/privacy approval,
  candidate oracle access, unsupported capability, and silent scenario exclusion.
- Prove a second offline run from the published cache produces the same normalized
  dataset and report hashes.

### CMP-006C — Execute and report

- Run LongMemEval and LoCoMo only after CMP-006A/B and gates G2/G5 are complete.
- Compare no-memory, scope-aware BM25, MemBerry proxy, and live MemBerry as
  distinct systems; never present proxy evidence as live product performance.
- Report coverage, answer quality, temporal correctness, stale leakage, isolation,
  latency, token/cost usage, failures, unsupported probes, and every exclusion.
- Include uncertainty/confidence intervals where the benchmark supports them.
- Identify exact commits, configs, runtime, hardware, dataset hashes, and adapter versions.
- Update this roadmap, `registry/datasets.json`, and the main PRP in the same
  closeout change; attach the final reproducibility artifacts.

### Activation gate

`CMP-006` is complete only when:

1. `npm run bench:lab:validate` passes with neither dataset marked `blocked`.
2. Network/source-file acquisition and a deliberate checksum-failure regression pass.
3. A cache-only rerun reproduces the same dataset and report hashes.
4. The report contains no unrecorded exclusions and no candidate access to holdout labels.
5. License and privacy approvals are recorded, including explicit LoCoMo usage approval.
6. The comparison report contains uncertainty and cost evidence and is independently reviewed.

Until then, these datasets remain registered and fail closed. Product work may
continue, but no release or comparison claim may imply that LongMemEval or LoCoMo
has been executed.

## Golden v2 — headroom-qualified retrieval RANKING instrument (RET-GOLDEN-V2)

**Instrument:** `memberry-golden-v2`, version `2.0.0`. Measures RANKING quality
(Recall@k / Precision@k / MRR / nDCG) of the production retrieval assembly path.
It does NOT measure answer quality, task completion, latency, or safety.

**Why it exists.** Measured at `6d2c6f7`: the golden set's Precision@5 is `0.4000`
against a STRUCTURAL ceiling of `0.4667`, with 8 of its 12 queries already maxed on
both Precision@5 and Recall@10 — an effective sample size of about 4. Every quality
metric is bit-identical to the 2026-08-14 `memberry-7a31231` baseline across 25
merged Retrieval 2.0 PRs. The instrument cannot distinguish "no improvement" from
"improvement it cannot see", so it cannot decide the G2 criterion "Precision@5
materially improved". Operating Rule 1 (headroom first: qualify the control before
candidate code is authorized) has never been applied to the golden set; it fails
that rule from the TOO-EASY side, the mirror of the LAB-013 rejection.

Golden v1 is NOT replaced. It remains the regression guard it became in RET-006,
with its `precisionAt5: 0.39` floor explicitly annotated as not a headroom metric.

### PRE-REGISTERED QUALIFICATION BAND

Fixed BEFORE any candidate arm exists. It may not be changed after any candidate
result is observed, and it is committed here before any dataset byte exists.

- **Structural ceiling MUST be 1.0:** every query carries >=5 relevant docs, so
  Precision@5 is not capped by construction. Exact equality, not `>=`.
- **Control Precision@5 in `[0.42, 0.58]`** on dev AND on the sealed holdout.
- **Control Recall@10 in `[0.45, 0.80]`.**
- **At most 1 query in ~40 maxed on both metrics** — the saturation counter, the
  direct analogue of RET-007 v4's headroom diagnostic H with the sign flipped.
  Non-negotiable.
- **>=3 clear successes AND >=3 clear failures in every distractor-density
  stratum** (`low`, `medium`, `high`).

```
GOLDEN_V2_CONTROL_BAND = {
  requiredStructuralCeilingPrecisionAt5: 1.0,          // exact equality, not >=
  minimumRelevantPerQueryInclusive: 5,
  minimumPrecisionAt5Inclusive: 0.42,
  maximumPrecisionAt5Inclusive: 0.58,
  minimumRecallAt10Inclusive: 0.45,
  maximumRecallAt10Inclusive: 0.80,
  maximumSaturatedQueriesPerSplitInclusive: 1,
  minimumSuccessesPerStratumInclusive: 3,
  minimumFailuresPerStratumInclusive: 3,
}
```

Split sizes are `calib 24 / dev 42 / holdout 42`, so each stratum is exactly 14 and
the one-saturated-query cap applies at its literal value. "Clear success" is
pre-registered as `precisionAt5 >= 0.6 AND recallAt10 >= 0.8`; "clear failure" is
its exact complement, so the two partition the split and no query is uncounted.
Both were settled before any control number was observed on any split.

### On rejection

1. Mark the version unqualified here with the closed aggregates and failure codes.
2. Leave the committed bytes exactly as they are. Frozen bytes are never mutated,
   regenerated in place, or deleted.
3. Upload the authoritative rejection tombstone artifact.
4. The ONLY permitted response is an additive `2.1.0` under new paths, tuning
   DATASET KNOBS ONLY, and only while no candidate arm, candidate adapter,
   candidate registration, or candidate result exists anywhere in the tree.
5. **Hard cap: two versions this campaign.** If `2.1.0` also rejects, stop and
   escalate with both tombstones and the measured knob-response table.
6. Never lower the band, never widen an interval, never drop a stratum, never
   shrink a split to make a rate land in range.

### GOLDEN V2 ANTI-GAMING RULE

```
GOLDEN V2 ANTI-GAMING RULE
Transcribed verbatim from PRP section 6.6, bullet 8 (2026-08-14):
"Record failures and exclusions; never remove a hard case merely to raise a score."
```

`GOLDEN_V2_ANTIGAMING_RULE` in `bench/lab/golden-v2/policy-v2.ts` holds that string
as a frozen literal, and a test asserts it matches this block character for
character. That pin proves the two tracked copies never drift after commit. It
cannot prove fidelity to the upstream PRP, because `docs/` is gitignored and git
has never seen that document — but the quoted sentence is one line, so anyone
holding the PRP can check it by eye.

A second, independently tracked analogue already exists above under CMP-006A
("Record every rejected or excluded case with a reason; no silent exclusions").
It predates this section and was written for a different work package, so it is
corroboration rather than the same evidence twice.

### Order-seed commitment (recorded before any scenario byte exists)

```
publicOrderSeed        memberry-goldenv2-order-2026-08-25
seedCommitmentSha256   0f6a8af36990d78b6224182638bfab9a6d17ba86c8e3c4ed0f5d800cc3711eb3
orderKeyDerivation     sha256-utf8(seed + LF + scenario_id + LF + neutral_slot_id)
```

Reproduced bit-identically under node:20 and node:22. Corpus order is therefore
independent of label, content, role, control output, and candidate output. This
follows the LAB-013 chronology precedent: the commitment is recorded before the
first scenario byte exists.

### Status

**NOT YET BUILT.** No dataset bytes, no adapter, no candidate, no registry entry
exists. The build is blocked behind a feasibility pilot that must first
demonstrate the five band terms above are JOINTLY satisfiable; if it cannot, the
design is tombstoned before any instrument version slot is opened.
