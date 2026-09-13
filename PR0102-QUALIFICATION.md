# PR-01/02 qualification record

Resumed 2026-09-11 from `RESEARCH-TO-PRODUCTION-HANDOFF.md` in this worktree.
Base: `60cf9757e5ec7aefdc94d785b4a5dd075ed89d1a`, branch
`feat/research-to-production`. The 92 checkpoint hashes matched before editing;
GitHub master still matched this base. Source changes are uncommitted.

## Scope and evidence boundary

This record tracks the PR-01/02 predecessor work in
`C:\Users\Guerr\Downloads\memberry-production-research-plan.md`. It does not
close PR-00, PR-03 through PR-08, or certify production. Production services and
data were not changed. Qualification uses synthetic data in disposable Docker
Neo4j/Redis services on Cerebro with no host networking or published ports.

## Requirement mapping

| Requirement | Implementation and decisive evidence |
|---|---|
| PR-01.1–3 strongest obsolete evidence / every reader / canonical lifecycle | `query.ts` shared Semantic eligibility; required `semantic-eligibility.live.test.ts` and `service.delivery.live.test.ts` cover vector overflow, tags, entity and stable IDs, graph, ranked/deterministic assembly, and runtime channels. Legacy predecessors remain superseded after their successors expire/archive. |
| PR-01.4 transactional supersession | `semantic.ts` locks and revalidates source/claim, aligns node/ABOUT/SUPERSEDES intervals, filters association endpoints, and preserves later revocations on exact replay. Required supersession live fixture installs its own schema and exercises competing writers. |
| PR-01.5 legacy repair | Read-only inventory plus `reconcile-semantic-supersession.mjs` plan/apply/conditional rollback. Exact snapshots, transactional receipts/epochs, quarantine, no invented timestamps. Required node:test fixture exercises real Cypher. See script operator guide for constraints and maintenance prerequisites. |
| PR-01.6 terminal eligibility | Core, CodeSearch, ranked/deterministic assembler and runtime adapters exclude unknown or ineligible Semantic IDs before serialization. Real assembled live fixture complements mocked channel regressions. |
| PR-01.7 current conflict evidence | Explicit disputed values and exclusive `version_is` conflicts retain balanced atomic groups. Multiple dependencies/capabilities are not inferred conflicts. Canonical entity/tenant/project identity separates groups. Corroboration no longer revokes unrelated multivalue facts. |
| PR-01.8 authorization | Semantic candidate/terminal and graph endpoint checks; Core fact tenant/project filter precedes ranking for current and historical reads. Unknown or conflicting project tags cannot enter a scoped fact result. |
| PR-02.1 authoritative epoch | Same-transaction mutations in Neo4j stores, Core import/bootstrap, wiki ingestion/reconciliation, code indexing, architecture/drift, and research evidence writers. Project mutations advance the tenant aggregate. |
| PR-02.2–6 cache identity / missed invalidation / final read / stale writers | Real `ContextCache` and `KnowledgeEpochStore` fixture. Core E1/E2 use the tenant aggregate to cover shared topology; cache identity and source authorization remain project-specific. The actual cache method receiver is retained. Redis publication fences reject older workers. |
| PR-02.7 bounded work | Existing service/safe-load regressions cover cancellation, timeout, 32 in-flight loads, and 32 outstanding raw authority reads, including providers that ignore cancellation. |

## Mutation coverage boundaries

Code, architecture and research writer APIs remain default-tenant APIs; adding
epoch transactions does not add multi-tenant authorization to them. Research
mutations explicitly reject foreign ownership. Rendered-context caching remains
hard-disabled in the production factory. The explicit library versioned mode is
not a blanket guarantee for external/ad-hoc graph writers or unsupported
cross-tenant shared topology. Maintenance writers must use the epoch protocol or
keep rendered caching disabled.

Historical responses remain authorized history, not a mechanism for accessing
another project's facts. Reconciliation rollback never promises to remove
information already read by an agent.

## Runs

- Initial disposable source archive SHA-256:
  `28a36c54916b3f5fbfd24d008b7eec5110ddd53dfd606cb33dc14c05849b216a`.
  Root `/home/cerebro/memberry-pr0102-resume-G5AaPB`: 10 live tests passed,
  one failed. The standalone supersession fixture omitted schema initialization;
  without Semantic ID uniqueness both racing creates succeeded. Fixed fixture
  initialization, retained the failure log locally in
  `.release-gate-runs/pr0102-first-live.log`. Containers/network removed.
- Expanded source archive SHA-256:
  `9fba4cf0e4efd3c35b1e02de3982301379291b14c79ab10180050a996eb7a5f5`.
  Root `/home/cerebro/memberry-pr0102-resume-TTEZXZ`: Node 22 live qualification passed: 26/26 Vitest cases across five files, report validator green, and 6/6 node:test reconciliation cases. All three stage exits were zero.
  This archive includes the repaired lifecycle, cache, mutation, fact scope,
  and expanded live fixtures. Later source edits require another binding.

## Current local checks

Build and formatting passed. Lint passed with 462 warnings under the unchanged
469-warning ceiling. Core complete run: 1,182 passed / 15 skipped. Script
contracts: 43 passed. Earlier package-specific checks are recorded in the
handoff/advisor log; they are not substitutes for the final settled-source gate.

