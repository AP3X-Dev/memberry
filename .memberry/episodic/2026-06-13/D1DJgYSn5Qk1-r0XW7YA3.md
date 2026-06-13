---
id: D1DJgYSn5Qk1-r0XW7YA3
session_id: session-20260612-ag3ntic-hostop-review
agent_id: default
task: Adversarial multi-agent review of the Host Operator infrastructure design spec (docs/superpowers/specs/2026-06-12-host-operator-infrastructure-design.md, commit e466568) before writing the implementation plan.
outcome: revised
created_at: "2026-06-13T03:13:18.947Z"
---

Ran a 48-agent adversarial review of the Host Operator infra spec. Verdict: REVISE_THEN_PLAN (sound design, specifiable holes + "extend don't fork" corrections; no fundamental rework). 41 findings raised -> 36 confirmed -> 3 blockers, 7 majors, 11 minors.

3 BLOCKERS (must close before plan): (1) The live worker.py reap_orphans sweep force-removes any ag3ntic.managed=true container lacking a runtime_instances row (only mcp sidecars carved out, orchestrator.py:1552-1571) after a 600s grace -> a Host-Operator Postgres tracked only in the new registry gets deleted ~10min after creation. Fix: reap_orphans must consult the resource registry BEFORE the new reconciler is added. (2) §9 privileged/host-mount/socket-passthrough guardrails have no enforcement layer; the only current block is run_container hardcoding privileged=False/ports={}, and the Tecnativa socket-proxy inspects no request bodies -> need a single in-process ContainerSpec validator that REJECTS banned knobs on every infra create (reuse tool_capsules/runtime.py:80-81 reject pattern). (3) Data model leans on a "project" tenancy concept + project_id that do not exist (workspace_id is the sole tenancy unit; no Project model); §6 ships no migration -> decide project_label-string vs first-class Project entity, add §6.1 data model.

7 MAJORS: resource registry duplicates the existing container_resources ledger (drop mcp_sidecar, owned by WQ-17 sidecars.py); new-DB secret minting undefined (mint CSPRNG at execution, encrypt under workspace DEK, store secret:// ref); approval authority + D3 "admin maintenance approval" undefined (control plane is not a workspace so per-workspace admin role doesn't apply); reconciler needs to be a pass inside worker.py sweep_once (M9 gate forbids a 2nd scheduler); project_network isolation undefined (naive wiring exposes a credentialed DB to all workspace employees); no volume GC/lifecycle (disk exhaustion); internal-service subject identity undefined.

KEY MINORS: "Host Operator" name collides with the reserved kind=operator Operator Employee -> rename (e.g. Infrastructure Authority); restart verb must be in-place-only (reusing restart_runtime recreates-from-registry).

PROCESS: PLAN.md discipline requires a WQ-23 row in §3 before any plan doc, and PLAN.md:68-69 ("NO open code-level queue") must be corrected. When planning: ContainerSpec validator + reap_orphans integration become their own EARLY rows ahead of any container-creating step; maker!=checker mandatory for security-critical rows; each row ends in a runnable gate (pytest + scripts/cleanliness_gate.sh + ruff). STRENGTHS to preserve: proposal-gated classification, reuse proxy-bound docker_client, no raw socket, outcomes-not-primitives, conservative failure handling.

Spec remains at commit e466568 (branch spec/docker-mcp-catalog-sync, ahead of cerebro/main by 1, not pushed). No edits applied yet; awaiting user decision on whether to revise the spec.