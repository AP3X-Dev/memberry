---
id: EpRWb0OIDcj8poT-0W_2n
session_id: session-20260612-ag3ntic-hostop-review
agent_id: default
task: Revise the Host Operator / Infrastructure Service infra spec to close all adversarial-review findings, then re-commit.
outcome: approved
created_at: "2026-06-13T03:44:10.367Z"
---

Revised the infra spec and re-committed. New commit 324fd7b "Revise infrastructure spec after design review" on branch spec/docker-mcp-catalog-sync (ahead of cerebro/main by 2; NOT pushed). The spec is now PLAN-READY.

What changed: rewrote docs/superpowers/specs/2026-06-12-host-operator-infrastructure-design.md to close the review's 3 blockers + 7 majors + 11 minors. Two judgment calls made (flagged in the spec's §0 so they can be flipped): (1) RENAMED "Host Operator" -> "Infrastructure Service" (class prefix Infrastructure*, events infra_*) to clear the collision with the reserved kind=operator Operator Employee; (2) "project" is a nullable opaque project_label string (NOT a first-class Project entity) for v1 — Project entity deferred to Open Later. Also deferred host-port publishing entirely to v2 (v1 is internal-DNS-only); consoles reverse-proxied.

Key resolutions baked in, grounded against real code: registry IS container_resources extended (the ledger reap_orphans consults); D11 reaper-claim invariant is a rollout row before the reconciler; D6.1 single in-process InfraSpec validator is the enforcement layer (socket proxy is body-blind, foundation §8.3); §7 four-table data model (extend container_resources + 3 new: infrastructure_resources, infrastructure_change_proposals, infrastructure_credentials); D10/§10 execution-time secret minting via vault.crypto.encrypt_value + secret_ref("infra_credential",id); reconciler is a pass in worker.py sweep_once (no 2nd scheduler, preserves M9); §6.1 network isolation allow-list (internal=True is net-new — ensure_network hardcodes internal=False); §13.2 volume reclamation + list_managed_volumes.

Verification: ran a 5-agent verify workflow. It confirmed all 36 findings closed + load-bearing code claims accurate, but caught 7 rewrite-introduced defects (overloaded §8 ref, wrong §14->§17 cross-ref, event-family inconsistency, host-port-vs-allocator inconsistency, table-name inconsistency x3, ensure_network internal=False accuracy, sweep call-graph nit) — all fixed before commit. NOTE: the verifier was WRONG that tool_install_proposal.* events don't exist (they do, in tools/install_proposals.py: tool_install_proposal.created/rejected/accepted/withdrawn) and wrong that event families must be single dotless tokens (api_key.rotated proves otherwise) — kept the infra_proposal.* / infra_resource.* / infra_service.* entity.verb form.

PLAN PREREQUISITE (review-flagged): before any plan doc, add a WQ-23 row to PLAN.md §3 (PLAN.md discipline: workstream row before doc; correct the "NO open code-level queue" note at PLAN.md:68-69). Rollout step 1 (models+migrations) depends on confirming the §0 project=label decision. maker!=checker mandatory for the security-critical rows (validator, reaper integration, approval authority, secret minting).