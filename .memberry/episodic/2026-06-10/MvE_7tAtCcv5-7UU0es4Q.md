---
id: MvE_7tAtCcv5-7UU0es4Q
session_id: session-20260610-pre-launch-impl
agent_id: default
task: Single-writer spike slice 1 (decision #5)
outcome: approved
created_at: "2026-06-10T20:56:28.498Z"
---

Single-writer spike STARTED on isolated branch v2-single-writer-spike (off main f751708). Shadow-equivalence-first approach (owner grill). Plan + status in docs/single-writer-spike.md.

Slice 1 COMMITTED (d8fb79e): src/engine/services/single_writer.py::reduce_assist_state — the apply_pipeline_result mutation sequence as a PURE fold (deep-copy state, reuse the existing _apply_* helpers, inject the wall-clock, return new AssistState, never mutate input). Single-writer path and lock-based path share ONE implementation so they can't drift. tests/services/test_single_writer.py proves the reducer reproduces the lock-based store's state for the booking path (modulo wall-clock) + purity. Locks untouched, nothing wired to production. Full gate green (ruff+mypy+pytest 2488 on the main-based branch).

KEY FINDING (direction-relevant): the mutation helpers embed datetime.now() in MANY fields (CustomerField.extracted_at, last_updated, ChecklistItem.detected_at, classification last_updated, ...), not just last_analyzed_at. So equivalence holds MODULO wall-clock stamps (normalize datetimes to compare). Byte-identical determinism (needed for crash-resume replay) requires threading clock injection through every helper — a bounded refactor the spike surfaced BEFORE deleting any locks. For shadow-equivalence's "zero divergence" goal, modulo-timestamps equivalence is sufficient.

NEXT: slice 2 = SingleWriterSession queue harness + concurrency equivalence (interleaved ticks, drain racing a tick — where lock→queue swap is most likely to diverge), then property suite + CIC Harness. Merge still gated on soft-launch baseline.