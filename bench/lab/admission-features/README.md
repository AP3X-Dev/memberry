# Admission feature evaluation v1

This directory is the MEM-002B evaluation-only boundary for the six MEM-002A
feature dimensions. It does not implement an extractor, tier decision, runtime
hook, persistence path, model call, or live-service claim.

- `fixtures/v1/**/input.jsonl` contains opaque synthetic dev and holdout inputs.
- `scorer-only/v1/**/oracle.jsonl` contains physically separate labels opened by
  scorer code only.
- The exact agreement gate is frozen at `requiredAgreementPermille=1000` for
  this first hand-computable synthetic corpus.
- `unavailable` is a scored label, not a skipped value.
- Runtime-neutral artifacts are scorer-conformance evidence. They do not claim
  that a product extractor exists or has passed.

Candidate execution is outside this packet by design. The evaluator accepts
only a byte-bounded canonical JSON prediction artifact; it accepts no source,
module, path, callback, function, VM, worker, or extension interface. The
artifact has closed version/dataset/hash/scenario fields and six strict
MEM-002A feature envelopes per scenario. Scorer-only labels remain unopened
until the artifact passes byte, schema, corpus, canonical, deep-freeze, and
SHA checks.

## MEM-002C2 neutral runtime-policy receipts

The canonical v1 receipt remains immutable legacy evidence. Its historical
`candidateTreeOid` field names the repository root tree, so it must not be
reinterpreted or rewritten. The canonical v2 receipt replaces that ambiguous
field with distinct `repositoryRootTreeOid` and `candidateSubtreeOid` fields.
It also binds the exact v1 receipt and canonical v1 byte hashes.

The v2 parser is a closed, separate schema with no v1 fallback. It accepts v2
only when supplied with the exact canonical v1 bytes and proves that the policy,
candidate commit and content hashes, runtime image identities, input/output
hashes, and hosted-evidence binding are unchanged from v1. Unknown fields,
coercion, cross-version inputs, equal tree identities, and unrelated binding
drift are rejected. Before either receipt is parsed, v2 also requires pristine
JSON parse/stringify intrinsics and absent Object/Array prototype `toJSON`
descriptors so canonical checks cannot invoke ambient serialization hooks.

## MEM-002C3 blinded holdout agreement

The scorer-owned `blinded-holdout.ts` command and the dedicated
`mem002c3-holdout.yml` workflow implement the manual, single-attempt admission
packet. Before candidate execution, they freeze the integrated commit, candidate
tree, public input, sealed oracle, Linux platform, base image, and independently
attested MEM-002C2 runtime-policy receipt identities. Before the sole candidate
start, the workflow atomically creates a lightweight Git tag at
`refs/tags/memberry-mem002c3-burn/<one-shot-hash>` targeting the exact evaluated
commit, verifies that exact ref and target, and writes a burned start receipt.
The tag namespace is append-only: the workflow contains no update or deletion
path, and an existing tag permanently rejects reuse even when every evidence
artifact has expired or been deleted. Candidate bytes are accepted only on
standard input under the exact networkless, read-only, capability-free runtime
policy; the candidate is stopped and removed before scorer custody begins.

The sealed candidate output is scored sequentially under Node 20 and Node 22
without another candidate run. Promotion requires identical aggregate reports,
18 of 18 dimension agreements, zero mismatches, and the existing exact
`requiredAgreementPermille=1000` gate. The public artifact contains only frozen
identities, counts, hashes, lifecycle facts, cleanup facts, and the pass/fail
outcome. Start and result artifacts are evidence only; the durable Git tag is
the one-shot authority. Evidence never contains inputs, predictions, labels,
feature values, per-case
results, standard streams, paths, command lines, environment values, or tokens.

Local development is limited to synthetic scorer-only tests and static workflow
validation. The real one-shot must run only through the manual hosted workflow;
it must not be rehearsed locally or rerun after a burned attempt.

## MEM-002 productionization (v3)

The v1/v2 lookup-table candidate (`candidate/extractor.ts`) is a RETIRED lab
fixture with no production role: its bytes back the consumed blinded-holdout
evidence chain (pinned subtree OIDs and receipts) and are frozen, but nothing
in the product executes it. The live producer is
`packages/core/src/admission-feature-producer.ts`
(`memberry.safe-facts-feature-producer@1.0.0`), which emits the narrowed
three-dimension v2 envelope (`durability`, `evidenceQuality`, `sensitivity`)
from safe facts only and is consumed inside the admission routing shadow when
`MEMBERRY_ADMISSION_FEATURE_PRODUCER_V1=live`.

v3 instrument map (new files only; every v1/v2 instrument stays frozen):

- `contract-v3.ts` — dataset `memberry.synthetic-admission-feature-labels@3.0.0`;
  scenario input is the closed five-key safe-facts subset; oracle/prediction are
  three-dimension v2 shapes.
- `scorer-v3.ts` — same agreement semantics over the three v2 dimensions at the
  re-declared frozen `requiredAgreementPermille=1000` gate.
- `fixtures/v3/MAPPING.md` + `fixtures/v3/dev/input.jsonl` — published labeling
  function and the 14-scenario dev split.
- `scorer-only/v3/dev/oracle.jsonl` — dev labels, opened by scorer code only.
- `scorer-only/blinded-holdout-artifact-v3.ts` — v3 attempt identity core:
  all four retired one-shot keys, the v4 key derivation, custodian seal
  contract, and the extended burn-authority absence check.
- `candidate-v3/worker.ts` — container adapter executing the PRODUCTION
  producer (no lab copy of the mapping).
- `contracts/c2-runtime-policy-receipt-v4.ts` — receipt-chain extension for the
  fresh attempt (canonical `.v4.json` instance is produced by the owner-gated
  hosted attestation run).
- `__tests__/producer-v3-dev-agreement.test.ts` — the pre-holdout dev gate
  (42/42 cells at 1000 permille).

Holdout fixtures (`fixtures/v3/holdout/input.jsonl`,
`scorer-only/v3/holdout/oracle.jsonl`) are authored under scorer/owner custody
by applying the published mapping; the sealed oracle is never opened outside
one-shot scoring custody.