## September 11 stopping point

Paused by user request; all workers and qualification processes stopped. Full
handoff: `RESEARCH-TO-PRODUCTION-HANDOFF.md`. No packet is closed here.

Clean disposable snapshot `9a733db17288d4478307dd5bce4ede4cc192f9a4` at
`/home/cerebro/memberry-pr0102-final-d0ypH6` failed Node 20 qualification:
workspace 4,079 passed / 3 failed / 101 skipped; lab 955 passed / 13 failed;
lab typecheck exit 2, lab CI exit 1. Other nine stage receipts passed. Evidence:
`.release-gate-runs/9a733db17288d4478307dd5bce4ede4cc192f9a4/node20-20260911T165155Z-858638/`.
The earlier `bb47c5f` run was deliberately interrupted for a source correction.

Local repairs now cover the three outdated query assertions, scoped lifecycle
authority in all three lab retrieval adapters, and the admission cache overload.
Frozen benchmark data, reports and thresholds were preserved. Lab typecheck and
73 focused tests passed. Historical code-response labels and actual MCP handler
regressions also landed: Code full 231 passed / 3 skipped; targeted 26 passed.
Retrieval 951 passed / 8 skipped plus 12 deterministic passes / one live skip;
MCP tools 73 passed; Neo4j idempotency 11 passed. Latest full build passed before
the final lab fixture edits. These are local/focused evidence only.

One broad lab selection encountered the unchanged dirty-source Git-object test's
`Git blob unavailable`; clean-source qualification remains necessary. Independent
requirements review found only the now-repaired historical serialization gap.

Next: create a NEW complete clean snapshot including every current source/test
change, then finish Node 20/22 full offline and required live suites on that SHA.
The expanded Node 22 live success above is real but predates final edits. Never
reuse its results as current-source proof. Expect 27 Vitest live cases plus six
reconciliation tests. Hosted CI and repository protection remain external gates.

## September 12 resumed qualification

All 176 checkpoint hashes matched before edits; base and remote master remain
60cf975. Local build/format passed, lint remained 462 warnings / zero errors.
The snapshot helper now preserves tracked executable modes and rejects unsupported
source entries. All 1,024 normalized files and modes were verified locally and
after fresh extraction into a disposable checkout.

Snapshot `4d4c416fa66939d5bbf411a754e904c933af0c4d` at
`/home/cerebro/memberry-pr0102-final-bbUxfp/source` passed 12/13 Node 20 stages:
workspace 4,085 passed / 102 skipped; lab 969 passed / one failed. Lab typecheck,
registry/baseline validation, lab CI, and source binding passed. Failure evidence:
`.release-gate-runs/4d4c416fa66939d5bbf411a754e904c933af0c4d/node20-20260912T153203Z-1653561/`.

The remaining lab failure compared current adapters against frozen RET-007 v4
experiment blobs. Preserve the approved blobs, workflow, datasets and receipts.
The repaired test instead verifies original commit
`1975dadde9442d03ba9ae1ae59b811324253e8c0`, its exact path envelope and six blobs,
then executes the unchanged source-preflight guard against isolated committed
mutations. Changed blobs, missing/extra paths and mismatched HEAD reject.
Focused custody tests passed 7/7; lab typecheck passed. Current adapters are not
qualified reproductions of that historical experiment. The historical guard
checks committed source; this repair does not add dirty-worktree enforcement.

Fresh complete source qualification is required after this test repair. PR-03A
remains gated on both Node-major offline and required-live results on one SHA.

## Final September 12 result — predecessor gate satisfied

The pending requirement above is now fulfilled. Clean disposable source
`6f18e2a00cbbd804806587fa8634584bc274a6d1` at
`/home/cerebro/memberry-pr0102-final-nfqBsj/source` passed all required arms:

| Arm | Result |
|---|---|
| Node 20.20.2 offline | 13/13 stages; workspace 4,085 passed / 102 offline skips; lab 2,124 passed / zero skips |
| Node 22.23.2 offline | 13/13 stages; workspace 4,085 passed / 102 offline skips; lab 2,124 passed / zero skips |
| Node 20 required live | 27 Vitest plus six reconciliation cases passed; zero skips |
| Node 22 required live | 27 Vitest plus six reconciliation cases passed; zero skips |

Lab totals include both stages: 971 general lab and 1,153 serialized RET-010
tests. Both live report validators passed. The integrated evidence check verifies
source SHA/clean state, exact receipt set and hashes, runtime majors, exact live
file set, counts and reconciliation status. Independent offline review matched
all 1,024 normalized source files and Git modes to the archive.

Evidence: `.release-gate-runs/6f18e2a00cbbd804806587fa8634584bc274a6d1/qualification-summary.json`
and the four sibling run directories. Source archive SHA-256:
`2a24ea24feec5f99c6a3e0e2939c97b757b61e6ea3b3b6f093763784d87ffd61`.
Final remote clone is clean; all qualification containers/networks were removed.
Only closeout docs/checkpoints change locally after this qualified snapshot.

PR-01/02 implementation and disposable qualification are complete, permitting
PR-03A. This is not hosted CI or production release qualification. Rendered
caching remains disabled in production composition; supported-writer boundaries
above remain in force. No production mutation, worktree commit, push, or deployment.
