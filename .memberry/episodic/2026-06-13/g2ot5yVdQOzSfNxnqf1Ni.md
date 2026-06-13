---
id: g2ot5yVdQOzSfNxnqf1Ni
session_id: session-20260613-ag3ntic-morph
agent_id: default
task: Adversarial+SPEC review of infra execution engine (adapter.py, section-11) at commit 1a6a3de
outcome: revised
created_at: "2026-06-13T08:20:36.563Z"
---

Reviewed the infra execution engine apps/api/platform_core/infrastructure/adapter.py (section-11 idempotent state machine that turns an accepted InfraChangeProposal's docker_plan into Docker resources). Verdict: CHANGES REQUESTED — one real defect.

SAFE (verified by running execute_proposal, not just reading):
- E VALIDATOR BYPASS: NO bypass. build_infra_spec/_infra_container_fields strips only keys NOT in InfraContainerSpec.model_fields; every banned knob (privileged, network_mode, pid_mode, ipc_mode, cap_add, published_ports, mounts/source) IS a modeled field, so all are preserved and validate_infra_spec (step 6) rejects before run_container. Renamed/unmodeled keys (Privileged/priv/HostConfig/ports) are inert: stripped pre-validation AND never forwarded because _container_kwargs builds a closed allowlist (no **plan passthrough) and run_container hardcodes privileged=False, ports={}. Confirmed step6 runs strictly before step7 on every path; a privileged+host-bind+docker.sock plan failed at validation with run_container never called.
- F SECRET LEAK: clean. Minted+resolved plaintext appears ONLY in transient container env; scanned execution_detail, audit_events.payload, container_resources/infrastructure_resources, infrastructure_credentials — only secret:// refs persisted, ciphertext-only rows.
- H VOLUME DELETION: clean. adapter.py never calls remove_volume/remove_network/remove_container (only a docstring mention). _fail journals+audits only. (The two real remove_volume callers are in unrelated orchestrator.py employee teardown.)
- D failure preserves volumes, status transitions correct. J hardened base correct.

DEFECT (G RESUME DOUBLE-MINT, HIGH): _step_secrets (adapter.py:272) marks "secrets" done at line 309 but, unlike every other side-effecting step (_step_networks/_step_volumes/_step_container all start with `if _is_done(detail, ...): return`), has NO skip-if-done guard on entry. mint_credential is side-effecting + non-idempotent. Proved: run1 mints icr_A, journals ref, fails at container; run2 resumes, re-enters _step_secrets, mints a SECOND credential icr_B, overwrites the journaled ref — container/registry use icr_B, icr_A is ORPHANED (encrypted row, never referenced, never torn down). Also means a resumed container can get a different password than the one baked into the volume on run1. RESOLVE-only resume is idempotent (control test: 1 cred), so the bug is mint-specific. FIX: add `if _is_done(_detail(proposal), "secrets"): return cached refs` guard, OR make mint resume-idempotent by resolving the already-journaled secret_refs on re-entry instead of minting fresh (rebuild values via secrets.resolve_ref on the journaled ref). Tests: 6/6 test_infra_execution pass, 138 infra tests pass, ruff clean — but no test covers a MINT requirement across a failed-then-resumed run, which is why the double-mint slipped through.