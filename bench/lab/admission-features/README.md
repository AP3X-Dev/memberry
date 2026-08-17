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
