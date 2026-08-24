# MEM-002 productionization — v3 candidate adapter

The candidate under test for the fresh blinded-holdout attempt is the
PRODUCTION module `packages/core/src/admission-feature-producer.ts`
(`memberry.safe-facts-feature-producer@1.0.0`). `worker.ts` is the container
adapter: it parses v3 scenario inputs, completes them to safe facts through the
production parser, executes the production producer (no lab copy of the
mapping), and emits the v3 prediction artifact within the frozen 32 KiB I/O
bounds.

## Sealed-at-dispatch material (not in this packet)

The following are finalized together with the custodian seal
(`scorer-only/v3/seal.json`, parsed by
`scorer-only/blinded-holdout-artifact-v3.ts`) under FULL-DEPTH verification
before the single owner-authorized dispatch — they bind identities that only
exist after the implementation merges and the holdout corpus is sealed:

- canonical networkless container build (candidate-v3 analogue of the frozen
  `candidate/build.ts`) and its content-hash pins;
- sandbox runtime policy wiring (frozen `candidate/sandbox.ts` discipline);
- the one-shot workflow (clone of the frozen `mem002c3-holdout.yml`
  discipline: same append-only `refs/tags/memberry-mem002c3-burn/` namespace,
  pre-start burn-authority verification of ALL four retired keys via
  `validateBlindedHoldoutBurnAuthorityAbsenceV3`, atomic tag before the sole
  candidate start, sequential Node 20 + Node 22 scoring of the sealed output,
  content-free public evidence);
- the canonical `contracts/c2-runtime-policy-receipt.v4.json` instance
  (schema: `contracts/c2-runtime-policy-receipt-v4.ts`), produced by the
  hosted attestation run.

The four logged failed-attempt classes
(docs/agent-runs/run-state-phase3-mem002.md) are do-not-retry-binding for that
packaging work. The frozen `candidate/` directory backs the historical v2-era
evidence chain and has no production role.
