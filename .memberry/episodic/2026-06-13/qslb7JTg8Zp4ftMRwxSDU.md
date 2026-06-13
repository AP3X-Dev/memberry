---
id: qslb7JTg8Zp4ftMRwxSDU
session_id: session-20260612-ag3ntic-wq23-impl
agent_id: default
task: WQ-23 Task 3 (InfraSpec validator, D6.1) — the linchpin reject gate
outcome: approved
created_at: "2026-06-13T06:27:03.983Z"
---

WQ-23 Task 3 DONE. The InfraSpec validator (the single in-process enforcement layer, D6.1) is implemented: platform_core/infrastructure/{__init__.py, schemas.py, validator.py}. schemas.py (coordinator-authored seam, commit 83d2e2a) = pydantic v2 InfraSpec/InfraContainerSpec/InfraMount/InfraPortPublish/InfraNetworkSpec/InfraVolumeSpec, all extra="forbid" (unmodeled knobs rejected at parse). validator.py: validate_infra_spec(spec)->None, raises InfraSpecRejected(code, detail). 

REJECT CODES (wire-stable strings; the ENFORCED set is BROADER than literal spec section 9): privileged, host_network, host_pid, host_ipc, host_path_bind, docker_socket_mount, root_bind, socket_passthrough, unapproved_cap_add, host_port_publish, container_namespace. Key rules: absolute-path mount source = a bind regardless of declared type; posixpath normalization before matching (so /var/run/../run/docker.sock and /run/docker.sock both = the socket; // = root); socket/root binds beat the generic host_path_bind (specificity ordering); APPROVED_CAPS=frozenset() so ANY cap_add rejects. 

HARDENINGS BEYOND literal section 9 (added after adversarial veto-review, commits 62b5a1c+1c544fe): (1) container_namespace — reject network/pid/ipc_mode starting with "container:" (sibling-namespace lateral-escape, e.g. pid_mode=container:<socket-proxy>); (2) full host-port deferral — reject ANY non-empty published_ports (not just 0.0.0.0/all-interfaces), since section 16 defers host-port publishing entirely and v1 is internal-DNS-only. Maker≠checker: checker authored all 26 tests (8d4abcb+62b5a1c), separate implementers wrote validator.py (0219d4c+1c544fe). Adversarial reviewer ran ~35 hostile specs, no bypass/crash. Wired into the execution engine in Task 10.