---
id: IuxsL04m7n9F7C_VTbomh
session_id: session-20260613-ag3ntic-morph
agent_id: default
task: Build section-11 infra execution engine (adapter.py) for the Infrastructure Change Proposal Docker plan.
outcome: approved
created_at: "2026-06-13T08:12:16.431Z"
---

Built apps/api/platform_core/infrastructure/adapter.py: the section-11 execution engine (WQ-23 task 10). It is a status-guarded, idempotent, resumable state machine that runs an ACCEPTED InfrastructureChangeProposal's docker_plan. Key design decisions:

- execute_proposal(session, *, workspace_id, proposal_id) -> dict is the top-level entrypoint; helper _step_* functions per section-11 step.
- Resume journal lives in proposal.execution_detail: {completed_steps:[...], network, volume(s), container, secret_refs (REFS only), health, resources:{network/volumes/container registry ids}, error}. Each step no-ops when its marker is set; a re-run resumes from the first incomplete step. begin_execution re-claims a failed/executing proposal (status stays 'accepted', execution_status flips).
- docker_plan -> InfraSpec: build_infra_spec() maps {containers,networks,volumes} via InfraSpec.model_validate; container entries are stripped to the InfraSpec-modeled subset (execution-only keys image_ref/digest/read_only/network/command/limits dropped to satisfy extra='forbid'), but banned knobs (privileged, host-path mounts) are KEPT so the validator can reject them at step 6.
- Step 2 RESOLVE vs MINT: _classify_requirement handles dict {action:resolve,ref}/{action:mint,kind} and bare 'secret://...' string (resolve). RESOLVE -> secrets.resolve_ref; MINT -> secrets.mint_credential. Plaintext injected into container env in-memory ONLY; only .ref stored in execution_detail/registry/audit.
- Step 6 validate_infra_spec runs BEFORE _step_container (the D6.1 enforcement point). InfraSpecRejected -> mark failed then RE-RAISE so caller sees the hard reject; no run_container fires.
- Step 7 family relaxations: hardened_container_kwargs() base; user from InfraContainerSpec.user, read_only/tmpfs from plan overrides else hardened. ports/privileged are not wrapper params (impossible by construction). Mounts -> docker-py volumes map.
- FAILURE preserves volumes: _fail() never calls remove_volume/remove_network; records partial state, sets execution_status='failed', emits infra_proposal.failed (refs only, no plaintext). Success emits infra_proposal.executed + infra_resource.created.
- Registry: networks/volumes -> create_infrastructure_resource (resource_network/named_volume); container -> create_container_resource(container_kind='infra'), exposed_ports carries {hostname, secret_refs} (ref-only connection metadata).

Tests: tests/test_infra_execution.py (6 tests, monkeypatched docker_client on runtime_orchestrator.docker_client, REAL vault for secrets): happy-path ordering, idempotent resume (no network/volume re-create), resolve-vs-mint, banned-knob hard reject (privileged + host-path bind), failure-preserves-volume. All green. Regression test_infra_proposals/registry/validator/secrets = 62 green. ruff clean. Commit 1a6a3de on spec/docker-mcp-catalog-sync.