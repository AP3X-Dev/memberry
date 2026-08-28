# MEM-002 productionization — v3 candidate adapter

The candidate under test for the fresh blinded-holdout attempt is the
PRODUCTION module `packages/core/src/admission-feature-producer.ts`
(`memberry.safe-facts-feature-producer@1.0.0`). `worker.ts` is the container
adapter: it parses v3 scenario inputs, completes them to safe facts through the
production parser, executes the production producer (no lab copy of the
mapping), and emits the v3 prediction artifact within the frozen 32 KiB I/O
bounds.

## Dispatch material — landed

The packaging material for the single owner-authorized dispatch has landed.
It is finalized together with the custodian seal (`scorer-only/v3/seal.json`,
added in `76fd52f`, parsed by `scorer-only/blinded-holdout-artifact-v3.ts`)
under FULL-DEPTH verification, and binds identities that only existed once
the implementation merged and the holdout corpus was sealed:

- canonical networkless container build — `candidate-v3/build.ts` plus
  `candidate-v3/container/Dockerfile` (`da154e0`), the candidate-v3 analogue
  of the frozen `candidate/build.ts`, pinning content hashes and Git blob
  identities only;
- sandbox runtime policy wiring — the frozen `candidate/sandbox.ts`, imported
  at `build.ts:39` and `live.ts:33`; the hosted live proof runs the image
  once under those flags in `candidate-v3/live.ts` (`da154e0`);
- the one-shot workflow — `.github/workflows/mem002prod-holdout.yml`
  (`76fd52f`), a clone of the frozen `mem002c3-holdout.yml` discipline: same
  append-only `refs/tags/memberry-mem002c3-burn/` namespace, pre-start
  burn-authority verification of ALL four retired keys via
  `validateBlindedHoldoutBurnAuthorityAbsenceV3`, atomic tag before the sole
  candidate start, sequential Node 20 + Node 22 scoring of the sealed output,
  content-free public evidence; asserted by
  `scorer-only/__tests__/mem002prod-holdout-workflow.test.ts`;
- the canonical `contracts/c2-runtime-policy-receipt.v4.json` instance
  (schema: `contracts/c2-runtime-policy-receipt-v4.ts`), added in `76fd52f`,
  bound to the seal and to hosted attestation run `32773103347` attempt 1 by
  `contracts/__tests__/c2-runtime-policy-receipt-v4-instance.test.ts`.

The four logged failed-attempt classes
(docs/agent-runs/run-state-phase3-mem002.md) are do-not-retry-binding for that
packaging work. The frozen `candidate/` directory backs the historical v2-era
evidence chain and has no production role.
