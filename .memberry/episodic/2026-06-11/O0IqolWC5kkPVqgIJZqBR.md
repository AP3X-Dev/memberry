---
id: O0IqolWC5kkPVqgIJZqBR
session_id: session-20260610-review-appt-dedup
agent_id: default
task: adversarial review of appointment dedup CTE change
created_at: "2026-06-11T01:46:34.969Z"
---

Reviewed the appointment dedup CTE change (buildAppointmentRequestMutation rewrite + migration 0011 + server.ts widget lookup removal). Verdict: PASS with 2 minor findings. (1) MODERATE: $11/$12 (scheduled_start_at/end_at, always null) lack explicit ::timestamptz casts in the INSERT...SELECT — PG resolves from INSERT target column but inconsistent with $22/$23 pattern. (2) LOW: test coverage gap on the existing-appointment-update branch (mock always returns FRESH_ID, no live PG). CTE logic is sound: mutual exclusion guaranteed, zero-row impossible, advisory lock properly scoped, UPDATE field set exactly mirrors old ON CONFLICT DO UPDATE, CRM idempotency preserved via RETURNING actual id, migration predicate exactly matches CTE dedup set.