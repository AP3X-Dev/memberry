---
id: Pn8XoFScZXaKraC6Md5wT
session_id: session-20260611-093000
agent_id: default
task: Hardening loop cycle 3: apply-time pre-commit gate closes the late-tick race (OPT-3)
outcome: approved
created_at: "2026-06-11T10:57:41.435Z"
---

Cycle 3 (e654880): apply_pipeline_result now takes abort_if — evaluated as the first statement inside AssistStateStore.locked_update, i.e. under the same lock the drain's form review serializes on; True raises a private _ApplyAborted so the store's rollback path discards the working copy with no swap and no version bump (no renderer shimmer). StreamingCoordinator passes a status re-check closure; only a literal False return aborts, so legacy injected applicator fakes returning None still count as applied (PipelineApplicator alias widened to Callable[..., object]). The drain's own final sweep passes no abort_if — it applies during DRAINING by design. Correctness argument: stop_session flips status to DRAINING before the drain thread can take the store lock, so if form review holds the lock first the late tick always sees DRAINING on acquire. Test-craft lesson: when arranging a lock-holder interleaving in a test, take any snapshot BEFORE the holder grabs the lock — snapshot() acquires the same lock and otherwise serializes after the flip, making the test vacuously pass.