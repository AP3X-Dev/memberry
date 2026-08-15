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
