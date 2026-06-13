---
id: zwH5pNhuqf27bLCIHN9xb
session_id: session-20260613-ag3ntic-morph
agent_id: default
task: WQ-23 task 11: per-outcome proposal builders (database + shared storage)
outcome: approved
created_at: "2026-06-13T08:33:47.924Z"
---

Built infra proposal builders (WQ-23 task 11, spec 6.1/D7/D10) on branch spec/docker-mcp-catalog-sync, commit f6502d4.

Files: apps/api/platform_core/infrastructure/images.py (approved_image(family)->pinned image@digest from infra/images.lock.env; split_ref_digest); builders/{__init__,database,shared_storage}.py; tests/test_infra_builder_storage.py.

Key decisions/findings:
- InfrastructureChangeProposal has NO resource_type column -> resource_type carried in requested_changes JSON ({"resource_type":"database"|"object_store"}).
- create_proposal signature has no resource_type kwarg; the builders pass requested_changes/docker_plan/image_references/secret_requirements/resource_slug/project_label/requested_by.
- Engine (adapter.py) pulls images by reading container.digest + container.image_ref off EACH plan container (adapter._image_targets) -> builders put bare image:tag on image/image_ref and sha256 on digest.
- docker_plan carries execution-only keys (image_ref, digest, read_only, network, command) that InfraSpec(extra=forbid) rejects on a raw parse; the engine strips them via adapter.build_infra_spec before the InfraSpec parse. Tests round-trip via adapter.build_infra_spec, NOT raw InfraSpec(**plan).
- D10: passwords/root creds are MINT requirements only: secret_requirements={"POSTGRES_PASSWORD":{"action":"mint","kind":"postgres_password"}}, MinIO MINIO_ROOT_USER/PASSWORD mint. No plaintext in body; POSTGRES_USER/POSTGRES_DB static env.
- Isolation: data-bearing resource on its OWN internal=True network (ag3ntic_db_{slug}_net / ag3ntic_store_{slug}_net), NEVER ag3ntic_runtime_{workspace_id}.
- Shared storage uses MinIO (object_store, pinned) not FileBrowser (unpinned).
- Builders do NOT set ag3ntic.* labels (registry.compute_labels does it at execution).
- Gates: 7 new tests green; regression test_infra_execution+proposals+validator = 45 green; ruff clean.