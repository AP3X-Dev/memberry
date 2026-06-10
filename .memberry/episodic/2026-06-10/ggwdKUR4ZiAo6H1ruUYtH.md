---
id: ggwdKUR4ZiAo6H1ruUYtH
session_id: session-20260609-130500
agent_id: default
task: Phase P item 10 (I-45): align contract docs and mock portal with shipped portal reality
outcome: approved
created_at: "2026-06-10T03:11:41.461Z"
---

Phase P COMPLETE (10/10) on v2-rebuild-spec. Item 10 committed as a8bcd82 (13 files, +295/-588): docs/desktop-portal-contract.md rewritten to shipped reality; docs/portal-dev-handoff.md banner'd HISTORICAL; mint_credentials removed from PortalClient; mock /api/v1/auth/credentials route + CredentialRequest/Response/VendorCredential models + credentials.*.json fixtures deleted; mock README endpoint table corrected (no /playbook/version, no mint; added profile/companies/service_tokens); tests/test_contract_docs_reality.py pins it all. Full gate green: ruff, mypy --strict (148 files), pytest 2348 passed/1 skipped.

Decisions worth keeping: (1) docs/portal-beta-endpoints.md is GITIGNORED (local planning note, .gitignore:65) — its docs-reality pin test skips when the file is absent so CI checkouts don't crash; chose skip over un-ignoring because the gitignore was a deliberate publication decision. (2) The contract doc deliberately NAMES dead routes (agent_credentials, /api/v1/auth/credentials, playbook/version) inside an "Endpoints that do **not** exist" fence so readers grepping old names land on the warning — the pin test is section-scoped (forbidden before/after the fence, allowed inside) rather than a blanket substring ban. (3) Mock source stays strictly route-string-free (the NOTE comment was reworded to avoid the literal path) so the mock test can be a blanket source-level ban. (4) Contract doc's mock section now states known divergences honestly: mock submission response still distinguishes accepted/duplicate and errors carry code/field extensions — prod does neither; flagged "do not build against them" rather than rewriting the mock response shape (out of item-10 scope).